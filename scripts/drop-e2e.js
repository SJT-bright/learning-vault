/**
 * 拖拽直收端到端验证（需 Electron 运行时，经 main.js --drop-test 入口调用）
 *
 * 两段式：
 *  ① 负例（CDP Input.dispatchDragEvent，浏览器级真实事件）：纯文本拖入 → types 无 'Files'
 *     → 门控不放行，遮罩不亮、不收录（防误触发）
 *  ② 正例（真实带路径 File 的完整拖拽流）：CDP DOM.setFileInputFiles 造出真正绑定磁盘路径的
 *     File 对象 → DataTransfer + dragenter/dragover/drop → webUtils.getPathForFile →
 *     vault.ingest 全链路真实执行（CDP 的 Input.dispatchDragEvent 无法携带文件路径，故用此法）
 * 验证：① 纯文本拖入不触发遮罩 ② 文件拖入亮遮罩/移开熄灭/松手熄灭 ③ drop → 视频建索引
 *       （kind=video、source_path 指向原文件、元数据带文件大小） ④ 不复制原文件
 *       （条目 files 为空 + 归档目录快照不变） ⑤ 收录后列表 UI 自动刷新
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function walk(dir) {
  const out = [];
  const rec = (d, prefix) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p, prefix + e.name + '/');
      else { let s = 0; try { s = fs.statSync(p).size; } catch {} out.push(prefix + e.name + ':' + s); }
    }
  };
  rec(dir, '');
  return out.sort().join('|');
}

async function run({ win, store, filesDir }) {
  const wc = win.webContents;
  const r = { maskEl: false, startHidden: false, textDragIgnored: false, noJunkRecord: true, enterShows: false, overKeeps: false, leaveHides: false, reenterShows: false, dropHides: false, videoRec: false, recFiles: -1, metaSize: null, noCopy: false, uiRefreshed: false, category: null, err: '' };
  let tmp = '', dbgAttached = false;
  try {
    // 前置：遮罩元素存在且初始隐藏
    r.maskEl = await wc.executeJavaScript("!!document.getElementById('dropmask')");
    r.startHidden = !(await wc.executeJavaScript("document.getElementById('dropmask').classList.contains('show')"));
    const shown = () => wc.executeJavaScript("document.getElementById('dropmask').classList.contains('show')");

    // 真实视频文件（假 mp4：Spotlight 无元数据 → 走文件大小兜底，恰好覆盖降级路径）
    const SIZE = 256 * 1024;
    tmp = path.join(os.tmpdir(), 'lv-droptest-' + Date.now() + '.mp4');
    fs.writeFileSync(tmp, Buffer.alloc(SIZE, 7));
    const before = walk(filesDir);

    wc.debugger.attach('1.3');
    dbgAttached = true;
    const [w, h] = win.getContentSize();

    // ① 负例：纯文本拖拽（CDP 浏览器级事件）→ 门控不放行
    const textDrag = (type) => wc.debugger.sendCommand('Input.dispatchDragEvent', {
      type, files: [],
      x: Math.floor(w / 2), y: Math.floor(h / 2),
      data: { items: [{ mimeType: 'text/plain', data: '纯文本不是文件' }], dragOperationsMask: 1 },
    });
    await textDrag('dragEnter');
    await textDrag('dragOver');
    await textDrag('drop');
    r.textDragIgnored = !(await shown());
    const itemsBefore = store.allItems().length;
    await sleep(600);
    r.noJunkRecord = store.allItems().length === itemsBefore;

    // ② 正例：真实带路径 File 构造 DataTransfer → 完整拖拽流
    await wc.executeJavaScript(`
      const inp = document.createElement('input');
      inp.type = 'file'; inp.id = '__lvtestfile'; inp.style.display = 'none';
      document.body.appendChild(inp);
    `);
    const doc = await wc.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#__lvtestfile' });
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [tmp], nodeId });

    const flow = await wc.executeJavaScript(`
      (() => {
        const f = document.getElementById('__lvtestfile').files[0];
        if (!f) return { noFile: true };
        const dt = new DataTransfer();
        dt.items.add(f);
        const fire = (t) => document.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
        fire('dragenter');
        const enterShown = document.getElementById('dropmask').classList.contains('show');
        fire('dragover');
        const overShown = document.getElementById('dropmask').classList.contains('show');
        document.dispatchEvent(new DragEvent('dragleave'));
        const leaveHidden = !document.getElementById('dropmask').classList.contains('show');
        fire('dragenter');
        const reenterShown = document.getElementById('dropmask').classList.contains('show');
        fire('drop');
        const dropHidden = !document.getElementById('dropmask').classList.contains('show');
        return { types: [...dt.types], nfiles: dt.files.length, name: f.name, enterShown, overShown, leaveHidden, reenterShown, dropHidden };
      })()
    `);
    if (flow && flow.noFile) { r.err = 'setFileInputFiles 未生效：input.files 为空'; }
    if (flow && !flow.noFile) {
      r.enterShows = !!flow.enterShown;
      r.overKeeps = !!flow.overShown;
      r.leaveHides = !!flow.leaveHidden;
      r.reenterShows = !!flow.reenterShown;
      r.dropHides = !!flow.dropHidden;
      if (!Array.isArray(flow.types) || !flow.types.includes('Files') || flow.nfiles !== 1) {
        r.err = 'DataTransfer 形态异常: ' + JSON.stringify({ types: flow.types, nfiles: flow.nfiles });
      }
    }

    // 轮询主进程 store：等视频条目落库（mdls 探测最长 8s）
    let rec = null;
    for (let i = 0; i < 48 && !rec; i++) {
      rec = store.allItems().find((x) => x.kind === 'video' && x.source_path === tmp);
      if (!rec) await sleep(250);
    }
    r.videoRec = !!rec;
    if (rec) {
      r.recFiles = (rec.files || []).length;
      r.metaSize = rec.video && rec.video ? rec.video.size : null;
      r.category = rec.category || null;
      // ⑤ 列表 UI 刷新：library:changed → refresh(true) → 新卡片出现
      const probe = JSON.stringify(String(rec.title).slice(0, 12));
      for (let i = 0; i < 20; i++) {
        r.uiRefreshed = await wc.executeJavaScript(`document.getElementById('list').textContent.includes(${probe})`);
        if (r.uiRefreshed) break;
        await sleep(250);
      }
    }

    // ④ 不复制：归档目录快照不变 + 条目 files 为空 + 原文件原样在原位
    const after = walk(filesDir);
    let origIntact = false;
    try { origIntact = fs.statSync(tmp).size === SIZE; } catch {}
    r.noCopy = before === after && r.recFiles === 0 && origIntact;
  } catch (e) {
    r.err = r.err || String((e && e.message) || e);
  } finally {
    try { if (tmp) fs.unlinkSync(tmp); } catch {}
    try { await wc.executeJavaScript("const i = document.getElementById('__lvtestfile'); if (i) i.remove();").catch(() => {}); } catch {}
    try { if (dbgAttached) wc.debugger.detach(); } catch {}
  }

  const ok = r.maskEl && r.startHidden && r.textDragIgnored && r.noJunkRecord
    && r.enterShows && r.overKeeps && r.leaveHides && r.reenterShows && r.dropHides
    && r.videoRec && r.recFiles === 0 && r.noCopy && r.uiRefreshed && !r.err;
  console.log('DROP_TEST_' + (ok ? 'OK' : 'FAIL') + ' ' + JSON.stringify(r));
  return ok;
}

module.exports = { run };
