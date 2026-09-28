#!/usr/bin/env node
/** LV-20260924-B 验收脚本（B 白名单文件）
 * 用法：node scripts/round-b-check.js [static|pure|fixture|real|all]   默认 all
 *
 *  static   flow-ui.js 可加载 + API 面齐全 + 关键标记 + renderer 无 Node 检查
 *           （内联脚本语法由 fixture/real 段真实页面加载与 pageerror 监控覆盖）
 *  pure     flow-ui.js 纯函数 Node 直测（计划归一化 / 视图模型 / 提交结果归一化）
 *  fixture  Electron + 桩 IPC（交付物 fixture 壳加载真实 quick.html）：
 *           预检面板、问题定位、勾选跳过、批量提交、部分失败只重试失败项、
 *           关闭重启恢复草稿与批次、中文 IME 不误提交、反复切类型不重置、420×460
 *  real     真实应用 + 临时库（LV_CONFIG_DIR 隔离，关桥接/提醒）：
 *           一句话直接保存、轻量成功反馈（打开/再记一条/撤销）、
 *           预检双态断言（QA-R1：有 importPreview→断言 plan 模式与胶囊定位；无→断言本地降级标注）、
 *           多文件、重启恢复草稿、点子「下一步」与撤销
 *
 * 边界：importPreview/Commit/Status/Retry 由 D 集成，fixture 段用明确标注的桩验证 UI；
 *       真实全链路（新导入 IPC + 真实库）待 D 集成后由 D/总控复验。
 * QA-R2：段间关闭改为有界等待（20s）+ 身份校验兜底清理（仅命令行含本轮临时库路径者
 *         或本次 launch 主进程后代；SIGTERM→3s 宽限→SIGKILL）。正常关闭与兜底分别记录，
 *         兜底≠正常关闭。环境变量：LV_B_APP_ROOT=real 段被测应用根（默认本工作区）；
 *         LV_B_OUT=产物输出根（默认 B 报告目录）。
 * 产物：交付物/ZCode优化-20260924/B/{screenshots,logs} */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');                 // 被测项目根（workspace 副本或正式项目）
const delivCandidates = [
  path.resolve(__dirname, '..', '..', '..', 'B'),           // workspace 模式：workspaces/B/scripts → …/ZCode优化-20260924/B
  path.join(root, '交付物', 'ZCode优化-20260924', 'B'),      // 正式项目模式
];
const deliv = delivCandidates.find(p => fs.existsSync(path.join(p, 'fixture', 'package.json')))
  || delivCandidates[1];
const fixtureDir = path.join(deliv, 'fixture');   // fixture 桩固定属于 B 报告目录（与输出根无关）

