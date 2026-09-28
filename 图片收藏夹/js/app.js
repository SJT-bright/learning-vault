/* ============================================================
 * app.js — 图片收藏夹 ImageVault 交互逻辑
 * 依赖：js/db.js (window.VaultDB)、js/importer.js (window.Importer)
 * 事件：导入成功后 importer 会在 document 上派发 vault:changed
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 状态 ----------
  const state = {
    view: 'gallery',     // gallery | prompts
    catFilter: '',       // ''=全部，'__uncat'=未分类，其余=分类 id
    search: '',
    images: [],
    categories: [],
    lightboxId: null,
    sort: 'new', // new | old | name（v2.2）
  };

  // 图标选择器里的图标：顺序与 index.html 精灵表「分类图标库」一致。
  // 全界面单色，分类只靠「图标 + 名称」区分，不再有分类色。
  const CAT_ICONS = [
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

  const DEFAULT_CAT_ICON = 'i-cat-folder';

  // v2.3 内置分类图标（全部图片/待收录/星标/回收站）可更换，存 localStorage
  const BUILTIN_ICON_KEY = 'imgvault.builtinIcons';
  function builtinIconMap() {
    try { return JSON.parse(localStorage.getItem(BUILTIN_ICON_KEY)) || {}; } catch (_) { return {}; }
  }
  function builtinIcon(key) { return builtinIconMap()[key] || null; }
  function saveBuiltinIcon(key, icon) {
    const m = builtinIconMap();
    m[key] = icon;
    try { localStorage.setItem(BUILTIN_ICON_KEY, JSON.stringify(m)); } catch (_) { /* 忽略 */ }
    const li = els.catList && els.catList.querySelector('.cat-item[data-cat="' + key + '"]');
    const use = li && li.querySelector('.cat-dot use');
    if (use) use.setAttribute('href', '#' + icon);
  }
  function restoreBuiltinIcons() {
    const m = builtinIconMap();
    for (const key of Object.keys(m)) {
      const li = els.catList && els.catList.querySelector('.cat-item[data-cat="' + key + '"]');
      const use = li && li.querySelector('.cat-dot use');
      if (use) use.setAttribute('href', '#' + m[key]);
    }
  }
  /** 图片图标按钮状态（Cat3D 位图接口） */
  function syncImgIconButtons() {
    const key = catModalBuiltin || catModalId;
    const has = !!(key && window.Cat3D && Cat3D.list()[key]);
    if (els.cmImgClear) els.cmImgClear.hidden = !has;
  }

  // 图标的中文名（只用于 title 提示，帮助盲选）
  const ICON_LABELS = {
    'i-cat-folder': '文件夹', 'i-cat-star': '星标', 'i-cat-heart': '心形',
    'i-cat-bookmark': '书签', 'i-cat-tag': '标签', 'i-cat-image': '图片',
    'i-cat-camera': '相机', 'i-cat-palette': '调色板', 'i-cat-brush': '画笔',
    'i-cat-pencil': '铅笔', 'i-cat-code': '代码', 'i-cat-cube': '立方体',
    'i-cat-rocket': '火箭', 'i-cat-bulb': '灵感', 'i-cat-book': '书',
    'i-cat-music': '音乐', 'i-cat-video': '视频', 'i-cat-gamepad': '游戏',
    'i-cat-coffee': '咖啡', 'i-cat-food': '美食', 'i-cat-plane': '旅行',
    'i-cat-car': '汽车', 'i-cat-home': '家居', 'i-cat-building': '建筑',
    'i-cat-map': '地图', 'i-cat-compass': '指南针', 'i-cat-flag': '旗帜',
    'i-cat-gift': '礼物', 'i-cat-leaf': '植物', 'i-cat-sun': '太阳',
    'i-cat-moon': '月亮', 'i-cat-cloud': '云', 'i-cat-fire': '火焰',
    'i-cat-wave': '波浪', 'i-cat-mountain': '山', 'i-cat-paw': '宠物',
    'i-cat-clock': '时间', 'i-cat-mail': '邮件', 'i-cat-chat': '对话',
    'i-cat-chart': '数据', 'i-cat-lock': '私密', 'i-cat-key': '密钥',
    'i-cat-globe': '全球', 'i-cat-diamond': '精选', 'i-cat-crown': '收藏级',
    'i-cat-bell': '提醒', 'i-cat-sparkle': '灵感火花', 'i-cat-shield': '安全',
  };

  /** 分类图标名（兼容历史记录：老分类没有 icon 字段，回落到默认） */
  const catIcon = (c) => (c && builtinIcon(c.id)) || (c && c.icon) || DEFAULT_CAT_ICON;

  // ---------- DOM 快捷引用 ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    grid: $('grid'),
    emptyState: $('empty-state'),
    promptList: $('prompt-list'),
    promptEmpty: $('prompt-empty'),
    search: $('search'),
    btnImport: $('btn-import'),
    sortSelect: $('sort-select'),
    btnRefetchAll: $('btn-refetch-all'),
    fileInput: $('file-input'),
    catList: $('cat-list'),
    btnAddCat: $('btn-add-category'),
    countAll: $('count-all'),
    countUncat: $('count-uncat'),
    countFav: $('count-fav'),
    countTrash: $('count-trash'),
    btnExport: $('btn-backup-export'),
    // 注意：上面 btnImport 指顶栏「收藏图片」(#btn-import)，备份导入用独立属性，
    // 否则同名键覆盖会导致 #btn-import 永远绑不上事件、#btn-backup-import 双绑定
    btnBackupImport: $('btn-backup-import'),
    fileImport: $('file-import'),
    cmImgSet: $('cm-img-set'),
    cmImgClear: $('cm-img-clear'),
    cmImgFile: $('cm-img-file'),
    stats: $('stats'),
    dropOverlay: $('drop-overlay'),
    lightbox: $('lightbox'),
    lbImg: $('lb-img'),
    lbName: $('lb-name'),
    lbMeta: $('lb-meta'),
    lbCatSelect: $('lb-cat-select'),
    lbFav: $('lb-fav'),
    lbFavUse: $('lb-fav-use'),
    lbFavText: $('lb-fav-text'),
    lbDownload: $('lb-download'),
    lbRefetch: $('lb-refetch'),
    lbDelete: $('lb-delete'),
    lbClose: $('lb-close'),
    lbPrev: $('lb-prev'),
    lbNext: $('lb-next'),
    promptDrawer: $('prompt-drawer'),
    promptToggle: $('prompt-toggle'),
    promptText: $('prompt-text'),
    promptSaveState: $('prompt-save-state'),
    btnCopyPrompt: $('btn-copy-prompt'),
    toastZone: $('toast-zone'),
    // 分类弹窗
    catModal: $('cat-modal'),
    cmTitle: $('cm-title'),
    cmName: $('cm-name'),
    cmIcons: $('cm-icons'),
    cmPreview: $('cm-icon-preview'),
    cmOk: $('cm-ok'),
    cmOkText: $('cm-ok-text'),
    cmClose: $('cm-close'),
    cmCancel: $('cm-cancel'),
  };

  // ---------- objectURL 缓存（防泄漏） ----------
  const urlCache = new Map(); // id -> objectURL
  function ensureURL(img) {
    // v2.2：外链记录（blob 为 null）直接用原图 URL 展示
    if (!img.blob) return img.sourceUrl || '';
    if (!urlCache.has(img.id)) urlCache.set(img.id, URL.createObjectURL(img.blob));
    return urlCache.get(img.id);
  }
  function pruneURLs() {
    const ids = new Set(state.images.map((i) => i.id));
    for (const [id, url] of urlCache) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(url);
        urlCache.delete(id);
      }
    }
  }

  // ---------- 小工具 ----------
  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // 回退方案：隐藏 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    els.toastZone.appendChild(t);
    setTimeout(() => t.classList.add('toast-out'), 2400);
    setTimeout(() => t.remove(), 2900);
  }
  /** v2.4：聚焦顶部搜索框并全选（「/」与 Cmd/Ctrl+F 快捷键共用） */
  function focusSearch() {
    if (!els.search) return;
    try {
      els.search.focus();
      els.search.select();
    } catch (_) { /* 忽略 */ }
  }

  // ---------- 数据加载 ----------
  async function loadImages() {
    state.images = await VaultDB.listImages();
  }
  async function loadAll() {
    state.categories = await VaultDB.listCategories();
    await loadImages();
  }

  // ---------- 过滤 ----------
  function currentList() {
    let list = state.images;
    // v2.3 回收站视图隔离：回收站只看已删，其余视图只看未删
    const inTrashView = state.catFilter === '__trash';
    list = inTrashView ? list.filter((i) => i.deleted) : list.filter((i) => !i.deleted);
    if (state.catFilter === '__uncat') list = list.filter((i) => !i.categoryId);
    else if (state.catFilter === '__fav') list = list.filter((i) => !!i.favorite);
    else if (state.catFilter) list = list.filter((i) => i.categoryId === state.catFilter);
    const q = state.search.trim().toLowerCase();
    if (q) {
      list = list.filter((i) =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.prompt || '').toLowerCase().includes(q));
    }
    list = list.slice(); // 不改动 state.images 原顺序
    const sort = state.sort || 'new'; // v2.2 排序
    if (sort === 'name') list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN'));
    else if (sort === 'old') list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    else list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return list;
  }

  // ---------- 渲染 ----------
  function renderAll() {
    renderCats();
    renderGrid();
    renderPromptList();
    updateStats();
  }

  function renderCats() {
    // 清掉旧的动态分类项（内置三项带 data-builtin，保留）
    els.catList.querySelectorAll('.cat-item:not([data-builtin])').forEach((li) => li.remove());
    // v2.3 回收站隔离：分类计数同样排除已删图片，与点击分类后实际看到的列表一致
    const countFor = (cid) => state.images.filter((i) => !i.deleted && i.categoryId === cid).length;
    for (const c of state.categories) {
      const li = document.createElement('li');
      li.className = 'cat-item' + (state.catFilter === c.id ? ' active' : '');
      li.dataset.cat = c.id;
      li.innerHTML =
        '<span class="cat-dot">' + Icons.svg(catIcon(c)) + '</span>' +
        '<span class="cat-name">' + esc(c.name) + '</span>' +
        '<span class="cat-count">' + countFor(c.id) + '</span>' +
        '<button class="cat-edit" title="修改名称与图标">' + Icons.svg('i-cat-pencil', 'ic-xs') + '</button>' +
        '<button class="cat-del" title="删除分类">' + Icons.svg('i-close', 'ic-xs') + '</button>';
      els.catList.appendChild(li);
    }
    // 内置项的选中态与计数
    els.catList.querySelectorAll('.cat-item[data-builtin]').forEach((li) => {
      li.classList.toggle('active', state.catFilter === li.dataset.cat);
    });
    const aliveCats = state.images.filter((i) => !i.deleted); // v2.3 排除回收站
    els.countAll.textContent = String(aliveCats.length);
    els.countUncat.textContent = String(aliveCats.filter((i) => !i.categoryId).length);
    if (els.countFav) {
      els.countFav.textContent = String(aliveCats.filter((i) => !!i.favorite).length);
    }
    if (els.countTrash) {
      els.countTrash.textContent = String(state.images.length - aliveCats.length);
    }
  }

  function setEmptyCopy() {
    const title = els.emptyState.querySelector('.empty-title');
    const desc = els.emptyState.querySelector('.empty-desc');
    if (!title || !desc) return;
    if (state.images.length === 0) {
      title.textContent = '收藏夹还是空的';
      desc.innerHTML = '把图片拖进这个窗口，或按 Ctrl+V 粘贴截图，<br>点右上角「收藏图片」也可以。图片会永久保存在本地浏览器里。';
    } else if (state.catFilter === '__fav' && !state.search.trim()) {
      title.textContent = '还没有星标图片';
      desc.innerHTML = '把鼠标移到任意图片上，点右上角的星星，<br>它就会出现在这里，方便随时取用。';
    } else if (state.catFilter === '__trash' && !state.search.trim()) {
      title.textContent = '回收站是空的';
      desc.innerHTML = '删除的图片会先到这里，随时可以恢复；<br>确定不要的，再进来彻底清除。';
    } else {
      title.textContent = '没有找到匹配的图片';
      desc.innerHTML = '换个关键词或换一个分类试试。';
    }
  }

  function renderGrid() {
    pruneURLs();
    const list = currentList();
    els.grid.innerHTML = '';
    const catMap = new Map(state.categories.map((c) => [c.id, c]));
    for (const [index, img] of list.entries()) {
      const fig = document.createElement('figure');
      fig.className = 'card';
      fig.classList.add('stagger'); // 错峰入场：cardIn + --i 延迟（样式见 styles.css .card.stagger）
      fig.style.setProperty('--i', String(Math.min(index, 20))); // 索引封顶 20，避免大网格尾部等待过久
      fig.dataset.id = img.id;
      fig.dataset.fav = img.favorite ? '1' : '';
      const inTrash = state.catFilter === '__trash'; // v2.3
      fig.draggable = !inTrash;
      const cat = img.categoryId ? catMap.get(img.categoryId) : null;
      const isRef = !img.blob && !!img.sourceUrl; // v2.2：外链记录
      const chips =
        (isRef ? '<span class="cat-chip ext-chip" title="网页外链图片（原图受跨域限制，已保存链接）">' + Icons.svg('i-link', 'ic-xs') + '<span class="cat-chip-text">外链</span></span>' : '') +
        (cat ? '<span class="cat-chip">' + Icons.svg(catIcon(cat), 'ic-xs') + '<span class="cat-chip-text">' + esc(cat.name) + '</span></span>' : '');
      fig.innerHTML =
        '<img src="' + ensureURL(img) + '" alt="' + esc(img.name) + '" loading="lazy" draggable="false"' +
        (isRef ? ' referrerpolicy="no-referrer"' : '') + '>' +
        (chips ? '<span class="card-chips">' + chips + '</span>' : '') +
        (img.favorite ? '<span class="fav-star">' + Icons.svg('i-star-fill') + '</span>' : '') +
        '<div class="card-actions">' +
        (inTrash
          ? '<button class="act-restore" title="恢复到收藏夹">' + Icons.svg('i-check') + '</button>' +
            '<button class="act-purge" title="彻底删除">' + Icons.svg('i-trash') + '</button>'
          : '<button class="act-fav" title="' + (img.favorite ? '取消星标' : '星标') + '">' +
            Icons.svg(img.favorite ? 'i-star-fill' : 'i-star') + '</button>' +
            '<button class="act-del" title="删除">' + Icons.svg('i-trash') + '</button>') +
        '</div>' +
        '<figcaption class="card-bar">' + esc(img.name) + '</figcaption>';
      els.grid.appendChild(fig);
    }
    if (state.view === 'gallery') {
      const none = list.length === 0;
      els.emptyState.hidden = !none;
      els.grid.style.display = none ? 'none' : '';
      setEmptyCopy();
    }
  }

  function renderPromptList() {
    pruneURLs();
    const q = state.search.trim().toLowerCase();
    // v2.3 回收站隔离：已删图片的提示词不再出现在提示词库
    let list = state.images.filter((i) => !i.deleted && (i.prompt || '').trim());
    if (q) {
      list = list.filter((i) =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.prompt || '').toLowerCase().includes(q));
    }
    els.promptList.innerHTML = '';
    for (const img of list) {
      const div = document.createElement('div');
      div.className = 'prompt-item';
      div.dataset.id = img.id;
      const isRef = !img.blob && !!img.sourceUrl; // v2.2：外链缩略图绕过防盗链
      div.innerHTML =
        '<img class="prompt-thumb" src="' + ensureURL(img) + '" alt=""' +
        (isRef ? ' referrerpolicy="no-referrer"' : '') + '>' +
        '<div class="prompt-content">' +
        '<div class="prompt-name">' + esc(img.name) + '</div>' +
        '<div class="prompt-text-display">' + esc(img.prompt) + '</div>' +
        '</div>' +
        '<button class="prompt-copy" title="复制提示词">' + Icons.svg('i-copy', 'ic-sm') + '<span>复制</span></button>';
      els.promptList.appendChild(div);
    }
    const none = list.length === 0;
    els.promptEmpty.hidden = !none;
    els.promptList.style.display = none ? 'none' : '';
  }

  function updateStats() {
    const alive = state.images.filter((i) => !i.deleted); // v2.3 排除回收站
    const total = alive.reduce((s, i) => s + (i.size || 0), 0);
    if (state.catFilter === '__trash') {
      els.stats.textContent = '回收站 ' + (state.images.length - alive.length) + ' 张 · 可恢复';
    } else {
      els.stats.textContent = '共 ' + alive.length + ' 张 · ' + fmtSize(total);
    }
    const refCount = alive.filter((it) => !it.blob && it.sourceUrl).length; // v2.2
    els.btnRefetchAll.hidden = refCount === 0;
    els.btnRefetchAll.textContent = '补抓外链（' + refCount + '）';
  }

  // ---------- 星标 / 删除 ----------
  /** 在网格里按 id 找卡片（不用属性选择器，避免 id 含特殊字符时出错） */
  function findCard(id) {
    const cards = els.grid.children;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].dataset && cards[i].dataset.id === id) return cards[i];
    }
    return null;
  }

  /** 就地同步单张卡片的星标外观（不重建整片网格，避免入场动画重放闪烁） */
  function syncCardFav(img) {
    const card = findCard(img.id);
    if (!card) return;
    card.dataset.fav = img.favorite ? '1' : '';
    const btn = card.querySelector('.act-fav');
    if (btn) {
      btn.title = img.favorite ? '取消星标' : '星标';
      btn.innerHTML = Icons.svg(img.favorite ? 'i-star-fill' : 'i-star');
    }
    let star = card.querySelector('.fav-star');
    if (img.favorite) {
      if (!star) {
        star = document.createElement('span');
        star.className = 'fav-star';
        star.innerHTML = Icons.svg('i-star-fill');
        const actions = card.querySelector('.card-actions');
        if (actions) card.insertBefore(star, actions);
        else card.appendChild(star);
      }
    } else if (star) {
      star.remove();
    }
  }

  async function toggleFav(id) {
    const img = state.images.find((i) => i.id === id);
    if (!img) return;
    const next = !img.favorite;
    try {
      await VaultDB.updateImage(id, { favorite: next });
    } catch (err) {
      toast('操作失败：' + err.message);
      return;
    }
    img.favorite = next;
    syncCardFav(img);
    renderCats();   // 刷新「星标收藏」计数
    updateStats();
    if (state.catFilter === '__fav') renderGrid(); // 星标视图需要真正增删卡片
    if (state.lightboxId === id) updateLbFav(img);
    toast(next ? '已加入星标' : '已取消星标');
  }

  function cancelPromptSave() {
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimer = null;
    }
  }

  async function deleteImageFlow(id) {
    const img = state.images.find((i) => i.id === id);
    if (!img) return;
    if (!confirm('把「' + (img.name || '这张图片') + '」移入回收站吗？')) return;
    try {
      await VaultDB.updateImage(id, { deleted: 1 }); // v2.3 软删除，可恢复
    } catch (err) {
      toast('操作失败：' + err.message);
      return;
    }
    cancelPromptSave(); // 防止挂起的提示词保存把记录复活
    img.deleted = 1;
    if (state.lightboxId === id) {
      state.lightboxId = null;
      els.lightbox.hidden = true;
    }
    pruneURLs();
    renderAll();
    toast('已移入回收站，可随时恢复');
  }

  /** v2.3 回收站：恢复 */
  async function restoreImage(id) {
    const img = state.images.find((i) => i.id === id);
    if (!img) return;
    try {
      await VaultDB.updateImage(id, { deleted: 0 });
    } catch (err) {
      toast('恢复失败：' + err.message);
      return;
    }
    img.deleted = 0;
    pruneURLs();
    renderAll();
    toast('已恢复「' + (img.name || '图片') + '」');
  }

  /** v2.3 回收站：彻底删除（不可恢复） */
  async function purgeImage(id) {
    const img = state.images.find((i) => i.id === id);
    if (!img) return;
    if (!confirm('彻底删除「' + (img.name || '这张图片') + '」？此操作不可恢复。')) return;
    try {
      await VaultDB.deleteImage(id);
    } catch (err) {
      toast('删除失败：' + err.message);
      return;
    }
    state.images = state.images.filter((i) => i.id !== id);
    if (state.lightboxId === id) {
      state.lightboxId = null;
      els.lightbox.hidden = true;
    }
    pruneURLs();
    renderAll();
    toast('已彻底删除');
  }

  /** v2.3 备份：blob -> dataURL */
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('读取失败'));
      r.readAsDataURL(blob);
    });
  }

  /** v2.3 备份：导出全部图片（含回收站）+ 分类 + 提示词为 JSON */
  async function exportBackup() {
    try {
      toast('正在打包备份，请稍候…');
      const images = [];
      for (const it of state.images) {
        const rec = {
          id: it.id, name: it.name, type: it.type, size: it.size,
          width: it.width, height: it.height, prompt: it.prompt || '',
          categoryId: it.categoryId || null, favorite: !!it.favorite,
          sourceUrl: it.sourceUrl || '', createdAt: it.createdAt || 0,
          deleted: it.deleted || 0
        };
        if (it.blob) rec.data = await blobToDataURL(it.blob);
        images.push(rec);
      }
      const payload = {
        app: 'imgvault', version: 1, exportedAt: new Date().toISOString(),
        categories: JSON.parse(JSON.stringify(state.categories)), images
      };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '拾光图库备份-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('已导出 ' + images.length + ' 张（' + fmtSize(blob.size) + '）');
    } catch (err) {
      toast('导出失败：' + err.message);
    }
  }

  /** v2.3 备份：从导出的 JSON 恢复（重复 id 跳过，分类按名称合并） */
  async function importBackupFile(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'imgvault' || !Array.isArray(data.images)) {
        toast('文件格式不对：需要本库「导出备份」生成的 JSON');
        return;
      }
      const catMap = new Map(); // 旧分类 id -> 本库分类 id
      for (const c of (data.categories || [])) {
        if (!c || !c.name) continue;
        const exist = state.categories.find((x) => x.name === c.name);
        if (exist) { catMap.set(c.id, exist.id); continue; }
        try {
          const created = await VaultDB.addCategory(c.name, c.icon);
          if (created && created.id) { catMap.set(c.id, created.id); state.categories.push(created); }
        } catch (e) { /* 单个分类失败不阻断 */ }
      }
      const existing = new Set(state.images.map((i) => i.id));
      let added = 0, skipped = 0;
      for (const rec of data.images) {
        if (!rec || existing.has(rec.id)) { skipped++; continue; }
        let blob = null;
        if (rec.data) { try { blob = await (await fetch(rec.data)).blob(); } catch (e) { blob = null; } }
        if (!blob && !rec.sourceUrl) { skipped++; continue; } // 无图无外链，丢弃
        const item = {
          id: rec.id, name: rec.name || '未命名图片',
          type: rec.type || (blob && blob.type) || '', blob,
          width: Number(rec.width) || 0, height: Number(rec.height) || 0,
          size: Number(rec.size) || (blob && blob.size) || 0,
          prompt: rec.prompt || '', categoryId: catMap.get(rec.categoryId) || null,
          favorite: !!rec.favorite, sourceUrl: rec.sourceUrl || '',
          createdAt: Number(rec.createdAt) || Date.now(), deleted: rec.deleted || 0
        };
        try {
          await VaultDB.importRecord(item);
          state.images.push(item);
          existing.add(item.id);
          added++;
        } catch (e) { skipped++; }
      }
      renderAll();
      toast('导入完成：新增 ' + added + ' 张' + (skipped ? '，跳过 ' + skipped + ' 条' : ''));
    } catch (err) {
      toast('导入失败：' + err.message);
    }
  }

  // ---------- 灯箱 ----------
  function updateLbFav(img) {
    Icons.setUse(els.lbFavUse, img.favorite ? 'i-star-fill' : 'i-star');
    if (els.lbFavText) els.lbFavText.textContent = img.favorite ? '已星标' : '星标';
    els.lbFav.title = img.favorite ? '取消星标' : '星标';
  }

  function openLightbox(id) {
    flushPromptSave(); // 换图前先把上一张的提示词落库
    const img = state.images.find((i) => i.id === id);
    if (!img) return;
    state.lightboxId = id;
    els.lbImg.src = ensureURL(img);
    els.lbImg.dataset.isRef = (!img.blob && img.sourceUrl) ? '1' : '0'; // v2.2 外链记录
    els.lbImg.referrerPolicy = (!img.blob && img.sourceUrl) ? 'no-referrer' : '';
    els.lbRefetch.hidden = !(!img.blob && img.sourceUrl); // 仅外链记录可补抓
    els.lbName.value = img.name || '';
    els.lbMeta.textContent =
      (img.width || '?') + '×' + (img.height || '?') + ' · ' + fmtSize(img.size) + ' · ' + fmtDate(img.createdAt);
    // 分类下拉
    els.lbCatSelect.innerHTML = '';
    const optUncat = document.createElement('option');
    optUncat.value = '';
    optUncat.textContent = '待收录';
    els.lbCatSelect.appendChild(optUncat);
    for (const c of state.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      els.lbCatSelect.appendChild(o);
    }
    els.lbCatSelect.value = img.categoryId || '';
    updateLbFav(img);
    els.promptText.value = img.prompt || '';
    els.promptSaveState.textContent = '';
    els.promptSaveState.dataset.state = '';
    els.promptDrawer.classList.add('collapsed'); // 每次打开默认折叠
    els.lightbox.hidden = false;
    // 灯箱内容浮起入场（fx2）；方向切图时改用左右浅入
    const stage = els.lightbox.querySelector('.lb-body');
    if (stage) {
      stage.classList.remove('lb-panel-in', 'lb-slide-l', 'lb-slide-r');
      void stage.offsetWidth;
      stage.classList.add(lbNavDir > 0 ? 'lb-slide-l' : lbNavDir < 0 ? 'lb-slide-r' : 'lb-panel-in');
      lbNavDir = 0;
    }
  }

  function closeLightbox() {
    flushPromptSave();
    state.lightboxId = null;
    els.lightbox.hidden = true;
  }

  let lbNavDir = 0; // 灯箱方向切图：±1（fx2）
  function navigate(dir) {
    const list = currentList();
    if (!list.length) return;
    const idx = list.findIndex((i) => i.id === state.lightboxId);
    if (idx === -1) {
      openLightbox(list[0].id);
      return;
    }
    const next = list[(idx + dir + list.length) % list.length];
    lbNavDir = dir;
    openLightbox(next.id);
  }

  // ---------- 提示词抽屉（防抖自动保存） ----------
  let promptTimer = null;

  function flushPromptSave() {
    if (!promptTimer || !state.lightboxId) return;
    clearTimeout(promptTimer);
    promptTimer = null;
    const id = state.lightboxId;
    const text = els.promptText.value;
    if (!state.images.some((i) => i.id === id)) return; // 图片已删除则放弃
    VaultDB.updateImage(id, { prompt: text })
      .then(() => {
        const img = state.images.find((i) => i.id === id);
        if (img) img.prompt = text;
        renderPromptList();
      })
      .catch((err) => toast('提示词保存失败：' + err.message));
  }

  // ---------- 分类弹窗（名称 + 图标选择） ----------
  let catModalMode = 'create';       // create | edit
  let catModalId = null;             // edit 模式下正在改的分类 id
  let catModalBuiltin = null;        // v2.3 内置项 key（__trash 等）：仅换图标模式
  let catModalIcon = DEFAULT_CAT_ICON;

  function syncIconPreview() {
    if (els.cmPreview) els.cmPreview.innerHTML = Icons.svg(catModalIcon, 'ic-sm');
  }

  function renderIconGrid() {
    if (!els.cmIcons) return;
    const frag = document.createDocumentFragment();
    for (const name of CAT_ICONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cm-icon' + (name === catModalIcon ? ' selected' : '');
      b.dataset.icon = name;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', name === catModalIcon ? 'true' : 'false');
      b.title = ICON_LABELS[name] || name;
      b.innerHTML = Icons.svg(name);
      frag.appendChild(b);
    }
    els.cmIcons.innerHTML = '';
    els.cmIcons.appendChild(frag);
    syncIconPreview();
  }

  function selectIcon(name) {
    if (CAT_ICONS.indexOf(name) === -1) return;
    catModalIcon = name;
    if (els.cmIcons) {
      els.cmIcons.querySelectorAll('.cm-icon').forEach((b) => {
        const on = b.dataset.icon === name;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    syncIconPreview();
  }

  /** 打开弹窗。传分类对象 = 编辑，传 null = 新建 */
  function openCatModal(cat, builtinKey) {
    if (!els.catModal) return;
    catModalBuiltin = builtinKey || null; // v2.3 内置项（仅换图标）
    catModalMode = cat ? 'edit' : (catModalBuiltin ? 'edit' : 'create');
    catModalId = cat ? cat.id : null;
    catModalIcon = cat ? catIcon(cat) : (catModalBuiltin ? (builtinIcon(catModalBuiltin) || DEFAULT_CAT_ICON) : DEFAULT_CAT_ICON);
    els.cmTitle.textContent = cat ? '修改分类' : (catModalBuiltin ? '更换图标' : '新建分类');
    els.cmOkText.textContent = cat ? '保存' : (catModalBuiltin ? '完成' : '创建');
    const nameLabel = document.querySelector('.cm-label[for="cm-name"]');
    els.cmName.hidden = !!catModalBuiltin;
    if (nameLabel) nameLabel.hidden = !!catModalBuiltin;
    els.cmName.value = cat ? cat.name : '';
    renderIconGrid();
    syncImgIconButtons();
    els.catModal.hidden = false;
    { const box = els.catModal.querySelector('.cm-panel') || els.catModal; box.classList.remove('cat-pop-in'); void box.offsetWidth; box.classList.add('cat-pop-in'); } // fx2
    // 打开后聚焦名称框（选中已有文字，便于直接覆盖）
    setTimeout(() => {
      if (!catModalBuiltin) {
        try { els.cmName.focus(); els.cmName.select(); } catch (_) { /* 忽略 */ }
      }
    }, 0);
  }

  function closeCatModal() {
    if (els.catModal) els.catModal.hidden = true;
    catModalId = null;
    catModalBuiltin = null;
    els.cmName.hidden = false;
    const nameLabel = document.querySelector('.cm-label[for="cm-name"]');
    if (nameLabel) nameLabel.hidden = false;
  }

  async function submitCatModal() {
    if (catModalBuiltin) { // v2.3 内置项：只保存图标
      saveBuiltinIcon(catModalBuiltin, catModalIcon);
      closeCatModal();
      toast('图标已更换');
      return;
    }
    const name = (els.cmName.value || '').trim();
    if (!name) {
      toast('请先填写分类名称');
      try { els.cmName.focus(); } catch (_) { /* 忽略 */ }
      return;
    }
    try {
      if (catModalMode === 'edit' && catModalId) {
        await VaultDB.updateCategory(catModalId, { name: name, icon: catModalIcon });
        state.categories = await VaultDB.listCategories();
        closeCatModal();
        renderAll();
        toast('已保存「' + name + '」');
      } else {
        await VaultDB.addCategory(name, catModalIcon);
        state.categories = await VaultDB.listCategories();
        closeCatModal();
        renderCats();
        toast('已创建分类「' + name + '」');
      }
    } catch (err) {
      toast('保存失败：' + err.message);
    }
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    // 视图切换
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.view;
        state.view = v;
        // 只在真正的视图按钮（带 data-view）间切换高亮；
        // 收录篮/悬浮小窗的 nav-item 没有 data-view，其 active 表示「功能已启用」
        document.querySelectorAll('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b === btn));
        $('view-gallery').classList.toggle('active', v === 'gallery');
        $('view-prompts').classList.toggle('active', v === 'prompts');
        if (v === 'prompts') renderPromptList();
        else renderGrid();
      });
    });

    // 搜索（同时作用于两个视图）
    els.search.addEventListener('input', () => {
      state.search = els.search.value;
      renderGrid();
      renderPromptList();
    });
    els.sortSelect.addEventListener('change', () => {
      state.sort = els.sortSelect.value;
      try { localStorage.setItem('imgvault.sort', state.sort); } catch (_) {}
      renderGrid();
    });
    els.btnRefetchAll.addEventListener('click', refetchAllRefs);
    // v2.3 备份导出 / 导入
    els.btnExport.addEventListener('click', exportBackup);
    els.btnBackupImport.addEventListener('click', () => els.fileImport.click());
    els.fileImport.addEventListener('change', () => {
      const f = els.fileImport.files && els.fileImport.files[0];
      els.fileImport.value = '';
      if (f) importBackupFile(f);
    });
    // v2.3 用图片当分类图标（Cat3D 位图接口）
    els.cmImgSet.addEventListener('click', () => els.cmImgFile.click());
    els.cmImgFile.addEventListener('change', () => {
      const f = els.cmImgFile.files && els.cmImgFile.files[0];
      els.cmImgFile.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { toast('请选择图片文件'); return; }
      const key = catModalBuiltin || catModalId;
      if (!key) { toast('请先创建分类，再设置图片图标'); return; }
      const r = new FileReader();
      r.onload = () => {
        if (window.Cat3D) Cat3D.setIcon(key, r.result);
        syncImgIconButtons();
        toast('图片图标已应用');
      };
      r.readAsDataURL(f);
    });
    els.cmImgClear.addEventListener('click', () => {
      const key = catModalBuiltin || catModalId;
      if (key && window.Cat3D) {
        Cat3D.clearIcon(key);
        syncImgIconButtons();
        toast('已恢复线条图标');
      }
    });

    // 按钮导入（文件选择器 → DataTransfer → Importer）
    els.btnImport.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', async () => {
      const files = Array.from(els.fileInput.files || []);
      els.fileInput.value = '';
      if (!files.length) return;
      try {
        let dt;
        try {
          dt = new DataTransfer();
          files.forEach((f) => dt.items.add(f));
        } catch (_) {
          toast('当前浏览器不支持按钮导入，请直接拖入或 Ctrl+V 粘贴');
          return;
        }
        const res = await Importer.fromDataTransfer(dt);
        if (!res || !res.added) toast('没有可收藏的图片');
      } catch (err) {
        toast('导入失败：' + err.message);
      }
    });

    // 全局拖放
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      els.dropOverlay.hidden = false;
    });
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // 允许 drop
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) els.dropOverlay.hidden = true;
    });
    document.addEventListener('dragend', () => {
      dragDepth = 0;
      els.dropOverlay.hidden = true;
    });
    document.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      els.dropOverlay.hidden = true;
      try {
        const res = await Importer.fromDataTransfer(e.dataTransfer);
        if (!res || !res.added) toast('没有可收藏的图片');
      } catch (err) {
        toast('导入失败：' + err.message);
      }
    });

    // 粘贴导入
    document.addEventListener('paste', async (e) => {
      if (!e.clipboardData || !e.clipboardData.items) return;
      try {
        const res = await Importer.fromClipboard(e.clipboardData.items);
        if (res && res.added) { /* toast 由 vault:changed 统一负责 */ }
      } catch (err) {
        toast('粘贴导入失败：' + err.message);
      }
    });

    // 数据变更 → 刷新（分类与图片一起重载，保证跨模块状态一致）
    document.addEventListener('vault:changed', async (e) => {
      try {
        await loadAll();
      } catch (err) {
        toast('刷新失败：' + err.message);
        return;
      }
      // 若当前选中的分类已被删除，自动回到「全部图片」，避免停在空白视图
      if (state.catFilter && state.catFilter !== '__uncat' && state.catFilter !== '__fav' &&
          !state.categories.some((c) => c.id === state.catFilter)) {
        state.catFilter = '';
      }
      renderAll();
      const detail = e.detail || {};
      const n = detail.added;
      // 收录篮会给出更精确的提示（含目标分类），这里不重复弹
      const linked = detail && detail.linked ? detail.linked : 0;
      if (n && linked > 0) toast('已收藏 ' + n + ' 张（' + linked + ' 张为外链，原图受跨域限制）');
      else if (n && detail.via !== 'inbox') toast('已收藏 ' + n + ' 张（可在「待收录」里分类）');
    });

    // 网格：点击（星标/删除/打开灯箱）与拖拽源
    els.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id;
      if (e.target.closest('.act-fav')) { toggleFav(id); return; }
      if (e.target.closest('.act-del')) { deleteImageFlow(id); return; }
      if (e.target.closest('.act-restore')) { restoreImage(id); return; }
      if (e.target.closest('.act-purge')) { purgeImage(id); return; }
      if (e.target.closest('.card-actions')) return;
      openLightbox(id);
    });
    els.grid.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      e.dataTransfer.setData('application/x-vault-id', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });

    // 分类侧栏：点击切换 / 删除 / 拖入归类（事件委托）
    els.catList.addEventListener('click', async (e) => {
      const item = e.target.closest('.cat-item');
      if (!item) return;
      // 修改名称与图标
      const edit = e.target.closest('.cat-edit');
      if (edit) {
        const cid = item.dataset.cat;
        if (item.dataset.builtin) { openCatModal(null, cid); return; } // v2.3 内置项仅换图标
        const c = state.categories.find((x) => x.id === cid);
        if (c) openCatModal(c);
        return;
      }
      const del = e.target.closest('.cat-del');
      if (del) {
        const cid = item.dataset.cat;
        const c = state.categories.find((x) => x.id === cid);
        if (!c) return;
        if (!confirm('删除分类「' + c.name + '」？其中的图片会回到待收录。')) return;
        try {
          await VaultDB.deleteCategory(cid);
        } catch (err) {
          toast('删除失败：' + err.message);
          return;
        }
        state.categories = await VaultDB.listCategories();
        if (state.catFilter === cid) state.catFilter = '';
        await loadImages();
        renderAll();
        toast('分类已删除');
        return;
      }
      state.catFilter = item.dataset.cat || '';
      renderCats();
      renderGrid();
    });
    els.catList.addEventListener('dragover', (e) => {
      const item = e.target.closest('.cat-item');
      if (!item) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('dragover');
    });
    els.catList.addEventListener('dragleave', (e) => {
      const item = e.target.closest('.cat-item');
      if (item) item.classList.remove('dragover');
    });
    els.catList.addEventListener('drop', async (e) => {
      const item = e.target.closest('.cat-item');
      if (!item) return;
      e.preventDefault();
      item.classList.remove('dragover');
      const id = e.dataTransfer.getData('application/x-vault-id');
      if (!id) return;
      const targetCat = item.dataset.cat;
      let newCat;
      if (targetCat === '__uncat') newCat = null;
      else if (!targetCat || targetCat === '__fav') return; // 「全部图片」「星标收藏」不接受拖入
      else newCat = targetCat;
      const img = state.images.find((i) => i.id === id);
      if (!img) return;
      if ((img.categoryId || null) === newCat) return;
      try {
        await VaultDB.updateImage(id, { categoryId: newCat });
      } catch (err) {
        toast('归类失败：' + err.message);
        return;
      }
      img.categoryId = newCat;
      renderAll();
      const catName = newCat ? ((state.categories.find((c) => c.id === newCat) || {}).name || '分类') : '待收录';
      toast('已移入「' + catName + '」');
    });

    // 新建分类 → 打开「名称 + 图标」弹窗
    els.btnAddCat.addEventListener('click', () => openCatModal(null));

    // 分类弹窗：确定 / 取消 / 关闭 / 点背板关闭 / 选图标 / 回车提交
    if (els.catModal) {
      els.cmOk.addEventListener('click', submitCatModal);
      els.cmCancel.addEventListener('click', closeCatModal);
      els.cmClose.addEventListener('click', closeCatModal);
      const cmBackdrop = els.catModal.querySelector('.cm-backdrop');
      if (cmBackdrop) cmBackdrop.addEventListener('click', closeCatModal);
      els.cmIcons.addEventListener('click', (e) => {
        const b = e.target.closest('.cm-icon');
        if (b && b.dataset.icon) selectIcon(b.dataset.icon);
      });
      els.cmName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitCatModal();
        }
      });
    }

    // 灯箱
    els.lbClose.addEventListener('click', closeLightbox);
    document.querySelector('.lb-backdrop').addEventListener('click', closeLightbox);
    // 点击舞台空白处也能关闭（大图与左右导航按钮除外）
    const lbStage = document.querySelector('.lb-stage');
    if (lbStage) {
      lbStage.addEventListener('click', (e) => {
        if (e.target.closest('#lb-img') || e.target.closest('.lb-nav')) return;
        closeLightbox();
      });
    }
    els.lbPrev.addEventListener('click', () => navigate(-1));
    els.lbNext.addEventListener('click', () => navigate(1));
    els.lbFav.addEventListener('click', () => toggleFav(state.lightboxId));
    els.lbDelete.addEventListener('click', () => {
      const im = state.images.find((i) => i.id === state.lightboxId);
      if (im && im.deleted) purgeImage(im.id); // 回收站里的图：灯箱删除=彻底删除
      else deleteImageFlow(state.lightboxId);
    });
    els.lbDownload.addEventListener('click', () => {
      const img = state.images.find((i) => i.id === state.lightboxId);
      if (!img) return;
      // v2.2：外链记录没有本地文件，改为新标签打开原图
      if (!img.blob) {
        if (img.sourceUrl) window.open(img.sourceUrl, '_blank', 'noopener');
        return;
      }
      const a = document.createElement('a');
      a.href = ensureURL(img);
      a.download = img.name || 'image.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    // v2.2：外链原图加载失败（防盗链/已失效）时在元信息里提示
    els.lbImg.addEventListener('error', () => {
      if (els.lbImg.dataset.isRef === '1') els.lbMeta.textContent += ' · 原图加载失败（外链可能已失效）';
    });
    els.lbRefetch.addEventListener('click', refetchCurrent);
    els.lbName.addEventListener('change', async () => {
      const id = state.lightboxId;
      if (!id) return;
      const v = els.lbName.value.trim();
      const img = state.images.find((i) => i.id === id);
      if (!img) return;
      if (!v) { els.lbName.value = img.name || ''; return; }
      if (v === img.name) return;
      try {
        await VaultDB.updateImage(id, { name: v });
      } catch (err) {
        toast('重命名失败：' + err.message);
        return;
      }
      img.name = v;
      renderGrid();
      renderPromptList();
    });
    els.lbCatSelect.addEventListener('change', async () => {
      const id = state.lightboxId;
      if (!id) return;
      const img = state.images.find((i) => i.id === id);
      if (!img) return;
      const newCat = els.lbCatSelect.value || null;
      if ((img.categoryId || null) === newCat) return;
      try {
        await VaultDB.updateImage(id, { categoryId: newCat });
      } catch (err) {
        toast('分类更新失败：' + err.message);
        return;
      }
      img.categoryId = newCat;
      renderAll();
      toast('分类已更新');
    });

    // 提示词抽屉
    els.promptToggle.addEventListener('click', () => {
      els.promptDrawer.classList.toggle('collapsed');
    });
    els.promptText.addEventListener('input', () => {
      const id = state.lightboxId;
      if (!id) return;
      clearTimeout(promptTimer);
      els.promptSaveState.textContent = '保存中…';
      els.promptSaveState.dataset.state = 'saving';
      promptTimer = setTimeout(async () => {
        promptTimer = null;
        const text = els.promptText.value;
        // 图片已被删除：静默放弃，避免把已删记录"复活"
        if (!state.images.some((i) => i.id === id)) return;
        try {
          await VaultDB.updateImage(id, { prompt: text });
          const img = state.images.find((i) => i.id === id);
          if (img) img.prompt = text;
          els.promptSaveState.innerHTML = Icons.svg('i-check', 'ic-xs') + '<span>已保存</span>';
          els.promptSaveState.dataset.state = 'saved';
          setTimeout(() => {
            if (els.promptSaveState.dataset.state === 'saved') {
              els.promptSaveState.textContent = '';
              els.promptSaveState.dataset.state = '';
            }
          }, 2000);
          renderPromptList();
        } catch (err) {
          els.promptSaveState.textContent = '';
          els.promptSaveState.dataset.state = '';
          toast('提示词保存失败：' + err.message);
        }
      }, 500);
    });
    els.btnCopyPrompt.addEventListener('click', async () => {
      const text = els.promptText.value.trim();
      if (!text) { toast('这张图还没有提示词'); return; }
      const ok = await copyText(text);
      toast(ok ? '提示词已复制' : '复制失败，请手动选择复制');
    });

    // 提示词库：复制 / 点开详情
    els.promptList.addEventListener('click', async (e) => {
      const item = e.target.closest('.prompt-item');
      if (!item) return;
      const id = item.dataset.id;
      const img = state.images.find((i) => i.id === id);
      if (!img) return;
      if (e.target.closest('.prompt-copy')) {
        const text = (img.prompt || '').trim();
        if (!text) { toast('这条还没有提示词'); return; }
        const ok = await copyText(text);
        toast(ok ? '提示词已复制' : '复制失败，请手动选择复制');
        return;
      }
      openLightbox(id);
    });

    // 悬浮小窗联动：点击小窗缩略图 → 切回画廊并打开灯箱
    document.addEventListener('fw:open-image', (e) => {
      const id = e.detail && e.detail.id;
      if (!id) return;
      if (state.view !== 'gallery') {
        state.view = 'gallery';
        document.querySelectorAll('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === 'gallery'));
        $('view-gallery').classList.add('active');
        $('view-prompts').classList.remove('active');
        renderGrid();
      }
      openLightbox(id);
    });

    // 键盘：Esc 逐层关闭（一次按键只关最上层：快投面板由 quickdrop 自身处理
    // 并拦截，这里依次是分类弹窗 → 灯箱 → 收录篮面板）；Cmd/Ctrl+F 与「/」
    // 聚焦搜索；灯箱内 ←/→；输入框不拦截
    document.addEventListener('keydown', (e) => {
      // 分类弹窗必须排在「输入框不拦截」之前 —— 否则光标在名称框里时 Esc 会被吞掉
      if (e.key === 'Escape' && els.catModal && !els.catModal.hidden) {
        closeCatModal();
        return;
      }
      if (e.key === 'Escape' && !els.lightbox.hidden) {
        closeLightbox();
        return;
      }
      // v2.4 Esc 关层链的最后一层：只收起收录篮面板（保留启用状态，气泡仍在），
      // 不会与弹窗/灯箱在同一次按键里一起被关掉
      if (e.key === 'Escape' && window.Inbox && Inbox.isExpanded && Inbox.isExpanded()) {
        Inbox.collapsePanel();
        return;
      }
      // v2.4 快捷键：Cmd/Ctrl+F 聚焦顶部搜索框并全选（拦截浏览器默认查找）
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        focusSearch();
        return;
      }
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) {
        if (e.key === 'Enter' && t === els.lbName) els.lbName.blur();
        return;
      }
      // v2.4 快捷键：非输入状态（焦点不在 input/textarea/contenteditable）按「/」
      // 聚焦搜索框并全选
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (els.lightbox.hidden) return;
      if (e.key === 'ArrowLeft') navigate(-1);
      else if (e.key === 'ArrowRight') navigate(1);
    });

    // v2.2：外链缩略图加载失败（防盗链/已失效）时半透明标记
    document.addEventListener('error', (e) => {
      const t = e.target;
      if (t && t.tagName === 'IMG') t.style.opacity = '0.35';
    }, true); // error 不冒泡，需捕获阶段
  }

  // v2.2：一次性迁移旧版「拾光图库」v1 数据（IndexedDB 库名 image-vault）
  async function migrateFromV1() {
    let flag = null;
    try { flag = localStorage.getItem('imgvault.migrated-v1'); } catch (_) {}
    if (flag) return;
    try {
      const oldDb = await new Promise((resolve, reject) => {
        const req = indexedDB.open('image-vault', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('open failed'));
        req.onupgradeneeded = () => {};
      });
      const all = await new Promise((resolve, reject) => {
        const tx = oldDb.transaction('images', 'readonly');
        const rq = tx.objectStore('images').getAll();
        rq.onsuccess = () => resolve(rq.result || []);
        rq.onerror = () => reject(rq.error);
      });
      try { oldDb.close(); } catch (_) {}
      let n = 0;
      for (const rec of all) {
        const base = {
          name: rec.name || '未命名图片', type: rec.type || '',
          width: rec.width || 0, height: rec.height || 0, size: rec.size || 0,
          categoryId: null, prompt: rec.prompt || '', favorite: !!rec.favorite
        };
        try {
          if (rec.blob instanceof Blob) { await VaultDB.addImage(Object.assign({}, base, { blob: rec.blob })); n++; }
          else if (rec.sourceUrl) { await VaultDB.addImageRef(Object.assign({}, base, { sourceUrl: rec.sourceUrl })); n++; }
        } catch (_) { /* 单条失败不阻断 */ }
      }
      try { localStorage.setItem('imgvault.migrated-v1', '1'); } catch (_) {}
      if (n) toast('已从旧版「拾光图库」迁移 ' + n + ' 张图片');
    } catch (_) {
      try { localStorage.setItem('imgvault.migrated-v1', '1'); } catch (_) {}
    }
  }

  // v2.2：外链记录补抓原图入库（fetch → blob → 尺寸 → 更新记录，sourceUrl 保留作溯源）
  // v2.2：补抓一张外链原图入库（fetch → blob → 尺寸 → 更新记录，sourceUrl 保留作溯源）
  async function refetchOne(img) {
    const resp = await fetch(img.sourceUrl, { mode: 'cors' });
    const type = ((resp.headers.get('content-type') || '').split(';')[0] || '').trim();
    if (!resp.ok || type.indexOf('image/') !== 0) throw new Error('原图不可访问');
    const blob = await resp.blob();
    let w = img.width || 0, h = img.height || 0;
    try {
      const bmp = await createImageBitmap(blob);
      w = bmp.width; h = bmp.height;
      if (bmp.close) bmp.close();
    } catch (_) { /* 尺寸读不到沿用旧值 */ }
    await VaultDB.updateImage(img.id, { blob: blob, type: type, size: blob.size, width: w, height: h });
  }

  // v2.2：灯箱内单张补抓
  async function refetchCurrent() {
    const img = state.images.find((it) => it.id === state.lightboxId);
    if (!img || img.blob || !img.sourceUrl) return;
    els.lbRefetch.disabled = true;
    try {
      await refetchOne(img);
      await loadAll();
      renderAll();
      if (state.lightboxId === img.id) openLightbox(img.id);
      toast('已补抓原图入库，外链徽章自动消失');
    } catch (err) {
      toast('补抓失败：' + (err && err.message ? err.message : '原图仍不可访问'));
    } finally {
      els.lbRefetch.disabled = false;
    }
  }

  // v2.2：批量补抓全部外链记录（侧栏入口）
  async function refetchAllRefs() {
    const refs = state.images.filter((it) => !it.blob && it.sourceUrl);
    if (!refs.length) return;
    els.btnRefetchAll.disabled = true;
    let okCount = 0;
    for (const img of refs) {
      try { await refetchOne(img); okCount++; } catch (_) { /* 单张失败继续 */ }
    }
    await loadAll();
    renderAll();
    els.btnRefetchAll.disabled = false;
    toast('外链补抓完成：成功 ' + okCount + ' / ' + refs.length + ' 张');
  }

  // ---------- 启动 ----------
  async function init() {
    if (typeof VaultDB === 'undefined' || typeof Importer === 'undefined') {
      toast('脚本加载不完整，请刷新页面重试');
      return;
    }
    if (typeof Icons === 'undefined' || !Icons.ready()) {
      // 图标精灵缺失不该让应用罢工：退化为纯文字界面
      try { console.warn('[App] 图标精灵未就绪，图标将不显示。'); } catch (_) { /* 忽略 */ }
    }
    bindEvents();
    // v2.3 恢复排序选择与内置项图标
    try { state.sort = localStorage.getItem('imgvault.sort') || 'new'; } catch (_) { state.sort = 'new'; }
    els.sortSelect.value = state.sort;
    restoreBuiltinIcons();
    els.promptDrawer.classList.add('collapsed'); // 抽屉初始折叠
    try {
      await VaultDB.open();
      await migrateFromV1(); // v2.2：旧版数据一次性迁移
      await loadAll();
      renderAll();
    } catch (err) {
      toast('本地存储不可用：' + (err && err.message ? err.message : err));
    }
  }

  init();

  // === QuickDrop 快投面板桥接（v2.4）：拖图自动展开收藏夹网格 ===
  if (window.QuickDrop) {
    QuickDrop.install({
      getCategories: function () { return state.categories; },
      onImported: function () { loadImages().then(renderAll); }
    });
  }
})();
