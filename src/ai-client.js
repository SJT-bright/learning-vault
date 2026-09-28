/** AI 请求统一入口：连接检测与实际功能使用相同地址、认证和错误处理。 */
function aiError(code, message) { return Object.assign(new Error(message), { code }); }
function normalizeConfig(cfg = {}) {
  const base = String(cfg.baseUrl || '').trim();
  const apiKey = String(cfg.apiKey || '').trim().replace(/^Bearer\s+/i, '');
  if (!base) throw aiError('CONFIG', '请填写 API 地址');
  if (!apiKey || /^•+$/.test(apiKey)) throw aiError('CONFIG', '请填写 API Key');
  let url;
  try { url = new URL(base); } catch { throw aiError('CONFIG', 'API 地址格式不正确，请填写完整的 http 或 https 地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw aiError('CONFIG', 'API 地址须为 http 或 https，密钥请填在 API Key 中');
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/chat/completions') ? pathname : pathname + '/chat/completions';
  url.hash = '';
  const deepseek = url.hostname === 'api.deepseek.com';
  return { endpoint: url.toString(), apiKey, deepseek, model: String(cfg.model || '').trim() || (deepseek ? 'deepseek-flash' : 'gpt-4o-mini') };
}

async function requestChat(cfg, body, { timeoutMs = 45000 } = {}) {
  const c = normalizeConfig(cfg);
  let response;
  try {
    response = await fetch(c.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
      body: JSON.stringify({ ...(c.deepseek ? { thinking: { type: 'disabled' } } : {}), ...body, model: c.model }), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (['TimeoutError', 'AbortError'].includes(e.name)) throw aiError('TIMEOUT', 'AI 响应超时，请稍后重试');
    throw aiError('NETWORK', '无法连接 AI 服务，请检查地址和网络');
  }
  if (!response.ok) {
    const messages = { 401: '认证失败，请检查 API Key', 403: '服务拒绝访问，请检查密钥权限', 404: '接口或模型不存在，请检查 API 地址和模型名', 429: '请求过多或额度不足，请稍后重试或检查账户额度' };
    throw aiError('HTTP_' + response.status, messages[response.status] || `AI 服务返回 HTTP ${response.status}，请稍后重试`);
  }
  let data;
  try { data = await response.json(); } catch (e) {
    if (['TimeoutError', 'AbortError'].includes(e.name)) throw aiError('TIMEOUT', 'AI 响应超时，请稍后重试');
    throw aiError('RESPONSE_FORMAT', 'AI 返回格式不正确，接口需支持 Chat Completions');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw aiError('EMPTY_RESPONSE', 'AI 未返回可用正文，请检查模型与接口兼容性');
  return content.trim();
}

async function testConnection(cfg) {
  const start = Date.now();
  try {
    const c = normalizeConfig(cfg);
    await requestChat(cfg, { messages: [{ role: 'user', content: '连接测试，请只回复 OK。' }], max_tokens: 16 }, { timeoutMs: 15000 });
    return { ok: true, model: c.model, elapsedMs: Date.now() - start };
  } catch (e) { return { ok: false, code: e.code || 'UNKNOWN', error: e.message }; }
}

function parseDraft(text) {
  try {
    const match = String(text).replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
    const obj = match && JSON.parse(match[0]);
    if (!obj || !Array.isArray(obj.items)) throw Error('items missing');
    const items = obj.items.slice(0, 8).map(x => {
      if (!x || !['conclusion', 'todo', 'method'].includes(x.kind) || typeof x.title !== 'string' || typeof x.body !== 'string' || !x.title.trim() || !x.body.trim()) throw Error('invalid item');
      return { kind: x.kind, title: x.title.trim(), body: x.body.trim(), ai_draft: true };
    });
    return items;
  } catch { throw aiError('DRAFT_FORMAT', 'AI 草稿格式不完整，请重试或手动提取'); }
}
module.exports = { normalizeConfig, requestChat, testConnection, parseDraft };
