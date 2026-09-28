/**
 * 分类画像 + 动态分类引擎 — 「规则 × 画像」双信号融合归类（v0.6 引擎）
 *
 * 调研依据（2026-09）：
 * - 中图法/UDC：大类稳定、小类可生长 → 固定 8 大类主干 + 用户自建分类
 * - 数字图书馆「分类主题一体化」：类目画像（高频主题词）与检索互相增强
 * - 文本分类的可靠形态：类中心向量余弦相似度 + 关键词规则先验，冷启动用规则兜底
 *
 * ── 底层参数设计（调优依据）──────────────────────────────────────────
 * 【画像层 · IDF 加权覆盖率】
 *   idf(t)   = ln(1 + N/df(t))      df = 含 t 的类目画像数 —— 词出现在越多类目，
 *                                    区分度越低（「学习」「文件」这类通用词被自动压平）
 *   c'(t)    = √画像词权重          边际递减，防单个高频词霸榜
 *   score(c) = Σ_hit c'(t)·idf(t) / Σ_q idf(t)²½ ∈ (0,1]
 *            —— 「查询向量的 IDF 质量有多少被该类目画像解释」的覆盖率语义：
 *            稀疏查询（短标题/纯阐述）不会被自身无关词撑大分母，跨类目可直接比较
 *   冷启动    count < MIN_PROFILE_COUNT(2) 的类目不参与 —— 少于 2 条样本的统计不可信
 *
 * 【规则层 · 自定义关键词】见 src/taxonomy-rules.js：
 *   字段权重 标题3/阐述2.5/正文1，词权重 1~5，命中计次封顶 3，总分反商饱和 s/(12+s)
 *
 * 【融合决策】decide()
 *   fused(c) = W_RULE×ruleNorm + W_PROFILE×coverage   W_RULE=0.52, W_PROFILE=0.48
 *     —— 规则略高：显式配置的关键词是用户意图的直接表达；画像负责泛化与长尾
 *   margin  = fused(top1) − fused(top2)             类目区分度
 *   置信度   = clamp(0.35 + 0.5×top1 + 0.3×margin, 0.05, 0.95)
 *   顺位：① 用户阐述（≥8字且含实义主题词：命中画像/规则关键词 → 定向归类；
 *          全都接不住 → 建类建议；泛化阐述「以后看/先收藏」被 VAGUE 过滤，不触发）
 *         ② 融合高分（top1≥ADOPT_NORM 且 margin≥MIN_MARGIN → 高置信采用）
 *         ③ 融合中分（top1≥MID_NORM → 采用但低置信，「整理积压」可重审）
 *         ④ 内置弱规则兜底 → ⑤ 资料收藏
 *   主题词↔关键词/画像词的匹配用「包含」而非严格相等（「分镜设计」接住关键词「分镜」）
 */

const fs = require('fs');
const { topTerms, matchTerms } = require('./index-engine');

// 固定八大类（中图法式主干，不轻易动）
const BASE_CATEGORIES = ['技术研究', '教程课程', '行业报告', '产品设计', '商业思考', '工具效率', '人文视野', '资料收藏'];
const FALLBACK_CAT = '资料收藏';

// ---------- 融合决策参数（集中定义，调参只动这里） ----------
const W_RULE = 0.52;            // 规则层融合权重
const W_PROFILE = 0.48;         // 画像层融合权重
const ADOPT_NORM = 0.40;        // 融合 top1 达此值 → 高置信采用
const MIN_MARGIN = 0.05;        // top1 领先第二名至少此差距才高置信
const MID_NORM = 0.22;          // 达此值 → 采用但低置信
const MIN_PROFILE_COUNT = 2;    // 画像至少喂过 N 条才参与判定
const NOTES_MIN_CHARS = 8;      // 阐述至少 N 字才视为有效表达

// 泛化阐述词表：这些「主题词」不是主题 —— 全由它们组成阐述时视为没说（不定向、不建类）
const VAGUE_TOPICS = new Set([
  '收藏', '以后', '一下', '看看', '东西', '资料', '文件', '内容', '学习', '整理',
  '备用', '参考', '随手', '先存', '下次', '回头', '再看', '好文', '不错', '有用',
]);
function isVagueTopic(t) {
  // 「个」收进字符类：虚词切割会把「这个以后看」残留成「个以后看」这类粘着串
  return VAGUE_TOPICS.has(t) || /^[一下以后再看收藏备用整理先手个]+$/u.test(t);
}

