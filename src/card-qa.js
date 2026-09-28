/**
 * 问答式成卡（P1）：AI 生成回想问题 + 一句答案；无 AI/失败时模板回退（纯函数零依赖）
 *
 * 目标：卡片正面是「一个问题」，背面是「一句答案」——对文章类资料这是回想题，
 * 而不是「再读一遍」。AI 只是可选增强，失败必须静默回退到模板。
 */

// 内容摘要：取最有信息量的一段（summary > notes > 正文首段），去掉空白噪音
function contentDigest(item, max = 900) {
  const it = item || {};
  const raw = String(it.summary || it.notes || it.text || '').trim();
  if (!raw) return String(it.title || '').trim();
  return raw.replace(/\s+/g, ' ').slice(0, max);
}

// 期望的 AI 输出：{q,a}，宽松解析（容忍 ```json 围栏 / 前后缀文字）
function parseCardQA(text) {
  try {
    const m = String(text || '').replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
    const obj = m && JSON.parse(m[0]);
    const q = obj && typeof obj.q === 'string' ? obj.q.trim() : '';
    const a = obj && typeof obj.a === 'string' ? obj.a.trim() : '';
    if (!q || !a) return null;
    return { q: q.slice(0, 40), a: a.slice(0, 120) };
  } catch { return null; }
}

// AI 提示词（与 parseCardQA 配对；只允许用原文事实，防止编造）
function qaPrompt(item) {
  const title = String((item && item.title) || '').slice(0, 120);
  const digest = contentDigest(item);
  return {
    system: '你把学习资料变成一张回想卡片。只使用给出内容里的事实，不要编造。输出 JSON：{"q":"一个回想问题（不超过40字）","a":"一句答案（不超过120字）"}。问题要能凭记忆回答，不要是非题。',
    user: `标题：${title}\n内容：${digest}`,
  };
}

module.exports = { contentDigest, parseCardQA, qaPrompt };
