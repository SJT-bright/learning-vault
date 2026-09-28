/**
 * 复盘生成：优先 LLM，失败降级为统计模板（启发式）
 *
 * 启发式路径输出 5 段钩子式结构：
 *   📈 收录脉搏 → 🎖️ 积累坐标 → 🗂️ 学了什么 → 🔍 模式观察 → 🎯 下一步
 * stats 契约（main.js 注入，字段可能缺失，全部容错）：
 *   { byKind:{url,file,chat,note}, total, weekCount, prevWeekCount,
 *     streak, bestStreak, title, level, nextMilestone:{kind,target,progress},
 *     justMilestones:[...] }
 * 任何数字缺失 → 显示 '—' 或整行/整段跳过，绝不抛错。
 */

function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }

// 精简条目（给 LLM 的 payload 不能带全文，否则被截断后只剩第一条）
function itemsBrief(items, max = 30) {
  return (items || []).slice(0, max).map(i => ({
    标题: clip(i.title, 60),
    分类: i.category,
    标签: i.tags || [],
    类型: i.kind,
    附言: clip(i.notes, 100),
    摘要: clip(i.summary, 100),
  }));
}

// ---------- 容错读取 ----------
function numOf(v, dflt = null) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
function strOf(v, dflt = '') { const s = String(v == null ? '' : v).trim(); return s || dflt; }
function safeStats(payload) {
  const s = payload && payload.stats;
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
}
function safeItems(payload) {
  const arr = payload && Array.isArray(payload.items) ? payload.items : [];
  return arr.filter(x => x && typeof x === 'object');
}
function countBy(arr, fn) {
  const m = {};
  for (const x of arr) { const k = fn(x); if (k != null) m[k] = (m[k] || 0) + 1; }
  return m;
}
const KIND_ZH = [['url', '链接'], ['file', '文件'], ['video', '视频'], ['image', '图片'], ['chat', '聊天'], ['note', '笔记'], ['bundle', '文件包']];
function byKindParts(stats, sep) {
  const bk = (stats.byKind && typeof stats.byKind === 'object') ? stats.byKind : null;
  if (!bk) return null;
  const parts = KIND_ZH.map(([k, zh]) => { const n = numOf(bk[k]); return n != null ? `${zh}${sep}${n}` : null; }).filter(Boolean);
  return parts.length ? parts : null;
}

// ---------- 标题 / 模式 ----------
const { outcomesMarkdown } = require('./outcomes');

const MODE_TITLES = {
  daily: '今日知识资产盘点',
  cycle: '知识积累复盘',
  weekly: '本周成果复盘',
  monthly: '本月知识资产盘点',
};
function labelToMode(label) {
  const l = strOf(label);
  if (l === '本月') return 'monthly';
  if (l === '本周') return 'weekly';
  if (l === '今日') return 'daily';
  if (/^近\d+天$/.test(l)) return 'cycle';
  return '';
}
function titleFor(payload) {
  const mode = strOf(payload && payload.mode) || labelToMode(payload && payload.label);
  if (MODE_TITLES[mode]) return MODE_TITLES[mode];
  const label = strOf(payload && payload.label);
  return label ? `${label}知识资产盘点` : '知识资产盘点';
}

// ---------- 启发式各段 ----------
function pulseLines(items, stats, count) {
  const lines = [];
  lines.push(`- 本期录入 ${count != null ? count : '—'} 条`);
  const w = numOf(stats.weekCount), p = numOf(stats.prevWeekCount);
  if (w != null && p != null) {
    const d = w - p;
    const delta = d > 0 ? `较上周 +${d} 条 ↑` : d < 0 ? `较上周 ${d} 条 ↓` : '与上周持平 →';
    lines.push(`- 本周 ${w} 条 vs 上周 ${p} 条，${delta}`);
  } else if (w != null) {
    lines.push(`- 本周 ${w} 条`);
  }
  const st = numOf(stats.streak), bs = numOf(stats.bestStreak);
  if (st != null && st > 0) {
    lines.push(`- 连续记录 ${st} 天` + (bs != null && bs > 0 ? ` · 历史纪录 ${bs} 天` : ''));
  } else if (bs != null && bs > 0) {
    lines.push(`- 历史纪录 ${bs} 天，连续记录等你自己续上`);
  }
  return lines;
}

