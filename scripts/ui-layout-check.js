/** 只复查捕获底栏与复盘弹窗，不覆盖其他已验收截图。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
let pw;try{pw=require('playwright');}catch{pw=require(process.env.LV_PLAYWRIGHT_PATH||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const root=path.resolve(__dirname,'..'),out=path.join(root,'交付物/v0.10.1-验收'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lv-layout-'));
let app;
(async()=>{
 fs.writeFileSync(path.join(tmp,'config.json'),JSON.stringify({vaultBridge:{enabled:false},autoReview:false,notifyOnIngest:false}));
 app=await pw._electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[root],env:{...process.env,LV_CONFIG_DIR:tmp}});
 const wait=async f=>{for(let n=0;n<100;n++){const x=f();if(x)return x;await new Promise(r=>setTimeout(r,50));}throw Error('窗口未出现');};
 const main=await wait(()=>app.windows().find(x=>x.url().includes('/main/index')));await main.waitForSelector('#addBtn');
 await main.evaluate(()=>window.vault.openQuick());const quick=await wait(()=>app.windows().find(x=>x.url().includes('/quick/')));
 const raw='阿宁 2026/9/22 09:12\n分镜先画九宫格，再写提示词\n[文件] 九宫格模板.md\n---\n小周 2026/9/22 09:14\n收到，我下午试一次';
 await quick.locator('#mainInput').fill(raw);await quick.locator('#mainInput').dispatchEvent('paste');await quick.locator('.msgcard').first().waitFor();
 await quick.locator('#chatTitle').fill('分镜方法讨论');await quick.locator('#chatSource').fill('微信 · 创作讨论');
 await quick.locator('.msgcard').last().scrollIntoViewIfNeeded();
 const bounds=await quick.evaluate(()=>({scrollBottom:document.querySelector('.wrap').getBoundingClientRect().bottom,footerTop:document.querySelector('.foot').getBoundingClientRect().top,buttonBottom:document.querySelector('#submitBtn').getBoundingClientRect().bottom,height:innerHeight}));
 assert.ok(bounds.scrollBottom<=bounds.footerTop+.5);assert.ok(bounds.buttonBottom<=bounds.height);
 await quick.screenshot({animations:'disabled',path:path.join(out,'01-聊天导入.png')});
 await quick.locator('#submitBtn').click();await quick.waitForFunction(()=>document.querySelector('#status').textContent==='已记下');
 await main.evaluate(async()=>{
   const n=await window.vault.captureSave({kind:'note',text:'九宫格分镜法',notes:'固定服装，先画九宫格'});
   await window.vault.usageAdd({id:n.id,purpose:'制作 15 秒样片',result:'人物稳定，动作还需优化'});
   await window.vault.improveAdd({id:n.id,problem:'动作太僵硬',change:'加入停顿和微表情',reason:'试片反馈',fullVersion:'固定服装，停顿后做微表情和动作'});
   const i=await window.vault.ideasAdd('用九宫格做一条短片');
   await window.vault.ideasPatch(i.idea.id,{status:'done',result_note:'完成 15 秒样片，人物更稳定',related_item_ids:[n.id]});
   const r=await window.vault.reviewGenerate({mode:'weekly'});if(!r.ok)throw Error(r.error);
   toast('上一条分类操作提示');showReviewModal(r);
 });
 assert.equal(await main.locator('#toast.show').count(),0);assert.equal(await main.locator('.mask .bh1').count(),1);assert.ok(await main.locator('#closeRev').isVisible());
 await main.screenshot({animations:'disabled',path:path.join(out,'05-真实成果复盘.png')});await main.locator('#closeRev').click();assert.equal(await main.locator('.mask').count(),0);
 fs.writeFileSync(path.join(out,'layout-result.json'),JSON.stringify({ok:true,checks:['聊天滚动区与底栏不重叠','保存按钮在窗口内','修改后聊天仍能正常入库','复盘弹窗隐藏旧操作提示','复盘分级标题渲染','关闭按钮可用'],bounds},null,2));
 console.log('UI_LAYOUT_OK 6');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(tmp,{recursive:true,force:true});});
