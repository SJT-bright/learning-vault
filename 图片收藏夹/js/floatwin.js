/* ============================================================
 * floatwin.js — 页内「桌面悬浮小窗」
 * 收起态＝右下角暖白玻璃圆钮（橘色图标）；展开态＝可拖拽的暖白玻璃面板
 * 玻璃质感为全应用唯一例外：只给「壳」（气泡/面板两个表面），
 * 壳内元素一律实色；不支持 backdrop-filter 时回退为不透明暖白扁平版。
 * 与主应用协作：VaultDB / Importer / vault:changed / fw:open-image
 * 自注入样式（#fw-root 作用域），不改 index.html
 * ============================================================ */
(function () {
  'use strict';

  var POS_KEY = 'imgvault.fw.pos';
  var ENABLED_KEY = 'imgvault.fw.enabled';

  var root = null, bubble = null, panel = null, gridEl = null, emptyEl = null, errEl = null, fileInput = null;
  var expanded = false;
  var enabled = false;
  var urlCache = new Map();
  var dragState = null;

  /** 迷你收录窗模式（URL 带 #inbox 或桌面壳标记） */
  function isMiniMode() {
    try {
      return window.location.hash === '#inbox' ||
        !!(window.imgvaultDesktop && window.imgvaultDesktop.isMini);
    } catch (_) { return false; }
  }

  /** 图标（精灵缺失时安全退化） */
  function icon(name, cls) {
    try {
      if (typeof Icons !== 'undefined' && Icons.svg) return Icons.svg(name, cls);
    } catch (_) { /* 忽略 */ }
    return '';
  }

  // ---------- 悬浮窗专属：暖白液态玻璃（全应用唯一允许玻璃质感处） ----------
  // 基底仍与 css/styles.css v3.0 同源：文字 #3b342c/#6f675e，
  // 强调色 #f97316 只给主按钮，橘面上文字 #3b1206。
  // 玻璃只给「壳」——.fw-bubble 圆钮与 .fw-panel 面板两个表面：
  //   半透明暖白一档 rgba(255,251,247,.72)
  //   + backdrop-filter blur(28px) saturate(150%)；
  //   1px 亮边框 rgba(255,255,255,.55)，外圈再包一层暗描边
  //   0 0 0 1px rgba(61,51,42,.08)；
  //   落影 0 12px 32px rgba(0,0,0,.12)；
  //   顶部唯一内高光 inset 0 1px 0 rgba(255,255,255,.6)。
  // 壳内元素（主按钮/缩略图/次级钮/报错条）保持实色/白底，不玻璃化。
  // 不支持 backdrop-filter 时回退为不透明暖白 #f9f6f2 扁平版。
  // 动效只保留 ≤150ms 的底色/边框过渡；无位移、缩放、扫光、发光。

  var CSS = [
    '#fw-root{position:fixed;right:20px;bottom:20px;z-index:500;color:#3b342c;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI","Microsoft YaHei",sans-serif;',
    '-webkit-app-region:no-drag;user-select:none;}',
    '#fw-root[hidden]{display:none!important;}',

    /* 气泡：暖白圆钮 + 橘色图标（此处为不支持模糊时的回退实底） */
    '.fw-bubble{position:relative;width:56px;height:56px;border-radius:50%;',
    'background-color:#f9f6f2;border:1px solid rgba(61,51,42,.13);',
    'box-shadow:0 8px 24px rgba(0,0,0,.10);',
    'color:#f97316;display:flex;align-items:center;justify-content:center;',
    'cursor:pointer;transition:background-color .15s ease,border-color .15s ease;}',
    '.fw-bubble svg{width:24px;height:24px;display:block;pointer-events:none;}',
    '.fw-bubble:hover{background-color:#f2eee9;}',
    '.fw-bubble:active{background-color:#eae5de;}',

    /* 面板：暖白浮层（此处为不支持模糊时的回退实底） */
    '.fw-panel{position:relative;width:320px;max-width:calc(100vw - 40px);border-radius:22px;',
    'background-color:#f9f6f2;border:1px solid rgba(61,51,42,.13);',
    'box-shadow:0 8px 24px rgba(0,0,0,.10);',
    'overflow:hidden;display:flex;flex-direction:column;animation:fw-in .15s ease backwards;}',
    '@keyframes fw-in{from{opacity:0}to{opacity:1}}',

    /* —— 玻璃壳：支持 backdrop-filter 时，气泡与面板换装 ——
     * 半透明暖白一档 .72；hover 只抬透明度 +0.06，active 再 +0.06，
     * 不做位移缩放；亮边框 + 外圈暗描边 + 柔和落影 + 顶部唯一内高光。 */
    '@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){',
    '.fw-bubble,.fw-panel{background-color:rgba(255,251,247,.72);',
    'border-color:rgba(255,255,255,.55);',
    '-webkit-backdrop-filter:blur(28px) saturate(150%);',
    'backdrop-filter:blur(28px) saturate(150%);',
    'box-shadow:0 0 0 1px rgba(61,51,42,.08),0 12px 32px rgba(0,0,0,.12),',
    'inset 0 1px 0 rgba(255,255,255,.60);}',
    '.fw-bubble:hover{background-color:rgba(255,251,247,.78);}',
    '.fw-bubble:active{background-color:rgba(255,251,247,.84);}',
    '}',

    '.fw-head{display:flex;align-items:center;gap:8px;padding:10px 12px;',
    'border-bottom:1px solid rgba(61,51,42,.10);cursor:grab;}',
    '.fw-head:active{cursor:grabbing;}',
    '.fw-title{flex:1;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.fw-btn{position:relative;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;',
    'border:1px solid transparent;border-radius:9px;',
    'background:transparent;color:#6f675e;cursor:pointer;',
    'transition:background-color .15s,color .15s,border-color .15s;}',
    '.fw-btn svg{width:14px;height:14px;display:block;pointer-events:none;}',
    '.fw-btn:hover{background:rgba(61,51,42,.05);border-color:rgba(61,51,42,.13);color:#3b342c;}',
    '.fw-btn:active{background:rgba(61,51,42,.08);}',

    '.fw-actions{display:flex;align-items:center;gap:10px;padding:10px 12px;',
    'border-bottom:1px solid rgba(61,51,42,.10);}',
    /* 主色按钮：暖橘实色，橘面上文字用深棕保证对比 */
    '.fw-pick{position:relative;display:inline-flex;align-items:center;gap:6px;',
    'border:1px solid #f97316;border-radius:11px;',
    'background-color:#f97316;',
    'color:#3b1206;font-size:12.5px;font-weight:600;padding:7px 12px;cursor:pointer;',
    'box-shadow:0 1px 2px rgba(0,0,0,.06);',
    'transition:background-color .15s ease,border-color .15s ease;}',
    '.fw-pick svg{width:14px;height:14px;display:block;pointer-events:none;}',
    '.fw-pick:hover{background-color:#ea580c;border-color:#ea580c;}',
    '.fw-pick:active{box-shadow:inset 0 1px 2px rgba(0,0,0,.08);}',
    '.fw-hint{font-size:11px;color:#7d746a;line-height:1.4;}',

    '.fw-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px;overflow-y:auto;max-height:42vh;}',
    '.fw-thumb{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:12px;',
    'border:1px solid rgba(61,51,42,.13);cursor:zoom-in;',
    'box-shadow:0 1px 2px rgba(0,0,0,.06);',
    'transition:border-color .15s ease;}',
    '.fw-thumb:hover{border-color:rgba(234,88,12,.45);}',
    '.fw-empty{padding:20px 14px;text-align:center;font-size:12px;color:#7d746a;}',
    /* 报错：danger 色 + 极浅红底 */
    '.fw-err{padding:8px 12px;font-size:11.5px;color:#dc2626;background:rgba(220,38,38,.07);',
    'border-top:1px solid rgba(61,51,42,.10);}',
    /* 拖放高亮：橘色虚线（信号色允许的用途） */
    '.fw-drop{outline:2px dashed rgba(249,115,22,.60);outline-offset:-6px;}',
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById('fw-style')) return;
    var s = document.createElement('style');
    s.id = 'fw-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function buildDom() {
    var wrap = document.createElement('div');
    wrap.id = 'fw-root';
    wrap.hidden = true;
    wrap.innerHTML =
      '<button class="fw-bubble" title="展开悬浮收藏夹">' + icon('i-window') + '</button>' +
      '<div class="fw-panel" hidden>' +
      '  <div class="fw-head">' +
      '    <span class="fw-title">悬浮收藏夹</span>' +
      '    <button class="fw-btn fw-min" title="收起">' + icon('i-chevron-down') + '</button>' +
      '  </div>' +
      '  <div class="fw-actions">' +
      '    <button class="fw-pick fw-pick-btn">' + icon('i-plus') + '<span>选择图片</span></button>' +
      '    <span class="fw-hint">拖图到面板<br>或 Ctrl+V</span>' +
      '  </div>' +
      '  <div class="fw-grid"></div>' +
      '  <div class="fw-empty" hidden>还没有收藏，把图拖进来试试</div>' +
      '  <div class="fw-err" hidden></div>' +
      '  <input class="fw-file" type="file" accept="image/*" multiple hidden>' +
      '</div>';
    document.body.appendChild(wrap);

    root = wrap;
    bubble = wrap.querySelector('.fw-bubble');
    panel = wrap.querySelector('.fw-panel');
    gridEl = wrap.querySelector('.fw-grid');
    emptyEl = wrap.querySelector('.fw-empty');
    errEl = wrap.querySelector('.fw-err');
    fileInput = wrap.querySelector('.fw-file');
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
    try {
      var raw = localStorage.getItem(POS_KEY);
      if (raw) applyPos(JSON.parse(raw));
    } catch (_) { /* 忽略坏数据 */ }
  }
  function savePos() {
    try {
      var r = root.getBoundingClientRect();
      localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    } catch (_) { /* 忽略 */ }
  }

  function clampPos(x, y) {
    var r = root.getBoundingClientRect();
    var w = r.width || 56, h = r.height || 56;
    var maxX = window.innerWidth - w - 8;
    var maxY = window.innerHeight - h - 8;
    return {
      x: Math.max(8, Math.min(x, Math.max(8, maxX))),
      y: Math.max(8, Math.min(y, Math.max(8, maxY))),
    };
  }

  function bindDrag() {
    var head = panel.querySelector('.fw-head');
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return; // 按钮不触发拖拽
      var r = root.getBoundingClientRect();
      dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      try { head.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
      e.preventDefault();
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragState || e.pointerId !== dragState.id) return;
      var p = clampPos(e.clientX - dragState.dx, e.clientY - dragState.dy);
      applyPos(p);
    });
    function endDrag(e) {
      if (!dragState || (e && e.pointerId !== dragState.id)) return;
      dragState = null;
      savePos();
    }
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
  }

  // ---------- 展开 / 收起 ----------
  function expand() {
    expanded = true;
    bubble.hidden = true;
    panel.hidden = false;
    loadRecent();
  }
  function collapse() {
    expanded = false;
    panel.hidden = true;
    bubble.hidden = false;
  }

  /**
   * @param {boolean} v          是否启用悬浮窗
   * @param {boolean} openInbox  迷你收录窗模式下，顺带确保页内收录篮已打开
   */
  function setEnabled(v, openInbox) {
    var mini = isMiniMode();
    // 迷你收录窗由 inbox.js 独占主界面，悬浮窗自身不启用，
    // 避免出现两个互相抢占右下角（且被迷你壳隐藏）的气泡。
    enabled = !!v && !mini;
    root.hidden = !enabled;
    try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); } catch (_) { /* 忽略 */ }
    var btn = document.getElementById('fw-nav-btn');
    if (btn) btn.classList.toggle('active', enabled);
    if (enabled) expand(); else collapse();

    // 迷你模式：确保收录篮被拉起；已经开着就不要再点（点击是"切换"，会把收录篮关掉）
    if (mini && openInbox) {
      setTimeout(function () {
        try {
          if (typeof Inbox !== 'undefined' && Inbox.isOpen && Inbox.isOpen()) return;
          var ibBtn = document.getElementById('ib-nav-btn');
          if (ibBtn) ibBtn.click();
        } catch (_) { /* 收录篮模块未加载时静默 */ }
      }, 400);
    }
  }

  // ---------- 图片列表 ----------
  function ensureURL(img) {
    var url = urlCache.get(img.id);
    if (!url) {
      url = URL.createObjectURL(img.blob);
      urlCache.set(img.id, url);
    }
    return url;
  }

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
    try { console.warn('[悬浮窗] ' + msg); } catch (_) { /* 忽略 */ }
  }

  function loadRecent() {
    if (typeof VaultDB === 'undefined') { showError('存储模块未加载'); return; }
    Promise.resolve()
      .then(function () { return VaultDB.open(); })
      .then(function () { return VaultDB.listImages(); })
      .then(function (imgs) {
        var list = (imgs || []).slice(0, 8);
        var keep = {};
        list.forEach(function (i) { keep[i.id] = true; });
        urlCache.forEach(function (url, id) {
          if (!keep[id]) { URL.revokeObjectURL(url); urlCache.delete(id); }
        });
        gridEl.innerHTML = '';
        list.forEach(function (img) {
          var im = document.createElement('img');
          im.className = 'fw-thumb';
          im.src = ensureURL(img);
          im.alt = img.name || '';
          im.title = img.name || '';
          im.addEventListener('click', function () {
            document.dispatchEvent(new CustomEvent('fw:open-image', { detail: { id: img.id } }));
          });
          gridEl.appendChild(im);
        });
        var none = list.length === 0;
        emptyEl.hidden = !none;
        gridEl.style.display = none ? 'none' : '';
        errEl.hidden = true;
      })
      .catch(function (err) {
        showError('加载失败：' + (err && err.message ? err.message : err));
      });
  }

  // ---------- 导入 ----------
  function importFiles(files) {
    if (typeof Importer === 'undefined') { showError('导入模块未加载'); return; }
    var list = Array.from(files || []);
    if (!list.length) return;
    var dt;
    try {
      dt = new DataTransfer();
      list.forEach(function (f) { dt.items.add(f); });
    } catch (_) {
      showError('当前环境不支持按钮导入，请直接把图拖进面板');
      return;
    }
    Importer.fromDataTransfer(dt).catch(function (err) {
      showError('导入失败：' + (err && err.message ? err.message : err));
    });
  }

  function bindPanel() {
    panel.querySelector('.fw-min').addEventListener('click', collapse);
    bubble.addEventListener('click', expand);

    // 选择图片
    panel.querySelector('.fw-pick-btn').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var files = fileInput.files;
      fileInput.value = '';
      importFiles(files);
    });

    // 面板本身就是拖放目标（阻止冒泡，避免主应用重复导入 / 弹出遮罩）
    ['dragenter', 'dragover'].forEach(function (type) {
      panel.addEventListener(type, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        panel.classList.add('fw-drop');
      });
    });
    panel.addEventListener('dragleave', function (e) {
      e.stopPropagation();
      panel.classList.remove('fw-drop');
    });
    panel.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      panel.classList.remove('fw-drop');
      if (typeof Importer === 'undefined') { showError('导入模块未加载'); return; }
      Importer.fromDataTransfer(e.dataTransfer).catch(function (err) {
        showError('导入失败：' + (err && err.message ? err.message : err));
      });
    });
    // 说明：粘贴沿用主应用的全局 Ctrl+V 处理，这里不重复监听，避免同一张图入库两次。

    bindDrag();
  }

  // ---------- 侧栏入口按钮 ----------
  function injectNavButton() {
    var nav = document.getElementById('view-nav');
    if (!nav || document.getElementById('fw-nav-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'fw-nav-btn';
    btn.className = 'nav-item';
    btn.title = '切换悬浮小窗';
    btn.innerHTML = icon('i-window') + '<span class="nav-label">悬浮小窗</span>';
    btn.addEventListener('click', function () { setEnabled(!enabled); });
    nav.appendChild(btn);
  }

  function init() {
    try {
      ensureStyle();
      buildDom();
      bindPanel();
      restorePos();
      injectNavButton();
      document.addEventListener('vault:changed', function () {
        if (expanded) loadRecent();
      });
      var saved = null;
      try { saved = localStorage.getItem(ENABLED_KEY); } catch (_) { saved = null; }
      var miniMode = isMiniMode();
      setEnabled(saved === '1' || miniMode, miniMode);
    } catch (err) {
      try { console.warn('[悬浮窗] 初始化失败：', err); } catch (_) { /* 忽略 */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