function coordLines(stats) {
  const lines = [];
  const title = strOf(stats.title);
  if (title) {
    const lv = numOf(stats.level);
    lines.push(`- 当前称号：${title}` + (lv != null ? `（Lv.${lv}）` : ''));
  }
  const jm = Array.isArray(stats.justMilestones)
    ? stats.justMilestones.map(x => strOf(x)).filter(Boolean) : [];
  if (jm.length) lines.push(`- 🎉 本期达成：${jm.join('、')}`);
  const nm = stats.nextMilestone;
  if (nm && typeof nm === 'object') {
    const t = numOf(nm.target);
    const unit = String(nm.kind || '').includes('streak') ? '天' : '条';
    // progress 为 0~1 进度比例；>1 时兼容旧调用直传绝对值
    const prRatio = numOf(nm.progress);
    const done = prRatio != null ? (prRatio > 1 ? Math.round(prRatio) : Math.round(t * prRatio)) : null;
    if (t != null && done != null) {
      lines.push(`- 距下一个里程碑还差 ${Math.max(0, t - done)} ${unit}（${done} / ${t}）`);
    } else if (t != null) {
      lines.push(`- 下一里程碑目标：${t} ${unit}`);
    }
  }
  return lines;
}

function learnLines(items) {
  if (!items.length) return [];
  const byCat = {};
  for (const i of items) {
    const c = strOf(i.category, '未分类');
    (byCat[c] = byCat[c] || []).push(i);
  }
  return Object.entries(byCat)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, arr]) => {
      const names = arr.slice(0, 4).map(i => clip(i.title, 40)).filter(Boolean).map(t => `《${t}》`).join('、');
      return `- ${cat} ${arr.length} 条${names ? '：' + names : ''}${names && arr.length > 4 ? ' 等' : ''}`;
    });
}

// 一句数据驱动的洞察，按优先级取第一条命中
function oneInsight(items, stats) {
  const st = numOf(stats.streak), bs = numOf(stats.bestStreak);
  const w = numOf(stats.weekCount), p = numOf(stats.prevWeekCount);
  if (st != null && st >= 3) {
    if (bs != null && bs > st) return `连续 ${st} 天了，再守 ${bs + 1 - st} 天就能刷新历史纪录。`;
    if (bs != null && bs === st) return `已追平历史纪录 ${bs} 天，再守 1 天就是新巅峰。`;
    return `连续 ${st} 天没断，节奏已经长在身上了。`;
  }
  if (w != null && w === 0) {
    return (p != null && p > 0) ? `本周还没进新料（上周 ${p} 条），今天收 1 条就能重启节奏。` : '本周还没进新料，该补料了。';
  }
  const bk = (stats.byKind && typeof stats.byKind === 'object') ? stats.byKind : null;
  if (bk) {
    const sum = KIND_ZH.reduce((a, [k]) => a + (numOf(bk[k], 0) || 0), 0);
    const heavy = (numOf(bk.chat, 0) || 0) + (numOf(bk.file, 0) || 0);
    if (sum >= 3 && heavy / sum >= 0.5) {
      return `聊天与文件是你目前的主力渠道（占 ${Math.round(heavy / sum * 100)}%），记得把关键结论转成自己的笔记。`;
    }
  }
  const byCat = countBy(items, i => strOf(i.category, '未分类'));
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  if (top && items.length >= 3 && top[1] / items.length >= 0.6) {
    return `最近明显在聚焦「${top[0]}」，趁热把这个方向啃透。`;
  }
  if (items.length >= 3 && !items.some(i => strOf(i.notes))) {
    return '本期还没有一条自己的附言，看完写两句，资产才算真的开始增值。';
  }
  return '';
}

function observeLines(items, stats) {
  const lines = [];
  const tot = numOf(stats.total);
  if (tot != null) lines.push(`- 资产库累计 ${tot} 条`);
  const top = Object.entries(countBy(items, i => strOf(i.category, '未分类')))
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (items.length && top.length) {
    lines.push('- 本期最密集的方向：' + top.map(([c, n]) => `${c}(${n})`).join('、'));
  }
  const parts = byKindParts(stats, ' ');
  if (parts) lines.push(`- 渠道构成：${parts.join(' · ')}`);
  const insight = oneInsight(items, stats);
  if (insight) lines.push(`- ${insight}`);
  return lines;
}

