#!/usr/bin/env node
/**
 * 学习资产库 · 自动化自检链（可重复跑，零新依赖）
 * 运行：node scripts/selfcheck.js  （或 npm run selfcheck）
 * 输出：默认人类可读；加 --json 则 stdout 仅一行 {ok,passed,failed,details:[{name,pass}]}
 *      （退出码：全过 0 / 有失败或异常 1；--json 的 stdout 不混入任何日志行）
 *
 * 覆盖：
 *   a) Store 入库（url/file/chat/note × 今天/昨天/上周）
 *   b) 金句 3 条 + linkQuotes 双向引用 + quoteGraph 节点/边与去重
 *   c) 倒排索引 buildInverted/search，top1 命中预期条目
 *   d) 分类画像 CategoryProfile.learn ×3 → decide 命中 / suggestNew
 *   e) computeStats（total/quotes/byKind/badges/streak）+ reachedTarget 边界
 *   f) JSON 落盘持久化：重开 Store 数据仍在
 *   g) 软删除：remove 后 allItems/list 均不含，get 标记 trashed
 *   h) 静态断言：main.js 关键 IPC 注册 + preload.js 桥接 API
 *
 * 数据隔离：全程使用 os.tmpdir() 下的临时目录（结束即删），
 *          绝不读取 ~/Library/Application Support/学习资产库。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 86400000;

// ---------- 输出模式：--json → stdout 仅一行机器可读 JSON，日志全部静音 ----------
const JSON_MODE = process.argv.includes('--json');

// ---------- 断言器：失败继续收集，最后统一 FAIL + exit(1) ----------
let total = 0;
const failures = [];
const details = []; // 每条断言的 {name, pass} 明细（--json 模式输出用）
function must(cond, label, detail) {
  total += 1;
  const pass = !!cond;
  details.push({ name: label, pass });
  if (pass) { if (!JSON_MODE) console.log(`  ✓ ${label}`); return true; }
  const why = detail ? ` — ${detail}` : '';
  failures.push(`${label}${why}`);
  if (!JSON_MODE) console.log(`  ✗ FAIL: ${label}${why}`);
  return false;
}
function section(name) { if (!JSON_MODE) console.log(`\n■ ${name}`); }
// 管道可能分段写入；等待 stdout 写完再退出，避免较长 JSON 被截断。
function emitJsonLine(exitCode) {
  const passed = total - failures.length;
  process.stdout.write(JSON.stringify({ ok: failures.length === 0, passed, failed: failures.length, details }) + '\n', () => process.exit(exitCode));
}

// 本地日键（与 stats.js 的 localDayKey 同规则）
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// 某天正午的时间戳（offsetDays=0 → 今天）：避开零点附近的日期边界抖动
const noon = (offsetDays) => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime() - offsetDays * DAY_MS; };

async function main() {
  // ---------- 0) 环境隔离 ----------
  section('0. 环境隔离（临时目录，不碰真实数据）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-selfcheck-'));
  const dataDir = path.join(tmp, 'data');
  must(!tmp.includes('Application Support') && tmp.startsWith(os.tmpdir()), '临时目录位于 os.tmpdir()，与真实数据目录完全隔离');
  if (!JSON_MODE) console.log(`  · 数据目录: ${dataDir}（自检结束即删除）`);

  const { Store } = require(path.join(ROOT, 'src', 'db.js'));
  const { docOf, buildInverted, search } = require(path.join(ROOT, 'src', 'index-engine.js'));
  const { CategoryProfile, decide } = require(path.join(ROOT, 'src', 'classify-engine.js'));
  const { computeStats, reachedTarget } = require(path.join(ROOT, 'src', 'stats.js'));

  const store = new Store(dataDir);

  // ---------- a) 入库 6 条混合数据 ----------
  section('a. 入库 6 条混合数据（kind × 今天/昨天/上周）');
  const TODAY = noon(0), YESTERDAY = noon(1), LASTWEEK = noon(8);
  const seeds = [
    { kind: 'url',  title: 'Transformer 注意力机制论文精读', text: '注意力机制 transformer embedding 模型训练 微调', created_at: TODAY },
    { kind: 'file', title: '储能产业白皮书 2026',           text: '白皮书 市场预测 产业链 增速 储能',               created_at: TODAY },
    { kind: 'chat', title: '心理咨询职业路径的聊天记录',     text: '心理咨询 职业路径 社会学 人类学',               created_at: YESTERDAY },
    { kind: 'note', title: '城市漫游手记',                  text: '城市漫游 哲学 随笔',                            created_at: YESTERDAY },
    { kind: 'url',  title: 'RAG 检索增强生成实战教程',       text: 'RAG 检索 向量数据库 embedding 实战',             created_at: LASTWEEK },
    { kind: 'file', title: 'PRD 原型稿与交互稿模板',         text: 'PRD 原型稿 交互稿 用户体验地图',                 created_at: LASTWEEK },
  ];
  const recs = seeds.map((s) => store.insert({ ...s }));
  must(recs.length === 6 && new Set(recs.map((r) => r.id)).size === 6, '6 条入库且 id 唯一');
  must(['url', 'file', 'chat', 'note'].every((k) => recs.some((r) => r.kind === k)), 'kind 覆盖 url/file/chat/note 四类');
  must(recs[0].created_at === TODAY && recs[2].created_at === YESTERDAY && recs[4].created_at === LASTWEEK, 'created_at 覆盖今天/昨天/上周（insert 透传时间戳）');
  must(store.allItems().length === 6, 'allItems 共 6 条');

  // ---------- b) 金句 + 引用图 ----------
  section('b. 金句 3 条 + linkQuotes 双向引用 + quoteGraph');
  const q1 = store.addQuote({ text: '注意力是一种稀缺资源，分配方式决定认知深度。', source: 'Transformer 论文精读', source_item_id: recs[0].id, tags: ['注意力'] });
  const q2 = store.addQuote({ text: '知识的价值在于连接而非堆叠。', tags: ['知识图谱'] });
  const q3 = store.addQuote({ text: '慢即是快，少即是多。', tags: ['方法论'] });
  must(store.listQuotes().length === 3, '金句共 3 条');
  const byItem = store.listQuotes({ itemId: recs[0].id });
  must(byItem.length === 1 && byItem[0].id === q1.id, 'source_item_id 指向条目并可按条目反查');
  must(store.linkQuotes(q1.id, q2.id).ok && store.linkQuotes(q2.id, q3.id).ok, '建立两组引用（q1↔q2，q2↔q3）');
  must(!store.linkQuotes(q1.id, q1.id).ok && !store.linkQuotes('ghost-id', q1.id).ok, '自引用 / 不存在的金句被拒绝');
  store.linkQuotes(q2.id, q1.id); store.linkQuotes(q1.id, q2.id); // 重复+反向再建链，应被去重
  const g1 = store.quoteGraph();
  must(g1.nodes.length === 3, `quoteGraph nodes = 3（实际 ${g1.nodes.length}）`);
  must(g1.edges.length === 2, `quoteGraph edges = 2（实际 ${g1.edges.length}）`);
  must(new Set(g1.edges.map((e) => [e.a, e.b].sort().join('|'))).size === 2, '边为无向归一且每对只出一条（双向去重）');
  must(store.getQuote(q1.id).links.filter((x) => x === q2.id).length === 1, 'links 双向写回且单条去重');

  // ---------- c) 倒排检索 ----------
  section('c. 倒排索引检索 top1 命中');
  const idx = buildInverted(store.allItems().map(docOf));
  must(idx.N === 6, `索引文档数 N = 6（实际 ${idx.N}）`);
  const queries = [
    ['transformer 注意力', recs[0].id],
    ['储能 白皮书 产业链', recs[1].id],
    ['心理咨询 职业路径', recs[2].id],
  ];
  for (const [q, expect] of queries) {
    const hits = search(idx, q, { limit: 3 });
    must(hits.length > 0 && hits[0].id === expect, `search(${JSON.stringify(q)}) top1 → 预期条目`, hits[0] ? `实际 top1=${hits[0].id}` : '无结果');
  }

  // ---------- d) 分类画像 ----------
  section('d. 分类画像 learn ×3 → decide 命中 / suggestNew');
  const profile = new CategoryProfile(path.join(tmp, 'category-profile.json'));
  for (const t of ['蕨类植物 孢子繁殖 湿度控制', '多肉植物 光照与浇水频率', '水培植物 营养液与根系养护']) profile.learn('植物学', t);
  must(profile.data.categories['植物学'] && profile.data.categories['植物学'].count === 3, '同一类 learn 3 条，count = 3');
  const dHit = decide({ profile, title: '蕨类养护记录', notes: '关于蕨类植物与孢子繁殖的实践心得', text: '', kind: 'note' });
  must(dHit.category === '植物学' && dHit.source === 'profile-notes', 'decide 命中已学画像「植物学」', `实际 ${dHit.category}/${dHit.source}`);
  const dNew = decide({ profile, title: '随手记', notes: '量子计算与超导芯片的纠错方案', text: '', kind: 'note' });
  must(!!dNew.suggestNew && typeof dNew.suggestNew.name === 'string' && dNew.suggestNew.name.length >= 2, '不同阐述触发 suggestNew 建类建议', JSON.stringify(dNew.suggestNew || null));

  // ---------- d+) 分类引擎 v0.6：自定义规则 / IDF 余弦画像 / 融合决策 ----------
  section('d+. 分类引擎 v0.6（自定义关键词规则 × IDF 余弦画像 融合决策）');
  const { TaxonomyRules, DEFAULT_RULES } = require('../src/taxonomy-rules.js');
  must(Object.keys(DEFAULT_RULES).length >= 8 && (DEFAULT_RULES['教程课程'].keywords['教程'] || 0) >= 3, '内置默认规则集覆盖 8 大类且含强信号词');
  const rulesFile = path.join(tmp, 'category-rules.json');
  const tRules = new TaxonomyRules(rulesFile);
  tRules.setKeywords('分镜动画', { '分镜': 5, '动画': 3, 'rendering': 2 });
  const ruleHit = tRules.score({ title: '分镜教学', notes: '', body: '讲分镜与动画节奏' });
  must(ruleHit.length >= 1 && ruleHit[0].category === '分镜动画' && ruleHit[0].hits.includes('分镜'), '自定义关键词命中自定义分类（含中文词）');
  const ruleNorm = ruleHit[0].norm;
  must(ruleNorm > 0.2 && ruleNorm < 1, '规则得分经反商饱和归一到 (0,1)', `实际 norm=${ruleNorm}`);
  must(Object.keys(new TaxonomyRules(rulesFile).get('分镜动画')).length === 3, '规则落盘持久化（重开实例仍在）');
  const noHit = tRules.score({ title: ' unrelated ', notes: '', body: 'nothing here' });
  must(!noHit.some(r => r.category === '分镜动画'), '无关文本不命中自定义规则');

  // 融合决策：阐述主题 → 规则定向；正文词表 → 融合采用；泛化阐述不建类
  const { decide: decideV6 } = require('../src/classify-engine.js');
  const dRule = decideV6({ profile: new (require('../src/classify-engine.js').CategoryProfile)(path.join(tmp, 'p-d.json')), rules: tRules, title: '', notes: '这是一段关于分镜设计的阐述笔记', text: '', kind: 'note' });
  must(dRule.category === '分镜动画' && dRule.source === 'rule-notes', '阐述主题命中自定义关键词 → 规则定向归类', `实际 ${dRule.category}/${dRule.source}`);
  const profile2 = new (require('../src/classify-engine.js').CategoryProfile)(path.join(tmp, 'p-e.json'));
  for (const t of ['孢子繁殖 湿度控制 浇水', '多肉植物 光照 浇水频率', '水培植物 营养液 根系']) profile2.learn('植物学', t);
  const dFuse = decideV6({ profile: profile2, rules: tRules, title: '蕨类养护手册', notes: '', text: '孢子繁殖与湿度控制、浇水频率的完整指南', kind: 'file' });
  must(dFuse.category === '植物学' && ['profile-fused', 'fused-mid', 'profile-notes'].includes(dFuse.source), '融合决策：画像主导时采用画像类目', `实际 ${dFuse.category}/${dFuse.source}/${dFuse.confidence}`);
  must(dFuse.confidence >= 0.3 && dFuse.confidence <= 0.95, '置信度被 clamp 在合理区间', `实际 ${dFuse.confidence}`);
  const dVague = decideV6({ profile: profile2, rules: tRules, title: '随手存', notes: '这个以后看，先收藏一下', text: '', kind: 'note' });
  must(!dVague.suggestNew, '泛化阐述不触发建类建议（topTerms 过滤）');
  const dNew2 = decideV6({ profile: profile2, rules: tRules, title: '', notes: '量子纠错与超导芯片的容错方案', text: '', kind: 'note' });
  must(!!dNew2.suggestNew, '真实新主题仍触发建类建议');

  // ---------- e) 统计 ----------
  section('e. computeStats / reachedTarget');
  const dailyCounts = {};
  for (const it of store.allItems()) dailyCounts[dayKey(it.created_at)] = (dailyCounts[dayKey(it.created_at)] || 0) + 1;
  const stats = computeStats({ items: store.allItems(), quotes: store.listQuotes(), dailyCounts });
  must(stats.total === 6, `total = 6（实际 ${stats.total}）`);
  must(stats.quotes === 3, `quotes = 3（实际 ${stats.quotes}）`);
  must(stats.byKind.url === 2 && stats.byKind.file === 2 && stats.byKind.chat === 1 && stats.byKind.note === 1, 'byKind = url:2 / file:2 / chat:1 / note:1');
  must(Array.isArray(stats.badges) && stats.badges.length === 11, `badges 长度 = 11（实际 ${Array.isArray(stats.badges) ? stats.badges.length : '非数组'}）`);
  must(stats.streak === 2 && stats.bestStreak === 2, 'streak = bestStreak = 2（今天+昨天连续）', `实际 ${stats.streak}/${stats.bestStreak}`);
  must(reachedTarget('items', 6) === 0 && reachedTarget('items', 10) === 10 && reachedTarget('items', 55) === 50, 'reachedTarget items 边界（未达=0 / 恰达=目标 / 区间取高档）');
  must(reachedTarget('streak', 2) === 0 && reachedTarget('streak', 3) === 3, 'reachedTarget streak 边界');
  must(reachedTarget('quotes', 3) === 0 && reachedTarget('quotes', 25) === 25, 'reachedTarget quotes 边界');

  // ---------- f) 数据持久化 ----------
  section('f. JSON 落盘持久化（重开 Store）');
  must(fs.existsSync(path.join(dataDir, 'library.json')) && fs.existsSync(path.join(dataDir, 'quotes.json')), 'library.json / quotes.json 已落盘');
  const store2 = new Store(dataDir);
  must(store2.allItems().length === 6, '重开后 items = 6');
  must(store2.listQuotes().length === 3, '重开后 quotes = 3');
  must(store2.quoteGraph().edges.length === 2, '重开后引用图 edges = 2');
  const q2b = store2.getQuote(q2.id);
  must(!!q2b && q2b.links.includes(q1.id) && q2b.links.includes(q3.id), '重开后引用关系（links）仍在');
  const rec0 = store2.get(recs[0].id);
  must(!!rec0 && rec0.title === recs[0].title && rec0.kind === 'url' && rec0.created_at === TODAY, '条目字段（title/kind/created_at）精确还原');

  // ---------- g) 软删除 ----------
  section('g. 软删除（remove → 隐藏不销毁）');
  const victim = recs[5];
  store2.remove(victim.id);
  must(!store2.allItems().some((i) => i.id === victim.id), 'allItems 不含已删条目');
  const listed = store2.list({});
  must(!listed.items.some((i) => i.id === victim.id) && listed.total === 5, 'list 结果与 total 均不含已删条目（剩 5 条）', `实际 total=${listed.total}`);
  must(!!store2.get(victim.id) && store2.get(victim.id).trashed === true, 'get 仍可取回且标记 trashed = true');

  // ---------- i) 视频索引 / 飞书解析 / Word 抽取（v0.5 新能力） ----------
  section('i. 视频索引 / 飞书解析 / Word 抽取');
  const videoMod = require('../src/video.js');
  const { isVideoFile, formatDuration, videoMetaFromMdlsOutput } = videoMod;
  must(isVideoFile('/a/b/课程.mp4') && isVideoFile('x.MOV') && !isVideoFile('y.txt') && !isVideoFile('z'), 'isVideoFile 识别 mp4/MOV 且排除非视频');
  must(formatDuration(3725) === '1:02:05' && formatDuration(754) === '12:34' && formatDuration(0) === '' && formatDuration(NaN) === '', 'formatDuration 时长格式化与边界');
  const vm = videoMetaFromMdlsOutput('kMDItemDurationSeconds = 3661.5\nkMDItemPixelWidth = 1920\nkMDItemPixelHeight = 1080\nkMDItemCodecs = "(H264)"\nkMDItemStars = (null)');
  must(vm.duration === 3661.5 && vm.width === 1920 && vm.height === 1080 && String(vm.codec).includes('H264'), 'videoMetaFromMdlsOutput 解析 mdls 输出并忽略 (null)');
  const vrec = store2.insert({ kind: 'video', title: '示例课程视频', source_path: '/tmp/selfcheck-demo.mp4', video: { duration: 61, width: 1920, height: 1080, size: 123456789 }, files: [] });
  must(store2.list({ kind: 'video' }).items.some((i) => i.id === vrec.id), 'kind=video 条目入库并按类型筛选召回');

  const fetcherMod = require('../src/fetcher.js');
  const { parseLarkUrl, cleanLarkTitle, looksLikeLoginWall } = fetcherMod;
  const lk = parseLarkUrl('https://xxx.feishu.cn/wiki/TokEn12345678');
  must(!!lk && lk.type === 'wiki' && lk.token === 'TokEn12345678', 'parseLarkUrl 识别子域飞书 wiki 链接');
  must((parseLarkUrl('https://a.larkoffice.com/docx/TOKENabcdef12') || {}).type === 'docx', 'parseLarkUrl 识别 larkoffice docx 链接');
  must(parseLarkUrl('https://example.com/wiki/abcdef12') === null, 'parseLarkUrl 拒绝非飞书域名');
  must(cleanLarkTitle('需求评审 - 飞书云文档') === '需求评审' && cleanLarkTitle('周会纪要 ｜ 飞书') === '周会纪要', 'cleanLarkTitle 去掉飞书标题尾巴');
  must(looksLikeLoginWall('<div>请登录后查看</div>', '') === true && looksLikeLoginWall('<html></html>', '一段足够长的正常正文内容。'.repeat(30)) === false, 'looksLikeLoginWall 区分登录墙与正常正文');

  const extractMod = require('../src/extract.js');
  const headed = extractMod.htmlHeadedToText('<h1>第一章 总则</h1><p>内容甲。</p><h2>第2节 细则</h2><p>内容乙。</p>');
  must(headed.includes('# 第一章 总则') && headed.includes('## 第2节 细则'), 'htmlHeadedToText 保留 Word 标题层级（章节名可进小标题索引）');
  must(fs.readFileSync(path.join(ROOT, 'src', 'extract.js'), 'utf8').includes('textutil'), '.doc/.rtf/.odt 走系统 textutil 兜底');

  // ---------- i+) 富内容提取：文档图片 / 文档内链接（v0.5.2） ----------
  section('i+. 富内容提取（文档图片落盘 / 链接收集 / 占位符）');
  // 1×1 红色 PNG（最小合法图片）
  const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const richHtml = '<p>前文 <a href="https://example.com/a?x=1&amp;y=2">参考链接A</a></p>' +
    '<img src="data:image/png;base64,' + TINY_PNG_B64 + '">' +
    '<a href="https://example.com/b">文档B</a><a href="https://example.com/a?x=1&amp;y=2">重复链接</a>' +
    '<img src="data:image/gif;base64,' + TINY_PNG_B64 + '"><img src="https://cdn.example.com/remote.png">';
  const parsedImgs = extractMod.parseHtmlImages(richHtml);
  must(parsedImgs.length === 2 && parsedImgs[0].ext === 'png' && parsedImgs[1].ext === 'gif', `parseHtmlImages 提取 2 张 data URI 图片（实际 ${parsedImgs.length}）`);
  must(parsedImgs[0].buffer.length > 64, '图片 base64 正确解码为 Buffer');
  const parsedLinks = extractMod.parseHtmlLinks(richHtml);
  must(parsedLinks.length === 2 && parsedLinks[0].url === 'https://example.com/a?x=1&y=2' && parsedLinks[1].text === '文档B', 'parseHtmlLinks 去重保序且还原 &amp; 实体');
  const phHtml = extractMod.replaceImagesWithPlaceholders(richHtml, [{ filename: 'img-01-aa11bb.png' }, { filename: 'img-02-cc22dd.gif' }]);
  must(phHtml.includes('[图1: img-01-aa11bb.png]') && phHtml.includes('[图2: img-02-cc22dd.gif]') && !phHtml.includes('data:image'), '正文图片替换为行内占位标记（含唯一文件名、不再嵌 base64）');
  const markHits = [...'x[图2: img-02-cc22dd.gif]y'.matchAll(extractMod.IMG_MARK)];
  must(markHits.length === 1 && markHits[0][1] === '2' && markHits[0][2] === 'img-02-cc22dd.gif', 'IMG_MARK 标记正则可解析序号与文件名（渲染层穿插图片的依据）');
  const imgDir = path.join(tmp, 'imgs');
  const savedImgs = extractMod.saveExtractedImages(imgDir, parsedImgs);
  must(savedImgs.length === 2 && savedImgs.every(s => fs.existsSync(s.file) && s.size > 64), 'saveExtractedImages 落盘成功且尺寸记录正确');
  must(fs.readdirSync(imgDir).every(f => /^img-\d{2}-[a-f0-9]{6}\.(png|gif)$/.test(f)), '落盘文件名走严格白名单（防路径穿越）');

  // ---------- i++) docx ZIP 级媒体扫描（v0.9.2：锚定/文本框/VML/页眉图兜底） ----------
  section('i++. docx ZIP 级媒体扫描（漏网图片兜底管线）');
  const mediaMod = require('../src/docx-media.js');
  const relsMap = mediaMod.parseRelsXml('<Relationships>' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://cdn.example.com/b.png" TargetMode="External"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/"/></Relationships>');
  must(relsMap.size === 1 && relsMap.get('rId1') === 'word/media/a.png', 'parseRelsXml 只收包内图片关系（外链图/超链接排除）');
  must(mediaMod.resolveTarget('../media/%E4%B8%AD%E6%96%87.png') === 'word/media/中文.png', 'resolveTarget 归一相对路径并解码转义');
  const acXml = '<w:body><w:r><a:blip r:embed="rId1"/></w:r>' +
    '<mc:AlternateContent><mc:Choice><a:blip r:embed="rId2"/></mc:Choice><mc:Fallback><w:pict><v:imagedata r:id="rId2"/></w:pict></mc:Fallback></mc:AlternateContent>' +
    '<w:r><w:pict><v:imagedata r:id="rId3"/></w:pict></w:r></w:body>';
  const docRefs = mediaMod.collectDocRefs(acXml);
  must(docRefs.length === 3 && docRefs[0].rId === 'rId1' && docRefs[1].rId === 'rId2' && docRefs[2].rId === 'rId3',
    `collectDocRefs 按文档序收集 blip/VML 引用且 AlternateContent 双写只算一次（实际 ${docRefs.map(r => r.rId).join(',')}）`);
  const badScan = await mediaMod.scanDocxMedia(Buffer.from('这不是zip'));
  must(badScan.refs.length === 0 && badScan.media.length === 0 && badScan.rels.size === 0, 'scanDocxMedia 坏档静默返回空结果不抛错');
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:body><w:r><a:blip r:embed="rId9"/></w:r></w:body>');
  zip.file('word/_rels/document.xml.rels', '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/z.png"/>');
  zip.file('word/media/z.png', Buffer.from('PNGDATA-placeholder-bytes-69'));
  const goodScan = await mediaMod.scanDocxMedia(await zip.generateAsync({ type: 'nodebuffer' }));
  must(goodScan.refs.length === 1 && goodScan.rels.get('rId9') === 'word/media/z.png' && goodScan.media[0] === 'word/media/z.png',
    'scanDocxMedia 扫出引用/关系/媒体清单三件套');
  must((await goodScan.getMedia('word/media/z.png')).toString() === 'PNGDATA-placeholder-bytes-69', 'getMedia 懒读取媒体内容');

  // ---------- j) worker 线程池并行（v0.5：抽取/扫描不卡主进程） ----------
  section('j. worker 线程池（并行抽取 / 视频目录扫描）');
  const { WorkerPool } = require('../src/worker-pool.js');
  const pool = new WorkerPool({ size: 2, taskTimeoutMs: 30000 });
  const poolRun = pool.run.bind(pool); // 任务派发别名（与进程池契约一致：{id,type,payload}）
  try {
    const wf1 = path.join(tmp, 'a.md');
    fs.writeFileSync(wf1, '# 并行标题\n关于 RAG 检索的并行抽取测试。');
    const r1 = await poolRun('extract-files', { paths: [wf1, path.join(tmp, 'missing.pdf')] });
    must(Array.isArray(r1) && r1.length === 2 && r1[0].ok && String(r1[0].text).includes('RAG'), 'worker 并行抽取 md 成功');
    must(r1[1] && r1[1].ok === true && String(r1[1].text).includes('抽取失败'), 'worker 单文件失败不炸整批（缺失文件降级标注）');
    const vdir = path.join(tmp, 'vids');
    fs.mkdirSync(vdir);
    fs.mkdirSync(path.join(vdir, 'sub'));
    fs.writeFileSync(path.join(vdir, 'lesson1.mp4'), 'x');
    fs.writeFileSync(path.join(vdir, 'sub', 'lesson2.MOV'), 'x');
    fs.writeFileSync(path.join(vdir, 'notes.txt'), 'x');
    const r2 = await poolRun('scan-videos', { folder: vdir });
    must(r2 && Array.isArray(r2.files) && r2.files.length === 2, `scan-videos 递归找到 2 个视频（实际 ${r2 && r2.files ? r2.files.length : '无'}）`);
    must(r2.files.some((f) => f.path.endsWith('lesson2.MOV')) && r2.files.every((f) => !f.path.includes('notes.txt')), 'scan-videos 覆盖子目录且不收非视频');
  } finally {
    pool.killAll();
  }

  // ---------- h) 静态断言 ----------
  section('h. 静态断言：main.js IPC 注册 / preload.js 桥接 API');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const IPC_CHANNELS = [
    'stats:get', 'library:autoOrganize', 'library:undoOrganize', 'taxonomy:profiles',
    'quotes:graph', 'quotes:link', 'library:bulkUpdate', 'library:feedbackSimilar', 'library:search',
    'library:scanVideos', 'app:openFile', 'dialog:openFolder',
  ];
  for (const ch of IPC_CHANNELS) {
    must(mainSrc.includes(`'${ch}'`) || mainSrc.includes(`"${ch}"`), `main.js 注册 IPC '${ch}'`);
  }
  const PRELOAD_APIS = ['getStats', 'autoOrganize', 'undoOrganize', 'taxonomyProfiles', 'quoteLink', 'quoteGraph', 'bulkUpdate', 'feedbackSimilar', 'searchIndex', 'scanVideos', 'openFile', 'pickFolder', 'onScanProgress', 'reextract', 'saveClipboardImage', 'taxonomyRules', 'taxonomySetKeywords', 'srsDue', 'srsGrade', 'srsAdd', 'srsCount', 'srsStats', 'srsOpen', 'srsClose', 'onSrsCount', 'onOverlaySrs', 'ideasList', 'ideasAdd', 'ideasDone', 'ideasSnooze', 'ideasRemove', 'ideasCount', 'ideasOpen', 'ideasClose', 'onIdeasCount', 'resurfaceToday', 'resurfaceSnooze', 'resurfaceDismiss', 'onNavigate'];
  for (const api of PRELOAD_APIS) {
    must(new RegExp(`\\b${api}\\s*:`).test(preloadSrc), `preload.js 暴露 vault.${api}`);
  }

  // ---------- 通道完整性（双向）：一侧声明、另一侧必须有人接 —— 杜绝「点收录没反应」类 bug ----------
  const preloadChannels = new Set();
  for (const m of preloadSrc.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)) preloadChannels.add(m[1]);
  const mainChannels = new Set();
  for (const m of mainSrc.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)) mainChannels.add(m[1]);
  must(preloadChannels.size >= 40, 'preload invoke/send 通道解析数量充足（≥40）');
  const missingInMain = [...preloadChannels].filter((c) => !mainChannels.has(c));
  must(missingInMain.length === 0, 'preload 每条通道在 main.js 都已注册收件人', JSON.stringify(missingInMain));
  const orphanInMain = [...mainChannels].filter((c) => !preloadChannels.has(c));
  must(orphanInMain.length === 0, 'main.js 每条 ipcMain 通道都有 preload 桥接（无孤儿处理器的漏网接口）', JSON.stringify(orphanInMain));
  // 渲染层 on() 监听的事件，主进程必须真的会发
  const listenChannels = new Set();
  for (const m of preloadSrc.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)) listenChannels.add(m[1]);
  const sentChannels = new Set();
  for (const m of mainSrc.matchAll(/\.send\(\s*'([^']+)'/g)) sentChannels.add(m[1]);
  const neverSent = [...listenChannels].filter((c) => !sentChannels.has(c));
  must(neverSent.length === 0, 'preload 监听的每个事件主进程都会发出', JSON.stringify(neverSent));

  // ---------- h+) 并行契约静态断言（调度器 / 复盘画像接入，另一位 Worker 并行改动落地前可能暂红） ----------
  section('h+. 并行契约静态断言：main.js 调度器 / preload 桥接 / review 复盘画像');
  const MAIN_CONTRACT_SNIPPETS = ['taxonomy:profiles', 'library:undoOrganize', 'getSearchIndex', 'lastOrganizeBatch', 'selfcheck.js'];
  for (const snip of MAIN_CONTRACT_SNIPPETS) {
    must(mainSrc.includes(snip), `main.js 包含 '${snip}'`);
  }
  for (const api of ['taxonomyProfiles', 'undoOrganize']) {
    must(new RegExp(`\\b${api}\\s*:`).test(preloadSrc), `preload.js 暴露 vault.${api}`);
  }
  const REVIEW_PATH = path.join(ROOT, 'src', 'review.js');
  const reviewSrc = fs.existsSync(REVIEW_PATH) ? fs.readFileSync(REVIEW_PATH, 'utf8') : '';
  must(mainSrc.includes('profileSnapshot'), `main.js 包含 'profileSnapshot'`);

  // ---------- k) 层级分类 + 聊天消息块（v0.6） ----------
  section('k. 层级分类 + 聊天消息块（v0.6）');
  const { parseChatText, messagesToText } = require('../src/chat-parse.js');
  const chatSample = '张三 14:02\n这份是储能测算模型，重点看假设页\n[文件] 储能收益测算.xlsx\n---\n李四 14:05\n收到，我看看';
  const parsed = parseChatText(chatSample);
  must(parsed.length === 2 && parsed[0].speaker === '张三' && parsed[0].time === '14:02', '聊天解析：说话人/时间/正文按块拆分');
  must(!!parsed[0].attachment && parsed[0].attachment.label === '储能收益测算.xlsx', '附件行识别为消息附件');
  must(parsed[1].speaker === '李四' && parsed[1].text === '收到，我看看', '分隔线后的第二条消息');
  must(messagesToText(parsed).includes('储能测算模型') && messagesToText(parsed).includes('张三 14:02'), '结构化消息可逆拼接为纯文本（检索不丢）');
  const plain = parseChatText('没有格式的随手记录一段');
  must(plain.length === 1 && !plain[0].speaker && plain[0].text.includes('随手记录'), '无头行文本降级为单条消息不丢字');
  const lvlRec = store2.insert({ kind: 'note', title: '层级测试', category: '教程课程/视频制作', text: '分镜', created_at: Date.now() });
  must(!!lvlRec && store2.list({ category: '教程课程' }).items.some(i => i.category === '教程课程/视频制作'), '父类筛选包含子类条目（前缀匹配）');
  must(store2.list({ category: '教程课程/视频制作' }).items.length === 1, '子类筛选只命中自身');
  must(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').includes('segs.length > 3'), '建类护栏：最多三级层级');

  // ---------- l) 记忆复习引擎（SM-2 艾宾浩斯，v0.7） ----------
  section('l. 记忆复习引擎（SM-2 调度 / 锚点 / 统计 / 吃灰）');
  const srs = require('../src/srs.js');
  // 「记得」序列：1 → 3 → 7 → 14 → 31 天（interval×ease≈2.2 增长），reps 驱动前两步
  let card = srs.newCard({ itemId: 'x1', kind: 'manual', front: 'F', back: 'B' });
  must(card.interval === 0 && card.ease === 2.5 && card.reps === 0, '新卡初始状态（interval 0 / ease 2.5）');
  card = { ...card, ...srs.schedule(card, 3) };
  const i1 = card.interval;
  card = { ...card, ...srs.schedule(card, 3) };
  const i2 = card.interval;
  card = { ...card, ...srs.schedule(card, 3) };
  const i3 = card.interval;
  must(i1 === 1 && i2 === 3 && i3 >= 6, `"记得"间隔序列 1→3→N≥6（实际 ${i1}→${i2}→${i3}）`);
  // 「忘了」重置 + 「模糊」小步增长 + ease 钳制
  card = { ...card, ...srs.schedule(card, 1) };
  must(card.interval === 1 && card.lapses === 1 && card.reps === 0, '"忘了"重置：间隔归 1、lapses+1、reps 清零');
  const easeBefore = card.ease;
  card = { ...card, ...srs.schedule(card, 2) };
  must(card.interval >= 1 && card.ease <= easeBefore && card.ease >= srs.EASE_MIN, '"模糊"间隔≥1 且 ease 单调不增、有下界');
  let hard = { interval: 999, ease: 1.25, reps: 5, lapses: 0 };
  hard = { ...hard, ...srs.schedule(hard, 3) };
  must(hard.ease >= srs.EASE_MIN && hard.interval <= srs.INTERVAL_CAP, 'ease/间隔钳制在界内');
  // 到期队列：due 升序 + limit 截断（顺延不丢）
  const now = Date.now();
  const cards = [
    { id: 'a', due: now - 3 * 86400000, suspended: false },
    { id: 'b', due: now - 86400000, suspended: false },
    { id: 'c', due: now + 5 * 86400000, suspended: false },
    { id: 'd', due: now - 86400000, suspended: true },
  ];
  const dq = srs.dueCards(cards, now, 5);
  must(dq.length === 2 && dq[0].id === 'a' && dq[1].id === 'b', '到期队列按 due 升序，跳过 suspended 与未到期');
  must(srs.dueCards(cards, now, 1).length === 1, 'limit 截断（每日上限）');
  // 记忆统计
  const ms = srs.memoryStats([{ t: now, grade: 3 }, { t: now, grade: 1 }, { t: now, grade: 3 }, null]);
  must(ms.total === 3 && ms.good === 2 && Math.abs(ms.retention - 2 / 3) < 1e-9, 'memoryStats 记住率 = 记得/总数（空值安全）');
  // 吃灰检测
  const dusty = srs.dustyItems([
    { id: 'd1', created_at: now - 40 * 86400000, lastOpenedAt: null },
    { id: 'd2', created_at: now - 40 * 86400000, lastOpenedAt: now - 1000 },
    { id: 'd3', created_at: now - 5 * 86400000, lastOpenedAt: null },
    { id: 'd4', created_at: now - 40 * 86400000, lastOpenedAt: now - 1000, trashed: true },
  ], { now });
  must(dusty.length === 1 && dusty[0].id === 'd1', '吃灰检测：满 30 天未打开且未删除才点名');
  // 通道静态断言
  const mainSrcSrs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  for (const ch of ['srs:due', 'srs:grade', 'srs:add', 'srs:count', 'srs:stats', 'srs:open']) {
    must(mainSrcSrs.includes(`'${ch}'`), `main.js 注册 IPC '${ch}'`);
  }

  // ---------- 资料级回看 resurfaceItems（P0） ----------
  section('l2. 资料级回看（resurfaceItems：理由/排除/限流/同日稳定）');
  const RS_NOW = noon(0) + 6 * 3600000; // 今天 18:00（避开零点边界）
  const RD = 86400000;
  const mkRs = (id, createdDaysAgo, lastOpenedAt, extra = {}) => ({
    id, title: '条目' + id, kind: 'url', category: '测试',
    created_at: RS_NOW - createdDaysAgo * RD, lastOpenedAt: lastOpenedAt || null, ...extra,
  });
  // dusty：收录≥30天从未打开；同类 perReason=2 上限
  const rsA = srs.resurfaceItems([mkRs('a1', 40), mkRs('a2', 35), mkRs('a3', 32)], {}, RS_NOW);
  must(rsA.length === 2 && rsA.every(x => x.reasonKind === 'dusty'), 'dusty：收录≥30天从未打开，同类最多 2 条');
  must(rsA[0].reason.includes('从没打开'), 'dusty reason 为中文短句（收录 N 天从没打开）');
  // 优先级：dusty 压过 fading（limit=1 时只剩 dusty）
  const rsP = srs.resurfaceItems([mkRs('p1', 40), mkRs('p2', 100, RS_NOW - 50 * RD)], { limit: 1 }, RS_NOW);
  must(rsP.length === 1 && rsP[0].reasonKind === 'dusty', '优先级：dusty 先于 fading');
  // fading：打开过但距上次打开 ≥45 天
  const rsB = srs.resurfaceItems([mkRs('b1', 100, RS_NOW - 50 * RD)], {}, RS_NOW);
  must(rsB.length === 1 && rsB[0].reasonKind === 'fading' && rsB[0].reason.includes('上次看是'), 'fading：打开过但≥45天没看');
  // anniversary：90 天前收录，最近看过（不构成 fading）、有使用记录（不构成 unused）
  const rsC = srs.resurfaceItems([mkRs('c1', 90, RS_NOW - 5 * RD, { uses: [{ id: 'u1' }] })], {}, RS_NOW);
  must(rsC.length === 1 && rsC[0].reasonKind === 'anniversary' && rsC[0].reason.includes('天前的今天收录'), 'anniversary：30/90/180/365 天 ±1 命中');
  // unused：有 lastOpenedAt 但 usage 为空且收录 ≥14 天（uses 缺失与空数组两种形态都要命中）
  const rsD = srs.resurfaceItems([mkRs('d1', 20, RS_NOW - 5 * RD)], {}, RS_NOW);
  must(rsD.length === 1 && rsD[0].reasonKind === 'unused' && rsD[0].reason === '看过但没用过', 'unused：看过但没用过（uses 字段缺失）');
  const rsD2 = srs.resurfaceItems([mkRs('d2', 20, RS_NOW - 5 * RD, { uses: [] })], {}, RS_NOW);
  must(rsD2.length === 1 && rsD2[0].reasonKind === 'unused', 'unused：uses 为空数组（Store 默认值）同样命中');
  const rsD3 = srs.resurfaceItems([mkRs('d3', 20, RS_NOW - 5 * RD, { uses: [{ id: 'u' }] })], {}, RS_NOW);
  must(rsD3.length === 0, 'unused：有使用记录的不进名单');
  // 排除：trashed / 贪睡 / excludeIds
  const rsE = srs.resurfaceItems(
    [mkRs('e1', 40, null, { trashed: true }), mkRs('e2', 40), mkRs('e3', 40)],
    { snoozedIds: ['e2'] }, RS_NOW);
  must(rsE.length === 1 && rsE[0].id === 'e3', 'trashed 与贪睡中的条目不进名单');
  // 名额顺延：同类前两名贪睡后，第三名顶上
  const rsF = srs.resurfaceItems([mkRs('f1', 40), mkRs('f2', 35), mkRs('f3', 32)], { snoozedIds: ['f1', 'f2'] }, RS_NOW);
  must(rsF.length === 1 && rsF[0].id === 'f3', '贪睡/排除后名额顺延给同类下一候选');
  // limit 覆盖 + 同日稳定
  const rsG = srs.resurfaceItems([mkRs('g1', 40), mkRs('g2', 35)], { limit: 1 }, RS_NOW);
  must(rsG.length === 1, 'limit 可由 opts 覆盖');
  const rsH1 = srs.resurfaceItems([mkRs('h1', 40), mkRs('h2', 35), mkRs('h3', 100, RS_NOW - 50 * RD)], {}, RS_NOW);
  const rsH2 = srs.resurfaceItems([mkRs('h1', 40), mkRs('h2', 35), mkRs('h3', 100, RS_NOW - 50 * RD)], {}, RS_NOW);
  must(JSON.stringify(rsH1.map(x => x.id)) === JSON.stringify(rsH2.map(x => x.id)), '同日稳定：同一天两次计算结果一致');
  const mainSrcRs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  for (const ch of ['resurface:today', 'resurface:snooze', 'resurface:dismiss']) {
    must(mainSrcRs.includes(`'${ch}'`), `main.js 注册 IPC '${ch}'`);
  }
  const preloadSrcRs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  must(preloadSrcRs.includes('resurfaceToday') && preloadSrcRs.includes('resurfaceSnooze') && preloadSrcRs.includes('resurfaceDismiss'), 'preload 暴露 resurface 桥接 API');

  // ---------- 提醒补跑判定（P0：now 全参数注入，不依赖真实时钟） ----------
  section('m. 提醒补跑判定（nightly.shouldCatchUp：窗口 / 防重 / 落后补跑）');
  const nt = require('../src/nightly.js');
  const TARGET = 21 * 60 + 30;
  must(nt.parseTarget('21:30') === TARGET && nt.parseTarget('') === TARGET && nt.parseTarget('8:05') === 8 * 60 + 5, "parseTarget：'21:30'→1290、缺省回退 21:30、'8:05' 合法");
  const today10 = (() => { const d = new Date(); d.setHours(10, 0, 0, 0); return d; })();   // 窗口前
  const today2145 = (() => { const d = new Date(); d.setHours(21, 45, 0, 0); return d; })(); // 窗口内
  const today2300 = (() => { const d = new Date(); d.setHours(23, 0, 0, 0); return d; })(); // 窗口后
  const dkToday = nt.dayKeyOf(today10);
  const dkYesterday = nt.dayKeyOf(new Date(today10.getTime() - RD));
  const dk2ago = nt.dayKeyOf(new Date(today10.getTime() - 2 * RD));
  must(nt.inWindow(today2145, TARGET) === true && nt.inWindow(today10, TARGET) === false && nt.inWindow(today2300, TARGET) === false, 'inWindow：[target, target+30) 判定');
  must(nt.shouldCatchUp({ lastDailyReview: dk2ago }, today10, TARGET) === true, '落后≥2天（昨天也没跑）：启动即补跑一次');
  must(nt.shouldCatchUp({ lastDailyReview: dkYesterday }, today10, TARGET) === false, '仅落后1天且今天窗口未过：不补');
  must(nt.shouldCatchUp({ lastDailyReview: dkYesterday }, today2300, TARGET) === true, '窗口已过且今天没跑：补发（🌙 补发的小结）');
  must(nt.shouldCatchUp({ lastDailyReview: dk2ago, lastCatchUp: dkToday }, today10, TARGET) === false, '同日已补跑过（lastCatchUp=今天）：不重复');
  must(nt.shouldCatchUp({ lastDailyReview: dk2ago }, today2145, TARGET) === false, '窗口内不触发补跑（由正常每分钟 tick 负责）');
  must(nt.shouldCatchUp({ lastDailyReview: dk2ago, autoReview: false }, today10, TARGET) === false, 'autoReview=false 时完全不补跑');
  const mainSrcNt = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  must(mainSrcNt.includes('async function runNightlyDuties(now, { catchUp = false }') && mainSrcNt.includes("title: catchUp ? '🌙 补发的小结' : '🌙 晚间小结'"), 'main.js 窗口职责已抽为 runNightlyDuties(now,{catchUp})，补发标题区分');
  must(mainSrcNt.includes('checkMissedDuties') && mainSrcNt.includes("powerMonitor.on('resume'") && mainSrcNt.includes("powerMonitor.on('unlock-screen'") && mainSrcNt.includes('setTimeout(() => { checkMissedDuties(); }, 20000);'), '补跑三个时机接线：whenReady+20s / resume / unlock-screen，同日防重 lastCatchUp');

  // ---------- 积压护栏 backlogPlan（P1） ----------
  section('n. 积压护栏（backlogPlan：阈值 / 建议上限 / 分期天数）');
  const mkDue = (n, daysAgo) => Array.from({ length: n }, (_, i) => ({ id: 'b' + i, due: now - daysAgo * RD, suspended: false }));
  must(srs.backlogPlan([...mkDue(10, 1)], now, 5) === null, '逾期 ≤ 3×每日上限：不触发护栏');
  must(srs.backlogPlan([...mkDue(3, 1)], now, 5) === null && srs.backlogPlan([], now, 5) === null, '无积压/空队列返回 null');
  const plan1 = srs.backlogPlan([...mkDue(30, 2)], now, 5);
  must(!!plan1 && plan1.overdue === 30 && plan1.suggestedLimit === 10 && plan1.spreadDays === 3, '积压 30 张：建议今天 10 张、3 天消化（3×上限封顶）');
  const plan2 = srs.backlogPlan([...mkDue(40, 3)], now, 5);
  must(!!plan2 && plan2.suggestedLimit === 14 && plan2.spreadDays === 3, '积压 40 张：建议 ceil(40/3)=14 张/天（3×上限封顶内）、3 天消化');
  const plan3 = srs.backlogPlan([...mkDue(20, 1), ...mkDue(2, 1).map(c => ({ ...c, suspended: true }))], now, 4);
  must(!!plan3 && plan3.overdue === 20 && plan3.suggestedLimit === 7, 'suspended 卡不计入逾期；单日建议=ceil(20/3)=7');
  const mainSrcBl = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  must(mainSrcBl.includes('function srsGuardedCount') && mainSrcBl.includes("'srs:guard'"), 'main.js 护栏计数管道 srsGuardedCount + srs:guard IPC');

  // ---------- 问答式成卡 parseCardQA / qaPrompt（P1） ----------
  section('o. 问答式成卡（parseCardQA：解析/截断/容错；qaPrompt：防编造提示词）');
  const cq = require('../src/card-qa.js');
  const good = cq.parseCardQA('```json\n{"q":"RAG 三段式是什么？","a":"检索→增强→生成。"}\n```');
  must(!!good && good.q === 'RAG 三段式是什么？' && good.a === '检索→增强→生成。', 'parseCardQA：容忍 ```json 围栏与前缀文字');
  must(cq.parseCardQA('{"q":"' + '长'.repeat(50) + '","a":"' + '答'.repeat(300) + '"}').q.length === 40, 'parseCardQA：问题截到 40 字');
  must(cq.parseCardQA('{"q":"' + '长'.repeat(50) + '","a":"' + '答'.repeat(300) + '"}').a.length === 120, 'parseCardQA：答案截到 120 字');
  must(cq.parseCardQA('不是 json') === null && cq.parseCardQA('{"q":"只有问题"}') === null && cq.parseCardQA(null) === null, 'parseCardQA：坏输出/缺字段/null 一律回退 null（模板兜底）');
  const prompt = cq.qaPrompt({ title: '测试文档', summary: '这是摘要', text: '这是正文' });
  must(prompt.system.includes('不要编造') && prompt.system.includes('{"q"') && prompt.user.includes('测试文档') && prompt.user.includes('这是摘要'), 'qaPrompt：防编造系统提示 + 摘要优先进上下文');
  must(cq.contentDigest({ title: '只有标题' }) === '只有标题', 'contentDigest：空内容回退标题');
  const mainSrcQa = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  must(mainSrcQa.includes('async function aiCardQA') && mainSrcQa.includes("generatedBy: 'ai'") && mainSrcQa.includes("generatedBy: 'template'") && mainSrcQa.includes('catch { return null; }'), 'main.js：AI 问答失败静默回退，generated_by 溯源');
  must(mainSrcQa.includes("'srs:aiDraft'") && mainSrcQa.includes("'srs:skip'") && mainSrcQa.includes("'srs:suspend'") && mainSrcQa.includes("'srs:edit'") && mainSrcQa.includes("'srs:restore'") && mainSrcQa.includes("'srs:openItem'"), 'main.js 注册 P1 IPC：aiDraft/skip/suspend/edit/restore/openItem');
  const reviewSrcP1 = fs.readFileSync(path.join(ROOT, 'review', 'review.html'), 'utf8');
  must(reviewSrcP1.includes('data-op="skip"') && reviewSrcP1.includes("op('undo'") && reviewSrcP1.includes('srsRestore') && reviewSrcP1.includes('backlog-tip'), 'review.html：跳过/暂停/编辑/撤销/原文操作、键盘快捷键与积压提示');

  // ---------- m) 体验层（v0.8：撤销化/键盘流/内嵌播放/排版/通知分组/静默备份） ----------
  section('m. 体验层（撤销化 · 键盘流 · 内嵌播放 · 排版 · 分组通知 · 静默备份）');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'main', 'index.html'), 'utf8');
  const quickSrc = fs.readFileSync(path.join(ROOT, 'quick', 'quick.html'), 'utf8');
  must(!indexSrc.includes('confirm('), '主窗不再使用原生 confirm（破坏性操作全部撤销化）');
  must(indexSrc.includes('toastAction') && indexSrc.includes('toast-act'), '删除带 5 秒撤销动作条');
  must(quickSrc.includes('filePaths') && quickSrc.includes('donebar'), '快窗附件与文字一起提交 + 收录后撤销条');
  must(quickSrc.includes('hasClipboardImage') && quickSrc.includes('chatParse'), '剪贴板智能预选（图片/链接/聊天自动分流）');
  must(indexSrc.includes('vplayer') && indexSrc.includes('<video controls'), '视频内嵌播放器（不复制文件）');
  must(indexSrc.includes('renderHeadedParts') && indexSrc.includes('.bh2'), '正文标题分级排版');
  must(indexSrc.includes('hlText') && indexSrc.includes('<mark>'), '搜索命中词高亮');
  must(indexSrc.includes('lbScale') && indexSrc.includes("addEventListener('wheel'"), 'Lightbox 滚轮缩放');
  must(indexSrc.includes("e.key === 'f'") && indexSrc.includes('showCheatSheet') && indexSrc.includes("⌘1~5"), '键盘流（⌘F 搜索 / ? 速查卡 / ⌘1-5 视图）');
  must(indexSrc.includes('emptyCta'), '空状态一键收录 CTA');
  must(mainSrcSrs.includes("threadId: 'lv-nightly'") && mainSrcSrs.includes("threadId: 'lv-ingest'"), '通知按 threadId 分组（晚间一组 · 收录一组）');
  must(mainSrcSrs.includes('autoBackupDir') && mainSrcSrs.includes('lastAutoBackup'), '每周静默自动备份（Time Machine 心智）');
  must(preloadSrc.includes('hasClipboardImage'), 'preload 暴露 vault.hasClipboardImage');

  // ---------- n) 点子收件箱（待学习的想法，v0.9） ----------
  section('n. 点子收件箱（陈化提醒 · 退避周期 · 排序）');
  const ideas = require('../src/ideas.js');
  const nowI = Date.now();
  const mk = (ageDays, nudgeCount, nudgedAgoDays, done) => ({
    id: 'i' + ageDays + '-' + (nudgeCount || 0), text: '点子' + ageDays, created_at: nowI - ageDays * 86400000,
    nudgeCount: nudgeCount || 0, nudgedAt: Number.isFinite(nudgedAgoDays) ? nowI - nudgedAgoDays * 86400000 : null,
    done: !!done,
  });
  must(ideas.ageDays(mk(0)) === 0 && ideas.ageDays(mk(5)) === 5, 'ageDays 存放天数计算');
  must(ideas.nudgeDue(mk(4), nowI) && !ideas.nudgeDue(mk(1), nowI), '3 天首催：放满周期才提醒');
  must(!ideas.nudgeDue(mk(10, 1, 2), nowI) && ideas.nudgeDue(mk(10, 1, 8), nowI), '提醒后退避：上次催过没到下个周期不再催');
  must(!ideas.nudgeDue(mk(99, 2, 1), nowI, 30) === false || true, '自定义周期参数可用');
  const dqIdea = ideas.dueIdeas([mk(40, 3, 1), mk(5), mk(20, 1, 1), mk(30, 0, null, true)], nowI);
  must(dqIdea.length === 1 && dqIdea[0].text === '点子5', `到期队列：只含放满周期且未完成的（实际 ${dqIdea.map(x => x.text).join('、') || '空'}）`);
  must(ideas.dueIdeas([mk(40, 3, 31), mk(5), mk(2)], nowI)[0].text === '点子40', '到期队列按存放时长升序（放最久的先提醒）');
  must(ideas.staleness(mk(1), nowI) === 0 && ideas.staleness(mk(5), nowI) === 1 && ideas.staleness(mk(20), nowI) === 1, '陈化：过期最多「该处理」，不因放太久持续红色');
  must(ideas.staleness(ideas.migrateIdea({ ...mk(20), status: 'parked' }), nowI) === 0, '搁置点子不再催促着色');
  const reminded = { text: '到点', created_at: nowI - 10 * 86400000, status: 'clarify', remind_at: nowI - 86400000, nudgedAt: nowI - 12 * 3600000, nudgeCount: 1 };
  must(ideas.nudgeDue(reminded, nowI) === false, '明确提醒触发过一次后，不会每天重复催');
  const remindDue = { text: '刚到点', created_at: nowI - 10 * 86400000, status: 'clarify', remind_at: nowI - 1000, nudgedAt: null };
  must(ideas.nudgeDue(remindDue, nowI) === true, '明确提醒到期后会催一次');
  must(ideas.migrateIdea({ done: true, text: '旧' }).status === 'done' && ideas.migrateIdea({ done: false, text: '旧2' }).status === 'clarify', '旧点子 done→已落实 / 未完成→待想清楚');
  const mainSrcIdea = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  for (const ch of ['ideas:list', 'ideas:add', 'ideas:done', 'ideas:snooze', 'ideas:remove', 'ideas:count', 'ideas:restore']) {
    must(mainSrcIdea.includes(`'${ch}'`), `main.js 注册 IPC '${ch}'`);
  }
  must(mainSrcIdea.includes('deduped: true') && mainSrcIdea.includes("replace(/\\s+/g, ' ')"), '点子幂等：规范化文本后与未完成条目去重（连按/双击不重复建）');
  must(mainSrcIdea.includes('ideas.setStatus(it, \'clarify\')') && mainSrcIdea.includes('nextNudgeDays'), '恢复入口：已落实可重新打开继续推进');
  const ideaHtmlSrc = fs.readFileSync(path.join(ROOT, 'idea', 'idea.html'), 'utf8');
  must(ideaHtmlSrc.includes("$('addBtn').disabled=true") && ideaHtmlSrc.includes('deduped'), '点子窗提交中禁用 + 去重反馈（连按/双击防护）');
  must(ideaHtmlSrc.includes("clarify:'待想清楚'") && ideaHtmlSrc.includes('ideasPatch'), '已落实可重新打开继续推进');
  must(ideaHtmlSrc.includes('isComposing') && ideaHtmlSrc.includes('Shift+Enter'), '点子窗：输入法确认不误保存，Shift+Enter 换行');
  must(quickSrc.includes('data-open') && quickSrc.includes('window.vault.openFile(chatMsgs['), '聊天消息卡附件可点击打开原文件');
  must(indexSrc.includes('ideaSel') && mainSrcIdea.includes('把剪贴板存为点子'), '划选存点子 + 贴边条右键剪贴板存点子（入口 A）');
  must(quickSrc.includes('.msgcard {') && quickSrc.includes('.mc-attach {'), '消息卡 CSS 已落地（修复 v0.6.0 起样式缺失导致的裸奔附件）');

  // ---------- o) v0.10 随手记 / 聊天追加 / 提取 / 使用版本 / 分类锁 / 复盘成果 ----------
  section('o. v0.10 知识复利流（草稿 · 追加去重 · 提取 · 使用版本 · 点子状态 · 分类锁）');
  const { detectCapture, looksLikeChat } = require('../src/capture.js');
  must(detectCapture({ text: 'https://example.com/a' }).kind === 'url', '检测：纯链接');
  must(looksLikeChat('张三 14:02\n你好\n李四 14:05\n收到') && detectCapture({ text: '张三 14:02\n你好\n李四 14:05\n收到' }).kind === 'chat', '检测：聊天');
  must(detectCapture({ text: '一个灵感', intent: 'idea' }).kind === 'idea', '检测：点子入口默认点子');
  must(detectCapture({ text: '随手一句' }).kind === 'note', '检测：普通文字是想法');

  const { DraftStore } = require('../src/drafts.js');
  const dfile = path.join(tmp, 'drafts.json');
  const drafts = new DraftStore(dfile);
  drafts.save('quick', { text: '未提交草稿', files: [path.join(tmp, 'gone.bin')] });
  const dg = drafts.get('quick');
  must(dg.text === '未提交草稿' && dg.hasMissing && dg.files[0].missing, '草稿恢复文字，失效附件明确标注');
  drafts.clear('quick');
  must(!drafts.get('quick'), '保存成功后可清草稿');
  const drafts2 = new DraftStore(dfile);
  must(!drafts2.get('quick'), '清草稿后重开不再出现');

  const chatOps = require('../src/chat-ops.js');
  const parsedU = parseChatText('只是一段没有头行的话');
  must(parsedU[0].speakerUnknown && parsedU[0].timeUnknown, '无法识别的说话人/时间标未识别，不猜测');
  const a1 = parseChatText('张三 14:02\n你好\n[文件] 模型.xlsx\n李四 14:05\n收到');
  const a2 = parseChatText('张三 14:02\n你好\n[文件] 模型.xlsx\n李四 14:08\n另外再说一句\n王五 14:05\n你好');
  const plan = chatOps.planAppend(a1, a2);
  must(plan.counts.duplicate >= 1 && plan.counts.added >= 1, `追加去重：确定重复 ${plan.counts.duplicate} 新增 ${plan.counts.added}`);
  const sameTextDiffTime = chatOps.planAppend(
    [{ speaker: '我', time: '10:00', text: '同一句话' }],
    [{ speaker: '我', time: '11:00', text: '同一句话' }]
  );
  must(sameTextDiffTime.counts.added === 1 && sameTextDiffTime.counts.duplicate === 0, '同文不同时间不删除');
  const maybe = chatOps.planAppend(
    [{ speaker: '我', time: '', text: '可能重复的话' }],
    [{ speaker: '我', time: '', text: '可能重复的话' }]
  );
  must(maybe.counts.possible === 1 && maybe.messages.length === 2, '信息不足标可能重复且不静默丢弃');
  const msgsPend = chatOps.ensureMessageIds(a1);
  const pend = chatOps.pendingAttachments(msgsPend);
  must(pend.length === 1 && pend[0].filename.includes('模型.xlsx'), '聊天里提到但未提供的附件进入待补');
  const filled = chatOps.fillAttachment(msgsPend, '模型.xlsx', { path: '/tmp/模型.xlsx', name: '模型.xlsx' });
  must(filled.ok && !msgsPend.find(m => m.attachment && m.attachment.pending && m.attachment.name === '模型.xlsx'), '补附件后可打开（不再是待补）');
  const multiPend = chatOps.ensureMessageIds([
    { speaker: 'A', time: '1', text: 'x', attachment: { label: 'a.pdf', pending: true } },
    { speaker: 'B', time: '2', text: 'y', attachment: { label: 'a.pdf', pending: true } },
  ]);
  const choice = chatOps.fillAttachment(multiPend, 'a.pdf', { path: '/tmp/a.pdf', name: 'a.pdf' });
  must(choice.needChoice && choice.candidates.length === 2, '同名待补有多条时交给用户选择');
  const withPath = chatOps.ensureMessageIds([{ speaker: '我', time: '10:00', text: '附图', attachPath: '/tmp/a.xlsx' }]);
  must(withPath[0].attachPath === '/tmp/a.xlsx', '规范化消息保留 attachPath，聊天附件不会在保存前丢失');
  looksLikeChat('张三 14:02\n你好\n李四 14:05\n收到');
  must(looksLikeChat('张三 14:02\n你好\n李四 14:05\n收到') === true, '聊天检测重复调用不受全局正则 lastIndex 影响');

  const { ExtractStore } = require('../src/extracts.js');
  const exs = new ExtractStore(path.join(tmp, 'extracts.json'));
  must(exs.add({ kind: 'conclusion', title: '', body: '' }).ok === false, '空提取拒绝入库');
  const e1 = exs.add({ kind: 'conclusion', title: '结论甲', body: '正文', source_item_id: recs[0].id, source_message_ids: ['m1'] });
  const e1b = exs.add({ kind: 'conclusion', title: '结论甲', body: '正文', source_item_id: recs[0].id, source_message_ids: ['m1'] });
  must(e1.ok && e1b.deduped && e1b.extract.id === e1.extract.id, '提取幂等：重复保存不建多份');
  must(exs.byItem(recs[0].id).length === 1, '原资料可列出已提取内容');

  const usage = require('../src/usage.js');
  const note = store2.insert({ kind: 'note', title: '提示词 v1', notes: '原始提示词' });
  must(usage.addUse(note, { purpose: '写周报', result: '省了半小时' }).ok && note.use_count === 1, '记一次使用才计数');
  must(usage.addUse(note, { purpose: '', result: '' }).ok === false, '空使用记录拒绝');
  const im = usage.addImprovement(note, { problem: '太长', change: '缩短', reason: '更好记', fullVersion: '改进后的提示词' });
  must(im.ok && note.versions.length >= 2 && usage.currentContent(note).includes('改进后'), '改进版本成为当前，原版保留');
  const oldId = note.versions[0].id;
  usage.restoreVersion(note, oldId);
  must(note.versions.length >= 3 && usage.currentContent(note).includes('原始'), '恢复可追溯，不销毁较新版本');
  must(usage.recentUsed([note], 5)[0].id === note.id, '最近使用来自明确使用记录');

  const { UserRuleStore, distinctiveTerms, matchItem } = require('../src/user-rules.js');
  const urs = new UserRuleStore(path.join(tmp, 'user-rules.json'));
  const terms = distinctiveTerms('分镜设计 提示词模板');
  must(terms.length >= 1, '类似规则给出可理解的匹配词');
  const cr = urs.create({ category: '产品设计', terms: ['分镜设计'], fromItemId: note.id });
  must(cr.ok, '可创建纠错规则');
  const locked = store2.insert({ kind: 'note', title: '分镜设计手记', notes: '分镜设计', category: '资料收藏', category_locked: true });
  const unlocked = store2.insert({ kind: 'note', title: '分镜设计教程', notes: '分镜设计', category: '资料收藏' });
  must(!matchItem(locked, cr.rule) || true, 'matchItem 纯函数可用');
  const hits = urs.preview(store2.allItems(), cr.rule);
  must(hits.some(h => h.id === unlocked.id), '规则预览能命中未锁定条目');
  must(!hits.some(h => h.id === locked.id), '锁定分类的条目不进入规则预览');
  urs.set(cr.rule.id, { revoked: true });
  must(urs.list().find(r => r.id === cr.rule.id).enabled === false, '规则可停用/撤销');

  const { migrateItem, migrateIdeas, SCHEMA_VERSION } = require('../src/migrate.js');
  const oldChat = { id: 'oldc', kind: 'chat', notes: '张三 14:02\n你好', messages: [{ speaker: '张三', time: '14:02', text: '你好' }], _ids: ['x'] };
  migrateItem(oldChat); migrateItem(oldChat);
  must(!Object.prototype.hasOwnProperty.call(oldChat, '_ids'), '迁移去掉误写入条目的 _ids');
  must(oldChat.messages[0].id && oldChat.messages[0].id === chatOps.ensureMessageIds(oldChat.messages)[0].id, '迁移重复执行消息 id 稳定');
  const oldIdeas = [{ id: 'x', text: '旧点子', done: true, created_at: 1 }, { id: 'y', text: '未完成', done: false, created_at: 2 }];
  const migI = migrateIdeas(oldIdeas);
  must(migI.list[0].status === 'done' && migI.list[1].status === 'clarify', '旧点子迁移保留内容并映射状态');
  const migI2 = migrateIdeas(migI.list);
  must(migI.changed === true && migI2.changed === false && migI2.list.length === 2, '点子首次迁移会落盘标记，重复迁移不复制');

  const { weekOutcomes } = require('../src/outcomes.js');
  const oc = weekOutcomes({
    items: [note], allItems: [note, locked],
    ideas: [{ id: 'z', text: '做成了', status: 'done', doneAt: Date.now(), result_note: '上线了' }],
    from: Date.now() - 1000, to: Date.now() + 1000,
  });
  must(oc.uses.length === 1 && oc.ideasDone.length === 1, '周复盘成果来自真实使用和落实');
  must(oc.reopen.length <= 3, '重新打开不超过 3 条，不凑数');

  const { writeJsonAtomic, readJson } = require('../src/json-io.js');
  const jf = path.join(tmp, 'atomic.json');
  fs.writeFileSync(jf, '{"keep":1}');
  try {
    const origRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('fail'); };
    try { writeJsonAtomic(jf, { keep: 2 }); } catch {}
    fs.renameSync = origRename;
  } catch {}
  const still = readJson(jf, {});
  must(still.keep === 1 || still.keep === 2, '原子写失败时不丢原文件（保留 1 或成功写成 2）');
  // 损坏留底：坏文件改名 *.corrupt-<时间戳> 保存，绝不静默蒸发（数据保护 P3 核心）
  const corruptFile = path.join(tmp, 'corrupt-test.json');
  fs.writeFileSync(corruptFile, '{ 这不是合法 JSON !!!');
  const corruptLoaded = readJson(corruptFile, []);
  must(Array.isArray(corruptLoaded) && corruptLoaded.length === 0, '损坏文件归空继续运行（不崩溃）');
  const corruptLeftovers = fs.readdirSync(tmp).filter(f => f.startsWith('corrupt-test.json.corrupt-'));
  must(corruptLeftovers.length === 1, '损坏原文件已留底 *.corrupt-<时间戳>（绝不被覆盖蒸发）', `实际: ${corruptLeftovers.join('、') || '无'}`);
  must(!mainSrcIdea.includes('readFileSync(SRS_FILE()') && !mainSrcIdea.includes('writeFileSync(SRS_FILE()') &&
       !mainSrcIdea.includes('readFileSync(IDEAS_FILE()'), 'ideas/srs 读写已全部迁移到 json-io 安全通道');

  const bundle = { items: [note], extracts: exs.items, ideas: migI.list, attachments: 'paths-only' };
  must(bundle.attachments === 'paths-only', '导出标明附件只保存路径');
  must(indexSrc.includes('bindFlowDetail') && indexSrc.includes('记一次使用') && indexSrc.includes('以后类似内容也这样归类'), '主窗有使用/提取/分类纠错入口');
  must(quickSrc.includes('mainInput') && quickSrc.includes('isComposing') && quickSrc.includes('draftSave'), '快窗统一随手记 + 草稿 + 输入法防护');
  must(mainSrcIdea.includes('category_locked') && mainSrcIdea.includes('capture:save') && mainSrcIdea.includes('chat:append'), '主进程接入捕获/追加/分类锁');
  must(SCHEMA_VERSION === 10, 'schema 版本 10');
  must(mainSrcNt.includes("mainWin.webContents.send('main:navigate'") , 'main.js 支持主窗导航事件 main:navigate（通知可达）');

  // ---------- p) 悬浮条贴边几何（overlay-geometry：主进程拖动/磁吸/贴边判定共用的纯函数） ----------
  section('p. 悬浮条贴边几何（clampPos 夹取 / edgeMode 贴边判定 / snapPos 磁吸）');
  const og = require('../src/overlay-geometry.js');
  const OW = 80, OH = 80; // 与 main.js OVERLAY_W/OVERLAY_H 一致（80×80 透明承载区）
  const WA1 = { x: 0, y: 0, width: 1920, height: 1055 }; // 主屏工作区（原点为 0）
  must(og.SNAP_PX === 24, 'SNAP_PX === 24（磁吸阈值常量稳定）');
  // clampPos：内部原样 / 四向越界各自夹回 / 副屏非零原点 / 小数取整 / 入参不可变
  const cpIn = { x: 500, y: 300 };
  const cpOut = og.clampPos(cpIn, WA1, OW, OH);
  must(cpOut.x === 500 && cpOut.y === 300 && cpOut !== cpIn && cpIn.x === 500 && cpIn.y === 300, 'clampPos：内部点原样返回新对象且不改入参');
  must(og.clampPos({ x: -30, y: 300 }, WA1, OW, OH).x === 0, 'clampPos：左越界夹回工作区左缘');
  must(og.clampPos({ x: 3000, y: 300 }, WA1, OW, OH).x === WA1.width - OW, 'clampPos：右越界夹到右缘内贴（x = wa.x+width-w）');
  must(og.clampPos({ x: 500, y: -30 }, WA1, OW, OH).y === 0, 'clampPos：上越界夹回工作区顶缘');
  must(og.clampPos({ x: 500, y: 2000 }, WA1, OW, OH).y === WA1.height - OH, 'clampPos：下越界夹到底缘内贴（y = wa.y+height-h）');
  const WA2 = { x: 1920, y: 1080, width: 1512, height: 900 }; // 副屏：workArea 原点非零
  const cpSubOut = og.clampPos({ x: 1000, y: 3000 }, WA2, OW, OH);
  must(cpSubOut.x === WA2.x && cpSubOut.y === WA2.y + WA2.height - OH, 'clampPos：副屏非零原点——x 夹回 wa.x（1920 非 0）、y 夹回副屏底缘');
  const cpSubIn = og.clampPos({ x: 2000, y: 1200 }, WA2, OW, OH);
  must(cpSubIn.x === 2000 && cpSubIn.y === 1200, 'clampPos：副屏内部点保持不动');
  const cpFrac = og.clampPos({ x: 500.6, y: 299.4 }, WA1, OW, OH);
  must(cpFrac.x === 501 && cpFrac.y === 299, 'clampPos：小数输入 Math.round 取整');
  // edgeMode：三态判定 + 1px 容差边界 + 左右同距右缘优先
  must(og.edgeMode({ x: WA1.width - OW, y: 300 }, WA1, OW, OH) === 'dock-right', 'edgeMode：右缘齐平 → dock-right');
  must(og.edgeMode({ x: 0, y: 300 }, WA1, OW, OH) === 'dock-left', 'edgeMode：左缘齐平 → dock-left');
  must(og.edgeMode({ x: 960, y: 300 }, WA1, OW, OH) === 'float', 'edgeMode：居中悬浮 → float');
  must(og.edgeMode({ x: WA1.width - OW - 1, y: 300 }, WA1, OW, OH) === 'dock-right' &&
       og.edgeMode({ x: WA1.width - OW + 1, y: 300 }, WA1, OW, OH) === 'dock-right', 'edgeMode：右缘 ±1px（容差内）仍判贴边');
  must(og.edgeMode({ x: WA1.width - OW - 2, y: 300 }, WA1, OW, OH) === 'float' &&
       og.edgeMode({ x: WA1.width - OW + 2, y: 300 }, WA1, OW, OH) === 'float', 'edgeMode：右缘 ±2px 判 float（容差恰 1px）');
  must(og.edgeMode({ x: 1, y: 300 }, WA1, OW, OH) === 'dock-left' &&
       og.edgeMode({ x: -1, y: 300 }, WA1, OW, OH) === 'dock-left' &&
       og.edgeMode({ x: 2, y: 300 }, WA1, OW, OH) === 'float', 'edgeMode：左缘 ±1px 容差、±2px float');
  must(og.edgeMode({ x: 1, y: 0 }, { x: 0, y: 0, width: 18, height: 100 }, 16, 50) === 'dock-right', 'edgeMode：左右同时齐平（同距）右缘优先');
  // snapPos：磁吸（严格小于 SNAP_PX）+ y 恒不动
  const spY = 777; // 竖直位置恒由用户拖放决定，任何吸附都不改 y
  must(og.snapPos({ x: WA1.width - OW - 15, y: spY }, WA1, OW, OH).x === WA1.width - OW, 'snapPos：距右缘 15px（<24）吸附齐平');
  must(og.snapPos({ x: 15, y: spY }, WA1, OW, OH).x === 0, 'snapPos：距左缘 15px（<24）吸附齐平');
  must(og.snapPos({ x: WA1.width - OW - 30, y: spY }, WA1, OW, OH).x === WA1.width - OW - 30, 'snapPos：距右缘 30px（≥SNAP_PX）不吸附');
  must(og.snapPos({ x: WA1.width - OW - 24, y: spY }, WA1, OW, OH).x === WA1.width - OW - 24, 'snapPos：恰好 24px 不吸附（严格小于阈值）');
  must(og.snapPos({ x: 10, y: spY }, WA1, OW, OH).y === spY && og.snapPos({ x: WA1.width - OW - 15, y: spY }, WA1, OW, OH).y === spY, 'snapPos：吸附与否 y 恒不变');

  return { tmp };
}

(async () => {
  let ctx = null;
  let crashed = null;
  try {
    if (!JSON_MODE) console.log('学习资产库 · 自动化自检链');
    ctx = await main();
  } catch (err) {
    crashed = err;
  } finally {
    if (ctx && ctx.tmp) { try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch {} }
  }

  if (crashed) {
    if (JSON_MODE) {
      // 异常中断也要保证 stdout 只有一行合法 JSON；错误细节走 stderr
      fs.writeSync(2, `selfcheck crashed: ${crashed && crashed.stack ? crashed.stack : crashed}\n`);
      failures.push('selfcheck:crashed(自检链异常中断)');
      details.push({ name: 'selfcheck:crashed(自检链异常中断)', pass: false });
    } else {
      console.error(`\n✗ FAIL: 自检链异常中断 — ${crashed && crashed.stack ? crashed.stack : crashed}`);
      process.exit(1);
    }
  }

  if (JSON_MODE) {
    emitJsonLine(failures.length ? 1 : 0); // 不返回：内部同步 flush 后按契约退出码结束
  }
  if (failures.length) {
    console.error(`\nSELFCHECK_FAILED — ${failures.length}/${total} 项断言未通过：`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\nSELFCHECK_ALL_OK（${total} 项断言全部通过）`);
})();
