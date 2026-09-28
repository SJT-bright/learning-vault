/**
 * 抽取工作线程 — 与 src/worker-pool.js 配套
 *
 * 职责：重 IO 全部在这里跑，主进程只做编排与落库
 * - extract-files：PDF / Word(docx/doc/rtf/odt) / Markdown / 网页存档 / 代码 全文抽取
 * - video-meta：mdls 视频元数据（时长/分辨率/码率/编码）+ 文件大小（并行由池负责）
 * - scan-videos：递归扫描文件夹里的视频文件（只返回路径清单，不读内容，不复制）
 *
 * 契约：收到 { id, type, payload } → 回 { id, ok, result? , error? }；单文件失败不影响批次。
 */
const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');

const { extractFromFile, makeTitleFromPath } = require('../src/extract');
const { isVideoFile, probeVideo } = require('../src/video');

const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.Trash', 'Library', '.DS_Store']);
const MAX_SCAN_FILES = 5000;
const MAX_DEPTH = 8;

async function handleExtractFiles({ paths, imagesOutDir } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  const out = [];
  for (const p of list) {
    try {
      const ex = await extractFromFile(p, { imagesOutDir: imagesOutDir || '' });
      out.push({ path: p, ok: true, text: ex.text, ext: ex.ext, title: makeTitleFromPath(p), images: ex.images, links: ex.links });
    } catch (e) {
      out.push({ path: p, ok: false, text: '【抽取失败：' + String(e && e.message ? e.message : e).slice(0, 120) + '】', ext: path.extname(p).slice(1), title: makeTitleFromPath(p), images: [], links: [] });
    }
  }
  return out;
}

async function handleVideoMeta({ paths } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  const out = [];
  for (const p of list) out.push(await probeVideo(p));
  return out;
}

// 递归列出一个文件夹里的全部视频（不读内容；跳过隐藏目录/node_modules；上限保护）
async function handleScanVideos({ folder, maxDepth } = {}) {
  const root = String(folder || '');
  const depthCap = Math.max(1, Math.min(12, parseInt(maxDepth, 10) || MAX_DEPTH));
  if (!root) throw new Error('缺少文件夹路径');
  let st;
  try { st = fs.statSync(root); } catch { throw new Error('文件夹不存在：' + root.slice(0, 120)); }
  if (!st.isDirectory()) throw new Error('不是文件夹：' + root.slice(0, 120));
  const files = [];
  let truncated = false;
  const walk = async (dir, depth) => {
    if (truncated || depth > depthCap) return;
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (truncated) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (ent.isFile() && isVideoFile(full)) {
        if (files.length >= MAX_SCAN_FILES) { truncated = true; return; }
        let size = 0, mtime = 0;
        try { const s2 = fs.statSync(full); size = s2.size; mtime = s2.mtimeMs; } catch {}
        files.push({ path: full, size, mtime });
      }
    }
  };
  await walk(root, 0);
  return { files, truncated };
}

const handlers = {
  'extract-files': handleExtractFiles,
  'video-meta': handleVideoMeta,
  'scan-videos': handleScanVideos,
};

if (parentPort) {
  parentPort.on('message', async (msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    const fn = handlers[msg.type];
    if (!fn) {
      parentPort.postMessage({ id: msg.id, ok: false, error: '未知任务类型：' + String(msg.type) });
      return;
    }
    try {
      const result = await fn(msg.payload);
      parentPort.postMessage({ id: msg.id, ok: true, result });
    } catch (e) {
      parentPort.postMessage({ id: msg.id, ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  });
}

module.exports = { handlers };
