/**
 * 视频索引支持 — 纯 Node、零新增依赖
 *
 * 设计原则（v0.5）：视频「只索引、不复制」——
 * - 条目只存 source_path（指向原文件）与元数据（时长/分辨率/大小），原文件永远留在原地
 * - 元数据来自 macOS Spotlight 的 mdls（系统自带，无需 ffprobe）；未索引/无元数据时降级为文件大小
 * - 纯函数（isVideoFile / formatDuration / videoMetaFromMdlsOutput）可被 selfcheck 直接断言
 */
const fs = require('fs');
const { execFile } = require('child_process');

// 覆盖日常拍摄/下载/录屏的主流容器
const VIDEO_EXTS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'wmv', 'flv',
  'mpg', 'mpeg', 'm2ts', 'mts', 'ts', '3gp', 'ogv',
]);

function extOf(p) { const m = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
function isVideoFile(p) { return VIDEO_EXTS.has(extOf(p)); }

// 秒 → 「1:02:05」/「12:34」；非法输入返回 ''
function formatDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '';
  const total = Math.round(s);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), ss = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(ss)}` : `${m}:${two(ss)}`;
}

// 解析 mdls -name … 多行输出：`kMDItemDurationSeconds = 123.4` / `kMDItemPixelWidth = 1920` / `xxx = (null)`
function videoMetaFromMdlsOutput(stdout) {
  const out = {};
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(kMDItem\w+)\s*=\s*(.+)$/);
    if (!m) continue;
    const v = m[2].trim();
    if (v === '(null)' || v === '') continue;
    out[m[1]] = v;
  }
  const num = (k) => { const n = parseFloat(out[k]); return Number.isFinite(n) ? n : null; };
  return {
    duration: num('kMDItemDurationSeconds'),
    width: num('kMDItemPixelWidth'),
    height: num('kMDItemPixelHeight'),
    bitrate: num('kMDItemTotalBitRate'),
    codec: out.kMDItemCodecs ? String(out.kMDItemCodecs).replace(/[()"]/g, '').slice(0, 60) : '',
  };
}

// 单个视频探测：mdls 元数据 + 文件大小兜底。永不 reject（拿不到元数据就只有 size）
function probeVideo(p) {
  return new Promise((resolve) => {
    const meta = { duration: null, width: null, height: null, bitrate: null, codec: '' };
    let size = 0;
    try { size = fs.statSync(p).size; } catch {}
    try {
      execFile('mdls', [
        '-name', 'kMDItemDurationSeconds', '-name', 'kMDItemPixelWidth',
        '-name', 'kMDItemPixelHeight', '-name', 'kMDItemTotalBitRate', '-name', 'kMDItemCodecs',
        p, // mdls 路径含中文/空格时 execFile 数组传参天然安全
      ], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        let m = meta;
        if (!err && stdout) { try { m = { ...meta, ...videoMetaFromMdlsOutput(stdout) }; } catch {} }
        resolve({ ...m, size, path: p });
      });
    } catch { resolve({ ...meta, size, path: p }); }
  });
}

module.exports = { VIDEO_EXTS, isVideoFile, formatDuration, videoMetaFromMdlsOutput, probeVideo };
