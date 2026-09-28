/**
 * 使用记录、改进意见、可复用版本（作用在资料条目上，不另起一套库）
 *
 * 打开详情 / 搜索命中 不算使用。只有用户明确「记一次使用」才计数。
 * 外部原文件（PDF/Word）默认不覆盖，改进记在条目上。
 */
const { uid } = require('./db');

function editableField(item) {
  if (!item) return 'notes';
  if (item.kind === 'note' || item.kind === 'chat') return 'notes';
  if (item.kind === 'file' || item.kind === 'bundle' || item.kind === 'url') return 'notes';
  return 'notes';
}

function currentContent(item) {
  const field = editableField(item);
  if (item && item.current_version_id && Array.isArray(item.versions)) {
    const v = item.versions.find((x) => x.id === item.current_version_id);
    if (v) return v.content;
  }
  return String((item && item[field]) || (item && item.text) || '');
}

function ensureOriginalVersion(item) {
  if (!item) return item;
  if (!Array.isArray(item.versions)) item.versions = [];
  if (item.versions.length) return item;
  const field = editableField(item);
  const content = String(item[field] || item.text || '');
  const v = {
    id: uid(),
    content,
    field,
    created_at: item.created_at || Date.now(),
    reason: '原始内容',
    from_version_id: null,
  };
  item.versions.push(v);
  if (!item.current_version_id) item.current_version_id = v.id;
  return item;
}

function addUse(item, rec) {
  if (!item) return { ok: false, error: '资料不存在' };
  if (!Array.isArray(item.uses)) item.uses = [];
  const u = {
    id: uid(),
    purpose: String((rec && rec.purpose) || '').trim().slice(0, 200),
    result: String((rec && rec.result) || '').trim().slice(0, 2000),
    used_at: Number.isFinite(rec && rec.used_at) ? rec.used_at : Date.now(),
    related_ids: Array.isArray(rec && rec.related_ids) ? rec.related_ids : [],
    related_url: String((rec && rec.related_url) || '').slice(0, 500),
  };
  if (!u.purpose && !u.result) return { ok: false, error: '写一下用于什么，或结果如何' };
  item.uses.unshift(u);
  item.use_count = item.uses.length;
  item.last_used_at = u.used_at;
  return { ok: true, use: u, item };
}

function addImprovement(item, rec) {
  if (!item) return { ok: false, error: '资料不存在' };
  if (!Array.isArray(item.improvements)) item.improvements = [];
  const im = {
    id: uid(),
    problem: String((rec && rec.problem) || '').trim().slice(0, 500),
    change: String((rec && rec.change) || '').trim().slice(0, 2000),
    reason: String((rec && rec.reason) || '').trim().slice(0, 1000),
    created_at: Date.now(),
    version_id: null,
  };
  if (!im.problem && !im.change) return { ok: false, error: '写一下发现的问题或改了什么' };
  const full = rec && rec.fullVersion != null ? String(rec.fullVersion) : '';
  if (full) {
    const ver = addVersion(item, { content: full, reason: im.reason || im.change || '改进版本', makeCurrent: true });
    if (ver.ok) im.version_id = ver.version.id;
  }
  item.improvements.unshift(im);
  return { ok: true, improvement: im, item };
}

function addVersion(item, rec) {
  if (!item) return { ok: false, error: '资料不存在' };
  ensureOriginalVersion(item);
  const content = String((rec && rec.content) != null ? rec.content : '');
  if (!content.trim()) return { ok: false, error: '版本内容是空的' };
  const v = {
    id: uid(),
    content,
    field: editableField(item),
    created_at: Date.now(),
    reason: String((rec && rec.reason) || '改进版本').slice(0, 200),
    from_version_id: item.current_version_id || null,
  };
  item.versions.push(v);
  if (rec && rec.makeCurrent !== false) {
    item.current_version_id = v.id;
    item[v.field] = content;
  }
  return { ok: true, version: v, item };
}

function setCurrentVersion(item, versionId) {
  if (!item || !Array.isArray(item.versions)) return { ok: false, error: '没有版本' };
  const v = item.versions.find((x) => x.id === versionId);
  if (!v) return { ok: false, error: '版本不存在' };
  item.current_version_id = v.id;
  item[v.field || editableField(item)] = v.content;
  return { ok: true, version: v, item };
}

function restoreVersion(item, versionId) {
  if (!item || !Array.isArray(item.versions)) return { ok: false, error: '没有版本' };
  const v = item.versions.find((x) => x.id === versionId);
  if (!v) return { ok: false, error: '版本不存在' };
  // 恢复 = 以旧版内容新建一版并指定为当前，不销毁较新版本
  return addVersion(item, {
    content: v.content,
    reason: '恢复自「' + (v.reason || '历史版本') + '」',
    makeCurrent: true,
  });
}

function recentUsed(items, limit) {
  const rows = [];
  for (const it of items || []) {
    if (it.trashed) continue;
    const last = it.last_used_at || ((it.uses && it.uses[0] && it.uses[0].used_at) || 0);
    if (!last) continue;
    rows.push({ item: it, last });
  }
  rows.sort((a, b) => b.last - a.last);
  return rows.slice(0, limit || 30).map((r) => r.item);
}

function frequentUsed(items, limit) {
  const rows = [];
  for (const it of items || []) {
    if (it.trashed) continue;
    const n = Array.isArray(it.uses) ? it.uses.length : (it.use_count || 0);
    if (!n) continue;
    rows.push({ item: it, n, last: it.last_used_at || 0 });
  }
  rows.sort((a, b) => b.n - a.n || b.last - a.last);
  return rows.slice(0, limit || 30).map((r) => r.item);
}

module.exports = {
  editableField, currentContent, ensureOriginalVersion,
  addUse, addImprovement, addVersion, setCurrentVersion, restoreVersion,
  recentUsed, frequentUsed,
};
