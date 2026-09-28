/** 聊天捕获回归：使用隔离资料库，验证选中消息、附件归属、草稿及小窗口操作。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
let pw;
try { pw = require('playwright'); }
catch { pw = require(process.env.LV_PLAYWRIGHT_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = path.resolve(__dirname, '..');
const out = path.join(root, '交付物/v0.10.1-收尾验收');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-capture-check-'));
const steps = [], errors = [], geometry = [];
let app, main, quick;
const step = s => { steps.push(s); console.log('✓ ' + s); };
async function until(fn, label) {
  for (let n = 0; n < 150; n++) { const r = await fn(); if (r) return r; await new Promise(r => setTimeout(r, 80)); }
  throw Error('等待失败：' + label);
}
async function launch() {
  app = await pw._electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], env: { ...process.env, LV_CONFIG_DIR: tmp } });
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  main = await until(() => app.windows().find(p => p.url().includes('/main/index.html')), '主窗口');
  await main.waitForSelector('#addBtn');
  await main.evaluate(() => window.vault.openQuick());
  quick = await until(() => app.windows().find(p => p.url().includes('/quick/')), '收录窗口');
  await quick.waitForSelector('#mainInput');
  await quick.waitForFunction(() => document.activeElement.id === 'mainInput');
}
async function checkGeometry(label) {
  const g = await quick.evaluate(() => {
    const rect = s => { const b = document.querySelector(s).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height }; };
    const wrap = document.querySelector('.wrap');
    return { width: innerWidth, height: innerHeight, toolbar: rect('.capture-toolbar'), wrap: rect('.wrap'), footer: rect('.foot'), save: rect('#submitBtn'), cancel: rect('#cancelBtn'), horizontalOverflow: wrap.scrollWidth > wrap.clientWidth + 1 };
  });
  assert.ok(g.toolbar.bottom <= g.wrap.top + 1, label + ' 导航不覆盖正文');
  assert.ok(g.wrap.bottom <= g.footer.top + 1, label + ' 正文不覆盖底栏');
  for (const b of [g.save, g.cancel]) { assert.ok(b.bottom <= g.height && b.left >= 0 && b.right <= g.width, label + ' 操作按钮在窗口内'); }
  assert.equal(g.horizontalOverflow, false, label + ' 无横向溢出');
  geometry.push({ label, ...g });
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ vaultBridge: { enabled: false }, autoReview: false, notifyOnIngest: false }));
  await launch();
  const raw = '阿宁 2026/9/22 09:12\n分镜先画九宫格，再写提示词\n---\n小周 2026/9/22 09:14\n收到，我下午试一次\n---\n阿宁 2026/9/22 09:16\n先固定服装，再安排动作';
  await quick.locator('#mainInput').fill(raw);
  await quick.locator('#mainInput').dispatchEvent('paste');
  await until(async () => await quick.locator('.msgcard').count() === 3, '拆分三条消息');
  assert.equal(await quick.locator('#showChatMessages').innerText(), '消息 · 3 条');
  await quick.locator('[data-f="text"]').nth(2).fill('固定服装，先九宫格，再写动作提示词。');
  await quick.locator('[data-remove="0"]').click();
  assert.equal(await quick.locator('.msgcard.selected').getAttribute('data-i'), '1');
  assert.equal(await quick.locator('#selectedMessageHint').innerText(), '附件将添加到第 2 条消息');
  step('删除前面的消息后，仍选中原消息，附件目标提示同步更新');

  await quick.locator('[data-k="chat"]').click();
  assert.equal(await quick.locator('.msgcard').count(), 2);
  assert.equal(await quick.locator('[data-f="text"]').nth(1).inputValue(), '固定服装，先九宫格，再写动作提示词。');
  step('再次点击聊天类型不会覆盖人工修正或恢复已移除消息');

  const file = path.join(tmp, '九宫格模板.md');
  fs.writeFileSync(file, '# 九宫格模板\n服装、机位、动作保持连续。');
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, file);
  await quick.locator('#chatCardPickBtn').click();
  assert.equal(await quick.locator('.msgcard').nth(1).locator('[data-open]').innerText(), '📎 九宫格模板.md');
  assert.equal(await quick.locator('.msgcard').nth(0).locator('[data-open]').count(), 0);
  step('选文件真实附到选中消息，其余消息没有串附件');

  await quick.locator('#chatTitle').fill('分镜方法讨论');
  await quick.locator('#chatSource').fill('微信 · 创作讨论');
  const heights = await quick.evaluate(() => ['chatSource', 'chatSearch', 'chatTitle'].map(id => document.getElementById(id).getBoundingClientRect().height));
  assert.ok(heights.every(h => h >= 36));
  await quick.locator('#showChatOriginal').click();
  assert.equal(await quick.evaluate(() => document.querySelector('.wrap').scrollTop), 0);
  assert.equal(await quick.locator('#mainInput').evaluate(el => el.scrollTop), 0);
  await checkGeometry('默认窗口：原文');
  await quick.screenshot({ animations: 'disabled', path: path.join(out, '01-原文与来源.png') });
  await quick.locator('#showChatMessages').click();
  assert.ok(await quick.evaluate(() => document.querySelector('.wrap').scrollTop > 0));
  await checkGeometry('默认窗口：消息');
  await quick.screenshot({ animations: 'disabled', path: path.join(out, '02-消息与附件.png') });
  step('原文和消息可直接跳转，顶部类型与底部保存始终可见');

  const win = await app.browserWindow(quick);
  await win.evaluate(w => w.setSize(420, 460));
  await until(() => quick.evaluate(() => innerWidth === 420 && innerHeight === 460), '最小窗口');
  await quick.locator('#showChatOriginal').click(); await checkGeometry('最小窗口：原文');
  await quick.locator('#showChatMessages').click(); await checkGeometry('最小窗口：消息');
  await quick.locator('.msgcard').last().scrollIntoViewIfNeeded();
  await quick.screenshot({ animations: 'disabled', path: path.join(out, '03-小窗口消息.png') });
  await quick.evaluate(() => status('无法读取附件，请重新选择：/一个很长的路径/long-filename-that-cannot-be-opened.md'));
  await checkGeometry('最小窗口：长错误提示');
  step('420×460 小窗口与长错误提示下，按钮可用且无横向溢出');

  await quick.locator('#closeBtn').click();
  await app.close(); app = null;
  await launch();
  await quick.waitForFunction(() => document.querySelector('#status').textContent === '已恢复草稿');
  assert.equal(await quick.locator('.msgcard').count(), 2);
  assert.equal(await quick.locator('[data-f="text"]').nth(1).inputValue(), '固定服装，先九宫格，再写动作提示词。');
  assert.equal(await quick.locator('.msgcard').nth(1).locator('[data-open]').innerText(), '📎 九宫格模板.md');
  assert.equal(await quick.locator('#chatSource').inputValue(), '微信 · 创作讨论');
  step('退出重启后，聊天修正、来源与消息附件草稿完整恢复');

  // B 新交互：≥2 条消息的聊天首次点保存会先出预检清单；走「按原文保存」仍走原 captureSave 单条链路
  await quick.locator('#submitBtn').click();
  await quick.locator('#precheckPanel').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const rawVisible = await quick.locator('#saveRawBtn').isVisible().catch(() => false);
  if (rawVisible) await quick.locator('#saveRawBtn').click();
  else await quick.locator('#submitBtn').click();
  try {
    // B 新版保存反馈带分类后缀（「已记下 · 分类名」），用前缀匹配
    await quick.waitForFunction(() => document.querySelector('#status').textContent.startsWith('已记下'), null, { timeout: 15000 });
  } catch (e) {
    const st = await quick.locator('#status').textContent().catch(() => '?');
    const pre = await quick.locator('.precheck').count().catch(() => 0);
    throw new Error(`保存未完成：status="${st}" precheck面板=${pre} saveRaw可见=${rawVisible}`);
  }
  const { items } = await main.evaluate(() => window.vault.list({ limit: 100 }));
  assert.equal(items.length, 1);
  const saved = await main.evaluate(id => window.vault.get(id), items[0].id);
  assert.equal(saved.raw_text, raw); assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[1].text, '固定服装，先九宫格，再写动作提示词。');
  assert.ok(saved.messages[1].attachment.path !== file);
  assert.equal(fs.readFileSync(saved.messages[1].attachment.path, 'utf8'), fs.readFileSync(file, 'utf8'));
  assert.ok(!saved.messages[0].attachment?.path);
  step('保存后原始聊天保留，修正后的消息与附件归属落盘正确');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'capture-result.json'), JSON.stringify({ ok: true, steps, errors, geometry, version: require('../package.json').version }, null, 2));
  console.log('CAPTURE_CHECK_OK ' + steps.length);
})().catch(e => {
  console.error(e.stack);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'capture-result.json'), JSON.stringify({ ok: false, steps, errors, error: e.stack }, null, 2));
  process.exitCode = 1;
}).finally(async () => { if (app) await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
