/**
 * 索引引擎 — 学习资产库的后台检索核心
 *
 * 调研依据（2026-09 调研结论）：
 * 1. 倒排索引（RAG 知识库/搜索引擎标配）：解析 → 索引 → 检索；中文无空格分词，采用
 *    CJK bigram（二字片）+ ASCII 词元，这是 Elasticsearch/MeiliSearch 对中文的通用做法
 * 2. 权重分层（Zettelkasten 主索引思想）：主标题命中权重最高（×3）、
 *    小标题/章节标题/标签/分类次之（×2）、正文最低（×1）——标题是知识检索的主锚点
 * 3. 分类主题一体化（中图法）：粗分类目（可生长）+ 细粒度主题词（标签），双层组织
 * 4. BM25 风格评分：TF 饱和 + 文档频率惩罚（稀有词更值钱）+ 字段权重 + 长度归一
 *
 * 本模块纯函数 + 轻量持久化，零外部依赖。
 */

const DAY_MS = 86400000;

// ---------- 文本分析 ----------
// ASCII 词（保留大小写原文+小写归一）+ CJK bigram；中文单字噪声大，二字片是精度/召回最佳平衡
function tokenize(input) {
  const s = String(input || '');
  const out = new Set();
  const ascii = s.match(/[A-Za-z0-9][A-Za-z0-9+#.\-]{1,24}/g) || [];
  for (const w of ascii) {
    out.add(w.toLowerCase());
    if (w.length >= 4 && w !== w.toUpperCase()) out.add(w.toLowerCase()); // 缩写词不再追加
    if (w.length >= 4 && w === w.toUpperCase()) out.add(w.toLowerCase());
  }
  const cjkRuns = s.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  // 单字 CJK 也入索引（低权重场景：搜索单个「云」字仍可召回）
  const singles = s.match(/[\u4e00-\u9fff]/g) || [];
  for (const ch of singles) out.add(ch);
  return [...out].filter(t => t && t.length >= 1 && t.length <= 25);
}

// 简易停用词：高频虚词/泛词，减少索引与主题词噪声
const STOP = new Set(['的了', '一个', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '如何',
  '可以', '就是', '但是', '因为', '所以', '如果', '还是', '或者', '以及', '并且',
  '一类', '这篇', '这篇', '这种', '那种', '专门', '关于', '相关', '整理', '学习', '内容', '资料', '文件',
  '工作', '今天', '明天', '以后', '然后', '只是', '有些', '很多', '时候', '地方',
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'not']);

function isStop(t) { return STOP.has(t); }

// 提取小标题（Markdown 标题行 / 「第X章/节」/ 编号标题）——Zettelkasten 小标题索引入口
function extractSubheads(text) {
  const s = String(text || '');
  const heads = [];
  const mdHeads = s.match(/^#{1,4}\s+(.+)$/gm) || [];
  for (const h of mdHeads) heads.push(h.replace(/^#+\s+/, '').trim());
  const zhHeads = s.match(/^(第[一二三四五六七八九十百\d]+[章节讲部篇]|[\d]+[\.、][^\n]{2,30})$/gm) || [];
  for (const h of zhHeads) heads.push(h.trim());
  return heads.filter(h => h.length >= 2 && h.length <= 60).slice(0, 40);
}

// ---------- 记录 → 索引文档 ----------
function docOf(item) {
  const subheads = extractSubheads(item.text);
  return {
    id: item.id,
    title: String(item.title || ''),
    tags: (item.tags || []).map(String),
    category: String(item.category || ''),
    subheads,
    body: String(item.text || '').slice(0, 40000),
    notes: [
      String(item.notes || '').slice(0, 8000),
      (item.uses || []).map(u => (u.purpose || '') + ' ' + (u.result || '')).join(' '),
      (item.improvements || []).map(u => (u.problem || '') + ' ' + (u.change || '')).join(' '),
      (item.versions || []).map(v => v.content || '').join('\n').slice(0, 4000),
    ].filter(Boolean).join('\n').slice(0, 12000),
    summary: String(item.summary || ''),
    kind: item.kind || '',
    created_at: item.created_at || 0,
    trashed: !!item.trashed,
  };
}

// 倒排索引：term → { df, postings: Map(id → {w, tf}) }
// 权重：title 3 / tags+category+subheads 2 / summary+notes 1.5 / body 1
function buildInverted(docs) {
  const index = new Map();
  const docLen = new Map();
  const F = [
    ['title', 3], ['tags', 2], ['category', 2], ['subheads', 2],
    ['summary', 1.5], ['notes', 1.5], ['body', 1],
  ];
  for (const d of docs) {
    if (d.trashed) continue;
    let len = 0;
    for (const [field, w] of F) {
      const text = field === 'tags' ? d.tags.join(' ') : d[field] || '';
      if (!text) continue;
      for (const t of tokenize(text)) {
        if (t.length === 1 && field === 'body') continue; // 单字只索引标题/标签/小标题，防正文噪声
        if (isStop(t)) continue;
        let entry = index.get(t);
        if (!entry) { entry = { df: 0, postings: new Map() }; index.set(t, entry); }
        let p = entry.postings.get(d.id);
        if (!p) { p = { w: w, tf: 0 }; entry.postings.set(d.id, p); entry.df += 1; }
        else if (p.w < w) p.w = w; // 同词多字段取最高权重
        p.tf += w;
        len += w;
      }
    }
    docLen.set(d.id, Math.max(len, 8));
  }
  return { index, docLen, N: docLen.size };
}

// ---------- BM25 风格检索 ----------
const K1 = 1.4, B = 0.72;
function search(index, query, { limit = 40 } = {}) {
  const { index: inv, docLen, N } = index;
  const terms = tokenize(query).filter(t => !isStop(t));
  if (!terms.length || !N) return [];
  const scores = new Map();
  for (const term of terms) {
    const entry = inv.get(term);
    if (!entry) continue;
    const idf = Math.log(1 + (N - entry.df + 0.5) / (entry.df + 0.5));
    for (const [id, p] of entry.postings) {
      const dl = docLen.get(id) || 8;
      const tfNorm = (p.tf * (K1 + 1)) / (p.tf + K1 * (1 - B + B * (dl / 260)));
      const s = idf * tfNorm * p.w;
      scores.set(id, (scores.get(id) || 0) + s);
    }
  }
  // 全 term 都查不到 → 退化前缀匹配（打字中途也能召回）
  if (!scores.size) {
    for (const term of terms) {
      for (const [t, entry] of inv) {
        if (t.startsWith(term) && term.length >= 2) {
          for (const [id, p] of entry.postings) scores.set(id, (scores.get(id) || 0) + p.w * 0.4);
        }
      }
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score: Math.round(score * 100) / 100 }));
}

// ---------- 从文本提取候选主题词（新分类命名 / 自动标签用） ----------
// 策略：CJK 2-4 字滑窗计分（长窗权重高，单次出现的 4 字窗也保留）+ 英文词元（全大写缩写加权）；
// 长词去重：保留高分长词，剔除被它包含的短碎片。短文本也能出有效主题词。
function topTerms(text, n = 8) {
  const s = String(text || '');
  const raw = new Map();
  const bump = (t, v) => { const k = t.toLowerCase(); if (k.length >= 2 && k.length <= 20 && !isStop(k)) raw.set(k, (raw.get(k) || 0) + v); };
  // 英文/缩写：RAG、LLM、PRD 这类强主题信号；普通小写词权重低一点
  for (const w of (s.match(/[A-Za-z][A-Za-z0-9+#\-]{1,15}/g) || [])) {
    bump(w, /^[A-Z]{2,6}$/.test(w) ? 6 : 3);
  }
  // CJK：双层提取。
  // 层1 · 虚词边界切割（单次出现也能抓到）：用高频虚词把 CJK run 切成实词段，
  //   段本身（2-6字）计高分 ——「心理咨询的职业路径」→「心理咨询」「职业路径」
  // 层2 · 复现合成：可靠 2-gram + 全可靠长窗加权（复现词加倍，跨段验证）
  const runs = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  // 虚词表（切割用）：只留单字、真作边界、极少构成实词的 —— 能/会/可/有/对/从/向/与/或/很 等
  // 会毁掉 储能/能源/可能/社会/可靠/对比/从业 一类真词，绝不入表
  const FUNC = /[的了是在我你他她它这那也由于及其之而被得着过吧吗啊呀]/;
  const FUNC_EDGE = FUNC; // 更小的集合：仅段边界粘字判定
  for (const run of runs) {
    // 层1：虚词边界切割（虚词表同时当段内切割器与边界验证器）
    const segs = run.split(FUNC)
      .filter(x => x && x.length >= 2);
    for (const seg of segs) {
      if (seg.length <= 4) {
        // 段首/段尾若粘了一个虚词单字（切割边界吞字），试偏移窗：如「业白皮书」→「白皮书」
        bump(seg, seg.length >= 3 ? seg.length + 3 : 4);
        if (seg.length >= 3 && seg.length <= 5) {
          if (FUNC_EDGE.test(seg[0])) bump(seg.slice(1), seg.length >= 4 ? 6 : 4);
          if (FUNC_EDGE.test(seg[seg.length - 1])) bump(seg.slice(0, -1), seg.length >= 4 ? 6 : 4);
        }
      }
      else if (seg.length <= 6) {
        bump(seg, seg.length + 4); // 5-6 字完整段直接计高分（大概率是复合术语）
        if (FUNC_EDGE.test(seg[0])) bump(seg.slice(1), 7);   // 头部粘虚词 → 偏移窗
        if (FUNC_EDGE.test(seg[seg.length - 1])) bump(seg.slice(0, -1), 7); // 尾部粘虚词
      }
      else {
        bump(seg.slice(0, 4), 4); // 头窗降权：跨界混合碎片与真词同分，靠复现叠分区分
        bump(seg.slice(-4), 4);
      }
    }
    // 层2：复现合成
    const bigram = new Map();
    for (let i = 0; i < run.length - 1; i++) { const g = run.slice(i, i + 2); bigram.set(g, (bigram.get(g) || 0) + 1); }
    const reliable = new Set();
    for (const [g, f] of bigram) {
      if (f >= 2) { reliable.add(g); continue; }
      const head = g[0], tail = g[1];
      let sameHead = 0, sameTail = 0;
      for (const [g2, f2] of bigram) {
        if (f2 < 2 || g2 === g) continue;
        if (g2[0] === head) sameHead += f2;
        if (g2[1] === tail) sameTail += f2;
      }
      if (sameHead >= 2 || sameTail >= 2) reliable.add(g);
    }
    for (let i = 0; i < run.length - 1; i++) {
      for (let L = Math.min(4, run.length - i); L >= 2; L--) {
        const w = run.slice(i, i + L);
        if (L === 2) { bump(w, 2); continue; }
        const gs = [];
        for (let k = 0; k + 2 <= L; k++) gs.push(reliable.has(w.slice(k, k + 2)));
        const allOk = gs.every(Boolean), anyOk = gs.some(Boolean);
        if (allOk) bump(w, L * 2);       // 全可靠长窗：真实合成词，权重翻倍；anyOk 不计分（碎片防线）
      }
    }
  }
  const isCJK = (t) => /[\u4e00-\u9fff]/.test(t);
  // 建类/命名级主题词：CJK ≥5（虚词切割段 4~9 分，复现合成词 6~8 分都能过；孤立 2-gram 2 分过不了）
  const cands = [...raw.entries()]
    .filter(([t, sc]) => sc >= (isCJK(t) ? 4 : 3))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const picked = [];
  for (const [t] of cands) {
    if (picked.some(p => p.includes(t) || t.includes(p))) continue; // 去重叠碎片
    if (isCJK(t) && FUNC.test(t) && t.length <= 2) continue; // 单个虚词不入候选
    picked.push(t);
    if (picked.length >= n) break;
  }
  return picked;
}

// 宽松版：供画像匹配消费 —— 额外纳入低置信 2-gram，保证「向量数据库选型」能对上词表里的「向量」
function matchTerms(text, n = 24) {
  const strict = topTerms(text, n);
  const s = String(text || '');
  const runs = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const extra = new Set();
  for (const run of runs) for (let i = 0; i < run.length - 1; i++) extra.add(run.slice(i, i + 2));
  return [...new Set([...strict, ...extra])].slice(0, n + 20);
}

module.exports = { tokenize, extractSubheads, docOf, buildInverted, search, topTerms, matchTerms };
