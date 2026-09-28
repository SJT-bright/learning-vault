/* ============================================================
 * desktop.js — Electron 桌面壳专属的「原生毛玻璃」适配层
 * ------------------------------------------------------------
 * 背景：electron/main.js 已在 macOS 上开启原生毛玻璃
 * vibrancy('under-window')，但页面自己把底色画成不透明暖白，
 * 把磨砂效果完全盖住了。本文件只在桌面壳里生效
 * （window.imgvaultDesktop.isDesktop，由 electron/preload.js
 * 暴露），浏览器直接打开 index.html 时零影响。
 *
 * 做法：
 *   1) 页面底色透明（去掉 --bg / --bg-grad 的不透明铺底），
 *      让原生 vibrancy 从窗口底层透出来成为磨砂；
 *   2) 表面变量整体半透明化——styles.css 的面板全部走
 *      --glass / --glass-strong / --glass-soft / --panel 变量，
 *      在 :root 改写即可全局生效；
 *   3) 跟随系统外观做明暗两套玻璃（苹果原生行为）：
 *      浅色 = 暖白磨砂 + 深色文字；深色 = 暖黑磨砂 + 浅色文字。
 *      inbox.js / floatwin.js 注入样式里是字面色，用同色相的
 *      半透明值覆盖（!important 仅在桌面壳内生效）；
 *   4) mini 收录窗：画廊已由 inbox.js 的 applyMiniShell 隐藏，
 *      收录篮面板铺满窗口，整个小窗 = 一块圆角磨砂玻璃卡；
 *      缩略图卡片保持接近实色，保证图片可读。
 * ============================================================ */
(function () {
  'use strict';

  var desktop = null;
  try { desktop = window.imgvaultDesktop; } catch (_) { desktop = null; }

  /* 桌面玻璃壳判定：① 独立 Electron 壳（preload 暴露 imgvaultDesktop）；
   * ② 作为「学习资产库」分支时，收录钮窗口由主进程带 ?ivglass=1 打开。
   * 浏览器直接打开 / 学习资产库画廊窗（不带参数）都不启用，保持不透明暖白。 */
  var inGlassShell = false;
  try {
    inGlassShell = !!(desktop && desktop.isDesktop) ||
      /[?&]ivglass=1/.test(window.location.search);
  } catch (_) { inGlassShell = false; }
  if (!inGlassShell) return;

  var isMini = false;
  try {
    isMini = !!(desktop && desktop.isMini) || window.location.hash === '#inbox';
  } catch (_) { /* 忽略 */ }

  var css = [];

  /* ---------- 底色让位：原生 vibrancy 在窗口底层铺磨砂 ---------- */
  css.push(
    'html,body{background:transparent!important;background-image:none!important;}',
    'body::before,body::after{display:none!important;}'
  );

  /* ---------- 浅色系统外观：暖白磨砂 + 深色文字 ---------- */
  css.push(
    '@media (prefers-color-scheme: light){',
    ':root{',
    '--bg:transparent;',
    '--bg-grad:none;',
    '--glass:rgba(255,251,247,.66);',
    '--glass-strong:rgba(255,253,250,.80);',
    '--glass-soft:rgba(255,251,247,.58);',
    '--panel:rgba(255,251,247,.72);',
    '--panel-2:rgba(255,249,243,.62);',
    '}',
    '#ib-root .ib-panel{background-color:rgba(255,251,247,.68)!important;}',
    '#ib-root .ib-drop{background-color:rgba(255,255,255,.45)!important;}',
    '.fw-panel{background-color:rgba(255,251,247,.68)!important;}',
    '.fw-bubble{background-color:rgba(255,251,247,.66)!important;}',
    '}'
  );

  /* ---------- 深色系统外观：暖黑磨砂 + 浅色文字 ---------- */
  css.push(
    '@media (prefers-color-scheme: dark){',
    ':root{',
    '--bg:transparent;',
    '--bg-grad:none;',
    '--glass:rgba(40,33,27,.55);',
    '--glass-strong:rgba(48,40,33,.68);',
    '--glass-soft:rgba(36,29,24,.48);',
    '--panel:rgba(42,35,29,.60);',
    '--panel-2:rgba(52,43,36,.55);',
    '--field:rgba(18,14,11,.45);',
    '--field-bg:rgba(18,14,11,.45);',
    '--field-bg-focus:rgba(18,14,11,.55);',
    '--btn-face:rgba(255,244,235,.09);',
    '--btn-face-hover:rgba(255,244,235,.14);',
    '--btn-face-press:rgba(255,244,235,.09);',
    '--glass-stroke:rgba(255,244,235,.14);',
    '--hover-wash:rgba(255,244,235,.06);',
    '--text:#f3ede6;',
    '--muted:#bfb4a9;',
    '}',

    /* 收录篮：注入样式里的字面暖白 → 暖黑半透明 */
    '#ib-root{color:#f3ede6!important;}',
    '#ib-root .ib-panel{background-color:rgba(40,33,27,.62)!important;border-color:rgba(255,244,235,.14)!important;}',
    '#ib-root .ib-title,#ib-root .ib-drop b{color:#f3ede6!important;}',
    '#ib-root .ib-hint,#ib-root .ib-empty,#ib-root .ib-drop{color:#bfb4a9!important;}',
    '#ib-root .ib-drop{background-color:rgba(255,255,255,.06)!important;border-color:rgba(255,244,235,.18)!important;}',
    '#ib-root .ib-btn{color:#d8cfc5!important;border-color:rgba(255,244,235,.16)!important;}',
    '#ib-root .ib-btn:hover{background-color:rgba(255,244,235,.08)!important;}',
    '#ib-root .ib-sel,#ib-root .ib-x{background-color:rgba(18,14,11,.5)!important;color:#f3ede6!important;}',
    '#ib-root .ib-msg.ib-ok{color:#fb923c!important;}',
    '#ib-root .ib-msg.ib-err{color:#f87171!important;}',

    /* 悬浮小窗（页内浮层）：同色相暖黑 */
    '#fw-root{color:#f3ede6!important;}',
    '#fw-root .fw-panel{background-color:rgba(40,33,27,.62)!important;border-color:rgba(255,244,235,.14)!important;}',
    '#fw-root .fw-bubble{background-color:rgba(40,33,27,.55)!important;border-color:rgba(255,244,235,.14)!important;}',
    '#fw-root .fw-title{color:#f3ede6!important;}',
    '#fw-root .fw-hint{color:#bfb4a9!important;}',
    '#fw-root .fw-btn{color:#d8cfc5!important;}',
    '#fw-root .fw-btn:hover{background-color:rgba(255,244,235,.08)!important;}',
    '}'
  );

  if (isMini) {
    /* mini 窗：画廊已隐藏，收录篮铺满 = 整窗一块磨砂玻璃卡 */
    css.push(
      '#ib-root{left:0!important;top:0!important;right:0!important;bottom:0!important;}',
      '#ib-root .ib-panel{width:100%!important;max-width:100%!important;height:100%!important;}',
      /* 快投圆钮在 mini 窗里没有存在意义，还会叠在面板上 */
      '#qd-fab{display:none!important;}'
    );
  }

  function inject() {
    try {
      var s = document.createElement('style');
      s.id = 'dv-desktop-glass';
      s.textContent = css.join('');
      document.head.appendChild(s);
      document.body.classList.add(isMini ? 'dv-mini' : 'dv-desktop');
    } catch (_) { /* 桌面适配失败不影响主应用 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