function nextLines(items) {
  if (!items.length) return [];
  const ACTION = {
    url: '打开通读一遍，摘 1 条金句',
    file: '安排一个专注段读完，写 3 行总结',
    chat: '把关键结论转成一条笔记',
    note: '回看一遍，补上此刻的新想法',
    bundle: '拆开逐条检查，标记已消化的',
  };
  const rank = i => (i.notes ? 2 : 0) + (Array.isArray(i.tags) && i.tags.length ? 1 : 0) + (i.summary ? 1 : 0);
  const picks = [...items].sort((a, b) => rank(b) - rank(a)).slice(0, 3);
  return picks.map(i =>
    `- 《${clip(i.title, 40) || '未命名条目'}》→ ${ACTION[i.kind] || '安排时间消化，读完写一句总结'}`);
}

function buildStatic(payload) {
  const items = safeItems(payload);
  const stats = safeStats(payload);
  if(payload.outcomes) return '# '+titleFor(payload)+'\n\n'+outcomesMarkdown(payload.outcomes);
  // items 数组存在就以它为准（哪怕为 0）；完全没有 items 才借 stats.total
  const count = (payload && Array.isArray(payload.items)) ? items.length : numOf(stats.total);

  const secs = [];
  const pulse = pulseLines(items, stats, count);
  if (pulse.length) secs.push([payload && payload.outcomes ? '📥 本周新收录' : '📈 收录脉搏', pulse]);
  const coord = coordLines(stats);
  if (coord.length) secs.push(['🎖️ 积累坐标', coord]);
  const learn = learnLines(items);
  if (learn.length) secs.push(['🗂️ 学了什么', learn]);
  const obs = observeLines(items, stats);
  if (obs.length) secs.push(['🔍 模式观察', obs]);
  const next = nextLines(items);
  if (next.length) secs.push(['🎯 下一步', next]);

  const body = secs.map(([h, ls]) => `## ${h}\n${ls.join('\n')}`).join('\n\n');
  const head = (payload && payload.outcomes) ? outcomesMarkdown(payload.outcomes) + '\n\n' : '';
  return `# ${titleFor(payload)}\n\n${head}${body ? body + '\n\n' : ''}（提示：配置 LLM API Key 后，复盘更有洞察。）`;
}

// 兜底：理论上 buildStatic 不会抛，但复盘生成绝不能让主流程失败
function fallbackMinimal(payload) {
  const items = safeItems(payload);
  const lines = [`本期共录入 ${items.length} 条资料。`];
  for (const [cat, arr] of Object.entries(countBy(items, i => strOf(i.category, '未分类')))) {
    lines.push(`【${cat}】${arr.length} 条：` + arr.slice(0, 4).map(i => `《${clip(i.title, 40)}》`).join('、') + (arr.length > 4 ? ' 等' : ''));
  }
  return `# ${titleFor(payload)}\n\n${lines.join('\n')}`;
}

function staticReview(payload) {
  try {
    return buildStatic(payload);
  } catch {
    return fallbackMinimal(payload);
  }
}

// ---------- 画像成长（可选段：周报/月报） ----------
// payload.profileGrowth 由 main.js 组装传入：{ isFirst, cats:[{ name, added:[词...] }] }
// 不传该字段时报告不出现此段（向后兼容，旧调用零变化）
function growthSection(pg) {
  try {
    if (!pg || typeof pg !== 'object') return '';
    if (pg.isFirst) return '## 📚 画像成长\n已开始记录画像成长，下周见分晓';
    const norm = (Array.isArray(pg.cats) ? pg.cats : [])
      .filter(c => c && strOf(c.name))
      .map(c => ({ name: strOf(c.name), added: (Array.isArray(c.added) ? c.added : []).filter(Boolean).slice(0, 5) }));
    if (!norm.length) return '';
    if (!norm.some(c => c.added.length)) return '## 📚 画像成长\n画像平稳';
    // 稳定排序：有新增的分类排前
    const ordered = [...norm].sort((a, b) => b.added.length - a.added.length);
    const lines = ordered.map(c => c.added.length
      ? `- 『${c.name}』新增 ${c.added.length} 个主题词（${c.added.join('、')}）`
      : `- 『${c.name}』无变化`);
    return `## 📚 画像成长\n${lines.join('\n')}`;
  } catch { return ''; }
}

