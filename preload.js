const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  // 事件推送
  onIngestDone: (cb) => ipcRenderer.on('ingest:done', (_e, d) => cb(d)),
  onQuickPayload: (cb) => ipcRenderer.on('quick:payload', (_e, d) => cb(d)),
  onQuickFx: (cb) => ipcRenderer.on('quick:fx', (_e, m) => cb(m)),
  onLibraryChanged: (cb) => ipcRenderer.on('library:changed', (_e, d) => cb(d)),
  onOverlayCount: (cb) => ipcRenderer.on('overlay:count', (_e, d) => cb(d)),
  onMilestone: (cb) => ipcRenderer.on('stats:milestone', (_e, d) => cb(d)),
  onScanProgress: (cb) => ipcRenderer.on('scan:progress', (_e, d) => cb(d)),

  // 视频索引（只索引不复制）与文件夹
  pickFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  scanVideos: (folder) => ipcRenderer.invoke('library:scanVideos', { folder }),
  openFile: (p) => ipcRenderer.invoke('app:openFile', p),

  // quick 窗
  quickSubmit: (payload) => ipcRenderer.send('quick:submit', payload),
  quickClose: () => ipcRenderer.send('quick:close'),
  openQuick: () => ipcRenderer.send('overlay:open-quick'),
  chatParse: (text) => ipcRenderer.invoke('chat:parse', text),

  // 图片收藏夹画廊窗：由主窗入口和右侧图片圆钮打开
  ivOpen: () => ipcRenderer.send('iv:open'),
  onIvShown: (cb) => ipcRenderer.on('iv:shown', () => cb()),

  // 记忆复习（SM-2 艾宾浩斯）
  srsDue: () => ipcRenderer.invoke('srs:due'),
  srsCount: () => ipcRenderer.invoke('srs:count'),
  srsGrade: (cardId, grade) => ipcRenderer.invoke('srs:grade', { cardId, grade }),
  srsAdd: (itemId, kind, front, back) => ipcRenderer.invoke('srs:add', { itemId, kind, front, back }),
  srsRemove: (itemId) => ipcRenderer.invoke('srs:remove', { itemId }),
  srsStats: () => ipcRenderer.invoke('srs:stats'),
  srsQueue: () => ipcRenderer.invoke('srs:queue'),
  srsSkip: (cardId) => ipcRenderer.invoke('srs:skip', { cardId }),
  srsSuspend: (cardId) => ipcRenderer.invoke('srs:suspend', { cardId }),
  srsSuspendedList: () => ipcRenderer.invoke('srs:suspendedList'),
  srsResume: (cardId) => ipcRenderer.invoke('srs:resume', { cardId }),
  srsEdit: (cardId, front, back) => ipcRenderer.invoke('srs:edit', { cardId, front, back }),
  srsRestore: (snapshot) => ipcRenderer.invoke('srs:restore', { snapshot }),
  srsOpenItem: (cardId) => ipcRenderer.invoke('srs:openItem', { cardId }),
  srsGuard: () => ipcRenderer.invoke('srs:guard'),
  srsAiDraft: (itemId) => ipcRenderer.invoke('srs:aiDraft', { itemId }),
  onSrsShown: (cb) => ipcRenderer.on('srs:shown', () => cb()),
  srsOpen: () => ipcRenderer.send('srs:open'),
  srsClose: () => ipcRenderer.send('srs:close'),

  // 资料级回看（该回看了）
  resurfaceToday: () => ipcRenderer.invoke('resurface:today'),
  resurfaceSnooze: (itemId, days) => ipcRenderer.invoke('resurface:snooze', { itemId, days }),
  resurfaceDismiss: (itemId) => ipcRenderer.invoke('resurface:dismiss', { itemId }),

  // 点子收件箱（待学习的想法）
  ideasList: () => ipcRenderer.invoke('ideas:list'),
  ideasAdd: (text, note) => ipcRenderer.invoke('ideas:add', { text, note }),
  ideasDone: (id) => ipcRenderer.invoke('ideas:done', { id }),
  ideasRestore: (id) => ipcRenderer.invoke('ideas:restore', { id }),
  ideasSnooze: (id) => ipcRenderer.invoke('ideas:snooze', { id }),
  ideasRemove: (id) => ipcRenderer.invoke('ideas:remove', { id }),
  ideasCount: () => ipcRenderer.invoke('ideas:count'),
  ideasPatch: (id, patch) => ipcRenderer.invoke('ideas:patch', { id, patch }),
  ideasThisWeek: () => ipcRenderer.invoke('ideas:thisWeek'),
  ideasOpen: (id) => ipcRenderer.send('ideas:open', id),
  onIdeasChanged: cb => ipcRenderer.on('ideas:changed',()=>cb()),
  onIdeaFocus: cb => ipcRenderer.on('ideas:focus',(_e,id)=>cb(id)),
  showItem: (id,messageIds) => ipcRenderer.invoke('library:show',{id,messageIds}),
  onItemFocus: cb => ipcRenderer.on('library:focus',(_e,p)=>cb(p)),
  onNavigate: cb => ipcRenderer.on('main:navigate',(_e,p)=>cb(p||{})),
  ideasClose: () => ipcRenderer.send('ideas:close'),
  onIdeaShown: (cb) => ipcRenderer.on('ideas:shown', () => cb()),
  onIdeasCount: (cb) => ipcRenderer.on('ideas:count-changed', (_e, d) => cb(d)),
  onSrsCount: (cb) => ipcRenderer.on('srs:count-changed', (_e, d) => cb(d)),
  // 主进程发两个载荷（shown 数字 + {total,plan} 附加对象），第二个必须透传给 setSrs(n, extra)，
  // 否则悬浮条积压徽标永远拿不到「实际到期/分期建议」tooltip 数据
  onOverlaySrs: (cb) => ipcRenderer.on('overlay:srs', (_e, d, extra) => cb(d, extra)),

  // 悬浮球
  // 主进程推送贴边模式：'dock-right' | 'dock-left' | 'float'（旧版本为布尔，透传给渲染层归一化）。
  onOverlayEdge: (cb) => ipcRenderer.on('overlay:edge', (_e, d) => cb(d)),
  overlayOpenQuick: () => ipcRenderer.send('overlay:open-quick'),
  overlayOpenMain: () => ipcRenderer.send('overlay:open-main'),
  overlayIngest: (payload) => ipcRenderer.send('overlay:ingest', payload),
  overlayQuickWith: (payload) => ipcRenderer.send('overlay:quick-with', payload),
  overlayResetPos: () => ipcRenderer.send('overlay:reset-pos'),
  overlayMenu: () => ipcRenderer.send('overlay:menu'),
  overlayHide: () => ipcRenderer.send('overlay:hide'),
  dragStart: (point) => ipcRenderer.send('overlay:drag-start', point),
  dragMove: (point) => ipcRenderer.send('overlay:drag-move', point),
  dragEnd: () => ipcRenderer.send('overlay:drag-end'),

  // 拖拽文件路径（Electron 32+ 必须用 webUtils）
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },

  // 库
  list: (f) => ipcRenderer.invoke('library:list', f),
  get: (id) => ipcRenderer.invoke('library:get', id),
  update: (id, patch) => ipcRenderer.invoke('library:update', { id, patch }),
  remove: (id) => ipcRenderer.invoke('library:remove', id),
  ingest: (payload) => ipcRenderer.invoke('library:ingest', payload),
  reclassify: (id) => ipcRenderer.invoke('library:reclassify', id),
  reextract: (id) => ipcRenderer.invoke('library:reextract', id),
  saveClipboardImage: () => ipcRenderer.invoke('app:saveClipboardImage'),
  searchIndex: (q, limit) => ipcRenderer.invoke('library:search', { q, limit }),
  taxonomyList: () => ipcRenderer.invoke('taxonomy:list'),
  taxonomyProfiles: () => ipcRenderer.invoke('taxonomy:profiles'),
  taxonomyCreate: (name, fromItemId, rename) => ipcRenderer.invoke('taxonomy:create', { name, fromItemId, rename }),
  taxonomyRemove: (name, mergeInto) => ipcRenderer.invoke('taxonomy:remove', { name, mergeInto }),
  taxonomyRules: () => ipcRenderer.invoke('taxonomy:rules'),
  taxonomySetKeywords: (cat, keywords) => ipcRenderer.invoke('taxonomy:setKeywords', { cat, keywords }),
  dayItems: (dateStr) => ipcRenderer.invoke('library:dayItems', dateStr),
  rangeItems: (from, to) => ipcRenderer.invoke('library:rangeItems', { from, to }),
  addEvent: (ev) => ipcRenderer.invoke('library:addEvent', ev),
  eventsSince: (ts) => ipcRenderer.invoke('events:since', ts),
  autoOrganize: (opts) => ipcRenderer.invoke('library:autoOrganize', opts || {}),
  undoOrganize: () => ipcRenderer.invoke('library:undoOrganize'),
  feedbackSimilar: (itemId, similarId) => ipcRenderer.invoke('library:feedbackSimilar', { itemId, similarId }),
  feedbackStats: () => ipcRenderer.invoke('library:feedbackStats'),
  bulkUpdate: (ids, patch) => ipcRenderer.invoke('library:bulkUpdate', { ids, patch }),

  // 复盘
  reviewGenerate: (payload) => ipcRenderer.invoke('review:generate', payload),
  reviewsList: () => ipcRenderer.invoke('reviews:list'),

  // 积累统计（连续天数 / 称号 / 成就墙）
  getStats: () => ipcRenderer.invoke('stats:get'),

  // 金句
  addQuote: (q) => ipcRenderer.invoke('quotes:add', q),
  listQuotes: (f) => ipcRenderer.invoke('quotes:list', f),
  quotesByItem: (itemId) => ipcRenderer.invoke('quotes:byItem', itemId),
  quotesRelated: (itemId, tags) => ipcRenderer.invoke('quotes:related', { itemId, tags }),
  updateQuote: (id, patch) => ipcRenderer.invoke('quotes:update', { id, patch }),
  removeQuote: (id) => ipcRenderer.invoke('quotes:remove', id),
  randomQuote: () => ipcRenderer.invoke('quotes:random'),
  exportQuotes: (fmt) => ipcRenderer.invoke('quotes:export', fmt),
  quoteLink: (idA, idB) => ipcRenderer.invoke('quotes:link', { idA, idB }),
  quoteGraph: () => ipcRenderer.invoke('quotes:graph'),

  // 配置
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (patch) => ipcRenderer.invoke('config:set', patch),
  testAi: (draft) => ipcRenderer.invoke('config:testAi', draft),

  // 系统
  pickFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  readClipboard: () => ipcRenderer.invoke('app:readClipboard'),
  hasClipboardImage: () => ipcRenderer.invoke('app:hasClipboardImage'),
  dailyCounts: () => ipcRenderer.invoke('library:dailyCounts'),
  reveal: (p) => ipcRenderer.send('app:reveal', p),
  openDataDir: () => ipcRenderer.send('app:openDataDir'),
  openExternal: (u) => ipcRenderer.send('app:openExternal', u),
  readFile: (p) => ipcRenderer.invoke('app:readFile', p),
  exportJson: () => ipcRenderer.invoke('app:exportJson'),
  importJson: () => ipcRenderer.invoke('app:importJson'),
  paths: () => ipcRenderer.invoke('app:paths'),
  version: () => ipcRenderer.invoke('app:version'),
  iconDataUrl: () => ipcRenderer.invoke('app:iconDataUrl'),

  captureDetect: (p) => ipcRenderer.invoke('capture:detect', p),
  captureSave: (p) => ipcRenderer.invoke('capture:save', p),

  // 批量导入（计划预检 → 明确提交 → 状态 → 失败单项重试）
  // payload: {text, files, kind, targetItemId?, source?}；files 只能来自显式选取/拖入的路径
  importPreview: (payload) => ipcRenderer.invoke('import:preview', payload),
  importCommit: ({ planId, decisions }) => ipcRenderer.invoke('import:commit', { planId, decisions }),
  importStatus: (batchId) => ipcRenderer.invoke('import:status', batchId),
  importRetry: (batchId) => ipcRenderer.invoke('import:retry', batchId),

  // 便携包（文件夹包导出/预检/恢复；原生选择器，取消一律 {cancelled:true}）
  portableExport: (opts) => ipcRenderer.invoke('portable:export', { selectExternal: !!(opts && opts.selectExternal === true) }),
  portablePreview: () => ipcRenderer.invoke('portable:preview'),
  portableRestore: ({ planId }) => ipcRenderer.invoke('portable:restore', { planId }),
  draftGet: (slot) => ipcRenderer.invoke('draft:get', slot),
  draftSave: (slot, draft) => ipcRenderer.invoke('draft:save', { slot, draft }),
  draftClear: (slot) => ipcRenderer.invoke('draft:clear', slot),
  chatList: (q) => ipcRenderer.invoke('chat:list', q),
  chatAppendPreview: (p) => ipcRenderer.invoke('chat:appendPreview', p),
  chatUpdateMessage: p => ipcRenderer.invoke('chat:updateMessage',p),
  chatAppend: (p) => ipcRenderer.invoke('chat:append', p),
  chatFillAttachment: (p) => ipcRenderer.invoke('chat:fillAttachment', p),
  extractAdd: (p) => ipcRenderer.invoke('extract:add', p),
  extractList: (f) => ipcRenderer.invoke('extract:list', f),
  extractByItem: (id) => ipcRenderer.invoke('extract:byItem', id),
  extractUpdate: (id, patch) => ipcRenderer.invoke('extract:update', { id, patch }),
  extractRemove: (id) => ipcRenderer.invoke('extract:remove', id),
  extractAiDraft: (p) => ipcRenderer.invoke('extract:aiDraft', p),
  usageAdd: (p) => ipcRenderer.invoke('usage:add', p),
  usageRecent: () => ipcRenderer.invoke('usage:recent'),
  usageFrequent: () => ipcRenderer.invoke('usage:frequent'),
  libraryRecentUsed: () => ipcRenderer.invoke('library:recentUsed'),
  libraryFrequentUsed: () => ipcRenderer.invoke('library:frequentUsed'),
  improveAdd: (p) => ipcRenderer.invoke('improve:add', p),
  versionAdd: (p) => ipcRenderer.invoke('version:add', p),
  versionSetCurrent: (p) => ipcRenderer.invoke('version:setCurrent', p),
  versionRestore: (p) => ipcRenderer.invoke('version:restore', p),
  versionCopy: (id) => ipcRenderer.invoke('version:copy', id),
  taxonomySetItemCategory: (p) => ipcRenderer.invoke('taxonomy:setItemCategory', p),
  taxonomyPreviewSimilar: (p) => ipcRenderer.invoke('taxonomy:previewSimilar', p),
  taxonomyCreateSimilar: (p) => ipcRenderer.invoke('taxonomy:createSimilar', p),
  taxonomyUserRules: () => ipcRenderer.invoke('taxonomy:userRules'),
  taxonomySetUserRule: (p) => ipcRenderer.invoke('taxonomy:setUserRule', p),
  taxonomyPreviewApply: (p) => ipcRenderer.invoke('taxonomy:previewApply', p),
  taxonomyApplyRule: (p) => ipcRenderer.invoke('taxonomy:applyRule', p),
});
