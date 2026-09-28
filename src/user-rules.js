/**
 * 用户纠错规则：「以后类似内容也这样归类」
 * 默认窄匹配（标题/阐述同时包含用户确认的词），不根据一次修改生成过大规则。
 */
const { uid } = require('./db');
const { readJson, writeJsonAtomic } = require('./json-io');

const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '还', '这', '那', '一个', '一些', '什么', '怎么', '如何',
  '可以', '不是', '没有', '以及', '并且', '因为', '所以', '如果', '或者', '关于', '相关', '整理', '学习',
  '内容', '资料', '文件', '工作', '今天', '以后', '收藏', '看看', '备用', '参考', '这个', '那个', '我们',
]);

function distinctiveTerms(text, max) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const cjk = s.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  const ascii = s.match(/[A-Za-z][A-Za-z0-9+#.\-]{1,20}/g) || [];
  for (const w of [...cjk, ...ascii]) {
    const t = w.toLowerCase();
    if (seen.has(t) || STOP.has(t) || t.length < 2) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= (max || 4)) break;
  }
  return out;
}

function matchItem(item, rule) {
  if (!rule || !rule.enabled || rule.revoked) return false;
  const terms = (rule.terms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  if (!terms.length) return false;
  const fields = rule.fields && rule.fields.length ? rule.fields : ['title', 'notes'];
  const blob = fields.map((f) => String((item && item[f]) || '')).join('\n').toLowerCase();
  if (rule.mode === 'any') return terms.some((t) => blob.includes(t));
  return terms.every((t) => blob.includes(t));
}

class UserRuleStore {
  constructor(file) {
    this.file = file;
    const data = readJson(file, []);
    this.rules = Array.isArray(data) ? data : [];
  }
  save() { writeJsonAtomic(this.file, this.rules); }

  list() { return this.rules.slice(); }

  create({ category, terms, fields, mode, fromItemId, reason }) {
    const cat = String(category || '').trim();
    const ts = (terms || []).map((t) => String(t).trim()).filter((t) => t.length >= 2 && t.length <= 20);
    if (!cat) return { ok: false, error: '缺少分类' };
    if (!ts.length) return { ok: false, error: '至少保留一个匹配词，范围才清楚' };
    const rec = {
      id: uid(),
      category: cat,
      terms: ts.slice(0, 6),
      fields: (fields && fields.length) ? fields : ['title', 'notes'],
      mode: mode === 'any' ? 'any' : 'all',
      enabled: true,
      fromItemId: fromItemId || null,
      reason: String(reason || '').slice(0, 120),
      created_at: Date.now(),
      revoked: false,
    };
    this.rules.unshift(rec);
    this.save();
    return { ok: true, rule: rec };
  }

  set(id, patch) {
    const r = this.rules.find((x) => x.id === id);
    if (!r) return { ok: false, error: '规则不存在' };
    if(patch && Array.isArray(patch.terms) && (!patch.terms.length || patch.terms.some(t=>typeof t!=='string'||t.trim().length<2||t.length>20)))return {ok:false,error:'匹配词需为 2 至 20 个字，至少一个'};
    if(patch && patch.category!==undefined && !String(patch.category).trim())return {ok:false,error:'分类不能为空'};
    if (patch && patch.enabled != null) r.enabled = !!patch.enabled;
    if (patch && patch.revoked != null) { r.revoked = !!patch.revoked; if (r.revoked) r.enabled = false; }
    if (patch && Array.isArray(patch.terms)) r.terms = patch.terms.map(String).filter(Boolean).slice(0, 6);
    if (patch && patch.category) r.category = String(patch.category);
    if (patch && patch.mode) r.mode = patch.mode === 'any' ? 'any' : 'all';
    this.save();
    return { ok: true, rule: r };
  }

  match(item) {
    for (const r of this.rules) {
      if (!r.enabled || r.revoked) continue;
      if (matchItem(item, r)) return r;
    }
    return null;
  }

  preview(items, rule) {
    const hits = (items || []).filter((it) => it && !it.trashed && !it.category_locked && matchItem(it, rule));
    return hits.map((it) => ({ id: it.id, title: it.title, category: it.category }));
  }
}

module.exports = { UserRuleStore, distinctiveTerms, matchItem };
