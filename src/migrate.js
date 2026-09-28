/**
 * v0.10 数据迁移：旧条目可读，重复执行不复制记录。
 */
const { ensureMessageIds } = require('./chat-ops');
const { migrateIdea } = require('./ideas');
const { readJson, writeJsonAtomic } = require('./json-io');
const path = require('path');

const SCHEMA_VERSION = 10;

function migrateItem(it) {
  if (!it || typeof it !== 'object') return false;
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(it, '_ids')) { delete it._ids; changed = true; }
  const arrFields = ['uses', 'improvements', 'versions', 'import_batches', 'tags', 'files', 'images', 'links', 'messages'];
  for (const f of arrFields) {
    if (!Array.isArray(it[f])) { it[f] = []; changed = true; }
  }
  if (it.category_locked == null) { it.category_locked = false; changed = true; }
  if (it.use_count == null) { it.use_count = (it.uses || []).length; changed = true; }
  if (it.kind === 'chat') {
    const before = JSON.stringify(it.messages);
    it.messages = ensureMessageIds(it.messages);
    if (JSON.stringify(it.messages) !== before) changed = true;
    if (!it.raw_text) { it.raw_text = it.notes || ''; changed = true; }
    if (!it.import_batches.length && (it.raw_text || it.messages.length)) {
      it.import_batches = [{
        id: 'legacy-' + (it.id || 'x'),
        imported_at: it.created_at || Date.now(),
        raw_text: it.raw_text,
        added_ids: it.messages.map((m) => m.id),
        counts: { added: it.messages.length, duplicate: 0, possible: 0 },
      }];
      changed = true;
    }
  }
  return changed;
}

function migrateIdeas(list) {
  if (!Array.isArray(list)) return { list: [], changed: false };
  let changed = false;
  const out = list.map((i) => {
    const missing = !i || i.status == null || i.next_action == null || !Array.isArray(i.related_item_ids) || !Array.isArray(i.status_history);
    const n = migrateIdea(i);
    if (missing) changed = true;
    return n;
  });
  return { list: out, changed };
}

function loadMeta(dataDir) {
  return readJson(path.join(dataDir, 'meta.json'), { schemaVersion: 0 });
}
function saveMeta(dataDir, meta) {
  writeJsonAtomic(path.join(dataDir, 'meta.json'), meta);
}

function migrateAll({ store, ideaItems, dataDir }) {
  const meta = loadMeta(dataDir);
  let changed = meta.schemaVersion !== SCHEMA_VERSION;
  if (store && Array.isArray(store.items)) {
    for (const it of store.items) if (migrateItem(it)) changed = true;
  }
  let ideas = ideaItems;
  if (Array.isArray(ideaItems)) {
    const r = migrateIdeas(ideaItems);
    ideas = r.list;
    if (r.changed) changed = true;
  }
  if (changed) {
    if (store && store.save) store.save();
    saveMeta(dataDir, { schemaVersion: SCHEMA_VERSION, migrated_at: Date.now() });
  } else if (meta.schemaVersion !== SCHEMA_VERSION) {
    saveMeta(dataDir, { schemaVersion: SCHEMA_VERSION, migrated_at: Date.now() });
  }
  return { schemaVersion: SCHEMA_VERSION, ideas, changed };
}

module.exports = { SCHEMA_VERSION, migrateItem, migrateIdeas, migrateAll, loadMeta };
