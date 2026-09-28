/* ============================================================
 * cat3d.js — 分类图标替换接口
 * ------------------------------------------------------------
 * v1.5 及以前：本文件还往 .cat-item 注入「按 --chip 上色的立体卡片」，v2.0 起分类改为单色 + 图标区分，不再依赖 --chip。
 *   分类之间靠颜色区分。
 * v2.0 起：界面统一为单色，分类只靠「图标 + 名称」区分。
 *   分类行的立体 / 光泽 / 浮起落下统一由 css/styles.css + css/ui3d.css
 *   接管（跟其它可点元素同一套规则），避免三处样式互相打架。
 *   本文件因此收窄为单一职责：
 *     1) 把位图图标（生图模型产物）灌到某个分类的 .cat-dot 上
 *     2) 保存到 localStorage（imgvault.catIcons），刷新后仍在
 *
 * ⚠️ 注意：位图图标与「单色」原则是有张力的 —— 图片自带颜色。
 *   内置的图标选择器（js/app.js）走的是内联 SVG 精灵表，天然单色，
 *   是首选方式；本接口只是留给「想用自定义图片当图标」的进阶场景。
 *
 * 全局导出：window.Cat3D
 *
 * 注：已按「界面安静朴素」的要求移除位图图标上残留的立体/光泽
 *   box-shadow（内嵌高光 + 投影），功能逻辑不变。
 * ============================================================ */
(function () {
  'use strict';

  var ICON_KEY = 'imgvault.catIcons';
  var icons = {};

  /* 只负责「有自定义位图图标」这一种状态的外观；分类行本身的样式不在这里 */
  var CSS = [
    '.cat-item.cat-has-img .cat-dot{background-image:var(--icon);background-size:cover;',
    'background-position:center;border-radius:5px;}',
    '.cat-item.cat-has-img .cat-dot svg{display:none;}',
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById('cat3d-style')) return;
    var s = document.createElement('style');
    s.id = 'cat3d-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function loadIcons() {
    try {
      var raw = localStorage.getItem(ICON_KEY);
      icons = raw ? (JSON.parse(raw) || {}) : {};
    } catch (_) { icons = {}; }
  }
  function saveIcons() {
    try { localStorage.setItem(ICON_KEY, JSON.stringify(icons)); } catch (_) { /* 忽略 */ }
  }

  /* 应用已保存的自定义图标 */
  function applyIcons() {
    var list = document.getElementById('cat-list');
    if (!list) return;
    var lis = list.querySelectorAll('.cat-item');
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var cid = li.dataset.cat;
      if (cid && icons[cid]) {
        li.style.setProperty('--icon', 'url("' + icons[cid] + '")');
        li.classList.add('cat-has-img');
      } else {
        li.classList.remove('cat-has-img');
        li.style.removeProperty('--icon');
      }
    }
  }

  function watchList() {
    var list = document.getElementById('cat-list');
    if (!list) return;
    applyIcons();
    // 分类增删 / 改名后 app.js 会重建列表，重建完要重新贴图标
    new MutationObserver(function () {
      try { applyIcons(); } catch (_) { /* 静默 */ }
    }).observe(list, { childList: true });
  }

  /* ---------- 对外接口：用位图替换分类图标 ---------- */
  window.Cat3D = {
    /** 给某个分类设置位图图标（dataUrl 或图片路径） */
    setIcon: function (categoryId, dataUrl) {
      if (!categoryId || !dataUrl) return;
      icons[categoryId] = dataUrl;
      saveIcons();
      applyIcons();
    },
    clearIcon: function (categoryId) {
      delete icons[categoryId];
      saveIcons();
      applyIcons();
    },
    list: function () { return Object.assign({}, icons); },
    /** 批量设置：{catId: dataUrl, ...} */
    setIcons: function (map) {
      Object.keys(map || {}).forEach(function (k) { icons[k] = map[k]; });
      saveIcons();
      applyIcons();
    },
    /** 清空全部位图图标，回到内置的单色 SVG 图标 */
    clearAll: function () {
      icons = {};
      saveIcons();
      applyIcons();
    },
  };

  function init() {
    try {
      ensureStyle();
      loadIcons();
      watchList();
    } catch (err) {
      try { console.warn('[分类图标] 初始化失败：', err); } catch (_) { /* 忽略 */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