const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
// QA-R2：real 段被测应用根（默认 B 自身；指向 D 最终副本时复验集成态）与产物输出根（默认 B 报告目录）
const APP_ROOT = process.env.LV_B_APP_ROOT || root;
const outBase = process.env.LV_B_OUT || deliv;
const shotDir = path.join(outBase, 'screenshots');
const logDir = path.join(outBase, 'logs');
fs.mkdirSync(shotDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
const electronBinFor = r => path.join(r, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
// playwright 不在项目依赖里；按字面量候选依次尝试（与本机 v0.10.1 验证环境一致）
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  try { return require('playwright-core'); } catch {}
  return null;
}

const report = [];
function check(name, cond, info = '') {
  report.push({ name, pass: !!cond, info: String(info) });
  console.log((cond ? '✓ ' : '✗ ') + name + (info ? ' — ' + info : ''));
  return !!cond;
}
function section(title) { console.log('\n===== ' + title + ' ====='); }

function readCalls(tmp) {
  try {
    return fs.readFileSync(path.join(tmp, 'calls.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- QA-R2：有界关闭 + 身份校验兜底清理 ----
 * 只作用于本脚本以独立临时目录（mkdtemp，全局唯一）启动的 Electron 实例：
 * 兜底匹配 =「命令行含本轮临时库路径」∪「本次 launch 主进程 pid 的全部后代」，
 * 绝不按应用名或宽泛模式批量杀。正常关闭与兜底分别记录，兜底不伪装为正常关闭。 */
const liveApps = new Map();   // app → { pid, tmp, tag }
const closeLog = [];          // 每次关闭的结果（normal-close / close-error / fallback-kill）
function trackApp(app, pid, tmp, tag) { try { liveApps.set(app, { pid: pid || null, tmp, tag }); } catch {} }
function snapshotProcesses() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,command='], { stdio: 'pipe' }).toString().split('\n').filter(Boolean);
  } catch { return []; }
}
async function killByTmpScope(pid, tmp, tag) {
  const procs = snapshotProcesses().map(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[4] } : null;
  }).filter(Boolean);
  const byTmp = new Set(procs.filter(p => tmp && p.cmd.includes(tmp)).map(p => p.pid));
  const kin = new Set([pid].filter(Boolean));
  let grew = true;
  while (grew) { grew = false; for (const p of procs) if (kin.has(p.ppid) && !kin.has(p.pid)) { kin.add(p.pid); grew = true; } }
  const targets = [...new Set([...byTmp, ...kin])].filter(t => t && t !== process.pid);
  const evidence = procs.filter(p => targets.includes(p.pid)).map(p => `${p.pid} ${p.ppid} ${p.cmd.slice(0, 150)}`);
  for (const t of targets) { try { process.kill(t, 'SIGTERM'); } catch {} }
  let alive = targets;
  for (let i = 0; i < 10 && alive.length; i++) {
    await sleep(300);
    alive = targets.filter(t => { try { process.kill(t, 0); return true; } catch { return false; } });
  }
  for (const t of alive) { try { process.kill(t, 'SIGKILL'); } catch {} }
  return { mode: 'fallback-kill', normal: false, tag, sigterm: targets, sigkillAfterGrace: alive, matchedBy: 'cmdline∋tmp 或 launch pid 后代', evidence };
}
async function boundedClose(app) {
  const meta = liveApps.get(app) || {};
  const tag = meta.tag || 'unknown';
  let outcome = null;
  const closeP = Promise.resolve().then(() => app.close()).then(() => { outcome = outcome || 'normal'; }, e => { outcome = outcome || 'close-error:' + ((e && e.message) || e); });
  const timedOut = (await Promise.race([closeP.then(() => false), sleep(20000).then(() => true)])) === true;
  liveApps.delete(app);
  if (!timedOut) {
    const rec = { mode: outcome === 'normal' ? 'normal-close' : 'close-error', normal: outcome === 'normal', tag, outcome };
    closeLog.push(rec);
    if (outcome !== 'normal') console.log('⚠ 关闭异常返回（非超时）：' + tag + ' — ' + outcome);
    return rec;
  }
  // 超时兜底：不再等待原始 close promise（可能永不返回），按身份清理后继续跑后续段落
  closeP.catch(() => {});
  const cleanup = await killByTmpScope(meta.pid, meta.tmp || '', tag);
  cleanup.timeoutMs = 20000;
  closeLog.push(cleanup);
  console.log('⚠ 兜底清理（非正常关闭，等待 20s 超时）：' + tag + ' — sigterm=' + JSON.stringify(cleanup.sigterm) + ' sigkill=' + JSON.stringify(cleanup.sigkillAfterGrace) + ' 匹配=' + cleanup.matchedBy);
  for (const line of cleanup.evidence) console.log('   残留进程快照：' + line);
  return cleanup;
}

const CHAT3 = '阿宁 09:12\n分镜先画九宫格，再写提示词\n[文件] 九宫格模板.pdf\n---\n我 09:14\n收到，下午就试\n---\n小群\nFAIL 这条没写时间';

/* ---------------- static ---------------- */
function runStatic() {
  section('static 可加载与标记');
  let api = null;
  try { api = require('../shared/flow-ui.js'); check('flow-ui.js 可加载（require 即全量解析）', true); }
  catch (e) { check('flow-ui.js 可加载（require 即全量解析）', false, e.message); return; }
  for (const fn of ['normPlan', 'localPlan', 'precheckViewModel', 'renderPrecheck', 'normCommitResult', 'appendPreview', 'planCounts', 'deriveMessageIssues']) {
    check('flow-ui.api.' + fn, typeof api[fn] === 'function');
  }
  for (const file of ['quick/quick.html', 'idea/idea.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    check(file + ' 内联脚本数量=1', scripts.length === 1, '实际 ' + scripts.length);
    const inline = scripts.join('\n');
    check(file + ' renderer 不用 Node（无 require/fs）', !/\brequire\s*\(/.test(inline) && !/\bfs\./.test(inline));
  }
  const quick = fs.readFileSync(path.join(root, 'quick', 'quick.html'), 'utf8');
  for (const marker of ['precheckHost', 'quick-preview', 'importPreview', 'importCommit', 'importRetry', 'importStatus', 'saveRawBtn', 'dbNext', 'needsPrecheck', 'localPlan']) {
    check('quick.html 标记 ' + marker, quick.includes(marker));
  }
  const idea = fs.readFileSync(path.join(root, 'idea', 'idea.html'), 'utf8');
  for (const marker of ['data-next', 'nextset', 'ideaUndoBtn', 'ideasPatch', 'ideadone']) {
    check('idea.html 标记 ' + marker, idea.includes(marker));
  }
}

/* ---------------- pure ---------------- */
function runPure() {
  section('pure 纯函数（Node 直测 flow-ui）');
  const F = require('../shared/flow-ui.js');
  // A schema 示例（含字符串 issues、缺字段、summary 计数）
  const plan = {
    planId: 'plan-1',
    entries: [
      { sourceKey: 'k1', kind: 'message', raw: '阿宁 09:12 分镜先画九宫格', parsed: { speaker: '阿宁', time: '09:12', text: '分镜先画九宫格', attachment: { name: '模板.pdf', pending: true } }, issues: [] },
      { sourceKey: 'k2', kind: 'message', raw: '我 09:14 收到', parsed: { speaker: '我', time: '09:14', text: '收到' }, issues: ['可能与已有聊天重复'] },
      { sourceKey: 'k3', kind: 'file', raw: 'a.pdf', parsed: { attachment: { name: 'a.pdf' } }, issues: [{ type: 'missing-file', message: '附件缺失' }] },
    ],
    summary: { messages: 2, files: 1 },
    warnings: [{ message: '两条来源时间相同' }, '普通字符串告警'],
  };
  const vm1 = F.precheckViewModel({ plan, decisions: {}, mode: 'plan' });
  check('视图模型：条目数', vm1.entryRows.length === 3, vm1.entryRows.length);
  check('视图模型：k1 自动补待补附件', vm1.issueRows.some(r => r.entryKey === 'k1' && r.type === 'pending-attachment'));
  check('视图模型：字符串 issue 归为可能重复', vm1.issueRows.some(r => r.entryKey === 'k2' && r.type === 'possible-duplicate'));
  check('视图模型：k3 附件缺失 danger', vm1.issueRows.some(r => r.entryKey === 'k3' && r.type === 'missing-file' && r.severity === 'danger'));
  check('视图模型：文件条定位 file 索引', vm1.issueRows.find(r => r.entryKey === 'k3').loc.index === 0);
  check('视图模型：k1 定位到附件字段', vm1.issueRows.filter(r => r.entryKey === 'k1').every(r => r.loc.type === 'attachment'));
  check('视图模型：summary 文本', vm1.summaryText.includes('2 条消息') && vm1.summaryText.includes('1 个文件'), vm1.summaryText);
  check('视图模型：warnings 字符串化', vm1.warnings.includes('普通字符串告警') && vm1.warnings.some(w => w.includes('时间相同')));
  check('视图模型：plan 模式标注', vm1.modeNote.includes('导入预检'));
  const vm2 = F.precheckViewModel({ plan, decisions: { k2: 'skip', k3: 'skip' }, mode: 'plan' });
  check('勾选跳过：kept=false', vm2.entryRows.filter(r => !r.kept).length === 2);
  const vmLocal = F.precheckViewModel({ plan: F.localPlan([{ speaker: '', time: '', text: '缺说话人', speakerUnknown: true, timeUnknown: true }], ['/tmp/a.md']), decisions: {}, mode: 'local' });
  check('本地预检：缺说话人/缺时间自动推导', vmLocal.issueRows.some(r => r.type === 'missing-speaker') && vmLocal.issueRows.some(r => r.type === 'missing-time'));
  check('本地预检：标注走原通道', vmLocal.modeNote.includes('原通道'), vmLocal.modeNote);
  check('本地预检：warning 提示接口未接入', vmLocal.warnings.some(w => w.includes('importPreview')));
  const cr1 = F.normCommitResult({ batchId: 'b1', succeeded: [{ sourceKey: 'k1' }], failed: ['附件不存在'], skipped: 1, itemIds: ['i1'] });
  check('提交结果：字符串失败映射', cr1.failed.length === 1 && cr1.failed[0].message === '附件不存在');
  check('提交结果：数量形态 skipped', cr1.skipped.length === 1);
  const cr2 = F.normCommitResult({ ok: false, error: '计划过期' });
  check('提交结果：error 转失败行', cr2.failed.length === 1 && cr2.failed[0].message === '计划过期');
  const empty = F.precheckViewModel({ plan: null, mode: 'local' });
  check('空计划不崩溃且显示空内容', empty.summaryText === '空内容' && empty.problemCount === 0);
  const unknown = F.precheckViewModel({ plan: { entries: [{ sourceKey: 'x', kind: 'message', raw: 'r', parsed: { speaker: 'a', time: 'b', text: 'c' }, issues: ['神秘问题'] }] }, mode: 'plan' });
  check('未知 issue 文案归为提示', unknown.issueRows[0].label === '提示' || unknown.issueRows[0].type === 'note', unknown.issueRows[0].type);
  /* QA-R1 回归：多消息来源条目（D 集成后真实形态）——issues[].index 为消息内序号，
     定位必须优先 iss.index，而不是条目自身的序号（缺陷：缺时间胶囊曾定位到第 1 卡） */
  const mm = F.precheckViewModel({
    plan: {
      entries: [{
        sourceKey: 's1', kind: 'message', raw: '整段聊天原文', issues: [
          { type: 'missing-speaker', index: 0 },
          { type: 'missing-time', index: 2 },
          { type: 'pending-attachment', index: 0, message: '九宫格模板.pdf' },
          { type: 'possible-duplicate' }, // 无 index → 回退条目序号
        ],
      }],
    },
    mode: 'plan',
  });
  const rTime = mm.issueRows.find(r => r.type === 'missing-time');
  check('R1 纯函数：缺时间定位优先 issue.index=2', rTime.loc.index === 2 && rTime.loc.type === 'time', JSON.stringify(rTime.loc));
  const rAtt = mm.issueRows.find(r => r.type === 'pending-attachment');
  check('R1 纯函数：待补附件定位 issue.index=0', rAtt.loc.index === 0 && rAtt.loc.type === 'attachment', JSON.stringify(rAtt.loc));
  const rNoIdx = mm.issueRows.find(r => r.type === 'possible-duplicate');
  check('R1 纯函数：无 index 回退条目序号', rNoIdx.loc.index === 0 && rNoIdx.loc.type === 'text', JSON.stringify(rNoIdx.loc));
  const single = F.precheckViewModel({
    plan: { entries: [{ sourceKey: 'k', kind: 'message', raw: 'r', parsed: { speaker: '', time: '09:00', text: 'x' }, issues: [] }] },
    mode: 'plan',
  });
  check('R1 纯函数：单消息条目仍回退 e.index=0', single.issueRows.length > 0 && single.issueRows.every(r => r.loc.index === 0));
}

/* ---------------- fixture ---------------- */
async function launchFixture(pw, scenario, tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const app = await pw._electron.launch({
    executablePath: electronBin,
    args: [fixtureDir],
    env: { ...process.env, LV_B_FIXTURE: scenario, LV_B_TMP: tmp, LV_B_WORKSPACE: root },
  });
  const errors = [];
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  let win = null;
  for (let i = 0; i < 150 && !win; i++) {
    win = app.windows().find(w => w.url().includes('quick.html'));
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('fixture 窗口未出现');
  await win.waitForSelector('#mainInput', { timeout: 15000 });
  let pid = null;
  try { pid = app.process && app.process() ? app.process().pid : null; } catch {}
  trackApp(app, pid, tmp, 'fixture:' + scenario);
  return { app, win, errors, tmp };
}
async function pasteChat(win, text) {
  await win.locator('#mainInput').fill(text);
  await win.locator('#mainInput').dispatchEvent('paste');
  await win.locator('.msgcard').first().waitFor({ timeout: 8000 });
}
async function shot(win, name) {
  const p = path.join(shotDir, name);
  await win.screenshot({ animations: 'disabled', path: p });
  return fs.existsSync(p) && fs.statSync(p).size > 1000;
}
async function uncheckEntryContaining(win, text) {
  const boxes = win.locator('.pc-entry input[type=checkbox]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const label = await boxes.nth(i).getAttribute('aria-label');
    if (label && label.includes(text)) { await boxes.nth(i).uncheck(); return true; }
  }
  return false;
}

async function runFixture(pw) {
  section('fixture UI（桩 IPC，加载真实 quick.html）');
  if (!fs.existsSync(electronBin)) { check('fixture：Electron 可用', false, electronBin); return; }
  if (!pw) { check('fixture：playwright 可用', false, '未找到 playwright'); return; }

  /* 场景1：import-ok 预检 → 定位 → 勾选跳过 → 批量提交（含重复点击保护） */
  {
    const { app, win, errors, tmp } = await launchFixture(pw, 'import-ok', path.join(logDir, 'fx-ok'));
    try {
      await pasteChat(win, CHAT3);
      check('fixture：长聊天拆成 3 张消息卡', await win.locator('.msgcard').count() === 3);
      await shot(win, '01-fixture-聊天拆分.png');
      await win.locator('#submitBtn').click();
      await win.locator('#precheckPanel').waitFor({ timeout: 8000 });
      const headText = await win.locator('.pc-title').innerText();
      check('fixture：预检摘要显示 3 条消息', headText.includes('3 条消息'), headText.trim());
      check('fixture：问题徽标出现', ((await win.locator('.pc-badge-warn').innerText()) || '').includes('注意'));
      check('fixture：plan 模式标注（导入预检）', ((await win.locator('.pc-mode').innerText()) || '').includes('导入预检'));
      const chips = await win.locator('.pc-issue').allInnerTexts();
      check('fixture：待补附件问题列出', chips.some(t => t.includes('待补附件')), chips.join(' | '));
      check('fixture：缺时间问题列出', chips.some(t => t.includes('缺时间')), chips.join(' | '));
      await shot(win, '02-fixture-预检清单.png');
      // 点击问题定位：缺时间 → 第 3 张卡时间输入聚焦
      await win.locator('.pc-issue', { hasText: '缺时间' }).first().click();
      const focused = await win.evaluate(() => { const el = document.activeElement; return { cls: String(el.className), i: el.dataset ? el.dataset.i : null }; });
      check('fixture：缺时间定位到第 3 条消息时间框', focused.cls.includes('mc-time') && focused.i === '2', JSON.stringify(focused));
      // 待补附件 → 第 1 张消息卡闪烁
      await win.locator('.pc-issue', { hasText: '待补附件' }).first().click();
      await sleep(200);
      check('fixture：待补附件定位闪烁第 1 条卡', await win.evaluate(() => !!document.querySelector('.msgcard[data-i="0"].flash')));
      // 编辑说话人 → 预检自动重建（内容有修改仍保留清单）
      await win.locator('.mc-speaker[data-i="1"]').fill('改名了');
      await sleep(1100);
      const previewCalls = readCalls(tmp).filter(c => c.name === 'importPreview');
      check('fixture：编辑后预检自动重建', previewCalls.length >= 2, 'importPreview 调用 ' + previewCalls.length);
      check('fixture：重建后消息卡编辑保留', (await win.locator('.mc-speaker[data-i="1"]').inputValue()) === '改名了');
      // 勾选跳过含 FAIL 的条目 → 同步双击保存（busy 守卫只允许一次提交）
      check('fixture：勾选跳过 FAIL 条目', await uncheckEntryContaining(win, 'FAIL'));
      await win.evaluate(() => { const b = document.getElementById('submitBtn'); b.click(); b.click(); });
      await win.locator('.donebar.show').waitFor({ timeout: 8000 });
      const doneText = await win.locator('.db-text').innerText();
      check('fixture：批量保存成功反馈（已存入 2 条）', doneText.includes('已存入 2 条'), doneText);
      const commits = readCalls(tmp).filter(c => c.name === 'importCommit');
      check('fixture：重复点击只提交一次', commits.length === 1, 'importCommit 调用 ' + commits.length);
      const decisions = (commits[0] && commits[0].arg && commits[0].arg.decisions) || {};
      check('fixture：跳过决定随提交传递', Object.values(decisions).filter(v => v === 'skip').length === 1, JSON.stringify(decisions));
      check('fixture：成功后输入区清空', (await win.locator('#mainInput').inputValue()) === '');
      check('fixture：420×460 无横向溢出', await win.evaluate(() => document.documentElement.scrollWidth <= 421), 'scrollWidth=' + await win.evaluate(() => document.documentElement.scrollWidth));
      await shot(win, '03-fixture-批量保存成功.png');
      check('fixture：场景1 无页面错误', errors.length === 0, errors.join(' | '));
    } finally { await boundedClose(app); }
  }

  /* 场景2：import-partial 部分失败 → 只重试失败项 */
  {
    const { app, win, errors, tmp } = await launchFixture(pw, 'import-partial', path.join(logDir, 'fx-partial'));
    try {
      await pasteChat(win, CHAT3);
      await win.locator('#submitBtn').click();
      await win.locator('#precheckPanel').waitFor({ timeout: 8000 });
      await win.locator('#submitBtn').click();
      await win.locator('.pc-result .fail').first().waitFor({ timeout: 8000 });
      check('fixture：失败原因逐条列出', ((await win.locator('.pc-result .fail').first().innerText()) || '').includes('fixture 模拟失败'));
      check('fixture：成功项同时列出', ((await win.locator('.pc-result .ok').innerText()) || '').includes('已保存 2 条'));
      check('fixture：出现「只重试失败项」', await win.locator('.pc-retry').isVisible());
      check('fixture：部分失败不弹完成条不关窗', !(await win.locator('.donebar.show').isVisible()));
      await shot(win, '04-fixture-部分失败.png');
      await win.locator('.pc-retry').click();
      await win.locator('.donebar.show').waitFor({ timeout: 8000 });
      check('fixture：重试后完成（已存入 1 条）', ((await win.locator('.db-text').innerText()) || '').includes('已存入 1 条'));
      const retries = readCalls(tmp).filter(c => c.name === 'importRetry');
      check('fixture：重试走 importRetry(batchId)', retries.length === 1 && typeof retries[0].arg === 'string' && retries[0].arg.indexOf('batch-') === 0, JSON.stringify(retries.map(r => r.arg)));
      check('fixture：场景2 无页面错误', errors.length === 0, errors.join(' | '));
    } finally { await boundedClose(app); }
  }

  /* 场景3：import-partial 中途关窗重启 → 草稿与失败批次恢复 */
  {
    const tmp = path.join(logDir, 'fx-restart');
    const a = await launchFixture(pw, 'import-partial', tmp);
    await pasteChat(a.win, CHAT3);
    await a.win.locator('#submitBtn').click();
    await a.win.locator('#precheckPanel').waitFor({ timeout: 8000 });
    await a.win.locator('#submitBtn').click();
    await a.win.locator('.pc-result .fail').first().waitFor({ timeout: 8000 });
    await sleep(500); // 等草稿落盘
    await boundedClose(a.app);
    const app = await pw._electron.launch({
      executablePath: electronBin, args: [fixtureDir],
      env: { ...process.env, LV_B_FIXTURE: 'import-partial', LV_B_TMP: tmp, LV_B_WORKSPACE: root },
    });
    let pidRestart = null;
    try { pidRestart = app.process && app.process() ? app.process().pid : null; } catch {}
    trackApp(app, pidRestart, tmp, 'fixture:import-partial-重启');
    let win = null;
    for (let i = 0; i < 150 && !win; i++) { win = app.windows().find(w => w.url().includes('quick.html')); if (!win) await sleep(100); }
    await win.waitForSelector('#mainInput', { timeout: 15000 });
    try {
      check('fixture：重启后原文恢复', ((await win.locator('#mainInput').inputValue()) || '').includes('分镜先画九宫格'));
      check('fixture：重启后消息卡恢复', await win.locator('.msgcard').count() === 3);
      await win.locator('#precheckPanel').waitFor({ timeout: 8000 });
      check('fixture：重启后失败批次恢复（可重试）', await win.locator('.pc-retry').isVisible());
      check('fixture：状态提示含恢复草稿', ((await win.locator('#status').innerText()) || '').includes('已恢复草稿'));
      await shot(win, '05-fixture-重启恢复重试.png');
      await win.locator('.pc-retry').click();
      await win.locator('.donebar.show').waitFor({ timeout: 8000 });
      check('fixture：重启后重试成功', ((await win.locator('.db-text').innerText()) || '').includes('已存入 1 条'));
    } finally { await boundedClose(app); }
  }

  /* 场景4：中文 IME 不误提交 */
  {
    const { app, win, tmp } = await launchFixture(pw, 'import-ok', path.join(logDir, 'fx-ime'));
    try {
      await win.locator('#mainInput').fill('先固定人物再写提示词');
      await win.locator('#mainInput').dispatchEvent('compositionstart');
      await win.locator('#mainInput').press('Enter');
      await sleep(500);
      check('fixture：输入法选词中 Enter 不提交', readCalls(tmp).every(c => c.name !== 'captureSave'));
      await win.locator('#mainInput').dispatchEvent('compositionend');
      await win.locator('#mainInput').press('Enter');
      await win.locator('.donebar.show').waitFor({ timeout: 8000 });
      check('fixture：选词结束 Enter 正常保存', readCalls(tmp).some(c => c.name === 'captureSave'));
    } finally { await boundedClose(app); }
  }

  /* 场景5：反复切类型不重置内容 */
  {
    const { app, win } = await launchFixture(pw, 'import-ok', path.join(logDir, 'fx-switch'));
    try {
      await pasteChat(win, CHAT3);
      await win.locator('.mc-speaker[data-i="1"]').fill('改名了');
      await win.locator('.kindchip[data-k="note"]').click();
      await win.locator('.kindchip[data-k="chat"]').click();
      check('fixture：切类型后消息卡不重置', await win.locator('.msgcard').count() === 3);
      check('fixture：切类型后编辑保留', (await win.locator('.mc-speaker[data-i="1"]').inputValue()) === '改名了');
      check('fixture：原文输入不重置', ((await win.locator('#mainInput').inputValue()) || '').includes('分镜先画九宫格'));
    } finally { await boundedClose(app); }
  }

  /* 场景6：legacy（无新导入接口）→ 本地预检明确标注，勾选过滤走原通道 */
  {
    const { app, win, tmp } = await launchFixture(pw, 'legacy', path.join(logDir, 'fx-legacy'));
    try {
      await pasteChat(win, CHAT3);
      await win.locator('#submitBtn').click();
      await win.locator('#precheckPanel').waitFor({ timeout: 8000 });
      check('fixture：本地预检标注（接口待接入）', ((await win.locator('.pc-mode').innerText()) || '').includes('本地预检'));
      check('fixture：本地预检警告可见', ((await win.locator('.pc-warns').innerText()) || '').includes('尚未接入'));
      await shot(win, '06-fixture-本地预检.png');
      check('fixture：勾选跳过 FAIL 条目', await uncheckEntryContaining(win, 'FAIL'));
      await win.locator('#submitBtn').click();
      await win.locator('.donebar.show').waitFor({ timeout: 8000 });
      const saves = readCalls(tmp).filter(c => c.name === 'captureSave');
      check('fixture：本地模式走原 captureSave', saves.length === 1);
      check('fixture：被跳过的消息不进入保存', ((((saves[0] || {}).arg || {}).messages) || []).length === 2, 'messages=' + ((((saves[0] || {}).arg || {}).messages) || []).length);
      // 按原文保存：不做勾选过滤，全部保留
      await pasteChat(win, CHAT3);
      await win.locator('#submitBtn').click();
      await win.locator('#precheckPanel').waitFor({ timeout: 8000 });
      await win.locator('#saveRawBtn').click();
      await win.locator('.donebar.show').waitFor({ timeout: 8000 });
      const saves2 = readCalls(tmp).filter(c => c.name === 'captureSave');
      check('fixture：按原文保存全量提交', ((((saves2[1] || {}).arg || {}).messages) || []).length === 3);
    } finally { await boundedClose(app); }
  }

  /* 场景7（QA-R1 回归）：import-source=D 集成后真实形态——整段聊天=1 条来源条目，
     逐消息问题以 issues[].index 表达；问题胶囊必须定位到对应消息卡而非首卡 */
  {
    const { app, win, errors } = await launchFixture(pw, 'import-source', path.join(logDir, 'fx-source'));
    try {
      await pasteChat(win, CHAT3);
      await win.locator('#submitBtn').click();
      await win.locator('#precheckPanel').waitFor({ timeout: 8000 });
      check('fixture：来源形态计划被渲染（整段聊天=1 条来源条目）', ((await win.locator('.pc-title').innerText()) || '').includes('1 条消息'));
      await win.locator('.pc-issue', { hasText: '缺时间' }).first().click();
      const focused = await win.evaluate(() => { const el = document.activeElement; return { cls: String(el.className), i: el.dataset ? el.dataset.i : null }; });
      check('fixture：缺时间胶囊按 issue.index 定位第 3 卡时间框', focused.cls.includes('mc-time') && focused.i === '2', JSON.stringify(focused));
      await win.locator('.pc-issue', { hasText: '待补附件' }).first().click();
      await sleep(200);
      check('fixture：待补附件胶囊按 issue.index 定位第 1 卡', await win.evaluate(() => !!document.querySelector('.msgcard[data-i="0"].flash')));
      await shot(win, '07-fixture-多消息来源定位回归.png');
      check('fixture：场景7 无页面错误', errors.length === 0, errors.join(' | '));
    } finally { await boundedClose(app); }
  }
}

/* ---------------- real ---------------- */
// 每步显式超时守护：卡住时报告卡在哪一步，不无限等待
function race(p, label, ms = 30000) {
  return Promise.race([
    Promise.resolve(p).then(v => { console.log('  [step] ' + label); return v; }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('步骤超时：' + label + '（' + ms + 'ms）')), ms)),
  ]);
}

async function launchReal(pw, tmp, tag = 'real') {
  if (!fs.existsSync(electronBinFor(APP_ROOT))) throw new Error('被测应用缺少 Electron：' + electronBinFor(APP_ROOT));
  console.log('  [launch] 被测应用根：' + APP_ROOT);
  const app = await race(pw._electron.launch({ executablePath: electronBinFor(APP_ROOT), args: [APP_ROOT], env: { ...process.env, LV_CONFIG_DIR: tmp } }), 'electron.launch', 60000);
  let pidReal = null;
  try { pidReal = app.process && app.process() ? app.process().pid : null; } catch {}
  trackApp(app, pidReal, tmp, tag);
  const errors = [];
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  let overlay = null;
  for (let i = 0; i < 150 && !overlay; i++) {
    overlay = app.windows().find(w => w.url().includes('/overlay/'));
    if (!overlay) await sleep(100);
  }
  if (!overlay) throw new Error('overlay 未出现');
  console.log('  [launch] overlay 已就绪');
  await race(overlay.evaluate(() => window.vault.overlayOpenMain()), 'overlayOpenMain');
  let main = null;
  for (let i = 0; i < 150 && !main; i++) {
    main = app.windows().find(w => w.url().includes('/main/index.html'));
    if (!main) await sleep(100);
  }
  if (!main) throw new Error('主窗未出现');
  await race(main.waitForSelector('#ingestBtn', { timeout: 20000 }), '主窗 #ingestBtn');
  console.log('  [launch] 主窗已就绪');
  await race(main.evaluate(() => window.vault.openQuick()), 'openQuick');
  let quick = null;
  for (let i = 0; i < 150 && !quick; i++) {
    quick = app.windows().find(w => w.url().includes('/quick/'));
    if (!quick) await sleep(100);
  }
  if (!quick) throw new Error('quick 窗未出现');
  await race(quick.waitForSelector('#mainInput', { timeout: 20000 }), 'quick #mainInput');
  console.log('  [launch] quick 窗已就绪');
  return { app, main, quick, errors };
}

async function runReal(pw) {
  section('real 真实应用 + 临时库（LV_CONFIG_DIR 隔离）');
  if (!fs.existsSync(electronBin)) { check('real：Electron 可用', false, electronBin); return; }
  if (!pw) { check('real：playwright 可用', false); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-b-real-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ vaultBridge: { enabled: false }, notifyOnIngest: false, autoReview: false, overlayVisible: false }));
  console.log('real 临时库：' + tmp);
  const list = main => main.evaluate(() => window.vault.list({ limit: 200 }));

  /* 一句话直接保存 + 轻量反馈 + 撤销 */
  {
    const { app, main, quick, errors } = await launchReal(pw, tmp, 'real段1-直存撤销');
    try {
      await quick.locator('#mainInput').fill('镜头提示词：先固定人物');
      await quick.locator('#mainInput').press('Enter');
      await quick.locator('.donebar.show').waitFor({ timeout: 20000 });
      check('real：一句话 Enter 直接保存', (await list(main)).total === 1);
      const dbText = (await quick.locator('.db-text').innerText()) || '';
      check('real：完成条显示存入位置', dbText.includes('存入'), dbText);
      check('real：完成条有「打开」入口', await quick.locator('#dbOpen').isVisible());
      check('real：完成条有「撤销」入口', await quick.locator('#dbUndo').isVisible());
      await shot(quick, '10-真实-一句话已记下.png');
      await quick.locator('#dbNext').click();
      check('real：「再记一条」窗口不关且清单收起', await quick.evaluate(() => document.visibilityState === 'visible' && !document.querySelector('.donebar.show')));
      await quick.locator('#mainInput').fill('第二条待撤销');
      await quick.locator('#mainInput').press('Enter');
      await quick.locator('.donebar.show').waitFor({ timeout: 20000 });
      await quick.locator('#dbUndo').click();
      await sleep(800);
      check('real：撤销后条目移除', (await list(main)).total === 1);
      check('real：段1 无页面错误', errors.length === 0, errors.join(' | '));
    } finally { await boundedClose(app); }
  }

  /* 长聊天本地预检（明确标注）→ 确认保存 → 入库验证 */
  {
    const { app, main, quick, errors } = await launchReal(pw, tmp, 'real段2-预检入库');
    try {
      await quick.locator('#mainInput').fill(CHAT3);
      await quick.locator('#mainInput').dispatchEvent('paste');
      await quick.locator('.msgcard').first().waitFor({ timeout: 8000 });
      await quick.locator('#submitBtn').click();
      await quick.locator('#precheckPanel').waitFor({ timeout: 8000 });
      // QA-R1：双态断言——新接口已接入→断言 plan 模式；未接入→断言本地降级标注。两种工作区都应全绿。
      const planMode = await quick.evaluate(() => typeof window.vault.importPreview === 'function');
      const modeText = ((await quick.locator('.pc-mode').innerText()) || '');
      if (planMode) {
        check('real：新接口接入时预检为 plan 模式（导入预检标注）', modeText.includes('导入预检'), modeText);
        check('real：plan 模式无本地降级标注（无「尚未接入」）', !(((await quick.locator('#precheckPanel').innerText()) || '')).includes('尚未接入'));
        // 多消息来源定位回归：缺时间胶囊应按消息内序号聚焦第 3 卡时间框
        const chip = quick.locator('.pc-issue', { hasText: '缺时间' });
        if (await chip.count()) {
          await chip.first().click();
          const focused = await quick.evaluate(() => { const el = document.activeElement; return { cls: String(el.className), i: el.dataset ? el.dataset.i : null }; });
          check('real：缺时间胶囊定位第 3 卡时间框（plan 形态）', focused.cls.includes('mc-time') && focused.i === '2', JSON.stringify(focused));
        } else {
          check('real：缺时间胶囊存在（plan 形态）', false, '未找到缺时间胶囊');
        }
        await shot(quick, '11-真实-导入预检.png');
      } else {
        check('real：无新接口时显示本地预检标注', modeText.includes('本地预检'));
        check('real：本地预检警告写明接口未接入', ((await quick.locator('.pc-warns').innerText()) || '').includes('尚未接入'));
        await shot(quick, '11-真实-本地预检.png');
      }
      await quick.locator('#submitBtn').click();
      await quick.locator('.donebar.show').waitFor({ timeout: 30000 });
      const lib = await list(main);
      const chatItem = lib.items.find(x => x.kind === 'chat' && ((x.notes || '') + (x.title || '')).includes('分镜'));
      check('real：聊天按原文入库', !!chatItem);
      if (chatItem) {
        const full = await main.evaluate(id => window.vault.get(id), chatItem.id);
        check('real：3 条消息按时序保存', (full.messages || []).length === 3, 'messages=' + (full.messages || []).length);
        check('real：待补附件标注保留', (full.messages || []).some(m => m.attachment && m.attachment.pending));
      }
      check('real：段2 无页面错误', errors.length === 0, errors.join(' | '));
    } finally { await boundedClose(app); }
  }

  /* 多文件预检 → 按原文保存 → 附件归档 */
  {
    const { app, main, quick } = await launchReal(pw, tmp, 'real段3-多文件');
    try {
      const f1 = path.join(tmp, '分镜说明.md');
      const f2 = path.join(tmp, '机位表.md');
      fs.writeFileSync(f1, '# 分镜说明\n角色衣服固定。');
      fs.writeFileSync(f2, '# 机位表\nA 机位特写。');
      await quick.locator('#mainInput').fill('两份拍摄资料');
      await quick.evaluate(([a, b]) => { files.push(a, b); renderFiles(); dirty(); }, [f1, f2]);
      await quick.locator('#submitBtn').click();
      await quick.locator('#precheckPanel').waitFor({ timeout: 8000 });
      check('real：多文件触发预检（2 个文件）', ((await quick.locator('.pc-title').innerText()) || '').includes('2 个文件'), ((await quick.locator('.pc-title').innerText()) || '').trim());
      await shot(quick, '12-真实-多文件预检.png');
      await quick.locator('#saveRawBtn').click();
      await quick.locator('.donebar.show').waitFor({ timeout: 30000 });
      const lib = await list(main);
      const fileItem = lib.items.find(x => (x.kind === 'file' || x.kind === 'bundle') && ((x.title || '') + (x.notes || '')).includes('拍摄资料'));
      check('real：文件+说明入库', !!fileItem);
      if (fileItem) {
        const full = await main.evaluate(id => window.vault.get(id), fileItem.id);
        check('real：两个附件归档进库', (full.files || []).length === 2 && (full.files || []).every(f => fs.existsSync(f.path)), JSON.stringify((full.files || []).map(f => f.name)));
      }
    } finally { await boundedClose(app); }
  }

  /* 重启恢复草稿（文字 + 附件） */
  {
    const f = path.join(tmp, '草稿附件.md');
    fs.writeFileSync(f, '# 草稿附件');
    const a = await launchReal(pw, tmp, 'real段4-重启前');
    await a.quick.locator('#mainInput').fill('未提交的草稿句子');
    await a.quick.evaluate(p => { files.push(p); renderFiles(); dirty(); }, f);
    await sleep(700);
    await a.quick.locator('#closeBtn').click();
    await sleep(500);
    await boundedClose(a.app);
    const b = await launchReal(pw, tmp, 'real段4-重启后');
    try {
      check('real：重启后草稿文字恢复', (await b.quick.locator('#mainInput').inputValue()) === '未提交的草稿句子');
      check('real：重启后草稿附件恢复', (((await b.quick.locator('#picStrip').innerText()) || '')) .includes('草稿附件.md'));
      await shot(b.quick, '13-真实-重启恢复草稿.png');
    } finally { await boundedClose(b.app); }
  }

  /* 点子：下一步快捷入口 + 撤销 */
  {
    const { app, main, quick } = await launchReal(pw, tmp, 'real段5-点子');
    try {
      await main.evaluate(() => window.vault.ideasOpen(''));
      let idea = null;
      for (let i = 0; i < 150 && !idea; i++) { idea = app.windows().find(w => w.url().includes('/idea/')); if (!idea) await sleep(100); }
      await idea.waitForSelector('#input', { timeout: 15000 });
      await idea.locator('#input').fill('做一期复盘模板');
      await idea.locator('#input').press('Enter');
      await idea.locator('#ideaDone').waitFor({ timeout: 10000 });
      check('real：点子记下后出现撤销回执', ((await idea.locator('#ideaDoneText').innerText()) || '').includes('已记下'));
      await idea.locator('[data-next]').first().click();
      await idea.locator('.nextset input').first().fill('明天出模板初稿');
      await idea.locator('.nextset input').first().press('Enter');
      await sleep(1000);
      check('real：下一步保存后卡片显示', (((await idea.locator('#openList').innerText()) || '')) .includes('下一步：明天出模板初稿'));
      await shot(idea, '14-真实-点子下一步.png');
      await idea.locator('#ideaUndoBtn').click();
      await sleep(1000);
      const ideas = await main.evaluate(() => window.vault.ideasList());
      check('real：撤销后点子移除', (ideas.open || []).length === 0, JSON.stringify(ideas).slice(0, 120));
    } finally { await boundedClose(app); }
  }
  console.log('real 临时库保留于：' + tmp);
}

