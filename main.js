/**
 * 学习资产库 — 主进程
 * 悬浮球（可拖动/可拖放直收）+ 快速捕获窗 + 主窗 + 托盘 + 全局快捷键 + 每晚定时复盘
 */
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, screen, dialog, nativeImage, Notification, powerMonitor, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Store } = require('./src/db');
const { extractFromUrl } = require('./src/fetcher');
const { makeTitleFromPath } = require('./src/extract');
const { classify } = require('./src/classify');
const { generateReview } = require('./src/review');
const { computeStats, MILESTONES, reachedTarget } = require('./src/stats');
const { buildInverted, search, docOf, topTerms } = require('./src/index-engine');
let bridgeIdx = null;   // 桥用搜索索引缓存：store.save 后失效（与 idxCache 同生命周期钩子）
const { CategoryProfile, decide } = require('./src/classify-engine');
const { BASE_CATEGORIES } = require('./src/classify-engine');
const { TaxonomyRules } = require('./src/taxonomy-rules');
const { isVideoFile, formatDuration } = require('./src/video');
const { getPool, inProcessFallback } = require('./src/worker-pool');
const { messagesToText } = require('./src/chat-parse');
const { parseChatText } = require('./src/chat-parse');
const srs = require('./src/srs');
const nightly = require('./src/nightly');
const cardQA = require('./src/card-qa');
const ideas = require('./src/ideas');
const http = require('http');
const { writeJsonAtomic, readJson } = require('./src/json-io');
const { detectCapture, firstUrl } = require('./src/capture');
const { DraftStore } = require('./src/drafts');
const chatOps = require('./src/chat-ops');
const { ExtractStore } = require('./src/extracts');
const usage = require('./src/usage');
const { UserRuleStore, distinctiveTerms } = require('./src/user-rules');
const { migrateAll } = require('./src/migrate');
const { weekOutcomes } = require('./src/outcomes');
const { mergeBackup, writeRestoredBundle, LISTS: BACKUP_LISTS } = require('./src/backup');
const { requestChat, testConnection, parseDraft } = require('./src/ai-client');
const { edgeMode, clampY } = require('./src/overlay-geometry');

// ---------- 图片媒体支持（v0.5.2） ----------
// 拖入的图片文件与视频同策略：只建索引指向原文件，不复制
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff']);
function isImageFile(p) { const m = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? IMAGE_EXTS.has(m[1]) : false; }
// 尺寸用 Electron 内置解码器读（svg/heic 等解码不了的只记文件大小）
function imageMeta(p) {
  const meta = { width: null, height: null, size: 0 };
  try { meta.size = fs.statSync(p).size; } catch {}
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) { const sz = img.getSize(); meta.width = sz.width; meta.height = sz.height; }
  } catch {}
  return meta;
}

const CONFIG_DIR = () => process.env.LV_CONFIG_DIR || app.getPath('userData');
const CONFIG_FILE = () => path.join(CONFIG_DIR(), 'config.json');
const FILES_DIR = () => path.join(CONFIG_DIR(), 'files');
const DATA_DIR = () => process.env.LV_DATA_DIR || path.join(CONFIG_DIR(), 'data');

// 隔离运行（LV_CONFIG_DIR 指定时）同步 userData：单实例锁/缓存均落在隔离目录，
// 不与真实运行中的应用冲突（--smoke 自检可并行跑）
if (process.env.LV_CONFIG_DIR) {
  try { app.setPath('userData', process.env.LV_CONFIG_DIR); } catch {}
}

let store, tray = null, overlayWin = null, quickWin = null, mainWin = null;
let catProfile = null; // 分类画像（在线学习）
let catRules = null;   // 自定义分类关键词规则（用户可编辑）
let srsCards = [];     // 复习卡片（SM-2 调度；金句/星标/手动成卡）
let ideaItems = [];    // 点子（灵感与行动）
let extractStore = null;
let draftStore = null;
let userRules = null;
let idxCache = null; // 倒排索引缓存 { builtAt, index }，store.save 时置空失效
let pendingDrops = []; // 传递给 quickWin 的 payload
let overlayDrag = null;
let quitting = false;

function localDayKey(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function localMonthKey(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- 配置 ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR(), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2));
}
function aiCfg() {
  const c = loadConfig();
  return { baseUrl: c.baseUrl || '', apiKey: c.apiKey || '', model: c.model || '' };
}

// ---------- 复习卡片存储（SM-2） ----------
// 读写走 json-io：原子写入（临时文件+rename）+ 损坏自动留底（*.corrupt-<时间戳>，绝不静默蒸发）
function SRS_FILE() { return path.join(DATA_DIR(), 'srs-cards.json'); }
function loadSrsCards() {
  srsCards = readJson(SRS_FILE(), []);
  if (!Array.isArray(srsCards)) srsCards = [];
}
function saveSrsCards() {
  try { writeJsonAtomic(SRS_FILE(), srsCards); } catch {}
}
// 成卡（幂等：同一条目同类型只留一张卡）
function addSrsCard({ itemId, kind, front, back, generatedBy }) {
  if (srsCards.some(c => c.itemId === itemId && c.kind === kind)) return null;
  const card = srs.newCard({ itemId, kind, front, back });
  if (generatedBy) card.generated_by = generatedBy; // ai | template | manual（P1 问答式成卡溯源；旧卡缺字段=template）
  srsCards.push(card);
  saveSrsCards();
  return card;
}
function removeSrsCardsFor(itemId) {
  const before = srsCards.length;
  srsCards = srsCards.filter(c => c.itemId !== itemId);
  if (srsCards.length !== before) saveSrsCards();
}

// ---------- 点子收件箱（待学习的想法） ----------
function IDEAS_FILE() { return path.join(DATA_DIR(), 'ideas.json'); }
function loadIdeas() {
  ideaItems = readJson(IDEAS_FILE(), []);
  if (!Array.isArray(ideaItems)) ideaItems = [];
}
function saveIdeas() {
  fs.mkdirSync(DATA_DIR(), { recursive: true }); writeJsonAtomic(IDEAS_FILE(), ideaItems);
  idxCache = null;
  if (ideaWin && !ideaWin.isDestroyed()) ideaWin.webContents.send('ideas:changed');
}
function pushIdeaCount() {
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.send('ideas:count-changed', ideaItems.filter(i => !i.done).length); } catch {}
  }
}

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }
  });
}

// ---------- 悬浮按钮（80×80 透明承载区 · 32px 圆钮贴右缘，上下拖动、横坐标固定） ----------
// 用户确认的最终形态（2026-09-22 改版+高亮修复，证据：交付物/悬浮按钮-高亮修复/）：
// 窗口本身全透明只当热区，圆形按钮画在页面里；拖动只改高度，横坐标恒贴工作区右缘。
const OVERLAY_W = 80, OVERLAY_H = 80;
const OVERLAY_POLL_MS = 16;     // 拖动跟手：主进程光标轮询间隔（16ms ≈ 一帧）
const OVERLAY_STILL_MS = 10000; // 光标静止 10s 兜底自动结束拖动
let overlayMode = null;        // 最近推给渲染层的贴边模式：'dock-right' | 'dock-left' | 'float'
let overlayPollTimer = null;   // 拖动期间的光标轮询定时器
let overlayDispHooked = false; // 显示器事件注册标志（只注册一次）
let overlayDispDebounce = null;
function overlayDefaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - OVERLAY_W, y: wa.y + Math.round(wa.height * 0.3) };
}
function overlayRestorePos() {
  const def = overlayDefaultPos();
  try {
    const s = loadConfig().overlayPos;
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return def;
    // 旧位置迁移：历史上 overlayPos 存过 16×50 竖条 / 24 宽条 / 旧自由圆钮的左上角。
    // 现版横坐标固定贴右缘，只迁移竖直高度：y 保留（夹回），x 按最近显示器工作区重贴右缘。
    const wa = screen.getDisplayNearestPoint({ x: s.x, y: s.y + OVERLAY_H / 2 }).workArea;
    return { x: wa.x + wa.width - OVERLAY_W, y: clampY(s.y, wa, OVERLAY_H) };
  } catch { return def; }
}
function saveOverlayPos() {
  try {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const c = loadConfig();
    const [x, y] = overlayWin.getPosition();
    c.overlayPos = { x, y };
    saveConfig(c);
  } catch {}
}
// 把当前贴边模式推给渲染层（现版横坐标固定贴右缘，恒为 dock-right；保留协议兼容渲染层旧通道）
function syncOverlayEdge() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    const b = overlayWin.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
    overlayMode = edgeMode(b, wa, OVERLAY_W, OVERLAY_H);
    overlayWin.webContents.send('overlay:edge', overlayMode);
  } catch {}
}
function createOverlay() {
  const p = overlayRestorePos();
  overlayWin = new BrowserWindow({
    width: OVERLAY_W, height: OVERLAY_H,
    x: p.x, y: p.y,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    // 80×80 全透明承载区：圆形按钮由页面绘制（透明热区大于视觉，好点好拖）。
    // transparent 与 vibrancy 互斥；透明后必须 hasShadow:false，
    // 否则 macOS 给整个矩形画投影，就是「闪白边方块」的根源。
    transparent: true, hasShadow: false, fullscreenable: false, acceptFirstMouse: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setAlwaysOnTop(true, 'floating');
  overlayWin.loadFile('overlay/overlay.html');
  hookOverlayDisplayChanges(); // 显示器插拔/分辨率变化 → 夹回工作区（内部有注册标志，只挂一次）
  overlayWin.webContents.on('did-finish-load', () => {
    // 首载/重载后贴边模式未知：重置并立即同步一次，渲染层才能恢复贴边视觉
    overlayMode = null;
    syncOverlayEdge();
    pushOverlayCount();
  });
  overlayWin.on('blur', () => stopOverlayDrag(true));
  overlayWin.on('closed', () => { stopOverlayDrag(); overlayWin = null; });
}
function overlayResetPos() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const p = overlayDefaultPos();
  overlayWin.setPosition(p.x, p.y);
  saveOverlayPos();
  syncOverlayEdge(); // 归位即右缘，顺手把贴边模式同步给渲染层
}

// 显示器插拔/分辨率变化：横坐标重贴最近显示器右缘、高度夹回工作区。500ms 去抖；拖动中跳过（松手自会 clamp）。
function hookOverlayDisplayChanges() {
  if (overlayDispHooked) return; // 只注册一次
  overlayDispHooked = true;
  const reflow = () => {
    if (overlayDrag || !overlayWin || overlayWin.isDestroyed()) return;
    try {
      const b = overlayWin.getBounds();
      const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
      const p = { x: wa.x + wa.width - OVERLAY_W, y: clampY(b.y, wa, OVERLAY_H) };
      if (p.x !== b.x || p.y !== b.y) overlayWin.setPosition(p.x, p.y);
      saveOverlayPos();
      syncOverlayEdge();
    } catch {}
  };
  const debounced = () => {
    if (overlayDispDebounce) clearTimeout(overlayDispDebounce);
    overlayDispDebounce = setTimeout(reflow, 500);
  };
  screen.on('display-removed', debounced);
  screen.on('display-metrics-changed', debounced);
}

// 拖动跟手（只动高度、横坐标固定）：渲染层 pointermove 上报屏幕坐标为主通道
// （pointer capture 让事件跨出窗口仍持续到达，程序注入的合成拖动也走这里）；
// 主进程光标轮询只作回退（上报中断 250ms 后接管）。拖动位移以上报的 pointerdown 为锚点。
// overlayDrag = { ax, ay: 起始窗口左上角 | reportOrigin: 上报锚点 | cursorOrigin: 光标锚点
//                 lx, ly: 上一 tick 光标 | lastReportedAt: 最近上报时间
//                 stillMs: 光标静止毫秒 | dirty: 位置是否真变过（变过松手才写盘） }
ipcMain.on('overlay:drag-start', (e, point) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  stopOverlayDrag(); // 兜底：上次拖动没收干净先结束（不落盘），再重建状态
  const b = overlayWin.getBounds();
  const cur = screen.getCursorScreenPoint(); // 主进程光标为唯一坐标基准，避免渲染层坐标系差异
  const hasPoint = point && Number.isFinite(point.x) && Number.isFinite(point.y);
  overlayDrag = {
    ax: b.x, ay: b.y,
    reportOrigin: hasPoint ? { x: point.x, y: point.y } : null, // pointerdown 锚点：位移以此精确计算
    cursorOrigin: { x: cur.x, y: cur.y },
    lx: cur.x, ly: cur.y, lastReportedAt: Date.now(), stillMs: 0, dirty: false, // 手势刚起步：防 drag-move 误重锚
  };
  if (!overlayPollTimer) overlayPollTimer = setInterval(pollOverlayDrag, OVERLAY_POLL_MS);
});
// 按上报坐标竖直移动（夹回窗口所在显示器工作区；横坐标永不变）
function moveOverlayDragTo(y) {
  if (!overlayDrag || !overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
  const ny = clampY(y, wa, OVERLAY_H);
  const [px, py] = overlayWin.getPosition();
  if (py !== ny) { overlayDrag.dirty = true; overlayWin.setPosition(px, ny); }
}
ipcMain.on('overlay:drag-move', (e, p) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  const now = Date.now();
  // 新手势识别：系统级拖入（macOS CG 注入）可能不产生 pointerdown，直接来 pointermove；
  // 无拖动态、或距上次上报超过 400ms（新手势/松手后新按下），都以本事件为锚点从当前窗口位置续算，
  // 避免沿用上一手势的锚点造成跳位。连续跟手（间隔 <400ms）沿用原锚点，位移精确。
  if (!overlayDrag || now - overlayDrag.lastReportedAt > 400) {
    const b = overlayWin.getBounds();
    const cur = screen.getCursorScreenPoint();
    overlayDrag = {
      ax: b.x, ay: b.y,
      reportOrigin: { x: p.x, y: p.y },
      cursorOrigin: { x: cur.x, y: cur.y },
      lx: cur.x, ly: cur.y, lastReportedAt: now, stillMs: 0, dirty: false,
    };
    if (!overlayPollTimer) overlayPollTimer = setInterval(pollOverlayDrag, OVERLAY_POLL_MS);
  }
  overlayDrag.lastReportedAt = now;
  overlayDrag.stillMs = 0;
  moveOverlayDragTo(overlayDrag.ay + (p.y - overlayDrag.reportOrigin.y));
});
function pollOverlayDrag() {
  const d = overlayDrag;
  if (!d || !overlayWin || overlayWin.isDestroyed()) { stopOverlayDrag(); return; }
  const cur = screen.getCursorScreenPoint();
  if (cur.x === d.lx && cur.y === d.ly) {
    d.stillMs += OVERLAY_POLL_MS;
    if (d.stillMs >= OVERLAY_STILL_MS) stopOverlayDrag(true); // 光标静止 10s 兜底结束
    return;
  }
  d.stillMs = 0;
  d.lx = cur.x; d.ly = cur.y;
  // 渲染层上报正在跟手（250ms 内有上报）时让位，避免双写抖动
  if (Date.now() - d.lastReportedAt < 250) return;
  moveOverlayDragTo(d.ay + (cur.y - d.cursorOrigin.y));
}
ipcMain.on('overlay:drag-end', (e) => {
  if (overlayWin && !overlayWin.isDestroyed() && e.sender === overlayWin.webContents) stopOverlayDrag(true);
});
function stopOverlayDrag(save) {
  if (!overlayDrag) return;
  const dirty = overlayDrag.dirty;
  overlayDrag = null;
  if (overlayPollTimer) { clearInterval(overlayPollTimer); overlayPollTimer = null; }
  if (!save || !dirty) return; // 纯点击没挪动就不写盘
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    // 落定：横坐标重贴工作区右缘、高度保持用户拖放的位置（不做动画，
    // 避免动画中途 getPosition/saveOverlayPos 读到中间值）。
    const b = overlayWin.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
    const s = { x: wa.x + wa.width - OVERLAY_W, y: clampY(b.y, wa, OVERLAY_H) };
    if (s.x !== b.x || s.y !== b.y) overlayWin.setPosition(s.x, s.y);
  } catch {}
  saveOverlayPos();
  syncOverlayEdge();
}

