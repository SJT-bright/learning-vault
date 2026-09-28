/**
 * LV-20260924-D-I1 整合验收：真实 UI → preload → 主进程 → 持久化（隔离临时库）。
 * 覆盖 D-INTEGRATE-01 第 3 步场景矩阵 + INTEGRATION-NOTES 六项适配：
 *   S1 B 真实 UI：粘贴聊天→预检→编辑说话人→勾选跳过一个文件→提交→持久化核对
 *   S2 5.8MB 文件：预检截断 → commit 完整重读（尾部存在）+ 原文件归档
 *   S3 超提交上限：明确失败（COMMIT_TOO_LARGE），不入库
 *   S4 源变化：SOURCE_CHANGED 阻止提交；decisions 严格校验（对象/数组/未知键/未知值）
 *   S5 部分失败→只重试失败项→重启幂等（批次落盘、成功项不重复导入）
 *   S6 便携包：导出→隔离库B恢复→OLD/NEW 同路径异内容冲突→重复恢复幂等→损坏包拒绝零残留
 * 原生对话框用 Playwright 注入 stub（不改产品代码）；AI 全程无 key（只测无 AI 路径）。
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
const out = process.env.LV_EVIDENCE_DIR || path.join(root, '交付物/D/evidence-integration');
const steps = [], errors = [];
const step = (t) => { steps.push(t); console.log('✓ ' + t); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-d-integration-'));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
async function until(fn, label, times = 150) { for (let i = 0; i < times; i++) { try { const r = await fn(); if (r) return r; } catch {} await sleep(100); } throw Error(label); }

const CFG = JSON.stringify({ vaultBridge: { enabled: false }, autoReview: false, notifyOnIngest: false, overlayVisible: false });
// 场景临时库只允许本脚本预设的白名单标签，路径必须落在 tmpRoot 内（越界即拒绝）
const ALLOWED_TAGS = new Set(['t1', 'portable-A', 'portable-B', 'portable-C']);
function mkTmp(tag) {
  if (!ALLOWED_TAGS.has(tag)) throw new Error('非法临时库标签：' + tag);
  const dir = path.join(tmpRoot, tag);
  const resolved = path.resolve(dir);
  if (resolved !== tmpRoot && !resolved.startsWith(tmpRoot + path.sep)) throw new Error('临时库路径越界：' + tag);
  fs.mkdirSync(path.join(resolved, 'data'), { recursive: true });
  fs.writeFileSync(path.join(resolved, 'config.json'), CFG);
  return resolved;
}
async function launch(tmp) {
  // 单实例锁/退出竞态兜底：首次失败（如上一个实例尚未完全退出）等 3s 重试一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    const app = await pw._electron.launch({
      executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root], env: { ...process.env, LV_CONFIG_DIR: tmp },
    });
    app.on('window', (p) => p.on('pageerror', (e) => errors.push(e.message)));
    try {
      // 应用设计：非空库启动只进托盘不弹主窗（启动静默化）。等任一窗口（overlay 预热最快），
      // 经 overlay/quick 的 vault.overlayOpenMain() 拉起主窗——与既有 integration-check.js 同一模式。
      const anyWin = await until(async () => app.windows().find((p) => p.url().includes('index.html') || p.url().includes('/overlay/') || p.url().includes('/quick/')), '主窗未打开', 200);
      if (!anyWin.url().includes('index.html')) {
        await anyWin.waitForFunction(() => !!window.vault, null, { timeout: 20000 });
        await anyWin.evaluate(() => window.vault.overlayOpenMain());
      }
      const page = await until(async () => app.windows().find((p) => p.url().includes('index.html')), '主窗未拉起', 200);
      await page.waitForFunction(() => !!window.vault, null, { timeout: 20000 });
      return { app, page };
    } catch (e) {
      try { await app.close(); } catch {}
      if (attempt === 2) throw e;
      await sleep(3000);
    }
  }
}
// 原生对话框 stub（仅本进程实例内生效，不改产品代码）
async function stubDialog(app, filePaths) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: !paths || !paths.length, filePaths: paths || [] });
  }, filePaths || []);
}
// Store 把 items 数组整体写入 library.json（不是 {items:[]} 包装）；兼容两种形态以防未来变更
const lib = (tmp) => {
  const v = readJson(path.join(tmp, 'data/library.json'), []);
  if (Array.isArray(v)) return v;
  return v && Array.isArray(v.items) ? v.items : [];
};
// close 加 12s 超时竞争：个别实例退出链路挂起时强杀，不拖垮整轮验收
async function closeSafe(app) {
  try { await Promise.race([app.close(), sleep(12000).then(() => 'timeout')]); } catch {}
  try { if (app.process() && !app.process().killed) app.process().kill(); } catch {}
  await sleep(800); // 给单实例锁释放留时间
}

(async () => {
  fs.mkdirSync(out, { recursive: true });

  // ================= S1：B 真实 UI（粘贴聊天 + 编辑说话人 + 勾选跳过 + 提交持久化） =================
  const t1 = mkTmp('t1');
  const f1 = path.join(tmpRoot, 'md-one.md');
  const f2 = path.join(tmpRoot, 'md-two.md');
  fs.writeFileSync(f1, '文件一内容：第一条独立笔记（应入库）\n');
  fs.writeFileSync(f2, '文件二内容：这条会被勾选跳过（不应入库）\n');
  const { app: app1, page: main1 } = await launch(t1);
  await main1.evaluate(() => window.vault.openQuick());
  const quick = await until(async () => app1.windows().find((p) => p.url().includes('/quick/')), '快窗未打开');
  await quick.waitForSelector('#mainInput');
  await stubDialog(app1, [f1, f2]);
  // 应用聊天头约定：`说话人 时间` 独立成行（与 B CHAT3 样例同格式）
  await quick.fill('#mainInput', '张三 14:02\n今天把储能测算过一遍\n---\n李四 14:03\n好，我下午发你数据\n---\n王五 14:05\n收到');
  // 真实用户路径：粘贴（paste 事件）才触发聊天解析（B 的 oninput 只做 detect，不拆卡）
  await quick.locator('#mainInput').evaluate((el) => el.dispatchEvent(new Event('paste', { bubbles: true })));
  await until(async () => (await quick.locator('.msgcard').count()) === 3, '聊天未拆成 3 张消息卡');
  await quick.fill('.mc-speaker[data-i="0"]', '张三-编辑后');
  await quick.click('#pickIngestBtn');
  // 预检由「首次点保存」生成（B 交互：submit 首击 buildPrecheck，二击确认提交）
  await quick.click('#submitBtn');
  await until(async () => (await quick.locator('#precheckPanel .pc-entry').count()) === 3, '预检未出现 3 个条目（1 聊天 + 2 文件）');
  await quick.screenshot({ path: path.join(out, 'S1-预检面板-3条目.png') });
  // 勾选跳过第二个文件条目（预览文本是文件内容，按内容特征定位）
  const skipKey = await quick.locator('.pc-entry', { hasText: '文件二内容' }).getAttribute('data-key');
  assert.ok(skipKey, '未找到 md-two 的预检条目');
  await quick.locator(`.pc-entry[data-key="${skipKey}"] input[type="checkbox"]`).click();
  await until(async () => (await quick.locator(`.pc-entry[data-key="${skipKey}"]`).getAttribute('class')).includes('skip'), '跳过勾选未生效');
  step('S1 真实 UI：粘贴聊天拆 3 卡、编辑说话人、2 文件加入预检、勾选跳过 md-two');
  await quick.click('#submitBtn'); // 第二次点：确认保存（走 importCommit，decisions 为对象契约）
  await until(async () => (await quick.locator('#donebar').getAttribute('class')).includes('show'), '完成条未出现');
  await quick.screenshot({ path: path.join(out, 'S1-提交完成条.png') });
  // 持久化核对（直接读库文件）
  const savedItems = await until(() => {
    const items = lib(t1);
    return items.length >= 2 ? items : null;
  }, '持久化超时：库中没有新条目');
  const chat = savedItems.find((i) => i.kind === 'chat' && (i.raw_text || i.notes || '').includes('张三 14:02'));
  assert.ok(chat, '聊天条目未入库');
  assert.equal(chat.messages.length, 3, '消息数应为 3');
  assert.equal(chat.messages[0].speaker, '张三-编辑后', '用户编辑的说话人必须保留（不得被重新解析覆盖）');
  assert.ok(chat.messages[1].speaker === '李四' && chat.messages[2].speaker === '王五', '其余说话人保持原样');
  assert.ok((chat.raw_text || chat.notes || '').includes('张三 14:02'), '原文（raw_text）仍完整保留');
  assert.ok(!JSON.stringify(savedItems).includes('md-two') && !savedItems.some((i) => (i.notes || '').includes('文件二内容')), '被跳过的 md-two 绝不入库');
  assert.ok(savedItems.some((i) => (i.notes || '').includes('文件一内容')), '保留的 md-one 已入库');
  step('S1 持久化：编辑说话人保留、原文完整、被跳过文件未入库、保留文件已入库');
  await closeSafe(app1);

  // ================= S2/S3/S4/S5：IPC 级真实链路（同库重启续用） =================
  const { app: app2, page: main2 } = await launch(t1);
  // S2 5.8MB 文件：预检截断 → commit 完整重读 + 原文件归档
  const bigPath = path.join(tmpRoot, 'big-5.8mb.txt');
  const tail = 'TAILMARKER-5.8MB-END';
  {
    const chunk = '记忆曲线复习素材行，包含编号与内容，用于填充体积。\n'.repeat(100);
    let buf = '';
    while (Buffer.byteLength(buf, 'utf8') < 5.8 * 1024 * 1024) buf += chunk;
    fs.writeFileSync(bigPath, buf + '\n' + tail + '\n');
  }
  const pvBig = await main2.evaluate(async (f) => window.vault.importPreview({ files: [f], source: 'check' }), bigPath);
  assert.ok(pvBig.ok && pvBig.entries.length === 1, '5.8MB 预检应产生 1 个条目');
  assert.equal(pvBig.entries[0].source.truncated, true, '预检应标记截断（2MB 上限）');
  const cmBig = await main2.evaluate(async (p) => {
    const en = p.entries[0];
    return window.vault.importCommit({ planId: p.planId, decisions: { [en.sourceKey]: 'keep' } });
  }, pvBig);
  assert.ok(cmBig.ok, '5.8MB 提交应成功');
  assert.equal(cmBig.failed.length, 0);
  const bigItem = await until(() => lib(t1).find((i) => (i.notes || '').includes(tail)) || null, '5.8MB 尾部标记未入库（完整重读失败）');
  const bigFileRef = (bigItem.files || []).find((f) => path.basename(f.path).includes('big-5.8mb'));
  assert.ok(bigFileRef && fs.existsSync(bigFileRef.path), '原文件应归档并挂在条目 files 上');
  assert.ok(Math.abs(fs.statSync(bigFileRef.path).size - fs.statSync(bigPath).size) === 0, '归档原文件大小应与源一致');
  step('S2 5.8MB：预检截断、commit 完整重读（尾部标记入库）、原文件归档一致');

  // S2b 二进制附件不漏：A 的 planImport 只收文本来源，二进制附件以 warning 拒收且不产生 entry；
  // D 的桥必须把它归档为文件包条目（绝不静默丢内容），且字节数一致
  const binPath = path.join(tmpRoot, '测算表.xlsx');
  fs.writeFileSync(binPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]));
  const pvBin = await main2.evaluate(async ({ txt, bin }) => window.vault.importPreview({ text: '附上测算表\n', files: [bin], source: 'check' }), { txt: '', bin: binPath });
  assert.ok(pvBin.ok && pvBin.entries.length === 1, '二进制被拒收后应只剩 1 个文本条目');
  assert.ok((pvBin.warnings || []).some((w) => w.code === 'UNREADABLE_BINARY'), '预检应如实提示二进制拒收');
  const cmBin = await main2.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: { [p.entries[0].sourceKey]: 'keep' } }), pvBin);
  assert.ok(cmBin.ok, '含二进制附件的提交应成功');
  const binBundle = await until(() => lib(t1).find((i) => (i.files || []).some((f) => path.basename(f.path) === '测算表.xlsx')) || null, '二进制附件未被归档（桥缺失）');
  const archived = fs.readFileSync((binBundle.files || []).find((f) => path.basename(f.path) === '测算表.xlsx').path);
  assert.ok(Buffer.compare(archived, fs.readFileSync(binPath)) === 0, '归档的二进制附件必须字节一致');
  step('S2b 二进制附件不漏：A 拒收的附件由 D 桥归档为文件包条目，字节一致');

  // S3 超提交上限（21MB > 20MB commit cap）→ 明确失败，不入库
  const hugePath = path.join(tmpRoot, 'huge-21mb.txt');
  {
    const chunk = '超限测试行。\n'.repeat(200);
    let fh = fs.openSync(hugePath, 'w');
    while (fs.statSync(hugePath).size < 21 * 1024 * 1024) fs.writeSync(fh, chunk);
    fs.closeSync(fh);
  }
  const pvHuge = await main2.evaluate(async (f) => window.vault.importPreview({ files: [f], source: 'check' }), hugePath);
  const cmHuge = await main2.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: { [p.entries[0].sourceKey]: 'keep' } }), pvHuge);
  assert.ok(cmHuge.ok === true, '批次本身返回 ok，但该条必须失败'); // 批次处理完成＝ok；条目级失败见 failed
  assert.equal(cmHuge.failed.length, 1, '超限条目必须失败');
  assert.equal(cmHuge.issues[0].code, 'COMMIT_TOO_LARGE', '失败码应为 COMMIT_TOO_LARGE');
  assert.ok(cmHuge.issues[0].message.includes('超过提交上限'), '失败原因必须可读（不能只有哈希）');
  assert.ok(!lib(t1).some((i) => (i.notes || '').includes('超限测试行')), '超限文件不得入库');
  step('S3 超 20MB：条目明确失败（COMMIT_TOO_LARGE + 可读原因），未把前缀当全文入库');

  // S4 源变化 → SOURCE_CHANGED；decisions 严格校验；数组形式可用；跳过不入库
  const small1 = path.join(tmpRoot, 'small-one.txt');
  fs.writeFileSync(small1, '孙七 10:00\n小文件一：新鲜度验证\n');
  const pvS4 = await main2.evaluate(async (f) => window.vault.importPreview({ files: [f], source: 'check' }), small1);
  const keyS4 = pvS4.entries[0].sourceKey;
  const bad1 = await main2.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: { 'src-not-in-plan': 'keep' } }), pvS4);
  assert.equal(bad1.error, 'DECISIONS_UNKNOWN_KEY', '未知 sourceKey 必须显式报错');
  const bad2 = await main2.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: { [p.entries[0].sourceKey]: 'bogus' } }), pvS4);
  assert.equal(bad2.error, 'DECISIONS_INVALID', '未知 decisions 值必须显式报错');
  fs.appendFileSync(small1, '预检之后追加的一行\n');
  const stale = await main2.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: { [p.entries[0].sourceKey]: 'keep' } }), pvS4);
  assert.equal(stale.error, 'SOURCE_CHANGED', '源文件变化必须要求重新预览');
  assert.ok(!lib(t1).some((i) => (i.notes || '').includes('小文件一')), '源变化后不得部分提交');
  step('S4 decisions 严格校验（未知键/值显式报错）；源变化 SOURCE_CHANGED 阻止提交');
  // 数组形式 + skip：跳过项不入库
  const small2 = path.join(tmpRoot, 'small-two.txt');
  fs.writeFileSync(small2, '小文件二：数组决策验证\n');
  const pvS4b = await main2.evaluate(async (f) => window.vault.importPreview({ files: [f], source: 'check' }), small2);
  const arr = await main2.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: [{ sourceKey: p.entries[0].sourceKey, action: 'skip' }] }), pvS4b);
  assert.ok(arr.ok && arr.skipped.length === 1 && arr.succeeded.length === 0, '数组 decisions 应生效且该条 skipped');
  assert.ok(!lib(t1).some((i) => (i.notes || '').includes('小文件二')), 'skip 条目绝不入库');
  step('S4 数组形式 decisions：skip 生效且不入库');

  // S5 部分失败 → 只重试失败项 → 重启幂等
  // 种子必须为 ≥2 条消息（A 设计：单条消息判为 note），否则不是 chat、无法追加
  const seedPv = await main2.evaluate(async () => window.vault.importPreview({ text: '赵六 09:00\n追加基准消息\n---\n赵六 09:05\n第二条基准\n', targetItemId: null, source: 'check' }));
  const seedCm = await main2.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: { [p.entries[0].sourceKey]: 'keep' } }), seedPv);
  const seedChatId = seedCm.itemIds[0];
  assert.ok(seedChatId, '基准聊天应入库');
  const beforeAppend = lib(t1).find((i) => i.id === seedChatId).messages.length;
  // 同一批次：小文件追加到 seedChat（成功） + 21MB 大文件（同 target，超限失败）
  const pvS5 = await main2.evaluate(async ({ f1, f2, target }) => window.vault.importPreview({ files: [f1, f2], targetItemId: target, source: 'check' }), { f1: small1, f2: hugePath, target: seedChatId });
  assert.equal(pvS5.entries.length, 2, 'S5 预检应有 2 个条目');
  const cmS5 = await main2.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: Object.fromEntries(p.entries.map((e) => [e.sourceKey, 'keep'])) }), pvS5);
  assert.equal(cmS5.succeeded.length, 1, '应成功 1 条（小文件追加）');
  assert.equal(cmS5.failed.length, 1, '应失败 1 条（大文件超限）');
  const afterAppend = lib(t1).find((i) => i.id === seedChatId).messages.length;
  assert.ok(afterAppend > beforeAppend, '成功条目的消息已追加');
  step('S5 部分失败：成功 1 + 失败 1（可读原因），成功项已持久化');
  // 重试：只处理失败项；成功项不重复导入
  const st1 = await main2.evaluate(async (b) => window.vault.importStatus(b), cmS5.batchId);
  assert.ok(st1.ok && st1.completed === false, 'importStatus 应报未完成（有失败项）');
  const rt1 = await main2.evaluate(async (b) => window.vault.importRetry(b), cmS5.batchId);
  assert.ok(rt1.ok, '重试应执行');
  assert.equal(rt1.succeeded.length, 1, '重试后成功集合不变（成功项不重导）');
  assert.equal(lib(t1).find((i) => i.id === seedChatId).messages.length, afterAppend, '成功条目不得重复追加');
  assert.equal(rt1.failed.length, 1, '大文件仍超限 → 依旧失败');
  assert.ok(rt1.failed[0].message && rt1.failed[0].sourceKey, '失败项必须带 sourceKey 与可读原因');
  step('S5 重试幂等：只重试失败项，成功项未重复导入，失败原因可读');
  // 重启后：批次/计划从磁盘恢复，重复提交不重复入库
  await closeSafe(app2);
  const { app: app2b, page: main2b } = await launch(t1);
  const st2 = await main2b.evaluate(async (b) => window.vault.importStatus(b), cmS5.batchId);
  assert.ok(st2.ok && st2.completed === false && st2.failed.length === 1, '重启后批次状态从磁盘恢复');
  const cmAgain = await main2b.evaluate(async (p) => window.vault.importCommit({ planId: p.planId, decisions: Object.fromEntries(p.entries.map((e) => [e.sourceKey, 'keep'])) }), pvS5);
  assert.equal(cmAgain.succeeded.length, 1, '重启后重复提交：成功项仍不重复导入');
  assert.equal(lib(t1).find((i) => i.id === seedChatId).messages.length, afterAppend, '重启后成功条目仍不重复追加');
  step('S5 重启幂等：批次落盘恢复，重复提交/重试均不重复入库');
  await closeSafe(app2b);

  // ================= S6：便携包（导出 → 恢复 → OLD/NEW 冲突 → 幂等 → 损坏包零残留） =================
  const tA = mkTmp('portable-A');
  const seedBase = (attachDir, id, title, notes) => {
    const fooPath = path.join(attachDir, 'foo.txt');
    return {
      id, kind: 'note', title, text: '', notes, created_at: 1789000000000, updated_at: 1789000000000,
      files: [{ path: fooPath, name: 'foo.txt', ext: '.txt', size: fs.statSync(fooPath).size }],
    };
  };
  const attachDir = path.join(tA, 'files', '1789000000001');
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, 'foo.txt'), 'OLD-CONTENT-foo');
  // Store 的 library.json 是纯数组格式（写成 {items:[]} 会让 migrate 崩溃退出）
  fs.writeFileSync(path.join(tA, 'data/library.json'), JSON.stringify([seedBase(attachDir, 'uid-x', '老资料X', 'old')]));
  const { app: appA, page: mainA } = await launch(tA);
  const exportParent = path.join(tmpRoot, 'export-out');
  fs.mkdirSync(exportParent, { recursive: true });
  await stubDialog(appA, [exportParent]);
  const ex = await mainA.evaluate(() => window.vault.portableExport());
  assert.ok(ex.ok && ex.outputPath, '导出应成功并返回输出路径');
  assert.ok(ex.records >= 1 && ex.attachmentsIncluded === 1, `导出清单应含记录与附件（${ex.records}/${ex.attachmentsIncluded}）`);
  assert.equal(ex.complete, true, 'complete 应如实为 true');
  assert.ok(fs.existsSync(path.join(ex.outputPath, 'manifest.json')), 'manifest.json 应存在（提交标记）');
  const bundleA = ex.outputPath;
  assert.equal(fs.readFileSync(path.join(bundleA, 'files/1789000000001/foo.txt'), 'utf8'), 'OLD-CONTENT-foo', '包内附件内容应正确');
  step('S6 导出：真实 IPC 产出文件夹包（manifest + 记录 + 附件），字段映射完整');

  // 隔离库 B：预检 → 恢复 → 校验
  const tB = mkTmp('portable-B');
  const { app: appB, page: mainB } = await launch(tB);
  await stubDialog(appB, [bundleA]);
  const pvA = await mainB.evaluate(() => window.vault.portablePreview());
  assert.ok(pvA.ok && pvA.planId, '预检应成功并返回计划号');
  assert.ok(pvA.adds >= 1 && pvA.conflicts === 0, `预检新增/冲突应正确（${pvA.adds}/${pvA.conflicts}）`);
  assert.equal(pvA.attachmentsFound, 1, '附件校验：包内可用 1');
  assert.equal(pvA.attachmentsMissing, 0);
  const rsA = await mainB.evaluate(async (p) => window.vault.portableRestore({ planId: p.planId }), pvA);
  assert.ok(rsA.ok && rsA.restored >= 1, '恢复应成功');
  assert.equal(rsA.attachmentsRestored, 1, '附件落位 1');
  const bItems = lib(tB);
  assert.ok(bItems.some((i) => i.id === 'uid-x'), 'uid-x 已恢复进库 B');
  const bx = bItems.find((i) => i.id === 'uid-x');
  const bAttach = fs.readFileSync(bx.files[0].path, 'utf8');
  assert.equal(bAttach, 'OLD-CONTENT-foo', '库 B 恢复的附件应读到 OLD 内容');
  assert.ok(bx.files[0].path.startsWith(tB), '附件引用应重写到库 B 内部');
  step('S6 恢复：跨隔离库附件可打开、引用重写正确');

  // OLD/NEW 冲突：库 C 打包（新 ID uid-y + 同相对路径附件内容 NEW）→ 恢复进库 B
  const tC = mkTmp('portable-C');
  const attachC = path.join(tC, 'files', '1789000000001');
  fs.mkdirSync(attachC, { recursive: true });
  fs.writeFileSync(path.join(attachC, 'foo.txt'), 'NEW-CONTENT-foo');
  fs.writeFileSync(path.join(tC, 'data/library.json'), JSON.stringify([seedBase(attachC, 'uid-y', '新资料Y', 'new')]));
  const { app: appC, page: mainC } = await launch(tC);
  await stubDialog(appC, [exportParent]);
  const exC = await mainC.evaluate(() => window.vault.portableExport());
  assert.ok(exC.ok, '库 C 导出应成功');
  const bundleC = exC.outputPath;
  await closeSafe(appC);

  await stubDialog(appB, [bundleC]);
  const pvC = await mainB.evaluate(() => window.vault.portablePreview());
  assert.ok(pvC.ok && pvC.adds >= 1, '库 B 预检包 C：应有新增');
  const rsC = await mainB.evaluate(async (p) => window.vault.portableRestore({ planId: p.planId }), pvC);
  assert.ok(rsC.ok && rsC.restored >= 1, '包 C 恢复应成功');
  assert.ok(rsC.conflictsRemapped >= 1, `同路径异内容应重映射（${rsC.conflictsRemapped}）`);
  const bItems2 = lib(tB);
  const oldX = bItems2.find((i) => i.id === 'uid-x');
  const newY = bItems2.find((i) => i.id === 'uid-y');
  assert.ok(oldX && newY, 'uid-x 保留、uid-y 新增');
  assert.equal(fs.readFileSync(oldX.files[0].path, 'utf8'), 'OLD-CONTENT-foo', '旧记录一字不动，仍读 OLD');
  assert.ok(newY.files[0].path.includes('from-bundle-'), '新记录应指向 from-bundle 哈希命名新路径');
  assert.equal(fs.readFileSync(newY.files[0].path, 'utf8'), 'NEW-CONTENT-foo', '新记录实际读到 NEW');
  step('S6 OLD/NEW 冲突：旧记录读 OLD、新记录读 NEW（逐字节核对）');
  // 重复恢复幂等
  const rsC2 = await mainB.evaluate(async (p) => window.vault.portableRestore({ planId: p.planId }), pvC);
  assert.ok(rsC2.ok && rsC2.restored === 0 && rsC2.skipped >= 1 && rsC2.attachmentsRestored === 0, '重复恢复：added=0、零附件复制');
  step('S6 重复恢复幂等：不复制条目、不新增附件');
  // 损坏包拒绝且零残留
  const libBefore = fs.readFileSync(path.join(tB, 'data/library.json'), 'utf8');
  const badBundle = path.join(tmpRoot, 'bundle-broken');
  fs.mkdirSync(badBundle, { recursive: true });
  fs.cpSync(bundleC, badBundle, { recursive: true });
  fs.writeFileSync(path.join(badBundle, 'manifest.json'), '{"format":"broken",');
  await stubDialog(appB, [badBundle]);
  const pvBad = await mainB.evaluate(() => window.vault.portablePreview());
  assert.ok(pvBad.ok === false, '损坏包预检必须拒绝');
  assert.equal(fs.readFileSync(path.join(tB, 'data/library.json'), 'utf8'), libBefore, '拒绝后库零写入');
  // 取消语义
  await stubDialog(appB, []);
  const pvCancel = await mainB.evaluate(() => window.vault.portablePreview());
  assert.ok(pvCancel.cancelled === true, '取消返回 {cancelled:true}');
  const exCancel = await mainB.evaluate(() => window.vault.portableExport());
  assert.ok(exCancel.cancelled === true, '导出取消返回 {cancelled:true}');
  assert.equal(fs.readFileSync(path.join(tB, 'data/library.json'), 'utf8'), libBefore, '取消后库零写入');
  step('S6 损坏包拒绝零残留；取消一律 {cancelled:true} 且零写入');
  await mainB.screenshot({ path: path.join(out, 'S6-主窗-整合后界面.png') });
  await closeSafe(appB);
  await closeSafe(appA);

  fs.writeFileSync(path.join(out, 'integration-import-result.json'), JSON.stringify({ ok: true, steps, errors, tmpRoot }, null, 2));
  console.log('INTEGRATION_IMPORT_CHECK_OK ' + steps.length);
  console.log('TMP_ROOT=' + tmpRoot);
})().catch((e) => {
  console.error(e.stack);
  try { fs.mkdirSync(out, { recursive: true }); } catch {}
  fs.writeFileSync(path.join(out, 'integration-import-result.json'), JSON.stringify({ ok: false, steps, errors, error: String(e.stack), tmpRoot }, null, 2));
  process.exitCode = 1;
});
