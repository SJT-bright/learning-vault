/**
 * docx ZIP 级媒体扫描（v0.9.2）
 *
 * 背景：mammoth 只把它认得的「行内图片」转成 data URI；浮动锚定图（wp:anchor）、
 * 文本框内图（w:txbxContent 里的 drawing）、组合形状内图、VML 老格式图
 * （w:pict / v:imagedata）、OLE 对象预览图、页眉页脚图都不经过它的转换管线，
 * 会整批静默丢失。这里直接读 docx（本质是 ZIP）做全量对账：
 *
 *   1. word/document.xml 按出现顺序收集全部图片引用：
 *      <a:blip r:embed="rIdX">（行内/锚定/文本框/组合形状一网打尽）
 *      <v:imagedata r:id / o:relid="rIdX">（VML 老格式）
 *   2. word/_rels/document.xml.rels 解析 rId → word/media/xx 目标（外链图跳过）
 *   3. 同一 <mc:AlternateContent> 里 Choice（DrawingML）/ Fallback（VML）双写
 *      同一目标 → 只保留首个（Word 只渲染其一，两个都出占位符会重复显示）
 *   4. word/media/ 全量清单：正文未引用的媒体（页眉页脚图、对象预览图）也能捞出
 *
 * 本模块只扫描不落盘；配合 extract.js 的内容哈希对账决定哪些算「mammoth 漏网」。
 * 纯函数 parseRelsXml / collectDocRefs 可被 selfcheck 直测。
 */
const JSZip = require('jszip');

// 容忍前缀重命名（w:/a:/v:/r: 等命名空间前缀理论上可被改写，按本地名匹配）
const BLIP_REF = /<(?:[A-Za-z0-9_.-]+:)?blip\b[^>]*?(?:[A-Za-z0-9_.-]+:)?embed\s*=\s*"([^"]+)"/g;
const VML_REF = /<(?:[A-Za-z0-9_.-]+:)?imagedata\b[^>]*?(?:[A-Za-z0-9_.-]+:)?(?:id|relid)\s*=\s*"([^"]+)"/g;

// rels 目标 → 包内完整路径：media/x.png → word/media/x.png（绝对/相对/URL 转义都归一）
function resolveTarget(t) {
  let s = String(t || '').replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch {}
  if (s.startsWith('/')) return s.slice(1);
  while (s.startsWith('../')) s = s.slice(3);
  return 'word/' + s;
}

// 解析关系表：仅图片类型、非外链。返回 Map<rId, 包内路径>
function parseRelsXml(xml) {
  const map = new Map();
  for (const m of String(xml || '').matchAll(/<(?:[A-Za-z0-9_.-]+:)?Relationship\b[^>]*>/g)) {
    const tag = m[0];
    if (!/Type="[^"]*\/image"/.test(tag)) continue;
    const id = (tag.match(/\b(?:[A-Za-z0-9_.-]+:)?Id="([^"]+)"/) || [])[1];
    const target = (tag.match(/\b(?:[A-Za-z0-9_.-]+:)?Target="([^"]+)"/) || [])[1];
    if (!id || !target) continue;
    if (/TargetMode\s*=\s*"External"/i.test(tag)) continue;
    map.set(id, resolveTarget(target));
  }
  return map;
}

// <mc:AlternateContent> 配对开闭（支持嵌套），返回 [start, endExclusive] 区间
function acSpansOf(xml) {
  const spans = [];
  const stack = [];
  const re = /<(\/?)(?:[A-Za-z0-9_.-]+:)?AlternateContent\b/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] === '/') { const s = stack.pop(); if (s !== undefined) spans.push([s, m.index]); }
    else stack.push(m.index);
  }
  return spans;
}

// 按文档顺序收集全部图片引用；AlternateContent 内 Choice/Fallback 双写的同目标只留首个
function collectDocRefs(docXml) {
  const refs = [];
  for (const re of [BLIP_REF, VML_REF]) {
    re.lastIndex = 0;
    for (const m of String(docXml || '').matchAll(re)) {
      refs.push({ rId: m[1], pos: m.index, vml: re === VML_REF });
    }
  }
  refs.sort((a, b) => a.pos - b.pos);
  if (!refs.length) return refs;
  const spans = acSpansOf(docXml);
  if (!spans.length) return refs;
  const dropped = new Set();
  for (const [s, e] of spans) {
    const seen = new Set();
    refs.forEach((r, i) => {
      if (r.pos < s || r.pos > e) return;
      if (seen.has(r.rId)) dropped.add(i);
      else seen.add(r.rId);
    });
  }
  return refs.filter((_, i) => !dropped.has(i));
}

// docx 媒体扩展名白名单（与 extract.js 落盘白名单一致；jpeg→jpg、tif→tiff 归一在 extract 侧）
const MEDIA_EXTS = new Set(['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'emf', 'wmf']);
function isMediaImage(entryPath) {
  const ext = entryPath.slice(entryPath.lastIndexOf('.') + 1).toLowerCase();
  return MEDIA_EXTS.has(ext);
}

// 扫描 docx 缓冲：refs（正文引用，文档序）/ rels（rId→包内路径）/ media（包内媒体清单，自然序）。
// getMedia(target) 懒读取媒体内容（nodebuffer，读不到返回 null）。任何失败都返回空结果，不抛错。
async function scanDocxMedia(buffer) {
  const out = { refs: [], rels: new Map(), media: [], getMedia: async () => null };
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { return out; }
  const readText = async (f) => { try { return (await zip.file(f).async('string')) || ''; } catch { return ''; } };
  const docXml = await readText('word/document.xml');
  if (!docXml) return out;
  out.rels = parseRelsXml(await readText('word/_rels/document.xml.rels'));
  out.refs = collectDocRefs(docXml);
  const media = [];
  const folder = zip.folder('word/media');
  if (folder) folder.forEach((relPath, f) => { if (!f.dir && isMediaImage('word/media/' + relPath)) media.push('word/media/' + relPath); });
  media.sort((a, b) => pathBase(a).localeCompare(pathBase(b), undefined, { numeric: true }));
  out.media = media;
  out.getMedia = async (target) => {
    try { return (await zip.file(target).async('nodebuffer')) || null; } catch { return null; }
  };
  return out;
}

function pathBase(p) { return p.slice(p.lastIndexOf('/') + 1); }

module.exports = { parseRelsXml, collectDocRefs, resolveTarget, scanDocxMedia, isMediaImage };
