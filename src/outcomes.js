/**
 * 周复盘成果：只用真实使用记录、点子状态、用户填写的改进。
 * 不把收藏/打开/AI 摘要当成学会了。不足 3 条就显示实际数量，不凑数。
 */
function inRange(ts, from, to) {
  const t = Number(ts) || 0;
  return t >= from && t <= to;
}

function weekOutcomes({ items, allItems, ideas, from, to }) {
  const uses = [];
  const improvements = [];
  for (const it of allItems || []) {
    if (!it || it.trashed) continue;
    for (const u of it.uses || []) {
      if (inRange(u.used_at, from, to)) {
        uses.push({
          itemId: it.id, title: it.title, purpose: u.purpose, result: u.result, used_at: u.used_at,
        });
      }
    }
    for (const im of it.improvements || []) {
      if (inRange(im.created_at, from, to)) {
        improvements.push({
          itemId: it.id, title: it.title, problem: im.problem, change: im.change, reason: im.reason,
          hasVersion: !!im.version_id, created_at: im.created_at,
        });
      }
    }
  }
  uses.sort((a, b) => b.used_at - a.used_at);
  improvements.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  const ideasDone = (ideas || []).filter((i) => {
    if (!i || (i.status !== 'done' && !i.done)) return false;
    return inRange(i.doneAt, from, to);
  }).map((i) => ({
    id: i.id, text: i.text, result_note: i.result_note || '', result_url: i.result_url || '', doneAt: i.doneAt,
  }));

  const tryIdeas = (ideas || []).filter((i) => i && i.this_week && i.status !== 'parked' && i.status !== 'done' && !i.done);
  const relatedIds = new Set();
  for (const i of tryIdeas) for (const id of (i.related_item_ids || [])) relatedIds.add(id);

  const reopen = [];
  const seen = new Set();
  const push = (row) => {
    if (!row || !row.id || seen.has(row.id) || reopen.length >= 3) return;
    seen.add(row.id);
    reopen.push(row);
  };

  for (const it of allItems || []) {
    if (!it || it.trashed) continue;
    if (relatedIds.has(it.id)) {
      const idea = tryIdeas.find((i) => (i.related_item_ids || []).includes(it.id));
      push({ id: it.id, title: it.title, reason: '与本周准备尝试的点子相关' + (idea && idea.text ? '：「' + String(idea.text).slice(0, 24) + '」' : '') });
    }
  }
  for (const it of allItems || []) {
    if (!it || it.trashed) continue;
    const lastUse = (it.uses || [])[0];
    const lastIm = (it.improvements || [])[0];
    if (lastUse && inRange(lastUse.used_at, from, to) && lastIm && !lastIm.version_id && inRange(lastIm.created_at, from, to)) {
      push({ id: it.id, title: it.title, reason: '本周记录了改进意见，可回看效果：' + (lastIm.problem || lastIm.change || '').slice(0, 30) });
    }
  }
  for (const i of ideas || []) {
    if (!i || i.status === 'done' || i.status === 'parked') continue;
    if (i.remind_at && inRange(i.remind_at, from, to + 7 * 86400000)) {
      push({ id: i.source_item_id || ('idea:' + i.id), title: i.text, reason: '你明确安排了回顾', ideaId: i.id });
    }
  }

  return {
    uses,
    improvements,
    ideasDone,
    reopen,
    ingestCount: (items || []).length,
    from,
    to,
  };
}

function outcomesMarkdown(o) {
  if (!o) return '';
  const lines = ['## 本周成果', ''];
  if (!o.uses.length && !o.improvements.length && !o.ideasDone.length) {
    lines.push('还没有使用记录、改进或落实的点子。打开资料点「记一次使用」，成果会出现在这里。');
    lines.push('');
  } else {
    lines.push('### 实际使用了哪些资料');
    if (!o.uses.length) lines.push('- （没有明确记录的使用）');
    else for (const u of o.uses) {
      lines.push(`- 《${u.title || '未命名'}》用于 ${u.purpose || '未填写'} → ${u.result || '未填写结果'}`);
    }
    lines.push('');
    lines.push('### 帮助完成了什么 / 点子变成了成果');
    if (!o.ideasDone.length) lines.push('- （本周还没有标记已落实的点子）');
    else for (const i of o.ideasDone) {
      lines.push(`- ${i.text}${i.result_note ? ' → ' + i.result_note : ''}${i.result_url ? ' ' + i.result_url : ''}`);
    }
    lines.push('');
    lines.push('### 哪些方法得到改进');
    if (!o.improvements.length) lines.push('- （没有改进记录）');
    else for (const im of o.improvements) {
      lines.push(`- 《${im.title || '未命名'}》${im.problem ? '问题：' + im.problem + '；' : ''}${im.change ? '改了：' + im.change : ''}${im.hasVersion ? '（已保存改进版本）' : ''}`);
    }
    lines.push('');
  }
  lines.push('### 下周最值得重新打开');
  if (!o.reopen.length) lines.push('- （依据不足，不凑数）');
  else o.reopen.forEach((r, i) => lines.push(`${i + 1}. 《${r.title || '未命名'}》—— ${r.reason}`));
  if (o.ingestCount) {
    lines.push('');
    lines.push(`> 本周新收录 ${o.ingestCount} 条（收录不等于学会或完成）。`);
  }
  return lines.join('\n');
}

module.exports = { weekOutcomes, outcomesMarkdown, inRange };