// 内置兜底规则：只在融合层沉默时出场（比 v0.5 再砍半，防抢戏）
const HEURISTICS_STRONG = [
  { re: /(论文|arxiv|期刊|实验报告|transformer|embedding|模型训练|微调|推理加速)/i, cat: '技术研究' },
  { re: /(教程|课程|tutorial|入门|实战|手把手|学习路线)/i, cat: '教程课程' },
  { re: /(白皮书|市场预测|增速|产业链|market share|行业格局)/i, cat: '行业报告' },
  { re: /(prd|原型稿|交互稿|用户体验地图|figma 稿)/i, cat: '产品设计' },
  { re: /(商业模式|融资|定价策略|增长黑客|变现)/i, cat: '商业思考' },
  { re: /(workflow|自动化脚本|智能体|效率工具|插件开发)/i, cat: '工具效率' },
  { re: /(历史|哲学|心理|社会学|传记|人类学)/i, cat: '人文视野' },
];

// ---------- 画像持久化（IDF 余弦版） ----------
class CategoryProfile {
  constructor(file) {
    this.file = file;
    // { categories: { 名: { terms: {词:权重}, count:N, created_at } }, version: 1 }
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = { categories: {}, version: 1 }; }
    if (!this.data.categories) this.data = { categories: {}, version: 1 };
  }
  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch {}
  }
  cat(name) {
    if (!this.data.categories[name]) this.data.categories[name] = { terms: {}, count: 0, created_at: Date.now() };
    return this.data.categories[name];
  }
  // 用已确认的条目喂画像（分类确认/改分类时调用）
  learn(category, text, { weight = 2 } = {}) {
    if (!category || category === '未分类') return;
    const c = this.cat(category);
    const terms = matchTerms(text, 20);
    for (const t of terms) c.terms[t] = (c.terms[t] || 0) + weight;
    c.count += 1;
    // 画像瘦身：每类最多存 300 词
    const keys = Object.keys(c.terms);
    if (keys.length > 300) {
      keys.sort((a, b) => c.terms[b] - c.terms[a]);
      for (const k of keys.slice(300)) delete c.terms[k];
    }
    this.save();
  }
  removeCategory(name) {
    delete this.data.categories[name];
    this.save();
  }

  // 有效类目（count 达标）数与词文档频率 df：IDF 的原料
  _dfStats() {
    const df = Object.create(null);
    let n = 0;
    for (const c of Object.values(this.data.categories)) {
      if (!c || c.count < MIN_PROFILE_COUNT) continue;
      n += 1;
      for (const t of Object.keys(c.terms || {})) df[t] = (df[t] || 0) + 1;
    }
    return { df, n };
  }

  // 条目文本与各类画像的相似度：IDF 加权覆盖率 ∈ (0,1]，按分降序
  // score = Σ_hit √画像词权·idf / √(Σ_q idf²) —— 查询 IDF 质量被该类目解释的比例
  // 返回 [{category, score, cos(=score，兼容旧消费方), _topics(命中的区分词)}]
  scores(text) {
    const qTerms = matchTerms(text, 30);
    if (!qTerms.length) return [];
    const { df, n } = this._dfStats();
    if (!n) return [];
    const idfOf = (t) => Math.log(1 + n / (df[t] || 1));
    const qSet = new Set(qTerms);
    let normQ2 = 0;
    const qIdf = Object.create(null);
    for (const t of qSet) { qIdf[t] = idfOf(t); normQ2 += qIdf[t] * qIdf[t]; }
    const normQ = Math.sqrt(normQ2) || 1;
    const out = [];
    for (const [name, c] of Object.entries(this.data.categories)) {
      if (!c || c.count < MIN_PROFILE_COUNT) continue; // 冷启动保护
      let dot = 0;
      const hits = [];
      for (const [t, rawW] of Object.entries(c.terms || {})) {
        if (!qSet.has(t)) continue;
        dot += Math.sqrt(rawW) * qIdf[t];
        if (hits.length < 10) hits.push(t);
      }
      if (dot <= 0) continue;
      const score = Math.min(1, dot / normQ);
      out.push({ category: name, score, cos: score, _topics: hits });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
}

// 主题词与词表的「包含式」命中：分镜设计↔分镜、蕨类植物↔蕨类 都算接住
function topicMatches(topicSet, words) {
  for (const t of topicSet) {
    for (const w of words) {
      if (t.includes(w) || w.includes(t)) return true;
    }
  }
  return false;
}

// ---------- 归类决策：多信号融合 ----------
// rules: TaxonomyRules 实例（可空 → 无规则层，纯画像+兜底）
// 返回 { category, tags, summary, confidence, source, suggestNew?, debug }
function decide({ profile, rules, text, notes, title, kind }) {
  const blob = ((title || '') + '\n' + (notes || '') + '\n' + (text || '')).slice(0, 6000);
  const fields = { title: String(title || ''), notes: String(notes || ''), body: String(text || '').slice(0, 4000) };

  // ① 用户阐述优先：有效阐述（≥8 字且含实义主题词）定向归类或触发建类建议
  const notesHasWords = String(notes || '').trim().length >= NOTES_MIN_CHARS;
  const topics = (notesHasWords ? topTerms(notes || '', 6) : []).filter(t => !isVagueTopic(t));
  if (topics.length) {
    const topicSet = new Set(topics);
    // a) 阐述主题命中某类画像主题词 → 按画像定向（老用户养出的类目最可信）
    const psPre = profile ? profile.scores(blob) : [];
    const hitProfile = psPre.find(p => topicMatches(topicSet, p._topics || []));
    if (hitProfile) {
      return { category: hitProfile.category, tags: topics.slice(0, 3), summary: '', confidence: 0.72, source: 'profile-notes' };
    }
    // b) 阐述主题命中某类自定义关键词 → 按规则定向（显式配置 = 直接意图）
    const rsPre = rules ? rules.score(fields) : [];
    const hitRule = rsPre.find(r => topicMatches(topicSet, r.hits || []));
    if (hitRule) {
      return { category: hitRule.category, tags: topics.slice(0, 3), summary: '', confidence: 0.68, source: 'rule-notes' };
    }
    // c) 全都接不住 → 建类建议（topTerms 已滤停用词/虚词，泛化阐述到不了这里）
    const strong = topics[0];
    const label = String(strong).slice(0, 6);
    return {
      category: FALLBACK_CAT, tags: topics.slice(0, 3), summary: '',
      confidence: 0.25, source: 'none',
      suggestNew: { name: label, reason: `你的阐述里反复出现「${strong}」，现有分类和关键词都接不住`, topic: strong },
      debug: { topics, rule: rsPre[0] || null, profile: psPre[0] || null },
    };
  }

  // ② 规则 × 画像融合：两路信号各自归一后加权
  const rs = rules ? rules.score(fields) : [];
  const ps = profile ? profile.scores(blob) : [];
  const fused = new Map();
  const put = (cat, w, part, extra) => {
    const cur = fused.get(cat) || { category: cat, fused: 0, rule: 0, cos: 0, hits: [] };
    cur[part] = extra;
    cur.fused += w;
    if (extra && extra.hits) cur.hits = [...new Set([...cur.hits, ...extra.hits])].slice(0, 8);
    fused.set(cat, cur);
  };
  for (const r of rs) put(r.category, W_RULE * r.norm, 'rule', r);
  for (const p of ps) put(p.category, W_PROFILE * p.cos, 'cos', p);
  const ranked = [...fused.values()].sort((a, b) => b.fused - a.fused);
  const top1 = ranked[0];
  const top2 = ranked[1];
  const titleTopics = topTerms(title || '', 3);

  if (top1) {
    const margin = top1.fused - (top2 ? top2.fused : 0);
    if (top1.fused >= ADOPT_NORM && margin >= MIN_MARGIN) {
      return {
        category: top1.category, tags: titleTopics.length ? titleTopics : (top1.hits || []).slice(0, 3), summary: '',
        confidence: Math.min(0.95, 0.35 + 0.5 * top1.fused + 0.3 * margin),
        source: rs.length && rs[0].category === top1.category ? 'rule-fused' : 'profile-fused',
        debug: { fused: top1.fused, margin, rule: top1.rule, profile: top1.cos, hits: top1.hits },
      };
    }
    if (top1.fused >= MID_NORM) {
      return {
        category: top1.category, tags: titleTopics.length ? titleTopics : (top1.hits || []).slice(0, 3), summary: '',
        confidence: Math.max(0.3, Math.min(0.55, 0.3 + 0.4 * top1.fused)),
        source: 'fused-mid',
        debug: { fused: top1.fused, margin, rule: top1.rule, profile: top1.cos, hits: top1.hits },
      };
    }
  }

  // ③ 内置兜底规则（融合沉默时才出场）
  for (const h of HEURISTICS_STRONG) if (h.re.test(blob)) {
    return { category: h.cat, tags: titleTopics, summary: '', confidence: 0.4, source: 'rule-fallback' };
  }
  // ④ 兜底类
  return {
    category: FALLBACK_CAT, tags: titleTopics, summary: '', confidence: 0.15, source: 'fallback',
    debug: { rule: rs[0] || null, profile: ps[0] || null },
  };
}

module.exports = {
  BASE_CATEGORIES, FALLBACK_CAT, HEURISTICS_STRONG, CategoryProfile, decide,
  W_RULE, W_PROFILE, ADOPT_NORM, MIN_MARGIN, MID_NORM, MIN_PROFILE_COUNT, NOTES_MIN_CHARS,
};
