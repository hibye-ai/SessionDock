'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {atomicRenameSync}=require('./atomic-rename.cjs');
const MAX_RECORDS=1024,MAX_BINDINGS=4096,MAX_FILE_BYTES=512*1024;
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const add=(a,b)=>Math.min(Number.MAX_SAFE_INTEGER,a+b);
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id);
function clean(record){
 if(!record||!validId(record.profileId)||!integer(record.lossCount)||!integer(record.firstAt)||!integer(record.lastAt))return null;
 return {profileId:record.profileId,lossCount:integer(record.lossCount),droppedLogBytes:integer(record.droppedLogBytes),unconfirmedLogBytes:integer(record.unconfirmedLogBytes),firstAt:integer(record.firstAt),lastAt:integer(record.lastAt)};
}
// Separate from session-store: no profile, endpoint, error string, log path or
// transcript ever enters the journal. One aggregate per profile, newest 1024.
class LogLossJournal{
 constructor(root){
  this.filePath=path.join(root,'log-loss-journal.json');this.records=new Map();this.bindings=new Map();this.persistenceFailed=false;this.revision=0;
  try{
   const stat=fs.statSync(this.filePath);if(!stat.isFile()||stat.size>MAX_FILE_BYTES)throw new Error('Invalid journal');
   const data=JSON.parse(fs.readFileSync(this.filePath,'utf8'));
   if(data.version!==1||!Array.isArray(data.records)||data.records.length>MAX_RECORDS)throw new Error('Invalid journal');
   for(const raw of data.records){const record=clean(raw);if(!record)throw new Error('Invalid journal');this.records.set(record.profileId,record);}
  }catch(error){if(error.code!=='ENOENT')this.persistenceFailed=true;}
 }
 get(profileId){const record=this.records.get(profileId);return record?{...record,...(this.persistenceFailed?{persistenceFailed:true}:{})}:this.persistenceFailed?{persistenceFailed:true}:null;}
 bind(id,profileId){
  if(!validId(id)||!validId(profileId))return null;
  if(!this.bindings.has(id)){this.bindings.set(id,{profileId,reported:false,dropped:0,unconfirmed:0});if(this.bindings.size>MAX_BINDINGS)this.bindings.delete(this.bindings.keys().next().value);}
  return this.get(profileId);
 }
 observe(event){
  if(!event||!['log','log-error','status'].includes(event.type))return null;
  const binding=this.bindings.get(event.id);if(!binding)return null;
  const incomplete=event.type==='log-error'||event.incomplete===true||event.logIncomplete===true;
  if(!incomplete)return this.get(binding.profileId);
  const dropped=Math.max(binding.dropped,integer(event.droppedLogBytes)),unconfirmed=Math.max(binding.unconfirmed,integer(event.unconfirmedLogBytes));
  if(binding.reported&&dropped===binding.dropped&&unconfirmed===binding.unconfirmed)return this.get(binding.profileId);
  const now=Date.now(),previous=this.records.get(binding.profileId);
  const record={profileId:binding.profileId,lossCount:add(previous?.lossCount||0,binding.reported?0:1),droppedLogBytes:add(previous?.droppedLogBytes||0,dropped-binding.dropped),unconfirmedLogBytes:add(previous?.unconfirmedLogBytes||0,unconfirmed-binding.unconfirmed),firstAt:previous?.firstAt||now,lastAt:now};
  binding.reported=true;binding.dropped=dropped;binding.unconfirmed=unconfirmed;
  this.records.delete(record.profileId);this.records.set(record.profileId,record);
  if(this.records.size>MAX_RECORDS)this.records.delete(this.records.keys().next().value);
  this.save();this.revision++;return this.get(binding.profileId);
 }
 save(){
  const temporary=`${this.filePath}.${randomUUID()}.tmp`;
  try{
   const content=JSON.stringify({version:1,records:[...this.records.values()]});
   if(Buffer.byteLength(content)>MAX_FILE_BYTES)throw new Error('Journal limit');
   fs.mkdirSync(path.dirname(this.filePath),{recursive:true});
   fs.writeFileSync(temporary,content,{flag:'wx',mode:0o600});atomicRenameSync(temporary,this.filePath);this.persistenceFailed=false;
  }catch{this.persistenceFailed=true;}
  finally{try{fs.unlinkSync(temporary);}catch{/* No temporary file after a successful rename. */}}
 }
}
module.exports={LogLossJournal,MAX_RECORDS,MAX_BINDINGS,MAX_FILE_BYTES};
