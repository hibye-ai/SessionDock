'use strict';
const path = require('node:path');
const { createTerminalDecoder, normalizeTerminalEncoding } = require('./terminal-encoding.cjs');
const DEFAULT_LOG_SETTINGS = Object.freeze({ logEnabled: false, logDirectory: '', logFilenameTemplate: '{year}{month}{day}_{hour}{minute}{second}_{host}.log', logFormat: 'text', logTimestamps: false, logRotateDaily: false });
const TOKENS = new Set(['session','host','port','username','protocol','date','time','year','month','day','hour','minute','second','id']);
function invalid(message) { const error = new Error(message); error.code = 'ERR_VALIDATION'; throw error; }
function validateLogTemplate(template) {
  if(typeof template !== 'string' || !template.trim() || template.length > 512 || /[\x00-\x1f<>:"|?*]/.test(template)) invalid('로그 파일명 양식이 올바르지 않습니다.');
  const parts=template.trim().replace(/\\/g,'/').split('/');
  if(parts.some(part=>!part||['.','..'].includes(part)||/[. ]$/.test(part))) invalid('로그 파일명에는 절대 경로나 상위 폴더를 사용할 수 없습니다.');
  const literal=template.replace(/\{([^{}]+)\}/g,(_match,token)=>{if(!TOKENS.has(token))invalid(`지원하지 않는 로그 변수: {${token}}`);return 'value';});
  if(/[{}]/.test(literal)||parts.some(part=>/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) invalid('로그 파일명 양식이 올바르지 않습니다.');
  return template.trim();
}
function safePart(value) {
  let result=String(value??'').normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').replace(/\.\.+/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,96);
  if(!result)result='_';if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result))result='_'+result;return result;
}
// One formatter for the whole process. Constructing `Intl.DateTimeFormat` is the
// expensive part (it resolves locale data and the time zone), and the log writer
// asked for it once per received chunk: 10,000 chunks cost ~611ms of pure
// formatter setup versus ~35ms when the instance and the formatted parts are
// cached. Both caches are sound because the output only depends on the instant
// at second resolution, and these settings are fixed (Seoul, h23, 2-digit).
const SEOUL_FORMAT_OPTIONS=Object.freeze({timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
let seoulFormatter=null;
function getSeoulFormatter(){if(!seoulFormatter)seoulFormatter=new Intl.DateTimeFormat('en-GB',SEOUL_FORMAT_OPTIONS);return seoulFormatter;}
let stampCache={second:Number.NaN,value:null};
// Returns a shared, immutable-per-second object. Callers only read fields (they
// spread it into their own tokens map), so no copy is allocated per chunk.
function dateParts(now=new Date()) {
  const second=Math.floor(now.getTime()/1000);
  if(stampCache.second===second&&stampCache.value)return stampCache.value;
  const parts=Object.fromEntries(getSeoulFormatter().formatToParts(now).map(part=>[part.type,part.value]));
  const value=Object.freeze({...parts,date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}-${parts.minute}-${parts.second}`,stamp:`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`});
  stampCache={second,value};
  return value;
}
function logRelativePath(template,info,id,now=new Date()) {
  validateLogTemplate(template);const tokens={session:info.name,host:info.host,port:info.port,username:info.username,protocol:info.protocol||'ssh',...dateParts(now),id:String(id).slice(0,8)};
  const relative=template.replace(/\{([^{}]+)\}/g,(_match,token)=>safePart(tokens[token])).replace(/\\/g,'/');
  if(relative.split('/').some(part=>part.length>240))invalid('로그 파일명은 폴더별로 240자 이하로 지정해 주세요.');
  return relative;
}
function logLocation(settings,defaultDirectory,info,id,now) {
  const directory=settings.logDirectory||defaultDirectory;
  if(typeof directory!=='string'||!path.isAbsolute(directory))invalid('로그 저장 폴더는 절대 경로로 지정해 주세요.');
  const root=path.resolve(directory),relative=logRelativePath(settings.logFilenameTemplate||DEFAULT_LOG_SETTINGS.logFilenameTemplate,info,id,now),filename=path.resolve(root,...relative.split('/'));
  if(!filename.startsWith(root.endsWith(path.sep)?root:root+path.sep))invalid('로그 파일이 지정한 저장 폴더를 벗어납니다.');
  return {root,filename,relative};
}
class LogFormatter {
  constructor({logFormat=DEFAULT_LOG_SETTINGS.logFormat,logTimestamps=false,encoding='utf-8'}={}) { this.raw=logFormat==='raw';this.timestamps=logTimestamps;this.encoding=normalizeTerminalEncoding(encoding);this.decoder=createTerminalDecoder(this.encoding);this.phase='text';this.pendingCr=false;this.lineStart=true; }
  write(bytes,now=new Date()) { return this.raw?bytes:this.clean(this.decoder.write(bytes),now); }
  clean(text,now) {
    const out=[],stamp=this.timestamps?`[${dateParts(now).stamp}] `:'';
    const emit=char=>{if(this.pendingCr){out.push('\n');this.lineStart=true;this.pendingCr=false;if(char==='\n')return;}if(char==='\r'){this.pendingCr=true;return;}if(char==='\n'){out.push('\n');this.lineStart=true;return;}if(char<' '&&char!=='\t'||char==='\x7f')return;if(this.lineStart&&this.timestamps)out.push(stamp);this.lineStart=false;out.push(char);};
    for(const char of text){
      if(this.phase==='esc'){if(char==='[')this.phase='csi';else if(']PX^_'.includes(char))this.phase=char===']'?'osc':'string';else if(/[ -/]/.test(char))this.phase='esc-intermediate';else this.phase='text';continue;}
      if(this.phase==='esc-intermediate'){if(/[0-~]/.test(char))this.phase='text';continue;}
      if(this.phase==='csi'){if(char>='@'&&char<='~')this.phase='text';continue;}
      if(this.phase==='osc'||this.phase==='string'){if(char==='\x07'&&this.phase==='osc')this.phase='text';else if(char==='\x1b'){this.previousPhase=this.phase;this.phase='string-esc';}continue;}
      if(this.phase==='string-esc'){this.phase=char==='\\'?'text':this.previousPhase;continue;}
      if(char==='\x1b'){this.phase='esc';continue;}if(char==='\u009b'){this.phase='csi';continue;}if(char==='\u009d'){this.phase='osc';continue;}emit(char);
    }
    return Buffer.from(out.join(''),'utf8');
  }
  flush(now=new Date()) { if(this.raw)return Buffer.alloc(0);const bytes=this.clean(this.decoder.end()||'',now);if(!this.pendingCr)return bytes;this.pendingCr=false;return Buffer.concat([bytes,Buffer.from('\n')]); }
}
module.exports={DEFAULT_LOG_SETTINGS,validateLogTemplate,logRelativePath,logLocation,LogFormatter,dateParts};
