/**
 * 记忆复习引擎 — SM-2 变体调度（Anki 同款思想）+ 事件流（纯 Node、零依赖、selfcheck 可直测）
 *
 * ── 调度模型 ────────────────────────────────────────────────
 * 每张卡 { id, itemId, kind, front, back, created_at, due, interval, ease, reps, lapses, suspended }
 *   interval: 当前间隔（天）  ease: 难度系数（1.3~2.5，2.5=最容易）  reps: 成功次数
 *
 * 评分 grade ∈ {1 忘了, 2 模糊, 3 记得}，SM-2 变体：
 *   忘了: interval=1, ease-0.20, lapses+1, reps=0        —— 回到 1 天后再见
 *   模糊: interval=max(1, round(interval*1.2)), ease-0.05  —— 间隔小幅增长
 *   记得: interval = reps===0 ? 1 : reps===1 ? 3 : round(interval*ease) —— 1→3→7→14→30→90→180 天序列
 *   ease 钳制在 [1.3, 2.5]；interval 上限 365 天（一年后没必要再排）
 *
 * ── 每日节奏 ────────────────────────────────────────────────
 *   due: 下次到期时间戳（当天 04:00 锚点，避开深夜复习污染次日队列）
 *   newPerDay 默认 5：当日到期卡 + 新卡混合，超过上限的顺延（不丢、不罚）
 */

const DAY_MS = 86400000;
const EASE_MIN = 1.3, EASE_MAX = 2.5;
const INTERVAL_CAP = 365;

// 卡片 ID：复用 db.js 的 uid（时间戳+随机后缀，仅作标识符，非加密用途）
const uid = require('./db').uid;

