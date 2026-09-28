/**
 * 积累统计引擎 — 纯函数、零依赖
 *
 * computeStats({ items, quotes, dailyCounts }) →
 * { total, quotes, weekCount, prevWeekCount, streak, bestStreak,
 *   title, level, nextMilestone, badges, byKind }
 *
 * - items:  有效条目数组（有 created_at 时间戳，可能有 kind: 'url'|'file'|'chat'|'note'）
 * - quotes: 金句数组
 * - dailyCounts: { 'YYYY-MM-DD': 当天录入条数 }，与 main.js localDayKey 同键规则；
 *   需覆盖全历史才能算出 bestStreak
 * - 数据为空不崩：total 0 → streak 0、title '初窥门径'、nextMilestone { items, 10, 0 }
 */

// ---------- 称号等级（按累计条数） ----------
const LEVELS = [
  { min: 0, title: '初窥门径' },
  { min: 10, title: '小有所成' },
  { min: 30, title: '学而有瘾' },
  { min: 60, title: '藏书之家' },
  { min: 120, title: '博览群书' },
  { min: 300, title: '学识渊博' },
  { min: 600, title: '知识富豪' },
];

// ---------- 里程碑（跨过时用于通知文案；主进程比对用） ----------
const MILESTONES = [
  { kind: 'items', target: 10, label: '集腋成裘', icon: '🌱' },
  { kind: 'items', target: 25, label: '循序渐进', icon: '📈' },
  { kind: 'items', target: 50, label: '藏书半架', icon: '📚' },
  { kind: 'items', target: 100, label: '百卷藏家', icon: '🏛️' },
  { kind: 'items', target: 200, label: '孜孜不倦', icon: '⏳' },
  { kind: 'items', target: 365, label: '日积月累', icon: '📆' },
  { kind: 'items', target: 500, label: '资产大亨', icon: '💎' },
  { kind: 'items', target: 1000, label: '学海无涯', icon: '🌊' },
  { kind: 'quotes', target: 10, label: '妙语拾遗', icon: '✒️' },
  { kind: 'quotes', target: 25, label: '妙笔生花', icon: '🖋️' },
  { kind: 'quotes', target: 50, label: '金句藏家', icon: '📜' },
  { kind: 'quotes', target: 100, label: '落笔成章', icon: '📖' },
  { kind: 'streak', target: 3, label: '三日之约', icon: '🔥' },
  { kind: 'streak', target: 7, label: '七日不辍', icon: '⚡' },
  { kind: 'streak', target: 14, label: '半月之勤', icon: '🌙' },
  { kind: 'streak', target: 30, label: '三十而立', icon: '🏆' },
  { kind: 'streak', target: 100, label: '百日长征', icon: '🌟' },
];

const MS_TARGETS = MILESTONES.reduce((acc, m) => {
  (acc[m.kind] = acc[m.kind] || []).push(m.target); // 各类内保持升序
  return acc;
}, {});

const DAY_MS = 86400000;

// 与 main.js localDayKey 完全一致的本地日键规则
function dayKeyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 'YYYY-MM-DD' → 天序号（本地零点；跨夏令时用 round 归位）
function dayIndexOf(key) {
  const t = new Date(key + 'T00:00:00').getTime();
  return isNaN(t) ? null : Math.round(t / DAY_MS);
}

// ---------- streak ----------
// 今天有录入则含今天；今天还没有则算到昨天为止（当天未结束不算断签）
function computeStreaks(dailyCounts, now) {
  const days = new Set();
  for (const [k, v] of Object.entries(dailyCounts || {})) {
    if (!(Number(v) > 0)) continue;
    const idx = dayIndexOf(k);
    if (idx !== null) days.add(idx);
  }
  if (!days.size) return { streak: 0, bestStreak: 0 };
  const sorted = [...days].sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  const todayIdx = dayIndexOf(dayKeyOf(now));
  const anchor = days.has(todayIdx) ? todayIdx : todayIdx - 1;
  let streak = 0;
  if (days.has(anchor)) {
    let d = anchor;
    while (days.has(d)) { streak += 1; d -= 1; }
  }
  return { streak, bestStreak: best };
}

function levelIndexOf(total) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) if (total >= LEVELS[i].min) idx = i;
  return idx;
}

