/**
 * LV-20260924-D-QA-R1 验收：B QA 缺陷 2/3 修复验证（真实 app+preload，一次性临时库）。
 * 场景（按 QA-R1 任务书）：
 *   R1 真实 UI 构造批次：3 文件预检（文件名/「文件」标签可见=缺陷3修复），跳过 1 项，提交
 *      → 1 成功 + 1 失败（超限）+ 1 跳过
 *   R2 草稿持久化：capture-drafts.json 的 quick-preview 槽含 batchId/decisions/mode/result（缺陷2修复）
 *   R3 关闭重启：预检面板恢复失败批次与「只重试失败项」，跳过勾选保持划线
 *   R4 重试：只触碰失败项（仍失败），成功项在库中恰好一次
 *   R5 跨批次幂等：重建新计划再提交 → 历史已成功来源自动 skipped，库中成功条目仍恰好一次
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
let pw;
try { pw = require('playwright'); } catch {
  const { createRequire } = require('module');
  const req2 = createRequire(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'));
  pw = req2('playwright');
}
const root = path.resolve(__dirname, '..');
const out = process.env.LV_EVIDENCE_DIR || path.join(root, '交付物/D/evidence-qa-r1');
const steps = [], errors = [];
const step = (t) => { steps.push(t); console.log('✓ ' + t); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-qa-r1-'));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
async function until(fn, label, times = 200) { for (let i = 0; i < times; i++) { try { const r = await fn(); if (r) return r; } catch {} await sleep(100); } throw Error(label); }

const tmp = path.join(tmpRoot, 't1');
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ vaultBridge: { enabled: false }, autoReview: false, notifyOnIngest: false, overlayVisible: false }));

async function launch() {
  const app = await pw._electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [root], env: { ...process.env, LV_CONFIG_DIR: tmp },
  });
  app.on('window', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  const anyWin = await until(async () => app.windows().find((p) => p.url().includes('index.html') || p.url().includes('/overlay/') || p.url().includes('/quick/')), '窗口未打开');
  if (!anyWin.url().includes('index.html')) {
    await anyWin.waitForFunction(() => !!window.vault, null, { timeout: 20000 });
    await anyWin.evaluate(() => window.vault.overlayOpenMain());
  }
  const main = await until(async () => app.windows().find((p) => p.url().includes('index.html')), '主窗未拉起');
  await main.waitForFunction(() => !!window.vault, null, { timeout: 20000 });
  return { app, main };
}
async function stubDialog(app, filePaths) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: !paths || !paths.length, filePaths: paths || [] });
  }, filePaths || []);
}
async function openQuick(app) {
  const main = app.windows().find((p) => p.url().includes('index.html'));
  await main.evaluate(() => window.vault.openQuick());
  const quick = await until(async () => app.windows().find((p) => p.url().includes('/quick/')), '快窗未打开');
  await quick.waitForSelector('#mainInput');
  return quick;
}
const lib = () => {
  const v = readJson(path.join(tmp, 'data/library.json'), []);
  return Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
};
async function closeSafe(app) {
  try { await Promise.race([app.close(), sleep(12000).then(() => 'timeout')]); } catch {}
  try { if (app.process() && !app.process().killed) app.process().kill(); } catch {}
  await sleep(800);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const small1 = path.join(tmpRoot, 'success-one.txt');
  const small2 = path.join(tmpRoot, 'skip-two.txt');
  const huge = path.join(tmpRoot, 'failure-huge.txt');
  fs.writeFileSync(small1, '成功来源内容：这条应入库且恰好一次。\n');
  fs.writeFileSync(small2, '跳过来源内容：这条永不入库。\n');
  {
    const chunk = '超限测试行。\n'.repeat(200);
    const fh = fs.openSync(huge, 'w');
    while (fs.statSync(huge).size < 21 * 1024 * 1024) fs.writeSync(fh, chunk);
    fs.closeSync(fh);
  }

  // ---------- R1：真实 UI 构造 1成/1败/1跳 批次 ----------
  let { app, main } = await launch();
  await stubDialog(app, [small1, small2, huge]);
  let quick = await openQuick(app);
  await quick.click('#pickIngestBtn');
  await until(async () => (await quick.locator('.mc-attach').count()) === 3, '3 个文件未入列表');
  await quick.click('#submitBtn'); // 首次点保存 → 生成预检
  await until(async () => (await quick.locator('#precheckPanel .pc-entry').count()) === 3, '预检未出现 3 条目');
  // 缺陷 3 修复验证：文件条目标签为「文件」且显示各自文件名
  const kinds = await quick.locator('#precheckPanel .pc-entry .pc-kind').allInnerTexts();
  assert.ok(kinds.filter((k) => k.trim() === '文件').length === 3, `文件条目应显示「文件」标签，实际：${kinds.join(',')}`);
  const raws = (await quick.locator('#precheckPanel .pc-entry .pc-raw').allInnerTexts()).join('\n');
  assert.ok(raws.includes('success-one.txt') && raws.includes('skip-two.txt') && raws.includes('failure-huge.txt'), '预览应含每个文件名');
  step('R1 预检面板：3 个文件条目均显示「文件」标签与各自文件名（缺陷 3 修复）');
  await quick.screenshot({ path: path.join(out, 'R1-预检-文件名与文件标签.png') });
  // 跳过 skip-two
  const skipKey = await quick.locator('.pc-entry', { hasText: 'skip-two.txt' }).getAttribute('data-key');
  await quick.locator(`.pc-entry[data-key="${skipKey}"] input[type="checkbox"]`).click();
  await until(async () => (await quick.locator(`.pc-entry[data-key="${skipKey}"]`).getAttribute('class')).includes('skip'), '跳过勾选未生效');
  await quick.click('#submitBtn'); // 确认保存
  const cr = await until(async () => {
    const st = await quick.evaluate(() => document.querySelector('#status').textContent);
    return /已保存|已存入|失败/.test(st) ? st : null;
  }, '提交未完成');
  assert.ok(/失败/.test(cr), `应部分失败：${cr}`);
  step('R1 提交：1 成功 + 1 失败（超限）+ 1 跳过，状态可读');
  await quick.screenshot({ path: path.join(out, 'R1-部分失败面板.png') });
  // 批次文件断言
  const batchFiles = fs.readdirSync(path.join(tmp, 'data/import-batches')).filter((f) => f.endsWith('.json'));
  assert.equal(batchFiles.length, 1, '应只有 1 个批次文件');
  const batch = readJson(path.join(tmp, 'data/import-batches', batchFiles[0]), null);
  const statuses = Object.values(batch.items);
  assert.equal(statuses.filter((s) => s.status === 'succeeded').length, 1, '1 成功');
  assert.equal(statuses.filter((s) => s.status === 'failed').length, 1, '1 失败');
  assert.equal(statuses.filter((s) => s.status === 'skipped' && !s.alreadyImported).length, 1, '1 跳过');
  assert.ok(!lib().some((i) => (i.notes || '').includes('跳过来源内容')), '跳过项不入库');
  step('R1 批次落盘：1 成功/1 失败/1 跳过，跳过项未入库');

  // ---------- R2：草稿持久化（缺陷 2 修复核心证据） ----------
  await quick.evaluate(() => window.flushCaptureDraft && window.flushCaptureDraft());
  await sleep(600); // 防抖 350ms + 余量
  const draftSlot = readJson(path.join(tmp, 'data/capture-drafts.json'), {})['quick-preview'];
  assert.ok(draftSlot && draftSlot.batchId === batch.batchId, `quick-preview 槽应含 batchId（实际 keys：${draftSlot ? Object.keys(draftSlot).join(',') : '槽缺失'}）`);
  assert.ok(draftSlot.decisions && draftSlot.decisions[skipKey] === 'skip', 'decisions 应含跳过决定');
  assert.ok(draftSlot.result && draftSlot.result.succeededCount === 1, 'result 应含成功计数');
  step('R2 quick-preview 槽持久化：batchId/decisions/result 完整落盘（缺陷 2 修复）');
  await closeSafe(app);

  // ---------- R3：重启恢复失败批次与勾选 ----------
  ({ app, main } = await launch());
  quick = await openQuick(app);
  await until(async () => (await quick.locator('.pc-retry').count()) === 1, '重启后「只重试失败项」未恢复');
  const restoredClass = await quick.locator(`.pc-entry[data-key="${skipKey}"]`).getAttribute('class');
  assert.ok(restoredClass.includes('skip'), '重启后跳过勾选应保持');
  const restoredRaws = (await quick.locator('#precheckPanel .pc-entry .pc-raw').allInnerTexts()).join('\n');
  assert.ok(restoredRaws.includes('failure-huge.txt'), '恢复面板应显示失败条目（文件名可见）');
  await quick.screenshot({ path: path.join(out, 'R3-重启恢复失败批次.png') });
  step('R3 重启恢复：失败批次 + 「只重试失败项」+ 跳过勾选划线完整恢复');
  const countSuccessBefore = lib().filter((i) => (i.notes || '').includes('成功来源内容')).length;
  assert.equal(countSuccessBefore, 1, '重启后成功条目仍恰好 1 条');

  // ---------- R4：重试只触碰失败项 ----------
  await quick.locator('.pc-retry').click();
  await until(async () => (await quick.locator('#status').textContent()).includes('失败') || (await quick.locator('.pc-result').innerText()).includes('失败'), '重试未完成', 100);
  const batchAfter = readJson(path.join(tmp, 'data/import-batches', batchFiles[0]), null);
  const succeededKeys = Object.entries(batchAfter.items).filter(([, s]) => s.status === 'succeeded');
  assert.equal(succeededKeys.length, 1, '重试后成功集合不变');
  const libAll1 = lib().filter((i) => (i.notes || '').includes('成功来源内容'));
  assert.equal(libAll1.length, 1, '成功条目在库中恰好一次（重试未重复导入）');
  const failedNow = Object.entries(batchAfter.items).filter(([, s]) => s.status === 'failed');
  assert.equal(failedNow.length, 1, '大文件仍超限失败（可再处理）');
  step('R4 重试幂等：只触碰失败项，成功条目在库中恰好一次');
  await closeSafe(app);

  // ---------- R5：跨批次幂等（新计划不得重复导入已成功来源；IPC 直调真实 preload→主进程） ----------
  ({ app, main } = await launch());
  const pv5 = await main.evaluate(async ({ f1, f2 }) => window.vault.importPreview({ files: [f1, f2], source: 'qa' }), { f1: small1, f2: huge });
  assert.ok(pv5.ok && pv5.entries.length === 2, '新计划应有 2 个条目');
  const cm5 = await main.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: Object.fromEntries(p.entries.map((e) => [e.sourceKey, 'keep'])) }), pv5);
  assert.ok(cm5.ok, '新计划提交应完成');
  const skippedKeys = cm5.skipped.map((s) => s.sourceKey);
  assert.equal(skippedKeys.length, 1, '历史已成功来源应被跳过');
  assert.equal(cm5.succeeded.length, 0, '新计划不应产生新的成功导入');
  const libAll2 = lib().filter((i) => (i.notes || '').includes('成功来源内容'));
  assert.equal(libAll2.length, 1, '跨批次幂等：新计划提交后成功条目仍恰好一次');
  const batchFiles2 = fs.readdirSync(path.join(tmp, 'data/import-batches')).filter((f) => f.endsWith('.json'));
  assert.equal(batchFiles2.length, 2, '应有第 2 个批次文件');
  const batch2 = batchFiles2.map((f) => readJson(path.join(tmp, 'data/import-batches', f), null)).find((b) => b.batchId !== batch.batchId);
  const crossSkipped = Object.values(batch2.items).some((s) => s.status === 'skipped' && s.alreadyImported && s.alreadyImported.batchId === batch.batchId);
  assert.ok(crossSkipped, '新批次应把历史已成功来源标为 skipped(alreadyImported 指向原批次)');
  step('R5 跨批次幂等：重建计划再提交，历史已成功来源自动跳过（alreadyImported 指向原批次），库中仍恰好一次');
  await main.screenshot({ path: path.join(out, 'R5-主窗-最终状态.png') });
  await closeSafe(app);

  fs.writeFileSync(path.join(out, 'qa-r1-result.json'), JSON.stringify({ ok: true, steps, errors, tmp }, null, 2));
  console.log('QA_R1_CHECK_OK ' + steps.length);
  console.log('TMP=' + tmp);
})().catch((e) => {
  console.error(e.stack);
  try { fs.mkdirSync(out, { recursive: true }); } catch {}
  fs.writeFileSync(path.join(out, 'qa-r1-result.json'), JSON.stringify({ ok: false, steps, errors, error: String(e.stack), tmpRoot }, null, 2));
  process.exitCode = 1;
});