/* ---------------- main ---------------- */
(async () => {
  const mode = process.argv[2] || 'all';
  const started = new Date();
  try {
    if (mode === 'all' || mode === 'static') runStatic();
    if (mode === 'all' || mode === 'pure') runPure();
    if (mode === 'fixture' || mode === 'real' || mode === 'all') {
      const pw = loadPlaywright();
      if (mode === 'fixture') await runFixture(pw).catch(e => check('fixture：执行完成', false, (e && e.stack) || e.message));
      if (mode === 'real') await runReal(pw).catch(e => check('real：执行完成', false, (e && e.stack) || e.message));
      if (mode === 'all') {
        await runFixture(pw).catch(e => check('fixture：执行完成', false, (e && e.stack) || e.message));
        await runReal(pw).catch(e => check('real：执行完成', false, (e && e.stack) || e.message));
      }
    }
  } catch (e) {
    check('执行中断', false, (e && e.stack) || e.message);
  }
  const failed = report.filter(r => !r.pass).length;
  const closeNormal = closeLog.filter(c => c.mode === 'normal-close').length;
  const closeFallback = closeLog.filter(c => c.mode === 'fallback-kill').length;
  const closeError = closeLog.filter(c => c.mode === 'close-error').length;
  const durationSec = Math.round((Date.now() - started.getTime()) / 100) / 10;
  const lines = [
    'LV-20260924-B round-b-check',
    '模式：' + mode + '  时间：' + started.toISOString() + '  脚本项目根：' + root + '  real 被测应用根：' + APP_ROOT,
    '通过 ' + (report.length - failed) + '/' + report.length + '  耗时 ' + durationSec + 's',
    '关闭：正常 ' + closeNormal + ' · 兜底清理 ' + closeFallback + ' · 异常返回 ' + closeError + (closeFallback ? '（兜底≠正常关闭，明细见上）' : ''),
    ...report.map(r => (r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.info ? '  | ' + r.info.replace(/\n/g, ' ') : '')),
    '关闭明细：' + JSON.stringify(closeLog),
  ];
  const logFile = path.join(logDir, 'round-b-check.log');
  fs.appendFileSync(logFile, lines.join('\n') + '\n\n');
  try {
    fs.writeFileSync(path.join(logDir, 'last-run-summary.json'), JSON.stringify({
      mode, started: started.toISOString(), durationSec,
      scriptRoot: root, testedAppRoot: APP_ROOT,
      passed: report.length - failed, failed,
      close: { normal: closeNormal, fallback: closeFallback, error: closeError, detail: closeLog },
    }, null, 2));
  } catch {}
  console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败') + '，日志：' + logFile);
  console.log('退出码：' + (failed === 0 ? 0 : 1) + '；关闭：正常 ' + closeNormal + ' / 兜底 ' + closeFallback + ' / 异常 ' + closeError);
  process.exit(failed === 0 ? 0 : 1);
})();
