/**
 * 从聊天/资料提取的结论、待办、方法（点子走点子系统，这里只留关联）
 */
const { uid } = require('./db');
const { readJson, writeJsonAtomic } = require('./json-io');

const KINDS = {
  conclusion: '结论',
  todo: '待办',
  method: '方法',
  idea: '点子',
};

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

class ExtractStore {
  constructor(file) {
    this.file = file;
    const data = readJson(file, []);
    this.items = Array.isArray(data) ? data : [];
  }
  save() { writeJsonAtomic(this.file, this.items); }

  keyOf(rec) {
    const ids = (rec.source_message_ids || []).slice().map(String).sort().join(',');
    return JSON.stringify([rec.kind, rec.source_item_id || '', ids, norm(rec.title), norm(rec.body)]);
  }

  add(rec) {
    const kind = rec && KINDS[rec.kind] ? rec.kind : 'conclusion';
    const item = {
      id: uid(),
      kind,
      title: String((rec && rec.title) || '').trim().slice(0, 80) || KINDS[kind],
      body: String((rec && rec.body) || '').trim().slice(0, 8000),
      source_item_id: (rec && rec.source_item_id) || null,
      source_message_ids: Array.isArray(rec && rec.source_message_ids) ? rec.source_message_ids.map(String) : [],
      source_text: String((rec && rec.source_text) || '').slice(0, 4000),
      created_at: Date.now(),
      updated_at: Date.now(),
      ai_draft: !!(rec && rec.ai_draft),
      todo_done: false,
      todo_done_at: null,
      idea_id: (rec && rec.idea_id) || null,
      trashed: false,
    };
    const rawTitle = String((rec && rec.title) || '').trim();
    const rawBody = String((rec && rec.body) || '').trim();
    if (!rawTitle && !rawBody) return { ok: false, error: '内容是空的' };
    const k = this.keyOf(item);
    const dup = this.items.find((x) => !x.trashed && this.keyOf(x) === k);
    if (dup) return { ok: true, extract: dup, deduped: true };
    this.items.unshift(item);
    this.save();
    return { ok: true, extract: item };
  }

  get(id) { return this.items.find((x) => x.id === id) || null; }

  update(id, patch) {
    const it = this.get(id);
    if (!it) return null;
    const allow = ['title', 'body', 'todo_done', 'idea_id', 'ai_draft'];
    for (const k of allow) if (patch && patch[k] !== undefined) it[k] = patch[k];
    if (patch && patch.todo_done === true && !it.todo_done_at) it.todo_done_at = Date.now();
    if (patch && patch.todo_done === false) it.todo_done_at = null;
    it.updated_at = Date.now();
    this.save();
    return it;
  }

  remove(id) {
    const it = this.get(id);
    if (!it) return false;
    it.trashed = true;
    it.updated_at = Date.now();
    this.save();
    return true;
  }

  list(f = {}) {
    let arr = this.items.filter((x) => !x.trashed);
    if (f.kind) arr = arr.filter((x) => x.kind === f.kind);
    if (f.itemId) arr = arr.filter((x) => x.source_item_id === f.itemId);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      arr = arr.filter((x) => (x.title + ' ' + x.body).toLowerCase().includes(q));
    }
    arr.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    return arr;
  }

  byItem(itemId) { return this.list({ itemId }); }

  byMessage(itemId, messageId) {
    return this.list({ itemId }).filter((x) => (x.source_message_ids || []).includes(String(messageId)));
  }

  asSearchDocs() {
    return this.list().map((x) => ({
      id: 'ex:' + x.id,
      title: x.title,
      kind: x.kind,
      category: KINDS[x.kind] || '整理',
      tags: [KINDS[x.kind] || '整理'],
      notes: x.body,
      text: x.body,
      summary: (x.ai_draft ? 'AI 草稿 · ' : '') + (x.body || '').slice(0, 120),
      created_at: x.created_at,
      trashed: false,
      _resultType: x.kind,
      _extractId: x.id,
      _sourceItemId: x.source_item_id,
    }));
  }
}

module.exports = { ExtractStore, KINDS };
