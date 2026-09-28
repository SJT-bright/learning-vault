/**
 * 自定义分类规则 — 关键词划分的存储、默认集与打分（纯 Node、零依赖、selfcheck 可直测）
 *
 * 数据模型：{ [分类名]: { keywords: { 词: 权重 } } }，存 DATA_DIR/category-rules.json
 * 关键词权重语义（用户可配 1~5）：
 *   1 泛词（ mentions 即轻提示） 2 相关  3 强信号  4 专属词  5 决定性词
 *
 * 打分模型（taxonomy-rules.score）：
 *   字段权重：标题 3 / 阐述 2.5 / 正文 1   —— 标题是作者意图最强的显式信号
 *   词命中分 = kw权重 × 字段权重 × min(出现次数, 3)   （次数饱和：重复刷词不线性放大）
 *   总分饱和 norm = s / (12 + s) ∈ (0,1)           （反商函数：一条 4 权词标题命中≈0.5，
 *     两个类目同分时仍可区分，长文档多词命中也不会碾压到 1）
 *
 * 兜底内置默认规则集覆盖 8 大类；用户编辑后整组覆盖默认（用户数据优先，永不覆盖回写）。
 */
const fs = require('fs');

// 字段权重：与 index-engine 的分层思想一致，但阐述略低于标题（用户随手写≠精心标题）
const FIELD_WEIGHTS = [['title', 3], ['notes', 2.5], ['body', 1]];
const COUNT_CAP = 3;      // 单词单字段计次上限
const SATURATION_K = 12;  // 反商饱和常数：norm = s/(K+s)，K=12 ⇒ 一条决定性词标题命中(15分)≈0.55

// 内置默认规则集：精选强信号词，宁缺勿滥（泛词留给画像层用统计区分）
const DEFAULT_RULES = {
  '技术研究': { keywords: { '论文': 4, 'arxiv': 5, '期刊': 3, '模型训练': 4, '微调': 4, 'fine-tune': 4, 'transformer': 4, 'embedding': 4, '推理加速': 4, '实验报告': 4, '基准测试': 3, 'rlhf': 5, '消融实验': 5 } },
  '教程课程': { keywords: { '教程': 4, '课程': 4, '实战': 3, '入门': 3, '手把手': 5, '学习路线': 4, '速成': 4, '案例实操': 4, 'step by step': 4, '从零开始': 4 } },
  '行业报告': { keywords: { '白皮书': 5, '行业报告': 5, '市场规模': 4, '产业链': 4, '增速': 3, '调研报告': 4, '竞品分析': 3, 'market share': 4, '行业格局': 4, 'forecast': 3 } },
  '产品设计': { keywords: { 'prd': 5, '原型稿': 5, '交互稿': 5, '需求文档': 5, '用户体验地图': 5, 'figma': 4, '可用性测试': 4, '信息架构': 4, '设计规范': 3, 'wireframe': 4 } },
  '商业思考': { keywords: { '商业模式': 5, '融资': 4, '变现': 4, '定价策略': 5, '增长黑客': 5, '护城河': 4, '单位经济模型': 5, '营收': 3, '创业': 3, 'roi': 2 } },
  '工具效率': { keywords: { '工作流': 4, 'workflow': 4, '自动化脚本': 5, '效率工具': 5, '插件开发': 4, '快捷键': 3, '清单模板': 3, '效率翻倍': 4, '自动化流程': 4 } },
  '人文视野': { keywords: { '哲学': 5, '人类学': 5, '社会学': 4, '心理学史': 4, '传记': 4, '思想史': 5, '历史研究': 4, '文明': 3, '文艺复兴': 4 } },
  '资料收藏': { keywords: {} },
};

function normalizeKeywords(input) {
  const out = {};
  for (const [w, wt] of Object.entries(input || {})) {
    const word = String(w).trim().toLowerCase();
    if (!word || word.length > 30) continue;
    out[word] = Math.max(1, Math.min(5, Math.round(Number(wt) || 1)));
  }
  return out;
}

class TaxonomyRules {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) this.data = {};
    // 合并默认集：用户已有该分类 → 保留其关键词并补默认缺失词；无 → 整组采用默认
    for (const [cat, rule] of Object.entries(DEFAULT_RULES)) {
      if (!this.data[cat] || typeof this.data[cat] !== 'object') {
        this.data[cat] = { keywords: { ...rule.keywords } };
      } else if (!this.data[cat].keywords || typeof this.data[cat].keywords !== 'object') {
        this.data[cat].keywords = { ...rule.keywords };
      }
    }
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch {} }

  ensure(cat) {
    if (!this.data[cat] || typeof this.data[cat] !== 'object') this.data[cat] = { keywords: {} };
    if (!this.data[cat].keywords || typeof this.data[cat].keywords !== 'object') this.data[cat].keywords = {};
    return this.data[cat];
  }
  get(cat) { return this.ensure(cat).keywords; }
  all() { return this.data; }

  // 覆盖某分类的关键词组（整组替换；词长≤30、权重 clamp 1~5）
  setKeywords(cat, keywords) {
    const r = this.ensure(cat);
    r.keywords = normalizeKeywords(keywords);
    this.save();
    return r.keywords;
  }
  // 追加/更新单个词（UI 单词添加走这里）
  upsertKeyword(cat, word, weight) {
    const r = this.ensure(cat);
    const norm = normalizeKeywords({ [word]: weight });
    if (!Object.keys(norm).length) return r.keywords;
    Object.assign(r.keywords, norm);
    this.save();
    return r.keywords;
  }
  removeKeyword(cat, word) {
    const r = this.ensure(cat);
    delete r.keywords[String(word).trim().toLowerCase()];
    this.save();
    return r.keywords;
  }
  removeCategory(cat) { delete this.data[cat]; this.save(); }
  renameCategory(oldName, newName) {
    if (this.data[oldName]) { this.data[newName] = this.data[oldName]; delete this.data[oldName]; this.save(); }
  }

  // 规则打分：fields = { title, notes, body }；返回按分降序的 [{category, score, norm, hits}]
  // 只要有任一分类配了词即参与；命中为空的分类不打分（避免空规则类吸走置信度）
  score(fields) {
    const out = [];
    for (const [cat, rule] of Object.entries(this.data)) {
      const entries = Object.entries(rule.keywords || {});
      if (!entries.length) continue;
      let s = 0;
      const hits = [];
      for (const [word, wkw] of entries) {
        for (const [fname, fw] of FIELD_WEIGHTS) {
          const text = String(fields[fname] || '').toLowerCase();
          if (!text) continue;
          const pos = text.indexOf(word);
          if (pos < 0) continue;
          const count = Math.min(COUNT_CAP, text.split(word).length - 1);
          s += wkw * fw * count;
          hits.push(word);
          break; // 一词只按最高价值字段计一次（标题命中就不再看正文）
        }
      }
      if (s > 0) out.push({ category: cat, score: s, norm: s / (SATURATION_K + s), hits: [...new Set(hits)].slice(0, 8) });
    }
    out.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category, 'zh'));
    return out;
  }
}

module.exports = { TaxonomyRules, DEFAULT_RULES, FIELD_WEIGHTS, COUNT_CAP, SATURATION_K, normalizeKeywords };
