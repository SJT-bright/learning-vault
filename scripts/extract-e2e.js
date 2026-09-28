/**
 * 富内容提取端到端验证（纯 Node，不依赖 Electron 运行时）
 * 前置：python3 scripts/make-fixture-docx.py /tmp/lv-fixture.docx
 * 验证不变量（对 mammoth 捕获哪些形态不敏感，只验收最终结果）：
 *   1. 一张不落：word/media 里每张图都落盘（含锚定/文本框/VML/双写/页眉形态）
 *   2. 1:1：每个落盘文件字节级等于包内对应媒体（哈希集合双射）
 *   3. 文档序：占位标记按 image1..image6 顺序出现，页眉图追加文末并带来源标注
 *   4. 正文干净：无 base64；标题层级与链接保留
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const JSZip = require('jszip');
const { extractDocxRich } = require('../src/extract');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  const fixture = '/tmp/lv-fixture.docx';
  if (!fs.existsSync(fixture)) {
    console.log('EXTRACT_E2E_FAIL 缺少夹具，先跑 python3 scripts/make-fixture-docx.py');
    process.exit(1);
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-extract-'));
  const fails = [];
  const must = (ok, msg) => { if (!ok) fails.push(msg); };
  try {
    // 包内真值：word/media 全量（文件名 → 哈希），按 imageN 自然序
    const zip = await JSZip.loadAsync(fs.readFileSync(fixture));
    const media = [];
    zip.folder('word/media').forEach((rel, f) => { if (!f.dir) media.push('word/media/' + rel); });
    media.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const hashByMedia = new Map();
    for (const m of media) hashByMedia.set(m, sha(await zip.file(m).async('nodebuffer')));
    const mediaByHash = new Map([...hashByMedia].map(([m, h]) => [h, m.slice(m.lastIndexOf('/') + 1)])); // 哈希 → imageN.png

    const r = await extractDocxRich(fixture, outDir);

    // ① 一张不落 + 落盘
    must(r.images.length === 7, `应提取 7 张图（实际 ${r.images.length}）`);
    const diskFiles = fs.readdirSync(outDir);
    must(diskFiles.length === 7, `落盘 7 个文件（实际 ${diskFiles.length}）`);
    must(new Set(r.images.map((i) => i.filename)).size === 7, '文件名全局唯一');

    // ② 1:1：落盘哈希集合 === 包内媒体哈希集合（双射，不多不少不改字节）
    const savedHash = new Set(diskFiles.map((f) => sha(fs.readFileSync(path.join(outDir, f)))));
    const wantHash = new Set(hashByMedia.values());
    must(savedHash.size === wantHash.size && [...wantHash].every((h) => savedHash.has(h)),
      '落盘文件与包内媒体字节级一致（1:1）');

    // ③ 标记：每张图恰好一个 [图N: 文件名]；无 base64
    must(!r.text.includes('base64'), '正文不含 base64');
    for (const img of r.images) {
      const hits = r.text.split(img.filename).length - 1;
      must(hits === 1, `每张图恰好一个占位标记（${img.filename} 出现 ${hits} 次）`);
    }
    const markCount = (r.text.match(/\[图\d+[:：]/g) || []).length;
    must(markCount === 7, `共 7 个占位标记（实际 ${markCount}）`);

    // ④ 文档序：image1..image6 标记位置严格递增；页眉图追加文末且带来源标注
    const textPos = {};
    for (const img of r.images) {
      const srcName = mediaByHash.get(sha(fs.readFileSync(img.file)));
      must(!!srcName, `落盘文件能对回包内媒体（${img.filename}）`);
      if (srcName) textPos[srcName] = r.text.indexOf(img.filename);
    }
    const seq = ['image1.png', 'image2.png', 'image3.png', 'image4.png', 'image5.png', 'image6.png'];
    for (let n = 1; n < seq.length; n++) {
      must(textPos[seq[n - 1]] >= 0 && textPos[seq[n]] > textPos[seq[n - 1]],
        `标记按文档序（${seq[n - 1]} 应在 ${seq[n]} 之前）`);
    }
    const notePos = r.text.indexOf('〔文档内嵌图片（页眉/页脚或对象预览，未在正文引用）〕');
    must(notePos > 0, '页眉图带来源标注');
    must(textPos['image7.png'] > notePos && textPos['image7.png'] > textPos['image6.png'], '页眉图标记在来源标注之后、正文图之后');

    // ⑤ 结构与叙事保留
    must(r.text.includes('# 验收文档：内嵌图片全形态'), 'H1 标题保留');
    for (const t of ['第一段', '第二段', '第三段：浮动锚定图', '第四段：文本框', '第五段：VML', '第六段：兼容写法']) {
      must(r.text.includes(t), `正文段落保留（${t}）`);
    }
    must(r.links.length === 1 && r.links[0].url === 'https://example.com/fixture', '文档内超链接收集');

    if (fails.length) {
      console.log('EXTRACT_E2E_FAIL ' + JSON.stringify(fails));
      process.exit(1);
    }
    console.log('EXTRACT_E2E_OK 7/7 内嵌图全形态（行内/锚定/文本框/VML/双写/页眉）1:1 落盘');
    process.exit(0);
  } catch (e) {
    console.log('EXTRACT_E2E_FAIL ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
})();