// ---------- 快速捕获窗（常驻热窗：首次创建后隐藏，再开零冷启动） ----------
let pendingQuickIntent = 'note';
function createQuickWin(intent = 'note') {
  if (intent) pendingQuickIntent = intent;
  if (quickWin && !quickWin.isDestroyed()) {
    if (quickWin.isVisible()) { quickWin.focus(); } else { quickWin.show(); quickWin.focus(); }
    const extra = pendingDrops.length ? pendingDrops.splice(0) : [];
    try { quickWin.webContents.send('quick:payload', { intent: pendingQuickIntent, drops: extra }); } catch {}
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  quickWin = new BrowserWindow({
    width: 480, height: 560, minWidth: 420, minHeight: 460,
    x: Math.round((width - 480) / 2), y: Math.round((height - 560) / 2),
    frame: false, transparent: false, backgroundColor: '#dfe9e4', // 与页面浅色底一致：渐入前的一瞬不闪暗底
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
    show: false, // 预创建时先隐藏
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  quickWin.setAlwaysOnTop(true, 'floating');
  quickWin.loadFile('quick/quick.html');
  quickWin.on('close', (e) => {
    // 关闭 = 隐藏进内存，不销毁 → 下次打开零延迟
    if (!quitting) { e.preventDefault(); quickWin.hide(); }
  });
  quickWin.on('closed', () => { quickWin = null; });
  // 常驻热窗复用 show()/hide() 不重载页面：把显示/隐藏广播给渲染层，驱动「虚化渐入」重放
  //（Electron 里 show() 不触发页面 visibilitychange，验证台实测，必须显式广播）
  quickWin.on('show', () => { try { quickWin.webContents.send('quick:fx', 'in'); } catch {} });
  quickWin.on('hide', () => { try { quickWin.webContents.send('quick:fx', 'out'); } catch {} });
  quickWin.webContents.once('did-finish-load', () => {
    // 启动静默化：预热只为热窗（秒开），不自动弹出；有待处理拖放时才显示
    if (intent || pendingDrops.length) {
      quickWin.show(); quickWin.focus();
      try { quickWin.webContents.send('quick:payload', { intent: pendingQuickIntent, drops: pendingDrops.splice(0) }); } catch {}
    }
  });
}

// ---------- 复习窗（一屏一卡 · 翻面自评 · SM-2） ----------
let reviewWin = null;
function createReviewWin() {
  if (reviewWin && !reviewWin.isDestroyed()) {
    if (reviewWin.isVisible()) reviewWin.focus();
    else {
      reviewWin.show(); reviewWin.focus();
      setTimeout(() => { try { reviewWin.webContents.send('srs:shown'); } catch {} }, 30);
    }
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  reviewWin = new BrowserWindow({
    width: 520, height: 560, minWidth: 420, minHeight: 460,
    x: Math.round((width - 520) / 2), y: Math.round((height - 560) / 2),
    frame: false, backgroundColor: '#101413',
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  reviewWin.setAlwaysOnTop(true, 'floating');
  reviewWin.loadFile('review/review.html');
  const notifyReviewShown = () => { try { reviewWin.webContents.send('srs:shown'); } catch {} };
  reviewWin.on('show', notifyReviewShown);
  reviewWin.on('close', (e) => { if (!quitting) { e.preventDefault(); reviewWin.hide(); } }); // 热窗常驻
  reviewWin.on('closed', () => { reviewWin = null; });
  reviewWin.webContents.once('did-finish-load', () => { reviewWin.show(); reviewWin.focus(); });
}

// ---------- 点子收件箱窗（输入即存 · 陈化提醒） ----------
let ideaWin = null;
function createIdeaWin() {
  if (ideaWin && !ideaWin.isDestroyed()) {
    if (ideaWin.isVisible()) ideaWin.focus();
    else {
      ideaWin.show(); ideaWin.focus();
      setTimeout(() => { try { ideaWin.webContents.send('ideas:shown'); } catch {} }, 30);
    }
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  ideaWin = new BrowserWindow({
    width: 560, height: 620, minWidth: 440, minHeight: 480,
    x: Math.round((width - 560) / 2), y: Math.round((height - 620) / 2),
    frame: false, backgroundColor: '#12100c',
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  ideaWin.setAlwaysOnTop(true, 'floating');
  ideaWin.loadFile('idea/idea.html');
  const notifyIdeaShown = () => { try { ideaWin.webContents.send('ideas:shown'); } catch {} };
  ideaWin.on('show', notifyIdeaShown);
  ideaWin.on('close', (e) => { if (!quitting) { e.preventDefault(); ideaWin.hide(); } }); // 热窗常驻
  ideaWin.on('closed', () => { ideaWin = null; });
  ideaWin.webContents.once('did-finish-load', () => { ideaWin.show(); ideaWin.focus(); });
}

// ---------- 图片收藏夹画廊窗 ----------
// 图片库与「自制图片收藏夹」桌面版共用同一套会话目录（IndexedDB 名 imgvault），
// 不写进学习资产库自己的 JSON 库。学习资产库只是它的窗口和入口。
let ivWin = null;
let ivSession = null;
let ivSessionDir = '';

function imageVaultDataDir() {
  if (process.env.LV_IV_DATA_DIR) return path.resolve(process.env.LV_IV_DATA_DIR);
  return path.join(app.getPath('appData'), '图片收藏夹');
}

// 画廊窗使用图片收藏夹的会话目录，确保与桌面版共用收藏库。
function imageVaultSession() {
  if (ivSession) return ivSession;
  ivSessionDir = imageVaultDataDir();
  try {
    fs.mkdirSync(ivSessionDir, { recursive: true });
    ivSession = session.fromPath(ivSessionDir);
  } catch (err) {
    console.log('[图片收藏夹] 无法接通原收藏库：', (err && err.message) || err);
    ivSession = null;
  }
  return ivSession;
}

function ivWebPreferences() {
  const prefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true };
  const ses = imageVaultSession();
  if (ses) prefs.session = ses;
  return prefs;
}

function createIvWin() {
  if (ivWin && !ivWin.isDestroyed()) {
    if (ivWin.isVisible()) ivWin.focus(); else { ivWin.show(); ivWin.focus(); }
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  // 2026-09-28 用户指定：画廊窗改为与「随手记下」一致的紧凑小窗（≤760px 断点下侧栏自动收成图标条）
  ivWin = new BrowserWindow({
    width: 480, height: 560, minWidth: 420, minHeight: 460,
    x: Math.round((width - 480) / 2), y: Math.round((height - 560) / 2),
    title: '图片收藏夹',
    backgroundColor: '#f4f1ec',
    fullscreenable: false,
    webPreferences: ivWebPreferences(),
  });
  ivWin.loadFile('图片收藏夹/index.html');
  const notifyIvShown = () => { try { ivWin.webContents.send('iv:shown'); } catch {} };
  ivWin.on('show', notifyIvShown);
  ivWin.on('closed', () => { ivWin = null; });
}

ipcMain.on('iv:open', () => { createIvWin(); });

// ---------- 主窗 ----------
function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 620,
    backgroundColor: '#f6f4ef', title: '学习资产库',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  mainWin.loadFile('main/index.html');
  mainWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWin.hide(); } // 关窗 = 退到托盘
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// ---------- 托盘 ----------
function buildTrayMenu() {
  const c = loadConfig();
  return Menu.buildFromTemplate([
    { label: '打开资料库', click: () => createMainWindow() },
    { label: '快速收录 (' + (c.quickDropShortcut || 'CommandOrControl+Shift+L') + ')', click: () => createQuickWin() },
    { label: '🔁 今日复习 (⌘⇧R)', click: () => createReviewWin() },
    { label: '💡 点子 (⌘⇧I)', click: () => createIdeaWin() },
    { label: '🖼 图片收藏', click: () => createIvWin() },
    { type: 'separator' },
    { label: '显示悬浮按钮', type: 'checkbox', checked: c.overlayVisible !== false, click: (mi) => {
      const cc = loadConfig(); cc.overlayVisible = mi.checked; saveConfig(cc);
      if (overlayWin && !overlayWin.isDestroyed()) { mi.checked ? overlayWin.show() : overlayWin.hide(); }
    } },
    { label: '悬浮按钮归位', click: () => overlayResetPos() },
    { type: 'separator' },
    { label: '数据', submenu: [
      { label: '⬇ 导出备份 (JSON)', click: async () => {
        try {
          const r = await dialog.showSaveDialog({
            defaultPath: path.join(app.getPath('documents'), `学习资产库备份-${localDayKey()}.json`),
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });
          if (r.canceled || !r.filePath) return;
          fs.writeFileSync(r.filePath, JSON.stringify({ exported_at: Date.now(), items: store.items, quotes: store.quotes, reviews: store.reviews, events: store.events }, null, 1));
          if (Notification.isSupported()) new Notification({ title: '⬇ 备份已导出', body: r.filePath }).show();
        } catch {}
      } },
      { label: '♻ 从备份恢复', click: async () => {
        try {
          const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
          if (r.canceled || !r.filePaths[0]) return;
          const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
          const known = new Set(store.items.map(i => i.id));
          let added = 0;
          for (const it of (data.items || [])) {
            if (known.has(it.id)) continue;
            store.items.unshift(it);
            added += 1;
          }
          const knownQ = new Set(store.quotes.map(q => q.id));
          for (const q of (data.quotes || [])) if (!knownQ.has(q.id)) store.quotes.unshift(q);
          store.save();
          if (Notification.isSupported()) new Notification({ title: '♻ 备份已恢复', body: `新增 ${added} 条` }).show();
        } catch (e) {
          if (Notification.isSupported()) new Notification({ title: '恢复失败', body: String(e && e.message ? e.message : e).slice(0, 80) }).show();
        }
      } },
      { label: '打开数据目录', click: () => shell.openPath(CONFIG_DIR()) },
    ] },
    { label: '🗂 每周自动备份到…', click: async () => {
      try {
        const r = await dialog.showOpenDialog({ properties: ['openDirectory'], message: '选择每周自动备份的存放目录（保留最近 8 份）' });
        if (r.canceled || !r.filePaths[0]) return;
        const c2 = loadConfig(); c2.autoBackupDir = r.filePaths[0]; saveConfig(c2);
        if (Notification.isSupported()) {
          const n = new Notification({ title: '🗂 每周自动备份已开启', body: `每周静默备份到 ${r.filePaths[0]} · 保留最近 8 份` });
          n.show();
        }
      } catch {}
    } },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}
// 彩色托盘图标：用生成的玻璃书 PNG 缩到 18px（Template 黑色版在暗色菜单栏不可见时用彩色更醒目）
function createTray() {
  let img = nativeImage.createEmpty();
  const colored = path.join(__dirname, 'assets', 'tray-color.png');
  const template = path.join(__dirname, 'assets', 'trayTemplate.png');
  try {
    if (fs.existsSync(colored)) {
      img = nativeImage.createFromPath(colored);
      img.setTemplateImage(false);
    } else if (fs.existsSync(template)) {
      img = nativeImage.createFromPath(template);
      img.setTemplateImage(true);
    }
  } catch {}
  tray = new Tray(img);
  tray.setToolTip('学习资产库');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => createMainWindow());
}

// 悬浮按钮右键：原生菜单（窗口太窄，渲染层画不下）
function popupOverlayMenu() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  Menu.buildFromTemplate([
    { label: '快速收录', click: () => createQuickWin() },
    { label: '🖼 图片收藏', click: () => createIvWin() },
    { label: '💡 把剪贴板存为点子', click: () => {
      try {
        const txt = String(require('electron').clipboard.readText() || '').trim();
        if (!txt) {
          if (Notification.isSupported()) new Notification({ title: '💡 剪贴板是空的', body: '先在任意应用里 ⌘C 复制一段文字，再点这里' }).show();
          return;
        }
        const rec = ideas.migrateIdea({
          id: require('./src/db').uid(),
          text: txt.replace(/\s+/g, ' ').slice(0, 500),
          note: '', created_at: Date.now(), lastTouchedAt: null,
          nudgedAt: null, nudgeCount: 0, done: false, doneAt: null,
          status: 'clarify', reminder_mode: 'weekly',
        });
        ideaItems.push(rec);
        saveIdeas();
        pushIdeaCount();
        if (Notification.isSupported()) {
          const n = new Notification({ title: '💡 已记下这个点子', body: `${rec.text.slice(0, 36)}${rec.text.length > 36 ? '…' : ''}` });
          n.on('click', () => createIdeaWin());
          n.show();
        }
      } catch {}
    } },
    { label: '打开资料库', click: () => createMainWindow() },
    { type: 'separator' },
    { label: '悬浮按钮归位', click: () => overlayResetPos() },
    { label: '隐藏悬浮按钮', click: () => {
      const c = loadConfig(); c.overlayVisible = false; saveConfig(c);
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
      if (tray) tray.setContextMenu(buildTrayMenu());
    } },
  ]).popup({ window: overlayWin });
}

// ---------- 导入管线 ----------
// 并行抽取通道：批量任务按文件拆分、fan-out 到池里全部 worker 并行（顺序保持不变）；
// 池不可用/单文件失败时降级进程内串行（同一份 handler 逻辑）
async function extractManyViaPool(paths, imagesOutDir) {
  const list = Array.isArray(paths) ? paths : [];
  const pool = getPool();
  if (pool && list.length > 1) {
    try {
      const results = await Promise.all(list.map((p) =>
        pool.run('extract-files', { paths: [p], imagesOutDir: imagesOutDir || '' })
          .then((r) => r[0])
          .catch(() => ({ path: p, ok: false, text: '【抽取失败】', images: [], links: [] }))));
      return results;
    } catch {}
  }
  if (pool && list.length === 1) {
    try { return await pool.run('extract-files', { paths: list, imagesOutDir: imagesOutDir || '' }); } catch {}
  }
  const h = inProcessFallback();
  return h['extract-files']({ paths: list, imagesOutDir: imagesOutDir || '' });
}
async function videoMetasViaPool(paths) {
  const pool = getPool();
  if (pool) {
    try { return await pool.run('video-meta', { paths }); } catch {}
  }
  const h = inProcessFallback();
  return h['video-meta']({ paths });
}

// 单条记录的归类收尾（AI → 画像 → 规则决策链 + 建类建议 + 画像学习）
async function classifyAndFinalize(rec) {
  const fresh = store.get(rec.id) || rec;
  if (fresh.category_locked) return fresh;
  const userHit = userRules ? userRules.match(fresh) : null;
  if (userHit) {
    catProfile.learn(userHit.category, (fresh.title || '') + '\n' + (fresh.notes || '') + '\n' + (fresh.text || '').slice(0, 8000));
    store.update(fresh.id, {
      category: userHit.category, status: 'classified',
      classification_confidence: 0.9,
      classification_source: 'user-rule',
      classification_rule_id: userHit.id,
    });
    return store.get(fresh.id);
  }
  const cfg = aiCfg();
  const cls = await classify(cfg, {
    title: fresh.title, text: fresh.text, notes: fresh.notes, kind: fresh.kind,
    site: fresh.source_path,
  });
  if (store.get(fresh.id)?.category_locked) return store.get(fresh.id);
  let finalCat = cls.category, suggestNew = null, confidence = 0.5;
  if (cls.source === 'ai') {
    confidence = 0.85;
  } else {
    const d = decide({ profile: catProfile, rules: catRules, text: fresh.text, notes: fresh.notes, title: fresh.title, kind: fresh.kind });
    if (d.suggestNew) {
      suggestNew = d.suggestNew;
      finalCat = d.category;
    } else if (d.source !== 'rule-fallback' && d.source !== 'fallback') {
      finalCat = d.category; confidence = d.confidence;
    } else {
      confidence = d.confidence;
    }
    cls.tags = (d.tags && d.tags.length ? d.tags : cls.tags);
  }
  catProfile.learn(finalCat, (fresh.title || '') + '\n' + (fresh.notes || '') + '\n' + (fresh.text || '').slice(0, 8000));
  store.update(fresh.id, {
    category: finalCat, tags: cls.tags, summary: cls.summary,
    status: 'classified',
    classification_confidence: confidence,
    classification_source: cls.source === 'ai' ? 'ai' : 'engine',
    suggest_new_category: suggestNew,
  });
  return store.get(fresh.id);
}

async function pipelineIngest(payload) {
  // payload: {kind:'url'|'file'|'video'|'chat'|'note', url?, filePaths?, notes?}
  const recs = []; // 一次拖入可能产生多条（视频逐条索引 + 其余文件打包）
  let primary = null;
  try {
    if (payload.kind === 'url') {
      const r = await extractFromUrl(payload.url);
      primary = store.insert({
        kind: 'url', url: r.finalUrl, title: r.title, text: r.text,
        notes: payload.notes || '', source_path: r.site,
        // 飞书适配：记录对象类型/token；登录墙时正文为空，详情页给出引导
        lark: r.lark && r.lark.type !== 'other' ? r.lark : null,
        login_wall: !!r.loginWall,
      });
      recs.push(primary);
    } else if (payload.kind === 'file' || payload.kind === 'video' || payload.kind === 'image') {
      const paths = payload.filePaths || [];
      const videos = paths.filter(p => isVideoFile(p));
      const pics = paths.filter(p => isImageFile(p));
      const others = paths.filter(p => !isVideoFile(p) && !isImageFile(p));
      // 视频：只建索引不复制 —— kind=video，source_path 指向原文件，元数据走 worker 并行探测
      if (videos.length) {
        const metas = await videoMetasViaPool(videos);
        for (let i = 0; i < videos.length; i++) {
          const rec = store.insert({
            kind: 'video', title: makeTitleFromPath(videos[i]),
            notes: payload.notes || '', source_path: videos[i],
            video: metas[i] || null, files: [],
            source_item_id: payload.sourceItemId || null,
          });
          recs.push(rec);
          if (!primary) primary = rec;
        }
      }
      // 图片：同样只索引不复制；详情页直接预览，可收为独立图片资产
      if (pics.length) {
        for (let i = 0; i < pics.length; i++) {
          const rec = store.insert({
            kind: 'image', title: makeTitleFromPath(pics[i]),
            notes: payload.notes && i === 0 ? payload.notes : (payload.notes || ''),
            source_path: pics[i], image: imageMeta(pics[i]), files: [],
            source_item_id: payload.sourceItemId || null,
          });
          recs.push(rec);
          if (!primary) primary = rec;
        }
      }
      // 文档类：抽取全文 + 图片落盘（画廊用）+ 链接收集
      if (others.length === 1) {
        const p = others[0];
        const outDir = path.join(FILES_DIR(), 'extract', String(Date.now()));
        const [ex] = await extractManyViaPool([p], outDir);
        const saved = archiveFile(p);
        const rec = store.insert({
          kind: 'file', title: (ex && ex.title) || makeTitleFromPath(p), text: ex ? ex.text : '', notes: payload.notes || '',
          source_path: p, files: [saved],
          images: (ex && ex.images) || [], links: (ex && ex.links) || [],
        });
        recs.push(rec);
        if (!primary) primary = rec;
      } else if (others.length > 1) {
        // 多文件包：抽取全部走 worker 线程并行（保持拖入顺序合并正文），图片统一落一个目录
        const outDir = path.join(FILES_DIR(), 'extract', String(Date.now()));
        const results = await extractManyViaPool(others, outDir);
        let combined = '';
        const files = [];
        const allImages = [];
        const allLinks = [];
        for (const r of results) {
          combined += `\n\n## ${path.basename(r.path)}\n` + (r.text || '').slice(0, 20000);
          files.push(archiveFile(r.path));
          for (const im of (r.images || [])) allImages.push({ ...im, from: path.basename(r.path) });
          for (const lk of (r.links || [])) if (!allLinks.some(x => x.url === lk.url)) allLinks.push(lk);
        }
        const rec = store.insert({
          kind: 'bundle', title: `文件包 · ${others.length} 个文件`, text: combined.slice(0, 120000),
          notes: payload.notes || '', files,
          images: allImages, links: allLinks,
        });
        recs.push(rec);
        if (!primary) primary = rec;
      }
      if (!primary) throw new Error('没有可导入的文件');
    } else if (payload.kind === 'chat') {
      const rawText = String(payload.rawText || payload.notes || '');
      let msgsIn = Array.isArray(payload.messages) ? payload.messages : [];
      if (!msgsIn.length && rawText) msgsIn = parseChatText(rawText);
      const msgs = chatOps.ensureMessageIds(msgsIn.map(m => ({
        ...m,
        speaker: String((m && m.speaker) || '').trim().slice(0, 40),
        time: String((m && m.time) || '').trim().slice(0, 40),
        text: String((m && m.text) || ''),
        attachPath: String((m && m.attachPath) || ''),
        attachment: m && m.attachment,
      })).filter(m => m.text || m.attachPath || (m.attachment && (m.attachment.label || m.attachment.name))));
      const attachPaths = [...new Set(msgs.map(m => m.attachPath).filter(Boolean))];
      const extraPaths = Array.isArray(payload.filePaths) ? payload.filePaths : [];
      const allFiles = [...new Set([...attachPaths, ...extraPaths])].filter(p => p && fs.existsSync(p));
      const savedFiles = allFiles.map(p => ({ ...archiveFile(p), orig: p }));
      for (const m of msgs) {
        if (m.attachPath) {
          const hit = savedFiles.find(f => f.orig === m.attachPath);
          m.attachment = hit
            ? { path: hit.path, name: hit.name, ext: hit.ext, size: hit.size, pending: false }
            : { path: m.attachPath, name: path.basename(m.attachPath), pending: !fs.existsSync(m.attachPath) };
          delete m.attachPath;
        }
      }
      const notes = rawText || messagesToText(msgs);
      if (!notes && !savedFiles.length) throw new Error('聊天内容为空');
      const title = String(payload.chatTitle || payload.title || '').trim().slice(0, 80) || firstLine(notes) || '聊天记录';
      const batchId = require('./src/db').uid();
      primary = store.insert({
        kind: 'chat', title, text: '',
        notes, messages: msgs, files: savedFiles.map(({ orig, ...f }) => f),
        raw_text: rawText || notes,
        chat_source: String(payload.chatSource || '').slice(0, 80),
        import_batches: [{
          id: batchId, imported_at: Date.now(), raw_text: rawText || notes,
          added_ids: msgs.map(m => m.id),
          counts: { added: msgs.length, duplicate: 0, possible: 0 },
        }],
      });
      recs.push(primary);
    } else {
      primary = store.insert({ kind: 'note', title: firstLine(payload.notes) || '手写笔记', text: '', notes: payload.notes || '' });
      recs.push(primary);
    }
  } catch (e) {
    const rec = store.insert({
      kind: payload.kind === 'url' ? 'url' : 'note',
      title: payload.kind === 'url' ? payload.url : '导入失败',
      url: payload.url || '', notes: payload.notes || '',
      text: '【抓取失败：' + String(e && e.message ? e.message : e).slice(0, 200) + '】',
      status: 'error',
    });
    return rec;
  }

  // 逐条归类（视频标题/附言同样参与画像学习）
  const done = [];
  for (const rec of recs) {
    try { done.push(await classifyAndFinalize(rec)); } catch { done.push(rec); }
  }
  const saved = store.get(primary.id) || primary;
  return Object.assign({}, saved, { _ids: done.map(r => r.id) });
}

function firstLine(s) { const t = String(s || '').trim().split('\n')[0].trim(); return t.slice(0, 80); }

async function appendChatToItem(itemId, payload) {
  const it = store.get(itemId);
  if (!it || it.trashed || it.kind !== 'chat') return { ok: false, error: '找不到这条聊天' };
  const rawText = String((payload && (payload.rawText || payload.text || payload.notes)) || '').trim();
  let incoming = Array.isArray(payload && payload.messages) ? payload.messages : [];
  if (!incoming.length && rawText) incoming = parseChatText(rawText);
  if (!incoming.length) return { ok: false, error: '没有可追加的内容' };
  const plan = chatOps.planAppend(it.messages || [], incoming);
  const dropIds = new Set(payload.dropPossible ? plan.possibleDup.map(m => m.id) : (payload.dropPossibleIds || []));
  const incomingPossible = new Set(plan.possibleDup.map(m => m.id));
  const msgs = plan.messages.filter(m => !(incomingPossible.has(m.id) && dropIds.has(m.id)));
  plan.counts.keptPossible = plan.possibleDup.filter(m => !dropIds.has(m.id)).length;
  const extraPaths = Array.isArray(payload && payload.filePaths) ? payload.filePaths : [];
  const attachPaths = msgs.map(m => m.attachPath).filter(Boolean);
  const allPaths = [...new Set([...extraPaths, ...attachPaths])].filter(Boolean);
  const missing = allPaths.filter(p => !fs.existsSync(p));
  if(missing.length) return {ok:false,error:'附件找不到，请补齐或移除：'+missing.map(p=>path.basename(p)).join('、')};
  const saved = allPaths.map(p => ({ ...archiveFile(p), orig: p }));
  for (const m of msgs) {
    if (!m.attachPath) continue;
    const hit = saved.find(f => f.orig === m.attachPath);
    if (hit) {
      m.attachment = { path: hit.path, name: hit.name, ext: hit.ext, size: hit.size, pending: false };
    }
    delete m.attachPath;
  }
  const files = [...(it.files || []), ...saved.map(({ orig, ...f }) => f)];
  const batch = {
    id: require('./src/db').uid(),
    imported_at: Date.now(),
    raw_text: rawText,
    added_ids: plan.added.map(m => m.id),
    possible_ids: plan.possibleDup.filter(m=>!dropIds.has(m.id)).map(m => m.id),
    skipped_possible_ids: [...dropIds],
    counts: plan.counts,
  };
  const title = (payload && payload.chatTitle) ? String(payload.chatTitle).slice(0, 80) : it.title;
  store.update(it.id, {
    messages: msgs,
    files,
    import_batches: [...(it.import_batches || []), batch],
    raw_text: [it.raw_text || '', rawText].filter(Boolean).join('\n\n----\n\n'),
    notes: messagesToText(msgs) || it.notes,
    title,
    chat_source: (payload && payload.chatSource) != null ? String(payload.chatSource).slice(0, 80) : it.chat_source,
  });
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', { id: it.id });
  return { ok: true, id: it.id, counts: plan.counts, pending: chatOps.pendingAttachments(msgs), item: store.get(it.id) };
}

function archiveFile(p) {
  try {
    const dir = path.join(FILES_DIR(), require('./src/db').uid());
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(p));
    fs.copyFileSync(p, dest);
    const st = fs.statSync(dest);
    return { path: dest, name: path.basename(p), ext: path.extname(p).slice(1), size: st.size };
  } catch { return { path: p, name: path.basename(p), ext: path.extname(p).slice(1), size: 0 }; }
}

async function ingestAndNotify(payload, win) {
  const rec = await pipelineIngest(payload);
  if (rec.status === 'error') throw new Error(rec.text || '导入失败，原文仍保留');
  if (win && !win.isDestroyed()) win.webContents.send('ingest:done', {
    id: rec.id, title: rec.title, category: rec.category, tags: rec.tags,
    source: rec.classification_source,
    ids: rec._ids || [rec.id], // 本次提交产生的全部条目（多视频/图片拆分场景的撤销依据）
  });
  const c = loadConfig();
  if (c.notifyOnIngest !== false && Notification.isSupported()) {
    const isVideo = rec.kind === 'video';
    const isImage = rec.kind === 'image';
    const dur = isVideo && rec.video && rec.video.duration ? ' · ' + formatDuration(rec.video.duration) : '';
    const n = new Notification({
      title: isVideo ? '🎬 视频已建索引（原文件未复制）' : isImage ? '🖼 图片已收录' : '✓ 已入库',
      body: `${rec.title.slice(0, 40)}${dur}\n分类：${rec.category}${rec.tags.length ? ' · ' + rec.tags.join(' / ') : ''}`,
      silent: false,
      threadId: 'lv-ingest', // 连续收录时折叠成一组，不轰炸通知中心
    });
    n.on('click', () => createMainWindow());
    n.show();
  }
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', { id: rec.id });
  pushOverlayCount();
  checkMilestones();
  // 主窗侧栏「今日复习」计数同步刷新
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.send('srs:count-changed', srs.dueCards(srsCards, Date.now(), 9999).length); } catch {}
  }
  return rec;
}

// ---------- 积累统计与里程碑 ----------
// 积累统计与里程碑
function statsSnapshot() {
  const s = computeStats({ items: store.allItems(), quotes: store.listQuotes(), dailyCounts: dailyCountsAll() });
  // 成就墙：每枚徽章附达成时间（config.milestoneDates，键 = 徽章 id）；存量旧成就无记录 → null，不补造
  try {
    const dates = loadConfig().milestoneDates || {};
    s.badges = (s.badges || []).map(b => ({ ...b, achievedAt: dates[b.id] || null }));
  } catch {}
  return s;
}
function sTreakLive() { try { return statsSnapshot().streak || 0; } catch { return 0; } }
// 收录/收藏后比对里程碑：跨过任意目标 → 主窗事件 + 系统通知；首次以现状为基线不补发旧账
function checkMilestones() {
  try {
    const s = statsSnapshot();
    const cur = { items: s.total, quotes: s.quotes, streak: s.streak };
    const c = loadConfig();
    if (!c.milestoneSeen) {
      const c2 = loadConfig(); c2.milestoneSeen = { ...cur }; saveConfig(c2);
      return;
    }
    const just = [];
    const prevSeen = c.milestoneSeen;
    for (const kind of ['items', 'quotes', 'streak']) {
      const nowV = cur[kind], seenV = prevSeen[kind] || 0;
      if (kind === 'streak' && nowV <= seenV) continue; // streak 只在增长当天触发
      const nowT = reachedTarget(kind, nowV), seenT = reachedTarget(kind, seenV);
      if (nowT > seenT) {
        for (const m of MILESTONES) if (m.kind === kind && m.target > seenT && m.target <= nowT) just.push(m);
      }
    }
    // 记录高水位：删除/断签回落不回退基线，避免重复轰炸
    const c2 = loadConfig();
    c2.milestoneSeen = {
      items: Math.max(cur.items, prevSeen.items || 0),
      quotes: Math.max(cur.quotes, prevSeen.quotes || 0),
      streak: Math.max(cur.streak, prevSeen.streak || 0),
    };
    if (just.length) {
      // 成就达成日期：键 = `${kind}-${target}`（MILESTONES 项无 id 字段），与 buildBadges 徽章 id 同规则；首达时间不覆盖
      const dates = c2.milestoneDates || {};
      const nowTs = Date.now();
      for (const m of just) {
        const bid = m.id || `${m.kind}-${m.target}`;
        if (!dates[bid]) dates[bid] = nowTs;
      }
      c2.milestoneDates = dates;
    }
    saveConfig(c2);
    for (const m of just) {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('stats:milestone', { kind: m.kind, label: m.label, icon: m.icon });
      if (Notification.isSupported()) {
        const n = new Notification({ title: `🎖️ 成就达成 · ${m.label}`, body: `${m.icon} 继续积累，下一个目标就在前方` });
        n.on('click', () => createMainWindow());
        n.show();
      }
    }
  } catch (e) { console.error('milestone check error:', e); }
}

// 积压护栏（P1）：角标显示 min(due, dailyLimit)，title 显示真实总数；积压超 3×上限给出分期建议
function srsGuardedCount() {
  const limit = Math.max(1, parseInt(loadConfig().srsDailyLimit, 10) || 5);
  const total = srs.dueCards(srsCards, Date.now(), 9999).length;
  const plan = srs.backlogPlan(srsCards, Date.now(), limit);
  return { total, shown: Math.min(total, limit), limit, plan };
}
function pushSrsCount() {
  const g = srsGuardedCount();
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.webContents.send('overlay:srs', g.shown, { total: g.total, plan: g.plan }); } catch {}
  }
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.send('srs:count-changed', { shown: g.shown, total: g.total, plan: g.plan }); } catch {}
  }
}

// 悬浮球今日计数徽标
function pushOverlayCount() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.webContents.send('overlay:count', store.itemsOfDay(localDayKey()).length); } catch {}
  }
  // 悬浮按钮同时带上待复习数（琥珀徽标，P1 起护栏口径）：余光可见今天还有没还的「记忆债」
  pushSrsCount();
}

