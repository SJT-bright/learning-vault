#!/usr/bin/env node
/** v0.10 数据层完整场景（临时目录，不启动 Electron，不碰真实资料库） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, uid } = require('../src/db');
const { parseChatText } = require('../src/chat-parse');
const chatOps = require('../src/chat-ops');
const { ExtractStore } = require('../src/extracts');
const usage = require('../src/usage');
const ideas = require('../src/ideas');
const { weekOutcomes, outcomesMarkdown } = require('../src/outcomes');
const { migrateAll } = require('../src/migrate');
const { DraftStore } = require('../src/drafts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-flow-'));
const dataDir = path.join(tmp, 'data');
const filesDir = path.join(tmp, 'files');
fs.mkdirSync(filesDir, { recursive: true });
const store = new Store(dataDir);
const extractStore = new ExtractStore(path.join(dataDir, 'extracts.json'));
let ideaItems = [];
const drafts = new DraftStore(path.join(dataDir, 'capture-drafts.json'));
const steps = [];
const step = (name, pass, extra) => { steps.push({ name, pass: !!pass, extra }); console.log((pass ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : '')); };

try {
  drafts.save('quick', { text: '一条还没提交的想法', files: [path.join(tmp, 'missing.png')] });
  const d = drafts.get('quick');
  step('草稿保存后重开仍在，失效附件有标记', d && d.text.includes('还没提交') && d.hasMissing);
  drafts.clear('quick');
  step('保存成功后清草稿', !drafts.get('quick'));

  const note = store.insert({ kind: 'note', title: '九宫格提示词', notes: '先环境后人物，再写动作。' });
  step('记下想法', !!note.id);

  const chat1 = '阿宁 09:12\n这个分镜方法可以复用，先画九宫格再写提示词\n[文件] 九宫格模板.pdf\n---\n我 09:14\n收到，我下午试一次';
  const chat2 = chat1 + '\n---\n阿宁 10:02\n试完把结果记下来\n---\n我 11:20\n收到，我下午试一次';
  const msgs1 = chatOps.ensureMessageIds(parseChatText(chat1));
  const chatItem = store.insert({
    kind: 'chat', title: '分镜方法讨论', notes: chat1, raw_text: chat1, messages: msgs1,
    import_batches: [{ id: uid(), imported_at: Date.now(), raw_text: chat1, added_ids: msgs1.map(m => m.id) }],
  });
  step('导入聊天保留原文和待补附件', chatItem.raw_text.includes('九宫格') && chatOps.pendingAttachments(chatItem.messages).length === 1);

  const plan = chatOps.planAppend(chatItem.messages, parseChatText(chat2));
  store.update(chatItem.id, { messages: plan.messages, raw_text: chat1 + '\n\n----\n\n' + chat2 });
  const after = store.get(chatItem.id);
  step('追加：新内容保留，同文不同时间仍在', plan.counts.added >= 1 && (after.messages || []).filter(m => (m.text || '').includes('收到，我下午试一次')).length >= 2 && after.raw_text.includes('试完'));

  const fakePdf = path.join(filesDir, '九宫格模板.pdf');
  fs.writeFileSync(fakePdf, '%PDF-1.4 fake');
  const fill = chatOps.fillAttachment(after.messages, '九宫格模板.pdf', { path: fakePdf, name: '九宫格模板.pdf', pending: false });
  store.update(after.id, { messages: after.messages, files: [{ path: fakePdf, name: '九宫格模板.pdf' }] });
  step('补附件后路径可打开', fill.ok && fs.existsSync(fakePdf) && !(store.get(after.id).messages.find(m => m.attachment && m.attachment.name === '九宫格模板.pdf') || {}).attachment.pending);

  const methodMsg = store.get(after.id).messages.find(m => (m.text || '').includes('九宫格'));
  const ex = extractStore.add({ kind: 'method', title: '九宫格分镜法', body: '先画九宫格再写提示词', source_item_id: after.id, source_message_ids: [methodMsg.id], source_text: methodMsg.text });
  const ex2 = extractStore.add({ kind: 'method', title: '九宫格分镜法', body: '先画九宫格再写提示词', source_item_id: after.id, source_message_ids: [methodMsg.id], source_text: methodMsg.text });
  step('提取方法且可回溯，重复保存不双份', ex.ok && ex2.deduped && extractStore.byItem(after.id)[0].source_message_ids[0] === methodMsg.id);

  const idea = ideas.migrateIdea({
    id: uid(), text: '用九宫格做一条 coding 视频', created_at: Date.now(),
    status: 'try', this_week: true, next_action: '先出 3 个分镜', related_item_ids: [after.id, note.id],
  });
  ideaItems.push(idea);
  usage.addUse(note, { purpose: '写一条视频提示词', result: '出片更快' });
  usage.addImprovement(note, { problem: '人物漂', change: '锁定服装', reason: '上次不一致', fullVersion: '先环境后人物，服装锁定，再写动作。' });
  store.save();
  ideas.setStatus(idea, 'done'); idea.result_note = '15 秒样片';
  step('使用、改进版本、点子落实', note.use_count === 1 && usage.currentContent(note).includes('服装锁定') && idea.status === 'done');

  const parked = ideas.migrateIdea({ id: uid(), text: '搁置灵感', created_at: Date.now() - 40 * 86400000, status: 'parked' });
  step('搁置不催促', !ideas.nudgeDue(parked) && ideas.staleness(parked) === 0);

  const oc = weekOutcomes({ items: store.allItems(), allItems: store.allItems(), ideas: ideaItems, from: Date.now() - 86400000, to: Date.now() + 1000 });
  step('周复盘成果来自真实记录', oc.uses.length >= 1 && oc.ideasDone.length >= 1 && outcomesMarkdown(oc).includes('样片'));

  const old = [{ id: 'old1', text: '旧完成', done: true, created_at: 1 }, { id: 'old2', text: '旧未完成', done: false, created_at: 2 }];
  ideaItems = old;
  const mig = migrateAll({ store, ideaItems, dataDir });
  migrateAll({ store, ideaItems: mig.ideas, dataDir });
  step('旧数据迁移可重复执行', mig.ideas[0].status === 'done' && mig.ideas[1].status === 'clarify' && mig.ideas.length === 2);

  const locked = store.insert({ kind: 'note', title: '手动分类', category: '产品设计', category_locked: true, notes: '分镜' });
  step('人工分类字段已落库', locked.category_locked === true);

  const failed = steps.filter(s => !s.pass);
  console.log(failed.length ? '\nFLOW_SCENARIO_FAIL ' + failed.map(s => s.name).join('; ') : '\nFLOW_SCENARIO_OK ' + steps.length);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error(e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
