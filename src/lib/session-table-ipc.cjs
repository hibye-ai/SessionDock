'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {parseCsv,sampleCsv}=require('./session-table.cjs');
const {readSessionFile,writeAtomicFileAsync}=require('./session-file.cjs');
function registerTableImport({handle,dialog,getWindow,store,protectedFiles,owner}){
 let pending=null,generation=0;
 const revision=()=>createHash('sha256').update(JSON.stringify([store.listSessions(),store.listFolders()])).digest('hex');
 handle('sessions:sample-csv',async()=>{
  const epoch=owner();const chosen=await dialog.showSaveDialog(getWindow(),{title:'예시 CSV 저장',buttonLabel:'저장',defaultPath:'SessionDock-예시.csv',filters:[{name:'CSV (UTF-8)',extensions:['csv']}]});
  if(chosen.canceled)return null;if(epoch!==owner())throw new Error('창이 변경되었습니다. 다시 시도하세요.');
  try{await writeAtomicFileAsync(chosen.filePath,sampleCsv(),protectedFiles());}catch{throw new Error('예시 CSV를 저장하지 못했습니다. 다른 파일 이름과 쓰기 권한을 확인하세요.');}
  return {saved:true};
 });
 handle('sessions:csv-preview',async(options={})=>{
  pending=null;const current=++generation,epoch=owner();
  const chosen=await dialog.showOpenDialog(getWindow(),{title:'CSV 세션 가져오기',buttonLabel:'미리보기',properties:['openFile'],filters:[{name:'CSV (UTF-8)',extensions:['csv']}]});
  if(chosen.canceled)return null;if(epoch!==owner()||current!==generation)throw new Error('창이 변경되었습니다. 다시 시도하세요.');
  let bytes;try{bytes=readSessionFile(chosen.filePaths[0]);}catch{throw new Error('CSV를 읽지 못했습니다. UTF-8 파일과 읽기 권한을 확인하세요.');}
  const result=parseCsv(bytes,options);if(!result.sessions.length)throw new Error('가져올 세션이 없습니다.');
  const token=randomUUID();pending={token,result,base:revision(),epoch,expires:Date.now()+10*60*1000};
  return {...result,token};
 });
 handle('sessions:csv-apply',input=>{
  const plan=pending;
  if(!plan||input?.token!==plan.token)throw new Error('미리보기를 다시 생성하세요.');
  pending=null;
  if(input.confirm===false)return null;
  if(input.confirm!==true||plan.epoch!==owner()||Date.now()>plan.expires||revision()!==plan.base)throw new Error('목록 또는 창이 변경되었습니다. 미리보기를 다시 확인하세요.');
  // Same append-only identity/collision policy as existing JSON import. Never update old secrets.
  const result=store.importData({version:1,sessions:plan.result.sessions});
  return {added:result.sessions.length};
 });
}
module.exports={registerTableImport};
