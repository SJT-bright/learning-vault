/**
 * 归类：优先 LLM（OpenAI 兼容接口），失败降级为关键词启发式
 */
const { requestChat } = require('./ai-client');
const CATEGORIES = ['技术研究', '教程课程', '行业报告', '产品设计', '商业思考', '工具效率', '人文视野', '资料收藏'];

const HEURISTICS = [
  { re: /(论文|arxiv|paper|期刊|研究|实验|模型|算法|训练|推理|transformer|embedding)/i, cat: '技术研究' },
  { re: /(教程|课程|tutorial|guide|入门|实战|手把手|how to|学习路线)/i, cat: '教程课程' },
  { re: /(行业|报告|趋势|白皮书|market|insight|调研|forecast|规模|增速)/i, cat: '行业报告' },
  { re: /(产品|需求|prd|设计|ux|交互|原型|用户体验|figma)/i, cat: '产品设计' },
  { re: /(商业|创业|增长|变现|商业模式|融资|定价|营收)/i, cat: '商业思考' },
  { re: /(工具|效率|workflow|自动化|智能体|agent|插件|软件|accelerate)/i, cat: '工具效率' },
  { re: /(历史|哲学|心理|社会|文化|经济|传记|essay)/i, cat: '人文视野' },
];

function heuristicClassify(text, notes) {
  const s = ((text || '') + ' ' + (notes || '')).slice(0, 4000);
  for (const h of HEURISTICS) if (h.re.test(s)) return { category: h.cat, tags: [], summary: '' };
  return { category: '资料收藏', tags: [], summary: '' };
}

function clip(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) : s; }

async function classifyWithLLM(cfg, { title, text, notes, kind, site }) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base || !cfg.apiKey) throw new Error('未配置 API');
  const body = {
    model: cfg.model || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: '你是个人学习资料管理助手。根据资料判断分类并打标签。只输出 JSON。' },
      {
        role: 'user',
        content:
          `分类必须从这个列表选一个：${CATEGORIES.join('、')}\n` +
          `打 2-4 个具体主题标签（中文，每个不超过6字，如 "RAG"、"团队管理"、"光伏储能"）。\n` +
          `用不超过80字概括这条资料讲了什么、为什么值得收藏。\n` +
          `只输出 JSON：{"category":"...","tags":["..."],"summary":"..."}\n\n` +
          `类型: ${kind}\n来源: ${site || '-'}\n标题: ${clip(title, 120)}\n附言: ${clip(notes, 300)}\n正文: ${clip(text, 3500)}`,
      },
    ],
  };
    let raw = await requestChat(cfg, body, { timeoutMs: 30000 });
    raw = raw.replace(/```json|```/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM 返回无法解析');
    const obj = JSON.parse(m[0]);
    let category = CATEGORIES.includes(obj.category) ? obj.category : '资料收藏';
    let tags = Array.isArray(obj.tags) ? obj.tags.map(t => String(t).slice(0, 12)).filter(Boolean).slice(0, 4) : [];
    let summary = clip(obj.summary, 200);
    return { category, tags, summary };
}

async function classify(cfg, payload) {
  try {
    const r = await classifyWithLLM(cfg, payload);
    return { ...r, source: 'ai' };
  } catch (e) {
    const r = heuristicClassify(payload.text, payload.notes);
    return { ...r, source: 'heuristic', error: String(e && e.message ? e.message : e) };
  }
}

module.exports = { classify, heuristicClassify, CATEGORIES };
