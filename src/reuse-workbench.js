/**
 * 继续使用工作台 · 纯选择/分组函数（不碰库、不发请求、不改 schema）
 *
 * 数据来自现有接口，由调用方取好后整体传入：
 *   items    = vault.list({ limit: 300 }).items   （含 uses / improvements / versions / messages）
 *   extracts = vault.extractList({})              （整理结果）
 *   ideas    = vault.ideasList().thisWeek         （本周点子，主进程已按 ideas.js 口径选好）
 *   now      = Date.now()（可注入，测试用）
 *
 * 铁律（与 src/usage.js / src/outcomes.js 口径一致）：
 * - 「使用」只来自 item.uses——用户明确点「记一次使用」才算；打开详情、搜索命中都不是使用。
 * - 每条目必须带 reason（为什么出现在这里）和恰好一个明确动作 action。
 * - 不做分数、不做伪排行榜；每段有上限（默认 5），空段如实留空说明。
 * - 只读加工：返回值是新对象，不改传入数据。
 */

const DEFAULTS = {
  limitPerSection: 5,     // 每段上限，超过截断并在 summary 里说明
  recentUseDays: 14,      // 「最近实际使用」窗口
  improveVerifyDays: 30,  // 「改进待验证」回看窗口
};

const DAY_MS = 86400000;

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function fmtDay(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const sectionEmpty = {
  'recent-uses': '还没有记录过使用。打开一条资料点「记一次使用」——只有明确记录的才算是使用。',
  'improve-pending': '近 30 天没有待验证的改进。记下改进后再次使用它，效果会在这里对照。',
  'idea-linked': '本周没有进行中的点子，或点子还没有关联资料。在点子里「关联资料」后会出现在这里。',
  'needs-fix': '没有待补的附件或来源。',
};

// 判断一条改进是否「已验证」：改进之后同一资料又记过一次使用 → 已验证，不再提示
function improvementVerified(item, im) {
  const uses = Array.isArray(item && item.uses) ? item.uses : [];
  return uses.some((u) => u && Number(u.used_at) > Number(im.created_at));
}

// 最近实际使用：uses 时间倒序，同一资料只取最新一次
function recentUseEntries(items, now, opts) {
  const from = now - opts.recentUseDays * DAY_MS;
  const rows = [];
  for (const it of items || []) {
    if (!it || it.trashed) continue;
    let newest = null;
    for (const u of it.uses || []) {
      if (!u || !(Number(u.used_at) >= from)) continue;
      if (!newest || Number(u.used_at) > Number(newest.used_at)) newest = u;
    }
    if (!newest) continue;
    rows.push({
      id: 'ru:' + it.id,
      kind: 'item',
      itemId: it.id,
      title: clip(it.title, 42),
      reason: `上次使用 ${fmtDay(Number(newest.used_at))}` + (newest.purpose ? ` · ${clip(newest.purpose, 30)}` : ''),
      detail: newest.result ? clip(newest.result, 60) : '',
      action: { id: 'record-use', label: '记一次使用' },
    });
  }
  return rows; // 排序由 buildReuseFeed 里的 sortByTs 按真实时间戳统一处理
}

// 带时间戳排序辅助（保持纯函数：先装饰再排序再剥掉）
function sortByTs(rows, tsMap, desc) {
  const decorated = rows.map((r) => ({ r, ts: Number(tsMap(r)) || 0 }));
  decorated.sort((a, b) => (desc ? b.ts - a.ts : a.ts - b.ts));
  return decorated.map((x) => x.r);
}

// 已记录改进待验证：窗口内记了改进、且改进后还没有再用过
function improvePendingEntries(items, now, opts) {
  const from = now - opts.improveVerifyDays * DAY_MS;
  const rows = [];
  for (const it of items || []) {
    if (!it || it.trashed) continue;
    for (const im of it.improvements || []) {
      if (!im || !(Number(im.created_at) >= from)) continue;
      if (improvementVerified(it, im)) continue;
      rows.push({
        id: 'ip:' + it.id + ':' + im.id,
        kind: 'item',
        itemId: it.id,
        title: clip(it.title, 42),
        reason: clip(im.problem || im.change || '', 40)
          ? `改进待验证 · ${clip(im.problem || im.change || '', 40)}` + (im.version_id ? '（已存新版本）' : '（只记了意见）')
          : '改进待验证',
        detail: im.version_id ? '已保存改进版本，用一次看看效果' : '还没有存改进版本，可用一次再决定要不要改',
        action: { id: 'record-use', label: '用一次验证' },
      });
    }
  }
  return rows;
}

// 本周点子关联资料：点子 related_item_ids 命中的资料（不含已删除）
function ideaLinkedEntries(items, ideas) {
  const byId = new Map((items || []).filter((i) => i && !i.trashed).map((i) => [i.id, i]));
  const rows = [];
  const seenPairs = new Set();
  for (const idea of ideas || []) {
    if (!idea || idea.status === 'done' || idea.status === 'parked') continue;
    for (const rid of idea.related_item_ids || []) {
      const it = byId.get(rid);
      if (!it) continue;
      const key = rid + '::' + idea.id;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      rows.push({
        id: 'il:' + rid + ':' + idea.id,
        kind: 'item',
        itemId: rid,
        ideaId: idea.id,
        title: clip(it.title, 42),
        reason: `本周点子「${clip(idea.text, 24)}」关联`,
        detail: idea.next_action ? '下一步：' + clip(idea.next_action, 40) : '',
        action: { id: 'open-item', label: '打开资料' },
      });
    }
  }
  return rows;
}

// 待处理项：聊天附件待补 / 登录墙未取正文 / 整理结果来源已删
function needsFixEntries(items, extracts) {
  const rows = [];
  for (const it of items || []) {
    if (!it || it.trashed) continue;
    const pend = (it.messages || []).filter((m) => m && m.attachment && m.attachment.pending);
    if (pend.length) {
      rows.push({
        id: 'nf-att:' + it.id,
        kind: 'item',
        itemId: it.id,
        title: clip(it.title, 42),
        reason: `有 ${pend.length} 条消息的附件待补（${clip(pend.map((m) => m.attachment.name || m.attachment.label || '未命名').join('、'), 40)}）`,
        detail: '',
        action: { id: 'open-item', label: '去补附件' },
      });
    }
    if (it.login_wall) {
      rows.push({
        id: 'nf-wall:' + it.id,
        kind: 'item',
        itemId: it.id,
        title: clip(it.title, 42),
        reason: '飞书登录墙：只存下标题和链接，正文待补',
        detail: '打开后把关键内容贴进附言，才能全文检索与复用',
        action: { id: 'open-item', label: '去补正文' },
      });
    }
  }
  const liveIds = new Set((items || []).filter((i) => i && !i.trashed).map((i) => i.id));
  for (const ex of extracts || []) {
    if (!ex || ex.trashed) continue;
    if (ex.source_item_id && !liveIds.has(ex.source_item_id)) {
      rows.push({
        id: 'nf-src:' + ex.id,
        kind: 'extract',
        extractId: ex.id,
        title: clip(ex.title, 42),
        reason: '来源资料已删除，这份整理还在',
        detail: '内容仍可复用；如不再需要可删除',
        action: { id: 'open-extract', label: '查看整理' },
      });
    }
  }
  return rows;
}

const SECTION_DEFS = [
  { id: 'recent-uses', title: '最近实际使用', note: '只统计明确记下的使用，打开不算' },
  { id: 'improve-pending', title: '改进 · 待验证', note: '记了改进还没再用过' },
  { id: 'idea-linked', title: '本周点子关联资料', note: '从本周点子回到相关资料' },
  { id: 'needs-fix', title: '待处理', note: '待补附件 / 来源' },
];

/**
 * 主入口：{ items, extracts, ideas, now, options } → { sections, generatedAt }
 * sections 永远是这四段（顺序固定），每段 entries 可为空数组（空态文案见 sectionEmpty）。
 */
function buildReuseFeed(input) {
  const opts = { ...DEFAULTS, ...((input && input.options) || {}) };
  const now = Number.isFinite(input && input.now) ? input.now : Date.now();
  const items = (input && input.items) || [];
  const extracts = (input && input.extracts) || [];
  const ideas = (input && input.ideas) || [];

  const ru = recentUseEntries(items, now, opts);
  const ruTs = new Map();
  for (const it of items || []) {
    if (!it || !Array.isArray(it.uses)) continue;
    for (const u of it.uses) if (u) ruTs.set('ru:' + it.id, Math.max(ruTs.get('ru:' + it.id) || 0, Number(u.used_at) || 0));
  }
  const ip = improvePendingEntries(items, now, opts);
  const ipTs = new Map();
  for (const it of items || []) {
    if (!it || !Array.isArray(it.improvements)) continue;
    for (const im of it.improvements || []) if (im) ipTs.set('ip:' + it.id + ':' + im.id, Number(im.created_at) || 0);
  }
  const il = ideaLinkedEntries(items, ideas);
  const nf = sortByTs(needsFixEntries(items, extracts), (r) => {
    const it = (items || []).find((x) => x && x.id === r.itemId);
    return (it && it.updated_at) || 0;
  }, true);

  const buckets = {
    'recent-uses': sortByTs(ru, (r) => ruTs.get(r.id) || 0, true),
    'improve-pending': sortByTs(ip, (r) => ipTs.get(r.id) || 0, true),
    'idea-linked': il,
    'needs-fix': nf,
  };

  const sections = SECTION_DEFS.map((def) => {
    const all = buckets[def.id] || [];
    return {
      id: def.id,
      title: def.title,
      note: def.note,
      entries: all.slice(0, opts.limitPerSection),
      overflow: Math.max(0, all.length - opts.limitPerSection),
      emptyText: sectionEmpty[def.id] || '暂无内容',
    };
  });

  return { sections, generatedAt: now };
}

// 侧栏角标：只统计「真的需要动一下」的量（待验证改进 + 待处理项），最近使用不计入
function reuseBadgeCount(feed) {
  if (!feed || !Array.isArray(feed.sections)) return 0;
  let n = 0;
  for (const s of feed.sections) {
    if (s.id === 'improve-pending' || s.id === 'needs-fix') n += (s.entries || []).length;
  }
  return n;
}

const api = { buildReuseFeed, reuseBadgeCount, improvementVerified, clip, DEFAULTS, SECTION_DEFS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ReuseWorkbench = api;
