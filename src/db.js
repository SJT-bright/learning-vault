/**
 * JSON 数据存储（零编译依赖，数据落在 userData/data 下）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJsonAtomic } = require('./json-io');

const uid = () => crypto.randomUUID().slice(0, 8) + Date.now().toString(36).slice(-4);

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.itemsFile = path.join(dataDir, 'library.json');
    this.eventsFile = path.join(dataDir, 'events.json');
    this.indexFile = path.join(dataDir, 'index.json');
    this.reviewsFile = path.join(dataDir, 'reviews.json');
    this.quotesFile = path.join(dataDir, 'quotes.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.items = this._read(this.itemsFile, []);
    this.events = this._read(this.eventsFile, []);
    this.reviews = this._read(this.reviewsFile, []);
    this.quotes = this._read(this.quotesFile, []);
  }

  _read(file, fallback) {
    return readJson(file, fallback);
  }
  _write(file, data) {
    writeJsonAtomic(file, data);
  }
  save() {
    this._write(this.itemsFile, this.items);
    this._write(this.eventsFile, this.events);
    // 轻量索引（可被外部检索/备份）
    const idx = this.items.map(i => ({
      id: i.id, title: i.title, category: i.category, tags: i.tags,
      kind: i.kind, created_at: i.created_at, summary: (i.summary || '').slice(0, 120),
    }));
    this._write(this.indexFile, idx);
  }

  insert(item) {
    const now = Date.now();
    const rec = {
      id: uid(),
      kind: 'note',            // url | file | video | image | chat | note | bundle（video/image 只索引：source_path 指向原文件，不复制）
      title: '未命名',
      category: '未分类',
      tags: [],
      notes: '',               // 用户附言 / 聊天记录
      summary: '',             // AI 摘要
      text: '',                // 全文（截断存储）
      url: '',
      source_path: '',
      files: [],               // [{path,name,ext,size}] 归档副本
      images: [],              // [{file,name,filename,size,mime,from?}] 文档提取出的图片（画廊/收为资产）
      links: [],               // [{url,text}] 文档内超链接
      source_item_id: null,    // 图片资产来源文档（详情页可跳回）
      messages: [],            // [{id,speaker,time,text,attachment,files?}] 聊天记录结构化消息块（时序呈现）
      raw_text: '',            // 聊天导入原文（解析失败也保留）
      import_batches: [],      // 每次追加的批次
      uses: [],                // 使用记录（只有用户明确记下才计数）
      improvements: [],        // 改进意见（不等于自动复制一份）
      versions: [],            // 可复用版本历史
      current_version_id: null,
      category_locked: false,  // 用户明确指定的分类，自动归类不得覆盖
      use_count: 0,
      last_used_at: null,
      favorite: false,
      trashed: false,
      status: 'new',           // new | classified | error
      classification_source: '', // ai | heuristic
      bundle_id: null,
      created_at: now,
      updated_at: now,
      ...item,
    };
    this.items.unshift(rec);
    this.events.push({ t: now, type: 'ingest', id: rec.id, title: rec.title, category: rec.category, kind: rec.kind });
    this.save();
    return rec;
  }

  get(id) { return this.items.find(i => i.id === id) || null; }

  update(id, patch) {
    const it = this.get(id);
    if (!it) return null;
    Object.assign(it, patch, { updated_at: Date.now() });
    if (patch.category || patch.tags) {
      this.events.push({ t: Date.now(), type: 'classify', id, category: it.category, tags: it.tags });
    }
    this.save();
    return it;
  }

  remove(id) {
    const it = this.get(id);
    if (!it) return null;
    it.trashed = true;
    this.events.push({ t: Date.now(), type: 'delete', id });
    this.save();
    return it;
  }

  list(f = {}) {
    let arr = this.items.filter(i => !i.trashed);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      arr = arr.filter(i =>
        (i.title || '').toLowerCase().includes(q) ||
        (i.notes || '').toLowerCase().includes(q) ||
        (i.summary || '').toLowerCase().includes(q) ||
        (i.text || '').toLowerCase().includes(q) ||
        (i.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    // 层级分类：父类筛选（「教程课程」）应包含其全部子类（「教程课程/视频制作」）条目
    if (f.category && f.category !== '全部') {
      const cat = String(f.category);
      arr = arr.filter(i => i.category === cat || String(i.category || '').startsWith(cat + '/'));
    }
    if (f.tag) arr = arr.filter(i => (i.tags || []).includes(f.tag));
    // 「文件」筛选包含文件包（对使用者是一个概念）；其余类型精确匹配
    if (f.kind && f.kind !== 'all') arr = arr.filter(i => f.kind === 'file' ? (i.kind === 'file' || i.kind === 'bundle') : i.kind === f.kind);
    if (f.favorites) arr = arr.filter(i => i.favorite);
    if (f.from) arr = arr.filter(i => i.created_at >= f.from);
    if (f.to) arr = arr.filter(i => i.created_at <= f.to);
    if (f.sort === 'oldest') arr.sort((a, b) => a.created_at - b.created_at);
    else if (f.sort === 'title') arr.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
    else arr.sort((a, b) => b.created_at - a.created_at);

    const facets = { categories: {}, tags: {} };
    for (const i of this.items) {
      if (i.trashed) continue;
      facets.categories[i.category] = (facets.categories[i.category] || 0) + 1;
      for (const t of i.tags || []) facets.tags[t] = (facets.tags[t] || 0) + 1;
    }
    const total = arr.length;
    const offset = f.offset || 0;
    const limit = f.limit || 200;
    return { items: arr.slice(offset, offset + limit), total, facets };
  }

  itemsOfDay(dateStr) { // dateStr: YYYY-MM-DD (local)
    const start = new Date(dateStr + 'T00:00:00').getTime();
    const end = start + 86400000;
    return this.items.filter(i => !i.trashed && i.created_at >= start && i.created_at < end);
  }
  itemsOfRange(fromTs, toTs) {
    return this.items.filter(i => !i.trashed && i.created_at >= fromTs && i.created_at <= toTs);
  }
  // 全量有效条目（排除软删除，不截断）— 供统计引擎读取
  allItems() {
    return this.items.filter(i => !i.trashed);
  }
  addEvent(ev) { this.events.push({ t: Date.now(), ...ev }); this.save(); }
  eventsSince(ts) { return this.events.filter(e => e.t >= ts); }
  addReview(r) { this.reviews.unshift({ id: uid(), created_at: Date.now(), ...r }); this._write(this.reviewsFile, this.reviews); }
  listReviews() { return this.reviews; }

  // ---- 金句库 ----
  _saveQuotes() { this._write(this.quotesFile, this.quotes); }
  addQuote(r) {
    const q = { id: uid(), text: '', note: '', source: '', source_item_id: null, tags: [], links: [], created_at: Date.now(), ...r };
    if (!Array.isArray(q.links)) q.links = []; // 旧数据 / 显式 undefined 兜底
    this.quotes.unshift(q); this._saveQuotes(); return q;
  }
  getQuote(id) { return this.quotes.find(q => q.id === id) || null; }
  updateQuote(id, patch) { const q = this.getQuote(id); if (!q) return null; Object.assign(q, patch); this._saveQuotes(); return q; }
  removeQuote(id) {
    const i = this.quotes.findIndex(q => q.id === id);
    if (i < 0) return false;
    this.quotes.splice(i, 1);
    for (const q of this.quotes) if (Array.isArray(q.links) && q.links.includes(id)) q.links = q.links.filter(x => x !== id); // 清理悬挂引用
    this._saveQuotes(); return true;
  }
  listQuotes(f = {}) {
    let arr = [...this.quotes];
    if (f.q) {
      const s = String(f.q).toLowerCase();
      arr = arr.filter(x => ((x.text || '') + ' ' + (x.note || '') + ' ' + (x.source || '') + ' ' + (x.tags || []).join(' ')).toLowerCase().includes(s));
    }
    if (f.tag) arr = arr.filter(x => (x.tags || []).includes(f.tag));
    if (f.itemId) arr = arr.filter(x => x.source_item_id === f.itemId);
    arr.sort((a, b) => b.created_at - a.created_at);
    return arr;
  }
  randomQuote() { if (!this.quotes.length) return null; return this.quotes[Math.floor(Math.random() * this.quotes.length)]; }

  // ---- 金句引用关系（知识图谱第一层）----
  // 双向引用：a.links / b.links 互相写入并去重；任一端不存在或自引用时拒绝
  linkQuotes(idA, idB) {
    const a = this.getQuote(idA), b = this.getQuote(idB);
    if (!a || !b) return { ok: false, error: '金句不存在' };
    if (idA === idB) return { ok: false, error: '不能与自身建立引用' };
    if (!Array.isArray(a.links)) a.links = [];
    if (!Array.isArray(b.links)) b.links = [];
    if (!a.links.includes(idB)) a.links.push(idB);
    if (!b.links.includes(idA)) b.links.push(idA);
    this._saveQuotes();
    return { ok: true, linksA: a.links, linksB: b.links };
  }
  // 引用图：nodes 为全部金句（id/text/tags），edges 由 links 派生（无向，每对只出一条，悬挂引用剔除）
  quoteGraph() {
    const ids = new Set(this.quotes.map(q => q.id));
    const nodes = this.quotes.map(q => ({ id: q.id, text: q.text, tags: q.tags || [] }));
    const seen = new Set();
    const edges = [];
    for (const q of this.quotes) {
      for (const other of (q.links || [])) {
        if (!other || other === q.id || !ids.has(other)) continue;
        const pair = [q.id, other].sort();
        const key = pair[0] + '|' + pair[1];
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a: pair[0], b: pair[1] });
      }
    }
    return { nodes, edges };
  }
}

module.exports = { Store, uid };
