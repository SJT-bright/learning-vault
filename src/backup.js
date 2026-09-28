const fs=require('fs');
const path=require('path');
const {writeJsonAtomic}=require('./json-io');
const {migrateItem}=require('./migrate');
const {migrateIdea}=require('./ideas');
const LISTS={items:'library.json',events:'events.json',reviews:'reviews.json',quotes:'quotes.json',ideas:'ideas.json',extracts:'extracts.json',userRules:'user-rules.json',srsCards:'srs-cards.json'};
const MAPS={drafts:'capture-drafts.json',categoryRules:'category-rules.json',categoryProfile:'category-profile.json'};
function mergeBackup(current,incoming) {
  if(!incoming||!Array.isArray(incoming.items))throw new Error('不是有效的资料库备份：缺少资料列表');
  const next=structuredClone(current); let added=0,skipped=0;
  for(const key of Object.keys(LISTS)) {
    if(incoming[key]!==undefined&&!Array.isArray(incoming[key])) throw new Error('备份字段格式错误：'+key);
    const rows=next[key]||[];
    const identity=x=>key==='events'?JSON.stringify([x.id,x.t,x.type,x.cardId]):x.id;
    const ids=new Set(rows.map(identity));
    for(const row of incoming[key]||[]) {
      if(!row||typeof row!=='object'||(key!=='events'&&(typeof row.id!=='string'||!row.id)))throw new Error('备份记录缺少有效 ID：'+key);
      const id=identity(row);if(ids.has(id)){if(key==='items')skipped++;continue;}
      rows.push(structuredClone(row));ids.add(id);if(key==='items')added++;
    }
    next[key]=rows;
  }
  for(const key of Object.keys(MAPS)) {
    const value=incoming[key];
    if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)))throw new Error('备份字段格式错误：'+key);
    next[key]={...(value||{}),...(next[key]||{})};
  }
  next.categoryProfile.categories={...(incoming.categoryProfile?.categories||{}),...(current.categoryProfile?.categories||{})};
  next.items.forEach(migrateItem);next.ideas=next.ideas.map(migrateIdea);
  return {next,added,skipped};
}
function writeRestoredBundle(dataDir,bundle) {
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const backupDir=path.join(dataDir,'restore-backups',stamp);fs.mkdirSync(backupDir,{recursive:true});
  const before=new Map();
  const entries=Object.entries({...LISTS,...MAPS});
  for(const [,name] of entries) {
    const file=path.join(dataDir,name);before.set(file,fs.existsSync(file)?fs.readFileSync(file):null);
    if(before.get(file))fs.writeFileSync(path.join(backupDir,name),before.get(file));
  }
  try {for(const [key,name] of entries)writeJsonAtomic(path.join(dataDir,name),bundle[key],{backup:false});}
  catch(e) {for(const [file,content] of before){if(content!==null)fs.writeFileSync(file,content);else fs.rmSync(file,{force:true});}throw e;}
  return backupDir;
}
module.exports={mergeBackup,writeRestoredBundle,LISTS,MAPS};
