/** 真实 Electron + StudyDesk 服务/页面；所有写入使用临时目录和随机端口。AI 使用本机假服务。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), assert = require('assert/strict');
const { spawn } = require('child_process');
let pw; try { pw = require('playwright'); } catch { pw = require(process.env.LV_PLAYWRIGHT_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = path.resolve(__dirname, '..'), sd = process.env.STUDYDESK_ROOT || '';
const out = path.join(root, '交付物/v0.10.1-联调验收');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-integration-')), vault = path.join(tmp, 'vault');
const steps = [], errors = []; let app, child, api, main, study, apiMode = 'ok', apiRequests = 0;
const step = s => { steps.push(s); console.log('✓ ' + s); };
async function until(fn, label) { for (let n = 0; n < 200; n++) { try { const r = await fn(); if (r) return r; } catch {} await new Promise(r => setTimeout(r, 80)); } throw Error('等待失败：' + label); }
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
(async () => {
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(path.join(vault, 'data'), { recursive: true });
  const vaultPort = await freePort(), deskPort = await freePort();
  const config = { vaultBridge: { enabled: true, port: vaultPort }, autoReview: false, notifyOnIngest: false };
  fs.writeFileSync(path.join(vault, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(vault, 'data/library.json'), JSON.stringify([
    { id: 'other', title: '九宫格九宫格课程', notes: '九宫格', category: '资料收藏' },
    { id: 'target1', title: '九宫格分镜方法', notes: '先固定人物服装，再画九宫格。', category: '教程课程' },
    { id: 'target2', title: '九宫格进阶', notes: '按镜头安排人物动作。', category: '教程课程/视频' },
  ].map(x => ({ ...x, kind: 'note', tags: [], files: [], created_at: Date.now(), updated_at: Date.now(), trashed: false, category_locked: true }))));
  app = await pw._electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], env: { ...process.env, LV_CONFIG_DIR: vault, LV_TEST_EXPOSE: '1' } });
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  const overlay = await until(() => app.windows().find(p => p.url().includes('/overlay/')), '贴边条');
  await overlay.waitForLoadState('domcontentloaded'); await overlay.evaluate(() => window.vault.overlayOpenMain());
  main = await until(() => app.windows().find(p => p.url().includes('/main/index.html')), '主窗'); await main.waitForSelector('#settingsBtn');
  const nightly = await app.evaluate(async ({ app }) => {
    const old = process.env.PATH; process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    try { return await app._testRunSelfcheckOnce(); } finally { process.env.PATH = old; }
  });
  assert.equal(nightly.ok, true); assert.ok(nightly.passed >= 241);
  step('没有系统 node 的桌面环境下，应用内自检仍全部通过');

  const copied = path.join(tmp, 'studydesk'); fs.mkdirSync(copied);
  for (const n of ['server.mjs', '网课学习工作台.html', 'lib', 'vendor', 'feishu-url.mjs']) { const p = path.join(sd, n); if (fs.existsSync(p)) fs.cpSync(p, path.join(copied, n), { recursive: true }); }
  child = spawn(process.execPath, ['server.mjs'], { cwd: copied, env: { ...process.env, STUDYDESK_PORT: String(deskPort), STUDYDESK_VAULT_PORT: String(vaultPort), STUDYDESK_HOME: path.join(tmp, 'desk-home'), STUDYDESK_MEDIA: tmp, STUDYDESK_TRANSCRIPTS_DIR: path.join(tmp, 'transcripts') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = ''; child.stdout.on('data', b => serverLog += b); child.stderr.on('data', b => serverLog += b);
  const origin = 'http://127.0.0.1:' + deskPort;
  const request = async (route, body) => {
    const r = await fetch(origin + '/api/vault/' + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) } : {});
    const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data;
  };
  await until(async () => (await request('status')).ok, 'StudyDesk 连接资料库');
  const result = await request('search?q=' + encodeURIComponent('九宫格') + '&category=' + encodeURIComponent('教程课程') + '&limit=1');
  assert.equal(result.total, 2); assert.equal(result.items.length, 1); assert.ok(result.items[0].category.startsWith('教程课程'));
  step('真实 StudyDesk 代理搜索：分类包含子分类，分页不漏匹配数');

  await app.evaluate(({ BrowserWindow }, url) => { const w = new BrowserWindow({ width: 1280, height: 900, webPreferences: { contextIsolation: true } }); w.loadURL(url); }, origin);
  study = await until(() => app.windows().find(p => p.url().startsWith(origin)), 'StudyDesk 页面');
  await study.waitForFunction(() => document.body.dataset.ready === 'true');
  await study.locator('#vaultBtn').click();
  await until(async () => await study.locator('.vault-item:not(.vault-loading)').count() === 3, '资料列表');
  await study.locator('.vault-chip[data-cat="教程课程"]').click();
  await until(async () => await study.locator('.vault-item:not(.vault-loading)').count() === 2, '分类筛选');
  await study.locator('.vault-chip[data-cat=""]').click();
  await until(async () => await study.locator('.vault-item:not(.vault-loading)').count() === 3, '回到全部');
  step('StudyDesk 真实页面能浏览资料、切换分类并回到全部');
  const row = study.locator('.vault-item').filter({ hasText: '九宫格分镜方法' });
  await row.locator('[data-act="open"]').click();
  await until(async () => (await main.locator('#detail .dtitle').textContent()) === '九宫格分镜方法', '笔记详情');
  step('从 StudyDesk 打开纯笔记，实际跳到资料库对应详情');
  await row.locator('[data-act="card"]').click();
  await until(() => JSON.parse(fs.readFileSync(path.join(vault, 'data/srs-cards.json'))).length === 1, '复习卡落盘');
  const longNote = '联调笔记：固定服装，再安排动作。'.repeat(350) + '【结尾保留标记】';
  await study.evaluate(t => { document.querySelector('#paper').textContent = t; }, longNote);
  await study.locator('#vaultIngestNote').click();
  await until(async () => (await request('recent?limit=20')).total === 4, '笔记收录');
  const saved = (await request('recent?limit=20')).items.find(x => !['other', 'target1', 'target2'].includes(x.id));
  const detail = await request('item/' + saved.id);
  const full = await main.evaluate(id => window.vault.get(id), saved.id);
  assert.ok(full.notes.endsWith('【结尾保留标记】')); assert.ok(full.notes.includes(longNote)); assert.equal(detail.item.kind, 'note');
  await study.evaluate(() => { document.querySelector('#paper').textContent = '用九宫格做一条短片'; });
  await study.locator('#vaultIdeaBtn').click(); await until(() => JSON.parse(fs.readFileSync(path.join(vault, 'data/ideas.json'))).length === 1, '点子落盘');
  await study.locator('#vaultIdeaBtn').click(); await new Promise(r => setTimeout(r, 200));
  assert.equal(JSON.parse(fs.readFileSync(path.join(vault, 'data/ideas.json'))).length, 1);
  const progress = await request('progress', { id: 'target1', progress: 43, status: 'learning' }); assert.equal(progress.progress, 43);
  assert.equal((await main.evaluate(() => window.vault.get('target1'))).studyProgress, 43);
  step('真实页面收录长笔记不截尾；点子去重、复习卡和学习进度均落盘');
  await study.locator('#vaultRefresh').click(); await until(async () => await study.locator('.vault-item:not(.vault-loading)').count() === 4, '更新列表');
  await study.screenshot({ animations: 'disabled', path: path.join(out, 'StudyDesk-真实联调.png') });

  api = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b; const b = JSON.parse(raw); apiRequests++;
    if (apiMode === 'invalid') { res.end('{"choices":[{"message":{"content":"invalid draft"}}]}'); return; }
    const system = b.messages?.[0]?.content || '';
    const content = system.includes('提取结论') ? JSON.stringify({ items: [{ kind: 'method', title: '固定人物后画分镜', body: '先固定人物服装，再画九宫格分镜。' }] }) : system.includes('打标签') ? JSON.stringify({ category: '教程课程', tags: ['分镜'], summary: '分镜练习' }) : 'OK';
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${api.address().port}/v1`;
  await main.locator('#settingsBtn').click();
  // C 轮设置弹窗重构：同一弹窗内 #aiTestBtn/#aiTestResult/#saveSetBtn/[data-cancel] 替代旧 uiForm 属性
  const fields = main.locator('.mask').last();
  await fields.locator('[data-k="baseUrl"]').fill(endpoint); await fields.locator('[data-k="apiKey"]').fill('fixture-key'); await fields.locator('[data-k="model"]').fill('deepseek-flash');
  assert.equal(await fields.locator('[data-k="apiKey"]').getAttribute('type'), 'password');
  await fields.locator('#aiTestBtn').click(); await until(async () => (await fields.locator('#aiTestResult').innerText()).includes('连接成功'), '连接检测');
  assert.equal(JSON.parse(fs.readFileSync(path.join(vault, 'config.json'))).apiKey, undefined);
  await fields.locator('#saveSetBtn').click(); await until(() => JSON.parse(fs.readFileSync(path.join(vault, 'config.json'))).apiKey === 'fixture-key', '设置保存');
  await main.locator('#settingsBtn').click();
  const masked = main.locator('.mask').last(); assert.equal(await masked.locator('[data-k="apiKey"]').inputValue(), '••••••••');
  await masked.locator('#aiTestBtn').click(); await until(async () => (await masked.locator('#aiTestResult').innerText()).includes('连接成功'), '沿用已存密钥');
  await masked.locator('[data-cancel]').click();
  step('设置页可用未保存配置测试，保存前不落盘，已存密钥掩码可沿用');
  const raw = '阿宁 09:12\n先固定服装，再画九宫格\n---\n小周 09:14\n下午试一下';
  const chat = await main.evaluate(text => window.vault.captureSave({ kind: 'chat', text, rawText: text, chatTitle: '分镜讨论' }), raw);
  await main.evaluate(id => window.vault.showItem(id), chat.id);
  await main.locator('#aiExtractBtn').click();
  await main.locator('[data-airow]').waitFor();
  assert.equal((await main.evaluate(id => window.vault.extractByItem(id), chat.id)).length, 0);
  await main.locator('[data-airow] [data-body]').fill('先固定人物服装，再画九宫格，并检查镜头衔接。');
  await main.locator('[data-save-ai]').click(); await until(async () => (await main.evaluate(id => window.vault.extractByItem(id), chat.id)).length === 1, 'AI 草稿保存');
  assert.ok((await main.evaluate(id => window.vault.extractByItem(id), chat.id))[0].body.includes('检查镜头衔接'));
  await main.locator('.mask [data-x]').click(); apiMode = 'invalid';
  const bad = await main.evaluate(id => window.vault.extractAiDraft({ itemId: id }), chat.id); assert.equal(bad.ok, false);
  step('AI 整理经真实界面生成草稿，编辑并保存后才入库，错误格式明确失败（本机模拟响应）');

  await main.locator('#settingsBtn').click();
  const shown = main.locator('.mask').last();
  await shown.locator('[data-k="baseUrl"]').fill('https://api.deepseek.com'); await shown.locator('[data-k="model"]').fill('deepseek-flash'); await shown.locator('[data-k="apiKey"]').fill('');
  const callsBefore = apiRequests; await shown.locator('#aiTestBtn').click();
  await until(async () => (await shown.locator('#aiTestResult').innerText()).includes('请填写 API Key'), '缺失密钥提示');
  assert.equal(apiRequests, callsBefore);
  await shown.locator('[data-k="baseUrl"]').scrollIntoViewIfNeeded();
  await main.screenshot({ animations: 'disabled', path: path.join(out, 'DeepSeek-连接设置.png') });
  await shown.locator('[data-cancel]').click();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'integration-result.json'), JSON.stringify({ ok: true, steps, errors, nightly, studyDeskSource: sd, aiMode: 'local-fixture-only', realProviderCalled: false }, null, 2));
  console.log('INTEGRATION_CHECK_OK ' + steps.length);
})().catch(e => { console.error(e.stack); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'integration-result.json'), JSON.stringify({ ok: false, steps, errors, error: e.stack }, null, 2)); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close();
  if (child) { child.kill('SIGTERM'); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); }
  if (api) { api.closeAllConnections(); api.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});
