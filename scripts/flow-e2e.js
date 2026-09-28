/**
 * v0.10 完整场景验证（Electron，LV_CONFIG_DIR 隔离，不碰真实资料库）
 * 记录想法 → 导入聊天 → 追加 → 补附件 → 提取方法 → 关联点子 →
 * 记使用 → 改进版本 → 点子落实 → 周复盘；并截关键界面。
 */
const fs = require('fs');
const path = require('path');
const { parseChatText } = require('../src/chat-parse');
const chatOps = require('../src/chat-ops');
const usage = require('../src/usage');
const { weekOutcomes, outcomesMarkdown } = require('../src/outcomes');
const ideas = require('../src/ideas');
const { uid } = require('../src/db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, file) {
  if (!win || win.isDestroyed()) return false;
  try {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    const r = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return fs.existsSync(file) && fs.statSync(file).size > 1000;
  } catch (e) {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(file, img.toPNG());
      return fs.existsSync(file) && fs.statSync(file).size > 1000;
    } catch {
      return false;
    }
  }
}

async function run(ctx) {
  const {
    store, extractStore, ideaItems, saveIdeas, filesDir,
    win, createQuickWin, createIdeaWin, generateAndSaveReview,
  } = ctx;
  const outDir = path.join(__dirname, '..', '交付物', 'v0.10-screens');
  fs.mkdirSync(outDir, { recursive: true });
  const r = { ok: true, steps: [], shots: [], errors: [] };
  const step = (name, pass, extra) => { r.steps.push({ name, pass, extra }); if (!pass) r.ok = false; };

  try {
    const chat1 = '阿宁 09:12\n这个分镜方法可以复用，先画九宫格再写提示词\n[文件] 九宫格模板.pdf\n---\n我 09:14\n收到，我下午试一次';
    const chat2 = '阿宁 09:12\n这个分镜方法可以复用，先画九宫格再写提示词\n[文件] 九宫格模板.pdf\n---\n我 09:14\n收到，我下午试一次\n---\n阿宁 10:02\n试完把结果记下来\n---\n我 09:14\n收到，我下午试一次';

    const note = store.insert({ kind: 'note', title: '九宫格提示词', notes: '先环境后人物，再写动作。' });
    step('记下想法', !!note.id);

    const msgs1 = chatOps.ensureMessageIds(parseChatText(chat1));
    const chatItem = store.insert({
      kind: 'chat', title: '分镜方法讨论', notes: chat1, raw_text: chat1, messages: msgs1,
      import_batches: [{ id: uid(), imported_at: Date.now(), raw_text: chat1, added_ids: msgs1.map(m => m.id), counts: { added: msgs1.length, duplicate: 0, possible: 0 } }],
    });
    step('导入聊天并保留原文', chatItem.raw_text.includes('九宫格') && chatOps.pendingAttachments(chatItem.messages).length === 1);

    const plan = chatOps.planAppend(chatItem.messages, parseChatText(chat2));
    store.update(chatItem.id, {
      messages: plan.messages,
      raw_text: chat1 + '\n\n----\n\n' + chat2,
      import_batches: [...(store.get(chatItem.id).import_batches || []), {
        id: uid(), imported_at: Date.now(), raw_text: chat2,
        added_ids: plan.added.map(m => m.id), counts: plan.counts,
      }],
    });
    const after = store.get(chatItem.id);
    const sameTextDiff = (after.messages || []).filter(m => (m.text || '').includes('收到，我下午试一次'));
    step('追加去重：新增保留且同文不同时间可并存', plan.counts.added >= 1 && sameTextDiff.length >= 1 && after.raw_text.includes('试完'));

    const fakePdf = path.join(filesDir, '九宫格模板.pdf');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(fakePdf, '%PDF-1.4 fake');
    const pend = chatOps.pendingAttachments(after.messages);
    const fill = chatOps.fillAttachment(after.messages, '九宫格模板.pdf', { path: fakePdf, name: '九宫格模板.pdf', pending: false });
    store.update(after.id, { messages: after.messages, files: [{ path: fakePdf, name: '九宫格模板.pdf', ext: 'pdf', size: 12 }] });
    const filledMsg = store.get(after.id).messages.find(m => m.attachment && m.attachment.path === fakePdf);
    step('待补附件补齐后可打开', fill.ok && filledMsg && fs.existsSync(filledMsg.attachment.path) && !filledMsg.attachment.pending);

    const methodMsg = store.get(after.id).messages.find(m => (m.text || '').includes('九宫格'));
    const ex = extractStore.add({
      kind: 'method', title: '九宫格分镜法', body: '先画九宫格再写提示词',
      source_item_id: after.id, source_message_ids: methodMsg ? [methodMsg.id] : [], source_text: methodMsg && methodMsg.text,
    });
    const ex2 = extractStore.add({
      kind: 'method', title: '九宫格分镜法', body: '先画九宫格再写提示词',
      source_item_id: after.id, source_message_ids: methodMsg ? [methodMsg.id] : [], source_text: methodMsg && methodMsg.text,
    });
    step('提取方法且幂等', ex.ok && ex2.deduped && extractStore.byItem(after.id).length === 1);

    const idea = ideas.migrateIdea({
      id: uid(), text: '用九宫格做一条 coding 视频', note: '来自聊天', created_at: Date.now(),
      status: 'try', this_week: true, next_action: '先出 3 个分镜', related_item_ids: [after.id, note.id],
    });
    ideaItems.push(idea); saveIdeas();
    step('点子关联资料并填写下一步', idea.related_item_ids.length === 2 && idea.next_action);

    usage.addUse(note, { purpose: '写一条视频提示词', result: '出片更快，但人物一致性还差' });
    usage.addImprovement(note, { problem: '人物一致性差', change: '锁定服装与镜头', reason: '上次出片漂了', fullVersion: '先环境后人物，服装锁定，再写动作。' });
    store.save();
    step('使用记录 + 改进版本', note.use_count === 1 && usage.currentContent(note).includes('服装锁定') && note.versions.length >= 2);

    ideas.setStatus(idea, 'done');
    idea.result_note = '做出了 15 秒样片';
    saveIdeas();
    step('点子标记已落实', ideas.ideaStatus(idea) === 'done');

    const parked = ideas.migrateIdea({ id: uid(), text: '以后再做的灵感', created_at: Date.now() - 40 * 86400000, status: 'parked' });
    step('搁置不再催促', !ideas.nudgeDue(parked, Date.now()) && ideas.staleness(parked) === 0);

    const oc = weekOutcomes({
      items: store.allItems(), allItems: store.allItems(), ideas: ideaItems,
      from: Date.now() - 7 * 86400000, to: Date.now() + 1000,
    });
    const md = outcomesMarkdown(oc);
    step('周复盘含真实使用和改进成果', oc.uses.length >= 1 && oc.ideasDone.length >= 1 && md.includes('九宫格') && !md.includes('学会了'));

    if (typeof generateAndSaveReview === 'function') {
      const rev = await generateAndSaveReview('weekly');
      step('周复盘可生成', !!(rev && (rev.ok || rev.text)));
    }

    if (win && !win.isDestroyed()) {
      win.show(); win.focus();
      await win.webContents.executeJavaScript('window.vault && window.vault.list ? window.vault.list({limit:20}).then(()=>{location.reload?null:0}):0').catch(() => {});
      await sleep(800);
      const s1 = path.join(outDir, '01-main.png');
      step('截图-主窗', await shot(win, s1)); r.shots.push(s1);

      await win.webContents.executeJavaScript(`
        (async () => {
          const items = await window.vault.list({limit:50});
          const chat = (items.items||[]).find(i => i.kind==='chat');
          if (chat) {
            const cards = document.querySelectorAll('.card');
            for (const c of cards) if (c.dataset.id === chat.id) c.click();
          }
        })()
      `).catch(() => {});
      await sleep(700);
      const s2 = path.join(outDir, '02-chat-detail.png');
      step('截图-聊天详情', await shot(win, s2)); r.shots.push(s2);

      await win.webContents.executeJavaScript(`
        (async () => {
          const items = await window.vault.list({kind:'note', limit:20});
          const note = (items.items||[]).find(i => (i.title||'').includes('提示词'));
          if (note) {
            const cards = document.querySelectorAll('.card');
            for (const c of cards) if (c.dataset.id === note.id) c.click();
          }
        })()
      `).catch(() => {});
      await sleep(700);
      const s3 = path.join(outDir, '03-note-usage.png');
      step('截图-使用与版本', await shot(win, s3)); r.shots.push(s3);
    }

    if (typeof createQuickWin === 'function') {
      createQuickWin('note');
      await sleep(900);
      const qwin = ctx.quickWin && ctx.quickWin();
      if (qwin && !qwin.isDestroyed()) {
        const s4 = path.join(outDir, '04-quick.png');
        step('截图-随手记', await shot(qwin, s4)); r.shots.push(s4);
      } else step('截图-随手记', false, '窗口未打开');
    }

    if (typeof createIdeaWin === 'function') {
      createIdeaWin();
      await sleep(900);
      const iwin = ctx.ideaWin && ctx.ideaWin();
      if (iwin && !iwin.isDestroyed()) {
        const s5 = path.join(outDir, '05-ideas.png');
        step('截图-点子', await shot(iwin, s5)); r.shots.push(s5);
      } else step('截图-点子', false, '窗口未打开');
    }
  } catch (e) {
    r.ok = false;
    r.errors.push(String(e && e.stack ? e.stack : e));
  }

  const failed = r.steps.filter(s => !s.pass);
  r.ok = r.ok && failed.length === 0;
  return r;
}

module.exports = { run };
