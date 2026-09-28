/**
 * 聊天消息规范化、追加去重、待补附件（纯函数，selfcheck 可直测）
 *
 * 去重原则：
 *   - 说话人 + 时间 + 正文 + 附件 全同 → 确定重复
 *   - 同文不同时间 → 保留
 *   - 信息不足（缺时间/说话人）→ 标「可能重复」，不静默丢弃
 */
const crypto = require('crypto');

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function attachKey(m) {
  const a = m && m.attachment;
  if (!a) return String(m && m.attachPath || '').split('/').pop().toLowerCase();
  return String(a.name || a.label || a.path || '').toLowerCase();
}

function stableMsgId(m, idx) {
  if (m && m.id) return String(m.id);
  const h = crypto.createHash('sha1')
    .update([norm(m && m.speaker), norm(m && m.time), norm(m && m.text), attachKey(m), String(idx)].join('\x1f'))
    .digest('hex').slice(0, 12);
  return 'm' + h;
}

function normalizeMessage(m, idx) {
  const speaker = String((m && m.speaker) || '').trim().slice(0, 40);
  const time = String((m && m.time) || '').trim().slice(0, 40);
  const text = String((m && m.text) || '');
  const speakerUnknown = m && m.speakerUnknown != null ? !!m.speakerUnknown : !speaker;
  const timeUnknown = m && m.timeUnknown != null ? !!m.timeUnknown : !time;
  const out = {
    id: stableMsgId(m || {}, idx == null ? 0 : idx),
    speaker,
    time,
    text,
    speakerUnknown,
    timeUnknown,
  };
  if (m && m.attachment) {
    const a = m.attachment;
    out.attachment = {
      kind: a.kind || '文件',
      label: a.label || a.name || '',
      name: a.name || a.label || '',
      path: a.path || '',
      ext: a.ext || '',
      size: a.size || 0,
      pending: !!(a.pending || ((a.label || a.name) && !a.path)),
    };
  }
  if (m && Array.isArray(m.files)) out.files = m.files;
  if (m && m.attachPath) out.attachPath = String(m.attachPath);
  if (m && m.possibleDup) { out.possibleDup = true; out.possibleDupOf = m.possibleDupOf || null; }
  return out;
}

function ensureMessageIds(messages) {
  return (messages || []).map((m, i) => normalizeMessage(m, i));
}

function exactKey(m) {
  return [norm(m.speaker).toLowerCase(), norm(m.time), norm(m.text), attachKey(m)].join('\x1f');
}

function planAppend(existing, incoming) {
  const have = ensureMessageIds(existing);
  const usedIds = new Set(have.map(m => m.id));
  const next = (incoming || []).map((m, i) => {
    const n = normalizeMessage(m, have.length + i);
    while (usedIds.has(n.id)) n.id = 'm' + crypto.randomUUID();
    usedIds.add(n.id);
    delete n.possibleDup; delete n.possibleDupOf;
    return n;
  });
  const added = [];
  const definiteDup = [];
  const possibleDup = [];
  const messages = [...have];

  function isDefinite(a, b) {
    if (norm(a.text) !== norm(b.text) || (!norm(a.text) && !attachKey(a))) return false;
    if (attachKey(a) !== attachKey(b)) return false;
    if (norm(a.speaker).toLowerCase() !== norm(b.speaker).toLowerCase()) return false;
    const t1 = norm(a.time), t2 = norm(b.time);
    return !!(norm(a.speaker) && norm(b.speaker) && !a.speakerUnknown && !b.speakerUnknown && !a.timeUnknown && !b.timeUnknown && t1 && t2 && t1 === t2);
  }

  for (const m of next) {
    if (!norm(m.text) && !attachKey(m)) continue;
    if (have.some((h) => isDefinite(h, m))) { definiteDup.push(m); continue; }

    const text = norm(m.text);
    const time = norm(m.time);
    const speaker = norm(m.speaker).toLowerCase();

    const sameText = text ? have.filter((h) => norm(h.text) === text) : [];
    const sameTextDiffTime = sameText.some((h) => {
      const ht = norm(h.time);
      return ht && time && ht !== time;
    });
    if (sameTextDiffTime && time) {
      added.push(m);
      messages.push(m);
      have.push(m);
      continue;
    }

    const maybe = have.find((h) => {
      if (!text || norm(h.text) !== text) return false;
      const ht = norm(h.time);
      const hs = norm(h.speaker).toLowerCase();
      if (ht && time && ht !== time) return false;
      const speakerGap = !hs || !speaker;
      const timeGap = !ht || !time;
      const speakerSame = hs && speaker && hs === speaker;
      if (speakerSame && ht && time && ht === time) return true;
      return speakerGap || timeGap;
    });
    if (maybe) {
      m.possibleDup = true;
      m.possibleDupOf = maybe.id;
      possibleDup.push(m);
      messages.push(m);
      have.push(m);
      continue;
    }

    added.push(m);
    messages.push(m);
    have.push(m);
  }

  return {
    incoming: next,
    added,
    definiteDup,
    possibleDup,
    messages,
    counts: { added: added.length, duplicate: definiteDup.length, possible: possibleDup.length },
  };
}

function pendingAttachments(messages) {
  const out = [];
  for (const m of messages || []) {
    const a = m.attachment;
    if (!a) continue;
    const filename = a.name || a.label;
    const hasFile = !!(a.path && !a.pending);
    if (filename && !hasFile) {
      out.push({
        id: m.id + ':att',
        messageId: m.id,
        filename,
        kind: a.kind || '文件',
        speaker: m.speaker || '',
        time: m.time || '',
        filled: false,
      });
    }
  }
  return out;
}

function namesMatch(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x);
}

function fillAttachment(messages, filename, fileRec, chosenMessageId) {
  const list = messages || [];
  if (chosenMessageId) {
    const m = list.find((x) => x.id === chosenMessageId);
    if (!m) return { ok: false, error: '消息不存在' };
    m.attachment = {
      ...(m.attachment || {}),
      ...fileRec,
      pending: false,
      name: (fileRec && fileRec.name) || filename,
      label: (fileRec && fileRec.name) || filename,
      path: fileRec && fileRec.path,
    };
    return { ok: true, filled: 1, messageId: m.id };
  }
  const hits = list.filter((m) => {
    const a = m.attachment;
    if (!a) return false;
    const n = a.name || a.label;
    if (!namesMatch(n, filename) && !namesMatch(filename, n)) return false;
    return !(a.path && !a.pending);
  });
  if (!hits.length) return { ok: false, error: '没有待补的同名附件', candidates: [] };
  if (hits.length > 1) {
    return {
      ok: false,
      needChoice: true,
      candidates: hits.map((h) => ({
        messageId: h.id,
        speaker: h.speaker || '未识别',
        time: h.time || '未识别',
        filename: (h.attachment && (h.attachment.name || h.attachment.label)) || filename,
      })),
    };
  }
  const m = hits[0];
  m.attachment = {
    ...(m.attachment || {}),
    ...fileRec,
    pending: false,
    name: (fileRec && fileRec.name) || filename,
    label: (fileRec && fileRec.name) || filename,
    path: fileRec && fileRec.path,
  };
  return { ok: true, filled: 1, messageId: m.id };
}

module.exports = {
  norm, attachKey, stableMsgId, normalizeMessage, ensureMessageIds,
  planAppend, pendingAttachments, fillAttachment, namesMatch,
};
