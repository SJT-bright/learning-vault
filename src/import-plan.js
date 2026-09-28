/**
 * 导入预检（纯函数 / 纯 Node，不依赖 Electron、不写库）—— LV-20260924-A
 *
 * planImport(payload, existingItems, options) → 可序列化 { planVersion, entries, summary, warnings }
 *
 * 设计底线（来自合同）：
 *   - 原文永远保留：解析失败 / 未知格式 / 编码可疑 → entry.rawText 原样带回 + issues 提示，绝不丢字、绝不臆造
 *   - 缺说话人 / 缺时间 → 只给 info 提示（speakerUnknown / timeUnknown），不猜
 *   - 稳定 ID：消息 ID 复用 chat-ops.stableMsgId（同内容重跑得到同 ID，供 commit 幂等）
 *   - sourceKey 以内容哈希构成；单纯同名不可去重（同内容不同名同 key，同内容不同目标条目不同 key）
 *   - 重复边界复用 chat-ops.planAppend：全同=确定重复；同文不同时间=保留；信息不足=可能重复（默认保留）
 *   - 有界读取：文件只读前 maxFileBytes 字节（默认 2MB），超出标记 truncated；绝不一次性读入任意超大文件
 *
 * payload: { text?, files?, kind? ('chat'|'note'|'auto'), targetItemId?, source? }
 *   - text：粘贴文本（原有路径），files：用户明确选取/拖入的 TXT/Markdown 文本文件路径
 *   - text 与 files 可同时给：text 一条 entry，每个文件各一条 entry
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseChatText, HEAD_RE } = require('./chat-parse');
const chatOps = require('./chat-ops');
const { looksLikeChat } = require('./capture');

const PLAN_VERSION = 1;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件预检上限（2MB）
const DEFAULT_MAX_COMMIT_BYTES = 20 * 1024 * 1024; // commit 阶段完整读取上限（20MB）
const DEFAULT_MAX_MESSAGES = 5000;                 // 单 entry 解析消息数上限
const DUP_SCAN_MAX_PER_ITEM = 5000;                // 跨条目全同消息比对时每条目扫描上限

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- 有界读取 + 编码识别 ----------

// TextDecoder 非 UTF-8 编码依赖 ICU；环境不支持时降级 latin1（字节 1:1 保留，内容不丢，标记 unknown）
function decodeBuffer(buf) {
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    try {
      return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8', bom: true };
    } catch { /* fallthrough */ }
  }
  // 大量 NUL 字节 → 二进制/损坏（NUL 不属于任何文本，先于编码猜测判断）
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  let nul = 0;
  for (const b of probe) if (b === 0) nul += 1;
  if (probe.length > 0 && nul / probe.length > 0.1) return { text: null, encoding: 'binary', bom: false };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', bom: false };
  } catch { /* not valid utf-8 */ }
  try {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(buf), encoding: 'gb18030', bom: false };
  } catch { /* ICU 不支持或仍乱码 */ }
  return { text: buf.toString('latin1'), encoding: 'unknown', bom: false };
}