// 与 main.js localDayKey 同规则的本地日键
function dayKey(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// 当天 04:00 锚点：due 落在凌晨四点，夜里收录的卡从"今天"算起
function anchor4am(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(4, 0, 0, 0);
  if (d.getTime() > (ts || Date.now())) d.setDate(d.getDate() - 1); // 凌晨 0~4 点算前一天
  return d.getTime();
}

// SM-2 变体：一次评分 → 新调度状态（纯函数，返回 patch）
function schedule(card, grade, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  let { interval = 0, ease = 2.5, reps = 0, lapses = 0 } = card || {};
  if (grade === 1) { // 忘了
    interval = 1;
    ease = Math.max(EASE_MIN, ease - 0.20);
    reps = 0;
    lapses += 1;
  } else if (grade === 2) { // 模糊
    interval = Math.max(1, Math.round((interval || 1) * 1.2));
    ease = Math.max(EASE_MIN, ease - 0.05);
    reps += 1;
  } else { // 记得
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 3;
    else interval = Math.min(INTERVAL_CAP, Math.max(1, Math.round(interval * ease)));
    reps += 1;
  }
  return { interval, ease: Math.min(EASE_MAX, Math.max(EASE_MIN, Math.round(ease * 100) / 100)), reps, lapses, due: anchor4am(t + interval * DAY_MS) };
}

// 新卡初始状态（金句/星标/手动加入时用）
function newCard({ itemId, kind, front, back }) {
  return {
    id: uid(),
    itemId: itemId || null, kind: kind || 'quote',
    front: String(front || '').slice(0, 300),
    back: String(back || '').slice(0, 800),
    created_at: Date.now(),
    due: anchor4am(Date.now() + DAY_MS), // 明天 04:00 首见
    interval: 0, ease: 2.5, reps: 0, lapses: 0, suspended: false,
  };
}

// 今日应复习队列：到期（含逾期）卡按 due 升序；limit 控制每日上限（超出顺延，不丢）
function dueCards(cards, now, limit = 5) {
  const t = anchor4am(now);
  return (cards || []).filter(c => c && !c.suspended && c.due <= t)
    .sort((a, b) => a.due - b.due)
    .slice(0, limit);
}

// 记忆统计：记住率（grade=3 占比）、活跃卡数、逾期数——复盘报告「记忆段落」用
function memoryStats(reviews) {
  const arr = (reviews || []).filter(Boolean);
  const total = arr.length;
  const good = arr.filter(r => r.grade === 3).length;
  const byDay = {};
  for (const r of arr) {
    const k = dayKey(new Date(r.t || 0));
    byDay[k] = byDay[k] || { total: 0, good: 0 };
    byDay[k].total += 1;
    if (r.grade === 3) byDay[k].good += 1;
  }
  return { total, good, retention: total ? good / total : null, byDay };
}

// 吃灰检测：收藏后 openedDays 天从未打开过（lastOpenedAt 空 或 < 收录时间）的条目
function dustyItems(items, { openedDays = 30, now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  return (items || []).filter(i => i && !i.trashed &&
    (t - (i.created_at || 0) >= openedDays * DAY_MS) && // 收录满 N 天
    (!i.lastOpenedAt || i.lastOpenedAt < i.created_at + 1000)); // 且从未真正打开过
}

// ---------- 资料级回看（P0）：卡片复习之外的另一条「回到眼前」通道 ----------
// 稳定伪随机：同一天多次计算结果一致（dayKey 做种子），避免每次打开列表顺序/人选都变
function hashStr(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 判断某条目的「回看理由」，返回 {reason, weight, kind} 或 null；按优先级先到先得
function resurfaceReason(item, t, opts) {
  const created = item.created_at || 0;
  if (!created) return null;
  const ageDays = Math.floor((t - created) / DAY_MS);

  // dusty：收录 ≥30 天且从未打开过（复用 dustyItems 判定）
  if (ageDays >= opts.dustyDays &&
      (!item.lastOpenedAt || item.lastOpenedAt < created + 1000)) {
    return { kind: 'dusty', weight: 0, reason: `收录 ${ageDays} 天从没打开` };
  }

  // fading：打开过但距上次打开 ≥45 天
  if (item.lastOpenedAt && item.lastOpenedAt > created &&
      t - item.lastOpenedAt >= opts.fadingDays * DAY_MS) {
    return { kind: 'fading', weight: 1, reason: `上次看是 ${Math.floor((t - item.lastOpenedAt) / DAY_MS)} 天前` };
  }

  // anniversary：收录日期为 30/90/180/365 天前 ±1 天
  const marks = opts.anniversaryDays;
  for (const mark of marks) {
    if (Math.abs(ageDays - mark) <= 1) {
      return { kind: 'anniversary', weight: 2, reason: `${ageDays} 天前的今天收录` };
    }
  }

  // unused：有 lastOpenedAt 但 usage 记录为空且收录 ≥14 天（看过但没用过）
  // 注意：uses 可能是 undefined（旧数据）或 []（Store 默认值），两者都算「没有使用记录」
  const noUses = !Array.isArray(item.uses) || item.uses.length === 0;
  if (item.lastOpenedAt && ageDays >= opts.unusedDays &&
      noUses && !(item.use_count > 0)) {
    return { kind: 'unused', weight: 3, reason: '看过但没用过' };
  }
  return null;
}

// 今日「该回看了」名单：按优先级排序、限流、同类限额、同日稳定
function resurfaceItems(items, opts = {}, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const o = {
    dustyDays: 30, fadingDays: 45, unusedDays: 14,
    anniversaryDays: [30, 90, 180, 365],
    limit: 3, perReason: 2,
    excludeIds: [], trashedIds: [], snoozedIds: [], ...opts,
  };
  const exclude = new Set(o.excludeIds || []);
  const trashed = new Set(o.trashedIds || []);
  const snoozed = new Set(o.snoozedIds || []);
  const dk = dayKey(new Date(t));
  const out = [];
  for (const it of items || []) {
    if (!it || it.trashed || trashed.has(it.id) || exclude.has(it.id) || snoozed.has(it.id)) continue;
    const r = resurfaceReason(it, t, o);
    if (!r) continue;
    out.push({ id: it.id, title: it.title || '', kind: it.kind || 'note', category: it.category || '', created_at: it.created_at, reason: r.reason, reasonKind: r.kind, _prio: r.weight, _h: hashStr(dk + ':' + it.id) });
  }
  // 排序：reason 类别优先级 → 同优先级按当日稳定伪随机（同一天多次打开看到同一批）
  out.sort((a, b) => (a._prio - b._prio) || (a._h - b._h));
  const perCount = {};
  const picked = [];
  for (const it of out) {
    if (picked.length >= o.limit) break;
    if ((perCount[it.reasonKind] || 0) >= o.perReason) continue;
    perCount[it.reasonKind] = (perCount[it.reasonKind] || 0) + 1;
    picked.push(it);
  }
  return picked.map(({ _prio, _h, ...rest }) => rest);
}

// 积压护栏（P1）：逾期超过 3×每日上限时给出分期消化建议（纯函数，不改变实际队列）
function backlogPlan(cards, now, dailyLimit = 5) {
  const limit = Math.max(1, parseInt(dailyLimit, 10) || 5);
  // 逾期口径与 dueCards 一致：到期（含逾期）未复习的卡
  const overdue = (cards || []).filter(c => c && !c.suspended && c.due <= anchor4am(now)).length;
  if (overdue <= limit * 3) return null;
  // 建议：约 3 天消化完，单日不超过 3×每日上限（护栏本身也有护栏）
  const suggestedLimit = Math.min(overdue, Math.max(1, Math.ceil(overdue / 3)), limit * 3);
  const spreadDays = Math.max(2, Math.ceil(overdue / suggestedLimit));
  return { overdue, suggestedLimit, spreadDays };
}

module.exports = { DAY_MS, EASE_MIN, EASE_MAX, INTERVAL_CAP, dayKey, anchor4am, schedule, newCard, dueCards, memoryStats, dustyItems, resurfaceItems, backlogPlan };