// ---------- 复盘 ----------
// 全历史日计数（streak / bestStreak 用），日键规则与 localDayKey 一致
function dailyCountsAll() {
  const out = {};
  for (const it of store.allItems()) {
    if (typeof it.created_at !== 'number') continue;
    const k = localDayKey(new Date(it.created_at));
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
// 复盘用统计快照：完整积累统计（streak/称号/里程碑/徽章）+ 旧字段（total/byCategory 保持近7天口径，兼容既有调用）
function weeklyStatsNow() {
  const s = statsSnapshot();
  const arr = store.itemsOfRange(Date.now() - 7 * 86400000, Date.now() + 60000);
  const byCategory = {};
  for (const i of arr) byCategory[i.category] = (byCategory[i.category] || 0) + 1;
  return { ...s, allTimeTotal: s.total, total: arr.length, byCategory };
}

// ---------- 画像成长（周报/月报嵌入用） ----------
// 纯函数：词→权重表取 topN 词（权重降序，稳定排序）
function topTermsOfTerms(terms, n) {
  return Object.entries(terms || {})
    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
    .slice(0, n)
    .map(([t]) => t);
}
// 纯函数：画像成长 diff —— 当前画像词表 vs 上次快照（{ 分类名: [词...] }）
// 返回 { isFirst, cats: [{ name, added: 新增词（权重降序，≤5） }] }
function computeProfileGrowth(curCats, prevCats) {
  const prev = (prevCats && typeof prevCats === 'object' && !Array.isArray(prevCats)) ? prevCats : null;
  const cats = [];
  for (const [name, p] of Object.entries(curCats || {})) {
    const prevSet = new Set((prev && prev[name]) || []);
    const added = topTermsOfTerms(p && p.terms, 20).filter(t => !prevSet.has(t)).slice(0, 5);
    cats.push({ name, added });
  }
  return { isFirst: !prev, cats };
}
// 纯函数：由画像数据生成快照 cats（每类 top20 词）
function snapshotCatsFromProfile(profileData) {
  const out = {};
  for (const [name, p] of Object.entries((profileData && profileData.categories) || {})) {
    out[name] = topTermsOfTerms(p && p.terms, 20);
  }
  return out;
}
// 组装：当前画像 vs config.profileSnapshot（上次周报/月报落下的快照）
function buildProfileGrowth() {
  const snap = loadConfig().profileSnapshot;
  const prevCats = (snap && snap.cats && typeof snap.cats === 'object' && !Array.isArray(snap.cats)) ? snap.cats : null;
  const curCats = catProfile ? catProfile.data.categories : {};
  const { isFirst, cats } = computeProfileGrowth(curCats, prevCats);
  return { isFirst, cats, snapshot: { t: Date.now(), cats: snapshotCatsFromProfile(catProfile ? catProfile.data : null) } };
}

async function generateAndSaveReview(mode) {
  const now = new Date();
  let items, label;
  if (mode === 'weekly') {
    items = store.itemsOfRange(Date.now() - 7 * 86400000, now.getTime() + 60000);
    label = '本周';
  } else if (mode === 'cycle') {
    // 知识积累复盘：近 N 天（周期可配 reviewCycleDays，默认 3）
    const days = Math.max(2, parseInt(loadConfig().reviewCycleDays, 10) || 3);
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
    items = store.itemsOfRange(from, now.getTime() + 60000);
    label = `近${days}天`;
  } else if (mode === 'monthly') {
    // 本月知识资产盘点：近 30 天
    items = store.itemsOfRange(now.getTime() - 30 * 86400000, now.getTime() + 60000);
    label = '本月';
  } else {
    items = store.itemsOfDay(localDayKey(now));
    label = '今日';
  }
  const rangeFrom = mode === 'weekly' ? Date.now() - 7 * 86400000
    : mode === 'monthly' ? now.getTime() - 30 * 86400000
    : mode === 'cycle' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((Math.max(2, parseInt(loadConfig().reviewCycleDays, 10) || 3) - 1))).getTime()
    : new Date(localDayKey(now) + 'T00:00:00').getTime();
  const outcomes = weekOutcomes({
    items, allItems: store.allItems(), ideas: ideaItems,
    from: rangeFrom, to: now.getTime() + 60000,
  });
  if (!items.length && mode !== 'weekly') {
    return { ok: false, error: '该时段还没有录入或使用记录' };
  }
  // 画像成长：周报/月报嵌入（日报不嵌）—— main.js 组装 diff 数据传给 review
  let growthSnapshot = null;
  const payload = { label, items, stats: weeklyStatsNow(), mode };
  if (mode === 'weekly') payload.outcomes = outcomes;
  if (mode === 'weekly' || mode === 'monthly') {
    try {
      const g = buildProfileGrowth();
      if (g) {
        payload.profileGrowth = { isFirst: g.isFirst, cats: g.cats };
        growthSnapshot = g.snapshot;
      }
    } catch {}
  }
  const r = await generateReview(aiCfg(), payload);
  const dir = path.join(CONFIG_DIR(), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${mode}-${localDayKey(now)}.md`);
  fs.writeFileSync(file, `# ${label}学习复盘 · ${localDayKey(now)}\n\n${r.text}\n\n---\n本期录入 ${items.length} 条 · 学习资产库自动生成\n`);
  store.addReview({ mode, label, text: r.text, source: r.source, item_count: items.length, file });
  // 报告生成成功后写回本次画像快照，下次周报/月报与它对比
  if (growthSnapshot) {
    try { const c9 = loadConfig(); c9.profileSnapshot = growthSnapshot; saveConfig(c9); } catch {}
  }
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
  return { ok: true, label, text: r.text, source: r.source, file, count: items.length };
}

// ---------- 每晚引擎自检巡检（21:30 复盘后） ----------
// 契约：scripts/selfcheck.js --json → stdout 单行 { ok, passed, failed, details:[{name,pass}] }
// 解析失败或超时 → { ok:false, failed:-1 }；全程不弹窗、不阻塞复盘流程
function parseSelfcheckOutput(stdout) {
  try {
    for (const line of String(stdout || '').split('\n')) {
      const s = line.trim();
      if (!s || s[0] !== '{') continue;
      let j = null;
      try { j = JSON.parse(s); } catch { continue; }
      if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.ok === 'boolean') {
        const passed = Number.isFinite(Number(j.passed)) ? Number(j.passed) : 0;
        const failed = (j.failed == null || !Number.isFinite(Number(j.failed)))
          ? (j.ok ? 0 : -1)
          : Number(j.failed);
        return { ok: j.ok, passed, failed };
      }
    }
  } catch {}
  return { ok: false, passed: 0, failed: -1 };
}

function runSelfcheckOnce() {
  return new Promise((resolve) => {
    try {
      execFile(process.execPath, ['scripts/selfcheck.js', '--json'], {
        timeout: 60000, cwd: __dirname, detached: false, windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }, (err, stdout) => {
        // 退出码非 0（有失败项）时 stdout 仍带契约 JSON → 优先解析；超时/起不来再兜底
        if (err && !String(stdout || '').trim()) return resolve({ ok: false, passed: 0, failed: -1 });
        resolve(parseSelfcheckOutput(stdout));
      });
    } catch { resolve({ ok: false, passed: 0, failed: -1 }); }
  });
}

// 结果写 config.selfcheckLast；ok=false 且当日日报已生成 → 日报末尾追加告警行
async function runNightlySelfcheck(dailyReportFile) {
  try {
    const sc = await runSelfcheckOnce();
    const c = loadConfig();
    c.selfcheckLast = { t: Date.now(), ok: sc.ok, passed: sc.passed, failed: sc.failed };
    saveConfig(c);
    if (!sc.ok && dailyReportFile && fs.existsSync(dailyReportFile)) {
      const line = sc.failed >= 0
        ? `⚠ 引擎自检：${sc.failed} 项异常，建议跑 npm run selfcheck 查看详情`
        : '⚠ 引擎自检：运行异常（超时或输出异常），建议跑 npm run selfcheck 查看详情';
      fs.appendFileSync(dailyReportFile, `\n${line}\n`);
    }
    // 自检异常 → 系统通知（ok=true 绝不弹；Notification 不可用或异常时静默跳过）
    if (!sc.ok) {
      try {
        if (Notification.isSupported()) {
          const n = new Notification({
            title: '学习资产库 · 引擎自检异常',
            body: sc.failed === -1
              ? '自检运行异常（超时或输出异常），点击查看'
              : `${sc.failed} 项异常，建议跑 npm run selfcheck 查看详情`,
          });
          n.on('click', () => {
            try { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } } catch {}
          });
          n.show();
        }
      } catch {}
    }
  } catch (e) { console.error('selfcheck patrol error:', e); }
}

