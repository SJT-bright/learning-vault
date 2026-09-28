/* ============================================================
 * inbox.js — 收录篮（待收录 → 投入文件夹）
 * 形态：右下角暖白圆钮（橘色图标）+ 可拖拽的暖白实底迷你收录窗
 * 流程：拖入/粘贴/选图 → 待收录（暂存，不入库）→ 选目标分类 → 全部收录（入库）
 * 依赖：window.VaultDB、window.Icons（可选）；事件：派发 vault:changed
 * ============================================================ */
(function () {
  'use strict';

  // ---------- localStorage 键（统一 imgvault.* 命名空间） ----------
  var POS_KEY = 'imgvault.inbox.pos';
  var ENABLED_KEY = 'imgvault.inbox.enabled';
  var LAST_CAT_KEY = 'imgvault.inbox.lastCat';

  // 旧版本曾把键名写坏成 '***' / 'imgvau…' / 'imgvaul…'（省略号是真实字符 U+2026）。
  // 这里做一次性迁移，避免老用户的「上次分类 / 收录篮开关 / 气泡位置」凭空丢失。
  var LEGACY_KEYS = [
    ['***', POS_KEY],
    ['imgvau\u2026', ENABLED_KEY],
    ['imgvaul\u2026', LAST_CAT_KEY],
  ];
  function migrateLegacyKeys() {
    try {
      for (var i = 0; i < LEGACY_KEYS.length; i++) {
        var oldK = LEGACY_KEYS[i][0], newK = LEGACY_KEYS[i][1];
        var v = localStorage.getItem(oldK);
        if (v === null) continue;
        if (localStorage.getItem(newK) === null) localStorage.setItem(newK, v);
        localStorage.removeItem(oldK);
      }
    } catch (_) { /* 忽略 */ }
  }

  var root = null, bubble = null, panel = null, gridEl = null, dropEl = null,
      errEl = null, fileInput = null, badge = null, commitBtn = null, countEl = null;

  var expanded = false;
  var enabled = false;
  var items = [];           // {tempId, blob, name, type, width, height, size, targetId}
  var urlCache = new Map(); // tempId -> objectURL
  var categories = [];
  var dragState = null;

  function isMiniDesktop() {
    try {
      return window.location.hash === '#inbox' ||
        !!(window.imgvaultDesktop && window.imgvaultDesktop.isMini);
    } catch (_) { return false; }
  }

  // ---------- 图标（精灵缺失时安全退化为空串） ----------
  function icon(name, cls) {
    try {
      if (typeof Icons !== 'undefined' && Icons.svg) return Icons.svg(name, cls);
    } catch (_) { /* 忽略 */ }
    return '';
  }

  // ---------- 暖白扁平：可复用的样式片段 ----------
  // 与 css/styles.css v3.0「安静扁平版」同基：
  // 表面一律接近实色的暖白 #f9f6f2 + 1px 低对比细边框
  // rgba(61,51,42,.13)，阴影单层极轻（浮层稍重一点）；
  // 橘色 #f97316 只给主按钮「全部收录」/ 关键图标 / 拖放高亮，
  // 橘面上文字用深棕 #3b1206。无玻璃光泽、无颗粒、
  // 无背景模糊、无内阴影高光；动效只有 ≤150ms 的
  // 底色/边框/颜色/透明度过渡。

  var CSS = [
    '#ib-root{position:fixed;right:20px;bottom:92px;z-index:510;color:#3b342c;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI","Microsoft YaHei",sans-serif;',
    '-webkit-app-region:no-drag;user-select:none;}',
    '#ib-root[hidden]{display:none!important;}',

    /* 气泡：暖白圆钮 + 橘色图标 */
    '.ib-bubble{position:relative;width:60px;height:60px;border-radius:50%;',
    'background-color:#f9f6f2;border:1px solid rgba(61,51,42,.13);',
    'box-shadow:0 8px 24px rgba(0,0,0,.10);',
    'color:#f97316;display:flex;align-items:center;justify-content:center;',
    'cursor:pointer;transition:background-color .15s ease,border-color .15s ease;}',
    '.ib-bubble svg{width:26px;height:26px;display:block;pointer-events:none;}',
    '.ib-bubble:hover{background-color:#f2eee9;}',
    '.ib-bubble:active{background-color:#eae5de;}',
    '.ib-bubble.ib-pulse{animation:ib-pulse .6s ease;}',
    '@keyframes ib-pulse{0%{background-color:#f9f6f2}35%{background-color:rgba(249,115,22,.18)}100%{background-color:#f9f6f2}}',

    '.ib-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;',
    'background-color:#f97316;border:1px solid #f97316;color:#3b1206;',
    'font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;',
    'box-shadow:0 1px 2px rgba(0,0,0,.06);}',
    '.ib-badge[hidden]{display:none!important;}',

    /* 面板：暖白实底浮层 */
    '.ib-panel{position:relative;width:330px;max-width:calc(100vw - 40px);border-radius:22px;',
    'background-color:#f9f6f2;border:1px solid rgba(61,51,42,.13);',
    'box-shadow:0 8px 24px rgba(0,0,0,.10);',
    'overflow:hidden;display:flex;flex-direction:column;animation:ib-in .15s ease backwards;}',
    '@keyframes ib-in{from{opacity:0}to{opacity:1}}',

    '.ib-head{display:flex;align-items:center;gap:8px;padding:10px 12px;',
    'border-bottom:1px solid rgba(61,51,42,.10);cursor:grab;}',
    '.ib-head:active{cursor:grabbing;}',
    '.ib-title{flex:1;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ib-btn{position:relative;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;',
    'border:1px solid transparent;border-radius:9px;',
    'background:transparent;color:#6f675e;cursor:pointer;',
    'transition:background-color .15s,color .15s,border-color .15s;}',
    '.ib-btn svg{width:14px;height:14px;display:block;pointer-events:none;}',
    '.ib-btn:hover{background:rgba(61,51,42,.05);border-color:rgba(61,51,42,.13);color:#3b342c;}',
    '.ib-btn:active{background:rgba(61,51,42,.08);}',

    /* 投放区：暖白实底 + 暖灰虚线 */
    '.ib-drop{margin:10px 12px 0;padding:14px 10px;border:1px dashed rgba(61,51,42,.20);border-radius:14px;',
    'background-color:#fbf9f6;',
    'text-align:center;font-size:12px;color:#6f675e;transition:background-color .15s,border-color .15s;}',
    '.ib-drop svg{width:26px;height:26px;display:block;margin:0 auto 6px;color:#f97316;pointer-events:none;}',
    '.ib-drop b{color:#3b342c;}',
    '.ib-drop.ib-over{background-color:rgba(249,115,22,.10);border-color:rgba(249,115,22,.65);}',

    '.ib-actions{display:flex;align-items:center;gap:10px;padding:10px 12px;}',
    /* 次级按钮：暖白实底中性按钮 */
    '.ib-pick{position:relative;display:inline-flex;align-items:center;gap:6px;',
    'border:1px solid rgba(61,51,42,.13);border-radius:11px;',
    'background-color:#f2eee9;',
    'color:#3b342c;font-size:12.5px;font-weight:600;padding:7px 12px;cursor:pointer;',
    'box-shadow:0 1px 2px rgba(0,0,0,.06);',
    'transition:background-color .15s ease,border-color .15s ease;}',
    '.ib-pick svg{width:14px;height:14px;display:block;pointer-events:none;}',
    '.ib-pick:hover{background-color:#eae5de;}',
    '.ib-pick:active{box-shadow:inset 0 1px 2px rgba(0,0,0,.06);}',
    '.ib-hint{font-size:11px;color:#7d746a;line-height:1.35;}',

    '.ib-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:4px 12px 10px;overflow-y:auto;max-height:38vh;}',
    '.ib-item{position:relative;border-radius:14px;overflow:hidden;border:1px solid rgba(61,51,42,.13);',
    'background-color:#ffffff;display:flex;flex-direction:column;}',
    '.ib-item img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;}',
    '.ib-item .ib-sel{width:100%;border:none;border-top:1px solid rgba(61,51,42,.10);',
    'background-color:#ffffff;color:#3b342c;font-size:11px;padding:5px 6px;outline:none;cursor:pointer;}',
    '.ib-item .ib-x{position:absolute;top:6px;right:6px;width:22px;height:22px;display:inline-flex;align-items:center;',
    'justify-content:center;border:1px solid rgba(61,51,42,.13);border-radius:8px;',
    'background-color:#ffffff;color:#6f675e;cursor:pointer;',
    'box-shadow:0 1px 2px rgba(0,0,0,.06);',
    'transition:background-color .15s,color .15s;}',
    '.ib-item .ib-x svg{width:11px;height:11px;display:block;pointer-events:none;}',
    '.ib-item .ib-x:hover{background-color:#f2eee9;color:#3b342c;}',
    '.ib-empty{padding:14px 12px 18px;text-align:center;font-size:12px;color:#7d746a;}',

    '.ib-foot{display:flex;align-items:center;gap:10px;padding:10px 12px;',
    'border-top:1px solid rgba(61,51,42,.10);}',
    /* 主色按钮「全部收录」：暖橘实色，橘面上文字用深棕保证对比 */
    '.ib-commit{position:relative;flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;',
    'border:1px solid #f97316;border-radius:12px;',
    'background-color:#f97316;',
    'color:#3b1206;font-size:13px;font-weight:600;padding:9px 12px;cursor:pointer;',
    'box-shadow:0 1px 2px rgba(0,0,0,.06);',
    'transition:background-color .15s ease,border-color .15s ease;}',
    '.ib-commit svg{width:15px;height:15px;display:block;pointer-events:none;}',
    '.ib-commit:hover:not(:disabled){background-color:#ea580c;border-color:#ea580c;}',
    '.ib-commit:active:not(:disabled){box-shadow:inset 0 1px 2px rgba(0,0,0,.08);}',
    '.ib-commit:disabled{opacity:.42;cursor:not-allowed;}',
    '.ib-msg{font-size:11.5px;color:#6f675e;min-height:14px;}',
    '.ib-msg.ib-err{color:#dc2626;font-weight:600;}',
    /* 成功提示：浅底强调文字用深一档橘 + 字重 */
    '.ib-msg.ib-ok{color:#c2410c;font-weight:600;}',

    /* 迷你桌面窗：收录篮铺满整个小窗 */
    '#ib-root.ib-mini{left:0;top:0;right:0;bottom:0;}',
    '#ib-root.ib-mini .ib-bubble{display:none!important;}',
    '#ib-root.ib-mini .ib-panel{width:100%;max-width:100%;height:100%;border-radius:18px;animation:none;}',
    '#ib-root.ib-mini .ib-grid{flex:1;max-height:none;}',
  ].join('\n');

  // ---------- 工具 ----------
  function ensureStyle() {
    if (document.getElementById('ib-style')) return;
    var s = document.createElement('style');
    s.id = 'ib-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function nowStamp() {
    var d = new Date();
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function extFromMime(mime) {
    var map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/tiff': '.tiff', 'image/x-icon': '.ico' };
    return map[mime || ''] || '.png';
  }

  /** 统一复用 Importer 的图片类型判断（含扩展名兜底），保证与主应用一致 */
  function resolveImageType(file) {
    try {
      if (typeof Importer !== 'undefined' && Importer.resolveImageType) {
        return Importer.resolveImageType(file);
      }
    } catch (_) { /* 回退 */ }
    var t = ((file && file.type) || '').toLowerCase();
    if (t.indexOf('image/') === 0) return t;
    var m = /\.(jpe?g|png|gif|webp|bmp|svg|avif|tiff?|ico)$/i.exec(String((file && file.name) || ''));
    if (!m) return '';
    return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon' }[m[0].toLowerCase()] || '';
  }

  function probeImage(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob)
        .then(function (bmp) {
          var s = { width: bmp.width || 0, height: bmp.height || 0 };
          if (typeof bmp.close === 'function') bmp.close();
          return s;
        })
        .catch(function () { return probeByImg(blob); });
    }
    return probeByImg(blob);
  }
  function probeByImg(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var im = new Image();
      im.onload = function () { var s = { width: im.naturalWidth || 0, height: im.naturalHeight || 0 }; URL.revokeObjectURL(url); resolve(s); };
      im.onerror = function () { URL.revokeObjectURL(url); resolve({ width: 0, height: 0 }); };
      im.src = url;
    });
  }

  function lastCategory() {
    try { return localStorage.getItem(LAST_CAT_KEY) || ''; } catch (_) { return ''; }
  }
  function setLastCategory(id) {
    try { localStorage.setItem(LAST_CAT_KEY, id || ''); } catch (_) { /* 忽略 */ }
  }
  function defaultTarget() {
    var lc = lastCategory();
    if (!lc) return null;
    for (var i = 0; i < categories.length; i++) if (categories[i].id === lc) return lc;
    return null;
  }

  // ---------- 样式/结构 ----------
  function buildDom() {
    var wrap = document.createElement('div');
    wrap.id = 'ib-root';
    wrap.hidden = true;
    wrap.innerHTML =
      '<button class="ib-bubble" title="展开收录篮">' + icon('i-inbox') + '<span class="ib-badge" hidden>0</span></button>' +
      '<div class="ib-panel" hidden>' +
      '  <div class="ib-head">' +
      '    <span class="ib-title">收录篮 · 待收录 0 张</span>' +
      '    <button class="ib-btn ib-min" title="收起">' + icon('i-chevron-down') + '</button>' +
      '  </div>' +
      '  <div class="ib-drop">' + icon('i-tray-down') +
      '    把图拖到这里 <b>暂存</b>，或 <b>Ctrl+V</b> 粘贴<br><span class="ib-hint">先待收录，再挑文件夹投进去</span></div>' +
      '  <div class="ib-actions">' +
      '    <button class="ib-pick ib-pick-btn">' + icon('i-plus') + '<span>选择图片</span></button>' +
      '    <span class="ib-hint">收录时会自动带上你上次用的分类</span>' +
      '  </div>' +
      '  <div class="ib-grid"></div>' +
      '  <div class="ib-empty">收录篮是空的</div>' +
      '  <div class="ib-foot">' +
      '    <button class="ib-commit" disabled>' + icon('i-check') + '<span>全部收录</span></button>' +
      '    <span class="ib-msg"></span>' +
      '  </div>' +
      '  <input class="ib-file" type="file" accept="image/*" multiple hidden>' +
      '</div>';
    document.body.appendChild(wrap);

    root = wrap;
    bubble = wrap.querySelector('.ib-bubble');
    badge = wrap.querySelector('.ib-badge');
    panel = wrap.querySelector('.ib-panel');
    gridEl = wrap.querySelector('.ib-grid');
    dropEl = wrap.querySelector('.ib-drop');
    errEl = wrap.querySelector('.ib-msg');
    fileInput = wrap.querySelector('.ib-file');
    commitBtn = wrap.querySelector('.ib-commit');
    countEl = wrap.querySelector('.ib-title');
  }

  // ---------- 位置 ----------
  function applyPos(p) {
    if (!p) return;
    root.style.left = p.x + 'px';
    root.style.top = p.y + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }
  function restorePos() {
    if (isMiniDesktop()) return; // 迷你窗铺满，不恢复自定义位置
    try {
      var raw = localStorage.getItem(POS_KEY);
      if (raw) applyPos(JSON.parse(raw));
    } catch (_) { /* 忽略 */ }
  }
  function savePos() {
    if (isMiniDesktop()) return;
    try {
      var r = root.getBoundingClientRect();
      localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    } catch (_) { /* 忽略 */ }
  }
  function clampPos(x, y) {
    var r = root.getBoundingClientRect();
    var w = r.width || 60, h = r.height || 60;
    return {
      x: Math.max(8, Math.min(x, Math.max(8, window.innerWidth - w - 8))),
      y: Math.max(8, Math.min(y, Math.max(8, window.innerHeight - h - 8))),
    };
  }
  function bindDrag() {
    var head = panel.querySelector('.ib-head');
    head.addEventListener('pointerdown', function (e) {
      if (isMiniDesktop()) return;         // 迷你窗不拖拽
      if (e.target.closest('button')) return;
      var r = root.getBoundingClientRect();
      dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      try { head.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
      e.preventDefault();
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragState || e.pointerId !== dragState.id) return;
      applyPos(clampPos(e.clientX - dragState.dx, e.clientY - dragState.dy));
    });
    function end(e) {
      if (!dragState || (e && e.pointerId !== dragState.id)) return;
      dragState = null;
      savePos();
    }
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  // ---------- 渲染 ----------
  function msg(text, kind) {
    errEl.textContent = text || '';
    errEl.className = 'ib-msg' + (kind ? ' ib-' + kind : '');
  }

  function updateCounts() {
    var n = items.length;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    countEl.textContent = '收录篮 · 待收录 ' + n + ' 张';
    commitBtn.disabled = n === 0;
    var label = commitBtn.querySelector('span');
    if (label) label.textContent = n ? ('全部收录（' + n + '）') : '全部收录';
    else commitBtn.textContent = n ? ('全部收录（' + n + '）') : '全部收录';
    var emptyDiv = root.querySelector('.ib-empty');
    if (emptyDiv) emptyDiv.hidden = n > 0;
    gridEl.style.display = n ? '' : 'none';
  }

  function renderItems() {
    gridEl.innerHTML = '';
    items.forEach(function (it) {
      var url = urlCache.get(it.tempId);
      if (!url) { url = URL.createObjectURL(it.blob); urlCache.set(it.tempId, url); }

      var div = document.createElement('div');
      div.className = 'ib-item';
      div.dataset.temp = it.tempId;

      var im = document.createElement('img');
      im.src = url;
      im.alt = it.name || '';
      im.title = it.name || '';
      im.draggable = false;
      div.appendChild(im);

      var x = document.createElement('button');
      x.className = 'ib-x';
      x.innerHTML = icon('i-close', 'ic-xs');
      x.title = '移出收录篮';
      x.addEventListener('click', function () { removeItem(it.tempId); });
      div.appendChild(x);

      var sel = document.createElement('select');
      sel.className = 'ib-sel';
      sel.title = '收录到哪个文件夹';
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '待收录（暂不入库）';
      sel.appendChild(o0);
      categories.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        sel.appendChild(o);
      });
      // 目标分类若已被删除，回落到「待收录」，避免写入悬空分类 id
      if (it.targetId && !categories.some(function (c) { return c.id === it.targetId; })) {
        it.targetId = null;
      }
      sel.value = it.targetId || '';
      sel.addEventListener('change', function () {
        it.targetId = sel.value || null;
        setLastCategory(it.targetId);
      });
      div.appendChild(sel);

      gridEl.appendChild(div);
    });
    updateCounts();
  }

  function bumpBadge() {
    try {
      bubble.classList.remove('ib-pulse');
      void bubble.offsetWidth;
      bubble.classList.add('ib-pulse');
    } catch (_) { /* 忽略 */ }
    var navBtn = document.getElementById('ib-nav-btn');
    if (navBtn) {
      var c = navBtn.querySelector('.ib-nav-count');
      if (c) c.textContent = items.length ? String(items.length) : '';
      else navBtn.title = items.length ? ('收录篮 · 待收录 ' + items.length + ' 张') : '收起/展开收录篮';
    }
  }

  function removeItem(tempId) {
    items = items.filter(function (i) { return i.tempId !== tempId; });
    var url = urlCache.get(tempId);
    if (url) { URL.revokeObjectURL(url); urlCache.delete(tempId); }
    renderItems();
    bumpBadge();
  }

  // ---------- 加入收录篮 ----------
  function addFiles(files) {
    var list = Array.from(files || []).filter(function (f) { return !!resolveImageType(f); });
    if (!list.length) {
      msg('没有可暂存的图片', 'err');
      return;
    }
    var target = defaultTarget();
    var jobs = list.map(function (f) {
      var type = resolveImageType(f);
      return probeImage(f).then(function (sz) {
        items.push({
          tempId: 'inbox-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          blob: f,
          name: f.name || (type === 'image/png' ? ('粘贴图片 ' + nowStamp() + '.png') : ('图片 ' + nowStamp() + extFromMime(type))),
          type: type,
          width: sz.width,
          height: sz.height,
          size: f.size,
          targetId: target,
        });
      });
    });
    Promise.all(jobs).then(function () {
      renderItems();
      bumpBadge();
      if (!expanded) expand();
      msg('已暂存 ' + list.length + ' 张，选好文件夹后点「全部收录」', 'ok');
    }).catch(function (err) {
      msg('暂存失败：' + (err && err.message ? err.message : err), 'err');
    });
  }

  // ---------- 全部收录（入库） ----------
  function commitAll() {
    if (!items.length) return;
    if (typeof VaultDB === 'undefined') { msg('存储模块未加载', 'err'); return; }
    commitBtn.disabled = true;
    msg('正在收录…');
    var snapshot = items.slice();
    var added = 0;
    var last = '';
    var errs = 0;

    var chain = Promise.resolve();
    snapshot.forEach(function (it) {
      chain = chain.then(function () {
        return VaultDB.addImage({
          blob: it.blob,
          name: it.name,
          type: it.type,
          width: it.width,
          height: it.height,
          size: it.size,
          categoryId: it.targetId || null,
          prompt: '',
        }).then(function () {
          added++;
          if (it.targetId) last = it.targetId;
          items = items.filter(function (x) { return x.tempId !== it.tempId; });
          var url = urlCache.get(it.tempId);
          if (url) { URL.revokeObjectURL(url); urlCache.delete(it.tempId); }
        }).catch(function (err) {
          errs++;
          msg('入库失败：' + (err && err.message ? err.message : err), 'err');
        });
      });
    });

    chain.then(function () {
      if (last) setLastCategory(last);
      renderItems();
      bumpBadge();
      if (added > 0) {
        document.dispatchEvent(new CustomEvent('vault:changed', { detail: { added: added, via: 'inbox' } }));
        document.dispatchEvent(new CustomEvent('vault:after-inbox-commit', { detail: { added: added, failed: errs } }));
        var catName = '待收录';
        for (var i = 0; i < categories.length; i++) if (categories[i].id === last) catName = categories[i].name;
        msg('已收录 ' + added + ' 张' + (last ? (' → ' + catName) : '（留在待收录）') + (errs ? ('，' + errs + ' 张失败') : ''), 'ok');
      } else {
        msg('没有收录成功的图片', 'err');
      }
      updateCounts();
    }).catch(function (err) {
      commitBtn.disabled = items.length === 0;
      msg('收录异常：' + (err && err.message ? err.message : err), 'err');
    });
  }

  // ---------- 展开 / 收起 ----------
  function expand() {
    expanded = true;
    bubble.hidden = true;
    panel.hidden = false;
    loadCategories().then(renderItems).catch(function () { renderItems(); });
  }
  function collapse() {
    expanded = false;
    panel.hidden = true;
    bubble.hidden = false;
  }

  function loadCategories() {
    if (typeof VaultDB === 'undefined') return Promise.resolve();
    return VaultDB.open()
      .then(function () { return VaultDB.listCategories(); })
      .then(function (list) { categories = list || []; })
      .catch(function () { categories = []; });
  }

  function setEnabled(v) {
    enabled = !!v;
    root.hidden = !enabled;
    try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); } catch (_) { /* 忽略 */ }
    var btn = document.getElementById('ib-nav-btn');
    if (btn) btn.classList.toggle('active', enabled);
    if (enabled) expand(); else collapse();
  }

  // ---------- 迷你桌面窗：只留收录篮 ----------
  function applyMiniShell() {
    if (!isMiniDesktop()) return;
    root.classList.add('ib-mini');
    var s = document.createElement('style');
    s.id = 'ib-mini-shell';
    s.textContent = '#app,#toast-zone,#drop-overlay,#lightbox,#fw-root{display:none!important;}' +
      'body{background:transparent!important;overflow:hidden!important;}' +
      'body::before,body::after{display:none!important;}' +
      '#bg3d-canvas{display:none!important;}';
    document.head.appendChild(s);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    bubble.addEventListener('click', expand);
    panel.querySelector('.ib-min').addEventListener('click', collapse);
    panel.querySelector('.ib-pick-btn').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files;
      fileInput.value = '';
      addFiles(f);
    });
    commitBtn.addEventListener('click', commitAll);
    bindDrag();

    // 拖放目标（阻止冒泡，避免主应用的全局 drop 直接入库）
    ['dragenter', 'dragover'].forEach(function (t) {
      panel.addEventListener(t, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        dropEl.classList.add('ib-over');
      });
    });
    panel.addEventListener('dragleave', function (e) {
      e.stopPropagation();
      dropEl.classList.remove('ib-over');
    });
    panel.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropEl.classList.remove('ib-over');
      var files = [];
      try {
        files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (!files.length && e.dataTransfer && e.dataTransfer.items) {
          Array.from(e.dataTransfer.items).forEach(function (it) {
            if (it && it.kind === 'file') { var f = it.getAsFile && it.getAsFile(); if (f) files.push(f); }
          });
        }
      } catch (_) { files = []; }
      if (files.length) addFiles(files);
    });

    // 粘贴：capture 阶段拦截（仅当收录篮展开、剪贴板含图、且不在输入框中）
    document.addEventListener('paste', function (e) {
      try {
        if (!expanded) return;
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
        if (!e.clipboardData || !e.clipboardData.items) return;
        var files = [];
        for (var i = 0; i < e.clipboardData.items.length; i++) {
          var it = e.clipboardData.items[i];
          if (it.kind === 'file') {
            var f = it.getAsFile && it.getAsFile();
            if (f && resolveImageType(f)) files.push(f);
          }
        }
        if (!files.length) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        addFiles(files);
      } catch (_) { /* 放行 */ }
    }, true);

    // 分类增删后同步下拉框，避免收录到已删除的分类
    document.addEventListener('vault:changed', function () {
      if (!expanded) return;
      loadCategories().then(function () { renderItems(); });
    });
  }

  function injectNavButton() {
    var nav = document.getElementById('view-nav');
    if (!nav || document.getElementById('ib-nav-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'ib-nav-btn';
    btn.className = 'nav-item';
    btn.title = '收起/展开收录篮（先待收录，再投入文件夹）';
    btn.innerHTML = icon('i-inbox') + '<span class="nav-label">收录篮</span><span class="ib-nav-count"></span>';
    btn.addEventListener('click', function () { setEnabled(!enabled); });
    nav.appendChild(btn);
  }

  function init() {
    try {
      ensureStyle();
      buildDom();
      bind();
      migrateLegacyKeys();
      restorePos();
      applyMiniShell();
      injectNavButton();
      updateCounts();
      var saved = null;
      try { saved = localStorage.getItem(ENABLED_KEY); } catch (_) { saved = null; }
      setEnabled(saved === '1' || isMiniDesktop());
    } catch (err) {
      try { console.warn('[收录篮] 初始化失败：', err); } catch (_) { /* 忽略 */ }
    }
  }

  // 对外 API
  window.Inbox = {
    open: function () { setEnabled(true); },
    close: function () { setEnabled(false); },
    toggle: function () { setEnabled(!enabled); },
    isOpen: function () { return enabled; },
    // v2.4 供 app.js 的 Esc 关层链使用：面板展开时 Esc 只收起面板，
    // 不整体停用（气泡与角标保留；迷你桌面窗下收录篮铺满整窗，不响应收起）
    isExpanded: function () { return expanded; },
    collapsePanel: function () { if (expanded && !isMiniDesktop()) collapse(); },
    addFiles: addFiles,
    count: function () { return items.length; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
