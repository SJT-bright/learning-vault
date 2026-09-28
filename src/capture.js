/**
 * 随手记：根据内容给出可修改的类型提示（不强制保存前选分类）
 */
const URL_RE = /^https?:\/\/\S+/i;
const HEAD_LINE = /^[^\n]{1,24}\s+(?:\d{4}[\/\-年]\s*)?(?:\d{1,2}[月\/\-]\s*\d{1,2}日?\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*$/gm;
const ATTACH_MARK = /[\[［](文件|图片|视频|链接|语音)[\]］]/;

function looksLikeChat(text) {
  const t = String(text || '');
  HEAD_LINE.lastIndex = 0;
  const heads = (t.match(HEAD_LINE) || []).length;
  if (heads >= 2) return true;
  if (heads === 1 && ATTACH_MARK.test(t)) return true;
  return false;
}

function firstUrl(text) {
  const t = String(text || '').trim();
  const m = t.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : '';
}

function detectCapture({ text, files, intent } = {}) {
  const t = String(text || '').trim();
  const nFiles = Array.isArray(files) ? files.filter(Boolean).length : 0;
  if (nFiles && !t) return { kind: 'file', hint: '文件', confidence: 0.9, reason: '拖入了文件' };
  const u = firstUrl(t);
  if (u && t.indexOf(u) === 0 && t.length < u.length + 8) {
    return { kind: 'url', hint: '链接', confidence: 0.95, reason: '以网址开头', url: u };
  }
  if (looksLikeChat(t)) return { kind: 'chat', hint: '聊天记录', confidence: 0.88, reason: '识别到说话人与时间' };
  if (intent === 'idea') return { kind: 'idea', hint: '点子', confidence: 0.75, reason: '从点子入口记下' };
  if (nFiles && t) return { kind: 'file', hint: '文件 + 说明', confidence: 0.7, reason: '文件和文字一起' };
  if (u) return { kind: 'url', hint: '链接', confidence: 0.7, reason: '文中含网址', url: u };
  return { kind: 'note', hint: '想法', confidence: 0.6, reason: '普通文字' };
}

const HINTS = {
  note: '想法', chat: '聊天记录', url: '链接', idea: '点子', file: '文件', image: '图片', video: '视频',
};

module.exports = { detectCapture, looksLikeChat, firstUrl, HINTS, URL_RE };
