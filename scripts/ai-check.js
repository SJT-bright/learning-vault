'use strict';
const assert = require('assert/strict'), http = require('http'), fs = require('fs'), path = require('path');
const { normalizeConfig, requestChat, testConnection, parseDraft } = require('../src/ai-client');
const { classify } = require('../src/classify');
const { generateReview } = require('../src/review');
const out = path.resolve(__dirname, '../交付物/v0.10.1-联调验收');
const steps = []; let server, mode = 'ok', observed;
async function test(name, fn) { await fn(); steps.push(name); console.log('✓ ' + name); }
(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    observed = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    if (mode === 'timeout') { setTimeout(() => res.end('{}'), 100); return; }
    if (mode === 'unauthorized') { res.writeHead(401); res.end('sensitive-provider-error'); return; }
    if (mode === 'quota') { res.writeHead(429); res.end('sensitive-provider-error'); return; }
    if (mode === 'invalid') { res.end('<html>upstream error</html>'); return; }
    if (mode === 'empty') { res.end(JSON.stringify({ choices: [{ message: { content: '' } }] })); return; }
    let content = 'OK';
    if (mode === 'classify') content = JSON.stringify({ category: '教程课程', tags: ['分镜'], summary: '学习九宫格分镜方法。' });
    if (mode === 'review') content = '本周实际使用九宫格方法，完成一条样片。';
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, apiKey: ' test-fixture-key ', model: 'deepseek-flash' };
  await test('API 根地址与完整 Chat Completions 地址都只请求一次正确路径', async () => {
    assert.equal((await testConnection(cfg)).ok, true); assert.equal(observed.url, '/v1/chat/completions');
    assert.equal(observed.auth, 'Bearer test-fixture-key');
    assert.equal((await testConnection({ ...cfg, baseUrl: cfg.baseUrl + 'chat/completions' })).ok, true);
    assert.equal(observed.url, '/v1/chat/completions');
  });
  await test('连接测试仅发送固定语句，使用当前选定模型', async () => {
    assert.equal(observed.body.model, 'deepseek-flash');
    assert.deepEqual(observed.body.messages, [{ role: 'user', content: '连接测试，请只回复 OK。' }]);
  });
  await test('缺失配置、掩码密钥和错误地址明确失败', async () => {
    for (const x of [{}, { ...cfg, apiKey: '••••••••' }, { ...cfg, baseUrl: 'bad address' }, { ...cfg, baseUrl: 'file:///tmp/api' }]) assert.equal((await testConnection(x)).code, 'CONFIG');
  });
  await test('401 和 429 返回具体提示，不显示服务端回显内容', async () => {
    for (const m of ['unauthorized', 'quota']) { mode = m; const r = await testConnection(cfg); assert.equal(r.ok, false); assert.ok(r.code.startsWith('HTTP_')); assert.ok(!JSON.stringify(r).includes('sensitive-provider-error')); }
  });
  await test('非 JSON 与空正文不能显示连接成功', async () => {
    mode = 'invalid'; assert.equal((await testConnection(cfg)).code, 'RESPONSE_FORMAT');
    mode = 'empty'; assert.equal((await testConnection(cfg)).code, 'EMPTY_RESPONSE');
  });
  await test('超时返回可重试提示', async () => {
    mode = 'timeout'; await assert.rejects(requestChat(cfg, { messages: [] }, { timeoutMs: 20 }), e => e.code === 'TIMEOUT');
  });
  await test('分类与复盘共用已验证的请求入口；失败时仍可离线工作', async () => {
    mode = 'classify'; assert.equal((await classify(cfg, { title: '分镜课程', text: '教程' })).source, 'ai');
    mode = 'review'; const r = await generateReview(cfg, { mode: 'weekly', label: '本周', items: [] }); assert.equal(r.source, 'ai'); assert.ok(r.text.includes('九宫格'));
    mode = 'unauthorized'; assert.equal((await classify(cfg, { text: '教程' })).source, 'heuristic'); assert.equal((await generateReview(cfg, { mode: 'weekly', items: [] })).source, 'static');
  });
  await test('DeepSeek 默认使用官方当前模型和非思考模式，测试额度不会被思考输出耗尽', async () => {
    const savedFetch = global.fetch; let request;
    try {
      global.fetch = async (url, init) => { request = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); };
      assert.equal((await testConnection({ baseUrl: 'https://api.deepseek.com', apiKey: 'fixture' })).ok, true);
      assert.equal(request.url, 'https://api.deepseek.com/chat/completions'); assert.equal(request.body.model, 'deepseek-flash'); assert.equal(request.body.thinking.type, 'disabled');
    } finally { global.fetch = savedFetch; }
  });
  await test('AI 草稿结构错误不会伪装成没有可提取内容', async () => {
    assert.deepEqual(parseDraft('{"items":[]}'), []);
    const valid = parseDraft('```json\n{"items":[{"kind":"method","title":"九宫格","body":"先画九宫格"}]}\n```'); assert.equal(valid[0].ai_draft, true);
    for (const s of ['{}', '不是 JSON', '{"items":[{"kind":"unknown","title":"a","body":"b"}]}', '{"items":[null]}']) assert.throws(() => parseDraft(s), e => e.code === 'DRAFT_FORMAT');
  });
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'ai-result.json'), JSON.stringify({ ok: true, testMode: 'local-fixtures-only', steps }, null, 2));
  console.log('AI_CHECK_OK ' + steps.length);
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { if (server) { server.closeAllConnections(); server.close(); } });
