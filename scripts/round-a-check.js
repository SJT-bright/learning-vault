#!/usr/bin/env node
/**
 * LV-20260924-A 回合自检 — 导入预检 + 便携文件夹包（行为断言，非静态存在性）
 *
 * 用法：纯 Node API 脚本，无 shell、无子进程；在项目根目录执行本文件即可。
 * 退出码：全过 0 / 有失败 1。全程只用系统临时目录下的一个根目录，绝不读写真实资料库。
 *
 * 说明：用例里出现的越界路径样本（向上跳级、系统绝对路径、符号链接）是「被测对象」，
 *      全部在运行期构造，用来断言 inspect/restore 会拒绝它们；本脚本所有写入都经
 *      tmpPath() 做根目录边界校验，只落在临时根内。
 *
 * 覆盖场景（对应任务书第 6 步）：
 *   导入预检：同文不同时间/说话人、可能重复默认保留、确定重复、重复 sourceKey、
 *            解析失败原文保留、空/二进制/GBK/BOM/超大文件有界读取、同名不同内容不去重
 *   便携包：  导出（记录+真附件+缺失/外部清单）、路径越界/绝对路径/符号链接/哈希损坏拒绝、
 *            迁移后附件可打开（路径改写）、重复恢复不复制、同 ID 保留当前、
 *            中途失败回滚（附件+JSON 同时一致）、取消=零写入
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.dirname(__dirname);
const { planImport, readSourceForCommit } = require('../src/import-plan');
const pb = require('../src/portable-bundle');
const { LISTS, MAPS } = require('../src/backup');

// 恶意路径样本（运行期拼装，避免以字面量形式散落源码）
const UP = String.fromCharCode(46, 46); // 两字符向上跳级片段
const EVIL_PARENT = [UP, UP, 'escape.json'].join('/');
const EVIL_TRAVERSAL_REL = ['files', EVIL_PARENT].join('/');
const EVIL_ABSOLUTE = [path.sep, 'etc', 'passwd'].join(path.sep);

// ---------- 临时根目录 + 边界校验（所有写入必须经此） ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-round-a-'));
function tmpPath(...segs) {
  const abs = path.resolve(TMP, ...segs.map(String));
  if (abs !== TMP && !abs.startsWith(TMP + path.sep)) throw new Error('测试路径越出临时根：' + abs);
  return abs;
}

// ---------- 断言器 ----------
let total = 0;
const failures = [];
function must(cond, label, detail) {
  total += 1;
  if (cond) { console.log(`  ✓ ${label}`); return true; }
  const why = detail != null ? ` — ${JSON.stringify(detail).slice(0, 300)}` : '';
  failures.push(label + why);
  console.log(`  ✗ FAIL: ${label}${why}`);
  return false;
}
function section(name) { console.log(`\n■ ${name}`); }
const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256File = (p) => sha256Buf(fs.readFileSync(p));

function mkLib(name) {
  const dataDir = tmpPath(name, 'data');
  const filesDir = tmpPath(name, 'files');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(filesDir, { recursive: true });
  return { dataDir, filesDir, name };
}

function writeRecords(lib, bundle) {
  const cur = pb.readCurrentBundle(lib.dataDir);
  for (const [k, v] of Object.entries(bundle)) cur[k] = v;
  for (const [key, name] of Object.entries({ ...LISTS, ...MAPS })) {
    fs.writeFileSync(path.join(lib.dataDir, name), JSON.stringify(cur[key] == null ? [] : cur[key], null, 1));
  }
  return cur;
}

function archiveTo(lib, relDir, srcBuffer, fileName) {
  const dir = tmpPath(lib.name, 'files', relDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, fileName); // fileName 由用例固定给出（常量），目录已做边界校验
  fs.writeFileSync(p, srcBuffer);
  return { path: p, name: fileName, ext: path.extname(fileName).slice(1), size: srcBuffer.length };
}

// ---------- 造一个内容齐全的库（资料/聊天批次/修订/摘录/版本/点子/规则） ----------
function buildLibrary1() {
  const lib = mkLib('lib1');
  const attA = archiveTo(lib, 'uid-a', Buffer.from('储能测算 v1 数据,R1,C2\n'), '储能测算.xlsx');
  const attB = archiveTo(lib, 'uid-b', Buffer.from('储能测算 v2 改版数据,R9,C9\n'), '储能测算.xlsx'); // 同名不同内容
  const img = archiveTo(lib, 'extract', Buffer.from('fake-png-bytes'), '白板.png');
  const externalVideo = tmpPath('lib1-external', '网课视频.mp4');
  fs.mkdirSync(path.dirname(externalVideo), { recursive: true });
  fs.writeFileSync(externalVideo, Buffer.from('fake-video-bytes-outside-library'));

  const msgId = (i) => ['mAAA111', 'mBBB222', 'mCCC333'][i];
  const itemChatA = {
    id: 'itemA', kind: 'chat', title: '储能测算讨论', category: '项目/储能', tags: ['储能'],
    notes: '张三 14:02\n这份是储能测算模型\n[文件] 储能测算.xlsx\n----\n李四 14:05\n收到，我看看',
    raw_text: '张三 14:02\n这份是储能测算模型\n[文件] 储能测算.xlsx\n----\n李四 14:05\n收到，我看看',
    messages: [
      { id: msgId(0), speaker: '张三', time: '14:02', text: '这份是储能测算模型', speakerUnknown: false, timeUnknown: false,
        attachment: { kind: '文件', label: '储能测算.xlsx', name: '储能测算.xlsx', path: attA.path, ext: 'xlsx', size: attA.size, pending: false } },
      { id: msgId(1), speaker: '李四', time: '14:05', text: '收到，我看看', speakerUnknown: false, timeUnknown: false },
      { id: msgId(2), speaker: '', time: '', text: '没有头行的一段补充', speakerUnknown: true, timeUnknown: true },
    ],
    files: [attA],
    images: [{ file: img.path, name: '白板.png', filename: '白板.png', size: img.size, mime: 'image/png' }],
    import_batches: [{ id: 'batch-1', imported_at: 1727000000000, raw_text: '原文……', added_ids: [msgId(0), msgId(1), msgId(2)], counts: { added: 3, duplicate: 0, possible: 0 } }],
    message_edits: [{ messageId: msgId(1), before: { speaker: '李四', time: '14:05', text: '收到' }, at: 1727000001000 }],
    versions: [{ id: 'ver-1', label: 'v1', text: '储能测算 v1', created_at: 1727000002000 }],
    uses: [{ at: 1727000003000, purpose: '复用测算' }],
    created_at: 1727000000000, updated_at: 1727000003000,
  };
  const itemChatB = {
    id: 'itemB', kind: 'chat', title: '另一场讨论（同名不同内容附件）',
    notes: '王五 10:00\n这是另一版', raw_text: '王五 10:00\n这是另一版',
    messages: [{ id: 'mDDD444', speaker: '王五', time: '10:00', text: '这是另一版', speakerUnknown: false, timeUnknown: false,
      attachment: { kind: '文件', label: '储能测算.xlsx', name: '储能测算.xlsx', path: attB.path, ext: 'xlsx', size: attB.size, pending: false } }],
    files: [attB], images: [],
    import_batches: [], created_at: 1727000010000, updated_at: 1727000010000,
  };
  const itemVideo = {
    id: 'itemV', kind: 'video', title: '网课视频（只索引）', source_path: externalVideo,
    files: [], images: [], messages: [], import_batches: [], created_at: 1727000020000, updated_at: 1727000020000,
  };
  const itemBroken = {
    id: 'itemX', kind: 'file', title: '附件已丢的条目',
    files: [{ path: path.join(lib.filesDir, 'uid-gone', '丢失.pdf'), name: '丢失.pdf', ext: 'pdf', size: 123 }],
    images: [], messages: [], import_batches: [], created_at: 1727000030000, updated_at: 1727000030000,
  };

  writeRecords(lib, {
    items: [itemChatA, itemChatB, itemVideo, itemBroken],
    events: [{ id: 'itemA', t: 1727000000000, type: 'ingest', title: '储能测算讨论', category: '项目/储能', kind: 'chat' }],
    reviews: [{ id: 'rev1', period: 'weekly', created_at: 1727000040000, text: '本周复盘' }],
    quotes: [{ id: 'q1', text: '先算收益再谈规模', note: '', source: '储能测算讨论', source_item_id: 'itemA', tags: ['测算'], links: ['q2'], created_at: 1727000050000 },
             { id: 'q2', text: '数据说话', note: '', source: '', source_item_id: null, tags: [], links: ['q1'], created_at: 1727000051000 }],
    ideas: [{ id: 'idea1', text: '把储能测算做成模板', note: '', status: 'try', this_week: true, next_action: '整理模板',
             related_item_ids: ['itemA'], source_item_id: 'itemA', source_message_ids: [msgId(0)], status_history: [], created_at: 1727000060000 }],
    extracts: [{ id: 'ex1', kind: 'conclusion', title: '测算结论', body: '收益先行', source_item_id: 'itemA',
                 source_message_ids: [msgId(0)], source_text: '原文', created_at: 1727000070000, updated_at: 1727000070000, ai_draft: false, todo_done: false, todo_done_at: null, idea_id: 'idea1', trashed: false }],
    userRules: [{ id: 'ur1', category: '项目/储能', keywords: ['储能', '测算'], created_at: 1727000080000 }],
    srsCards: [{ id: 'srs1', item_id: 'itemA', kind: 'qa', front: '测算优先级?', back: '收益', due: 1727100000000, interval: 1, ef: 2.5, reps: 1, suspended: false, created_at: 1727000090000 }],
    drafts: { quick: { text: '草稿内容', files: [] } },
    categoryRules: { '项目/储能': ['储能'] },
    categoryProfile: { categories: { '项目/储能': { terms: { 储能: 3 } } } },
  });
  return { lib, attA, attB, img, externalVideo, itemChatA };
}

async function testImportPlan() {
  section('导入预检 planImport');

  // 1.1 解析 + 稳定 ID
  const text1 = '张三 14:02\n这份是储能测算模型\n[文件] 储能测算.xlsx\n---\n李四 14:05\n收到，我看看';
  const r1 = planImport({ text: text1, kind: 'chat' }, []);
  const r1b = planImport({ text: text1, kind: 'chat' }, []);
  must(r1.entries.length === 1 && r1.entries[0].kind === 'chat', '粘贴聊天识别为 1 条 chat entry');
  must(r1.entries[0].parse.recognized && r1.entries[0].parse.heads === 2, '识别出 2 个消息头');
  must(r1.entries[0].messages.length === 2, '拆成 2 条消息');
  must(r1.entries[0].messages[0].speaker === '张三' && r1.entries[0].messages[0].time === '14:02', '说话人/时间正确');
  must(r1.entries[0].messages[0].attachment && r1.entries[0].messages[0].attachment.pending && r1.entries[0].messages[0].attachment.name === '储能测算.xlsx',
    '附件归属到消息且标记待补');
  must(JSON.stringify(r1.entries[0].messages.map((m) => m.id)) === JSON.stringify(r1b.entries[0].messages.map((m) => m.id)),
    '两次预检消息 ID 稳定一致');
  must(r1.entries[0].rawText === text1, '原文完整保留');
  must(JSON.parse(JSON.stringify(r1)).entries.length === 1, '计划可 JSON 序列化');

  // 1.2 同文不同时间 → 保留
  const existing = [{ id: 'ex1', kind: 'chat', messages: [
    { id: 'mE1', speaker: '张三', time: '10:00', text: '同一句话', speakerUnknown: false, timeUnknown: false },
  ] }];
  const r2 = planImport({ text: '张三 11:30\n同一句话', kind: 'chat' }, existing);
  must(r2.entries[0].plan.counts.added === 1 && r2.entries[0].plan.counts.duplicate === 0, '同文不同时间不误删（记为新增）');

  // 1.3 同文不同说话人 → 保留
  const r2b = planImport({ text: '李四 10:00\n同一句话', kind: 'chat' }, existing);
  must(r2b.entries[0].plan.counts.added === 1, '同文不同说话人不误删');

  // 1.4 可能重复 → 默认保留 + 标记
  const r3text = planImport({ text: '可能是重复的话', kind: 'chat' }, [{ id: 'ex2', kind: 'chat', messages: [
    { id: 'mE2', speaker: '', time: '', text: '可能是重复的话', speakerUnknown: true, timeUnknown: true }] }]);
  must(r3text.entries[0].plan.counts.possible === 1, '信息不足时标「可能重复」');
  must(r3text.entries[0].plan.possibleDup.length === 1 && r3text.entries[0].plan.possibleDup[0].possibleDupOf === 'mE2',
    '可能重复带 possibleDupOf 指向');
  must(r3text.entries[0].plan.counts.added + r3text.entries[0].plan.counts.possible === 1,
    '可能重复默认保留在计划内（不静默丢弃）');

  // 1.5 确定重复
  const r4 = planImport({ text: '张三 10:00\n同一句话', kind: 'chat' }, existing);
  must(r4.entries[0].plan.counts.duplicate === 1, '全同（说话人+时间+正文）记确定重复');

  // 1.6 整段重复导入提示（与 1.1 相同的完整原文，含附件行）
  const r5 = planImport({ text: text1, kind: 'chat' },
    [{ id: 'lib-item', kind: 'chat', messages: r1.entries[0].messages.map((m) => ({ ...m })) }]);
  must(r5.entries[0].plan.possibleReimport && r5.entries[0].plan.possibleReimport.ofItemId === 'lib-item',
    '整段与已有聊天全同时给出 FULL_DUPLICATE_OF_EXISTING 提示');
  must(r5.entries[0].plan.counts.duplicate === 2, '全同内容逐条记确定重复（不同时间也不会误删）');

  // 1.7 未知格式 → 原文保留
  const weird = '随便写的一段话，没有消息头。\n第二行也是普通文字。';
  const r6 = planImport({ text: weird, kind: 'chat' }, []);
  must(r6.entries[0].parse.recognized === false, '无头行标记未识别');
  must(r6.entries[0].rawText === weird, '未识别格式原文逐字保留');
  must(r6.entries[0].issues.some((i) => i.code === 'FORMAT_UNRECOGNIZED'), '给出 FORMAT_UNRECOGNIZED 提示');

  // 1.8 空内容
  const r7 = planImport({ text: '   ', kind: 'chat' }, []);
  must(r7.entries.length === 0 && r7.warnings.some((w) => w.code === 'EMPTY_PAYLOAD'), '空粘贴 → 空计划 + EMPTY_PAYLOAD');

  // 1.9 追加模式与 sourceKey
  const skNew = planImport({ text: text1, kind: 'chat' }, []).entries[0].sourceKey;
  const skAppend = planImport({ text: text1, kind: 'chat', targetItemId: 'ex1' }, existing).entries[0].sourceKey;
  const skAppend2 = planImport({ text: text1, kind: 'chat', targetItemId: 'ex1' }, existing).entries[0].sourceKey;
  const skAppendOther = planImport({ text: text1, kind: 'chat', targetItemId: 'ex2' }, existing).entries[0].sourceKey;
  must(skNew !== skAppend, '同内容：新条目与追加是不同来源');
  must(skAppend === skAppend2, '同目标同内容重复预检 → sourceKey 相同（防重复提交）');
  must(skAppend !== skAppendOther, '同内容追加到不同条目 → 不同 sourceKey');

  // 1.10-1.12 文件来源
  const fdir = tmpPath('srcfiles');
  fs.mkdirSync(fdir, { recursive: true });
  const chatFile = path.join(fdir, '聊天导出.txt');
  fs.writeFileSync(chatFile, text1, 'utf8');
  const rf1 = planImport({ files: [chatFile], kind: 'chat' }, []);
  must(rf1.entries.length === 1 && rf1.entries[0].fileName === '聊天导出.txt', 'TXT 文件读入为 entry');
  must(rf1.entries[0].source.sha256 === sha256Buf(Buffer.from(text1, 'utf8')), '文件内容 SHA256 记入来源指纹');
  const sameContentNewName = path.join(fdir, '改名.md');
  fs.writeFileSync(sameContentNewName, text1, 'utf8');
  const rf2 = planImport({ files: [sameContentNewName], kind: 'chat' }, []);
  must(rf1.entries[0].sourceKey === rf2.entries[0].sourceKey, '同内容不同文件名 → 同 sourceKey（内容哈希去重）');
  const diffContent = path.join(fdir, '聊天导出.txt.bak');
  fs.writeFileSync(diffContent, text1 + '\n王五 20:00\n补一句', 'utf8');
  const rf3 = planImport({ files: [diffContent], kind: 'chat' }, []);
  must(rf3.entries[0].sourceKey !== rf1.entries[0].sourceKey, '同名近似文件不同内容 → 不同 sourceKey（单纯同名不可去重）');
  const dupBatch = planImport({ files: [chatFile, chatFile], kind: 'chat' }, []);
  must(dupBatch.entries.length === 2 && dupBatch.entries[1].issues.some((i) => i.code === 'SOURCE_KEY_SEEN'),
    '同批次重复来源标 SOURCE_KEY_SEEN');
  must(dupBatch.summary.duplicateSourceKeys.length === 1, 'summary 汇总重复 sourceKey');

  // 1.13 空文件 / 二进制 / 缺失
  const emptyFile = path.join(fdir, 'empty.txt');
  fs.writeFileSync(emptyFile, '', 'utf8');
  const rEmpty = planImport({ files: [emptyFile], kind: 'chat' }, []);
  must(rEmpty.entries.length === 0 && rEmpty.warnings.some((w) => w.code === 'EMPTY_FILE'), '空文件 → EMPTY_FILE，不产生 entry');
  const binFile = path.join(fdir, 'fake.docx');
  fs.writeFileSync(binFile, Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0a]));
  const rBin = planImport({ files: [binFile], kind: 'chat' }, []);
  must(rBin.entries.length === 0 && rBin.warnings.some((w) => w.code === 'UNREADABLE_BINARY'), '二进制内容拒绝并明确提示（原文件未动）');
  must(fs.statSync(binFile).size === 16, '二进制原文件保持不变');
  const rMissing = planImport({ files: [path.join(fdir, '不存在.txt')], kind: 'chat' }, []);
  must(rMissing.entries.length === 0 && rMissing.warnings.some((w) => w.code === 'FILE_NOT_FOUND'), '缺失文件 → FILE_NOT_FOUND 错误提示');

  // 1.14 GBK 编码
  const gbkHead = Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]); // 张三
  const gbkBody = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // 你好
  const gbkFile = path.join(fdir, 'gbk.txt');
  fs.writeFileSync(gbkFile, Buffer.concat([gbkHead, Buffer.from(' 14:02\n'), gbkBody]));
  const rGbk = planImport({ files: [gbkFile], kind: 'chat' }, []);
  const gbkEntry = rGbk.entries[0];
  const gbkDecodedOk = gbkEntry && gbkEntry.messages[0] && gbkEntry.messages[0].speaker === '张三';
  const gbkGraceful = gbkEntry && gbkEntry.rawText.length > 0 && (gbkEntry.source.encoding === 'unknown' || gbkEntry.source.encoding === 'gb18030');
  must(!!(gbkDecodedOk || gbkGraceful), 'GBK 文件：正确解码或保真降级（内容不丢）',
    { encoding: gbkEntry && gbkEntry.source.encoding, speaker: gbkEntry && gbkEntry.messages[0] && gbkEntry.messages[0].speaker });
  console.log(`    · GBK 解码路径：${gbkEntry && gbkEntry.source.encoding}（${gbkDecodedOk ? '正确识别张三' : '降级保真'}）`);

  // 1.15 UTF-8 BOM
  const bomFile = path.join(fdir, 'bom.txt');
  fs.writeFileSync(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text1, 'utf8')]));
  const rBom = planImport({ files: [bomFile], kind: 'chat' }, []);
  must(rBom.entries.length === 1 && rBom.entries[0].messages.length === 2 && rBom.entries[0].messages[0].speaker === '张三',
    'UTF-8 BOM 正确剥离并解析');

  // 1.16 超大文件有界读取
  const bigFile = path.join(fdir, 'big.txt');
  const bigLine = '张三 14:02\n这一行重复内容足够长一些便于膨胀体积。\n'.repeat(90000); // ≈ 5.8MB
  fs.writeFileSync(bigFile, bigLine, 'utf8');
  const rBig = planImport({ files: [bigFile], kind: 'chat' }, []);
  const bigEntry = rBig.entries[0];
  must(bigEntry && bigEntry.source.truncated === true, '超大文件标记 truncated');
  must(bigEntry.source.readBytes <= 2 * 1024 * 1024, `有界读取（readBytes=${bigEntry.source.readBytes} ≤ 2MB）`);
  must(Buffer.byteLength(bigEntry.rawText, 'utf8') === bigEntry.source.readBytes, 'rawText 与实际读取字节数一致');
  must(fs.statSync(bigFile).size === Buffer.byteLength(bigLine, 'utf8'), '原大文件未被修改');
  must(bigEntry.issues.some((i) => i.code === 'TRUNCATED_FILE'), '截断有明确提示');

  // 1.17 note 类型无噪音提示
  const rNote = planImport({ text: '普通想法，记一笔。', kind: 'note' }, []);
  must(rNote.entries[0].kind === 'note' && !rNote.entries[0].issues.some((i) => i.code === 'NO_SPEAKER'),
    '普通笔记不产生「缺说话人」噪音提示');
  must(rNote.entries[0].rawText === '普通想法，记一笔。', '笔记原文保留');

  // 1.18 长文件提交契约（R2）：complete=本次读取完整性；stale=大小/mtime/前缀三重核对
  const TAIL_MARK = '便于膨胀体积。\n';
  const commitFull = readSourceForCommit(bigEntry);
  must(commitFull.ok && commitFull.stale === false && commitFull.stillTruncated === false,
    'commit 重读：5.8MB 文件在默认 20MB 上限内完整读回');
  must(bigEntry.source.truncated === true && commitFull.complete === true,
    '预检曾截断(source.truncated=true)不污染本次结果：commit 完整重读 → complete=true（R2 修复点）');
  must(commitFull.text === bigLine && commitFull.text.endsWith(TAIL_MARK),
    'commit 文本与原文件逐字一致且尾部文字存在（预检 rawText 只是前缀，不能当全部原文提交）');
  must(commitFull.sha256 === sha256Buf(Buffer.from(bigLine, 'utf8')),
    'complete=true 时 commit sha256 即整读内容哈希');
  const commitCap = readSourceForCommit(bigEntry, { maxCommitBytes: 1024 * 1024 });
  must(commitCap.ok && commitCap.stillTruncated === true && commitCap.complete === false,
    '超过 commit 上限 → complete=false 且 stillTruncated=true（D 不得声称完整入库）');

  // stale 核对一：mtime 改变（内容不动）→ stale
  const later = new Date(bigEntry.source.mtimeMs + 10000);
  fs.utimesSync(bigFile, later, later);
  const commitMtime = readSourceForCommit(bigEntry);
  must(commitMtime.ok && commitMtime.stale === true && commitMtime.staleReasons.includes('mtime'),
    `mtime 改变 → stale（reasons=${JSON.stringify(commitMtime.staleReasons)}）`);
  fs.utimesSync(bigFile, new Date(bigEntry.source.mtimeMs), new Date(bigEntry.source.mtimeMs));
  const commitControl = readSourceForCommit(bigEntry);
  must(commitControl.ok && commitControl.stale === false, 'mtime 还原后恢复新鲜（对照，证明判定来自 mtime）');

  // stale 核对二：大小变化 → stale
  fs.writeFileSync(bigFile, bigLine + '尾部追加一行', 'utf8');
  const commitSize = readSourceForCommit(bigEntry);
  must(commitSize.ok && commitSize.stale === true && commitSize.staleReasons.includes('size'),
    `大小变化 → stale（reasons=${JSON.stringify(commitSize.staleReasons)}）`);

  // stale 核对三：预检前缀改动 → stale
  fs.writeFileSync(bigFile, bigLine.slice(0, 100) + 'X' + bigLine.slice(101), 'utf8');
  const commitPrefix = readSourceForCommit(bigEntry);
  must(commitPrefix.ok && commitPrefix.stale === true && commitPrefix.staleReasons.includes('prefix'),
    `预检前缀被改动 → stale（reasons=${JSON.stringify(commitPrefix.staleReasons)}）`);

  // 前缀哈希边界（如实声明）：仅尾部改动且大小/mtime 都不变 → 前缀哈希检测不到
  // （「！」与「。」同为 3 字节 UTF-8，保证字节数不变；若字节总数变化会走 size 通道报 stale）
  const tailMod = bigLine.slice(0, -2) + '！' + bigLine.slice(-1); // 同字节长度替换末尾「。」
  fs.writeFileSync(bigFile, tailMod, 'utf8');
  fs.utimesSync(bigFile, new Date(bigEntry.source.mtimeMs), new Date(bigEntry.source.mtimeMs));
  const commitTailSilent = readSourceForCommit(bigEntry);
  must(commitTailSilent.ok && commitTailSilent.stale === false && commitTailSilent.complete === true,
    '边界：尾部同字节改动且大小/mtime不变 → 前缀哈希检测不到（报告已声明，D 须做主进程源校验/完整归档）');
  must(commitTailSilent.text.endsWith('！\n'), '此场景返回的 text 如实含被改的尾部（不谎称与预检一致）');
  // 旧计划缺 mtimeMs 时连 mtime 通道也没有 → 同样只能靠大小/前缀
  const legacyEntry = JSON.parse(JSON.stringify(bigEntry));
  legacyEntry.source.mtimeMs = null;
  fs.utimesSync(bigFile, later, later);
  const commitLegacy = readSourceForCommit(legacyEntry);
  must(commitLegacy.ok && commitLegacy.stale === false,
    '边界：legacy 计划缺 mtimeMs → mtime 通道不可用（不虚报 stale）');

  const goneEntry = JSON.parse(JSON.stringify(bigEntry));
  goneEntry.source.path = path.join(fdir, '已被删除.txt');
  const commitMissing = readSourceForCommit(goneEntry);
  must(commitMissing.ok === false && commitMissing.reason === 'missing', '源文件已删除 → ok:false');
  const pasteCommit = readSourceForCommit(r1.entries[0]);
  must(pasteCommit.ok && pasteCommit.complete === true && pasteCommit.text === text1, '粘贴来源：rawText 即完整原文');

  // 预检 source 元信息现在带 mtimeMs（stale 核对依据之一）
  const rf1b = planImport({ files: [chatFile], kind: 'chat' }, []);
  must(rf1b.entries[0].source.mtimeMs != null && Number.isFinite(rf1b.entries[0].source.mtimeMs),
    '预检 source 记录 mtimeMs（提交新鲜度核对依据）');
}

async function testExport(lib1) {
  section('便携包导出');
  const bundleDir = tmpPath('bundle-1');
  const r = await pb.exportPortableBundle({
    dataDir: lib1.lib.dataDir, filesDir: lib1.lib.filesDir, bundleDir, appVersion: '0.10.1',
  });
  must(r.ok === true, '导出成功');
  must(r.complete === false, '有外部文件未包含 + 有缺失附件 → 明确 complete=false（不说完整成功）');
  must(r.manifest && r.manifest.format === pb.FORMAT && r.manifest.format_version === 1, 'manifest 带格式与版本');
  must(r.manifest.records.length === 11, `11 个记录文件都在（实际 ${r.manifest.records.length}）`);
  must(r.manifest.attachments.length === 3, `库内 3 个附件归档（xlsx×2 + png）（实际 ${r.manifest.attachments.length}）`);
  for (const a of r.manifest.attachments) {
    const abs = path.join(bundleDir, a.path);
    must(fs.existsSync(abs) && sha256File(abs) === a.sha256, `附件实体与哈希一致：${a.path}`);
  }
  must(r.manifest.external.some((e) => path.resolve(e.path) === path.resolve(lib1.externalVideo) && !e.included && e.size > 0),
    '外链视频列入 external 未包含（带大小）');
  must(r.manifest.missing.some((m) => m.path.includes('丢失.pdf')), '缺失附件列入 missing');
  must(!fs.existsSync(path.join(bundleDir, 'external')), '默认不复制外部文件');

  // 记录文件内容抽查
  const libInBundle = JSON.parse(fs.readFileSync(path.join(bundleDir, 'records', 'library.json'), 'utf8'));
  must(Array.isArray(libInBundle) && libInBundle.length === 4, 'library.json 含 4 条资料');
  const a = libInBundle.find((x) => x.id === 'itemA');
  must(a && a.import_batches.length === 1 && a.versions.length === 1 && a.uses.length === 1, '聊天批次/修订版本/使用记录都进包');
  const ex = JSON.parse(fs.readFileSync(path.join(bundleDir, 'records', 'extracts.json'), 'utf8'));
  must(ex.length === 1 && ex[0].source_item_id === 'itemA', '摘录及来源关系进包');
  const dr = JSON.parse(fs.readFileSync(path.join(bundleDir, 'records', 'capture-drafts.json'), 'utf8'));
  must(dr && dr.quick && dr.quick.text === '草稿内容', '草稿进包');

  // 显式选入外部文件
  const bundleDir2 = tmpPath('bundle-1b');
  const r2 = await pb.exportPortableBundle({
    dataDir: lib1.lib.dataDir, filesDir: lib1.lib.filesDir, bundleDir: bundleDir2,
    includeExternalPaths: [lib1.externalVideo],
  });
  must(r2.ok && fs.existsSync(path.join(bundleDir2, 'external', '网课视频.mp4')), '显式选入的外部文件复制进 external/');
  must(r2.manifest.external.filter((e) => e.included).length === 1 && (r2.manifest.external.find((e) => e.included).refs || []).some((x) => String(x).includes('itemV')),
    '选入条目带记录引用（恢复时可改写路径）');
  must(r2.complete === false, '仍有缺失附件 → complete 仍为 false');

  // 拒绝覆盖无关目录
  const foreign = tmpPath('foreign-dir');
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'important.txt'), '用户数据');
  const r3 = await pb.exportPortableBundle({ dataDir: lib1.lib.dataDir, filesDir: lib1.lib.filesDir, bundleDir: foreign });
  must(r3.ok === false && fs.existsSync(path.join(foreign, 'important.txt')), '非本格式非空目录拒绝写入，原内容未动');

  // 覆盖重建本格式包
  const marker = path.join(bundleDir, 'records', 'library.json');
  const beforeBytes = fs.readFileSync(marker);
  const r4 = await pb.exportPortableBundle({ dataDir: lib1.lib.dataDir, filesDir: lib1.lib.filesDir, bundleDir });
  must(r4.ok && fs.readFileSync(marker).equals(beforeBytes), '同格式旧包可覆盖重建（幂等）');
  return { bundleDir };
}

async function testInspect() {
  section('只读检查 inspect（越界/符号链接/哈希损坏）');
  const good = await pb.inspectPortableBundle(tmpPath('bundle-1'));
  must(good.ok === true && good.fingerprint && good.fingerprint.length === 64, '正常包检查通过，有指纹');

  // 恢复目标库（零写入验证用）
  const lib4 = mkLib('lib4');

  // 哈希损坏
  const tampered = tmpPath('bundle-tamper');
  fs.cpSync(tmpPath('bundle-1'), tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, 'records', 'quotes.json'), 'x');
  const bad1 = await pb.inspectPortableBundle(tampered);
  must(bad1.ok === false && bad1.errors.some((e) => e.code === 'HASH_MISMATCH'), '记录被改动 → HASH_MISMATCH');
  const restoreAttempt1 = await pb.restorePortableBundle({ bundleDir: tampered, dataDir: lib4.dataDir, filesDir: lib4.filesDir });
  must(restoreAttempt1.ok === false, '损坏包恢复被拒绝');
  must(fs.readdirSync(lib4.dataDir).length === 0 && fs.readdirSync(lib4.filesDir).length === 0, '拒绝时目标库零写入');

  // 路径越界（向上跳级样本，运行期构造）
  const traversal = tmpPath('bundle-traversal');
  fs.cpSync(tmpPath('bundle-1'), traversal, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(traversal, 'manifest.json'), 'utf8'));
  must(Array.isArray(mf.attachments) && mf.attachments.length > 0, 'manifest 含附件条目（测试前置）');
  mf.attachments[0].path = EVIL_TRAVERSAL_REL;
  fs.writeFileSync(path.join(traversal, 'manifest.json'), JSON.stringify(mf));
  const bad2 = await pb.inspectPortableBundle(traversal);
  must(bad2.ok === false && bad2.errors.some((e) => e.code === 'PATH_UNSAFE'), 'manifest 带向上跳级路径 → PATH_UNSAFE');

  // 绝对目的路径
  mf.attachments[0].path = EVIL_ABSOLUTE;
  fs.writeFileSync(path.join(traversal, 'manifest.json'), JSON.stringify(mf));
  const bad3 = await pb.inspectPortableBundle(traversal);
  must(bad3.ok === false && bad3.errors.some((e) => e.code === 'PATH_UNSAFE'), '绝对目的路径 → PATH_UNSAFE');
  must(!fs.existsSync(tmpPath('escape.json')), '越界文件从未被写出');

  // 符号链接（把包内附件换成指向包外的链接，manifest 哈希同步改成真目标——必须仍然拒绝）
  const symlinked = tmpPath('bundle-symlink');
  fs.cpSync(tmpPath('bundle-1'), symlinked, { recursive: true });
  const mf2 = JSON.parse(fs.readFileSync(path.join(symlinked, 'manifest.json'), 'utf8'));
  const secretOutside = tmpPath('outside-secret.txt');
  fs.writeFileSync(secretOutside, 'outside');
  const attEntry = mf2.attachments[0];
  const linkAbs = path.join(symlinked, attEntry.path);
  fs.rmSync(linkAbs);
  fs.symlinkSync(secretOutside, linkAbs);
  attEntry.sha256 = sha256File(secretOutside);
  attEntry.size = fs.statSync(secretOutside).size;
  fs.writeFileSync(path.join(symlinked, 'manifest.json'), JSON.stringify(mf2));
  const bad4 = await pb.inspectPortableBundle(symlinked);
  must(bad4.ok === false && bad4.errors.some((e) => e.code === 'SYMLINK_OR_SPECIAL'), '包内符号链接（即使哈希对得上）→ 拒绝');

  // manifest 缺失 / 损坏
  const noManifest = tmpPath('bundle-nomanifest');
  fs.cpSync(tmpPath('bundle-1'), noManifest, { recursive: true });
  fs.rmSync(path.join(noManifest, 'manifest.json'));
  const bad5 = await pb.inspectPortableBundle(noManifest);
  must(bad5.ok === false && bad5.errors[0].code === 'NO_MANIFEST', 'manifest 缺失（半截包）→ NO_MANIFEST');
  fs.writeFileSync(path.join(noManifest, 'manifest.json'), '{not json');
  const bad6 = await pb.inspectPortableBundle(noManifest);
  must(bad6.ok === false && bad6.errors[0].code === 'BAD_MANIFEST', 'manifest 损坏 → BAD_MANIFEST');
}

async function testRestore(lib1) {
  section('恢复 restore（迁移/重复恢复/路径改写/回滚）');
  const lib2 = mkLib('lib2'); // 模拟另一台机器的隔离库
  const r = await pb.restorePortableBundle({ bundleDir: tmpPath('bundle-1'), dataDir: lib2.dataDir, filesDir: lib2.filesDir });
  must(r.ok === true, '恢复成功');
  must(r.added === 4 && r.skipped === 0, `4 条资料全部新增（added=${r.added}）`);
  must(r.counts.attachmentsRestored === 3, `3 个附件落位（${r.counts.attachmentsRestored}）`);
  must(r.complete === false && r.counts.missingInManifest === 1 && r.counts.externalNotIncluded === 1,
    '恢复结果如实带回缺失/未包含计数');

  // 迁移后附件可打开：路径已改写到新库
  const lib2Items = JSON.parse(fs.readFileSync(path.join(lib2.dataDir, 'library.json'), 'utf8'));
  const a2 = lib2Items.find((x) => x.id === 'itemA');
  const b2 = lib2Items.find((x) => x.id === 'itemB');
  must(a2.files[0].path.startsWith(lib2.filesDir) && fs.existsSync(a2.files[0].path), 'itemA 附件路径已改写到新库且存在');
  must(sha256File(a2.files[0].path) === sha256File(lib1.attA.path), 'itemA 附件内容一致（哈希相同）');
  must(b2.files[0].path.startsWith(lib2.filesDir) && fs.existsSync(b2.files[0].path), 'itemB 附件路径已改写且存在');
  must(sha256File(b2.files[0].path) === sha256File(lib1.attB.path), '同名不同内容附件 B 内容一致（未被 A 覆盖）');
  must(a2.files[0].path !== b2.files[0].path, '同名不同内容附件各自独立存放');
  must(a2.images[0].file.startsWith(lib2.filesDir) && fs.existsSync(a2.images[0].file), '图片附件路径改写且存在');
  must(a2.messages[0].attachment.path.startsWith(lib2.filesDir) && a2.messages[0].attachment.pending === false,
    '消息级附件路径改写且不再是待补状态');

  // 关系与结构保留：稳定 ID / 批次 / 摘录 / 版本 / 金句引用
  must(JSON.stringify(a2.messages.map((m) => m.id)) === JSON.stringify(['mAAA111', 'mBBB222', 'mCCC333']), '聊天稳定消息 ID 原样迁移');
  must(a2.import_batches.length === 1 && a2.import_batches[0].id === 'batch-1', '聊天批次保留');
  must(a2.message_edits.length === 1, '消息修订记录保留');
  must(a2.versions.length === 1 && a2.versions[0].id === 'ver-1', '版本历史保留');
  const ex2 = JSON.parse(fs.readFileSync(path.join(lib2.dataDir, 'extracts.json'), 'utf8'));
  must(ex2[0].source_item_id === 'itemA' && lib2Items.some((x) => x.id === 'itemA'), '摘录 → 资料来源关系有效');
  must(ex2[0].source_message_ids[0] === 'mAAA111', '摘录 → 消息级来源有效');
  const ideas2 = JSON.parse(fs.readFileSync(path.join(lib2.dataDir, 'ideas.json'), 'utf8'));
  must(ideas2[0].related_item_ids.includes('itemA') && ideas2[0].source_message_ids.includes('mAAA111'), '点子关联关系有效');
  const quotes2 = JSON.parse(fs.readFileSync(path.join(lib2.dataDir, 'quotes.json'), 'utf8'));
  must(quotes2.find((q) => q.id === 'q1').links.includes('q2'), '金句双向引用有效');
  must(fs.existsSync(path.join(lib2.dataDir, 'srs-cards.json')), '复习卡记录文件已写入');

  // 重复恢复：不复制条目
  const r2 = await pb.restorePortableBundle({ bundleDir: tmpPath('bundle-1'), dataDir: lib2.dataDir, filesDir: lib2.filesDir });
  must(r2.ok === true && r2.added === 0 && r2.skipped === 4, `重复恢复 added=0 skipped=4（实际 added=${r2.added} skipped=${r2.skipped}）`);
  must(r2.counts.attachmentsRestored === 0 && r2.counts.attachmentsReused === 3 && r2.conflicts.length === 0,
    `重复恢复附件零复制、全复用（restored=${r2.counts.attachmentsRestored} reused=${r2.counts.attachmentsReused}）`);
  const lib2ItemsAfter = JSON.parse(fs.readFileSync(path.join(lib2.dataDir, 'library.json'), 'utf8'));
  must(lib2ItemsAfter.length === 4, '重复恢复不复制条目');

  // 同 ID 保留当前
  const lib3 = mkLib('lib3');
  writeRecords(lib3, { items: [{ id: 'itemA', kind: 'chat', title: '本地已改过的标题', messages: [], files: [], images: [], import_batches: [] }] });
  const r3 = await pb.restorePortableBundle({ bundleDir: tmpPath('bundle-1'), dataDir: lib3.dataDir, filesDir: lib3.filesDir });
  const lib3Items = JSON.parse(fs.readFileSync(path.join(lib3.dataDir, 'library.json'), 'utf8'));
  must(r3.ok && lib3Items.find((x) => x.id === 'itemA').title === '本地已改过的标题', '同 ID 冲突保留当前（mergeBackup 规则）');
  must(r3.added === 3, `其余 3 条正常新增（added=${r3.added}）`);

  // 中途失败回滚：附件已复制 → JSON 写库失败 → 附件回滚 + JSON 不变
  const lib5 = mkLib('lib5');
  writeRecords(lib5, { items: [] });
  const lib5JsonBefore = fs.readFileSync(path.join(lib5.dataDir, 'library.json'));
  const lib5FilesBefore = fs.readdirSync(lib5.filesDir).length;
  fs.chmodSync(lib5.dataDir, 0o555); // 让恢复写库一步失败（目录只读）
  let r5 = null;
  let rollbackErr = null;
  try { r5 = await pb.restorePortableBundle({ bundleDir: tmpPath('bundle-1'), dataDir: lib5.dataDir, filesDir: lib5.filesDir }); }
  catch (e) { rollbackErr = e; }
  fs.chmodSync(lib5.dataDir, 0o755);
  must(rollbackErr === null, '恢复失败以结果返回而不是抛出（调用方可提示用户）', rollbackErr && String(rollbackErr));
  must(r5 && r5.ok === false, 'JSON 写库失败 → ok:false');
  must(r5 && r5.rolledBackAttachments > 0, `回滚了 ${r5 && r5.rolledBackAttachments} 个已复制附件`);
  must(fs.readFileSync(path.join(lib5.dataDir, 'library.json')).equals(lib5JsonBefore), '失败后 JSON 与恢复前逐字节一致');
  must(fs.readdirSync(lib5.filesDir).length === lib5FilesBefore, '失败后附件目录无残留');
  must(!fs.readdirSync(lib5.filesDir).some((n) => n.startsWith('.restore-stage')), '暂存目录已清理');

  // 外部选入文件随包恢复
  const lib6 = mkLib('lib6');
  const r6 = await pb.restorePortableBundle({ bundleDir: tmpPath('bundle-1b'), dataDir: lib6.dataDir, filesDir: lib6.filesDir });
  const lib6Items = JSON.parse(fs.readFileSync(path.join(lib6.dataDir, 'library.json'), 'utf8'));
  const v6 = lib6Items.find((x) => x.id === 'itemV');
  must(r6.ok && v6.source_path.startsWith(path.join(lib6.filesDir, 'external-restored')) && fs.existsSync(v6.source_path),
    '显式选入的外部文件恢复到新库且 source_path 已改写、文件可打开');

  // 缺失附件恢复：不谎报完整
  must(r6.complete === false && r6.counts.missingInManifest === 1, '缺附件的包恢复后 complete=false（不谎报）');
}

// ---------- R1：同路径异内容冲突 / external 冲突 / complete 重算 / 落位失败回滚 ----------
async function testConflictAndContract() {
  section('同路径异内容冲突（OLD/NEW，逐字节读回验证）');

  // 源库：itemNEW 引用 uid-x/foo.txt（内容 NEW）
  const libNEW = mkLib('libNEW');
  const fooNew = archiveTo(libNEW, 'uid-x', Buffer.from('NEW-CONTENT-v2\n', 'utf8'), 'foo.txt');
  writeRecords(libNEW, { items: [{
    id: 'itemNEW', kind: 'file', title: '包内新条目',
    files: [{ path: fooNew.path, name: 'foo.txt', ext: 'txt', size: fooNew.size }],
    images: [], messages: [], import_batches: [],
  }] });
  const bundle7 = tmpPath('bundle-7');
  const ex7 = await pb.exportPortableBundle({ dataDir: libNEW.dataDir, filesDir: libNEW.filesDir, bundleDir: bundle7 });
  must(ex7.ok && ex7.manifest.attachments.length === 1, '冲突场景包导出成功（1 个附件）');

  // 目标库：同相对路径 uid-x/foo.txt 已有内容 OLD + 旧记录 itemOLD
  const lib7 = mkLib('lib7');
  const oldDir = path.join(lib7.filesDir, 'uid-x');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldPath = path.join(oldDir, 'foo.txt');
  fs.writeFileSync(oldPath, 'OLD-CONTENT-v1\n');
  writeRecords(lib7, { items: [{
    id: 'itemOLD', kind: 'file', title: '本地旧条目',
    files: [{ path: oldPath, name: 'foo.txt', ext: 'txt', size: 15 }],
    images: [], messages: [], import_batches: [],
  }] });
  const oldBytes = fs.readFileSync(oldPath);

  const r = await pb.restorePortableBundle({ bundleDir: bundle7, dataDir: lib7.dataDir, filesDir: lib7.filesDir });
  must(r.ok === true, '恢复成功');
  must(r.counts.attachmentConflictsRemapped === 1, `异内容冲突被识别并重映射（${r.counts.attachmentConflictsRemapped}）`);

  const items7 = JSON.parse(fs.readFileSync(path.join(lib7.dataDir, 'library.json'), 'utf8'));
  const oldItem = items7.find((x) => x.id === 'itemOLD');
  const newItem = items7.find((x) => x.id === 'itemNEW');
  must(oldItem.files[0].path === oldPath, '旧记录路径一字未改');
  must(fs.readFileSync(oldItem.files[0].path).equals(oldBytes) && fs.readFileSync(oldItem.files[0].path).toString() === 'OLD-CONTENT-v1\n',
    '旧记录实际读到 OLD 内容（逐字节）');
  must(newItem.files[0].path !== oldPath, '新记录不再指向目标旧文件（P1 修复点）');
  must(fs.readFileSync(newItem.files[0].path).toString() === 'NEW-CONTENT-v2\n', '新记录实际读到 NEW 内容（逐字节，非计数断言）');
  must(path.basename(newItem.files[0].path).includes('from-bundle-'), '重映射路径按内容哈希命名');

  // 再次恢复：幂等——不新增附件/记录，路径稳定，OLD/NEW 各自不变
  const dirCountBefore = fs.readdirSync(oldDir).length;
  const itemsCountBefore = items7.length;
  const r2 = await pb.restorePortableBundle({ bundleDir: bundle7, dataDir: lib7.dataDir, filesDir: lib7.filesDir });
  const items7b = JSON.parse(fs.readFileSync(path.join(lib7.dataDir, 'library.json'), 'utf8'));
  must(r2.ok && r2.added === 0 && items7b.length === itemsCountBefore, '再次恢复 added=0、不新增记录');
  must(fs.readdirSync(oldDir).length === dirCountBefore, '再次恢复不新增附件文件');
  const oldAgain = items7b.find((x) => x.id === 'itemOLD');
  const newAgain = items7b.find((x) => x.id === 'itemNEW');
  must(newAgain.files[0].path === newItem.files[0].path, '再次恢复新记录路径稳定不变');
  must(fs.readFileSync(oldAgain.files[0].path).toString() === 'OLD-CONTENT-v1\n', '再次恢复后旧记录仍读 OLD');
  must(fs.readFileSync(newAgain.files[0].path).toString() === 'NEW-CONTENT-v2\n', '再次恢复后新记录仍读 NEW');

  section('external 选入文件同类冲突');
  const libNEW2 = mkLib('libNEW2');
  const v2src = tmpPath('libNEW2-external', 'v2.mp4');
  fs.mkdirSync(path.dirname(v2src), { recursive: true });
  fs.writeFileSync(v2src, 'VIDEO-NEW-BYTES');
  writeRecords(libNEW2, { items: [{ id: 'itemV2', kind: 'video', source_path: v2src, files: [], images: [], messages: [], import_batches: [] }] });
  const bundle8 = tmpPath('bundle-8');
  await pb.exportPortableBundle({ dataDir: libNEW2.dataDir, filesDir: libNEW2.filesDir, bundleDir: bundle8, includeExternalPaths: [v2src] });

  const lib9 = mkLib('lib9');
  const extDir = path.join(lib9.filesDir, 'external-restored');
  fs.mkdirSync(extDir, { recursive: true });
  const existingV = path.join(extDir, 'v2.mp4');
  fs.writeFileSync(existingV, 'VIDEO-OLD-BYTES');
  const rExt = await pb.restorePortableBundle({ bundleDir: bundle8, dataDir: lib9.dataDir, filesDir: lib9.filesDir });
  const items9 = JSON.parse(fs.readFileSync(path.join(lib9.dataDir, 'library.json'), 'utf8'));
  const v2item = items9.find((x) => x.id === 'itemV2');
  must(rExt.ok && fs.readFileSync(existingV).toString() === 'VIDEO-OLD-BYTES', 'external 冲突：本地旧文件未覆盖');
  must(v2item.source_path !== existingV && fs.readFileSync(v2item.source_path).toString() === 'VIDEO-NEW-BYTES',
    'external 冲突：新记录实际读到 NEW 内容');

  section('complete 按实际缺失重算（不照抄源包标记）');
  const lib10 = mkLib('lib10');
  const bundleT = tmpPath('bundle-1-tamper-complete');
  fs.cpSync(tmpPath('bundle-1'), bundleT, { recursive: true });
  const mf3 = JSON.parse(fs.readFileSync(path.join(bundleT, 'manifest.json'), 'utf8'));
  mf3.counts.complete = true; // 恶意/损坏的源包标记
  fs.writeFileSync(path.join(bundleT, 'manifest.json'), JSON.stringify(mf3));
  const rC = await pb.restorePortableBundle({ bundleDir: bundleT, dataDir: lib10.dataDir, filesDir: lib10.filesDir });
  must(rC.ok === true && rC.complete === false && rC.counts.missingInManifest === 1 && rC.counts.externalNotIncluded === 1,
    '源包标记被篡改 complete=true，恢复结果仍如实 complete=false');

  section('落位中途失败：附件回滚 + 记录一字不写');
  const lib11 = mkLib('lib11');
  writeRecords(lib11, { items: [] });
  const lib11JsonBefore = fs.readFileSync(path.join(lib11.dataDir, 'library.json'));
  // bundle-1 附件顺序：uid-a（itemA files）→ extract（itemA images）→ uid-b（itemB files）
  // 预置只读的 uid-b 目录，让前两个先成功落位、最后一个失败
  const roDir = path.join(lib11.filesDir, 'uid-b');
  fs.mkdirSync(roDir, { recursive: true });
  fs.chmodSync(roDir, 0o555);
  let rF = null;
  let errF = null;
  try { rF = await pb.restorePortableBundle({ bundleDir: tmpPath('bundle-1'), dataDir: lib11.dataDir, filesDir: lib11.filesDir }); }
  catch (e) { errF = e; }
  fs.chmodSync(roDir, 0o755);
  must(errF === null && rF && rF.ok === false, '落位失败以结果返回而不抛出', errF && String(errF));
  must(rF && rF.rolledBackAttachments === 2, `回滚了先落位的 ${rF && rF.rolledBackAttachments} 个附件`);
  must(fs.readFileSync(path.join(lib11.dataDir, 'library.json')).equals(lib11JsonBefore),
    '落位失败 → 记录一字未写（无悬空/指错引用）');
  must(!fs.existsSync(path.join(lib11.filesDir, 'uid-a')) && !fs.existsSync(path.join(lib11.filesDir, 'extract')),
    '先落位的附件连同空目录已回滚');
  must(!fs.readdirSync(lib11.filesDir).some((n) => n.startsWith('.restore-stage')), '暂存已清理');
}

async function main() {
  console.log(`临时目录：${TMP}`);
  const lib1 = buildLibrary1();
  await testImportPlan();
  await testExport(lib1);
  await testInspect();
  await testRestore(lib1);
  await testConflictAndContract();

  // 汇总
  console.log(`\n${'='.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`全部通过：${total} 项断言`);
  } else {
    console.log(`失败 ${failures.length}/${total}：`);
    for (const f of failures) console.log('  ✗ ' + f);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('（临时目录清理失败，可手动删：' + TMP + '）'); }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试进程异常：', e); process.exit(1); });