// ---------- AI 路径 ----------
const SYSTEM = '你是学习复盘助手，语气克制、具体。只根据用户给出的事实写中文复盘，不得把「收藏了」「打开过」「AI 生成了摘要」写成学会了或完成了成果。若提供了本周成果（使用记录、改进、已落实点子），优先写这些；新收录数量可以提及但不是核心。推荐重新打开的条目必须使用给出的理由，不足 3 条就写实际数量，不要凑数。没有事实时如实写空。不要编造数字。不要客套开头结尾。';

function statsFacts(payload) {
  const stats = safeStats(payload);
  const f = [];
  const w = numOf(stats.weekCount), p = numOf(stats.prevWeekCount);
  if (w != null && p != null) {
    const d = w - p;
    f.push(d > 0 ? `本周收录 ${w} 条 vs 上周 ${p} 条（环比 +${d} 条）`
      : d < 0 ? `本周收录 ${w} 条 vs 上周 ${p} 条（环比 ${d} 条）`
      : `本周收录 ${w} 条，与上周持平`);
  } else if (w != null) {
    f.push(`本周收录 ${w} 条`);
  }
  const st = numOf(stats.streak), bs = numOf(stats.bestStreak);
  if (st != null) f.push(`连续记录 ${st} 天` + (bs != null ? `，历史纪录 ${bs} 天` : ''));
  const title = strOf(stats.title);
  if (title) f.push(`当前称号：${title}` + (numOf(stats.level) != null ? `（Lv.${stats.level}）` : ''));
  const jm = Array.isArray(stats.justMilestones)
    ? stats.justMilestones.map(x => strOf(x)).filter(Boolean) : [];
  if (jm.length) f.push(`本期刚达成的成就：${jm.join('、')}（请用一句话庆祝）`);
  const nm = stats.nextMilestone;
  if (nm && typeof nm === 'object') {
    const t = numOf(nm.target);
    const unit = String(nm.kind || '').includes('streak') ? '天' : '条';
    // progress 是 0~1 的进度比例；部分旧调用可能直传绝对值，>1 时按绝对值处理
    const prRatio = numOf(nm.progress);
    const done = prRatio != null ? (prRatio > 1 ? Math.round(prRatio) : Math.round(t * prRatio)) : null;
    if (t != null && done != null) f.push(`下一里程碑：还差 ${Math.max(0, t - done)} ${unit}（当前 ${done}/${t}）`);
    else if (t != null) f.push(`下一里程碑目标：${t} ${unit}`);
  }
  const tot = numOf(stats.total);
  if (tot != null) f.push(`资产库累计 ${tot} 条`);
  const parts = byKindParts(stats, '');
  if (parts) f.push(`渠道构成：${parts.join(' / ')}`);
  return f.length ? f.map(x => '- ' + x).join('\n') : '';
}

const { requestChat } = require('./ai-client');
async function generateReview(cfg, payload) {
  payload = payload || {};
  // 画像成长段（可选）：main.js 只在周报/月报传入 profileGrowth；不传则本段不出现
  const growthTail = growthSection(payload.profileGrowth);
  const withGrowth = (text) => (growthTail ? `${text}\n\n${growthTail}` : text);
  const base = ((cfg && cfg.baseUrl) || '').replace(/\/+$/, '');
  if (base && cfg.apiKey) {
    try {
      const facts = statsFacts(payload);
      const body = JSON.stringify({
        label: strOf(payload.label) || '本期',
        statsFacts: facts || '（本期暂无统计数字，只根据条目内容写）',
        stats: payload.stats,
        items: itemsBrief(payload.items, 30),
        outcomes: payload.outcomes ? outcomesMarkdown(payload.outcomes) : undefined,
      });
      const txt = await requestChat(cfg, {
          model: cfg.model || 'gpt-4o-mini',
          temperature: 0.4,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: body },
          ],
      });
      if (txt.trim()) return { text: withGrowth(`# ${titleFor(payload)}\n\n${txt.trim()}`), source: 'ai' };
      throw new Error('LLM 返回为空');
    } catch (e) {
      return { text: withGrowth(staticReview(payload)), source: 'static', error: String(e && e.message ? e.message : e) };
    }
  }
  return { text: withGrowth(staticReview(payload)), source: 'static' };
}

module.exports = { generateReview, itemsBrief };
