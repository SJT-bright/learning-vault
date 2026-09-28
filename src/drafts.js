/**
 * 未提交草稿：Esc 关闭 / 重启后可恢复；附件失效明确标注，不静默丢失。
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./json-io');

function checkFiles(files) {
  return (files || []).map((f) => {
    const p = typeof f === 'string' ? f : (f && f.path) || '';
    const name = (typeof f === 'string' ? path.basename(f) : (f && f.name)) || path.basename(p);
    const exists = !!(p && fs.existsSync(p));
    return { path: p, name, exists, missing: !exists };
  });
}

// 预检状态槽（quick-preview）的扩展字段白名单：渐进导入把 mode/open/decisions/batchId/result
// 存在独立槽，供重启后恢复失败批次与勾选决定。显式列出（schema-safe：不盲目透传未知字段），
// 只对该槽生效；其余槽与原有字段行为零变化。
const PRECHECK_SLOT = 'quick-preview';
const PRECHECK_FIELDS = ['mode', 'open', 'decisions', 'batchId', 'result'];

class DraftStore {
  constructor(file) {
    this.file = file;
    const data = readJson(file, {});
    this.data = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  }
  get(slot) {
    const d = this.data[slot];
    if (!d || typeof d !== 'object') return null;
    const files = checkFiles(d.files);
    return { ...d, files, hasMissing: files.some((f) => f.missing) };
  }
  save(slot, draft) {
    const prev = this.data[slot] || {};
    const next = {
      text: String((draft && draft.text) != null ? draft.text : prev.text || ''),
      intent: (draft && draft.intent) || prev.intent || 'note',
      kind: (draft && draft.kind) || prev.kind || '',
      chatTitle: draft?.chatTitle ?? prev.chatTitle ?? '',
      appendToId: draft?.appendToId !== undefined ? draft.appendToId : (prev.appendToId || null),
      chatSource: draft?.chatSource ?? prev.chatSource ?? '',
      files: checkFiles((draft && draft.files) != null ? draft.files : prev.files),
      messages: Array.isArray(draft && draft.messages) ? draft.messages : (prev.messages || []),
      updatedAt: Date.now(),
    };
    if (slot === PRECHECK_SLOT) {
      for (const k of PRECHECK_FIELDS) {
        if (draft && draft[k] !== undefined) next[k] = draft[k];
        else if (prev[k] !== undefined) next[k] = prev[k];
      }
    }
    const data = { ...this.data, [slot]: next };
    writeJsonAtomic(this.file, data, { backup: false });
    this.data = data;
    return this.get(slot);
  }
  clear(slot) {
    const data = { ...this.data };
    delete data[slot];
    writeJsonAtomic(this.file, data, { backup: false });
    this.data = data;
    return true;
  }
}

module.exports = { DraftStore, checkFiles };
