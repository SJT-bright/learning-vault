/**
 * 聊天记录解析 — 把粘贴的大段聊天文本拆成有序消息块（纯函数、零依赖、selfcheck 可直测）
 *
 * 识别的常见形态（微信/QQ 复制、手动整理都兼容）：
 *   张三 14:02            ← 「说话人 时间」头行（时间可带秒、可带日期前缀）
 *   这份是储能测算模型
 *   [文件] 储能收益测算.xlsx   ← 附件行（识别 [文件]/[图片]/[视频] 前缀，记入消息附件标注）
 *   ---
 *   李四 14:05            ← 分隔线（---、———）直接跳过
 *   收到，我看看
 *
 * 输出：[{ speaker, time, text, attachment }]
 *   - 完全没有头行的文本 → 单条消息（speaker=''），原文保留，绝不丢字
 *   - 日期形态「9月17日 14:02」「2026/9/17 14:02」整段视为 time 文本
 */
const HEAD_RE = /^([\s\S]{1,24}?)\s+((?:\d{4}[\/\-年]\s*)?\d{1,2}[月\/\-]\s*\d{1,2}日?\s*)?(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
const SEP_RE = /^[-—=*_]{2,}\s*$/;
const ATTACH_RE = /^\s*[\[［]?(文件|图片|视频|链接|语音)[\]］][:：]?\s*(.+)$/;

// 解析聊天文本 → 有序消息数组
function parseChatText(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const messages = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      cur.text = cur.text.replace(/\n{3,}/g, '\n\n').trim();
      if (cur.text || cur.attachment) messages.push(cur);
    }
    cur = null;
  };
  for (const line0 of lines) {
    const line = line0.replace(/\s+$/, '');
    if (SEP_RE.test(line.trim())) { flush(); continue; } // 分隔线=强制分段
    const m = line.match(HEAD_RE);
    if (m) {
      // 头行：开新消息（speaker 去掉常见装饰：冒号结尾、序号前缀）
      const speaker = m[1].replace(/[:：]\s*$/, '').replace(/^\d+\.\s*/, '').trim();
      const time = [m[2], m[3]].filter(Boolean).join(' ').trim();
      flush();
      cur = { speaker, time, text: '', attachment: null, speakerUnknown: !speaker, timeUnknown: !time };
      continue;
    }
    if (!line.trim()) { if (cur && cur.text) cur.text += '\n'; continue; }
    const att = line.trim().match(ATTACH_RE);
    if (att && cur) {
      cur.attachment = { kind: att[1], label: att[2].trim(), name: att[2].trim(), pending: true };
      cur.text += (cur.text ? '\n' : '') + line.trim(); // 原文同时保留，检索不丢
      continue;
    }
    if (!cur) cur = { speaker: '', time: '', text: '', attachment: null, speakerUnknown: true, timeUnknown: true };
    cur.text += (cur.text ? '\n' : '') + line;
  }
  flush();
  return messages;
}

// 结构化消息 → 拼接回纯文本（存 notes 供全文检索；与原粘贴格式互逆）
function messagesToText(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.speaker || m.time) out.push([m.speaker, m.time].filter(Boolean).join(' '));
    if (m.text) out.push(m.text);
    out.push('');
  }
  return out.join('\n').trim();
}

module.exports = { parseChatText, messagesToText, HEAD_RE, ATTACH_RE };
