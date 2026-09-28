/* ============================================================
 * QuickDrop 快投面板 v1.0（image-vault v2.4 新能力）
 * ------------------------------------------------------------
 * 交互：拖着图片靠近 → 小钮感知到拖拽自动动画展开面板；
 * 展开后是你自己创建的收藏夹网格，每个收藏夹下面一个
 * 虚线投放框，拖到哪个框就收进哪个收藏夹——相互隔离。
 *
 * 设计约束：
 *   - 自包含：自建 DOM / 样式（暖白扁平主题，与 styles.css 同基），不依赖 styles.css
 *   - 数据：直接读写 window.VaultDB（IndexedDB，与主程序同库）
 *     导入统一走 VaultDB.importRecord（完整记录，字段不丢失）
 *   - 集成：app.js 末尾调用 QuickDrop.install({
 *       getCategories: () => state.categories,
 *       onImported: () => loadImages().then(renderAll),
 *     })
 *   - 隔离：面板内 drop 会 stopPropagation，不会触发主页面
 *     的通用导入，绝不重复入库
 *   - 深链：?qd-open=1 打开页面即展开（调试/演示用）
 *
 * 全局导出：window.QuickDrop = { install, open, close }
 * ============================================================ */
(function () {
  'use strict';
  if (window.QuickDrop) return; // 幂等

  var cfg = { getCategories: null, onImported: null };
  var opened = false;
  var dragDepth = 0;
  var closeTimer = null;

  /* ---------------- 样式（暖白扁平：实底 + 细边框 + 轻阴影） ---------------- */
  var CSS = [
    '#qd-fab{position:fixed;right:26px;bottom:26px;z-index:99990;width:56px;height:56px;',
    'border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;',
    'background-color:#f9f6f2;',
    'border:1px solid rgba(61,51,42,.13);color:#f97316;',
    'box-shadow:0 8px 24px rgba(0,0,0,.10);',
    'transition:background-color .15s,border-color .15s,opacity .15s;}',
    '#qd-fab:hover{background-color:#f2eee9;}',
    '#qd-fab svg{width:22px;height:22px;}',
    'body.qd-open #qd-fab{opacity:0;pointer-events:none;}',

    '#qd-panel{position:fixed;right:26px;bottom:26px;z-index:99991;width:352px;max-width:92vw;',
    'max-height:72vh;overflow:auto;padding:16px 16px 14px;border-radius:18px;',
    'background-color:#f9f6f2;',
    'border:1px solid rgba(61,51,42,.13);color:#3b342c;',
    'box-shadow:0 8px 24px rgba(0,0,0,.10);',
    'opacity:0;pointer-events:none;',
    'transition:opacity .15s;}',
    '#qd-panel.show{opacity:1;pointer-events:auto;}',

    '.qd-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;}',
    '.qd-title{font-size:14px;font-weight:600;letter-spacing:.5px;}',
    '.qd-hint{font-size:11px;color:#6f675e;}',

    '.qd-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
    '.qd-cell{min-width:0;}',
    '.qd-cat{display:flex;align-items:center;gap:6px;font-size:12px;color:#3b342c;',
    'margin-bottom:6px;overflow:hidden;}',
    '.qd-cat svg{width:15px;height:15px;flex:none;}',
    '.qd-cat span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.qd-zone{height:66px;border:1.5px dashed rgba(61,51,42,.20);border-radius:10px;',
    'display:flex;flex-direction:column;gap:4px;align-items:center;justify-content:center;',
    'color:#6f675e;font-size:11px;background-color:#fbf9f6;',
    'transition:border-color .15s,background-color .15s;text-align:center;}',
    '.qd-zone svg{width:16px;height:16px;color:#f97316;}',
    '.qd-cell.hot .qd-zone{border-color:#f97316;border-style:solid;',
    'background-color:rgba(249,115,22,.10);color:#c2410c;}',
    '.qd-cell.qd-soft .qd-cat{color:#6f675e;}',

    '.qd-empty{grid-column:1/-1;text-align:center;color:#7d746a;font-size:12px;padding:14px 0 6px;}',

    '#qd-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);',
    'z-index:99999;padding:9px 16px;border-radius:12px;font-size:13px;color:#3b342c;',
    'background-color:#f9f6f2;border:1px solid rgba(61,51,42,.13);',
    'box-shadow:0 8px 24px rgba(0,0,0,.10);opacity:0;pointer-events:none;',
    'transition:opacity .15s;max-width:80vw;}',
    '#qd-toast.show{opacity:1;}'
  ].join('');

  /* ---------------- DOM ---------------- */
  var fab, panel, grid, toastEl;

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function iconSvg(name) {
    return '<svg aria-hidden="true"><use href="#' + name + '"></use></svg>';
  }

  function buildDom() {
    var style = document.createElement('style');
    style.id = 'qd-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    fab = el('div');
    fab.id = 'qd-fab';
    fab.title = '快投收藏：拖着图片靠近我';
    fab.innerHTML = iconSvg('i-tray-down');
    document.body.appendChild(fab);
    fab.addEventListener('click', function () { opened ? closePanel() : openPanel(); });

    panel = el('div');
    panel.id = 'qd-panel';
    panel.hidden = true;
    panel.innerHTML =
      '<div class="qd-head"><span class="qd-title">快投收藏</span>' +
      '<span class="qd-hint">拖到收藏夹 · Esc 关闭</span></div>';
    grid = el('div', 'qd-grid');
    panel.appendChild(grid);
    document.body.appendChild(panel);

    toastEl = el('div');
    toastEl.id = 'qd-toast';
    document.body.appendChild(toastEl);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && opened) {
        // 快投面板是页面最上层（z 99991），且本监听先于 app.js 注册：
        // 一次 Esc 只关快投自己，并拦住 app.js 的 Esc 关层链
        // （否则同一按键会把灯箱/分类弹窗/收录篮面板一起关掉）
        e.stopImmediatePropagation();
        closePanel();
      }
    });
  }

  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
  }

  /* ---------------- 展开与收回 ---------------- */
  function openPanel() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (opened) return;
    opened = true;
    refreshGrid();
    panel.hidden = false;
    document.body.classList.add('qd-open');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { panel.classList.add('show'); });
    });
  }

  function closePanel() {
    if (!opened) return;
    opened = false;
    dragDepth = 0;
    panel.classList.remove('show');
    document.body.classList.remove('qd-open');
    setTimeout(function () { if (!opened) panel.hidden = true; }, 240);
  }

  function scheduleClose() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(function () { closeTimer = null; closePanel(); }, 150);
  }

  /* ---------------- 收藏夹网格 ---------------- */
  function getCategories() {
    try {
      if (cfg.getCategories) return cfg.getCategories() || [];
    } catch (_) { /* app 未就绪 */ }
    return [];
  }

  function cellHtml(icon, name, zoneText, soft) {
    return '<div class="qd-cat">' + iconSvg(icon) + '<span>' + esc(name) + '</span></div>' +
      '<div class="qd-zone">' + iconSvg('i-download') + '<span>' + zoneText + '</span></div>';
  }

  function refreshGrid() {
    if (!grid) return;
    var cats = getCategories();
    grid.innerHTML = '';
    if (!cats.length) {
      grid.innerHTML = '<div class="qd-empty">还没有收藏夹，先拖到「未归类」吧</div>';
    }
    cats.forEach(function (c) {
      var cell = el('div', 'qd-cell');
      cell.dataset.cat = c.id || '';
      cell.innerHTML = cellHtml(c.icon || 'i-cat-folder', c.name || '收藏夹', '拖到这里收入');
      grid.appendChild(cell);
    });
    // 兜底：未归类投放格（无分类 / 拖丢的分类都归这里）
    var soft = el('div', 'qd-cell qd-soft');
    soft.dataset.cat = '';
    soft.innerHTML = cellHtml('i-inbox', '未归类', '不选分类，直接收入');
    grid.appendChild(soft);

    Array.prototype.forEach.call(grid.querySelectorAll('.qd-cell'), bindZone);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- 拖拽检测（document 级） ---------------- */
  function hasDragPayload(e) {
    try {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (!t) return false;
      for (var i = 0; i < t.length; i++) {
        if (t[i] === 'Files' || t[i] === 'text/uri-list') return true;
      }
    } catch (_) { /* 某些浏览器访问受限 */ }
    return false;
  }

  function bindZone(cell) {
    var zone = cell.querySelector('.qd-zone');
    if (!zone) return;
    cell.addEventListener('dragover', function (e) {
      e.preventDefault();          // 允许 drop
      e.stopPropagation();         // 不冒泡给 document
      cell.classList.add('hot');
    });
    cell.addEventListener('dragleave', function (e) {
      e.stopPropagation();
      cell.classList.remove('hot');
    });
    cell.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();         // 关键：阻断主页面通用导入，防重复
      cell.classList.remove('hot');
      var catId = cell.dataset.cat || null;
      dragDepth = 0;
      handleDrop(e.dataTransfer, catId);
      closePanel();
    });
  }

  function attachDocumentDrag() {
    document.addEventListener('dragenter', function (e) {
      if (!hasDragPayload(e)) return;
      dragDepth++;
      openPanel(); // 拖着图片进来 → 自动展开
    });
    document.addEventListener('dragover', function (e) {
      if (!opened) return;
      if (!hasDragPayload(e)) return;
      e.preventDefault(); // 保持 drop 能力
    });
    document.addEventListener('dragleave', function (e) {
      if (!hasDragPayload(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) scheduleClose(); // 完全拖出 → 收回
    });
    document.addEventListener('drop', function (e) {
      if (!opened) return;
      // 落在面板外的 drop：交给 app 原有导入逻辑，这里只收面板
      dragDepth = 0;
      closePanel();
    });
  }

  /* ---------------- 导入 ---------------- */
  function genId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) { /* 忽略 */ }
    return 'qd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function handleDrop(dt, catId) {
    var files = [];
    try { files = Array.prototype.slice.call((dt && dt.files) || []); } catch (_) { /* 忽略 */ }
    var url = '';
    try {
      url = (dt && (dt.getData('text/uri-list') || dt.getData('text/plain'))) || '';
    } catch (_) { /* 忽略 */ }
    url = (url || '').trim().split(/\r?\n/).filter(function (l) { return l && l.charAt(0) !== '#'; })[0] || '';

    if (files.length) saveFiles(files, catId);
    else if (/^https?:\/\//i.test(url)) saveUrl(url, catId);
    else toast('没有可导入的图片');
  }

  function imported(ok, fail) {
    if (ok) toast('已收入 ' + ok + ' 张' + (fail ? '（' + fail + ' 张失败）' : ''));
    if (ok && cfg.onImported) { try { cfg.onImported(); } catch (_) { /* 忽略 */ } }
  }

  function saveFiles(files, catId) {
    var ok = 0, fail = 0, done = 0;
    var total = files.length;
    files.forEach(function (f) {
      if (!f || !/^image\//.test(f.type || '')) { fail++; fin(); return; }
      var reader = new Promise(function (res, rej) {
        var r = new FileReader();
        r.onload = function () { res(new Blob([r.result], { type: f.type })); };
        r.onerror = function () { rej(r.error || new Error('read-fail')); };
        r.readAsArrayBuffer(f);
      });
      var dims = createImageBitmap(f).catch(function () { return null; });
      Promise.all([reader, dims]).then(function (arr) {
        var blob = arr[0], bmp = arr[1];
        var item = {
          id: genId(),
          name: (f.name || '图片').replace(/\.[a-z0-9]+$/i, ''),
          type: f.type, blob: blob, size: blob.size,
          width: bmp ? bmp.width : 0, height: bmp ? bmp.height : 0,
          prompt: '', categoryId: catId, favorite: false,
          sourceUrl: '', createdAt: Date.now(), deleted: 0
        };
        if (bmp && bmp.close) { try { bmp.close(); } catch (_) { /* 忽略 */ } }
        return window.VaultDB.importRecord(item).then(function () { ok++; });
      }).catch(function () { fail++; }).then(fin);
    });
    function fin() {
      done++;
      if (done >= total) imported(ok, fail);
    }
  }

  function saveUrl(url, catId) {
    fetch(url, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (b) {
      if (!/^image\//.test(b.type || '')) throw new Error('not-image');
      return createImageBitmap(b).catch(function () { return null; }).then(function (bmp) {
        var item = {
          id: genId(), name: '网页图片', type: b.type, blob: b, size: b.size,
          width: bmp ? bmp.width : 0, height: bmp ? bmp.height : 0,
          prompt: '', categoryId: catId, favorite: false,
          sourceUrl: url, createdAt: Date.now(), deleted: 0
        };
        if (bmp && bmp.close) { try { bmp.close(); } catch (_) { /* 忽略 */ } }
        return window.VaultDB.importRecord(item);
      });
    }).then(function () {
      imported(1, 0);
    }).catch(function () {
      // 跨域 / 失效 → 降级为外链收藏（与主程序策略一致）
      var item = {
        id: genId(), name: '网页图片', type: 'image/external', blob: null, size: 0,
        width: 0, height: 0, prompt: '', categoryId: catId, favorite: false,
        sourceUrl: url, createdAt: Date.now(), deleted: 0
      };
      window.VaultDB.importRecord(item).then(function () {
        toast('原图跨域，已收藏外链');
        if (cfg.onImported) { try { cfg.onImported(); } catch (_) { /* 忽略 */ } }
      }).catch(function () { toast('导入失败'); });
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (!document.body) {
      setTimeout(boot, 60);
      return;
    }
    buildDom();
    attachDocumentDrag();
    try { if (/[?&]qd-open=1/.test(location.search)) openPanel(); } catch (_) { /* 忽略 */ }
  }
  boot();

  window.QuickDrop = {
    /** app.js 在 IIFE 尾部调用，桥接分类数据与刷新回调 */
    install: function (c) {
      Object.assign(cfg, c || {});
      refreshGrid();
    },
    open: function () { openPanel(); },
    close: function () { closePanel(); }
  };
})();
