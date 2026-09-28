/* 共享流程 UI（B 白名单）：
 *  1) appendPreview —— 聊天追加确认（不确定消息逐条保留/跳过，默认保留）。
 *  2) 导入预检 —— 纯函数归一化（宽松适配 A 的 planImport schema）+ 视图模型 + 面板渲染，
 *     供 quick 窗渐进导入使用。真实数据源是 vault.importPreview/importCommit/importRetry（D 提供）；
 *     接口未接入时 quick 用 localPlan() 生成「本地预检」，保存仍走原 captureSave 通道。
 * 纯函数可在 Node 下直测（round-b-check）；末尾才挂 window，不依赖 DOM。 */
(function () {
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const basename = p => String(p || '').split('/').pop();
  const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

  // 已知问题类型 → 展示文案 / 严重度；未知类型按「提示」展示，不丢弃
  const ISSUE_LABELS = {
    'missing-speaker': '缺说话人', 'missing-time': '缺时间', 'pending-attachment': '待补附件',
    'definite-duplicate': '确定重复', 'possible-duplicate': '可能重复', 'missing-file': '附件缺失',
    'unparsed': '无法识别', 'format': '格式存疑', 'note': '提示',
  };
  const ISSUE_SEVERITY = {
    'definite-duplicate': 'danger', 'missing-file': 'danger',
    'possible-duplicate': 'warn', 'pending-attachment': 'warn', 'unparsed': 'warn', 'format': 'warn',
    'missing-speaker': 'info', 'missing-time': 'info', 'note': 'info',
  };
  // 问题类型 → 需要定位到的消息卡字段（file 类型单独定位文件条）
  const ISSUE_FIELD = {
    'missing-speaker': 'speaker', 'missing-time': 'time', 'pending-attachment': 'attachment',
    'definite-duplicate': 'text', 'possible-duplicate': 'text', 'unparsed': 'text', 'format': 'text',
  };

  function guessIssueType(message) {
    const s = String(message || '');
    if (/说话人/.test(s)) return 'missing-speaker';
    if (/时间/.test(s)) return 'missing-time';
    if (/缺失|找不到/.test(s)) return 'missing-file';
    if (/附件/.test(s)) return 'pending-attachment';
    if (/确定重复/.test(s)) return 'definite-duplicate';
    if (/重复/.test(s)) return 'possible-duplicate';
    if (/识别|格式|解析/.test(s)) return 'unparsed';
    return 'note';
  }

  // 单条已解析消息的保守问题推导（本地预检 / 补全计划缺失的 issues）
  function deriveMessageIssues(m) {
    const issues = [];
    if (!m) return issues;
    if (!String(m.speaker || '').trim() || m.speakerUnknown) issues.push({ type: 'missing-speaker', message: '' });
    if (!String(m.time || '').trim() || m.timeUnknown) issues.push({ type: 'missing-time', message: '' });
    const a = m.attachment;
    if (a && (a.pending || ((a.name || a.label) && !a.path))) {
      issues.push({ type: 'pending-attachment', message: a.name || a.label || '' });
    }
    return issues;
  }

  // 宽松归一化一条计划条目；绝不臆造内容，缺什么显示什么
  function normEntry(e, i) {
    if (e == null || typeof e !== 'object') return null;
    const kind = ['message', 'file', 'note'].includes(e.kind) ? e.kind
      : (e.parsed && typeof e.parsed === 'object' ? 'message' : 'other');
    let issues = Array.isArray(e.issues) ? e.issues : [];
    issues = issues.map(x => {
      if (typeof x === 'string') return { type: guessIssueType(x), message: x };
      const type = ISSUE_LABELS[x && x.type] ? x.type : guessIssueType(x && (x.message || x.text));
      return { type, message: String((x && (x.message || x.text)) || ''), index: x && Number.isInteger(x.index) ? x.index : null };
    }).filter(Boolean);
    const parsed = (e.parsed && typeof e.parsed === 'object') ? e.parsed : null;
    if (parsed && kind === 'message') {
      for (const d of deriveMessageIssues(parsed)) {
        if (!issues.some(x => x.type === d.type)) issues.push(d);
      }
    }
    const raw = e.raw != null ? String(e.raw)
      : (parsed ? [parsed.speaker, parsed.time, parsed.text].filter(Boolean).join(' ') : '');
    return {
      sourceKey: String(e.sourceKey || ('entry-' + i)),
      kind, raw, parsed, issues, index: i,
    };
  }

  // 宽松归一化整个计划；entries 缺失按空处理，warnings 展示原样
  function normPlan(plan) {
    const p = plan && typeof plan === 'object' ? plan : {};
    const entries = (Array.isArray(p.entries) ? p.entries : []).map(normEntry).filter(Boolean);
    const warnings = (Array.isArray(p.warnings) ? p.warnings : [])
      .map(w => (typeof w === 'string' ? w : String((w && (w.message || w.text)) || ''))).filter(Boolean);
    return { planId: p.planId != null ? String(p.planId) : null, entries, warnings };
  }

  function planCounts(plan) {
    const p = normPlan(plan);
    const by = k => p.entries.filter(e => e.kind === k).length;
    const counts = { messages: by('message'), files: by('file'), notes: by('note'), other: by('other') };
    const s = (plan && typeof plan.summary === 'object' && plan.summary) || {};
    for (const k of Object.keys(counts)) {
      const v = s[k] != null ? s[k] : s[k + 's'];
      if (Number.isFinite(v)) counts[k] = v;
    }
    return counts;
  }

  // 本地预检（接口未接入时的降级数据源）：从当前消息卡与文件列表生成，与计划 schema 同构
  function localPlan(chatMsgs, files) {
    const msgs = Array.isArray(chatMsgs) ? chatMsgs : [];
    const fs = Array.isArray(files) ? files : [];
    return {
      planId: null,
      entries: [
        ...msgs.map((m, i) => ({
          sourceKey: 'local-msg-' + i, kind: 'message',
          raw: [m.speaker, m.time, m.text].filter(Boolean).join(' ') || (m.attachment ? '[附件] ' + (m.attachment.name || '') : ''),
          parsed: {
            speaker: m.speaker || '', time: m.time || '', text: m.text || '',
            attachment: m.attachment || (m.attachPath ? { name: basename(m.attachPath), path: m.attachPath, pending: false } : null),
          },
          issues: [],
        })),
        ...fs.map((p, i) => ({
          sourceKey: 'local-file-' + i, kind: 'file', raw: basename(p),
          parsed: { attachment: { name: basename(p), path: p, pending: false } }, issues: [],
        })),
      ],
      warnings: ['本地预检：批量导入接口（importPreview）尚未接入（待 D），核对后仍按原通道保存'],
    };
  }

  // 视图模型：面板渲染与 Node 测试共用的唯一数据出口
  function precheckViewModel({ plan, decisions = {}, result = null, open = true, mode = 'plan', error = '' } = {}) {
    const p = normPlan(plan);
    const counts = planCounts(plan);
    const fileIdx = new Map(); // file 条目序号（用于定位文件条）
    let fi = 0;
    for (const e of p.entries) {
      if (e.kind === 'file') { fileIdx.set(e.sourceKey, fi); fi++; }
    }
    const issueRows = [];
    p.entries.forEach((e) => {
      for (const iss of e.issues) {
        const isFile = e.kind === 'file';
        issueRows.push({
          key: e.sourceKey + '::' + iss.type + '::' + issueRows.length,
          entryKey: e.sourceKey,
          type: iss.type,
          severity: ISSUE_SEVERITY[iss.type] || 'info',
          label: ISSUE_LABELS[iss.type] || iss.type,
          detail: clip(iss.message || (isFile ? e.raw : [e.parsed && e.parsed.speaker, e.parsed && e.parsed.text].filter(Boolean).join(' ')), 60),
          raw: e.raw,
          loc: isFile ? { type: 'file', index: fileIdx.get(e.sourceKey) }
            : (ISSUE_FIELD[iss.type]
              ? { type: ISSUE_FIELD[iss.type], index: Number.isInteger(iss.index) ? iss.index : (e.kind === 'message' ? e.index : null) }
              : null),
        });
      }
    });
    const entryRows = p.entries.map(e => ({
      key: e.sourceKey,
      kind: e.kind,
      kindLabel: e.kind === 'message' ? '消息' : e.kind === 'file' ? '文件' : '内容',
      kept: decisions[e.sourceKey] !== 'skip',
      issueCount: e.issues.length,
      preview: clip(e.raw, 46),
      raw: e.raw,
    }));
    const resultView = result ? {
      error: String(result.error || ''),
      batchId: result.batchId || null,
      succeededCount: Array.isArray(result.succeeded) ? result.succeeded.length : (Number.isFinite(result.succeeded) ? result.succeeded : 0),
      skippedCount: Array.isArray(result.skipped) ? result.skipped.length : (Number.isFinite(result.skipped) ? result.skipped : 0),
      failed: (Array.isArray(result.failed) ? result.failed : []).map(f => (typeof f === 'string' ? { sourceKey: '', message: f } : { sourceKey: String(f.sourceKey || ''), message: String(f.message || f.error || '失败') })),
      itemIds: Array.isArray(result.itemIds) ? result.itemIds : [],
    } : null;
    if (resultView && resultView.error) resultView.failed = resultView.failed.concat([{ sourceKey: '', message: resultView.error }]);
    const summaryText = [
      counts.messages ? counts.messages + ' 条消息' : '',
      counts.files ? counts.files + ' 个文件' : '',
      (counts.notes + counts.other) ? (counts.notes + counts.other) + ' 条内容' : '',
    ].filter(Boolean).join(' · ') || '空内容';
    return {
      mode, open, summaryText,
      problemCount: issueRows.length,
      issueRows, entryRows, result: resultView,
      warnings: p.warnings,
      error: String(error || ''),
      modeNote: mode === 'plan'
        ? '导入预检 · 重复与附件由资料库核对'
        : '本地预检 · 批量导入接口待接入，保存走原通道',
    };
  }

  // 面板渲染：只依赖传入的宿主元素；事件经 handlers 回调，不直接操作 quick 的状态
  // handlers: {onToggle(key,kept), onLocate(row), onRescan(), onRetry(), onCollapse()}
  function renderPrecheck(host, vm, handlers = {}) {
    if (!host) return;
    const h = [];
    h.push(`<section class="precheck ${vm.open ? '' : 'collapsed'}" id="precheckPanel">`);
    h.push(`<div class="pc-head" data-act="collapse" role="button" tabindex="0" aria-expanded="${vm.open}">`);
    h.push(`<span class="pc-title">📋 预检 · ${esc(vm.summaryText)}</span>`);
    h.push(vm.problemCount
      ? `<span class="pc-badge pc-badge-warn">${vm.problemCount} 个注意</span>`
      : '<span class="pc-badge pc-badge-ok">没发现问题</span>');
    h.push(`<span class="pc-caret">${vm.open ? '▾' : '▸'}</span></div>`);
    if (vm.open) {
      h.push('<div class="pc-body">');
      if (vm.error) h.push(`<div class="pc-error">预检失败：${esc(vm.error)}</div>`);
      if (vm.issueRows.length) {
        h.push('<div class="pc-issues">');
        for (const row of vm.issueRows) {
          h.push(`<button class="pc-issue sev-${row.severity}" data-act="locate" data-key="${esc(row.key)}" title="${esc(row.raw).slice(0, 80)}">${esc(row.label)}${row.detail ? ' · ' + esc(row.detail) : ''}</button>`);
        }
        h.push('</div>');
      }
      if (vm.entryRows.length) {
        h.push('<div class="pc-entries">');
        for (const e of vm.entryRows) {
          h.push(`<label class="pc-entry ${e.kept ? '' : 'skip'}" data-key="${esc(e.key)}">`);
          h.push(`<input type="checkbox" data-act="toggle" data-key="${esc(e.key)}" ${e.kept ? 'checked' : ''} aria-label="保留${esc(e.kindLabel)}：${esc(e.preview)}">`);
          h.push(`<span class="pc-kind">${esc(e.kindLabel)}</span><span class="pc-raw" title="${esc(e.raw)}">${esc(e.preview)}</span>`);
          if (e.issueCount) h.push(`<span class="pc-n">${e.issueCount}</span>`);
          h.push('</label>');
        }
        h.push('</div>');
      }
      if (vm.result) {
        h.push('<div class="pc-result">');
        if (vm.result.succeededCount) h.push(`<div class="ok">✓ 已保存 ${vm.result.succeededCount} 条${vm.result.skippedCount ? ` · 按勾选跳过 ${vm.result.skippedCount} 条` : ''}</div>`);
        for (const f of vm.result.failed) h.push(`<div class="fail">✕ ${esc(f.message || '保存失败')}${f.sourceKey ? `（${esc(f.sourceKey)}）` : ''}</div>`);
        if (vm.result.failed.length && vm.result.batchId) h.push('<button class="chipbtn pc-retry" data-act="retry" type="button">只重试失败项</button>');
        h.push('</div>');
      }
      if (vm.warnings.length) {
        h.push('<div class="pc-warns">');
        for (const w of vm.warnings) h.push(`<div>⚠ ${esc(w)}</div>`);
        h.push('</div>');
      }
      h.push('<div class="pc-actions">');
      h.push(`<span class="pc-mode">${esc(vm.modeNote)}</span>`);
      h.push('<button class="chipbtn" data-act="rescan" type="button">重新预检</button>');
      h.push('</div></div>');
    }
    h.push('</section>');
    host.innerHTML = h.join('');

    const rowByKey = key => vm.issueRows.find(r => r.key === key);
    host.querySelectorAll('[data-act="toggle"]').forEach(x => {
      x.onchange = () => handlers.onToggle && handlers.onToggle(x.dataset.key, x.checked);
    });
    host.querySelectorAll('[data-act="locate"]').forEach(x => {
      x.onclick = () => handlers.onLocate && handlers.onLocate(rowByKey(x.dataset.key));
    });
    const rescan = host.querySelector('[data-act="rescan"]');
    if (rescan) rescan.onclick = () => handlers.onRescan && handlers.onRescan();
    const retry = host.querySelector('[data-act="retry"]');
    if (retry) retry.onclick = () => handlers.onRetry && handlers.onRetry();
    const head = host.querySelector('[data-act="collapse"]');
    if (head) head.onclick = () => handlers.onCollapse && handlers.onCollapse();
  }

  // 提交结果宽松归一化：数组 / 数量两种形态都接，失败必须能逐条展示
  function normCommitResult(r) {
    const r0 = r && typeof r === 'object' ? r : {};
    const arr = (v, fb) => Array.isArray(v) ? v : (Number.isFinite(v) ? Array.from({ length: v }, () => ({})) : fb);
    const failed = (Array.isArray(r0.failed) ? r0.failed : []).map(f => (typeof f === 'string' ? { sourceKey: '', message: f } : { sourceKey: String((f && f.sourceKey) || ''), message: String((f && (f.message || f.error)) || '保存失败') }));
    const error = String(r0.error || (r0.ok === false ? (r0.message || '提交失败') : ''));
    return {
      batchId: r0.batchId != null ? String(r0.batchId) : null,
      succeeded: arr(r0.succeeded, []),
      failed: error ? failed.concat([{ sourceKey: '', message: error }]) : failed,
      skipped: arr(r0.skipped, []),
      itemIds: Array.isArray(r0.itemIds) ? r0.itemIds.filter(Boolean) : [],
      issues: Array.isArray(r0.issues) ? r0.issues : [],
    };
  }

  const api = {
    esc, basename, clip,
    ISSUE_LABELS, ISSUE_SEVERITY, ISSUE_FIELD,
    guessIssueType, deriveMessageIssues, normEntry, normPlan, planCounts,
    localPlan, precheckViewModel, renderPrecheck, normCommitResult,
    appendPreview(prev) {
      return new Promise(resolve => {
        const cover = document.createElement('div'); cover.className = 'flow-preview';
        cover.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#0009;display:grid;place-items:center;padding:20px;color:#efe9dd';
        const c = prev.counts;
        cover.innerHTML = `<section style="background:#1c2924;border:1px solid #74897e;border-radius:14px;padding:20px;width:min(640px,100%);max-height:85vh;overflow:auto"><h3>确认追加内容</h3><p>新增 ${c.added} · 确定重复 ${c.duplicate} · 可能重复 ${c.possible}</p><p>可能重复的消息默认保留；取消勾选才跳过。</p><div>${[...(prev.added || []), ...(prev.possibleDup || [])].map(m => `<div style="padding:10px 0;border-bottom:1px solid #ffffff22">${m.possibleDup ? `<label><input type="checkbox" data-keep="${esc(m.id)}" checked> 保留可能重复</label>` : '新增'} · ${esc(m.speaker || '未识别')} ${esc(m.time || '未识别')}<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.text || m.attachment?.name || '附件')}</div></div>`).join('') || '<p>没有新消息，原始导入批次仍会保留。</p>'}</div><div style="display:flex;gap:12px;margin-top:16px"><button data-cancel>取消</button><button data-save>确认追加</button></div></section>`;
        document.body.appendChild(cover);
        const done = r => { cover.remove(); resolve(r); };
        cover.querySelector('[data-cancel]').onclick = () => done(null);
        cover.querySelector('[data-save]').onclick = () => done({ dropPossibleIds: [...cover.querySelectorAll('[data-keep]:not(:checked)')].map(x => x.dataset.keep) });
      });
    },
  };

  if (typeof window !== 'undefined') window.FlowUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