// ---------- 下一个里程碑 ----------
// 每类取第一个未达目标，选 progress 最高者（同进度按 items→quotes→streak 声明序，空数据即 items 10）
function nextMilestoneOf(cur) {
  const cands = [];
  for (const kind of ['items', 'quotes', 'streak']) {
    const target = (MS_TARGETS[kind] || []).find((t) => t > cur[kind]);
    if (target !== undefined) {
      cands.push({ kind, target, progress: Math.min(1, Math.max(0, cur[kind] / target)) });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.progress - a.progress); // V8 稳定排序，同进度保持插入序
  return cands[0];
}

// ---------- 成就徽章（earned 按数据实算；streak 徽章看历史最佳，断了不掉） ----------
function buildBadges({ total, quoteCount, bestStreak, byKind }) {
  return [
    { id: 'items-10', label: '集腋成裘', desc: '累计收录 10 条学习资产', icon: '🌱', earned: total >= 10 },
    { id: 'items-50', label: '藏书半架', desc: '累计收录 50 条学习资产', icon: '📚', earned: total >= 50 },
    { id: 'items-100', label: '百卷藏家', desc: '累计收录 100 条学习资产', icon: '🏛️', earned: total >= 100 },
    { id: 'items-500', label: '资产大亨', desc: '累计收录 500 条学习资产', icon: '💎', earned: total >= 500 },
    { id: 'streak-3', label: '三日之约', desc: '连续 3 天都有录入', icon: '🔥', earned: bestStreak >= 3 },
    { id: 'streak-7', label: '七日不辍', desc: '连续 7 天都有录入', icon: '⚡', earned: bestStreak >= 7 },
    { id: 'streak-30', label: '三十而立', desc: '连续 30 天都有录入', icon: '🏆', earned: bestStreak >= 30 },
    { id: 'streak-100', label: '百日长征', desc: '连续 100 天都有录入', icon: '🌟', earned: bestStreak >= 100 },
    { id: 'quotes-10', label: '妙语拾遗', desc: '收藏 10 条金句', icon: '✒️', earned: quoteCount >= 10 },
    { id: 'quotes-50', label: '金句藏家', desc: '收藏 50 条金句', icon: '📜', earned: quoteCount >= 50 },
    { id: 'all-kinds', label: '博采众长', desc: '网页、文件、聊天、笔记四种类型都收录过', icon: '🧭', earned: ['url', 'file', 'chat', 'note'].every((k) => (byKind[k] || 0) > 0) },
  ];
}

// ---------- 主入口 ----------
function computeStats({ items = [], quotes = [], dailyCounts = {} } = {}) {
  const now = new Date();
  const arr = (Array.isArray(items) ? items : []).filter((i) => i && typeof i.created_at === 'number');
  const quoteArr = Array.isArray(quotes) ? quotes : [];
  const total = arr.length;
  const quoteCount = quoteArr.length;

  const byKind = { url: 0, file: 0, chat: 0, note: 0, video: 0, image: 0, bundle: 0 };
  const nowTs = now.getTime();
  const weekFrom = nowTs - 7 * DAY_MS;
  const prevFrom = nowTs - 14 * DAY_MS;
  const until = nowTs + 60000; // 与 weeklyStatsNow 同口径（容忍 1 分钟时钟偏差）
  let weekCount = 0;
  let prevWeekCount = 0;
  for (const it of arr) {
    if (byKind[it.kind] !== undefined) byKind[it.kind] += 1;
    const t = it.created_at;
    if (t >= weekFrom && t <= until) weekCount += 1;
    else if (t >= prevFrom && t < weekFrom) prevWeekCount += 1;
  }

  const { streak, bestStreak } = computeStreaks(dailyCounts, now);
  const level = levelIndexOf(total);
  const nextMilestone = nextMilestoneOf({ items: total, quotes: quoteCount, streak });

  return {
    total,
    quotes: quoteCount,
    weekCount,
    prevWeekCount,
    streak,
    bestStreak,
    title: LEVELS[level].title,
    level,
    nextMilestone,
    badges: buildBadges({ total, quoteCount, bestStreak, byKind }),
    byKind,
  };
}

// ---------- 主进程里程碑比对辅助 ----------
// 当前值已达成的最高里程碑目标（未达任何目标返回 0）
function reachedTarget(kind, value) {
  let best = 0;
  for (const m of MILESTONES) {
    if (m.kind === kind && value >= m.target && m.target > best) best = m.target;
  }
  return best;
}

// 里程碑文案（跨过目标时的通知 / 主窗事件用）
function milestoneInfo(kind, target) {
  return MILESTONES.find((m) => m.kind === kind && m.target === target) || { kind, target, label: String(target), icon: '🎖️' };
}

module.exports = { computeStats, LEVELS, MILESTONES, reachedTarget, milestoneInfo };