// ---------- 问答式成卡（P1）：AI 可选生成 {q,a}，失败/无 AI 静默回退模板 ----------
// 带超时的 AI 问答（成卡不阻塞主流程：拿不到就用模板）
async function aiCardQA(item) {
  const cfg = aiCfg();
  if (!cfg.baseUrl || !cfg.apiKey) return null;
  try {
    const p = cardQA.qaPrompt(item);
    const out = await requestChat(cfg, {
      temperature: 0.2,
      messages: [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
    }, { timeoutMs: 20000 });
    return cardQA.parseCardQA(out);
  } catch { return null; } // AI 失败必须静默回退
}

// 星标/金句自动成卡时尝试 AI 问答；成功记 generated_by:'ai'，否则模板
async function addSrsCardWithAI(item, kind, fallbackFront, fallbackBack) {
  const qa = await aiCardQA(item);
  if (qa) return addSrsCard({ itemId: item.id, kind, front: qa.q, back: qa.a, generatedBy: 'ai' });
  return addSrsCard({ itemId: item.id, kind, front: fallbackFront, back: fallbackBack, generatedBy: 'template' });
}

// 每晚定时复盘（默认 21:30，autoReview=false 可关）
let reviewTimerStarted = false;
// ---------- 资料级回看（P0）：名单计算与主窗导航 ----------
function resurfaceList() {
  const t = Date.now();
  const srsTodayIds = new Set(srs.dueCards(srsCards, t, 9999).map(c => c.itemId).filter(Boolean));
  const items = store.allItems().filter(i => !i.resurface_snoozed_until || t >= i.resurface_snoozed_until);
  return srs.resurfaceItems(items, {
    excludeIds: [...srsTodayIds],
    limit: Math.max(1, parseInt(loadConfig().resurfaceLimit, 10) || 3),
  }, t);
}

// 通知可达（P0）：主窗支持导航事件 {view, itemId?}，通知点击直达对应视图/条目
function navigateMainWindow({ view, itemId } = {}) {
  createMainWindow();
  const send = () => { try { mainWin.webContents.send('main:navigate', { view, itemId }); } catch {} };
  if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', send); else send();
}

// ---------- 窗口内职责（P0 重构）：日报 / 自检巡检 / 晚间小结 / 周期复盘 / 周报 / 月报 / 周备份 ----------
// 原 startReviewScheduler 每分钟窗口逻辑整体抽出；now/catchUp 可注入（selfcheck 直测；catchUp=true 时为补发路径）
async function runNightlyDuties(now, { catchUp = false } = {}) {
  const c = loadConfig();
  if (c.autoReview === false) return;
  const dk = localDayKey(now);
  const target = nightly.parseTarget(c.autoReviewTime);
  let nightlyParts = [];
  if (!catchUp) {
    // 断签预警：21:00（复盘窗口前 30 分钟）今天还没录入且 streak ≥ 2 → 温和提醒一次（窗口内专属，补发不发）
    const cur = now.getHours() * 60 + now.getMinutes();
    const warnMin = target - 30;
    if (cur >= warnMin && cur < target && (c.lastStreakWarn || '') !== dk && sTreakLive() >= 2) {
      if (store.itemsOfDay(dk).length === 0) {
        const c4 = loadConfig(); c4.lastStreakWarn = dk; saveConfig(c4);
        if (Notification.isSupported()) {
          const n = new Notification({ title: '🔥 连续记录保卫战', body: `今晚录一条就能续上 ${sTreakLive()} 天连续记录，别断了`, threadId: 'lv-nightly' });
          n.on('click', () => createQuickWin());
          n.show();
        }
      } else {
        const c4 = loadConfig(); c4.lastStreakWarn = dk; saveConfig(c4); // 今天已录，标记免打扰
      }
    }
  }
  if (c.lastDailyReview !== dk) {
    const items = store.itemsOfDay(dk);
    let dailyReportFile = null;
    if (items.length) {
      const r = await generateAndSaveReview('daily');
      dailyReportFile = (r && r.file) || null;
      const c2 = loadConfig(); c2.lastDailyReview = dk; saveConfig(c2);
      nightlyParts.push(`📖 今日复盘 ${r.count} 条`);
    } else {
      const c2 = loadConfig(); c2.lastDailyReview = dk; saveConfig(c2);
    }
    // 每晚引擎自检巡检：跟随 daily 生成路径，一天只触发一次；失败绝不阻塞复盘
    await runNightlySelfcheck(dailyReportFile);
    // 🔁 记忆复习 + 🔍 资料级回看 + 💡 点子陈化：并入晚间小结
    const srsN = srs.dueCards(srsCards, Date.now(), 9999).length;
    if (srsN > 0 && c.srsNotify !== false) nightlyParts.push(`🔁 待复习 ${srsN} 张`);
    let nightlyResurface = false;
    try {
      const rsN = resurfaceList().length;
      if (rsN > 0 && c.resurfaceNotify !== false) { nightlyParts.push(`🔍 该回看了 ${rsN} 条`); nightlyResurface = true; }
    } catch {}
    const dueIdeas = ideas.dueIdeas(ideaItems, Date.now(), c.ideaNudgeDays);
    if (dueIdeas.length && c.ideaNotify !== false) nightlyParts.push(`💡 ${dueIdeas.length} 个点子到了提醒时间`);
    if (now.getDay() === 0 && c.ideaNotify !== false) { const week = ideas.thisWeekIdeas(ideaItems); if (week.length) nightlyParts.push(`本周想推进 ${week.length} 个点子`); }
    if (nightlyParts.length && Notification.isSupported()) {
      const n = new Notification({ title: catchUp ? '🌙 补发的小结' : '🌙 晚间小结', body: nightlyParts.join(' · '), threadId: 'lv-nightly' });
      n.on('click', () => nightlyResurface ? navigateMainWindow({ view: 'resurface' }) : createMainWindow());
      n.show();
      // 点子记账：本轮已提醒（周期退避从这里起算）
      for (const i of c.ideaNotify !== false ? dueIdeas : []) {
        const rec = ideaItems.find(x => x.id === i.id);
        if (rec) { rec.nudgeCount = (rec.nudgeCount || 0) + 1; rec.nudgedAt = Date.now(); }
      }
      saveIdeas();
    }
  }
  // 每 N 天知识积累复盘（默认 3 天一个周期）
  const cycleDays = Math.max(2, parseInt(c.reviewCycleDays, 10) || 3);
  if (!c.lastCycleReview) {
    const c3 = loadConfig(); c3.lastCycleReview = dk; saveConfig(c3); // 首次启动定锚
  } else {
    const lastCyc = new Date(c.lastCycleReview + 'T00:00:00').getTime();
    if (!isNaN(lastCyc) && now.getTime() - lastCyc >= cycleDays * 86400000) {
      const rc = await generateAndSaveReview('cycle');
      const c3 = loadConfig(); c3.lastCycleReview = dk; saveConfig(c3);
      if (rc.ok && Notification.isSupported()) {
        const n = new Notification({ title: '🧭 知识积累复盘已生成', body: `近${cycleDays}天录入 ${rc.count} 条，点击查看积累脉络`, threadId: 'lv-nightly' });
        n.on('click', () => createMainWindow());
        n.show();
      }
    }
  }
  // 每周日自动周报
  if (now.getDay() === 0 && c.lastWeeklyReview !== dk) {
    const r = await generateAndSaveReview('weekly');
    if (r.ok) {
      const c2 = loadConfig(); c2.lastWeeklyReview = dk; saveConfig(c2);
      if (Notification.isSupported()) {
        const n = new Notification({ title: '📅 本周学习复盘已生成', body: `本周累计 ${weeklyStatsNow().total} 条，点击查看`, threadId: 'lv-nightly' });
        n.on('click', () => createMainWindow());
        n.show();
      }
    }
  }
  // 每月 1 号 · 本月知识资产盘点（近 30 天全景）
  if (now.getDate() === 1 && c.lastMonthlyReview !== localMonthKey(now)) {
    const r = await generateAndSaveReview('monthly');
    const c2 = loadConfig(); c2.lastMonthlyReview = localMonthKey(now); saveConfig(c2);
    if (r.ok && Notification.isSupported()) {
      const n = new Notification({ title: '📦 本月复盘已生成', body: `近30天累计 ${r.count} 条，点击查看知识资产盘点`, threadId: 'lv-nightly' });
      n.on('click', () => createMainWindow());
      n.show();
    }
  }
  // 每周静默自动备份（Time Machine 心智：配置了 autoBackupDir 才生效，保留最近 8 份，绝不弹窗）
  const bkDir = c.autoBackupDir;
  if (bkDir && Date.now() - (c.lastAutoBackup || 0) >= 7 * 86400000) {
    try {
      if (fs.existsSync(bkDir)) {
        const bkFile = path.join(bkDir, `学习资产库备份-${localDayKey()}.json`);
        fs.writeFileSync(bkFile, JSON.stringify(exportBundle()));
        const olds = fs.readdirSync(bkDir).filter(f => /^学习资产库备份-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
        for (const f of olds.slice(0, -8)) { try { fs.unlinkSync(path.join(bkDir, f)); } catch {} }
        const c6 = loadConfig(); c6.lastAutoBackup = Date.now(); saveConfig(c6);
      }
    } catch (e) { console.error('auto backup error:', e); }
  }
}

// ---------- 补跑检查（P0）：错过 21:30 窗口（睡眠/未运行）后恢复 ----------
// 三个时机调用：whenReady 延迟 20s / powerMonitor resume / unlock-screen；同日防重（config.lastCatchUp）
let catchUpRunning = false;
async function checkMissedDuties() {
  if (catchUpRunning) return;
  const now = new Date();
  const c = loadConfig();
  const target = nightly.parseTarget(c.autoReviewTime);
  if (!nightly.shouldCatchUp(c, now, target)) return;
  catchUpRunning = true;
  try {
    await runNightlyDuties(now, { catchUp: true });
    const c2 = loadConfig(); c2.lastCatchUp = localDayKey(now); saveConfig(c2);
  } catch (e) { console.error('catch-up duties error:', e); }
  finally { catchUpRunning = false; }
}

// ---------- 每分钟 tick：点子显式提醒（原逻辑不变） + 窗口内职责 + 补跑兜底 ----------
function startReviewScheduler() {
  if (reviewTimerStarted) return;
  reviewTimerStarted = true;
  setInterval(async () => {
    try {
      const c = loadConfig();
      if(c.ideaNotify !== false && Notification.isSupported()) {
        const due=ideaItems.filter(i=>i.remind_at && ideas.nudgeDue(i,Date.now()) && !(i.nudgedAt>=i.remind_at));
        if(due.length){const n=new Notification({title:'点子提醒',body:due.map(i=>i.text).slice(0,3).join(' · '),threadId:'lv-ideas'});n.on('click',()=>{createIdeaWin();const first=due[0];if(first&&ideaWin&&!ideaWin.isDestroyed()){const send=()=>ideaWin.webContents.send('ideas:focus',first.id);if(ideaWin.webContents.isLoading())ideaWin.webContents.once('did-finish-load',send);else send();}});n.show();for(const i of due)i.nudgedAt=Date.now();saveIdeas();}
      }
      if (c.autoReview === false) return;
      const now = new Date();
      const target = nightly.parseTarget(c.autoReviewTime);
      const cur = now.getHours() * 60 + now.getMinutes();
      // 窗口内：正常职责（原逻辑）
      if (cur >= target && cur < target + 30) {
        await runNightlyDuties(now);
        return;
      }
      // 窗口外：错过补跑兜底（每分钟静默检查一次，同日只补一次）
      await checkMissedDuties();
    } catch (e) { console.error('review tick error:', e); }
  }, 60 * 1000);
}

// ---------- 倒排索引缓存 ----------
// library:search / quotes:related(相似条目) 共用：首次查询构建，任何落库（store.save 已被包装置空）后懒重建
function getSearchIndex() {
  if (!idxCache) {
    const docs = store.allItems().map(docOf);
    if (extractStore) {
      for (const d of extractStore.asSearchDocs()) docs.push(docOf(d));
    }
    for (const i of ideaItems) {
      if (!i) continue;
      docs.push(docOf({
        id: 'idea:' + i.id, title: i.text, kind: 'idea', category: '点子',
        notes: [i.note, i.next_action, i.result_note].filter(Boolean).join('\n'),
        text: i.text, tags: ['点子'], created_at: i.created_at, trashed: false,
      }));
    }
    idxCache = { builtAt: Date.now(), index: buildInverted(docs) };
  }
  return idxCache.index;
}

function exportBundle() {
  return {
    exported_at: Date.now(),
    version: app.getVersion(),
    attachments: 'paths-only',
    items: store.items,
    reviews: store.reviews,
    quotes: store.quotes,
    events: store.events,
    ideas: ideaItems,
    extracts: extractStore ? extractStore.items : [],
    userRules: userRules ? userRules.rules : [],
    srsCards,
    drafts: draftStore ? draftStore.data : {},
    categoryRules: catRules ? catRules.data : {},
    categoryProfile: catProfile ? catProfile.data : {},
  };
}

function resolveSearchHit(h) {
  const id = h.id;
  if (String(id).startsWith('ex:') && extractStore) {
    const ex = extractStore.get(id.slice(3));
    if (!ex || ex.trashed) return null;
    return {
      ...ex, id, title: ex.title, kind: ex.kind, category: '整理',
      summary: (ex.ai_draft ? 'AI 草稿 · ' : '') + (ex.body || '').slice(0, 120),
      _score: h.score, _resultType: ex.kind, _extractId: ex.id, _sourceItemId: ex.source_item_id,
      created_at: ex.created_at,
    };
  }
  if (String(id).startsWith('idea:')) {
    const idea = ideaItems.find(x => x.id === id.slice(5));
    if (!idea) return null;
    const st = ideas.migrateIdea(idea);
    return {
      ...st, id, title: st.text, kind: 'idea', category: '点子',
      summary: (ideas.STATUSES[st.status] || {}).label + (st.next_action ? ' · ' + st.next_action : ''),
      _score: h.score, _resultType: 'idea', _ideaId: st.id, created_at: st.created_at,
    };
  }
  const it = store.get(id);
  if (!it || it.trashed) return null;
  return { ...it, _score: h.score, _resultType: it.kind };
}

// 画像词表 top12（按权重降序）→ 画像可视化数据
function profileTopTerms(p) {
  if (!p || !p.terms) return [];
  return Object.entries(p.terms)
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12);
}

// ---------- IPC ----------
function registerIpc() {
  // 悬浮球：拖放直收 / 打开快速窗
  ipcMain.on('overlay:ingest', (e, payload) => { ingestAndNotify(payload, null); });
  ipcMain.on('overlay:quick-with', (e, payload) => { pendingDrops.push(payload); createQuickWin(); });
  // 快捷开口：收录按钮（＋ 收录 / 收录内容）与悬浮按钮的打开动作都走这两条通道
  ipcMain.on('overlay:open-quick', () => createQuickWin());
  ipcMain.on('overlay:open-main', () => createMainWindow());
  ipcMain.on('overlay:reset-pos', () => overlayResetPos());
  ipcMain.on('overlay:menu', () => popupOverlayMenu());
  ipcMain.on('overlay:hide', () => {
    const c = loadConfig(); c.overlayVisible = false; saveConfig(c);
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
    if (tray) tray.setContextMenu(buildTrayMenu());
  });

  ipcMain.on('quick:submit', (e, payload) => {
    const w = quickWin;
    ingestAndNotify(payload, w);
    // 不再瞬隐：渲染层收到 ingest:done 后显示「✓ 已入库 · 撤销」条，自行收起（动作先行，反悔在后）
  });
  ipcMain.on('quick:close', () => { if (quickWin && !quickWin.isDestroyed()) quickWin.hide(); });

  ipcMain.handle('dialog:openFiles', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  // 视频库：选一个文件夹递归扫描（worker 线程里跑，主进程不卡）
  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? '' : (r.filePaths[0] || '');
  });
  // 用系统默认播放器打开视频原文件（索引条目不复制文件，播放回到原位置）
  ipcMain.handle('app:openFile', async (e, p) => {
    if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在（可能已被移动或删除）' };
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  });
  // 视频文件夹批量索引：扫描 → 跳过已索引 → 元数据并行探测 → 逐条入库归类
  ipcMain.handle('library:scanVideos', async (e, { folder } = {}) => {
    const dir = String(folder || '').trim();
    if (!dir) return { ok: false, error: '缺少文件夹路径' };
    let scan;
    const pool = getPool();
    try {
      if (pool) scan = await pool.run('scan-videos', { folder: dir }, { timeoutMs: 120000 });
      else scan = await inProcessFallback()['scan-videos']({ folder: dir });
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
    const files = (scan && scan.files) || [];
    const existing = new Set(store.allItems().filter(i => i.kind === 'video').map(i => i.source_path));
    const fresh = files.filter(f => f && f.path && !existing.has(f.path));
    const metas = fresh.length ? await videoMetasViaPool(fresh.map(f => f.path)) : [];
    const added = [];
    for (let i = 0; i < fresh.length; i++) {
      const rec = store.insert({
        kind: 'video', title: makeTitleFromPath(fresh[i].path),
        notes: '', source_path: fresh[i].path, video: metas[i] || null, files: [],
      });
      try { await classifyAndFinalize(rec); } catch {}
      added.push(rec.id);
      if (mainWin && !mainWin.isDestroyed() && i % 5 === 0) {
        mainWin.webContents.send('scan:progress', { done: i + 1, total: fresh.length });
      }
    }
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
    checkMilestones();
    return { ok: true, scanned: files.length, added: added.length, skipped: files.length - fresh.length, truncated: !!(scan && scan.truncated) };
  });
  ipcMain.handle('app:readClipboard', () => {
    try { return require('electron').clipboard.readText() || ''; } catch { return ''; }
  });
  // 聊天记录智能拆分：粘贴的大段文本 → 有序消息块（quick 收录窗「✂ 从剪贴板拆分」用）
  ipcMain.handle('chat:parse', (e, text) => {
    try { return parseChatText(String(text || '')); } catch { return []; }
  });

  // ---- 金句 IPC ----
  ipcMain.handle('quotes:add', async (e, q) => {
    const rec = store.addQuote(q || {});
    // 金句自动成复习卡（亲手摘的天然高价值；幂等；P1 起 AI 可选生成问答式卡面）
    try {
      await addSrsCardWithAI(rec, 'quote', (rec.note || rec.source || '这句为什么打动你？').slice(0, 200), rec.text || '');
    } catch {}
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
    checkMilestones(); // 金句里程碑（妙语拾遗等）
    return rec;
  });
  ipcMain.handle('quotes:list', (e, f) => store.listQuotes(f || {}));
  // 知识体系：金句 ↔ 原文条目双向关联
  ipcMain.handle('quotes:byItem', (e, itemId) => store.listQuotes({ itemId }));
  ipcMain.handle('quotes:related', (e, { itemId, tags } = {}) => {
    // 同源金句（同一原文） + 同标签金句 + 同标签条目 + 内容相似条目（倒排索引），供详情页/金句页互跳
    const all = store.listQuotes();
    const sameSource = all.filter(q => q.source_item_id === itemId);
    const tset = new Set((tags || []).map(String));
    const sameTags = all.filter(q => !(q.source_item_id === itemId) && (q.tags || []).some(t => tset.has(t)));
    const it = itemId ? store.get(itemId) : null;
    let relatedItems = [];
    if (it && (it.tags || []).length) {
      relatedItems = store.allItems().filter(x => x.id !== itemId && (x.tags || []).some(t => (it.tags || []).includes(t))).slice(0, 4);
    }
    // 内容相似：拿标题+摘要作为查询走倒排索引（有标签关联时去重后补足到 4 条）
    let similar = [];
    try {
      if (it) {
        const query = (it.title || '') + ' ' + (it.summary || '') + ' ' + (it.tags || []).join(' ');
        if (query.trim().length >= 2) {
          const idx = getSearchIndex();
          const seen = new Set([itemId, ...relatedItems.map(x => x.id)]);
          similar = search(idx, query, { limit: 8 })
            .map(h => store.get(h.id)).filter(x => x && !seen.has(x.id))
            .slice(0, Math.max(0, 4 - relatedItems.length));
        }
      }
    } catch {}
    // 点击反馈回流：近 30 天被点过的相似条目排前（稳定排序，0 次保持原相关度序）
    try {
      const since = Date.now() - 30 * 86400000;
      const clicks = new Map();
      for (const ev of store.events) {
        if (ev && ev.type === 'similar_click' && ev.similarId && ev.t >= since) {
          clicks.set(ev.similarId, (clicks.get(ev.similarId) || 0) + 1);
        }
      }
      if (clicks.size && similar.length > 1) {
        similar = similar
          .map((x, i) => ({ x, i, c: clicks.get(x.id) || 0 }))
          .sort((a, b) => b.c - a.c || a.i - b.i)
          .map((en) => en.x);
      }
    } catch {}
    return { sameSource, sameTags: sameTags.slice(0, 6), relatedItems, similar };
  });
  ipcMain.handle('quotes:update', (e, { id, patch }) => store.updateQuote(id, patch));
  ipcMain.handle('quotes:remove', (e, id) => store.removeQuote(id));
  ipcMain.handle('quotes:random', () => store.randomQuote());
  // 金句引用关系（知识图谱第一层）：双向去重落库 / 引用图输出
  ipcMain.handle('quotes:link', (e, { idA, idB } = {}) => store.linkQuotes(idA, idB));
  ipcMain.handle('quotes:graph', () => store.quoteGraph());
  ipcMain.handle('quotes:export', async (e, fmt) => {
    const quotes = store.listQuotes();
    const ext = fmt === 'csv' ? 'csv' : fmt === 'json' ? 'json' : 'md';
    const r = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('documents'), `金句库-${localDayKey()}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    if (fmt === 'json') {
      fs.writeFileSync(r.filePath, JSON.stringify(quotes, null, 2));
    } else if (fmt === 'csv') {
      const escCsv = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
      const rows = [['金句', '我的理解', '来源', '标签', '收藏时间'].join(',')];
      for (const q of quotes) rows.push([q.text, q.note, q.source, (q.tags || []).join(' '), new Date(q.created_at).toLocaleString('zh-CN')].map(escCsv).join(','));
      fs.writeFileSync(r.filePath, '\ufeff' + rows.join('\n'));
    } else {
      const lines = ['# 金句库', ''];
      for (const q of quotes) {
        lines.push('> ' + (q.text || '').replace(/\n/g, '\n> '));
        if (q.note) lines.push('');
        if (q.note) lines.push('**我的理解：** ' + q.note);
        if (q.source) lines.push('**来源：** ' + q.source);
        if ((q.tags || []).length) lines.push('**标签：** ' + q.tags.join(' / '));
        lines.push('');
        lines.push('---');
        lines.push('');
      }
      fs.writeFileSync(r.filePath, lines.join('\n'));
    }
    return r.filePath;
  });
  ipcMain.handle('library:dailyCounts', () => {
    const out = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push({ date: localDayKey(d), count: store.itemsOfDay(localDayKey(d)).length });
    }
    return out;
  });

  // 库操作
  ipcMain.handle('library:list', (e, f) => store.list(f || {}));
  // 全文检索：倒排索引（标题×3/小标题×2/正文×1，BM25 风格），索引进程内缓存（落库失效，懒重建）
  ipcMain.handle('library:search', (e, { q, limit } = {}) => {
    const idx = getSearchIndex();
    const hits = search(idx, String(q || ''), { limit: limit || 40 });
    const scoreMap = new Map(hits.map(h => [h.id, h.score]));
    return hits.map(h => resolveSearchHit({ id: h.id, score: scoreMap.get(h.id) })).filter(Boolean);
  });
  // 分类目录：固定大类 + 动态用户分类（含画像强度）
  // 分类目录：固定大类 + 动态分类（含画像强度与层级信息，UI 据此渲染树）
  ipcMain.handle('taxonomy:list', () => {
    const facets = {};
    for (const it of store.list().items) facets[it.category] = (facets[it.category] || 0) + 1;
    const dynamic = Object.entries(catProfile ? catProfile.data.categories : {})
      .filter(([name]) => !BASE_CATEGORIES.includes(name))
      .map(([name, p]) => ({ name, count: facets[name] || 0, strength: p.count, isBase: false }));
    const base = BASE_CATEGORIES.map(name => ({ name, count: facets[name] || 0, isBase: true }));
    const other = Object.keys(facets).filter(n => !BASE_CATEGORIES.includes(n) && !dynamic.some(d => d.name === n))
      .map(name => ({ name, count: facets[name], strength: 0, isBase: false }));
    // 层级字段：depth（0=顶级）、parent（父全路径）；排序保证父在子前、同层按中文序
    const all = [...base, ...dynamic, ...other].map(n => ({
      ...n,
      depth: (n.name.match(/\//g) || []).length,
      parent: n.name.includes('/') ? n.name.split('/').slice(0, -1).join('/') : '',
    }));
    // 父类计数 = 自身 + 全部子孙（UI 展开父类时总数直观）
    const countOf = (name) => {
      let c = facets[name] || 0;
      for (const [cat, cnt] of Object.entries(facets)) if (cat.startsWith(name + '/')) c += cnt;
      return c;
    };
    for (const n of all) n.totalCount = countOf(n.name);
    all.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return all;
  });
  // 分类画像可视化：base 大类 + 动态分类，每类画像词表 top12（权重降序），供知识体系页画词云/强度条
  // newTerms：画像成长 —— 当前 top12 主题词中不在上次快照（config.profileSnapshot.cats[分类名]）里的词，
  // 按权重降序取前 5；该分类无快照则为 []。纯读，不写快照（快照仍由周报/月报生成后写回）
  ipcMain.handle('taxonomy:profiles', () => {
    const counts = {};
    for (const it of store.allItems()) counts[it.category] = (counts[it.category] || 0) + 1;
    const snap = loadConfig().profileSnapshot;
    const snapCats = (snap && snap.cats && typeof snap.cats === 'object' && !Array.isArray(snap.cats)) ? snap.cats : null;
    const newTermsOf = (name, p) => {
      const prev = snapCats ? snapCats[name] : null;
      if (!prev || !Array.isArray(prev)) return [];
      const prevSet = new Set(prev);
      return profileTopTerms(p).map(x => x.term).filter(t => !prevSet.has(t)).slice(0, 5);
    };
    const profiles = [];
    for (const name of BASE_CATEGORIES) {
      const p = catProfile ? catProfile.data.categories[name] : null;
      profiles.push({ name, count: counts[name] || 0, strength: p ? p.count : 0, isBase: true, terms: profileTopTerms(p), newTerms: newTermsOf(name, p) });
    }
    for (const [name, p] of Object.entries(catProfile ? catProfile.data.categories : {})) {
      if (BASE_CATEGORIES.includes(name)) continue;
      profiles.push({ name, count: counts[name] || 0, strength: p.count || 0, isBase: false, terms: profileTopTerms(p), newTerms: newTermsOf(name, p) });
    }
    // firstRun：尚无任何画像快照（周报/月报一次都没生成过）
    return { profiles, firstRun: !snapCats };
  });
  // 动态建类：支持层级名（「教程课程/视频制作」，最多三级，父类自动创建）
  ipcMain.handle('taxonomy:create', (e, { name, fromItemId, rename } = {}) => {
    const rawName = String(rename || name || '').trim();
    const segs = rawName.split('/').map(s => s.trim()).filter(Boolean);
    if (!segs.length) return { ok: false, error: '分类名不能为空' };
    if (segs.length > 3) return { ok: false, error: '最多三级分类（如 教程课程/视频制作/剪辑）' };
    if (segs.some(s => s.length < 1 || s.length > 12)) return { ok: false, error: '每级分类名 1~12 个字' };
    const label = segs.join('/');
    if (label.length > 40) return { ok: false, error: '分类全名过长' };
    if (BASE_CATEGORIES.includes(label)) return { ok: false, error: '与内置分类重名' };
    const exists = catProfile.data.categories[label] || store.list().items.some(i => i.category === label);
    // 父链逐级确保存在（父类可以挂在内置类或动态类下）
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      if (BASE_CATEGORIES.includes(prefix)) continue; // 内置父类无需建档
      if (!catProfile.data.categories[prefix]) { catProfile.cat(prefix); }
      catRules.ensure(prefix);
    }
    catProfile.save(); catRules.save();
    if (fromItemId && !exists) {
      const it = store.get(fromItemId);
      if (it) {
        store.update(fromItemId, { category: label });
        catProfile.learn(label, (it.title || '') + '\n' + (it.notes || '') + '\n' + (it.text || '').slice(0, 8000), { weight: 2 });
      }
    }
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
    return { ok: true, name: label };
  });
  // 删除动态分类：条目并入指定分类（默认资料收藏），画像与自定义关键词同步清理
  ipcMain.handle('taxonomy:remove', (e, { name, mergeInto } = {}) => {
    const label = String(name || '');
    if (BASE_CATEGORIES.includes(label)) return { ok: false, error: '内置分类不可删除' };
    const target = BASE_CATEGORIES.includes(mergeInto) ? mergeInto : '资料收藏';
    for (const it of store.list().items) if (it.category === label) store.update(it.id, { category: target });
    if (catProfile) catProfile.removeCategory(label);
    if (catRules) catRules.removeCategory(label);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
    return { ok: true };
  });
  // 自定义关键词规则：读取（含默认集）/ 整组保存 / 单词增删
  ipcMain.handle('taxonomy:rules', () => {
    const out = {};
    for (const [cat, rule] of Object.entries(catRules.all())) out[cat] = { keywords: { ...(rule.keywords || {}) } };
    return { rules: out, baseCategories: BASE_CATEGORIES };
  });
  ipcMain.handle('taxonomy:setKeywords', (e, { cat, keywords } = {}) => {
    const label = String(cat || '').trim();
    if (!label) return { ok: false, error: '缺少分类名' };
    if (!BASE_CATEGORIES.includes(label) && !catProfile.data.categories[label] && !store.list().items.some(i => i.category === label)) {
      return { ok: false, error: '分类不存在（先创建分类再配关键词）' };
    }
    catRules.ensure(label);
    const saved = catRules.setKeywords(label, keywords || {});
    return { ok: true, keywords: saved };
  });
  ipcMain.handle('library:get', (e, id) => {
    const it = store.get(id);
    // 打开即回看：记 lastOpenedAt（吃灰检测/记忆统计的原始数据；只内存更新每分钟批量落盘）
    if (it && !it.trashed) {
      it.lastOpenedAt = Date.now();
      touchOpenQueue.set(id, it.lastOpenedAt);
    }
    return it;
  });
  // lastOpenedAt 批量落盘：主窗每次选中详情都会 get，逐次写盘太吵
  const touchOpenQueue = new Map();
  setInterval(() => {
    if (!touchOpenQueue.size || !store) return;
    try { store.save(); } catch {} // items 数组已就地更新，save 即落盘
    touchOpenQueue.clear();
  }, 60 * 1000).unref();

  // ---------- 复习（SM-2）IPC ----------
  // 今日队列（到期卡 + 可选新卡，默认上限 5）
  ipcMain.handle('srs:due', () => {
    const limit = Math.max(1, parseInt(loadConfig().srsDailyLimit, 10) || 5);
    const cards = srs.dueCards(srsCards, Date.now(), limit);
    return cards.map(c => {
      const it = c.itemId && !String(c.itemId).startsWith('q') ? store.get(c.itemId) : store.getQuote ? store.getQuote(c.itemId) : null;
      return { ...c, itemTitle: it ? (it.title || '') : '', itemKind: it ? it.kind : (c.kind === 'quote' ? 'quote' : '') };
    });
  });
  // 待复习数（悬浮按钮徽标 / 侧栏计数）
  ipcMain.handle('srs:count', () => srs.dueCards(srsCards, Date.now(), 9999).length);
  // 护栏计数（P1）：{shown,total,plan}；角标/侧栏/结算页统一口径
  ipcMain.handle('srs:guard', () => srsGuardedCount());
  // 评分：1 忘了 / 2 模糊 / 3 记得 → SM-2 调度 + 事件流
  ipcMain.handle('srs:grade', (e, { cardId, grade } = {}) => {
    const card = srsCards.find(c => c.id === cardId);
    if (!card) return { ok: false, error: '卡片不存在' };
    const g = [1, 2, 3].includes(grade) ? grade : 3;
    Object.assign(card, srs.schedule(card, g));
    saveSrsCards();
    store.addEvent({ type: 'srs_review', cardId, grade: g, itemId: card.itemId, interval: card.interval });
    // 徽标与侧栏计数即时回刷（护栏口径）
    pushSrsCount();
    return { ok: true, card };
  });
  // 今日队列（复习窗操作版：含卡 ID 供跳过/暂停/编辑/撤销定位；结构同 srs:due 但不做 limit 截断标记）
  ipcMain.handle('srs:queue', () => {
    const limit = Math.max(1, parseInt(loadConfig().srsDailyLimit, 10) || 5);
    const cards = srs.dueCards(srsCards, Date.now(), limit);
    return cards.map(c => {
      const it = c.itemId && !String(c.itemId).startsWith('q') ? store.get(c.itemId) : store.getQuote ? store.getQuote(c.itemId) : null;
      return { ...c, itemTitle: it ? (it.title || '') : '', itemKind: it ? it.kind : (c.kind === 'quote' ? 'quote' : '') };
    });
  });
  // 跳过：本局不评分，due 顺延到明天 04:00（与调度锚点一致）
  ipcMain.handle('srs:skip', (e, { cardId } = {}) => {
    const card = srsCards.find(c => c.id === cardId);
    if (!card) return { ok: false, error: '卡片不存在' };
    card.due = srs.anchor4am(Date.now() + srs.DAY_MS);
    saveSrsCards();
    return { ok: true, card };
  });
  // 暂停这张：不再进入队列（可在复习窗「已暂停」列表恢复；暂停可逆）
  ipcMain.handle('srs:suspend', (e, { cardId } = {}) => {
    const card = srsCards.find(c => c.id === cardId);
    if (!card) return { ok: false, error: '卡片不存在' };
    card.suspended = true;
    card.suspendedAt = Date.now(); // 仅供暂停列表展示暂停时长，调度不使用
    saveSrsCards();
    pushSrsCount();
    return { ok: true, card };
  });
  // 已暂停列表：复习窗「已暂停」面板用，带原文标题方便认卡（不改调度字段）
  ipcMain.handle('srs:suspendedList', () => {
    return srsCards.filter(c => c && c.suspended).map(c => {
      const it = c.itemId && !String(c.itemId).startsWith('q') ? store.get(c.itemId) : store.getQuote ? store.getQuote(c.itemId) : null;
      return { ...c, itemTitle: it ? (it.title || '') : '', itemKind: it ? it.kind : (c.kind === 'quote' ? 'quote' : '') };
    });
  });
  // 恢复暂停卡：只翻回 suspended 标记，due/interval/ease/reps/lapses 全部保留——
  // 到期时间早于当前的卡自然回到今日队列，不需要用户手改 JSON
  ipcMain.handle('srs:resume', (e, { cardId } = {}) => {
    const card = srsCards.find(c => c.id === cardId);
    if (!card) return { ok: false, error: '卡片不存在' };
    card.suspended = false;
    delete card.suspendedAt;
    saveSrsCards();
    pushSrsCount();
    return { ok: true, card };
  });
  // 编辑卡面（问答修正）
  ipcMain.handle('srs:edit', (e, { cardId, front, back } = {}) => {
    const card = srsCards.find(c => c.id === cardId);
    if (!card) return { ok: false, error: '卡片不存在' };
    const f = String(front || '').trim();
    if (!f) return { ok: false, error: '问题不能为空' };
    card.front = f.slice(0, 300);
    card.back = String(back || '').trim().slice(0, 800);
    saveSrsCards();
    return { ok: true, card };
  });
  // 撤销上一评分：渲染进程把评分前快照写回（sm-2 状态不可逆推，快照最可靠）
  ipcMain.handle('srs:restore', (e, { snapshot } = {}) => {
    if (!snapshot || !snapshot.id) return { ok: false, error: '快照无效' };
    const card = srsCards.find(c => c.id === snapshot.id);
    if (!card) return { ok: false, error: '卡片不存在' };
    for (const k of ['due', 'interval', 'ease', 'reps', 'lapses', 'suspended']) {
      if (snapshot[k] !== undefined) card[k] = snapshot[k];
    }
    saveSrsCards();
    return { ok: true, card };
  });
  // 从复习卡跳到原资料（金句卡 itemId 是 quote id，走 showQuote 通道）
  ipcMain.handle('srs:openItem', (e, { cardId } = {}) => {
    const card = srsCards.find(c => c.id === cardId);
    if (!card || !card.itemId) return { ok: false, error: '没有关联来源' };
    if (String(card.itemId).startsWith('q') || card.kind === 'quote') {
      const quote = store.getQuote(card.itemId);
      if (quote && quote.source_item_id) return showLibraryItem(quote.source_item_id);
      return { ok: false, error: '金句没有关联原文' };
    }
    return showLibraryItem(card.itemId);
  });
  // 打开复习窗
  ipcMain.on('srs:open', () => createReviewWin());
  ipcMain.on('srs:close', () => { if (reviewWin && !reviewWin.isDestroyed()) reviewWin.hide(); });

  // ---------- 点子收件箱（待学习的想法） ----------
  const enrichIdea = (i) => {
    const n = ideas.migrateIdea(i);
    return {
      ...n,
      ageDays: ideas.ageDays(n),
      stale: ideas.staleness(n, Date.now(), loadConfig().ideaNudgeDays),
      statusLabel: (ideas.STATUSES[n.status] || ideas.STATUSES.clarify).label,
      related_titles: Object.fromEntries([...new Set([n.source_item_id,...n.related_item_ids||[]].filter(Boolean))].map(id=>{const it=store.get(id);return [id,it&&!it.trashed?it.title:'资料已删除'];})),
    };
  };
  ipcMain.handle('ideas:list', () => {
    const all = ideaItems.map(ideas.migrateIdea);
    const done = all.filter(i => i.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 50).map(enrichIdea);
    const parked = all.filter(i => i.status === 'parked').sort((a, b) => (b.lastTouchedAt || 0) - (a.lastTouchedAt || 0)).map(enrichIdea);
    const open = all.filter(i => i.status !== 'done' && i.status !== 'parked').sort((a, b) => (a.created_at || 0) - (b.created_at || 0)).map(enrichIdea);
    return { open, done, parked, due: ideas.dueIdeas(ideaItems, Date.now(), loadConfig().ideaNudgeDays).length, thisWeek: ideas.thisWeekIdeas(ideaItems).map(enrichIdea) };
  });
  ipcMain.handle('ideas:add', (e, { text, note } = {}) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, error: '点子是空的' };
    const dup = ideaItems.find(i => ideas.ideaStatus(i) !== 'done' && ideas.ideaStatus(i) !== 'parked' && norm(i.text) === norm(t));
    if (dup) return { ok: true, idea: enrichIdea(dup), deduped: true };
    const rec = ideas.migrateIdea({
      id: require('./src/db').uid(),
      text: t.slice(0, 500),
      note: String(note || '').slice(0, 1000),
      created_at: Date.now(),
      lastTouchedAt: null, nudgedAt: null, nudgeCount: 0,
      done: false, doneAt: null, status: 'clarify', reminder_mode: 'weekly',
    });
    ideaItems.push(rec);
    saveIdeas();
    idxCache = null;
    pushIdeaCount();
    return { ok: true, idea: enrichIdea(rec) };
  });
  ipcMain.handle('ideas:done', (e, { id } = {}) => {
    const it = ideaItems.find(i => i.id === id);
    if (!it) return { ok: false, error: '点子不存在' };
    ideas.setStatus(it, 'done');
    saveIdeas();
    pushIdeaCount();
    return { ok: true };
  });
  // ⏰ 再等等：重置本轮提醒（按周期退避，下次再催）
  ipcMain.handle('ideas:snooze', (e, { id } = {}) => {
    const it = ideaItems.find(i => i.id === id);
    if (!it) return { ok: false, error: '点子不存在' };
    it.nudgeCount = (it.nudgeCount || 0) + 1;
    it.nudgedAt = Date.now();
    saveIdeas();
    return { ok: true };
  });
  // 恢复误点"学了"的点子：保留原 created_at（存放时长不洗白）；提醒从今天重新计周期，
  // 退避档位（nudgeCount）保留——催过多次的点子不会立刻又 3 天一催
  ipcMain.handle('ideas:restore', (e, { id } = {}) => {
    const it = ideaItems.find(i => i.id === id);
    if (!it) return { ok: false, error: '点子不存在' };
    ideas.setStatus(it, 'clarify');
    it.nudgedAt = Date.now();
    saveIdeas();
    pushIdeaCount();
    const cycle = ideas.nextCycleDays(it.nudgeCount);
    return { ok: true, idea: enrichIdea(it), nextNudgeDays: cycle };
  });
  ipcMain.handle('ideas:remove', (e, { id } = {}) => {
    ideaItems = ideaItems.filter(i => i.id !== id);
    saveIdeas();
    pushIdeaCount();
    return { ok: true };
  });
  ipcMain.handle('ideas:count', () => ideaItems.filter(i => ideas.ideaStatus(i) !== 'done').length);
  ipcMain.handle('ideas:patch', (e, { id, patch } = {}) => {
    const it = ideaItems.find(i => i.id === id);
    if (!it) return { ok: false, error: '点子不存在' };
    const p = patch || {};
    if (p.text !== undefined) { if(!String(p.text).trim()) return {ok:false,error:'点子不能为空'}; it.text=String(p.text).trim(); }
    if (p.status && ideas.STATUSES[p.status]) ideas.setStatus(it, p.status);
    if (p.next_action != null) it.next_action = String(p.next_action).slice(0, 400);
    if (p.note != null) it.note = String(p.note).slice(0, 1000);
    if (p.this_week != null) it.this_week = !!p.this_week;
    if (p.result_note != null) it.result_note = String(p.result_note).slice(0, 1000);
    if (p.result_url != null) it.result_url = String(p.result_url).slice(0, 500);
    if (p.remind_at !== undefined) {
      if(p.remind_at && !Number.isFinite(Number(p.remind_at))) return {ok:false,error:'提醒日期无效'};
      it.remind_at = p.remind_at ? Number(p.remind_at) : null;
      it.reminder_mode = p.remind_at ? 'explicit' : 'weekly';
    }
    if (Array.isArray(p.related_item_ids)) it.related_item_ids = p.related_item_ids.map(String).slice(0, 20);
    it.lastTouchedAt = Date.now();
    if(it.status==='done' && it.status_history?.length) {const h=it.status_history[it.status_history.length-1]; h.result_note=it.result_note;h.result_url=it.result_url;}
    for(const ex of extractStore?.items||[])if(ex.idea_id===it.id){ex.title=it.text;ex.body=it.note;ex.updated_at=Date.now();}
    if(extractStore)extractStore.save();
    saveIdeas();
    idxCache = null;
    pushIdeaCount();
    return { ok: true, idea: enrichIdea(it) };
  });
  ipcMain.handle('ideas:thisWeek', () => ideas.thisWeekIdeas(ideaItems).map(enrichIdea));
  ipcMain.on('ideas:open', (e, id) => { createIdeaWin(); if(id) {const send=()=>ideaWin.webContents.send('ideas:focus',id); if(ideaWin.webContents.isLoading())ideaWin.webContents.once('did-finish-load',send); else send();} });
  ipcMain.handle('library:show', (e, { id, messageIds } = {}) => {
    return showLibraryItem(id, messageIds);
  });
  ipcMain.on('ideas:close', () => { if (ideaWin && !ideaWin.isDestroyed()) ideaWin.hide(); });
  // 手动成卡 / 移除一条条目的全部卡
  ipcMain.handle('srs:add', (e, { itemId, kind, front, back } = {}) => {
    const f = String(front || '').trim();
    if (!f) return { ok: false, error: '问题不能为空' };
    const card = addSrsCard({ itemId, kind: kind || 'manual', front: f, back: String(back || '').trim(), generatedBy: 'manual' });
    return card ? { ok: true, card } : { ok: false, error: '已有同款卡片（同一条目同类型只留一张）' };
  });
  // AI 问答草稿预取（详情页「加入复习」弹窗预填用；无 AI/失败返回模板，绝不报错打断）
  ipcMain.handle('srs:aiDraft', async (e, { itemId } = {}) => {
    const it = store.get(String(itemId || ''));
    if (!it) return { ok: false, error: '条目不存在' };
    const fallback = {
      q: (it.title || '这条资料的核心是什么？').slice(0, 200),
      a: (it.summary || it.notes || (it.text || '').slice(0, 400) || '').slice(0, 800),
    };
    const qa = await aiCardQA(it);
    return qa ? { ok: true, q: qa.q, a: qa.a, source: 'ai' } : { ok: true, q: fallback.q, a: fallback.a, source: 'template' };
  });
  ipcMain.handle('srs:remove', (e, { itemId } = {}) => { removeSrsCardsFor(itemId); return { ok: true }; });
  // 记忆统计（复习窗结算页/复盘段落用）
  ipcMain.handle('srs:stats', () => {
    const since = Date.now() - 30 * 86400000;
    const reviews = store.events.filter(ev => ev && ev.type === 'srs_review' && ev.t >= since);
    const ms = srs.memoryStats(reviews);
    return {
      ...ms,
      cards: srsCards.length,
      due: srs.dueCards(srsCards, Date.now(), 9999).length,
      dusty: srs.dustyItems(store.allItems()).length,
    };
  });
  // ---------- 资料级回看（resurface）IPC ----------
  // 今日「该回看了」名单：按 reason 优先级排序，排除今日 SRS 已含条目 / 已贪睡条目
  ipcMain.handle('resurface:today', () => resurfaceList());
  // 贪睡：N 天后再说（字段写在条目上，旧数据缺字段=不贪睡）
  ipcMain.handle('resurface:snooze', (e, { itemId, days } = {}) => {
    const it = store.get(String(itemId || ''));
    if (!it) return { ok: false, error: '条目不存在' };
    const d = Math.max(1, parseInt(days, 10) || 7);
    store.update(it.id, { resurface_snoozed_until: Date.now() + d * 86400000 });
    return { ok: true };
  });
  // 不再提醒：记 lastResurfacedAt（本轮不再进入名单）
  ipcMain.handle('resurface:dismiss', (e, { itemId } = {}) => {
    const it = store.get(String(itemId || ''));
    if (!it) return { ok: false, error: '条目不存在' };
    store.update(it.id, { lastResurfacedAt: Date.now() });
    return { ok: true };
  });
  ipcMain.handle('library:update', (e, { id, patch }) => {
    if(patch?.category && patch.category_locked===undefined)patch.category_locked=true;
    const old=store.get(id);if(old?.current_version_id && patch?.notes!==undefined && patch.notes!==old.notes){usage.addVersion(old,{content:patch.notes,reason:'手动编辑',makeCurrent:true});}
    const it = store.update(id, patch);
    // 星标成卡/摘星移卡：★ 是用户盖的「重要」章，天然值得复习（幂等）
    try {
      if (it && patch && patch.favorite === true) {
        addSrsCardWithAI(it, 'star', (it.title || '这条资料讲了什么？').slice(0, 200), (it.summary || (it.text || '').slice(0, 400) || it.notes || it.title || '').slice(0, 800));
      } else if (it && patch && patch.favorite === false) {
        srsCards = srsCards.filter(c => !(c.itemId === id && c.kind === 'star'));
        saveSrsCards();
      }
    } catch {}
    return it;
  });
  ipcMain.handle('library:remove', (e, id) => store.remove(id));
  ipcMain.handle('library:ingest', (e, payload) => ingestAndNotify(payload, mainWin));
  ipcMain.handle('library:reclassify', async (e, id) => {
    const it = store.get(id);
    if (!it) return null;
    if (it.category_locked) return { ...it, _locked: true };
    await classifyAndFinalize(it);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', { id });
    return store.get(id);
  });
  // 重新提取附件：给已收录的文档条目补齐图片/链接，并刷新正文
  // （正文重抽后自带「[图N: 文件名]」行内占位，渲染层据此把图片穿插回文章原位；
  //   v0.5.2 之前入库的旧条目点一次即完成全部升级）
  ipcMain.handle('library:reextract', async (e, id) => {
    const it = store.get(id);
    if (!it) return { ok: false, error: '条目不存在' };
    const paths = (it.files || []).map(f => f.path).filter(p => p && fs.existsSync(p));
    if (!paths.length) return { ok: false, error: '该条目没有可提取的归档文件' };
    const outDir = path.join(FILES_DIR(), 'extract', String(Date.now()));
    const results = await extractManyViaPool(paths, outDir);
    const images = [];
    const links = [...(it.links || [])];
    let text = it.text || '';
    if (results.length === 1) {
      text = results[0].text || text;
    } else if (results.length > 1) {
      text = results.map(r => `\n\n## ${path.basename(r.path)}\n` + (r.text || '').slice(0, 20000)).join('').slice(0, 120000);
    }
    for (const r of results) {
      for (const im of (r.images || [])) if (!images.some(x => x.file === im.file)) images.push({ ...im, from: path.basename(r.path) });
      for (const lk of (r.links || [])) if (!links.some(x => x.url === lk.url)) links.push(lk);
    }
    store.update(id, { images, links, text });
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', { id });
    return { ok: true, images: images.length, links: links.length, added: images.length - (it.images || []).length };
  });
  // 剪贴板是否持有图片（只探测不落盘——打开收录窗时智能预选用；真正收录才走 saveClipboardImage）
  ipcMain.handle('app:hasClipboardImage', () => {
    try { return !require('electron').clipboard.readImage().isEmpty(); } catch { return false; }
  });
  // 剪贴板截图/复制的图片 → 存盘并返回路径（快速收录窗 ⌘V 直接收图）
  ipcMain.handle('app:saveClipboardImage', () => {
    try {
      const img = require('electron').clipboard.readImage();
      if (img.isEmpty()) return null;
      const root = path.resolve(FILES_DIR(), 'inbox');
      fs.mkdirSync(root, { recursive: true });
      const file = path.resolve(root, 'clip-' + Date.now() + '.png');
      if (!file.startsWith(root + path.sep)) return null; // 落盘路径边界校验
      fs.writeFileSync(file, img.toPNG());
      const sz = img.getSize();
      return { file, width: sz.width, height: sz.height, size: fs.statSync(file).size };
    } catch { return null; }
  });
  ipcMain.handle('library:dayItems', (e, dateStr) => store.itemsOfDay(dateStr));
  ipcMain.handle('library:rangeItems', (e, { from, to }) => store.itemsOfRange(from, to));
  ipcMain.handle('library:addEvent', (e, ev) => store.addEvent(ev));
  // 相似条目点击反馈回流：记录事件，供 quotes:related 的 similar 排序加权
  ipcMain.handle('library:feedbackSimilar', (e, { itemId, similarId } = {}) => {
    if (!similarId) return { ok: false, error: '缺少 similarId' };
    store.addEvent({ type: 'similar_click', itemId: itemId || null, similarId });
    return { ok: true };
  });
  // 点击回流统计：近 30 天 similar_click 事件按目标聚合（点击越多 = 回流价值越高）
  ipcMain.handle('library:feedbackStats', () => {
    const since = Date.now() - 30 * 86400000;
    const clicks = new Map();
    let total = 0;
    for (const ev of store.events) {
      if (!ev || ev.type !== 'similar_click' || !ev.similarId) continue;
      if (typeof ev.t !== 'number' || ev.t < since) continue;
      clicks.set(ev.similarId, (clicks.get(ev.similarId) || 0) + 1);
      total += 1;
    }
    const byTarget = [...clicks.entries()]
      .map(([id, c]) => {
        const it = store.get(id);
        return { id, title: it ? it.title : '（已删除）', clicks: c };
      })
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 10);
    return { total, byTarget };
  });
  // 批量整理积压：低置信「资料收藏/未分类」条目走本地引擎重新归类（dryRun 只预览不落库）
  // 落库前快照 from → config.lastOrganizeBatch，供 library:undoOrganize 24 小时内回滚
  ipcMain.handle('library:autoOrganize', (e, { dryRun } = {}) => {
    const candidates = store.allItems().filter(i =>
      !i.category_locked &&
      (i.category === '资料收藏' || i.category === '未分类') &&
      (i.classification_confidence == null || i.classification_confidence <= 0.4));
    const details = [];
    const moves = []; // 回滚快照：from 必须在 store.update 之前记录
    for (const it of candidates) {
      let d = null;
      try { d = decide({ profile: catProfile, rules: catRules, text: it.text, notes: it.notes, title: it.title, kind: it.kind }); } catch {}
      if (!d || !d.category || d.category === it.category || d.source === 'fallback') continue;
      details.push({ id: it.id, title: it.title, from: it.category, to: d.category, confidence: d.confidence });
      if (!dryRun) {
        moves.push({ id: it.id, from: it.category, title: it.title });
        store.update(it.id, { category: d.category, classification_confidence: d.confidence });
        if (catProfile) catProfile.learn(d.category, (it.title || '') + '\n' + (it.notes || '') + '\n' + (it.text || '').slice(0, 8000));
      }
    }
    if (!dryRun && moves.length) {
      const c = loadConfig();
      c.lastOrganizeBatch = { t: Date.now(), moves };
      saveConfig(c);
    }
    if (!dryRun && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
    const res = { scanned: candidates.length, moved: details.length, details };
    if (!dryRun && details.length) res.undoable = true;
    return res;
  });
  // 回滚上次积压整理批次：逐条恢复原分类，完成后清掉批次（不存在/超 24 小时拒绝）
  ipcMain.handle('library:undoOrganize', () => {
    const batch = loadConfig().lastOrganizeBatch;
    if (!batch || !Array.isArray(batch.moves) || !batch.moves.length) {
      return { ok: false, error: '没有可回滚的整理批次' };
    }
    if (Date.now() - (batch.t || 0) > 24 * 3600000) {
      return { ok: false, error: '整理批次已超过 24 小时，无法回滚' };
    }
    let restored = 0;
    for (const m of batch.moves) {
      if (m && m.id && m.from && store.get(m.id) && store.update(m.id, { category: m.from })) restored += 1;
    }
    const c2 = loadConfig();
    delete c2.lastOrganizeBatch;
    saveConfig(c2);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
    return { ok: true, restored, batch };
  });
  // 批量打补丁（改分类/标签等），返回成功条数
  ipcMain.handle('library:bulkUpdate', (e, { ids, patch } = {}) => {
    const list = Array.isArray(ids) ? ids : [];
    const p = { ...(patch || {}) };
    if (p.category && p.category_locked == null) p.category_locked = true;
    let count = 0;
    for (const id of list) if (store.update(id, p)) count += 1;
    return { ok: true, count };
  });

  ipcMain.handle('capture:detect', (e, p) => detectCapture(p || {}));
  // 单条收录核心管线：capture:save 与批量导入 import:commit 共用同一条路径，
  // 保证批量导入每一条都走与手动保存完全一致的检测/归类/归档逻辑
  async function captureSaveCore(payload, win) {
    const p = payload || {};
    const det = detectCapture(p);
    const kind = p.kind || det.kind;
    try {
      const missing=(p.filePaths||[]).filter(f=>!fs.existsSync(f));
      if(missing.length)return {ok:false,error:'附件找不到，请补齐或移除：'+missing.map(f=>path.basename(f)).join('、')};
      if ((kind==='note'||kind==='idea') && !String(p.text||p.notes||'').trim())return {ok:false,error:'内容不能为空'};
      if (kind === 'idea') {
        const r = await (async () => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const t = String(p.text || p.notes || '').replace(/\s+/g, ' ').trim();
          if (!t) return { ok: false, error: '点子是空的' };
          const dup = ideaItems.find(i => ideas.ideaStatus(i) !== 'done' && ideas.ideaStatus(i) !== 'parked' && norm(i.text) === norm(t));
          if (dup) return { ok: true, idea: enrichIdea(dup), deduped: true, kind: 'idea' };
          const rec = ideas.migrateIdea({
            id: require('./src/db').uid(), text: t.slice(0, 500),
            note: String(p.note || '').slice(0, 1000), created_at: Date.now(),
            source_item_id: p.source_item_id || null, status: 'clarify', reminder_mode: 'weekly',
          });
          ideaItems.push(rec); saveIdeas(); idxCache = null; pushIdeaCount();
          return { ok: true, idea: enrichIdea(rec), kind: 'idea' };
        })();
        if (r.ok && p.draftSlot && draftStore) draftStore.clear(p.draftSlot);
        return r;
      }
      if (kind === 'chat' && p.appendToId) {
        const r = await appendChatToItem(p.appendToId, p);
        if (r.ok && p.draftSlot && draftStore) draftStore.clear(p.draftSlot);
        return r;
      }
      const ingestPayload = { ...p, kind: kind === 'url' ? 'url' : kind };
      if (kind === 'url') {
        ingestPayload.url = ingestPayload.url || firstUrl(p.text || p.notes) || p.url;
        if (!/^https?:\/\//i.test(String(ingestPayload.url || ''))) {
          return { ok: false, error: '请输入有效链接' };
        }
      }
      if (kind === 'file' && !(Array.isArray(p.filePaths) && p.filePaths.length)) {
        return { ok: false, error: '请先添加文件' };
      }
      if (kind === 'note' || kind === 'chat') ingestPayload.notes = p.notes || p.text || '';
      if (kind === 'chat') ingestPayload.rawText = p.rawText || p.notes || p.text || '';
      const rec = await ingestAndNotify(ingestPayload, win);
      if (p.draftSlot && draftStore) draftStore.clear(p.draftSlot);
      return { ok: true, id: rec.id, title: rec.title, category: rec.category, kind: rec.kind, ids: rec._ids || [rec.id] };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }
  ipcMain.handle('capture:save', (e, payload) => captureSaveCore(payload, BrowserWindow.fromWebContents(e.sender)));

  // ---------- 批量导入（合同接口 vault.importPreview/Commit/Status/Retry） ----------
  // 计划（planImport）来自 A 的纯模块 src/import-plan；主进程负责：payload 路径来源校验
  // （只接受用户显式选取/拖入的绝对路径，逐一核实存在且为普通文件）、计划缓存与新鲜度
  // （源文件变更/过期必须重预览，绝不静默丢内容）、批次状态落盘（DATA_DIR/import-batches）、
  // 幂等提交（同 sourceKey 已成功不重导）与失败单项重试。提交复用 captureSaveCore 管线。
  const importPlanMod = (() => { try { return require('./src/import-plan'); } catch { return null; } })();
  const portableMod = (() => { try { return require('./src/portable-bundle'); } catch { return null; } })();
  const IMPORT_TEXT_MAX = 2_000_000;   // 预览文本上限（字符）：超限直接拒绝并提示拆分
  const IMPORT_FILES_MAX = 200;        // 单次导入文件数上限
  const IMPORT_PLAN_TTL_MS = 24 * 3600 * 1000; // 计划有效期：过期要求重预览
  const IMPORT_PLANS_DIR = () => path.join(DATA_DIR(), 'import-plans');
  const IMPORT_BATCHES_DIR = () => path.join(DATA_DIR(), 'import-batches');
  const importPlans = new Map();       // planId → 计划记录（懒加载磁盘）
  const importBatches = new Map();     // batchId → 批次记录（懒加载磁盘）
  const importBatchByPlan = new Map(); // planId → batchId（同计划幂等提交）

  function importModuleMissing() {
    return { ok: false, error: 'IMPORT_MODULE_MISSING', message: '导入计划模块尚未集成（等待 A 交付合并），本接口暂不可用' };
  }
  function loadImportPlans() {
    try {
      const dir = IMPORT_PLANS_DIR();
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const rec = readJson(path.join(dir, f), null);
          if (rec && rec.planId) importPlans.set(rec.planId, rec);
        } catch {}
      }
    } catch {}
  }
  function saveImportPlan(rec) {
    importPlans.set(rec.planId, rec);
    try {
      fs.mkdirSync(IMPORT_PLANS_DIR(), { recursive: true });
      writeJsonAtomic(path.join(IMPORT_PLANS_DIR(), rec.planId + '.json'), rec);
    } catch {}
  }
  function loadImportBatches() {
    try {
      const dir = IMPORT_BATCHES_DIR();
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const rec = readJson(path.join(dir, f), null);
          if (rec && rec.batchId) {
            importBatches.set(rec.batchId, rec);
            if (rec.planId) importBatchByPlan.set(rec.planId, rec.batchId);
          }
        } catch {}
      }
    } catch {}
  }
  function saveImportBatch(rec) {
    importBatches.set(rec.batchId, rec);
    if (rec.planId) importBatchByPlan.set(rec.planId, rec.batchId);
    try {
      fs.mkdirSync(IMPORT_BATCHES_DIR(), { recursive: true });
      writeJsonAtomic(path.join(IMPORT_BATCHES_DIR(), rec.batchId + '.json'), rec);
    } catch {}
  }
  // 路径来源校验：只接受用户显式选取/拖入的绝对路径；逐一存在、普通文件、可读
  function validateImportPayload(payload) {
    const p = payload || {};
    if (p.text !== undefined && p.text !== null && typeof p.text !== 'string') return 'text 必须是字符串';
    if (String(p.text || '').length > IMPORT_TEXT_MAX) return `文本超过 ${IMPORT_TEXT_MAX} 字符，请拆分后分批导入`;
    const files = Array.isArray(p.files) ? p.files : [];
    if (files.length > IMPORT_FILES_MAX) return `单次最多 ${IMPORT_FILES_MAX} 个文件，请分批导入`;
    for (const f of files) {
      if (typeof f !== 'string' || !f.trim()) return 'files 只能是路径字符串';
      if (!path.isAbsolute(f)) return `只接受绝对路径：${String(f).slice(0, 80)}`;
      let st = null;
      try { st = fs.statSync(f); } catch { return `文件不存在或不可读：${path.basename(f)}`; }
      if (!st.isFile()) return `不是普通文件（目录/链接不接受）：${path.basename(f)}`;
    }
    return null;
  }
  // 计划来源快照：提交前重 stat，任何变化都要求重预览
  function snapshotSources(files) {
    const out = [];
    for (const f of (Array.isArray(files) ? files : [])) {
      try { const st = fs.statSync(f); out.push({ path: f, size: st.size, mtimeMs: st.mtimeMs }); } catch {}
    }
    return out;
  }
  function sourcesChanged(snap) {
    const changed = [];
    for (const s of snap || []) {
      try {
        const st = fs.statSync(s.path);
        if (st.size !== s.size || st.mtimeMs !== s.mtimeMs) changed.push(path.basename(s.path));
      } catch { changed.push(path.basename(s.path) + '（已消失）'); }
    }
    return changed;
  }
  // ---------- decisions 规范化（B 契约：对象 {sourceKey:'keep'|'skip'}；也接受数组 [{sourceKey, action}]） ----------
  // 未知键/未知值一律显式报错，绝不静默忽略——「跳过项绝不入库」必须可被 UI 依赖
  function normalizeDecisions(decisions) {
    if (decisions == null) return { map: new Map() };
    const bad = (m) => ({ map: null, error: m });
    if (Array.isArray(decisions)) {
      const map = new Map();
      for (const d of decisions) {
        if (!d || typeof d !== 'object' || Array.isArray(d)) return bad('decisions 数组元素必须是 {sourceKey, action} 对象');
        if (typeof d.sourceKey !== 'string' || !d.sourceKey) return bad('decisions 元素缺少有效 sourceKey');
        const act = d.action === undefined ? 'keep' : d.action;
        if (act !== 'keep' && act !== 'skip') return bad(`未知的 decisions.action：${String(d.action)}（只接受 keep|skip）`);
        const extra = Object.keys(d).filter(k => k !== 'sourceKey' && k !== 'action');
        if (extra.length) return bad('decisions 元素含未知字段：' + extra.join('、'));
        map.set(d.sourceKey, act);
      }
      return { map };
    }
    if (typeof decisions === 'object') {
      const map = new Map();
      for (const [k, v] of Object.entries(decisions)) {
        if (v !== 'keep' && v !== 'skip') return bad(`未知的 decisions 值：${k}=${String(v)}（只接受 keep|skip）`);
        map.set(k, v);
      }
      return { map };
    }
    return bad('decisions 必须是 {sourceKey: keep|skip} 对象或 [{sourceKey, action}] 数组');
  }

  function batchSummary(rec) {
    const items = rec.items || {};
    const succeeded = [], failed = [], skipped = [], itemIds = [], issues = [];
    for (const [sourceKey, it] of Object.entries(items)) {
      if (it.status === 'succeeded') { succeeded.push({ sourceKey, itemId: it.itemId || null }); if (it.itemId) itemIds.push(it.itemId); }
      else if (it.status === 'failed') {
        failed.push({ sourceKey, message: it.error || '保存失败' });
        issues.push({ sourceKey, code: it.code || null, message: it.error || '未知错误', attempts: it.attempts || 0 });
      } else skipped.push({ sourceKey });
    }
    // completed：批次再无待处理失败项（B 重启恢复时探测，清理残留失败提示）
    return { batchId: rec.batchId, planId: rec.planId, succeeded, failed, skipped, itemIds, issues, failedCount: failed.length, completed: failed.length === 0, done: failed.length === 0 };
  }

  // 单条目提交：commit 阶段用 readSourceForCommit 完整重读（大小/mtime/前缀三重新鲜度），
  // 用户编辑消息卡优先（绝不重新解析原文覆盖编辑），chat/note 各走既有管线并归档原文件。
  async function commitEntry(rec, plan, entry, firstChatSourceKey) {
    const key = entry.sourceKey;
    const attempts = ((rec.items[key] && rec.items[key].attempts) || 0) + 1;
    const fail = (message, code) => { rec.items[key] = { status: 'failed', error: message, code: code || null, attempts }; };
    try {
      // 1) 完整重读：stale=要求重预览；stillTruncated=超提交上限 → 该条明确失败（绝不把前缀当全文报成功）
      let rawText = entry.rawText || '';
      if (entry.source && entry.source.type === 'file') {
        const r = importPlanMod.readSourceForCommit(entry, {});
        if (!r || r.ok === false) return fail(r && r.reason === 'missing' ? '源文件已删除或不可读，请重新预览' : `源文件读取失败（${(r && r.reason) || '未知原因'}），请重新预览`, 'SOURCE_READ_FAILED');
        if (r.stale) return fail(`源文件在预览后有变化（${(r.staleReasons || []).join('/')}），请重新预览`, 'SOURCE_CHANGED');
        if (!r.complete) return fail(`文件共 ${r.sizeOnDisk} 字节，超过提交上限（20MB），本次只读到前 ${r.readBytes} 字节；为避免把前缀当全文入库，本条未保存，请拆分后重试`, 'COMMIT_TOO_LARGE');
        rawText = r.text || rawText; // complete=true：全文（含预检阶段被截断的尾部）
      }
      // 2) 用户编辑消息卡优先：只作用于本次预检的第一条 chat entry（B 的消息卡属于同一段聊天）。
      //    note entry 追加到聊天时不带 messages，交给 appendChatToItem 用 rawText 自行解析
      const edited = Array.isArray(plan.payload && plan.payload.messages) && plan.payload.messages.length ? plan.payload.messages : null;
      const useMessages = entry.kind === 'chat' ? (edited && key === firstChatSourceKey ? edited : (entry.messages || [])) : null;
      // 3) 原文件归档：chat 经 filePaths 由管线归档；note 在插入后补归档
      const srcPath = entry.source && entry.source.type === 'file' ? entry.source.path : null;
      const srcFilePaths = srcPath && entry.kind === 'chat' ? [srcPath] : [];
      if (entry.targetItemId) {
        // 追加到已有聊天：内部重新 planAppend（预检 counts 仅供参考），稳定消息 ID 幂等
        const r = await appendChatToItem(entry.targetItemId, {
          messages: useMessages, rawText, notes: rawText,
          chatTitle: entry.title || undefined,
          filePaths: srcFilePaths, dropPossible: false,
        });
        if (!r || r.ok === false) return fail((r && r.error) || '追加失败', 'APPEND_FAILED');
        rec.items[key] = { status: 'succeeded', itemId: entry.targetItemId, attempts, appended: true };
        return true;
      }
      const rec2 = await pipelineIngest({
        kind: entry.kind === 'note' ? 'note' : 'chat',
        rawText, notes: rawText,
        messages: useMessages,
        chatTitle: entry.title || undefined,
        chatSource: String(plan.payload.source || 'import').slice(0, 80),
        filePaths: srcFilePaths,
      });
      if (!rec2 || rec2.status === 'error') return fail((rec2 && rec2.text) || '入库失败', 'INGEST_FAILED');
      if (srcPath && entry.kind === 'note' && fs.existsSync(srcPath)) {
        try { const f = archiveFile(srcPath); store.update(rec2.id, { files: [...(rec2.files || []), f] }); } catch { /* 归档失败不阻断导入，正文已完整入库 */ }
      }
      rec.items[key] = { status: 'succeeded', itemId: rec2.id || (rec2._ids && rec2._ids[0]) || null, attempts, title: rec2.title || null };
      return true;
    } catch (err) {
      rec.items[key] = { status: 'failed', error: String(err && err.message ? err.message : err), code: 'EXCEPTION', attempts };
      return true;
    }
  }
  // 选中条目的源新鲜度预检：任一源变化/丢失 → 阻止整批提交（要求重预览，不静默丢内容）
  function selectedStale(entries) {
    const out = [];
    for (const en of entries) {
      if (!en.source || en.source.type !== 'file') continue;
      const r = importPlanMod.readSourceForCommit(en, {});
      if (!r.ok && r.reason === 'missing') out.push({ sourceKey: en.sourceKey, staleReasons: ['missing'], name: path.basename(en.source.path || '') });
      else if (r && r.ok && r.stale) out.push({ sourceKey: en.sourceKey, staleReasons: r.staleReasons || [], name: path.basename(en.source.path || '') });
    }
    return out;
  }
  // A entry → B 渲染层视图条目适配（仅在 import:preview 响应中生效；落盘计划保持 A 原始 schema）。
  // B normEntry 读 raw/kind('message'|'file'|'note')/issues[].type+index；A 给 rawText/kind('chat'|'note')/
  // issues{level,code,message}。这里做字段与语义映射：消息级定位索引取该类问题的第一条消息；
  // 文件来源（有 fileName）映射为 B 的 'file'，预览带文件名，多文件可各自辨认。
  function toUiEntry(en) {
    const msgs = Array.isArray(en.messages) ? en.messages : [];
    const firstIdx = (pred) => { const i = msgs.findIndex(pred); return i >= 0 ? i : null; };
    const typeOf = (iss) => {
      switch (iss.code) {
        case 'NO_SPEAKER': return 'missing-speaker';
        case 'NO_TIME': return 'missing-time';
        case 'PENDING_ATTACHMENTS': return 'pending-attachment';
        case 'FULL_DUPLICATE_OF_EXISTING':
        case 'SOURCE_KEY_SEEN': return 'possible-duplicate';
        case 'FORMAT_UNRECOGNIZED': return 'unparsed';
        case 'TRUNCATED_FILE': return 'format';
        case 'FILE_NOT_FOUND': return 'missing-file';
        default: return null; // 交给 B 的 guessIssueType 按中文信息分类
      }
    };
    const indexFor = (code) => {
      switch (code) {
        case 'NO_SPEAKER': return firstIdx((m) => m && m.speakerUnknown);
        case 'NO_TIME': return firstIdx((m) => m && m.timeUnknown);
        case 'PENDING_ATTACHMENTS': return firstIdx((m) => m && m.attachment && (m.attachment.pending || !m.attachment.path));
        default: return null;
      }
    };
    const fileName = en.fileName || (en.source && en.source.type === 'file' && en.source.path ? path.basename(en.source.path) : null);
    const rawText = en.rawText != null ? en.rawText : '';
    const raw = fileName
      ? `${fileName} · ${String(rawText).trim().split('\n')[0].slice(0, 60)}` // 文件名 + 首行内容，多文件各自可辨认
      : rawText;
    return {
      ...en,
      raw,
      kind: fileName ? 'file' : (en.kind === 'chat' ? 'message' : 'note'), // B kindLabel：文件 / 消息 / 内容
      issues: (en.issues || []).map((iss) => ({ ...iss, type: typeOf(iss) || undefined, index: indexFor(iss.code) })),
    };
  }
  ipcMain.handle('import:preview', async (e, payload) => {
    if (!importPlanMod || typeof importPlanMod.planImport !== 'function') return importModuleMissing();
    const invalid = validateImportPayload(payload);
    if (invalid) return { ok: false, error: 'INVALID_PAYLOAD', message: invalid };
    try {
      const p = payload || {};
      const plan = importPlanMod.planImport(
        { text: p.text != null ? String(p.text) : '', files: Array.isArray(p.files) ? p.files : [], kind: p.kind, targetItemId: p.targetItemId, source: p.source },
        store.allItems().filter(i => !i.trashed),
        {},
      );
      if (!plan || !Array.isArray(plan.entries)) return { ok: false, error: 'PLAN_INVALID', message: '计划模块返回了不可用的结果' };
      const planId = require('./src/db').uid();
      const rec = {
        planId, createdAt: Date.now(),
        payload: {
          text: p.text != null ? String(p.text) : '',
          files: Array.isArray(p.files) ? p.files : [],
          kind: p.kind || null, source: p.source || null,
          messages: Array.isArray(p.messages) ? p.messages : null, // B 的用户编辑消息卡：commit 时优先使用，绝不重新解析覆盖
        },
        entries: plan.entries, summary: plan.summary || {}, warnings: plan.warnings || [],
        sources: snapshotSources(p.files),
        attachmentSources: await require('./src/import-attachments').snapshot(
          (Array.isArray(p.files) ? p.files : []).filter(file => !plan.entries.some(en => en.source && en.source.path === file)),
        ),
      };
      saveImportPlan(rec);
      return { ok: true, planId, entries: plan.entries.map(toUiEntry), summary: plan.summary || {}, warnings: plan.warnings || [] };
    } catch (err) {
      return { ok: false, error: 'PLAN_FAILED', message: String(err && err.message ? err.message : err) };
    }
  });
  // 跨批次幂等索引：sourceKey → 首个已成功记录。任何历史批次已导入的来源，在新计划中
  // 提交时自动标 skipped（防止重建计划后重复导入已成功条目；批次内幂等由 rec.items 承担）。
  function succeededSourceKeyIndex(excludeBatchId) {
    if (!importBatches.size) loadImportBatches();
    const idx = new Map();
    for (const rec of importBatches.values()) {
      if (excludeBatchId && rec.batchId === excludeBatchId) continue;
      for (const [key, it] of Object.entries(rec.items || {})) {
        if (it && it.status === 'succeeded' && !idx.has(key)) idx.set(key, { batchId: rec.batchId, itemId: it.itemId || null });
      }
    }
    return idx;
  }
  function markAlreadyImported(rec, entries, doneIdx) {
    for (const en of entries) {
      const prev = doneIdx.get(en.sourceKey);
      const cur = rec.items[en.sourceKey];
      if (prev && !(cur && cur.status === 'succeeded')) {
        rec.items[en.sourceKey] = { status: 'skipped', attempts: (cur && cur.attempts) || 0, alreadyImported: prev };
      }
    }
  }
  // 二进制附件没有文本 entry；提交与失败重试必须共享同一补偿路径。
  async function commitUnplannedAttachments(rec, plan, retryOnly = false) {
    const plannedPaths = new Set(plan.entries.map(en => en.source && en.source.path).filter(Boolean));
    const unplanned = (Array.isArray(plan.payload.files) ? plan.payload.files : []).filter(f => !plannedPaths.has(f));
    if (!unplanned.length) return;
    const legacyKey = 'src-attach-' + require('crypto').createHash('sha256').update([...unplanned].sort().join('\x1f')).digest('hex');
    const attachments = require('./src/import-attachments');
    const sources = plan.attachmentSources;
    // Already-completed old batches remain idempotent. Unfinished old plans need a fresh preview.
    if (!Array.isArray(sources) && rec.items[legacyKey] && rec.items[legacyKey].status === 'succeeded') return;
    const attachKey = Array.isArray(sources) ? attachments.sourceKey(sources) : legacyKey;
    const cur = rec.items[attachKey];
    if (cur && (cur.status === 'succeeded' || (cur.status === 'skipped' && cur.alreadyImported))) return;
    if (retryOnly && (!cur || cur.status !== 'failed')) return;
    const attempts = ((cur && cur.attempts) || 0) + 1;
    try {
      const missing = unplanned.filter(f => !fs.existsSync(f));
      if (missing.length) {
        rec.items[attachKey] = { status: 'failed', error: '附件文件已不存在：' + missing.map(f => path.basename(f)).join('、'), code: 'ATTACH_MISSING', attempts };
      } else {
        if (!Array.isArray(sources) || sources.length !== new Set(unplanned).size) {
          rec.items[attachKey] = { status: 'failed', error: '附件计划来自旧版本，请重新预检后保存', code: 'PLAN_REPREVIEW_REQUIRED', attempts };
          saveImportBatch(rec);
          return;
        }
        const stale = await attachments.changed(sources);
        if (stale.length) {
          rec.items[attachKey] = { status: 'failed', error: '附件内容已变化，请重新预检：' + stale.map(f => path.basename(f)).join('、'), code: 'SOURCE_CHANGED', attempts };
          saveImportBatch(rec);
          return;
        }
        const previous = succeededSourceKeyIndex(rec.batchId).get(attachKey);
        if (previous) {
          rec.items[attachKey] = { status: 'skipped', attempts: (cur && cur.attempts) || 0, alreadyImported: previous };
          saveImportBatch(rec);
          return;
        }
        const result = await pipelineIngest({ kind: 'file', filePaths: unplanned, notes: plan.payload.text || '' });
        if (!result || result.status === 'error') throw new Error((result && result.text) || '附件归档失败');
        rec.items[attachKey] = { status: 'succeeded', itemId: result.id || (result._ids && result._ids[0]) || null, attempts, attachmentBundle: true };
      }
    } catch (err) {
      rec.items[attachKey] = { status: 'failed', error: String(err && err.message ? err.message : err), code: 'ATTACH_FAILED', attempts };
    }
    saveImportBatch(rec);
  }
  ipcMain.handle('import:commit', async (e, { planId, decisions } = {}) => {
    if (!importPlanMod || typeof importPlanMod.planImport !== 'function') return importModuleMissing();
    if (!importPlans.size) loadImportPlans();
    if (!importBatches.size) loadImportBatches();
    const plan = importPlans.get(planId);
    if (!plan) return { ok: false, error: 'PLAN_NOT_FOUND', message: '找不到导入计划，请重新预览' };
    if (Date.now() - plan.createdAt > IMPORT_PLAN_TTL_MS) return { ok: false, error: 'PLAN_EXPIRED', message: '计划已超过 24 小时，请重新预览' };
    const dec = normalizeDecisions(decisions);
    if (dec.error) return { ok: false, error: 'DECISIONS_INVALID', message: dec.error };
    const entryKeys = new Set(plan.entries.map(en => en.sourceKey));
    const unknown = [...dec.map.keys()].filter(k => !entryKeys.has(k));
    if (unknown.length) return { ok: false, error: 'DECISIONS_UNKNOWN_KEY', message: '以下 sourceKey 不在当前计划中，请重新预览：' + unknown.slice(0, 5).join('、'), unknown };
    // 幂等：同计划已有批次则复用（已成功条目不重复导入；批次落盘，重启后同样生效）
    let rec = importBatchByPlan.get(planId) && importBatches.get(importBatchByPlan.get(planId));
    if (!rec) rec = { batchId: require('./src/db').uid(), planId, createdAt: Date.now(), items: {} };
    const selected = plan.entries.filter(en => dec.map.get(en.sourceKey) !== 'skip');
    // skip 条目显式落盘状态（B 依赖 skipped 计数；重启后语义不丢）
    for (const en of plan.entries) {
      if (dec.map.get(en.sourceKey) === 'skip' && !(rec.items[en.sourceKey] && rec.items[en.sourceKey].status === 'succeeded')) {
        rec.items[en.sourceKey] = { status: 'skipped', attempts: (rec.items[en.sourceKey] && rec.items[en.sourceKey].attempts) || 0 };
      }
    }
    const staleInfos = selectedStale(selected);
    if (staleInfos.length) {
      saveImportBatch(rec);
      return { ok: false, error: 'SOURCE_CHANGED', message: '源文件在预览后有变化，请重新预览（不静默丢内容）', changed: staleInfos, ...batchSummary(rec) };
    }
    const firstChat = plan.entries.find(en => en.kind === 'chat');
    // 跨批次幂等：历史批次已成功的来源自动跳过（新计划/重建面板防重复导入）
    markAlreadyImported(rec, selected, succeededSourceKeyIndex(rec.batchId));
    for (const en of selected) {
      const cur = rec.items[en.sourceKey];
      if (cur && cur.status === 'succeeded') continue; // 幂等：已成功不重导
      if (cur && cur.status === 'skipped' && cur.alreadyImported) continue; // 历史已导入
      await commitEntry(rec, plan, en, firstChat ? firstChat.sourceKey : null);
      saveImportBatch(rec); // 每条落盘：中断/重启后批次状态不丢
    }
    await commitUnplannedAttachments(rec, plan);
    saveImportBatch(rec);
    pushIdeaCount();
    if (mainWin && !mainWin.isDestroyed()) { try { mainWin.webContents.send('library:changed', {}); } catch {} }
    return { ok: true, ...batchSummary(rec) };
  });
  ipcMain.handle('import:status', (e, batchId) => {
    if (!importBatches.size) loadImportBatches();
    const rec = importBatches.get(batchId);
    if (!rec) return { ok: false, error: 'BATCH_NOT_FOUND' };
    return { ok: true, ...batchSummary(rec), createdAt: rec.createdAt, updatedAt: rec.updatedAt };
  });
  ipcMain.handle('import:retry', async (e, batchId) => {
    if (!importPlanMod || typeof importPlanMod.planImport !== 'function') return importModuleMissing();
    if (!importBatches.size) loadImportBatches();
    const rec = importBatches.get(batchId);
    if (!rec) return { ok: false, error: 'BATCH_NOT_FOUND' };
    const plan = importPlans.get(rec.planId) || (loadImportPlans(), importPlans.get(rec.planId));
    if (!plan) return { ok: false, error: 'PLAN_NOT_FOUND', message: '原计划已不存在，无法重试，请重新预览' };
    // 重试只处理失败项（succeeded/skipped 一律不再动——已入库条目绝不重复导入）
    const failedKeys = new Set(Object.entries(rec.items || {}).filter(([, it]) => it.status === 'failed').map(([k]) => k));
    if (!failedKeys.size) return { ok: true, ...batchSummary(rec) };
    const selected = plan.entries.filter(en => failedKeys.has(en.sourceKey));
    // 跨批次幂等兜底：失败项若已被其他批次成功导入，直接转 skipped
    markAlreadyImported(rec, selected, succeededSourceKeyIndex(rec.batchId));
    const staleInfos = selectedStale(selected.filter(en => !(rec.items[en.sourceKey] && rec.items[en.sourceKey].status === 'skipped' && rec.items[en.sourceKey].alreadyImported)));
    if (staleInfos.length) {
      saveImportBatch(rec);
      return { ok: false, error: 'SOURCE_CHANGED', message: '源文件有变化，请重新预览', changed: staleInfos, ...batchSummary(rec) };
    }
    const firstChat = plan.entries.find(en => en.kind === 'chat');
    for (const en of selected) {
      const cur = rec.items[en.sourceKey];
      if (cur && cur.status === 'skipped' && cur.alreadyImported) continue; // 其他批次已导入，不再重跑
      await commitEntry(rec, plan, en, firstChat ? firstChat.sourceKey : null);
      saveImportBatch(rec);
    }
    await commitUnplannedAttachments(rec, plan, true);
    saveImportBatch(rec);
    pushIdeaCount();
    if (mainWin && !mainWin.isDestroyed()) { try { mainWin.webContents.send('library:changed', {}); } catch {} }
    return { ok: true, ...batchSummary(rec) };
  });

  // ---------- 便携包（合同接口 vault.portableExport/Preview/Restore） ----------
  // A 的 exportPortableBundle/inspectPortableBundle/restorePortableBundle 承担打包/校验/恢复；
  // 主进程负责原生选择器、取消语义（{cancelled:true}，取消零写入）、C 的 UI 字段映射
  // （C 报告 §4：导出 records/attachmentsIncluded/missing/external/outputPath；
  //   预检 planId/adds/conflicts/attachmentsFound/attachmentsMissing/conflictSamples；
  //   恢复 restored/skipped/failed/attachmentsRestored）与恢复后内存态同步。
  const PE_NAME = (x) => (x && typeof x === 'object' ? path.basename(String(x.path || x.name || '')) : path.basename(String(x || '')));
  // 只读对比包内记录 vs 当前库（mergeBackup 同款身份判定），供预检「新增/冲突保留」摘要
  async function portableAddsAndConflicts(bundleDir, manifest) {
    const current = portableMod.readCurrentBundle(DATA_DIR());
    const identity = (key, x) => (key === 'events' ? JSON.stringify([x.id, x.t, x.type, x.cardId]) : String(x && x.id));
    let adds = 0, conflicts = 0;
    const conflictSamples = [];
    for (const r of (manifest.records || [])) {
      if (!Object.prototype.hasOwnProperty.call(BACKUP_LISTS, r.key)) continue;
      let rows = [];
      try { const v = JSON.parse(fs.readFileSync(path.join(bundleDir, r.path), 'utf8')); rows = Array.isArray(v) ? v : []; } catch { continue; }
      const cur = Array.isArray(current[r.key]) ? current[r.key] : [];
      const curIds = new Set(cur.map((x) => identity(r.key, x)));
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        if (curIds.has(identity(r.key, row))) {
          conflicts += 1;
          if (conflictSamples.length < 4 && r.key === 'items') conflictSamples.push(String(row.title || row.id || '').slice(0, 40));
        } else adds += 1;
      }
    }
    return { adds, conflicts, conflictSamples };
  }
  ipcMain.handle('portable:export', async (e, opts = {}) => {
    if (!portableMod || typeof portableMod.exportPortableBundle !== 'function') {
      return { ok: false, error: 'PORTABLE_MODULE_MISSING', message: '便携包模块尚未集成，本接口暂不可用' };
    }
    let includeExternalPaths;
    if (opts && opts.selectExternal === true) {
      const selected = await dialog.showOpenDialog({
        title: '选择要一起迁移的外部附件（仅复制明确选中的文件）',
        properties: ['openFile', 'multiSelections'],
      });
      if (selected.canceled || !selected.filePaths.length) return { cancelled: true };
      includeExternalPaths = [...new Set(selected.filePaths)];
    }
    const r = await dialog.showOpenDialog({ title: '选择便携包导出位置（将在所选位置创建文件夹包）', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { cancelled: true };
    // 在用户所选目录下创建独立子目录作为包目录（绝不把所选目录本身当包写入）
    const stamp = localDayKey() + '-' + new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    const bundleDir = path.join(r.filePaths[0], `学习资产库-便携包-${stamp}`);
    try {
      const res = await portableMod.exportPortableBundle({
        dataDir: DATA_DIR(), filesDir: FILES_DIR(), bundleDir,
        appVersion: app.getVersion(),
        includeExternalPaths,
      });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'EXPORT_FAILED', message: (res && res.error) || '导出失败' };
      return {
        ok: true,
        records: res.counts.records,
        attachmentsIncluded: res.counts.attachmentsArchived,
        missing: (res.missing || []).map(PE_NAME),
        external: (res.external || []).filter((x) => x && x.included === false).map(PE_NAME),
        externalIncluded: res.counts.externalIncluded || 0,
        outputPath: res.bundleDir,
        complete: !!res.complete, // 由 A 按实际缺失重算，绝不照抄源包标记
        bundleDir: res.bundleDir,
      };
    } catch (err) {
      return { ok: false, error: 'EXPORT_FAILED', message: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('portable:preview', async (e) => {
    if (!portableMod || typeof portableMod.inspectPortableBundle !== 'function') {
      return { ok: false, error: 'PORTABLE_MODULE_MISSING', message: '便携包模块尚未集成，本接口暂不可用' };
    }
    const r = await dialog.showOpenDialog({ title: '选择要恢复的便携包文件夹', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { cancelled: true };
    try {
      const srcDir = r.filePaths[0];
      const inspection = await portableMod.inspectPortableBundle(srcDir, { verifyHashes: true });
      if (!inspection || inspection.ok === false) {
        const msgs = ((inspection && inspection.errors) || []).map((x) => x && x.message).filter(Boolean);
        return { ok: false, error: 'BUNDLE_INVALID', message: msgs.length ? msgs.slice(0, 3).join('；') : '包不完整或不是本应用的便携包' };
      }
      // fingerprint 作 planId（A 适配约定）：同一包重复预检复用同一计划
      const planId = inspection.fingerprint || require('./src/db').uid();
      const { adds, conflicts, conflictSamples } = await portableAddsAndConflicts(srcDir, inspection.manifest);
      const rec = { planId, srcDir, createdAt: Date.now(), fingerprint: inspection.fingerprint, kind: 'portable' };
      try { fs.mkdirSync(IMPORT_PLANS_DIR(), { recursive: true }); writeJsonAtomic(path.join(IMPORT_PLANS_DIR(), planId + '.json'), rec); } catch {}
      importPlans.set(planId, rec);
      const counts = inspection.counts || {};
      return {
        ok: true, planId,
        adds, conflicts, conflictSamples,
        attachmentsFound: counts.attachmentsArchived || 0,
        attachmentsMissing: counts.missing || 0,
        records: counts.records || 0,
        complete: !!counts.complete,
      };
    } catch (err) {
      return { ok: false, error: 'PREVIEW_FAILED', message: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('portable:restore', async (e, { planId } = {}) => {
    if (!portableMod || typeof portableMod.restorePortableBundle !== 'function') {
      return { ok: false, error: 'PORTABLE_MODULE_MISSING', message: '便携包模块尚未集成，本接口暂不可用' };
    }
    if (!importPlans.size) loadImportPlans();
    const rec = importPlans.get(planId);
    if (!rec || !rec.srcDir) return { ok: false, error: 'PLAN_NOT_FOUND', message: '请先做恢复预检，再确认执行' };
    try {
      const res = await portableMod.restorePortableBundle({ bundleDir: rec.srcDir, dataDir: DATA_DIR(), filesDir: FILES_DIR() });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'RESTORE_FAILED', message: (res && res.error) || '恢复失败' };
      // 恢复成功：从磁盘重载内存态（与 app:importJson 同款收尾），广播刷新
      const n = portableMod.readCurrentBundle(DATA_DIR());
      store.items = n.items; store.events = n.events; store.reviews = n.reviews; store.quotes = n.quotes;
      ideaItems = n.ideas; extractStore.items = n.extracts; userRules.rules = n.userRules; srsCards = n.srsCards;
      draftStore.data = n.drafts; catRules.data = n.categoryRules; catProfile.data = n.categoryProfile;
      idxCache = null; bridgeIdx = null;
      pushIdeaCount(); pushSrsCount();
      if (mainWin && !mainWin.isDestroyed()) { try { mainWin.webContents.send('library:changed', {}); } catch {} }
      return {
        ok: true,
        restored: res.added, skipped: res.skipped, failed: 0,
        attachmentsRestored: res.counts ? res.counts.attachmentsRestored : null,
        attachmentsReused: res.counts ? res.counts.attachmentsReused : null,
        conflictsRemapped: res.counts ? res.counts.attachmentConflictsRemapped : null,
        complete: !!res.complete,
        backupDir: res.backupDir, bundleDir: rec.srcDir,
      };
    } catch (err) {
      return { ok: false, error: 'RESTORE_FAILED', message: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('draft:get', (e, slot) => draftStore ? draftStore.get(slot || 'quick') : null);
  ipcMain.handle('draft:save', (e, { slot, draft } = {}) => draftStore ? draftStore.save(slot || 'quick', draft || {}) : null);
  ipcMain.handle('draft:clear', (e, slot) => draftStore ? draftStore.clear(slot || 'quick') : true);

  ipcMain.handle('chat:list', (e, q) => {
    const s = String(q || '').toLowerCase();
    return store.allItems().filter(i => i.kind === 'chat').filter(i => {
      if (!s) return true;
      return (i.title || '').toLowerCase().includes(s) || (i.notes || '').toLowerCase().includes(s) || (i.raw_text || '').toLowerCase().includes(s);
    }).slice(0, 40).map(i => ({
      id: i.id, title: i.title, created_at: i.created_at,
      messages: (i.messages || []).length, pending: chatOps.pendingAttachments(i.messages || []).length,
    }));
  });
  ipcMain.handle('chat:appendPreview', (e, { itemId, messages, text } = {}) => {
    const it = store.get(itemId);
    if (!it || it.kind !== 'chat') return { ok: false, error: '找不到这条聊天' };
    const incoming = Array.isArray(messages) && messages.length ? messages : parseChatText(text || '');
    const plan = chatOps.planAppend(it.messages || [], incoming);
    return { ok: true, counts: plan.counts, added: plan.added, definiteDup: plan.definiteDup, possibleDup: plan.possibleDup, incoming:plan.incoming, rawText: text || '' };
  });
  ipcMain.handle('chat:append', async (e, p) => appendChatToItem(p && p.itemId, p || {}));
  ipcMain.handle('chat:updateMessage', (e,{itemId,messageId,patch}={})=>{
    const it=store.get(itemId);if(!it||it.trashed||it.kind!=='chat')return {ok:false,error:'聊天不存在'};
    const messages=structuredClone(it.messages||[]);const m=messages.find(x=>x.id===messageId);if(!m)return {ok:false,error:'消息不存在'};
    const before={speaker:m.speaker,time:m.time,text:m.text};
    for(const k of ['speaker','time','text'])if(patch?.[k]!==undefined)m[k]=String(patch[k]);
    m.speakerUnknown=!m.speaker;m.timeUnknown=!m.time;
    store.update(it.id,{messages,notes:messagesToText(messages),message_edits:[...(it.message_edits||[]),{messageId,before,at:Date.now()}]});
    return {ok:true};
  });

  ipcMain.handle('chat:fillAttachment', async (e, { itemId, filename, filePath, messageId } = {}) => {
    const it = store.get(itemId);
    if (!it || it.trashed) return { ok: false, error: '资料不存在' };
    const msgs = chatOps.ensureMessageIds(it.messages || []);
    if (filePath && fs.existsSync(filePath)) {
      const probe = chatOps.fillAttachment(msgs.map(m => ({ ...m, attachment: m.attachment ? { ...m.attachment } : m.attachment })), filename || path.basename(filePath), { path: filePath, name: path.basename(filePath) }, messageId);
      if (probe.needChoice) return probe;
      if (!probe.ok && !messageId) return probe;
      const saved = archiveFile(filePath);
      const fileRec = { ...saved, pending: false };
      const r = chatOps.fillAttachment(msgs, filename || path.basename(filePath), fileRec, messageId || probe.messageId);
      if (!r.ok) return r;
      store.update(it.id, { messages: msgs, files: [...(it.files || []), saved] });
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', { id: it.id });
      return { ...r, item: store.get(it.id) };
    }
    return { ok: false, error: '文件不存在' };
  });

  ipcMain.handle('extract:add', (e, rec) => {
    if (!extractStore) return { ok: false, error: '未就绪' };
    let ideaId = null;
    if (rec && rec.kind === 'idea') {
      const t = String(rec.title || rec.body || '').replace(/\s+/g, ' ').trim();
      if (!t) return { ok: false, error: '点子是空的' };
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      let idea = ideaItems.find(i => ideas.ideaStatus(i) !== 'done' && norm(i.text) === norm(t));
      if (!idea) {
        idea = ideas.migrateIdea({
          id: require('./src/db').uid(), text: t.slice(0, 500),
          note: String(rec.body || '').slice(0, 1000), created_at: Date.now(),
          source_item_id: rec.source_item_id || null, source_message_ids: rec.source_message_ids || [], related_item_ids: rec.source_item_id ? [rec.source_item_id] : [], status: 'clarify', reminder_mode: 'weekly',
        });
        ideaItems.push(idea); saveIdeas(); idxCache = null; pushIdeaCount();
      }
      idea.related_item_ids=[...new Set([...(idea.related_item_ids||[]),rec.source_item_id].filter(Boolean))];
      saveIdeas();
      ideaId = idea.id;
      rec.idea_id = ideaId;
    }
    const r = extractStore.add(rec || {});
    idxCache = null;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', { id: rec && rec.source_item_id });
    return r;
  });
  ipcMain.handle('extract:list', (e, f) => extractStore ? extractStore.list(f || {}) : []);
  ipcMain.handle('extract:byItem', (e, id) => extractStore ? extractStore.byItem(id) : []);
  ipcMain.handle('extract:update', (e, { id, patch } = {}) => {
    if (!extractStore) return null;
    const r = extractStore.update(id, patch || {});
    if(r && r.idea_id){const idea=ideaItems.find(i=>i.id===r.idea_id);if(idea){idea.text=r.title;idea.note=r.body;saveIdeas();}}
    idxCache = null;
    return r;
  });
  ipcMain.handle('extract:remove', (e, id) => {
    if (!extractStore) return false;
    const r = extractStore.remove(id);
    idxCache = null;
    return r;
  });
  ipcMain.handle('extract:aiDraft', async (e, { itemId, messageIds, sourceText } = {}) => {
    const cfg = aiCfg();
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: '未配置 AI', disabled: true };
    const it = itemId ? store.get(itemId) : null;
    const msgs = (it && it.messages || []).filter(m => !messageIds || !messageIds.length || messageIds.includes(m.id));
    const raw = sourceText || msgs.map(m => [m.speaker, m.time, m.text].filter(Boolean).join(' ')).join('\n') || (it && (it.notes || it.text)) || '';
    try {
      const body = {
        model: cfg.model || 'gpt-4o-mini', temperature: 0.2,
        messages: [
          { role: 'system', content: '从用户给出的原文提取结论、待办、方法。只使用原文里有的事实，不要补充，不要把未确认讨论写成最终结论。输出 JSON：{"items":[{"kind":"conclusion|todo|method","title":"","body":""}]}。没有把握就少提取。' },
          { role: 'user', content: String(raw).slice(0, 6000) },
        ],
      };
      const rawOut = await requestChat(cfg, body);
      return { ok: true, ai_draft: true, items: parseDraft(rawOut) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('usage:add', (e, { id, purpose, result, related_ids, related_url, used_at } = {}) => {
    const it = store.get(id);
    if (!it) return { ok: false, error: '资料不存在' };
    const r = usage.addUse(it, { purpose, result, related_ids, related_url, used_at });
    if (!r.ok) return r;
    store.save();
    return r;
  });
  ipcMain.handle('usage:recent', () => usage.recentUsed(store.allItems(), 40));
  ipcMain.handle('usage:frequent', () => usage.frequentUsed(store.allItems(), 40));
  ipcMain.handle('library:recentUsed', () => usage.recentUsed(store.allItems(), 40));
  ipcMain.handle('library:frequentUsed', () => usage.frequentUsed(store.allItems(), 40));
  ipcMain.handle('improve:add', (e, { id, problem, change, reason, fullVersion } = {}) => {
    const it = store.get(id);
    if (!it) return { ok: false, error: '资料不存在' };
    const r = usage.addImprovement(it, { problem, change, reason, fullVersion });
    if (!r.ok) return r;
    store.save();
    return r;
  });
  ipcMain.handle('version:add', (e, { id, content, reason } = {}) => {
    const it = store.get(id);
    if (!it) return { ok: false, error: '资料不存在' };
    const r = usage.addVersion(it, { content, reason, makeCurrent: true });
    if (!r.ok) return r;
    store.save();
    return r;
  });
  ipcMain.handle('version:setCurrent', (e, { id, versionId } = {}) => {
    const it = store.get(id);
    const r = usage.setCurrentVersion(it, versionId);
    if (r.ok) store.save();
    return r;
  });
  ipcMain.handle('version:restore', (e, { id, versionId } = {}) => {
    const it = store.get(id);
    const r = usage.restoreVersion(it, versionId);
    if (r.ok) store.save();
    return r;
  });
  ipcMain.handle('version:copy', (e, id) => {
    const it = store.get(id);
    if (!it) return { ok: false, error: '资料不存在' };
    return { ok: true, text: usage.currentContent(it) };
  });

  ipcMain.handle('taxonomy:setItemCategory', (e, { id, category, makeRule, terms } = {}) => {
    const it = store.get(id);
    if (!it) return { ok: false, error: '资料不存在' };
    const cat = String(category || '').trim();
    if (!cat) return { ok: false, error: '缺少分类' };
    store.update(id, { category: cat, category_locked: true, classification_source: 'user' });
    if (catProfile) catProfile.learn(cat, (it.title || '') + '\n' + (it.notes || ''), { weight: 3 });
    let rule = null;
    if (makeRule && userRules) {
      const ts = (terms && terms.length) ? terms : distinctiveTerms((it.title || '') + ' ' + (it.notes || ''), 4);
      const cr = userRules.create({ category: cat, terms: ts, fromItemId: id, reason: '由「' + (it.title || '').slice(0, 20) + '」纠错生成' });
      if (cr.ok) rule = cr.rule;
    }
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', { id });
    return { ok: true, item: store.get(id), rule, suggestedTerms: distinctiveTerms((it.title || '') + ' ' + (it.notes || ''), 4) };
  });
  ipcMain.handle('taxonomy:previewSimilar', (e, { id, terms, category } = {}) => {
    const it = id ? store.get(id) : null;
    const ts = (terms && terms.length) ? terms : distinctiveTerms(it ? ((it.title || '') + ' ' + (it.notes || '')) : '', 4);
    const fake = { terms: ts, fields: ['title', 'notes'], mode: 'all', enabled: true, category: category || (it && it.category) };
    const hits = userRules ? userRules.preview(store.allItems(), fake) : [];
    return { ok: true, terms: ts, hits: hits.filter(h => h.id !== id).slice(0, 30) };
  });
  ipcMain.handle('taxonomy:createSimilar', (e, { category, terms, fromItemId } = {}) => {
    if (!userRules) return { ok: false, error: '未就绪' };
    return userRules.create({ category, terms, fromItemId, reason: '类似内容归类' });
  });
  ipcMain.handle('taxonomy:userRules', () => userRules ? userRules.list() : []);
  ipcMain.handle('taxonomy:setUserRule', (e, { id, patch } = {}) => userRules ? userRules.set(id, patch || {}) : { ok: false });
  ipcMain.handle('taxonomy:previewApply', (e, { id } = {}) => {
    const rule = userRules && userRules.list().find(r => r.id === id);
    if (!rule) return { ok: false, error: '规则不存在' };
    return { ok: true, hits: userRules.preview(store.allItems(), rule) };
  });
  ipcMain.handle('taxonomy:applyRule', (e, { id, ids } = {}) => {
    const rule = userRules && userRules.list().find(r => r.id === id);
    if (!rule || !rule.enabled) return { ok: false, error: '规则不可用' };
    if(!Array.isArray(ids))return {ok:false,error:'请先预览并选择要调整的资料'};
    const valid = new Set(userRules.preview(store.allItems(), rule).map(h=>h.id));
    const target = ids.filter(id=>valid.has(id));
    let n = 0;
    for (const iid of target) {
      const it = store.get(iid);
      if (!it || it.category_locked) continue;
      store.update(iid, { category: rule.category, classification_source: 'user-rule', classification_rule_id: rule.id });
      n += 1;
    }
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
    return { ok: true, moved: n };
  });

  // 复盘
  ipcMain.handle('review:generate', (e, { mode }) => generateAndSaveReview(['weekly', 'cycle', 'monthly'].includes(mode) ? mode : 'daily'));
  ipcMain.handle('reviews:list', () => store.listReviews());

  // 积累统计（侧栏积累条 / 成就墙）
  ipcMain.handle('stats:get', () => statsSnapshot());

  ipcMain.handle('config:get', () => {
    const c = loadConfig();
    return { ...c, apiKey: c.apiKey ? '••••••••' : '' };
  });
  ipcMain.handle('config:testAi', (e, draft = {}) => {
    const saved = aiCfg();
    const key = draft.apiKey === undefined || /^•+$/.test(String(draft.apiKey).trim()) ? saved.apiKey : draft.apiKey;
    return testConnection({ ...saved, ...draft, apiKey: key });
  });
  ipcMain.handle('config:set', (e, patch) => {
    const c = loadConfig();
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) if (v !== undefined && !(k === 'apiKey' && /^•+$/.test(String(v).trim()))) clean[k] = v;
    const next = { ...c, ...clean };
    saveConfig(next);
    if (clean.quickDropShortcut !== undefined) { try { globalShortcut.unregisterAll(); registerShortcuts(); } catch {} }
    if (tray) tray.setContextMenu(buildTrayMenu());
    return true;
  });

  ipcMain.handle('app:paths', () => ({ userData: CONFIG_DIR(), files: FILES_DIR(), data: DATA_DIR(), reports: path.join(CONFIG_DIR(), 'reports') }));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:iconDataUrl', () => {
    try {
      const p = path.join(__dirname, 'assets', 'icon-512.png');
      return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    } catch { return null; }
  });
  ipcMain.on('app:reveal', (e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
  ipcMain.on('app:openDataDir', () => { shell.openPath(CONFIG_DIR()); });
  // 只读访问应用数据目录内的文本文件（预览归档附件用；拒绝数据目录外的任意路径）
  ipcMain.handle('app:readFile', (e, p) => {
    try {
      if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
      const root = CONFIG_DIR();
      const abs = path.resolve(p);
      if (!abs.startsWith(root + path.sep)) return null;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
      return fs.readFileSync(abs, 'utf8').slice(0, 200000);
    } catch { return null; }
  });
  // 行为事件流读取（stats/画像辅助）
  ipcMain.handle('events:since', (e, ts) => { try { return store.eventsSince(Number(ts) || 0); } catch { return []; } });
  ipcMain.on('app:openExternal', (e, u) => { if (/^https?:/i.test(String(u))) shell.openExternal(u); });
  ipcMain.handle('app:exportJson', async () => {
    const r = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('documents'), `学习资产库备份-${localDayKey()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(exportBundle(), null, 1));
    return r.filePath;
  });
  ipcMain.handle('app:importJson', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    try {
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const merged=mergeBackup(exportBundle(),data);
      const backupDir=writeRestoredBundle(DATA_DIR(),merged.next);
      const n=merged.next;
      store.items=n.items;store.events=n.events;store.reviews=n.reviews;store.quotes=n.quotes;
      ideaItems=n.ideas;extractStore.items=n.extracts;userRules.rules=n.userRules;srsCards=n.srsCards;
      draftStore.data=n.drafts;catRules.data=n.categoryRules;catProfile.data=n.categoryProfile;
      idxCache=null;bridgeIdx=null;pushIdeaCount();
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:changed', {});
      return {ok:true,added:merged.added,skipped:merged.skipped,backupDir,attachments:'paths-only'};
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
}

// ---------- 快捷键 ----------
function registerShortcuts() {
  const c = loadConfig();
  try { globalShortcut.register(c.quickDropShortcut || 'CommandOrControl+Shift+L', () => createQuickWin('note')); } catch {}
  try { globalShortcut.register('CommandOrControl+Shift+R', () => createReviewWin()); } catch {} // 🔁 复习
  try { globalShortcut.register('CommandOrControl+Shift+I', () => createIdeaWin()); } catch {}   // 💡 点子
}

// ---------- StudyDesk 本机桥接（网课学习工作台 ↔ 学习资产库） ----------
function showLibraryItem(id, messageIds = []) {
  const it = store.get(id);
  if (!it || it.trashed) return { ok: false, error: '来源资料已删除或不存在' };
  createMainWindow();
  const send = () => mainWin.webContents.send('library:focus', { id, messageIds });
  if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', send); else send();
  return { ok: true };
}
// 仅监听 127.0.0.1，供本机「网课学习工作台」检索 / 打开 / 收录资料库条目。
// 开关与端口存 config.json 的 vaultBridge 字段，关掉后重启应用即关闭端口。
function BRIDGE_PORT() { const c = loadConfig(); return Number(c.vaultBridge && c.vaultBridge.port) || 8791; }
function bridgeEnabled() { const c = loadConfig(); return !(c.vaultBridge && c.vaultBridge.enabled === false); }
function bridgeItem(it, withText) {
  if (!it) return null;
  const out = {
    id: it.id, kind: it.kind || 'note', title: it.title || '未命名',
    category: it.category || '未分类', tags: it.tags || [],
    notes: String(it.notes || '').slice(0, 2000), summary: it.summary || '',
    source_path: it.source_path || '', url: it.url || '',
    files: (it.files || []).map(f => ({ path: f.path, name: f.name, ext: f.ext, size: f.size || 0 })),
    favorite: !!it.favorite, created_at: it.created_at, updated_at: it.updated_at,
    study: { progress: it.studyProgress != null ? it.studyProgress : null, status: it.studyStatus != null ? it.studyStatus : null, updatedAt: it.studyUpdatedAt != null ? it.studyUpdatedAt : null },
  };
  if (it.video) out.video = { duration: it.video.duration, width: it.video.width, height: it.video.height, size: it.video.size };
  if (withText) out.text = String(it.text || '').slice(0, 3000);
  return out;
}
function resolveBridgePath(it) {
  // 打开优先级：视频原路径 → 归档副本 → 原始路径 → 无
  if (it && it.video && it.video.path && fs.existsSync(it.video.path)) return it.video.path;
  if (it && Array.isArray(it.files) && it.files.length) {
    const hit = it.files.find(f => f && f.path && fs.existsSync(f.path));
    if (hit) return hit.path;
  }
  if (it && it.source_path && fs.existsSync(it.source_path)) return it.source_path;
  return '';
}
function bridgeReadBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > (limit || 256 * 1024)) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const bridgeCatMatch = (it, cat) => !cat || it.category === cat || String(it.category || '').startsWith(cat + '/');
function bridgeJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const bridgeServer = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (!/^127\.0\.0\.1(:\d+)?$/.test(host)) return bridgeJson(res, 403, { error: 'forbidden' });
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    if (req.method === 'GET' && p === '/ping') return bridgeJson(res, 200, { ok: true, app: 'learning-vault', version: app.getVersion(), items: store.allItems().length, ideas: ideaItems.filter(i => !i.done).length, cards: srsCards.length });
    if (req.method === 'GET' && p === '/search') {
      const q = String(u.searchParams.get('q') || '').trim();
      const limit = Math.max(1, Math.min(Math.floor(Number(u.searchParams.get('limit'))) || 50, 200));
      const category = u.searchParams.get('category') || '';
      let items, total;
      if (!q) {
        if (category) {
          // 无关键词 + 分类筛选：先全量再过滤、截断，total 为过滤后总数
          const all = store.list({ limit: store.allItems().length }).items.filter(i => bridgeCatMatch(i, category));
          items = all.slice(0, limit);
          total = all.length;
        } else {
          items = store.list({ limit }).items;
          total = store.allItems().length;
        }
      } else {
        if (!bridgeIdx) bridgeIdx = buildInverted(store.allItems().map(docOf));
        const hits = search(bridgeIdx, q, { limit: bridgeIdx.N });
        const matched = hits.map(h => store.get(h.id)).filter(Boolean).filter(i => bridgeCatMatch(i, category));
        total = matched.length;
        items = matched.slice(0, limit);
      }
      return bridgeJson(res, 200, { total, items: items.map(i => bridgeItem(i, false)) });
    }
    if (req.method === 'GET' && p === '/recent') {
      const category = u.searchParams.get('category') || '';
      const limit = Math.max(1, Math.min(Math.floor(Number(u.searchParams.get('limit'))) || 20, 100));
      if (category) {
        // 分类筛选：先取全量（facets 口径一致）再过滤、截断，total 为过滤后总数
        const all = store.list({ limit: store.allItems().length }).items.filter(i => bridgeCatMatch(i, category));
        return bridgeJson(res, 200, { total: all.length, items: all.slice(0, limit).map(i => bridgeItem(i, false)) });
      }
      const out = store.list({ limit });
      return bridgeJson(res, 200, { total: out.total, items: out.items.map(i => bridgeItem(i, false)) });
    }
    const idMatch = p.match(/^\/item\/([\w-]+)$/);
    if (req.method === 'GET' && idMatch) {
      const it = store.get(idMatch[1]);
      if (!it || it.trashed) return bridgeJson(res, 404, { error: 'not found' });
      return bridgeJson(res, 200, { item: bridgeItem(it, true) });
    }
    if (req.method === 'POST' && p === '/open') {
      const body = JSON.parse(await bridgeReadBody(req, 4096) || '{}');
      const it = store.get(String(body.id || ''));
      if (!it || it.trashed) return bridgeJson(res, 404, { error: 'not found' });
      if (['note', 'chat', 'bundle'].includes(it.kind)) {
        const opened = showLibraryItem(it.id);
        store.addEvent({ type: 'bridge-open', id: it.id, title: it.title });
        return bridgeJson(res, 200, { ...opened, opened: 'library', id: it.id });
      }
      const p2 = resolveBridgePath(it);
      if (p2) { shell.openPath(p2); store.addEvent({ type: 'bridge-open', id: it.id, title: it.title }); return bridgeJson(res, 200, { ok: true, opened: p2 }); }
      if (it.url) { shell.openExternal(it.url); store.addEvent({ type: 'bridge-open', id: it.id, title: it.title }); return bridgeJson(res, 200, { ok: true, opened: it.url }); }
      return bridgeJson(res, 410, { error: '原文件不在原位置' });
    }
    if (req.method === 'POST' && p === '/ideas') {
      const body = JSON.parse(await bridgeReadBody(req, 8192) || '{}');
      const t = String(body.text || '').replace(/\s+/g, ' ').trim();
      if (!t) return bridgeJson(res, 400, { error: '点子是空的' });
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const dup = ideaItems.find(i => !i.done && norm(i.text) === norm(t));
      if (dup) return bridgeJson(res, 200, { ok: true, id: dup.id, deduped: true });
      const rec = ideas.migrateIdea({
        id: require('./src/db').uid(),
        text: t.slice(0, 500),
        note: String(body.note || '').slice(0, 1000),
        created_at: Date.now(),
        lastTouchedAt: null, nudgedAt: null, nudgeCount: 0,
        done: false, doneAt: null, status: 'clarify', reminder_mode: 'weekly',
      });
      ideaItems.push(rec);
      saveIdeas();
      pushIdeaCount();
      return bridgeJson(res, 200, { ok: true, id: rec.id });
    }
    if (req.method === 'POST' && p === '/ingest') {
      const body = JSON.parse(await bridgeReadBody(req, 1024 * 1024) || '{}');
      const kind = body.kind === 'url' ? 'url' : (body.kind === 'video' || body.kind === 'image') ? body.kind : 'note';
      if (kind === 'url' && !/^https?:\/\//i.test(String(body.url || ''))) return bridgeJson(res, 400, { error: 'bad url' });
      if (kind !== 'url' && !String(body.notes || '').trim()) return bridgeJson(res, 400, { error: 'empty content' });
      const payload = { kind, notes: String(body.notes || '') };
      if (kind === 'url') payload.url = String(body.url);
      if ((kind === 'video' || kind === 'image') && body.source_path && fs.existsSync(body.source_path)) payload.filePaths = [String(body.source_path)];
      const rec = await pipelineIngest(payload);
      return bridgeJson(res, 200, { ok: true, id: rec.id, title: rec.title, category: rec.category, tags: rec.tags });
    }
    if (p === '/progress' && req.method === 'GET') {
      const it = store.get(String(u.searchParams.get('id') || ''));
      if (!it || it.trashed) return bridgeJson(res, 404, { error: 'not found' });
      return bridgeJson(res, 200, { id: it.id, progress: it.studyProgress != null ? it.studyProgress : null, status: it.studyStatus != null ? it.studyStatus : null, updatedAt: it.studyUpdatedAt != null ? it.studyUpdatedAt : null });
    }
    if (p === '/progress' && req.method === 'POST') {
      const body = JSON.parse(await bridgeReadBody(req, 4096) || '{}');
      const it = store.get(String(body.id || ''));
      if (!it || it.trashed) return bridgeJson(res, 404, { error: 'not found' });
      const status = body.status === 'done' ? 'done' : body.status === 'learning' ? 'learning' : (it.studyStatus === 'done' ? 'done' : 'learning');
      let progress;
      if (body.progress == null || body.progress === '') {
        progress = status === 'done' ? 100 : (Number.isFinite(Number(it.studyProgress)) ? Number(it.studyProgress) : 0);
      } else {
        progress = Math.round(Number(body.progress));
        if (!Number.isFinite(progress)) progress = status === 'done' ? 100 : 0;
        progress = Math.max(0, Math.min(100, progress));
      }
      store.update(it.id, { studyProgress: progress, studyStatus: status, studyUpdatedAt: Date.now() });
      return bridgeJson(res, 200, { ok: true, id: it.id, progress, status });
    }
    if (req.method === 'GET' && p === '/categories') {
      // facets 对全部未删除条目统计，与 limit 无关，limit:1 只为少拷贝分页切片
      const facets = store.list({ limit: 1 }).facets.categories;
      const categories = Object.keys(facets)
        .filter(k => k)
        .map(name => ({ name, count: facets[name] }))
        .sort((a, b) => b.count - a.count);
      return bridgeJson(res, 200, { categories });
    }
    if (req.method === 'POST' && p === '/card') {
      const body = JSON.parse(await bridgeReadBody(req, 8192) || '{}');
      const front = String(body.front || '').trim();
      if (!front) return bridgeJson(res, 400, { error: '卡面是空的' });
      const back = String(body.back || '').trim();
      const srcId = String(body.sourceItemId || '') || null;
      if (srcId) {
        const srcIt = store.get(srcId);
        if (!srcIt || srcIt.trashed) return bridgeJson(res, 404, { error: 'not found' });
      }
      // 字段形状与 srs.newCard（手动成卡路径）完全一致，sourceItemId 映射到 itemId
      const card = srs.newCard({ itemId: srcId, kind: 'manual', front, back });
      srsCards.push(card);
      saveSrsCards();
      return bridgeJson(res, 200, { ok: true, id: card.id });
    }
    return bridgeJson(res, 404, { error: 'not found' });
  } catch (e) {
    return bridgeJson(res, 500, { error: String(e && e.message || e) });
  }
});
function startBridge() {
  if (!bridgeEnabled()) return;
  try {
    bridgeServer.listen(BRIDGE_PORT(), '127.0.0.1');
    bridgeServer.on('error', () => {}); // 端口被占（多开/自检）时静默跳过，不影响应用本体
  } catch {}
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  store = new Store(DATA_DIR());
  // 倒排索引缓存失效钩子：insert/update 等内部都走 this.save → 实例方法已被包装，落库即置空缓存
  const _origSave = store.save.bind(store);
  store.save = () => { idxCache = null; bridgeIdx = null; _origSave(); };
  catProfile = new CategoryProfile(path.join(DATA_DIR(), 'category-profile.json'));
  catRules = new TaxonomyRules(path.join(DATA_DIR(), 'category-rules.json'));
  loadSrsCards();
  loadIdeas();
  extractStore = new ExtractStore(path.join(DATA_DIR(), 'extracts.json'));
  draftStore = new DraftStore(path.join(DATA_DIR(), 'capture-drafts.json'));
  userRules = new UserRuleStore(path.join(DATA_DIR(), 'user-rules.json'));
  try {
    const mig = migrateAll({ store, ideaItems, dataDir: DATA_DIR() });
    if (Array.isArray(mig.ideas)) ideaItems = mig.ideas;
    if (mig.changed) saveIdeas();
  } catch (e) { dialog.showErrorBox('升级未完成，数据保持原样',String(e.message)); app.exit(1); return; }
  fs.mkdirSync(FILES_DIR(), { recursive: true });

  registerIpc();
  createTray();
  startBridge();   // StudyDesk 桥：本机 127.0.0.1:8791，关停不影响应用
  createOverlay();
  const c = loadConfig();
  if (c.overlayVisible === false) overlayWin.hide();
  registerShortcuts();
  startReviewScheduler();
  // P0 补跑：启动 20s 后检查错过的晚间职责；睡眠唤醒/解锁后再查（错峰等网络与磁盘就绪）
  setTimeout(() => { checkMissedDuties(); }, 20000);
  try {
    powerMonitor.on('resume', () => setTimeout(() => { checkMissedDuties(); }, 15000));
    powerMonitor.on('unlock-screen', () => setTimeout(() => { checkMissedDuties(); }, 15000));
  } catch (e) { console.error('powerMonitor hook error:', e); }
  // 预热快速收录窗：应用启动 2s 后后台建好，首次按快捷键秒开
  setTimeout(() => { if(!quickWin) createQuickWin(null); }, 2000);
  setTimeout(pushOverlayCount, 3200); // 等悬浮球加载完再推今日计数

  // --smoke：自检模式，验证模块与入库链路后自动退出（不污染真实数据，走 LV_* 目录覆盖）
  if (process.argv.includes('--smoke')) {
    createMainWindow();
    setTimeout(async () => {
      let code = 0;
      try {
        require('pdf-parse'); require('mammoth');
        const osx = require('os');
        const tmp = path.join(osx.tmpdir(), 'lv-smoke-' + Date.now() + '.md');
        fs.writeFileSync(tmp, '# 冒烟测试\n这是一篇关于 RAG 检索增强生成的测试文档，包含算法与模型内容。');
        const { extractFromFile } = require('./src/extract');
        const ex = await extractFromFile(tmp);
        const extractOk = ex.text.includes('RAG');
        const { heuristicClassify } = require('./src/classify');
        const cls = heuristicClassify(ex.text, '');
        const rec = store.insert({ kind: 'file', title: '冒烟测试条目', text: ex.text, files: [] });
        const listed = store.list({ q: 'RAG' });
        const storeOk = listed.total >= 1;
        const r = generateAndSaveReview('daily');
        console.log('SMOKE_OK ' + JSON.stringify({
          extract: extractOk, classify: cls.category, store: storeOk,
          items: store.items.length, inserted: rec.id, reviewReady: !!r,
        }));
      } catch (e) {
        code = 1;
        console.log('SMOKE_FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
      }
      app.exit(code);
    }, 2500);
    return;
  }

  // --drop-test：拖拽直收 E2E（CDP 注入真实系统级文件拖拽；LV_CONFIG_DIR 隔离运行，不碰真实数据）
  if (process.argv.includes('--drop-test')) {
    createMainWindow();
    setTimeout(async () => {
      let code = 0;
      try {
        const ok = await require('./scripts/drop-e2e.js').run({ win: mainWin, store, filesDir: FILES_DIR() });
        code = ok ? 0 : 1;
      } catch (e) {
        code = 1;
        console.log('DROP_TEST_FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
      }
      app.exit(code);
    }, 2500);
    return;
  }

  if (process.argv.includes('--flow-verify')) {
    createMainWindow();
    setTimeout(async () => {
      let code = 0;
      try {
        const r = await require('./scripts/flow-e2e.js').run({
          store, extractStore, ideaItems, saveIdeas, filesDir: FILES_DIR(),
          win: mainWin,
          createQuickWin, createIdeaWin, generateAndSaveReview,
          quickWin: () => quickWin, ideaWin: () => ideaWin,
        });
        console.log('FLOW_VERIFY ' + JSON.stringify({ ok: r.ok, steps: r.steps, shots: r.shots, errors: r.errors }));
        code = r.ok ? 0 : 1;
      } catch (e) {
        code = 1;
        console.log('FLOW_VERIFY_FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e));
      }
      app.exit(code);
    }, 2800);
    return;
  }

  // --shot：主窗截图（CDP Page.captureScreenshot；LV_CONFIG_DIR 隔离运行，仅测试用）
  if (process.argv.includes('--shot')) {
    const out = process.env.LV_SHOT_OUT || '/tmp/lv-shot.png';
    createMainWindow();
    setTimeout(async () => {
      try {
        mainWin.webContents.debugger.attach('1.3');
        const r = await mainWin.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
        console.log('SHOT_OK ' + out);
      } catch (e) {
        console.log('SHOT_FAIL ' + (e && e.message ? e.message : e));
        process.exitCode = 1;
      }
      app.exit(0);
    }, 3000);
    return;
  }

  // 启动静默化：空库（首次）才弹主窗引导；日常启动只进托盘 + 悬浮按钮，不抢屏幕
  if (!store.items.length) {
    createMainWindow();
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '学习资产库已在后台就绪',
        body: '拖文件/链接到屏幕右侧悬浮按钮即可收录；快捷键 ' + (c.quickDropShortcut || '⌘⇧L') + ' 唤起快速收录',
      });
      n.on('click', () => createMainWindow());
      n.show();
    }
  }
});

app.on('activate', () => createMainWindow());
app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
let flushedForQuit = false;
app.on('before-quit', (e) => {
  if (!flushedForQuit) {
    e.preventDefault();
    // 3s 超时兜底：预热窗页面尚未加载完时 executeJavaScript 永不 resolve，
    // 没有超时会让退出永久挂起（实测复现：快速启动后立即退出）
    const withTimeout = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(true), 3000))]);
    Promise.all([quickWin,ideaWin].filter(w=>w&&!w.isDestroyed()).map(w=>withTimeout(w.webContents.executeJavaScript('window.flushCaptureDraft ? window.flushCaptureDraft() : true').catch(()=>true))))
      .then(results=>{
        if(results.some(r=>r===false)){ dialog.showErrorBox('暂未退出','有未保存的草稿，请在窗口中重试保存'); return; }
        flushedForQuit=true;app.quit();
      })
      .catch(err=>{flushedForQuit=true;app.quit();}); // 冲刷链路异常（页面销毁等）不卡死退出，草稿有防抖自动保存兜底
    return;
  }
  quitting=true;stopOverlayDrag();try{const p=getPool();if(p)p.killAll();}catch{}
});
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });

// 仅供临时 node 测试脚本（无 Electron 环境）复用纯函数；正常运行零影响
if (process.env.LV_TEST_EXPOSE) {
  app._testRunSelfcheckOnce = runSelfcheckOnce;
  module.exports = { topTermsOfTerms, computeProfileGrowth, snapshotCatsFromProfile, parseSelfcheckOutput, runSelfcheckOnce };
}