function readTextBounded(filePath, maxBytes) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: { code: 'FILE_NOT_FILE', message: '不是常规文件' } };
    const cap = Math.min(st.size, maxBytes);
    const buf = Buffer.allocUnsafe(cap);
    let read = 0;
    while (read < cap) {
      const n = fs.readSync(fd, buf, read, cap - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { buf: buf.subarray(0, read), sizeOnDisk: st.size, mtimeMs: st.mtimeMs, truncated: st.size > maxBytes };
  } catch (e) {
    return { error: { code: 'FILE_NOT_FOUND', message: String((e && e.code) === 'ENOENT' ? '文件不存在' : e.message || e) } };
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// ---------- sourceKey ----------

// 来源键：kind + 目标条目 + 内容哈希。同名不同内容 → 不同 key（绝不用文件名去重）。
function makeSourceKey({ kind, targetItemId, contentSha }) {
  return 'src-' + sha256([String(kind || ''), String(targetItemId || 'new'), String(contentSha || '')].join('\x1f'));
}

// ---------- entry 级解析 ----------

function countHeads(text) {
  const lines = String(text || '').split('\n');
  let n = 0;
  for (const line of lines) if (HEAD_RE.test(line.replace(/\s+$/, ''))) n += 1;
  return n;
}

function issue(level, code, message, extra) {
  return { level, code, message, ...(extra || {}) };
}

function buildEntry({ kind, targetItemId, existingItem, existingItems, fileName, text, sourceMeta, options, exactIndex }) {
  const issues = [];
  const truncated = !!sourceMeta.truncated;
  if (truncated) {
    issues.push(issue('warn', 'TRUNCATED_FILE',
      `文件超过预检上限（${sourceMeta.readBytes}/${sourceMeta.sizeOnDisk} 字节已读），只预检了前 ${sourceMeta.readBytes} 字节；原文件未被修改，commit 时可完整处理`,
      { readBytes: sourceMeta.readBytes, sizeOnDisk: sourceMeta.sizeOnDisk }));
  }
  if (sourceMeta.encoding === 'gb18030') {
    issues.push(issue('info', 'ENCODING_GB18030', '文件不是 UTF-8，已按 GB18030 解码；如出现乱码请以 UTF-8 重新导出'));
  }
  if (sourceMeta.encoding === 'unknown') {
    issues.push(issue('warn', 'ENCODING_UNKNOWN', '无法识别文件编码，已按单字节保真读入（内容未丢但可能显示为乱码）'));
  }

  const heads = countHeads(text);
  const chatLike = looksLikeChat(text);
  let entryKind = kind;
  if (entryKind !== 'chat' && entryKind !== 'note') entryKind = chatLike ? 'chat' : 'note';

  let messages = [];
  let recognized = false;
  if (entryKind === 'chat') {
    recognized = heads >= 1;
    if (!recognized) {
      // 未知/非聊天格式：原文整段保留为单条消息（speaker/time 留空，只提示不臆造）
      issues.push(issue('warn', 'FORMAT_UNRECOGNIZED',
        '未识别出「说话人 时间」消息头，按整段文字保留原文；不会拆成确定的消息事实'));
    }
  } else {
    recognized = true; // note 不需要头行
  }
  messages = parseChatText(text).slice(0, options.maxMessages);
  // 空消息兜底：即使解析不出任何块，也保留原文本身
  if (!messages.length && text && text.trim()) {
    messages = [{ id: '', speaker: '', time: '', text, speakerUnknown: true, timeUnknown: true }];
  }
  messages = chatOps.ensureMessageIds(messages);

  let noSpeaker = 0;
  let noTime = 0;
  let pendingAtt = 0;
  for (const m of messages) {
    if (m.speakerUnknown) noSpeaker += 1;
    if (m.timeUnknown) noTime += 1;
    if (m.attachment && (m.attachment.pending || !m.attachment.path)) pendingAtt += 1;
  }
  // 只有识别成功的聊天才提示缺说话人/时间；纯文本/未识别时整个原文是一条，提示无意义
  if (entryKind === 'chat' && recognized) {
    if (noSpeaker) issues.push(issue('info', 'NO_SPEAKER', `${noSpeaker} 条消息没有说话人，已按原样保留（不会臆造）`));
    if (noTime) issues.push(issue('info', 'NO_TIME', `${noTime} 条消息没有时间，已按原样保留（不会臆造）`));
  }
  if (pendingAtt) issues.push(issue('info', 'PENDING_ATTACHMENTS',
    `${pendingAtt} 个附件只有文件名标注、没有实际文件；保存后可在详情页补齐`));

  // 重复边界：复用 planAppend（确定重复 / 可能重复默认保留；同文不同时间保留）
  // 参照条目：显式 targetItemId 优先；新条目则选与来料重叠最大的已有聊天条目做重复核对
  // （commit 时 D 侧仍会对真实目标重新 planAppend，这里的 counts 是预检参照，不落库）
  let referenceItem = existingItem || null;
  let refHits = 0;
  if (!referenceItem && messages.length) {
    const perItem = new Map();
    for (const m of messages) {
      if (!chatOps.norm(m.text) && !chatOps.attachKey(m)) continue;
      const key = [chatOps.norm(m.speaker).toLowerCase(), chatOps.norm(m.time), chatOps.norm(m.text), chatOps.attachKey(m)].join('\x1f');
      for (const itemId of exactIndex.get(key) || []) perItem.set(itemId, (perItem.get(itemId) || 0) + 1);
    }
    for (const [itemId, hits] of perItem) {
      if (hits > refHits) { refHits = hits; referenceItem = (existingItems || []).find((it) => it && it.id === itemId) || null; }
    }
  }
  const existingMessages = referenceItem ? (referenceItem.messages || []) : [];
  const planAppend = chatOps.planAppend(existingMessages, messages);  // 新条目场景：跨全部已有聊天条目检测整段重复导入（全同消息占比 100% → 提示，不自动丢弃）
  let possibleReimport = null;
  if (!existingItem) {
    const meaningful = planAppend.incoming.filter((m) => chatOps.norm(m.text) || chatOps.attachKey(m));
    if (meaningful.length) {
      const hitByItem = new Map();
      for (const m of meaningful) {
        const key = [chatOps.norm(m.speaker).toLowerCase(), chatOps.norm(m.time), chatOps.norm(m.text), chatOps.attachKey(m)].join('\x1f');
        const items = exactIndex.get(key);
        if (items) for (const itemId of items) hitByItem.set(itemId, (hitByItem.get(itemId) || 0) + 1);
      }
      for (const [itemId, hits] of hitByItem) {
        if (hits === meaningful.length) { possibleReimport = { ofItemId: itemId, matched: hits }; break; }
      }
      if (possibleReimport) {
        issues.push(issue('warn', 'FULL_DUPLICATE_OF_EXISTING',
          `内容与已有聊天「${possibleReimport.ofItemId}」完全相同，可能整段重复导入；默认仍可保存，是否跳过由 commit 决定`,
          { ofItemId: possibleReimport.ofItemId }));
      }
    }
  }

  const contentSha = sha256(Buffer.from(text || '', 'utf8'));
  const sourceKey = makeSourceKey({ kind: entryKind, targetItemId: targetItemId || null, contentSha });

  const firstMeaningful = messages.find((m) => chatOps.norm(m.text)) || null;
  const suggestedTitle = fileName
    ? fileName.replace(/\.(txt|md|markdown)$/i, '')
    : (firstMeaningful ? chatOps.norm(firstMeaningful.text).split('\n')[0].slice(0, 60) : '');

  return {
    sourceKey,
    kind: entryKind,
    targetItemId: targetItemId || null,
    isNewItem: !targetItemId,
    title: suggestedTitle || null,
    fileName: fileName || null,
    source: sourceMeta,
    rawText: text || '',
    messages: planAppend.incoming, // 与 plan 计数同源：addedIds / possibleDup 引用的就是这里的 ID
    parse: { recognized, format: entryKind === 'chat' ? (recognized ? 'chat' : 'plain') : 'note', heads },
    plan: {
      referenceItemId: referenceItem ? referenceItem.id : null,
      counts: planAppend.counts,
      addedIds: planAppend.added.map((m) => m.id),
      definiteDupIds: planAppend.definiteDup.map((m) => m.id),
      possibleDup: planAppend.possibleDup.map((m) => ({ id: m.id, possibleDupOf: m.possibleDupOf })),
      possibleReimport: possibleReimport || null,
    },
    issues,
  };
}

// ---------- 跨条目全同消息索引（有界） ----------

function buildExactIndex(existingItems) {
  const idx = new Map();
  for (const it of existingItems || []) {
    if (!it || it.kind !== 'chat') continue;
    const msgs = (it.messages || []).slice(0, DUP_SCAN_MAX_PER_ITEM);
    for (const m of msgs) {
      if (!chatOps.norm(m.text) && !chatOps.attachKey(m)) continue;
      const key = [chatOps.norm(m.speaker).toLowerCase(), chatOps.norm(m.time), chatOps.norm(m.text), chatOps.attachKey(m)].join('\x1f');
      if (!idx.has(key)) idx.set(key, []);
      const bucket = idx.get(key);
      if (!bucket.includes(it.id)) bucket.push(it.id);
    }
  }
  return idx;
}

// ---------- 主入口 ----------

function planImport(payload, existingItems, options) {
  const opts = {
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxMessages: DEFAULT_MAX_MESSAGES,
    ...(options || {}),
  };
  const p = payload || {};
  const entries = [];
  const warnings = [];
  const seenKeys = new Map(); // sourceKey → 第一个 entry 序号

  const exactIndex = buildExactIndex(existingItems);
  const existingById = new Map((existingItems || []).map((it) => [it && it.id, it]));

  const requestedKind = p.kind === 'chat' || p.kind === 'note' ? p.kind : 'auto';

  // 1) 粘贴文本
  const pastedText = p.text != null ? String(p.text) : '';
  if (pastedText.trim()) {
    const sha = sha256(Buffer.from(pastedText, 'utf8'));
    const sourceMeta = {
      type: 'paste', path: null, sizeBytes: Buffer.byteLength(pastedText, 'utf8'),
      mtimeMs: null, sha256: sha, encoding: 'utf-8', truncated: false,
      readBytes: Buffer.byteLength(pastedText, 'utf8'), sizeOnDisk: Buffer.byteLength(pastedText, 'utf8'),
    };
    const entry = buildEntry({
      kind: requestedKind, targetItemId: p.targetItemId, existingItem: p.targetItemId ? existingById.get(p.targetItemId) : null, existingItems,
      fileName: null, text: pastedText, sourceMeta, options: opts, exactIndex,
    });
    entries.push(entry);
  } else if (!pastedText.trim() && !(Array.isArray(p.files) && p.files.length)) {
    warnings.push(issue('warn', 'EMPTY_PAYLOAD', '没有可导入的内容（text 为空且未选文件）'));
  }

  // 2) 用户选取的 TXT / Markdown 文件
  const files = Array.isArray(p.files) ? p.files : [];
  for (const f of files) {
    const fp = String(f || '');
    if (!fp) continue;
    const ext = path.extname(fp).toLowerCase().replace(/^\./, '');
    const knownExt = ext === '' || ['txt', 'md', 'markdown', 'text', 'log'].includes(ext);
    const r = readTextBounded(fp, opts.maxFileBytes);
    if (r.error) {
      warnings.push(issue('error', r.error.code, `${path.basename(fp)}：${r.error.message}`, { path: fp }));
      continue;
    }
    const dec = decodeBuffer(r.buf);
    if (dec.encoding === 'binary') {
      warnings.push(issue('error', 'UNREADABLE_BINARY',
        `${path.basename(fp)}：内容像二进制/损坏数据，不是文本，已拒绝预检（原文件未改动）`, { path: fp }));
      continue;
    }
    const sourceMeta = {
      type: 'file', path: fp, sizeBytes: r.sizeOnDisk, mtimeMs: r.mtimeMs != null ? r.mtimeMs : null,
      sha256: sha256(r.buf), encoding: dec.encoding, truncated: r.truncated,
      readBytes: r.buf.length, sizeOnDisk: r.sizeOnDisk,
    };
    if (!knownExt) {
      warnings.push(issue('info', 'UNCOMMON_EXT', `${path.basename(fp)}：扩展名 .${ext || '(无)'} 不是常见文本格式，已按文本尝试解析`, { path: fp }));
    }
    if (r.truncated && dec.encoding === 'utf-8') {
      // 截断可能切在多字节字符中间 → 尾部乱码不影响前段；重解码去掉末尾不完整序列
      try {
        sourceMeta.partialChar = true;
        dec.text = new TextDecoder('utf-8').decode(r.buf);
      } catch { /* 保留原解码结果 */ }
    }
    if (!dec.text || !dec.text.trim()) {
      warnings.push(issue('error', 'EMPTY_FILE', `${path.basename(fp)}：空文件，没有可导入内容`, { path: fp }));
      continue;
    }
    const entry = buildEntry({
      kind: requestedKind, targetItemId: p.targetItemId, existingItem: p.targetItemId ? existingById.get(p.targetItemId) : null, existingItems,
      fileName: path.basename(fp), text: dec.text, sourceMeta, options: opts, exactIndex,
    });
    entries.push(entry);
  }

  // 3) payload 内 sourceKey 撞车（同批次重复来源）→ 第二份起标记，commit 默认跳过
  const duplicateSourceKeys = [];
  entries.forEach((entry, i) => {
    if (seenKeys.has(entry.sourceKey)) {
      duplicateSourceKeys.push(entry.sourceKey);
      entry.issues.push(issue('warn', 'SOURCE_KEY_SEEN',
        `本批次第 ${seenKeys.get(entry.sourceKey) + 1} 条来源内容完全相同（sourceKey 一致），commit 默认应跳过本条`,
        { firstAtIndex: seenKeys.get(entry.sourceKey) }));
    } else {
      seenKeys.set(entry.sourceKey, i);
    }
  });

  const summary = {
    entryCount: entries.length,
    chatEntries: entries.filter((e) => e.kind === 'chat').length,
    noteEntries: entries.filter((e) => e.kind === 'note').length,
    appendEntries: entries.filter((e) => !e.isNewItem).length,
    messagesParsed: entries.reduce((n, e) => n + e.messages.length, 0),
    addedTotal: entries.reduce((n, e) => n + e.plan.counts.added, 0),
    definiteDupTotal: entries.reduce((n, e) => n + e.plan.counts.duplicate, 0),
    possibleDupTotal: entries.reduce((n, e) => n + e.plan.counts.possible, 0),
    truncatedFiles: entries.filter((e) => e.source.truncated).length,
    duplicateSourceKeys,
  };

  return { planVersion: PLAN_VERSION, entries, summary, warnings };
}

// ---------- commit 阶段完整读取契约 ----------
//
// 预检的 source.sha256 是「读取前缀哈希」：文件超过 maxFileBytes（默认 2MB）时只覆盖前
// maxFileBytes 字节，且 entry.source.truncated=true、rawText 只是前缀文本。
// commit 前必须用 readSourceForCommit 重读源文件，三重新鲜度核对：
//   大小（sizeBytes） / 修改时间（mtimeMs） / 预检前缀哈希 —— 任一变化 → stale=true，须重新预览。
// 边界（必须如实理解）：前缀哈希只覆盖前 readBytes 字节；「尾部被改、大小与 mtime 不变」
// 或「旧计划缺 mtimeMs」时本函数检测不到，因此 D 在 commit 落库时仍须按合同做主进程源
// 校验与原文件完整归档保护，不能把仅前缀校验当成整文件哈希校验。
// complete 只表示「本次读取是否读到整个文件」（!stillTruncated）；预检历史截断保存在
// entry.source.truncated，不会污染本次结果。

function readSourceForCommit(entry, options) {
  const opts = { maxCommitBytes: DEFAULT_MAX_COMMIT_BYTES, ...(options || {}) };
  const src = entry && entry.source;
  if (!src) return { ok: false, reason: 'no-source' };
  if (src.type === 'paste') {
    return { ok: true, stale: false, staleReasons: [], complete: true, stillTruncated: false, text: entry.rawText || '', encoding: 'utf-8', sha256: src.sha256, note: '粘贴来源：rawText 即完整原文' };
  }
  if (src.type !== 'file' || !src.path) return { ok: false, reason: 'no-file' };
  let st;
  try { st = fs.statSync(src.path); } catch { return { ok: false, reason: 'missing', path: src.path }; }
  const r = readTextBounded(src.path, opts.maxCommitBytes);
  if (r.error) return { ok: false, reason: r.error.code, path: src.path };

  // 新鲜度：大小 / mtime / 前缀哈希（各查各的，逐项报告）
  const staleReasons = [];
  if (src.sizeBytes != null && r.sizeOnDisk !== src.sizeBytes) staleReasons.push('size');
  // mtime 1ms 容差：float ms 序列化/文件系统精度抖动
  if (src.mtimeMs != null && r.mtimeMs != null && Math.abs(r.mtimeMs - src.mtimeMs) > 1) staleReasons.push('mtime');
  const prefixLen = Math.min(Number(src.readBytes) || 0, r.buf.length);
  if (prefixLen > 0 && sha256(r.buf.subarray(0, prefixLen)) !== src.sha256) staleReasons.push('prefix');
  const stale = staleReasons.length > 0;

  const dec = decodeBuffer(r.buf);
  return {
    ok: true,
    stale,
    staleReasons,
    complete: !r.truncated,          // 本次读取是否读到整个文件（与预检是否截断无关）
    stillTruncated: r.truncated,     // 超过 commit 上限仍未读全
    text: dec.text || '',
    encoding: dec.encoding,
    sha256: sha256(r.buf),           // 本次实际读取内容的哈希：complete=true 时才是整读哈希
    sizeOnDisk: r.sizeOnDisk,
    readBytes: r.buf.length,
  };
}

module.exports = {
  PLAN_VERSION,
  planImport,
  makeSourceKey,
  readTextBounded,
  decodeBuffer,
  readSourceForCommit,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_COMMIT_BYTES,
  DEFAULT_MAX_MESSAGES,
};
