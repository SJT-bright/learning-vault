/* ============================================================
 * icons.js — 统一图标工具
 * 图标本体是 index.html 里内联的 <svg id="iv-sprite"> 精灵表，
 * 本文件只负责给「JS 动态创建」的节点生成 <svg><use> 结构，
 * 保证图标只有一份定义（零重复、零外部请求）。
 * 全局导出：window.Icons
 * ============================================================ */
(function () {
  'use strict';

  var SPRITE_ID = 'iv-sprite';

  // 精灵表里已声明的图标名（用于开发期提示，不抛错）
  var KNOWN = [
    // 界面图标
    'i-vault', 'i-gallery', 'i-prompts', 'i-inbox', 'i-window', 'i-search',
    'i-plus', 'i-star', 'i-star-fill', 'i-trash', 'i-download', 'i-close',
    'i-chevron-down', 'i-chevron-left', 'i-chevron-right', 'i-copy',
    'i-folder', 'i-folder-open', 'i-note', 'i-tray-down', 'i-check',
    // 分类图标库（图标选择器用，全部单色描边）
    'i-cat-folder', 'i-cat-star', 'i-cat-heart', 'i-cat-bookmark', 'i-cat-tag',
    'i-cat-image', 'i-cat-camera', 'i-cat-palette', 'i-cat-brush', 'i-cat-pencil',
    'i-cat-code', 'i-cat-cube', 'i-cat-rocket', 'i-cat-bulb', 'i-cat-book',
    'i-cat-music', 'i-cat-video', 'i-cat-gamepad', 'i-cat-coffee', 'i-cat-food',
    'i-cat-plane', 'i-cat-car', 'i-cat-home', 'i-cat-building', 'i-cat-map',
    'i-cat-compass', 'i-cat-flag', 'i-cat-gift', 'i-cat-leaf', 'i-cat-sun',
    'i-cat-moon', 'i-cat-cloud', 'i-cat-fire', 'i-cat-wave', 'i-cat-mountain',
    'i-cat-paw', 'i-cat-clock', 'i-cat-mail', 'i-cat-chat', 'i-cat-chart',
    'i-cat-lock', 'i-cat-key', 'i-cat-globe', 'i-cat-diamond', 'i-cat-crown',
    'i-cat-bell', 'i-cat-sparkle', 'i-cat-shield',
  ];

  function spriteReady() {
    return !!document.getElementById(SPRITE_ID);
  }

  function normalize(name) {
    var n = String(name == null ? '' : name).trim();
    if (!n) return '';
    return n.charAt(0) === '#' ? n.slice(1) : n;
  }

  /** 生成 <svg><use href="#id"></use></svg> 字符串（供 innerHTML 使用） */
  function svg(name, className, extraAttrs) {
    var id = normalize(name);
    if (!id) return '';
    if (KNOWN.indexOf(id) === -1) {
      try { console.warn('[Icons] 未声明的图标：' + id); } catch (_) { /* 忽略 */ }
    }
    var cls = 'ic' + (className ? ' ' + className : '');
    var attrs = extraAttrs ? ' ' + extraAttrs : '';
    return '<svg class="' + cls + '" aria-hidden="true" focusable="false"' + attrs +
      '><use href="#' + id + '"></use></svg>';
  }

  /** 生成真实 SVG 元素（供 appendChild 使用） */
  function el(name, className) {
    var id = normalize(name);
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'ic' + (className ? ' ' + className : ''));
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    var u = document.createElementNS(ns, 'use');
    u.setAttribute('href', '#' + id);
    // 兼容较老的渲染内核
    u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + id);
    s.appendChild(u);
    return s;
  }

  /** 替换已有 <use> 的图标（用于状态切换，如 星标 ↔ 已星标） */
  function setUse(useEl, name) {
    if (!useEl) return;
    var id = '#' + normalize(name);
    useEl.setAttribute('href', id);
    useEl.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', id);
  }

  window.Icons = {
    spriteId: SPRITE_ID,
    names: KNOWN.slice(),
    ready: spriteReady,
    svg: svg,
    el: el,
    setUse: setUse,
  };
})();
