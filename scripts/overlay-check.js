/** 圆形悬浮按钮：真实 Electron 窗口、捕获指针、竖向拖动、重启恢复与拖入。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
let pw;
try { pw = require('playwright'); } catch { pw = require(process.env.LV_PLAYWRIGHT_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = path.resolve(__dirname, '..'), out = process.env.LV_EVIDENCE_DIR || path.join(root, '交付物/悬浮按钮-高亮修复/验证');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-overlay-check-'));
let app, page, win;
const nativeResults = [], nativeTrace = [];
const steps = [], errors = [];
const step = text => { steps.push(text); console.log('✓ ' + text); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i=0;i<120;i++) { const r = await fn(); if(r) return r; await sleep(80); } throw Error(label); }
async function launch() {
  app = await pw._electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], env: { ...process.env, LV_CONFIG_DIR: tmp } });
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  page = await until(() => app.windows().find(p => p.url().includes('/overlay/')), '悬浮窗未打开');
  await page.waitForSelector('#bar');
  win = await app.browserWindow(page);
  await app.evaluate(({BrowserWindow}) => { for(const w of BrowserWindow.getAllWindows()) if(!w.webContents.getURL().includes('/overlay/')) w.hide(); });
  await win.evaluate(w => { w.show(); w.focus(); });
}
async function quickVisible() { return app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('/quick/') && w.isVisible())); }
async function hideQuick() { await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('/quick/')).forEach(w=>w.hide())); await win.evaluate(w=>w.focus()); }
async function bounds() { return win.evaluate(w=>w.getBounds()); }
// 由真实 pointerdown 建立 capture，再注入屏幕坐标，覆盖窗外松手和屏幕边界。
async function drag(dx,dy, cancel=false) {
  await win.evaluate(w=>w.focus());
  const b = await bounds();
  await page.evaluate(()=>{ window.__start = null; document.getElementById('bar').addEventListener('pointerdown', e=>{window.__start={id:e.pointerId,x:e.screenX,y:e.screenY};},{once:true}); });
  const button=await page.locator('#bar').boundingBox();
  await page.mouse.move(button.x+button.width/2,button.y+button.height/2); await page.mouse.down();
  const capture = await page.evaluate(()=>document.getElementById('bar').hasPointerCapture(window.__start.id));
  assert.ok(capture, '真实 pointerdown 必须成功捕获指针');
  await page.evaluate(({dx,dy,cancel})=>{
    const s=window.__start, bar=document.getElementById('bar');
    bar.dispatchEvent(new PointerEvent('pointermove',{pointerId:s.id,isPrimary:true,buttons:1,screenX:s.x+dx,screenY:s.y+dy,bubbles:true}));
    bar.dispatchEvent(new PointerEvent(cancel?'pointercancel':'pointerup',{pointerId:s.id,isPrimary:true,button:0,buttons:0,screenX:s.x+dx,screenY:s.y+dy,bubbles:true}));
  },{dx,dy,cancel});
  await page.mouse.up(); await sleep(120);
  assert.equal(await quickVisible(), false, '拖动松手不得误开收录窗');
  assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('dragging')), false);
  return { before:b, after:await bounds() };
}
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(tmp,'config.json'),JSON.stringify({vaultBridge:{enabled:false},autoReview:false,notifyOnIngest:false}));
  await launch();
  const display = await app.evaluate(({screen})=>screen.getPrimaryDisplay().workArea);
  await win.evaluate((w,p)=>w.setPosition(p.x,p.y),{x:display.x+display.width-80,y:display.y+150});
  if (process.env.LV_NATIVE_POINTER_TEST === '1') {
    const { execFileSync } = require('child_process');
    const source = path.join(tmp, 'drag.swift'), binary = path.join(tmp, 'drag');
    fs.writeFileSync(source, `import CoreGraphics
import Foundation
let a = CommandLine.arguments.dropFirst().compactMap { Double($0) }
guard CGPreflightPostEventAccess(), a.count == 2 || a.count == 4 else { exit(2) }
let previous = CGEvent(source: nil)!.location
func send(_ type: CGEventType, _ x: Double, _ y: Double) {
  let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x:x,y:y), mouseButton:.left)!
  if type == .leftMouseDown || type == .leftMouseUp { e.setIntegerValueField(.mouseEventClickState, value:1) }
  e.post(tap:.cghidEventTap)
}
send(.mouseMoved,a[0],a[1]); Thread.sleep(forTimeInterval:0.18)
if a.count == 2 { exit(0) }
send(.leftMouseDown,a[0],a[1]); Thread.sleep(forTimeInterval:0.18)
for i in 1...16 { let f=Double(i)/16; send(.leftMouseDragged,a[0]+a[2]*f,a[1]+a[3]*f); Thread.sleep(forTimeInterval:0.025) }
send(.leftMouseUp,a[0]+a[2],a[1]+a[3]); Thread.sleep(forTimeInterval:0.2)
send(.mouseMoved,previous.x,previous.y)
`);
    execFileSync('swiftc', [source,'-o',binary]);
    await win.evaluate(w=>w.webContents.send('overlay:count',1));
    const nativeBounds=await bounds(), target=await page.locator('#bar').boundingBox();
    for(const [label,hover] of [['native-idle',false],['native-hover',true],['native-leave',false]]) {
      await sleep(700);
      const x=hover?nativeBounds.x+target.x+target.width/2:nativeBounds.x-30;
      execFileSync(binary,[x,nativeBounds.y+target.y+target.height/2].map(String));
      await until(()=>page.locator('#bar').evaluate(e=>e.matches(':hover')).then(v=>v===hover),'系统鼠标悬停状态未同步');
      execFileSync('/usr/sbin/screencapture',['-x',`-R${nativeBounds.x},${nativeBounds.y},80,80`,path.join(out,label+'.png')]);
    }
    step('系统鼠标移入和移出，并记录真实桌面透明合成截图');
    await page.evaluate(()=>{window.__trace=[];for(const name of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','blur'])window.addEventListener(name,e=>window.__trace.push({name,x:e.screenX,y:e.screenY,buttons:e.buttons,target:e.target.id,down:typeof down==='undefined'?null:down}),true);});
    {const b=await bounds();execFileSync('/usr/sbin/screencapture',['-x',`-R${b.x},${b.y},${b.width},${b.height}`,path.join(out,'桌面透明效果-预检.png')]);}
    for(const [dx,dy] of [[-110,90],[-90,-60]]) {
      await win.evaluate(w=>w.focus());
      await sleep(900); // 等前一轮系统注入鼠标的抑制期与窗口移动完成
      const before=await bounds();
      const button=await page.locator('#bar').boundingBox();
      execFileSync(binary,[before.x+button.x+button.width/2,before.y+button.y+button.height/2,dx,dy].map(String));
      await sleep(120);
      const after=await bounds();
      nativeTrace.push(...await page.evaluate(()=>window.__trace.splice(0)));
      fs.writeFileSync(path.join(out,'native-trace.json'),JSON.stringify({nativeResults,before,after,nativeTrace},null,2));
      assert.equal(after.x,before.x,'系统鼠标拖动保持横坐标');
      assert.equal(after.y,before.y+dy,'系统鼠标拖动更新高度');
      assert.equal(await quickVisible(),false,'系统鼠标在窗外松手不打开收录窗');
      await sleep(120);assert.deepEqual(await bounds(),after,'松手后不继续跟随鼠标');
      nativeResults.push({dx,dy,before,after});
    }
    step('macOS 系统鼠标向上/向下拖动，并在按钮外松手：位置正确、无误开、无继续跟随');
  }
  const surface=()=>page.locator('#bar').evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {background:s.background,shadow:s.boxShadow,width:r.width,height:r.height};});
  await page.mouse.move(1,1);const idleSurface=await surface();
  for(let i=0;i<8;i++) { await page.locator('#bar').hover();assert.deepEqual(await surface(),idleSurface,'悬停不替换底色和阴影');await page.mouse.move(1,1);assert.deepEqual(await surface(),idleSurface,'移出后恢复且不跳尺寸'); }
  step('反复移入/移出 8 次，圆面、阴影与尺寸保持稳定');
  for(const event of ['blur','dragend','dragleave','pointercancel','pointermove','Escape']) {
    await page.evaluate(event=>{
      window.dispatchEvent(new DragEvent('dragover',{cancelable:true}));
      if(!document.getElementById('bar').classList.contains('over'))throw Error('未进入拖放状态');
      if(event==='Escape')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
      else if(event==='pointermove')window.dispatchEvent(new PointerEvent('pointermove',{buttons:0}));
      else if(event==='dragleave')window.dispatchEvent(new DragEvent('dragleave',{clientX:60,clientY:40,relatedTarget:null}));
      else window.dispatchEvent(new Event(event));
    },event);
    assert.equal(await page.locator('#bar').evaluate(e=>e.classList.contains('over')),false,event+' 后不得残留高亮');
  }
  step('失焦、结束/离开/取消拖放、空闲鼠标及 Esc 均清除高亮');
  const size=await page.locator('#bar').boundingBox();assert.equal(size.width,32);assert.equal(size.height,32);assert.equal(80-size.x-size.width,4);
  await page.locator('#bar').click();await until(quickVisible,'单击未打开收录窗');await hideQuick();
  step('32px 圆按钮，距右边缘 4px，正常单击打开收录窗');
  const down=await drag(-70,120);assert.equal(down.after.x,down.before.x);assert.equal(down.after.y,down.before.y+120);
  const up=await drag(50,-80);assert.equal(up.after.x,up.before.x);assert.equal(up.after.y,up.before.y-80);
  step('真实指针捕获，向上/向下移动，横向晃动不改变横坐标，松手不误开');
  const top=await drag(0,-10000);assert.equal(top.after.y,display.y);
  const bottom=await drag(0,10000);assert.equal(bottom.after.y,display.y+display.height-80);
  step('越过顶部/底部时仍保持完整按钮在显示器工作区内');
  await drag(0,-130,true);
  const cancelled=await bounds();await sleep(150);assert.deepEqual(await bounds(),cancelled);
  step('取消拖动结束捕获，不继续跟随，也不打开收录窗');
  const saved=JSON.parse(fs.readFileSync(path.join(tmp,'config.json'),'utf8')).overlayPos;
  await app.close();app=null;await launch();
  assert.deepEqual({x:(await bounds()).x,y:(await bounds()).y},saved);
  step('正常退出再启动，恢复保存的位置');
  await page.locator('#bar').focus();await page.keyboard.press('Enter');await until(quickVisible,'键盘打开失败');await hideQuick();
  step('键盘 Enter 仍可打开快速收录');
  // 真正的带路径 File 经过 preload/webUtils，再由原收录链路落盘。
  const fixture=path.join(tmp,'圆按钮收录验证.txt');fs.writeFileSync(fixture,'悬浮按钮拖入测试，保留原有归档流程。');
  await page.evaluate(()=>{const i=document.createElement('input');i.type='file';i.id='testFile';i.hidden=true;document.body.appendChild(i);});
  await page.locator('#testFile').setInputFiles(fixture);
  await page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(document.getElementById('testFile').files[0]);window.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,cancelable:true}));window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,cancelable:true}));document.getElementById('testFile').remove();});
  const item=await until(async()=>{const r=await page.evaluate(()=>window.vault.list({limit:100}));return r.items.find(i=>i.title.includes('圆按钮收录验证'));},'文件拖入没有保存');
  assert.equal(item.kind,'file');assert.equal(fs.readFileSync(item.files[0].path,'utf8'),fs.readFileSync(fixture,'utf8'));
  step('真实带路径文件拖入后成功归档，内容一致');
  await page.evaluate(()=>{const dt=new DataTransfer();dt.setData('text/plain','圆按钮文字拖入');window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,cancelable:true}));});
  await until(quickVisible,'文字拖入未开收录窗');
  const quick=app.windows().find(p=>p.url().includes('/quick/'));await quick.waitForFunction(()=>document.getElementById('mainInput').value.includes('圆按钮文字拖入'));await hideQuick();
  step('文字拖入打开收录草稿，保持原有入口');
  await win.evaluate(w=>{w.webContents.send('overlay:count',1);w.webContents.send('overlay:srs',0);});
  await sleep(180);await page.mouse.move(1,1);
  await page.locator('#bar').evaluate(el=>el.blur());
  await page.screenshot({path:path.join(out,'圆形悬浮按钮.png'),omitBackground:true});
  if(process.env.LV_NATIVE_POINTER_TEST === '1') {
    const b=await bounds();require('child_process').execFileSync('/usr/sbin/screencapture',['-x',`-R${b.x},${b.y},${b.width},${b.height}`,path.join(out,'桌面透明效果.png')]);
  }
  await win.evaluate(w=>{w.webContents.send('overlay:count',120);w.webContents.send('overlay:srs',8);});
  await until(()=>page.locator('#countBadge').innerText().then(t=>t==='99+'),'角标没有更新');
  for (const id of ['#bar','#countBadge','#srsBadge']) {const r=await page.locator(id).boundingBox();assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=80&&r.y+r.height<=80,id+' 没有完整显示');}
  await page.screenshot({path:path.join(out,'圆形悬浮按钮-双角标.png'),omitBackground:true});
  await page.locator('#srsBadge').click();
  await until(()=>app.windows().find(p=>p.url().includes('/review/review.html')||p.url().includes('/srs/')),'复习按钮未打开');
  assert.equal(await quickVisible(),false);step('双角标和 99+ 不溢出，复习按钮单独打开复习窗口');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'overlay-result.json'),JSON.stringify({ok:true,steps,errors,display,saved,nativeResults,drag:{down,up,top,bottom},scope:'真实 Electron；真实 pointerdown 与 pointer capture，屏幕位移和窗外抬起通过注入事件覆盖；隔离数据'},null,2));
  console.log('OVERLAY_CHECK_OK '+steps.length);
})().catch(e=>{console.error(e.stack);fs.writeFileSync(path.join(out,'overlay-result.json'),JSON.stringify({ok:false,steps,errors,error:e.stack},null,2));process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(tmp,{recursive:true,force:true});});
