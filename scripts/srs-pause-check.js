/** 已暂停卡片恢复入口：真实 Electron + 隔离库，覆盖 暂停→列表→恢复→字段保留→回到队列 与界面面板。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
let pw;
try { pw = require('playwright'); } catch {
  const { createRequire } = require('module');
  const req2 = createRequire(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'));
  pw = req2('playwright');
}
const root = path.resolve(__dirname, '..'), out = process.env.LV_EVIDENCE_DIR || path.join(root, '交付物/D/evidence-srs-pause');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-srs-pause-'));
let app, reviewPage;
const steps = [], errors = [];
const step = t => { steps.push(t); console.log('✓ ' + t); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 120; i++) { const r = await fn(); if (r) return r; await sleep(80); } throw Error(label); }

(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ vaultBridge: { enabled: false }, autoReview: false, notifyOnIngest: false }));

  // 用真实存储路径造两张到期卡（srs-cards.json），启动时由 loadSrsCards 读回
  const cards = [{ front: '旧知-正面A', back: '背面A' }, { front: '旧知-正面B', back: '背面B' }];
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const now = Date.now();
  // due 取「昨天 04:00」：调度锚点是最近一个凌晨四点，深拧到锚点前才算到期（与 main.js 同规则）
  const anchor = new Date(); anchor.setDate(anchor.getDate() - 1); anchor.setHours(4, 0, 0, 0);
  const mk = (i) => ({ id: 'testcard' + i, itemId: null, kind: 'quote', front: cards[i].front, back: cards[i].back, created_at: now, due: anchor.getTime() - 1, interval: 3, ease: 2.35, reps: 2, lapses: 1, suspended: false });
  fs.writeFileSync(path.join(dataDir, 'srs-cards.json'), JSON.stringify([mk(0), mk(1)]));
  app = await pw._electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], env: { ...process.env, LV_CONFIG_DIR: tmp } });
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));

  // 打开复习窗（其余窗口隐藏，画面干净）：复习窗懒创建，先用任意窗口调 srsOpen
  const trigger = await until(async () => app.windows().find(p => p.url().includes('index.html') || p.url().includes('/overlay/')), '没有任何可触发窗口');
  await trigger.evaluate(() => window.vault.srsOpen());
  await until(() => app.windows().some(p => p.url().includes('/review/')), '复习窗未打开');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(w => { if (!w.webContents.getURL().includes('/review/')) w.hide(); else { w.show(); w.focus(); } }); });
  reviewPage = await until(() => app.windows().find(p => p.url().includes('/review/')), '复习窗未打开');
  await reviewPage.waitForSelector('#stage');
  await until(async () => await reviewPage.locator('#suspBtn').isVisible().catch(() => false) === false || (await reviewPage.locator('#suspCount').innerText()) === '0', '初始不应有暂停卡');
  step('复习窗加载，「已暂停」入口就位（当前无暂停卡，入口隐藏）');

  // 队列里两张卡都到期；暂停第一张
  const q0 = await reviewPage.evaluate(() => window.vault.srsQueue());
  assert.equal(q0.length, 2, '两张到期卡都应在队列');
  const victim = q0[0];
  await reviewPage.evaluate(id => window.vault.srsSuspend(id), victim.id);
  const list = await reviewPage.evaluate(() => window.vault.srsSuspendedList());
  assert.equal(list.length, 1); assert.equal(list[0].id, victim.id);
  step('暂停卡片进入已暂停列表');

  // 直连 IPC 暂停不经 UI 刷新（符合设计）：重载复习窗后标题栏计数应显示 1
  await reviewPage.reload(); await reviewPage.waitForSelector('#stage');
  await until(async () => (await reviewPage.locator('#suspCount').innerText()) === '1', '标题栏暂停计数未刷新');
  await reviewPage.screenshot({ path: path.join(out, '复习窗-已暂停入口.png') });
  await reviewPage.locator('#suspBtn').click();
  await reviewPage.waitForSelector('.susp-row');
  const rowText = await reviewPage.locator('.susp-row').innerText();
  assert.ok(rowText.includes(victim.front.slice(0, 4)), '面板应显示暂停卡正面');
  await reviewPage.screenshot({ path: path.join(out, '已暂停面板.png') });
  step('「已暂停」面板列出暂停卡（含来源与暂停日期）');

  // 恢复：调度字段必须原样保留
  await reviewPage.locator('[data-resume]').first().click();
  await until(async () => (await reviewPage.evaluate(() => window.vault.srsSuspendedList())).length === 0, '恢复后列表未清空');
  const resumed = (await reviewPage.evaluate(() => window.vault.srsQueue())).find(c => c.id === victim.id);
  assert.ok(resumed, '恢复的卡应回到今日队列');
  for (const k of ['due', 'interval', 'ease', 'reps', 'lapses']) assert.equal(resumed[k], victim[k], `恢复必须保留调度字段 ${k}`);
  step('恢复后调度字段原样保留（due/interval/ease/reps/lapses），卡回到队列');
  await reviewPage.screenshot({ path: path.join(out, '恢复后回队列.png') });

  // 界面路径：复习中按 P 暂停 → 入口计数 +1 → 面板恢复 → 返回复习
  await reviewPage.reload(); await reviewPage.waitForSelector('#stage');
  const cardFront = await reviewPage.evaluate(() => window.vault.srsQueue().then(q => q[0] && q[0].front));
  assert.ok(cardFront, '重载后仍有到期卡');
  await reviewPage.keyboard.press('p');
  await until(async () => (await reviewPage.evaluate(() => window.vault.srsSuspendedList())).length === 1, '键盘 P 暂停未生效');
  step('复习中按 P 暂停，入口计数即时刷新');
  await reviewPage.screenshot({ path: path.join(out, '键盘P暂停后.png') });
  await reviewPage.locator('#suspBtn').click();
  await reviewPage.waitForSelector('.susp-row');
  await reviewPage.locator('#suspBack').click();
  step('面板「返回复习」正常关闭');
  await reviewPage.screenshot({ path: path.join(out, '暂停面板-返回.png') });

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'srs-pause-result.json'), JSON.stringify({ ok: true, steps, errors, tmp }, null, 2));
  console.log('SRS_PAUSE_CHECK_OK ' + steps.length);
})().catch(e => {
  console.error(e.stack);
  try { fs.mkdirSync(out, { recursive: true }); } catch {}
  fs.writeFileSync(path.join(out, 'srs-pause-result.json'), JSON.stringify({ ok: false, steps, errors, error: String(e.stack) }, null, 2));
  process.exitCode = 1;
}).finally(async () => { if (app) await app.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
