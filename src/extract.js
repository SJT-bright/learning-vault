/**
 * 本地文件文本抽取：pdf / docx / doc / rtf / odt / txt / md / html / 代码
 *
 * Word 增强（v0.5）：
 * - docx 改走 mammoth convertToHtml：h1-h6 转成 Markdown 式「#」标题行，
 *   倒排索引的 extractSubheads 就能按章节名检索正文（原 rawText 会丢章节结构）
 * - 旧版 .doc / .rtf / .odt 用 macOS 自带 textutil 转 txt（零依赖），mammoth 失败时 docx 也降级走它
 *
 * 富内容提取（v0.5.2）：
 * - 文档里的图片不再丢弃：mammoth 把行内图片转成 data URI 嵌在 <img>，parseHtmlImages
 *   解码后由调用方落盘，正文替换为「[图N: 文件名]」占位（保持可读可检索），
 *   同时返回图片清单供详情页画廊展示 / 收为独立图片资产
 * - 文档里的超链接全量收集（parseHtmlLinks）：详情页「文档内链接」区可打开 / 一键收录
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { htmlToText } = require('./fetcher');
const { scanDocxMedia } = require('./docx-media');

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log', 'yml', 'yaml', 'html', 'htm',
  'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'java', 'c', 'cpp', 'h', 'rs', 'rb', 'php', 'sh', 'sql', 'css']);

// textutil 可转换的富文本格式（macOS 系统自带，无需安装）
const TEXTUTIL_EXTS = new Set(['doc', 'rtf', 'odt', 'docx', 'wpd', 'webarchive']);

// 图片 MIME → 扩展名（详情页 <img> 可显示的白名单；emf/wmf 等老格式照存但不保证可预览）
const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/x-emf': 'emf', 'image/x-wmf': 'wmf',
};

function extOf(p) { return path.extname(p).replace('.', '').toLowerCase(); }

// 把 mammoth 产出的 HTML 转成保留标题层级的纯文本：<h2>xxx</h2> → 「## xxx」
function htmlHeadedToText(html) {
  const headed = String(html || '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, inner) =>
      '\n' + '#'.repeat(Number(lv)) + ' ' + inner.replace(/<[^>]+>/g, '').trim() + '\n')
    .replace(/<\/(p|li|tr|blockquote)>/gi, '\n');
  return htmlToText(headed);
}

// macOS textutil → txt（promise；不可用/失败时抛错由调用方兜底）。
// execFile 数组参数形式、不经 shell；路径来自用户自己选择的本地文件。
function textutilToText(p) {
  return new Promise((resolve, reject) => {
    execFile('textutil', ['-convert', 'txt', '-stdout', p],
      { timeout: 20000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout || ''));
      });
  });
}

// ---------- 富内容提取（纯函数，selfcheck 直测） ----------
const IMG_DATA_URI = /<img[^>]+src=["']data:([^;"']+);base64,([A-Za-z0-9+/=\s]+)["'][^>]*>/gi;
const IMG_ANY_DATA_URI = /<img[^>]+src=["']data:[^;"']+;base64,[A-Za-z0-9+/=\s]+["'][^>]*>/gi;
const A_HREF = /<a[^>]+href=["'](https?:\/\/[^"'\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

// 提取 HTML 里全部 <img src="data:image/...;base64,....">：返回 [{mime, ext, buffer}]
// 非图片 / 非 data URI 的 <img> 一律跳过（外链图由链接提取通道处理）
function parseHtmlImages(html) {
  const out = [];
  for (const m of String(html || '').matchAll(IMG_DATA_URI)) {
    const mime = String(m[1] || '').toLowerCase();
    const ext = MIME_EXT[mime];
    if (!ext) continue;
    try {
      const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      if (buffer.length > 64) out.push({ mime, ext, buffer }); // <64B 视为占位噪声
    } catch {}
    if (out.length >= 200) break; // 单文档图片上限，防极端文件拖垮内存
  }
  return out;
}

// 提取 HTML 里全部 http(s) 超链接（去重保序，保留锚文本）：返回 [{url, text}]
function parseHtmlLinks(html) {
  const seen = new Set();
  const out = [];
  for (const m of String(html || '').matchAll(A_HREF)) {
    const url = m[1].replace(/&amp;/g, '&');
    if (seen.has(url)) continue;
    seen.add(url);
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    out.push({ url, text });
    if (out.length >= 100) break;
  }
  return out;
}

// 把 HTML 里的 data URI <img> 替换为「[图N: 文件名]」行内占位（N 按出现顺序）。
// 占位符留在正文原位 —— 渲染层按它在文本流中的位置把图片穿插回文章对应段落，
// 文件名全局唯一（含 sha256 前 6 位），多文件合并成文件包后依然能精确定位到图片。
function replaceImagesWithPlaceholders(html, images) {
  let i = 0;
  return String(html || '').replace(IMG_ANY_DATA_URI, () => {
    i += 1;
    const img = images[i - 1];
    return '\n[图' + i + ': ' + (img ? img.filename : '图片' + i) + ']\n';
  });
}

// 图片落盘：写入 outDir。文件名由本函数生成并走严格白名单，
// 拼接后校验仍在 outDir 根内（防任何形式的路径穿越）
const SAFE_IMG_NAME = /^img-\d{2,}-[a-f0-9]{6}\.(png|jpg|gif|webp|bmp|svg|tiff|emf|wmf)$/;
function saveExtractedImages(outDir, images, startIndex = 0) {
  const root = path.resolve(outDir);
  fs.mkdirSync(root, { recursive: true });
  return images.map((img, i) => {
    const hash = crypto.createHash('sha256').update(img.buffer).digest('hex').slice(0, 6);
    const filename = 'img-' + String(startIndex + i + 1).padStart(2, '0') + '-' + hash + '.' + img.ext;
    if (!SAFE_IMG_NAME.test(filename)) throw new Error('生成的图片文件名不在白名单内');
    const file = path.resolve(root, filename);
    if (!file.startsWith(root + path.sep)) throw new Error('图片落盘路径越界');
    fs.writeFileSync(file, img.buffer);
    return { file, name: '图' + (startIndex + i + 1), filename, size: img.buffer.length, mime: img.mime };
  });
}

// 媒体扩展名归一（jpeg/jpe/jfif→jpg、tif→tiff）+ 落盘白名单校验
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tiff: 'image/tiff', emf: 'image/x-emf', wmf: 'image/x-wmf' };
function normalizeMediaExt(entryPath) {
  let ext = entryPath.slice(entryPath.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpeg' || ext === 'jpe' || ext === 'jfif') ext = 'jpg';
  if (ext === 'tif') ext = 'tiff';
  return EXT_MIME[ext] ? ext : null;
}

const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 占位符按全文出现顺序重编号：渲染层按文件名对图，序号仅用于展示连续性
function renumberImgMarks(s) {
  let n = 0;
  return String(s || '').replace(/\[图(\d*)[:：]\s*([^\]\n]+?)\s*\]/g, (_, __, name) => {
    n += 1;
    return '[图' + n + ': ' + name + ']';
  });
}

// docx 完整链路（v0.9.2）：
// ① mammoth：行内图 → data URI 占位、标题结构、链接（原链路）
// ② ZIP 级媒体兜底：锚定/文本框/组合形状/VML/OLE 预览/页眉页脚图 —— 与 mammoth 产出
//    按内容哈希对账，漏网的一张不落；每个漏网引用按「前后最近的已捕获行内图」插回正文原位；
//    包内未被正文引用的媒体（页眉页脚/对象预览）追加文末并标注来源
// ③ mammoth 坏档：textutil 出文本，ZIP 级媒体照常兜底（图片不再随之丢失）
async function extractDocxRich(p, outDir) {
  const mammoth = require('mammoth');
  const raw = fs.readFileSync(p);
  let html = '';
  let links = [];
  let textutilText = '';
  try {
    const r = await mammoth.convertToHtml({ path: p });
    html = r.value || '';
    links = parseHtmlLinks(html);
  } catch {
    try { textutilText = await textutilToText(p); } catch {}
  }

  // ① 行内图（mammoth 产出，按 HTML 出现序）
  const inlineImgs = parseHtmlImages(html);
  let saved = [];
  if (inlineImgs.length && outDir) saved = saveExtractedImages(outDir, inlineImgs);
  const haveHashes = new Set(inlineImgs.map((i) => hashOf(i.buffer)));

  let finalHtml = html;
  if (outDir) {
    // ② ZIP 级兜底：逐引用对账
    const scan = await scanDocxMedia(raw);
    if (scan.refs.length || scan.media.length) {
      const bufCache = new Map();
      const hashCache = new Map();
      const bufOf = async (t) => {
        if (!bufCache.has(t)) bufCache.set(t, await scan.getMedia(t));
        return bufCache.get(t);
      };
      const hashOfT = async (t) => {
        if (!hashCache.has(t)) { const b = await bufOf(t); hashCache.set(t, b && b.length > 64 ? hashOf(b) : null); }
        return hashCache.get(t);
      };
      // 已捕获 = 引用目标哈希在 mammoth 产出里（序号与 data URI 顺序对齐）
      const capturedOrd = [];
      const missedRefs = [];
      for (const ref of scan.refs) {
        const target = scan.rels.get(ref.rId);
        if (!target) continue;
        const h = await hashOfT(target);
        if (!h) continue;
        if (haveHashes.has(h)) capturedOrd.push({ ref, target });
        else missedRefs.push({ ref, target, hash: h });
      }
      // 漏网图落盘（同目标只存一份），hash → 落盘条目
      const missHashSaved = new Map();
      const missImgs = [];
      for (const m of missedRefs) {
        if (missHashSaved.has(m.hash)) continue;
        const ext = normalizeMediaExt(m.target);
        if (!ext) continue;
        missImgs.push({ mime: EXT_MIME[ext], ext, buffer: await bufOf(m.target) });
        missHashSaved.set(m.hash, missImgs.length - 1);
      }
      const savedMissed = missImgs.length ? saveExtractedImages(outDir, missImgs, saved.length) : [];
      for (const [h, idx] of missHashSaved) missHashSaved.set(h, savedMissed[idx]);

      // 漏网占位符：锚到前后最近的已捕获行内图（data URI <img> 在 HTML 里的位置）
      const imgSpans = [];
      const reImg = /<img[^>]+src=["']data:[^"']+["'][^>]*>/g;
      let mm;
      while ((mm = reImg.exec(html))) imgSpans.push([mm.index, mm.index + mm[0].length]);
      const capturedOrdinalOf = (refPos) => {
        let k = -1;
        capturedOrd.forEach((c, i) => { if (c.ref.pos < refPos) k = i; });
        return k;
      };
      const inserts = []; // {at, order, mark} —— at: html 坐标；order: 引用序（同坐标按序拼接）
      missedRefs.forEach((m, order) => {
        const savedOne = missHashSaved.get(m.hash);
        if (!savedOne) return;
        const mark = '\n[图0: ' + savedOne.filename + ']\n';
        const k = capturedOrdinalOf(m.ref.pos);
        let at, atOrder = order;
        if (k >= 0 && imgSpans[k]) at = imgSpans[k][1];          // 插在前一张已捕获行内图之后
        else if (imgSpans.length) { at = imgSpans[0][0]; }        // 全在行内图之前 → 插首图前
        else { at = finalHtml.length; }                           // 无行内图 → 文末（重编号后仍按序）
        inserts.push({ at, order: atOrder, mark });
      });
      // 追加未引用媒体（页眉页脚/对象预览）
      const refTargets = new Set(scan.refs.map((r) => scan.rels.get(r.rId)).filter(Boolean));
      const extraImgs = [];
      const seenExtra = new Set();
      for (const t of scan.media) {
        if (refTargets.has(t)) continue;
        const b = await bufOf(t);
        if (!b || b.length <= 64) continue;
        const h = hashOf(b);
        if (haveHashes.has(h) || seenExtra.has(h)) continue;
        const ext = normalizeMediaExt(t);
        if (!ext) continue;
        seenExtra.add(h);
        extraImgs.push({ mime: EXT_MIME[ext], ext, buffer: b });
      }
      let savedExtra = [];
      if (extraImgs.length) {
        savedExtra = saveExtractedImages(outDir, extraImgs, saved.length + missImgs.length);
        const tail = savedExtra.map((x) => '[图0: ' + x.filename + ']\n').join('');
        inserts.push({ at: html.length, order: 1e9, mark: '\n〔文档内嵌图片（页眉/页脚或对象预览，未在正文引用）〕\n' + tail });
      }

      // 坐标降序应用插入（先算好坐标再动字符串，互不干扰）
      inserts.sort((a, b) => (b.at - a.at) || (b.order - a.order));
      let acc = html;
      for (const ins of inserts) acc = acc.slice(0, ins.at) + ins.mark + acc.slice(ins.at);
      finalHtml = acc;

      if (savedMissed.length || savedExtra.length) {
        saved = saved.concat(savedMissed, savedExtra);
      }
    }
  }

  // 行内 data URI <img> → 占位标记：必须在 ZIP 级插入应用之后做，两类标记才能按真实位置交错。
  // 漏网/追加标记先记「图0」，这里与行内标记一起按出现顺序重编号（saved 前段就是行内图，序号对齐）
  if (saved.length) {
    finalHtml = replaceImagesWithPlaceholders(finalHtml, saved);
    if (finalHtml.includes('[图0:')) finalHtml = renumberImgMarks(finalHtml);
  }

  // 正文文本：mammoth 结构优先；坏档时 textutil 文本 + 占位符拼合
  let text;
  if (textutilText) {
    text = textutilText.replace(/\s+$/, '') + (/\S/.test(finalHtml) ? '\n' + htmlHeadedToText(finalHtml) : '');
  } else {
    text = htmlHeadedToText(finalHtml);
  }
  return { text, images: saved, links };
}

async function extractFromFile(p, { imagesOutDir } = {}) {
  const ext = extOf(p);
  const name = path.basename(p);
  let text = '';
  let images = [];
  let links = [];
  try {
    if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(p);
      const r = await pdfParse(buf);
      text = r.text || '';
    } else if (ext === 'docx') {
      try {
        const rich = await extractDocxRich(p, imagesOutDir || '');
        text = rich.text;
        images = rich.images;
        links = rich.links;
        if (!text.trim()) text = (await require('mammoth').extractRawText({ path: p })).value || '';
      } catch (e) {
        text = await textutilToText(p); // mammoth 坏档降级：系统 textutil 再试一次
      }
    } else if (TEXTUTIL_EXTS.has(ext)) {
      text = await textutilToText(p);
    } else if (TEXT_EXTS.has(ext)) {
      const raw = fs.readFileSync(p, 'utf8');
      text = ext === 'html' || ext === 'htm' ? htmlToText(raw) : raw;
      if (ext === 'html' || ext === 'htm') links = parseHtmlLinks(raw);
    } else {
      text = '【该格式暂不支持全文提取，原文件已保存】';
    }
  } catch (e) {
    text = '【内容抽取失败：' + String(e && e.message ? e.message : e).slice(0, 120) + '，原文件已保存】';
  }
  return { text: text.slice(0, 120000), ext, name, images: images || [], links: links || [] };
}

// 正文里的行内图片占位标记（渲染层按它把图片穿插回文章原位）
// capture 1 = 序号 N（可空），capture 2 = 图片文件名
const IMG_MARK = /\[图(\d*)[:：]\s*([^\]\n]+?)\s*\]/g;

function makeTitleFromPath(p) {
  return path.basename(p, path.extname(p)).slice(0, 120) || path.basename(p);
}

module.exports = {
  extractFromFile, extOf, makeTitleFromPath, htmlHeadedToText, textutilToText,
  parseHtmlImages, parseHtmlLinks, replaceImagesWithPlaceholders, saveExtractedImages, extractDocxRich,
  IMG_MARK,
};
