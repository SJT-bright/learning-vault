/**
 * 点子：灵感与行动（不限于待学习）
 *
 * 状态：clarify 待想清楚 / try 准备尝试 / done 已落实 / parked 暂时搁置
 * 保存时不要求选状态（默认待想清楚），不要求设提醒。
 * 已落实、暂时搁置不再催促；不因放得久就持续红色警报。
 */
const DAY_MS = 86400000;

const NUDGE_CYCLES = [3, 7, 14, 30];

const STATUSES = {
  clarify: { id: 'clarify', label: '待想清楚', open: true, nudge: true },
  try: { id: 'try', label: '准备尝试', open: true, nudge: true },
  done: { id: 'done', label: '已落实', open: false, nudge: false },
  parked: { id: 'parked', label: '暂时搁置', open: true, nudge: false },
};

function nextCycleDays(nudgeCount) {
  return NUDGE_CYCLES[Math.min(nudgeCount || 0, NUDGE_CYCLES.length - 1)];
}

function ageDays(idea, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  return Math.floor((t - (idea.created_at || t)) / DAY_MS);
}

function ideaStatus(idea) {
  if (!idea) return 'clarify';
  if (idea.status && STATUSES[idea.status]) return idea.status;
  return idea.done ? 'done' : 'clarify';
}

function migrateIdea(idea) {
  if (!idea || typeof idea !== 'object') return idea;
  const status = ideaStatus(idea);
  idea.status = status;
  if (idea.this_week == null) idea.this_week = false;
  if (idea.next_action == null) idea.next_action = '';
  if (!Array.isArray(idea.related_item_ids)) idea.related_item_ids = [];
  if (idea.result_note == null) idea.result_note = '';
  if (idea.result_url == null) idea.result_url = '';
  if (idea.reminder_mode === undefined) idea.reminder_mode = idea.remind_at ? 'explicit' : 'legacy';
  if (idea.remind_at === undefined) idea.remind_at = null;
  if (!Array.isArray(idea.status_history)) {
    idea.status_history = [{ status, at: idea.doneAt || idea.created_at || Date.now(), note: '迁移' }];
  }
  idea.done = status === 'done';
  if (status === 'done' && !idea.doneAt) idea.doneAt = null;
  return idea;
}

function nudgeDue(idea, now, cycleDays) {
  const i = migrateIdea(idea);
  if (!i || !STATUSES[i.status].nudge) return false;
  const t = Number.isFinite(now) ? now : Date.now();
  if (i.reminder_mode === 'weekly' && !i.remind_at) return false;
  if (i.remind_at) {
    if (t < i.remind_at) return false;
    if (i.nudgedAt && i.nudgedAt >= i.remind_at) {
      const cycle = Math.max(1, Number(cycleDays) || nextCycleDays(i.nudgeCount));
      return t - i.nudgedAt >= cycle * DAY_MS;
    }
    return true;
  }
  const cycle = Math.max(1, Number(cycleDays) || nextCycleDays(i.nudgeCount));
  const last = i.nudgedAt || i.created_at || t;
  return t - last >= cycle * DAY_MS;
}

function dueIdeas(ideas, now, cycleDays) {
  return (ideas || [])
    .map(migrateIdea)
    .filter((i) => i && STATUSES[i.status].nudge && nudgeDue(i, now, cycleDays))
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

function thisWeekIdeas(ideas, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const d = new Date(t);
  const day = (d.getDay() + 6) % 7; // Mon=0
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime();
  const end = start + 7 * DAY_MS;
  return (ideas || []).map(migrateIdea).filter((i) => {
    if (!i || i.status === 'done' || i.status === 'parked') return false;
    if (i.this_week) return true;
    if (i.status === 'try') return true;
    if (i.remind_at && i.remind_at >= start && i.remind_at < end) return true;
    return false;
  });
}

// 陈化：搁置/已落实不着色；默认最多「该处理」（不因放太久持续红色）
// 红色仅用于：本周想推进 且 已过明确提醒时间
function staleness(idea, now, cycleDays) {
  const i = migrateIdea(idea);
  if (!i || !STATUSES[i.status].nudge) return 0;
  const t = Number.isFinite(now) ? now : Date.now();
  if (i.this_week && i.remind_at && t >= i.remind_at) return 2;
  if (i.remind_at && t >= i.remind_at) return 1;
  const cycle = Math.max(1, Number(cycleDays) || nextCycleDays(i.nudgeCount));
  const age = ageDays(i, now);
  if (age >= cycle) return 1;
  return 0;
}

function setStatus(idea, status, note) {
  migrateIdea(idea);
  if (!idea || !STATUSES[status]) return idea;
  if (idea.status === status) return idea;
  idea.status_history = idea.status_history || [];
  idea.status_history.push({ status, at: Date.now(), from: idea.status, note: note || '' });
  idea.status = status;
  idea.done = status === 'done';
  idea.doneAt = status === 'done' ? Date.now() : null;
  idea.lastTouchedAt = Date.now();
  return idea;
}

module.exports = {
  NUDGE_CYCLES, STATUSES, DAY_MS,
  nextCycleDays, ageDays, nudgeDue, dueIdeas, staleness,
  migrateIdea, ideaStatus, thisWeekIdeas, setStatus,
};
