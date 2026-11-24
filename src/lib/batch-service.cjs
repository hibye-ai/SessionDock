'use strict';
const {randomUUID,createHmac}=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const {performance}=require('node:perf_hooks');
const {ConnectionService}=require('./connection-service.cjs');
const {normalizePlan,publicPlan}=require('./batch-plan.cjs');
const {findOffset,foldText}=require('./batch-search.cjs');
const {TerminalTail,PromptMatcher,candidate,hasResponse,denied,commandError,needsEnter,pager,credentialPrompt,credentialKind,lastNonEmptyLine,sameView}=require('./batch-terminal.cjs');
const LIMIT_ROW=2*1024*1024,LIMIT_TOTAL=32*1024*1024;
// How long an unconfirmed teardown blocks its endpoint when the transport exposes
// no close promise at all. It matches the transport's own close-record TTL: past
// that the record is pruned and "no evidence" would otherwise mean "blocked
// forever" (V7-M-02).
const UNCONFIRMED_CLOSE_TTL_MS=60*1000;
const DONE=new Set(['success','error','cancelled']);
const STATUS={queued:'대기',connecting:'접속 중',login:'로그인 중',running:'명령 실행 중',success:'완료',error:'실패',cancelled:'취소'};
// How long an approved preview may be started. The draft owns the only direct
// (typed) secrets the operator entered, so it is released on every path that
// ends its life — this deadline, an explicit clear, cancel or close (V9-M-06).
const DRAFT_TTL_MS=10*60*1000;
class BatchFailure extends Error{}
// V9-M-06: an approved plan is bound to *credential identity*, never to the
// plaintext that was resolved when the preview was approved. The binding is an
// opaque per-process HMAC over exactly the fields that change what is sent to a
// device; it cannot be compared across processes, no material is derivable from
// it, and an unrelated edit (name/timestamp) does not invalidate an approval.
// A same-value re-save is explicitly allowed to keep the approval: the
// fingerprint proves the operator's approved secret is still that secret, while
// any change to the key passphrase, username, auth type or key/agent path
// requires a fresh preview instead of silently using either value.
const CREDENTIAL_KEY=createHmac('sha256','sessiondock.batch.credential.v1').update(randomUUID()).digest();
function credentialFingerprint(profile,passphrase){
  return createHmac('sha256',CREDENTIAL_KEY).update(JSON.stringify([
    String(profile?.username??''),String(profile?.authType??''),
    String(profile?.privateKeyPath??''),String(profile?.agentPath??''),
    profile?.authType==='key'&&typeof passphrase==='string'?passphrase:''
  ])).digest('hex');
}
// One start/row failure that names every affected group, so a multi-group plan
// is fixed in one pass instead of one preview click per group.
function credentialChanged(conflicts){
  const detail=conflicts.map(item=>`${item.group}(${item.reason})`).join(', ');
  const error=new BatchFailure(`저장 자격 증명이 변경 또는 삭제되었습니다: ${detail}. 실행 계획을 다시 확인해 주세요.`);
  error.code='CREDENTIAL_CHANGED';error.failureCode='CREDENTIAL_CHANGED';
  return error;
}

const REDACTED='[비밀값 숨김]';
// Shortest fragment of a long secret that is treated as a partial echo. A
// 1-character secret can never be a partial echo — hiding every occurrence of a
// single letter would destroy the whole transcript — so it is only matched in
// full (see `obscure`), never as a suffix.
const MIN_TAIL=3;
// Terminal cleanup rewrites CR/CRLF and drops control bytes, so a secret that
// contained them no longer appears verbatim in the transcript. Mask every form
// the secret can take after that transformation, longest first so a secret that
// contains another one is still fully hidden.
function secretForms(secrets){
  const forms=new Set();
  for(const secret of secrets||[]){
    if(typeof secret!=='string'||!secret)continue;
    forms.add(secret);
    const cleaned=clean(secret);
    if(cleaned)forms.add(cleaned);
    const collapsed=cleaned.replace(/\n+/g,'');
    if(collapsed&&collapsed!==cleaned)forms.add(collapsed);
  }
  return [...forms].sort((a,b)=>b.length-a.length);
}
// Keep only an opaque digest, not another retained copy of authentication
// answers. Include every effective string and its order, including replacements
// made in place without changing the array length.
function secretFingerprint(secrets){
  const values=(secrets||[]).filter(value=>typeof value==='string'&&value);
  return values.length?createHmac('sha256',CREDENTIAL_KEY).update(JSON.stringify(values)).digest('hex'):'';
}
function obscure(text,forms){let value=String(text??'');for(const secret of forms)value=value.split(secret).join(REDACTED);return value;}
// Z-function: z[i] is the length of the longest prefix of `pattern` that also
// starts at i. One pass, O(n), and it answers both "where does this prefix of
// the secret appear" (fragment masking) and "is the buffer ending in this
// prefix" (tail masking) without restarting a comparison at every offset — the
// per-offset comparison was O(output × secret) and blocked the main loop for
// seconds on a legitimate long repetitive secret (V4-M-14).
function zArray(pattern){
  const n=pattern.length,z=new Uint32Array(n);
  let left=0,right=0;
  for(let i=1;i<n;i++){
    if(i<right)z[i]=Math.min(right-i,z[i-left]);
    while(i+z[i]<n&&pattern[z[i]]===pattern[i+z[i]])z[i]++;
    if(i+z[i]>right){left=i;right=i+z[i];}
  }
  return z;
}
// A stream that is cut mid-echo leaves a partial prefix behind. Keep masking it
// even when the stream ends so cancelling/timeouts never reveal the fragment.
// `size` is always >= MIN_TAIL (>= 3) and <= secret.length-1, so a 1- or
// 2-character secret is never truncated into a zero-length slice: `endsWith('')`
// is always true, and `slice(0,-0)` would erase the entire result.
function obscureTail(text,forms){
  let value=String(text??'');
  for(const secret of forms){
    const longest=Math.min(secret.length-1,value.length);
    if(longest<MIN_TAIL)continue;
    // The tail is a *suffix* of the buffer, so the prefix of `secret` being
    // echoed is exactly the longest prefix/suffix overlap. Computing that with
    // `secret + '\x00' + last-secret-length-chars` and the Z-function is one
    // linear pass; the old loop tried every length with `endsWith`, which is
    // O(secret × output) and cost hundreds of milliseconds on a long secret
    // (V4-M-14). Only the final `secret.length` characters can participate, so
    // the scan is bounded by the secret size, not the transcript size.
    const window=value.slice(value.length-Math.min(value.length,secret.length));
    const z=zArray(secret+'\x00'+window);
    const offset=secret.length+1;
    let size=0;
    for(let start=0;start<window.length;start++){
      const span=window.length-start;
      if(span>longest)continue;
      // The match must be the whole rest of the buffer, not merely present.
      if(z[offset+start]>=span&&span>size)size=span;
    }
    if(size<MIN_TAIL)continue;
    value=value.slice(0,value.length-size)+REDACTED;
  }
  return value;
}
// A partial echo is not necessarily at the very end of the buffer: a hurried
// device may print a line break, an OTP prompt or the next banner right after
// the fragment. Mask a prefix that is followed by a line boundary as well.
// The scanned prefix length is bounded by the secret itself, not by a constant:
// an allowed secret can be 16,384 characters long, and a fixed 240-character
// cap let a 253-character prefix be printed in full.
//
// The prefix search is a Z-function over `secret + sentinel + value`, so the
// cost is linear in the output length instead of O(output × secret). The old
// matcher restarted the prefix comparison at every start offset, which meant a
// repetitive secret (`'A'.repeat(16383)+'Z'`) against a repetitive 64KiB
// transcript blocked the main loop for ~2.8s (V4-M-14).
function obscureFragments(text,forms){
  let value=String(text??'');
  for(const secret of forms){
    if(secret.length<=MIN_TAIL)continue;
    const limit=secret.length,offset=limit+1,pattern=secret+'\x00'+value;
    const n=pattern.length,z=new Uint32Array(n);
    // z[i] = length of the longest prefix of `secret` that starts at i.
    // A sentinel that appears inside the text can only make z larger than
    // `limit`, which is clamped away below, so the match length stays exact.
    let left=0,right=0;
    for(let i=1;i<n;i++){
      if(i<right)z[i]=Math.min(right-i,z[i-left]);
      while(i+z[i]<n&&pattern[z[i]]===pattern[i+z[i]])z[i]++;
      if(i+z[i]>right){left=i;right=i+z[i];}
    }
    let index=0,last=0;const out=[];
    while(index<value.length){
      const size=Math.min(limit,z[offset+index]);
      if(size>=MIN_TAIL){
        const after=index+size;
        const boundary=after>=value.length||value[after]==='\n'||(value[after]==='\r'&&value[after+1]==='\n');
        if(boundary){out.push(value.slice(last,index),REDACTED);index=after;last=after;continue;}
      }
      index++;
    }
    if(!out.length)continue;
    out.push(value.slice(last));
    value=out.join('');
  }
  return value;
}
function scrub(text,secrets){return obscure(text,secretForms(secrets));}
// final/export redactor: exact forms anywhere, partial prefixes at a cut or line
// boundary. Applied to transcripts *and* to timing/command metadata so a
// fragment cannot come back through `detail` or `exportRows`.
function scrubStream(text,secrets){
  const forms=secretForms(secrets);
  return obscureTail(obscureFragments(obscure(text,forms),forms),forms);
}
function clean(text){return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b[()][\w]/g,'').replace(/\x1b./g,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');}
function isCiscoEnable(command){return /^en(?:able)?(?:\s+(?:[0-9]|1[0-5]))?$/i.test(command.trim());}
function echoIsCommand(tail,command,prompt){const line=String(tail??'').trim();return !!command&&(line===command||!!prompt&&line.startsWith(prompt)&&line.slice(prompt.length).trim()===command);}
function echoPrefix(line,command,prompt){
  line=String(line??'').trim();if(!line||!command)return false;
  if(command.startsWith(line))return true;
  const prefix=String(prompt??'').trim();
  if(!prefix)return false;
  if(prefix.startsWith(line))return true;
  return line.startsWith(prefix)&&command.startsWith(line.slice(prefix.length).trimStart());
}
// A device that was already privileged can print `Router#` without any
// transition, and a stack member prints `Switch-1#`; both are real `#` proofs.
// `Router>` (the same user mode) and a silent device prove nothing.
// A `literal` identity has no verified host name at all (a banner-only login
// learned `Welcome…`), so accepting any `#` there turned a stranger's prompt
// into proof of privilege. It now needs a host token that was actually
// confirmed at login; without one the operator's explicit phrase or the learned
// prompt text is the only acceptable evidence (H-06).
function privilegedLine(row,line){
  const text=String(line??'').trim();
  if(!text||!text.endsWith('#')||credentialPrompt(text))return false;
  const learned=row.matcher?.learned;
  if(!learned)return false;
  if(candidate(text)){
    if(learned.kind!=='literal')return row.matcher.sameDevice(text);
    // Literal identity: only the exact spelling the device already proved, or
    // an explicitly configured completion phrase, may stand in for a host name.
    const name=String(learned.identity??'').trim();
    const body=text.slice(0,-1);
    return !!name&&(body===name||text===name);
  }
  // Prompt-shaped but unparsed: compare its token body with the learned identity
  // under the same strict stack/view rule used everywhere else.
  const body=text.slice(0,-1);
  if(!body||/\s/.test(body))return false;
  if(learned.kind==='literal')return false;
  const identity=String(learned.identity??'');
  return !!identity&&(body===identity||sameView(identity.toLowerCase(),body.toLowerCase()));
}
// The completion prompt must still belong to the device learned at login and,
// for a privilege transition, must be the privileged `#` form. Applied to both
// the separate `enableCommand` path and inline `enable`, so a foreign
// `OtherDevice>`/`OtherDevice#` can never be accepted as success.
function privilegedPrompt(row,group,line){
  const text=String(line??'').trim();
  const expected=String(group.prompt??'').trim();
  if(expected.length>1&&text!==expected)return false;
  // The prompt itself must be a `#` for this same device. Identity comes from
  // `privilegedLine`, which accepts a stack member (`Switch-1#`) but never a
  // sibling host (`Router-backup#`) or an authentication challenge.
  return privilegedLine(row,text);
}
class BatchService{
  constructor({knownHosts,ask,emit,resolveCredential,connectionFactory,onDisconnect,autoTrustHostKey=false,autoTrustChangedHostKey=false,draftTtlMs=DRAFT_TTL_MS}={}){
    this.emit=emit||(()=>{});this.resolveCredential=resolveCredential;this.draft=null;this.job=null;this.closed=false;
    this.draftTtlMs=Number.isFinite(draftTtlMs)&&draftTtlMs>0?draftTtlMs:DRAFT_TTL_MS;this.draftTimer=null;
    this.ask=ask;this.connections=new Map();this.profiles=new Map();this.notificationTimer=null;this.lastNotification=-Infinity;this.searchCache=null;this.liveResultCache=null;
    // connection id -> {endpoint, at} for teardowns whose real socket close was
    // never observed. Consulted before any *new* connection to the same address,
    // so an unconfirmed close cannot become a second device session (V6-H-01).
    this.unconfirmedCloses=new Map();
    this.onDisconnect=onDisconnect;
    // Batch keys live only for the duration of one job. Interactive trust is
    // read as a hint but never written: an unattended batch must not be able to
    // promote (or replace) a key that the operator's interactive sessions trust.
    this.knownHosts=knownHosts;this.autoTrustHostKey=autoTrustHostKey===true;this.autoTrustChangedHostKey=autoTrustChangedHostKey===true;
    this.jobTrust=new Map();
    this.transport=(connectionFactory||((options)=>new ConnectionService(options)))({lookupSession:id=>this.profiles.get(id),knownHosts:{
      get:key=>this.jobTrust.has(key)?this.jobTrust.get(key):(this.knownHosts?.get?.(key)||null),
      // `expected` mirrors SessionStore.trustKnownHost: a key that changed
      // between the prompt and the write is rejected instead of trusted.
      set:(key,fingerprint,expected)=>{
        if(expected!==undefined&&(this.jobTrust.has(key)?this.jobTrust.get(key):(this.knownHosts?.get?.(key)||null))!==expected)throw new Error('확인 중 저장된 호스트 키가 바뀌었습니다. 다시 연결해 확인해 주세요.');
        if(this.jobTrust.size<4096)this.jobTrust.set(key,fingerprint);return fingerprint;
      }
    },ask:async prompt=>{
      const row=this.connections.get(prompt.connectionId);if(!row||this.job?.cancelled)throw new Error('일괄 작업이 취소되었습니다.');
      if(prompt.kind==='host-key'&&this.autoTrustHostKey)return {accept:true,remember:true,replace:false};
      if(prompt.kind==='host-key-changed'&&this.autoTrustChangedHostKey)return {accept:true,remember:true,replace:true};
      // A changed key is a possible spoofing signal. When the batch runs
      // unattended (auto trust on) it must fail closed and surface
      // HOST_KEY_CHANGED instead of asking or silently replacing the key.
      if(prompt.kind==='host-key-changed'&&this.autoTrustHostKey)return {accept:false};
      return this.askRow(this.job,row,prompt);
    },emit:event=>this.onEvent(event),getLogSettings:()=>({logEnabled:false}),binaryOutput:true});
  }
  async askRow(job,row,prompt){
    const connectionId=prompt.connectionId,previousPhase=row.phase;
    const check=()=>{
      if(this.job!==job||row.connectionId!==connectionId||this.connections.get(connectionId)!==row)throw new BatchFailure('일괄 연결이 종료되었습니다.');
      this.stopped(job,row);
    };
    check();
    row.authStarted=performance.now();row.authWaiting=true;row.phase='인증 확인';this.notify();let answer;
    const ended=new Promise((_,reject)=>{ row.endAuth=()=>reject(new BatchFailure('일괄 연결이 종료되었습니다.')); });
    try{answer=await Promise.race([ended,this.ask({...prompt,batch:true,batchGroup:row.group,batchHost:row.host,batchPort:row.port})]);}
    finally{delete row.endAuth;row.authPausedMs+=performance.now()-row.authStarted;row.authWaiting=false;row.phase=previousPhase;}
    check();
    // Keep answers only for output scrubbing on this row, not for authentication reuse.
    for(const value of [answer?.password,answer?.passphrase,...(Array.isArray(answer?.answers)?answer.answers:[])])if(typeof value==='string'&&value)row.secrets.push(value);
    this.invalidateLiveResult(row);
    return answer;
  }
  async answerDevicePassword(job,row,group,purpose,challenge){
    const connectionId=row.connectionId,sequence=row.sequence;
    const fail=(code,message)=>{row.failureCode=code;throw new BatchFailure(message);};
    let answer;
    try{answer=await this.askRow(job,row,{kind:'credentials',connectionId,fields:['password'],purpose,
      session:{name:row.group,host:row.host,port:row.port,username:row.username,protocol:row.protocol}});}
    catch(error){
      if(error?.code==='AUTH_RESPONSE_TIMEOUT')fail(error.code,'인증 응답 대기 시간이 초과되었습니다.');
      if(error?.code==='AUTH_REQUIRED')fail(error.code,'인증 응답이 올바르지 않습니다.');
      throw error;
    }
    if(!answer||answer.cancelled)fail('AUTH_CANCELLED','비밀번호 입력을 취소했습니다.');
    if(typeof answer.password!=='string'||!answer.password.length||answer.password.length>16384||/[\x00-\x1f\x7f]/.test(answer.password))fail('AUTH_REQUIRED','유효한 비밀번호를 입력해 주세요.');
    // Device state can advance while the modal is open. Do not send a late
    // secret into a shell, a different challenge or a replacement connection.
    await this.pollTransport();
    this.stopped(job,row);
    if(this.job!==job||row.connectionId!==connectionId||this.connections.get(connectionId)!==row||row.sequence!==sequence||
      (row.tail.activeLine||row.tail.line||lastNonEmptyLine(row.received))!==challenge)fail('CREDENTIAL_CHALLENGE','장비의 인증 요청이 변경되어 비밀번호를 전송하지 않았습니다. 다시 실행해 주세요.');
    this.sendLine(row,group,answer.password);
  }
  // Approve a plan. A stored credential is approved as (id + opaque
  // fingerprint of its private authentication material) plus the public
  // metadata the operator actually saw; the resolved plaintext stays only in
  // this draft so that `start` can prove it is still the approved value. A
  // directly typed secret lives no longer than the draft (V9-M-06).
  preview(input){
    if(this.closed)throw new Error('일괄 작업 서비스가 종료되었습니다.');
    if(this.job?.active)throw new Error('실행 중인 작업이 있습니다.');
    this.releaseDraft();
    const credentialBindings=new Map();
    const plan=normalizePlan(input,this.resolveCredential,{deferSecrets:true,recordCredential:binding=>{
      const key=binding.credentialId,existing=credentialBindings.get(key);
      // One credential can be shared by several groups; every affected group is
      // recorded so a single failure names all of them.
      if(existing){existing.groups.push(binding.groupName);return;}
      credentialBindings.set(key,{
        credentialId:key,groups:[binding.groupName],
        // Only the opaque fingerprint is kept: `start` proves equality by
        // re-resolving, so the approved plaintext is never retained in the
        // draft. Directly typed secrets still live in the plan (they are the
        // only copy) and are released with this draft.
        fingerprint:credentialFingerprint(binding.profile,binding.passphrase),
        profile:{...binding.profile}
      });
    }});
    const token=randomUUID();
    this.draft={token,plan,expires:Date.now()+this.draftTtlMs,credentialBindings};
    this.armDraftTimer();
    const dto={token,...publicPlan(plan)};
    // The public approval states which credential (and which group metadata) was
    // approved, never a fingerprint or a secret.
    return dto;
  }
  armDraftTimer(){
    clearTimeout(this.draftTimer);this.draftTimer=null;
    const draft=this.draft;if(!draft)return;
    const remaining=Math.max(0,draft.expires-Date.now());
    this.draftTimer=setTimeout(()=>{
      this.draftTimer=null;
      // Only the draft this timer was armed for is released: a newer preview may
      // already own the slot.
      if(this.draft===draft)this.draft=null;
    },remaining);this.draftTimer.unref?.();
  }
  // Releases the approval draft and everything it alone held: the resolved
  // stored secrets, the directly typed secrets and the approved plan.
  releaseDraft(){clearTimeout(this.draftTimer);this.draftTimer=null;this.draft=null;}
  clearPreview(){this.releaseDraft();this.liveResultCache=null;}
  // Proves every approved credential reference still resolves to the approved
  // material. Nothing is started unless *all* of them match, so a plan whose
  // second group lost its credential cannot send the first group's secret to a
  // device before failing.
  verifyCredentials(draft){
    const conflicts=[];
    for(const [credentialId,binding] of draft.credentialBindings){
      let resolved;
      try{resolved=this.resolveCredential({...binding.profile,protocol:'ssh'},credentialId);}
      catch(error){
        if(error?.code==='ERR_NOT_FOUND'){conflicts.push({group:binding.groups.join(', '),reason:'삭제됨'});continue;}
        // A store read failure is not a stale approval: it is reported as-is so
        // an operator never sees a decryption problem blamed on their edit.
        throw error;
      }
      const fingerprint=credentialFingerprint(resolved,resolved?.passphrase);
      if(fingerprint!==binding.fingerprint){conflicts.push({group:binding.groups.join(', '),reason:'변경됨'});continue;}

    }
    if(conflicts.length)throw credentialChanged(conflicts);

  }
  start(token){
    if(this.closed||this.job?.active)throw new Error('실행 중인 작업을 먼저 종료해 주세요.');
    const draft=this.draft;
    if(!draft||draft.token!==token||draft.expires<Date.now()){this.releaseDraft();throw new Error('실행 계획을 다시 확인해 주세요.');}
    // Every referenced credential is validated before any worker exists, so a
    // conflict in one group cannot leave another group's devices half-run. The
    // secret handed to the workers is the re-resolved, provably approved value.
    this.verifyCredentials(draft);
    this.releaseDraft();
    const groups=draft.plan.groups;
    const job={id:randomUUID(),active:true,cancelled:false,budgetExhausted:false,startedAt:new Date().toISOString(),finishedAt:null,concurrency:draft.plan.concurrency,rows:[],counts:{queued:draft.plan.devices.length},bytes:0,workers:[],groups,groupNames:[...new Set(groups.map(g=>g.name))],credentialBindings:draft.credentialBindings};
    job.rows=draft.plan.devices.map((d,i)=>({id:String(i),host:d.host,port:d.port,group:job.groups[d.groupIndex].name,groupIndex:d.groupIndex,protocol:job.groups[d.groupIndex].profile.protocol,username:job.groups[d.groupIndex].profile.username,status:'queued',message:'',commandIndex:0,commandCount:job.groups[d.groupIndex].commands.length,outputs:[],output:'',startedAt:null,finishedAt:null}));
    this.job=job;this.searchCache=null;this.liveResultCache=null;this.jobTrust=new Map();this.notify(true);let cursor=0;
    const worker=async()=>{while(!job.cancelled&&cursor<job.rows.length){
      const row=job.rows[cursor++];
      // The job-wide result budget is a terminal condition, not a per-row one.
      // Once it is spent the row must not connect at all, otherwise thousands
      // of queued devices still stream their first chunk into a full store.
      // The loop keeps running so every remaining row is retired with a reason.
      if(job.budgetExhausted){this.skipRow(job,row);continue;}
      await this.runRow(job,row,job.groups[row.groupIndex]);
    }};
    job.workers=Array.from({length:Math.min(job.concurrency,job.rows.length)},()=>worker());
    Promise.allSettled(job.workers).then(()=>{for(const row of job.rows)if(row.status==='queued'){this.setStatus(job,row,'cancelled');row.message='작업을 취소했습니다.';row.finishedAt=new Date().toISOString();}job.active=false;job.finishedAt=new Date().toISOString();job.groups=[];this.notify(true);}).catch(()=>{});return this.summary();
  }
  // A queued row that is retired because the job budget is gone. It is recorded
  // as an explicit, non-retryable failure so the operator sees why it never ran.
  skipRow(job,row){
    row.startedAt=new Date().toISOString();row.finishedAt=row.startedAt;row.failureCode='RESULT_BUDGET_EXCEEDED';
    row.message='총 결과 보존 한도(32MB)를 초과하여 실행하지 않았습니다.';row.output='';row.outputs=[];row.phase='건너뜀';
    this.setStatus(job,row,'error');
  }
  notify(immediate=false){
    if(this.closed)return;
    const delay=100-(performance.now()-this.lastNotification);
    if(!immediate&&delay>0){if(!this.notificationTimer)this.notificationTimer=setTimeout(()=>{this.notificationTimer=null;this.notify(true);},delay);return;}
    clearTimeout(this.notificationTimer);this.notificationTimer=null;this.lastNotification=performance.now();
    try{this.emit({type:'batch',summary:this.summary()});}catch{}
  }
  setStatus(job,row,status){if(row.status===status)return;if(DONE.has(status))this.invalidateLiveResult(row);const previous=job.counts[row.status];if(previous>1)job.counts[row.status]=previous-1;else delete job.counts[row.status];job.counts[status]=(job.counts[status]||0)+1;row.status=status;}
  summary(){const j=this.job;if(!j)return null;return {id:j.id,active:j.active,cancelled:j.cancelled,startedAt:j.startedAt,finishedAt:j.finishedAt,total:j.rows.length,counts:{...j.counts},concurrency:j.concurrency,totalBytes:j.bytes,budgetExhausted:!!j.budgetExhausted,groups:[...(j.groupNames||[])]};}
  // A row's failure message is decided once, from the *first* terminal code.
  // A later close (NOT_CONNECTED / CONNECTION_CLOSED) must never replace the
  // real cause: that is what made a TCP reset during authentication look like
  // the generic "could not connect or authenticate" text.
  connectionFailureMessage(row,event){
    const code=event.code||'CONNECTION_CLOSED';
    // A peer that vanished is not a wrong password. OmniSwitch style AAA also
    // drops the session on its own attempt limit or session limit, so the phase
    // and the safe code are both stated and nothing is claimed about the
    // credential itself.
    if(code==='ECONNRESET'||code==='EPIPE'||code==='ECONNABORTED'||code==='AUTH_CONNECTION_CLOSED'){
      return row.connectionReady
        ? `연결이 끊겼습니다 (${code}). 장비의 접속 제한·세션 상태를 확인해 주세요.`
        : `SSH 인증 중 연결이 끊겼습니다 (${code}). 장비의 접속 제한·잠금 상태를 확인해 주세요.`;
    }
    const codes={
      SSH_SIGNATURE_INVALID:'SSH 서버 서명 검증에 실패했습니다. 장비의 SSH 구현 또는 서버 키를 확인해 주세요.',
      SSH_ALGORITHM_MISMATCH:'SSH 알고리즘이 장비와 호환되지 않습니다. 호환성 설정을 확인해 주세요.',
      SSH_DSA_UNSUPPORTED:'장비의 DSA 전용 호스트 키를 지원하지 않습니다. RSA 호스트 키 사용 여부를 확인해 주세요.',
      // Not an assertion of lockout: a rejected credential and a device that has
      // started refusing the account look the same to the client.
      AUTH_FAILED:'SSH 인증이 거부되었습니다. 계정 정보와 장비의 잠금·접속 제한 상태를 확인한 뒤 새로 실행해 주세요.',
      AUTH_CONNECTION_CLOSED:'SSH 인증 중 연결이 끊겼습니다. 장비의 접속 제한·잠금 상태를 확인해 주세요.',
      AUTH_CANCELLED:'인증 입력을 취소해 연결하지 않았습니다.',
      AUTH_RESPONSE_TIMEOUT:'인증 응답 대기 시간이 초과되었습니다. 다시 실행해 주세요.',
      AUTH_REQUIRED:'SSH 인증 정보를 입력해 주세요.',
      AUTH_PASSWORD_CHANGE_REQUIRED:'SSH 비밀번호 변경이 필요합니다. 장비에서 비밀번호를 변경한 뒤 다시 연결해 주세요.',
      // The device asked for the same login password twice on one transport and
      // the client refused to answer again. Not a wrong password: the operator is
      // told to correct the secret and start a new run.
      AUTH_RETRY_NEW_CONNECTION_REQUIRED:'장비가 같은 연결에서 비밀번호 재입력을 지원하지 않습니다. 새로 실행해 주세요.',
      INVALID_KEY:'개인키 형식 또는 암호를 확인해 주세요.',
      AGENT_REQUIRED:'SSH 에이전트를 사용할 수 없습니다. 에이전트 소켓을 설정해 주세요.',
      HOST_KEY_REJECTED:'호스트 키 확인을 취소했습니다.',
      HOST_KEY_CHANGED:'변경된 호스트 키를 승인하지 않았습니다.',
      HANDSHAKE_TIMEOUT:'SSH 접속 제한 시간이 초과되었습니다.',
    };
    if(codes[code])return codes[code];
    return event.status==='error'?'접속 또는 인증에 실패했습니다.':'완료 전에 연결이 종료되었습니다.';
  }
  onEvent(event){
    if(event.type==='status'&&['error','disconnected'].includes(event.status))this.onDisconnect?.(event);
    const row=this.connections.get(event.id);if(!row)return;
    if(event.type==='status'){
      row.connectionStatus=event.status;
      // The secret-free authentication summary travels on the terminal event
      // because the service drops its connection map entry as it emits it.
      if(event.authentication)row.authSummary=event.authentication;
      if(event.status==='connected'){row.connectionReady=true;return;}
      if(!['error','disconnected'].includes(event.status))return;
      row.endAuth?.();
      if(row.outputError||row.firstFailureCode)return;
      row.firstFailureCode=event.code||'CONNECTION_CLOSED';
      row.failureCode=row.firstFailureCode;
      row.connectionError=this.connectionFailureMessage(row,event);
      return;
    }
    if(event.type==='data'){
      const job=this.job;
      const text=row.decoder.write(Buffer.isBuffer(event.data)?event.data:typeof event.data==='string'?Buffer.from(event.data,'base64'):Buffer.from(event.data));
      const alreadyLimited=!!row.outputError;
      const accepted=this.admitOutput(job,row,text);
      row.tail.write(accepted);row.sequence++;row.lastData=performance.now();row.lastDataClock=this.clock(row);
      try{if(row.transport)row.transport.encoding=this.transport.getConnectionInfo(event.id).encoding;}catch{}
      if(!alreadyLimited&&row.outputError){try{this.transport.disconnect(row.connectionId);}catch{}}
    }
  }
  // Account for the UTF-8 encoding of decoded text before retaining it,
  // including replacement characters emitted by decoder.end().
  // Once a suffix has been rejected, later in-flight data is rejected too so
  // the retained output remains a prefix of the received transcript.
  admitOutput(job,row,text){
    const bytes=Buffer.byteLength(text);
    if(!bytes)return '';
    if(row.outputError){row.rejectedBytes=(row.rejectedBytes||0)+bytes;return '';}
    const totalRoom=job?Math.max(0,LIMIT_TOTAL-job.bytes):LIMIT_TOTAL;
    const rowRoom=Math.max(0,LIMIT_ROW-(row.receivedBytes||0));
    const room=Math.min(bytes,totalRoom,rowRoom);
    const accepted=room>=bytes?text:text.slice(0,this.safeCut(text,room));
    const acceptedBytes=Buffer.byteLength(accepted);
    row.receivedBytes=(row.receivedBytes||0)+acceptedBytes;
    if(accepted){this.invalidateLiveResult(row);row.received+=accepted;}
    if(job)job.bytes+=acceptedBytes;
    if(acceptedBytes<bytes){
      row.rejectedBytes=(row.rejectedBytes||0)+bytes-acceptedBytes;
      row.limitScope=rowRoom===totalRoom?'both':rowRoom<totalRoom?'row':'job';
      row.failureCode='OUTPUT_LIMIT';
      row.outputError=row.limitScope==='row'
        ? '장비별 결과 크기 제한(2MiB)에 도달하여 수신을 중단했습니다. 명령의 출력 범위를 줄여 다시 실행해 주세요.'
        : row.limitScope==='job'
          ? '작업별 결과 크기 제한(32MiB)에 도달하여 수신을 중단했습니다. 장비 수나 출력 범위를 줄여 다시 실행해 주세요.'
          : '장비별(2MiB) 및 작업별(32MiB) 결과 크기 제한에 도달하여 수신을 중단했습니다. 장비 수나 출력 범위를 줄여 다시 실행해 주세요.';
    }
    // Reaching the total exactly prevents queued rows from connecting.
    if(job&&job.bytes>=LIMIT_TOTAL)job.budgetExhausted=true;
    return accepted;
  }
  // Largest prefix of `text` whose UTF-8 encoding fits in `limit` bytes, never
  // splitting a surrogate pair.
  safeCut(text,limit){
    if(limit<=0)return 0;
    let bytes=0;
    for(let index=0;index<text.length;index++){
      const char=text.charCodeAt(index);
      const width=char<0x80?1:char<0x800?2:char>=0xd800&&char<=0xdbff?4:3;
      if(bytes+width>limit)return index;
      bytes+=width;
      if(width===4)index++;
    }
    return text.length;
  }
  stopped(job,row){if(job.cancelled)throw new Error('작업을 취소했습니다.');if(row.outputError)throw new Error(row.outputError);if(row.connectionError)throw new Error(row.connectionError);}
  clock(row){return performance.now()-row.authPausedMs-(row.authWaiting?performance.now()-row.authStarted:0);}
  // Two check phases include a poll phase even when called from a check
  // callback, giving already-ready transport callbacks an opportunity to run.
  async pollTransport(){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));}
  async wait(job,row,predicate,timeoutMs,message='응답 대기 시간이 초과되었습니다. 뒤의 명령은 전송하지 않았습니다.',{idle=false,settleMs=timeoutMs}={}) {
    let since=this.clock(row),sequence=row.sequence;
    while(true){
      this.stopped(job,row);
      if(idle&&row.sequence!==sequence){sequence=row.sequence;since=row.lastDataClock??this.clock(row);}
      const checkedAt=performance.now(),result=predicate(),ready=result instanceof Promise?await result:result;
      // An evidence pass can cross the settling interval itself. Also confirm
      // every quiet candidate after polling: the loop may have been stalled
      // before this predicate ran, with transport data already waiting.
      if(idle&&checkedAt-row.lastData<settleMs&&performance.now()-row.lastData>=settleMs){await this.pollTransport();continue;}
      if(ready){
        if(!idle)return;
        const candidateSequence=row.sequence;await this.pollTransport();this.stopped(job,row);
        if(row.sequence!==candidateSequence)continue;
        return;
      }
      if(this.clock(row)-since>=timeoutMs){
        // At equal idle/quiet limits the last data may itself have taken time
        // to process, or its callback may already be queued. Give a ready
        // candidate the same poll/recheck before declaring the idle timeout.
        if(idle){
          const candidateSequence=row.sequence;await this.pollTransport();this.stopped(job,row);
          if(row.sequence!==candidateSequence)continue;
          const rechecked=predicate();if(rechecked instanceof Promise?await rechecked:rechecked)return;
        }
        row.failureCode='RESPONSE_TIMEOUT';throw new BatchFailure(message);
      }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
  sendLine(row,group,text=''){this.transport.input(row.connectionId,text+(row.protocol==='telnet'||group.enterKey==='cr'?'\r':'\r\n'));}
  // Login readiness, SmartNetwork style: the *settled stream* is the evidence,
  // not a prompt string and not the operator's completion phrase.
  //   1. A settled line that names a device (`Router>`, `<Huawei>`, `[~R]`) is
  //      learned as the session identity.
  //   2. Otherwise, once the one-time wake-up CR has been sent and the stream
  //      settles again without a prompt shape, the session is treated as ready
  //      exactly like SmartNetwork does. The line is remembered verbatim and
  //      `row.settledLogin` makes command completion fall back to output
  //      stabilization, so a banner-only login can never hang the row.
  // `group.prompt` is deliberately never applied here: an explicit phrase such
  // as `Router#` describes the *privileged* prompt and cannot exist before
  // `enable` has run, so requiring it at login burned the whole login budget.
  initialReady(row,group,line,settleFrom=0){
    if(!line)return false;
    if(performance.now()-row.lastData<group.quietMs)return false;
    // An authentication challenge is checked *before* the prompt matcher. A
    // Telnet `Password>` is prompt-shaped (`candidate()` reads it as the host
    // `Password`), so learning it made the session "ready" and sent the command
    // list into the login dialogue.
    if(credentialPrompt(line))return false;
    if(row.matcher.initial(line,'')){this.promptContract(row,group,line);return true;}
    // A banner or MOTD counts only after `settleFrom` — the wake-up CR was sent
    // (SSH) or the credential dialogue was answered (Telnet) — so the settle
    // rule never races the device's own prompt and never fires into an unknown
    // authentication prompt.
    if(!settleFrom||performance.now()-settleFrom<group.quietMs)return false;
    if(!row.sequence||!/\S/.test(row.received||''))return false;
    row.matcher.settle(line);row.settledLogin=true;row.promptContract='settled';
    return true;
  }
  // Which spelling may prove a finished command for this session.
  //  'explicit' — the learned login prompt really does spell the operator's
  //               completion phrase (`Router#` for `#`), so keep it strict.
  //  'learned'  — the phrase describes a *privileged* prompt the device has not
  //               produced (`Router>` while `#` was requested, usually because
  //               enable is not configured). Requiring it would stall every
  //               command until timeout, so the learned same-host prompt is the
  //               contract instead.
  //  'settled'  — no prompt-shaped line was ever printed; only settling can
  //               complete a command.
  // The identity check is never weakened: 'learned' still matches only the
  // device learned at login.
  promptContract(row,group,line){
    const expected=String(group.prompt??'').trim(),text=String(line??'').trim();
    const spelled=!expected||text===expected||/^[#>$%]$/.test(expected)&&text.endsWith(expected);
    row.promptContract=spelled?'explicit':'learned';
    return row.promptContract;
  }
  // The phrase a command must return to. Only the completion phrase that the
  // learned login prompt actually spells stays in force; a phrase for a prompt
  // this session never produced is dropped so the same-host learned prompt is
  // used instead of waiting out the timeout.
  effectivePrompt(row,group){
    return row.promptContract==='learned'?'':group.prompt;
  }
  // Command completion. The prompt contract stays authoritative whenever login
  // produced one; a no-echo device still finishes through stabilization. For a
  // session that only ever settled on a banner line (`row.settledLogin`) there
  // is no prompt to match, so SmartNetwork's settling rule is the only
  // available evidence — and the row must not hang waiting for one.
  settledComplete(row,group,firstResponse){
    if(firstResponse===null)return false;
    return row.settledLogin||group.completion==='quiet';
  }
  // SmartNetwork-style completion evidence. A fresh, prompt-shaped line proves a
  // command finished even when the operator's completion phrase or the learned
  // spelling does not match it — but only for the *same* device, so a prompt
  // printed inside command output can never be mistaken for the session's own.
  promptLike(row,line){
    const text=String(line??'').trim();
    if(!text)return false;
    // An authentication challenge never proves a command finished; accepting it
    // would let a re-prompt end the command and receive the next one.
    if(credentialPrompt(text))return false;
    // A line the matcher can name and that belongs to this device.
    if(candidate(text))return !!row.matcher.learned&&row.matcher.sameDevice(text);
    // A prompt whose spelling the matcher cannot parse but that still looks like
    // one — a single unbroken token ending in `#`/`>`: `switch(conf)#`. Without a
    // learned identity there is no evidence at all to compare it with, and with
    // one the token must still name that same device, so a foreign `[OtherDevice]#`
    // printed in body text cannot finish the command.
    if(!row.matcher.learned)return false;
    if(!(text.length<=240&&text.length>1&&!/\s/.test(text)&&!/%/.test(text)&&/[#>]$/.test(text)))return false;
    // An unparsed token carries no separate identity field: derive one from the
    // trailing prompt marker and require the same strict view/stack rule.
    const body=text.slice(0,-1);
    const learned=String(row.matcher.learned.identity??'');
    if(!learned)return false;
    return body===learned||sameView(learned.toLowerCase(),body.toLowerCase());
  }
  // Prompt-shaped foreign output must not become a quiet completion either.
  foreignPrompt(row,line){
    const text=String(line??'').trim();
    if(!text||credentialPrompt(text)||!row.matcher.learned)return false;
    const shaped=candidate(text)||(text.length<=240&&text.length>1&&!/\s/.test(text)&&!/%/.test(text)&&/[#>]$/.test(text));
    return !!shaped&&!row.matcher.matches(text,'')&&!this.promptLike(row,text);
  }
  // Track the terminal's visible lines after the command, independently of the
  // retained transcript. This parser is bounded by TerminalTail and handles
  // fragmented escape sequences and command echoes without rescanning output.
  responseEvidence(row,command,prompt,markStamp){
    const view=new TerminalTail();
    let unknownStart=!!row.tail.line.trim();
    let found=false;
    const consider=()=>{
      const line=view.line.trim();
      if(!line||echoPrefix(line,command,prompt)||credentialPrompt(line)||pager(line)||this.foreignPrompt(row,line))return;
      // A single overwritten cell in the pre-command prompt is not a reply.
      // An actual fresh one-cell prompt may still be completion evidence.
      if(unknownStart&&line.length===1&&!row.tail.freshSince(markStamp))return;
      found=true;
    };
    return {
      feed(text){
        if(found)return true;
        let start=0;
        for(let i=0;i<text.length;i++)if(text[i]==='\r'||text[i]==='\n'){
          if(i>start)view.write(text.slice(start,i));
          consider();view.write(text[i]);start=i+1;
          if(text[i]==='\n')unknownStart=false;
        }
        if(start<text.length)view.write(text.slice(start));
        consider();return found;
      },
      get found(){return found;}
    };
  }
  async ready(job,row,group,mark=0,initial=false,command='',offset=0,finalize=null){
    let pages=0,pagerMark=-1,entered=false,firstResponse=null,responseSequence=-1,response='';const started=performance.now(),startedClock=this.clock(row),tailVersion=row.tail.version,lastPrompt=row.matcher.learned?.line||'';
    // Prompt provenance: a completion prompt must be produced *after* the
    // command was sent. `mark` is the tail generation at send time, and
    // `promptStamp` is the oldest character still visible on the line, so a
    // trailing space or a single overwritten cell cannot promote a stale prompt.
    const markStamp=row.tail.stamp;
    const enabling=!initial&&isCiscoEnable(command);let passwordSent=false,passwordMark=mark;
    const quietCommand=!initial&&!enabling&&group.completion==='quiet';
    const evidence=quietCommand?this.responseEvidence(row,command,lastPrompt,markStamp):null;
    let evidenceOffset=offset;
    // SmartNetwork readiness bookkeeping: `nudgeAt` records the wake-up CR sent
    // to a device that printed a banner but no prompt, so the settled-stream
    // fallback cannot fire *before* the device had a chance to answer it.
    let nudgeAt=0;
    row.lastWait=null;let completed=false,currentTail='',preparedTiming=null;try{while(true){await this.wait(job,row,()=>{
      const tail=row.tail.activeLine||row.tail.line||(quietCommand?'':lastNonEmptyLine(row.received));
      currentTail=tail;
      if(initial&&!entered&&needsEnter(tail)){this.sendLine(row,group);entered=true;nudgeAt=performance.now();return false;}
      if(quietCommand){
        if(evidenceOffset<row.received.length){evidence.feed(row.received.slice(evidenceOffset));evidenceOffset=row.received.length;}
      }else if(responseSequence!==row.sequence){response=clean(row.received.slice(offset));responseSequence=row.sequence;}
      // In quiet mode a credential-shaped tail is ambiguous even when it looks
      // like a command echo. Fail closed rather than send the next command into
      // a repeated authentication prompt.
      if(!initial&&!enabling&&row.sequence>mark&&credentialPrompt(tail)&&(quietCommand||!echoPrefix(tail,command,lastPrompt))){
        row.failureCode='CREDENTIAL_CHALLENGE';
        throw new BatchFailure('명령 실행 중 인증 정보를 다시 요청했습니다. 후속 명령을 전송하지 않았습니다.');
      }
      if(pager(tail)){
        if(group.pager&&pagerMark!==row.sequence){if(++pages>1000)throw new BatchFailure('페이지 넘김 제한을 초과했습니다.');this.transport.input(row.connectionId,' ');pagerMark=row.sequence;}
        return false;
      }
      // A blank/newline-only packet advances the packet counter without
      // producing a new prompt line, so the reused previous line keeps its old
      // stamp. The lastNonEmptyLine fallback (used only when the bounded tail is
      // empty) still needs a genuine non-echo response line.
      const fallbackTail=!row.tail.line.trim()&&!row.tail.previousLine;
      const promptFresh=row.tail.freshSince(markStamp)||fallbackTail&&(quietCommand?evidence.found:hasResponse(response,command,lastPrompt));
      if(enabling&&row.sequence>mark){
        if(denied(response)||commandError(response)){row.failureCode='ENABLE_DENIED';throw new BatchFailure('권한 전환을 거부한 장비입니다. 후속 명령을 전송하지 않았습니다.');}
        if(/(?:password|passwd)\s*[:>]\s*$/i.test(tail)){
          if(!passwordSent){
            passwordSent=true;passwordMark=row.sequence;
            return this.answerDevicePassword(job,row,group,'enable',tail).then(()=>false);
          }
          return false;
        }
      }
      const echo=echoIsCommand(tail,command,lastPrompt);
      // An explicit completion phrase describes the *command* prompt. It must
      // never be imposed on the login prompt: a Cisco `Router>` cannot become
      // `Router#` until `enable` runs, so requiring `#` here burned the whole
      // login budget and failed every row with "초기 터미널 프롬프트 대기 시간이
      // 초과되었습니다". It is equally useless when the phrase names a
      // privileged prompt the device never reaches — see `promptContract`.
      const expected=this.effectivePrompt(row,group);
      const returned=!echo&&(initial?false:row.matcher.matches(tail,expected));
      const fresh=row.sequence>mark&&(initial||row.tail.version>tailVersion);
      // Huawei VRP devices often print a warning/info banner after SSH login and
      // then wait for a key press without ever showing a "Press ENTER" hint, so
      // <Huawei> never appears and the login wait times out. Once output has
      // settled without a prompt, nudge the device once with a gentle CR — but
      // never into a username/password prompt, which a blank CR would submit.
      if(initial&&!entered&&!candidate(tail)&&!credentialPrompt(tail)&&performance.now()-row.lastData>=group.quietMs&&performance.now()-started>=Math.max(1500,group.quietMs)){this.sendLine(row,group);entered=true;nudgeAt=performance.now();}
      if(!initial&&fresh&&firstResponse===null&&(quietCommand?evidence.found||returned&&promptFresh:returned||hasResponse(response,command,lastPrompt)))firstResponse=this.clock(row)-startedClock;
      if(!initial&&firstResponse===null&&this.clock(row)-startedClock>=group.responseTimeoutMs){row.failureCode='FIRST_RESPONSE_TIMEOUT';throw new BatchFailure('명령 에코 이후 첫 응답이 없습니다. 첫 응답 대기 시간이 초과되어 후속 명령을 중단했습니다.');}
      if(!fresh)return false;
      if(initial)return this.initialReady(row,group,tail,nudgeAt);
      // A device rejection must be reported even when a prompt came with it and
      // the strict completion path would otherwise finish the command.
      if(!quietCommand&&(denied(response)||group.stopOnError&&commandError(response))){row.failureCode='DEVICE_COMMAND_ERROR';throw new BatchFailure('장비가 명령 오류 또는 권한 거부를 반환했습니다. 후속 명령을 중단했습니다.');}
      if(performance.now()-row.lastData<group.quietMs)return false;
      if(enabling){
        if(row.sequence<=passwordMark)return false;
        // Privilege proof is separate from transport settling (H-06). Only a
        // same-device `#` prompt proves the transition; a returned `>` (the very
        // user mode enable started from) or a silent stream proves nothing, and
        // continuing there sends the command list without privilege.
        if(promptFresh&&privilegedLine(row,tail)){row.matcher.settle(tail);row.settledLogin=false;this.promptContract(row,group,tail);return true;}
        // A prompt that provably names *another* device is unrecoverable: the
        // command list must never be typed into a different box.
        if(candidate(tail)&&row.matcher.learned&&!row.matcher.sameDevice(tail)){
          row.failureCode='ENABLE_DENIED';
          throw new BatchFailure('권한 전환 후 같은 장비의 관리자(#) 프롬프트를 확인하지 못했습니다. 후속 명령을 전송하지 않았습니다.');
        }
        // Only a *repeated* credential challenge keeps the wait open: the device
        // is asking for the password again (a re-prompt or a rejected one), so
        // sending the command list now would type it into the challenge.
        if(credentialPrompt(tail))return false;
        // Anything else is an unverified transition. SmartNetwork-style quiet
        // settling is not evidence of privilege, so fail closed instead of
        // reporting success and streaming commands into user mode.
        row.failureCode='ENABLE_DENIED';
        throw new BatchFailure('권한 전환 후 관리자(#) 프롬프트를 확인하지 못했습니다. 후속 명령을 전송하지 않았습니다.');
      }
      if(quietCommand){
        // Check the entire retained command output once before advancing, so an
        // old error is not lost when the bounded terminal tail has moved on.
        if(this.foreignPrompt(row,tail))return false;
        return firstResponse!==null;
      }
      // A prompt only completes the command when the line itself was produced
      // after the command was sent; quiet completion keeps the settled-output
      // path so no-echo devices still finish.
      if(returned&&promptFresh)return true;
      // SmartNetwork never requires the operator's completion phrase: once new
      // output has arrived and the stream went quiet, a *same-device* prompt
      // whose spelling the strict contract rejects (`Router#` for a different
      // literal, a sub-view prompt, an ANSI-wrapped prompt) still proves this
      // command finished. Freshness stays strict so a prompt printed before the
      // command cannot complete it. Without this, such a row sat until the 30s
      // command deadline and failed with
      // "명령 완료 프롬프트 대기 시간이 초과되었습니다".
      //
      // The relaxation is *only* for a contract that was never spelled out. When
      // the operator typed an exact completion phrase and the login prompt
      // really spells it (`promptContract==='explicit'`), a different line is a
      // mismatch, not a spelling of the same thing: `Router>` must never finish
      // a command that was told to wait for `Router#` (V4 H-01). An operator who
      // *chose* quiet completion still gets it, and the row records that the
      // command finished on stabilization rather than on a prompt.
      if(row.promptContract==='explicit')return group.completion==='quiet'&&this.settledComplete(row,group,firstResponse);
      if(row.tail.freshSince(markStamp)&&this.promptLike(row,row.tail.activeLine||tail))return true;
      return this.settledComplete(row,group,firstResponse);
    },initial?group.loginTimeoutMs:quietCommand?group.timeoutMs:Math.max(0,group.timeoutMs-(this.clock(row)-startedClock)),initial?'로그인 후 초기 터미널 프롬프트 대기 시간이 초과되었습니다.':'명령 응답 대기 시간이 초과되었습니다. 후속 명령을 중단했습니다.',{idle:quietCommand,settleMs:group.quietMs});
      if(quietCommand){
        // Inspect the complete command once, immediately before advancing, so
        // errors that have passed out of the bounded tail remain authoritative.
        response=clean(row.received.slice(offset));
        if(denied(response)||group.stopOnError&&commandError(response)){row.failureCode='DEVICE_COMMAND_ERROR';throw new BatchFailure('장비가 명령 오류 또는 권한 거부를 반환했습니다. 후속 명령을 중단했습니다.');}
      }
      if(finalize){
        // Output cleaning/redaction can be expensive. Recheck the same command
        // after polling if a callback arrived while those results were prepared.
        const sequence=row.sequence;finalize(response);preparedTiming={durationMs:Math.round(performance.now()-started),firstResponseMs:firstResponse===null?null:Math.round(firstResponse),completion:initial?'initial-prompt':row.matcher.matches(currentTail,this.effectivePrompt(row,group))?'prompt':'quiet',prompt:scrubStream(currentTail,row.secrets)};
        await this.pollTransport();this.stopped(job,row);
        if(row.sequence!==sequence)continue;
      }
      break;
    }completed=true;}
    finally{row.lastWait=completed&&preparedTiming?preparedTiming:{durationMs:Math.round(performance.now()-started),firstResponseMs:firstResponse===null?null:Math.round(firstResponse),completion:!completed?'stopped':initial?'initial-prompt':row.matcher.matches(currentTail,this.effectivePrompt(row,group))?'prompt':'quiet',prompt:scrubStream(currentTail,row.secrets)};}
    return row.lastWait;
  }
  async telnetLogin(job,row,group){
    this.setStatus(job,row,'login');row.phase='Telnet 로그인';this.notify();const started=performance.now();let userSent=false,passwordSent=false,entered=false,nudgeAt=0,dialogueDone=0;
    await this.wait(job,row,()=>{
      const tail=row.tail.activeLine||row.tail.line||lastNonEmptyLine(row.received);
      if(!entered&&needsEnter(tail)){this.sendLine(row,group);entered=true;nudgeAt=performance.now();return false;}
      // One classifier for the whole dialogue (V3-H-07): the account half is
      // answered once with the configured username, the password half once with
      // the password, and neither is ever read as a prompt by `candidate()`.
      const kind=credentialKind(tail);
      if(kind==='username'&&group.profile.username&&!userSent){this.sendLine(row,group,group.profile.username);userSent=true;return false;}
      if(kind==='password'&&!passwordSent){passwordSent=true;return this.answerDevicePassword(job,row,group,'telnet-login',tail).then(()=>{dialogueDone=performance.now();return false;});}
      if(/(?:login incorrect|authentication failed|access denied|invalid password)/i.test(tail))throw new BatchFailure('Telnet 인증에 실패했습니다.');
      // Same SmartNetwork rule as SSH: a settled stream after the credential
      // dialogue is readiness, whether or not the prompt is prompt-shaped. The
      // explicit completion phrase is never required here — it belongs to the
      // privileged command prompt, not the login prompt.
      if(performance.now()-row.lastData<group.quietMs)return false;
      // A device that printed a banner and now sits silent gets the same single
      // gentle CR the SSH path sends, so a key-press prompt still arrives
      // before the settle rule may accept the banner as readiness.
      if(!entered&&!candidate(tail)&&!credentialPrompt(tail)&&!dialogueDone&&performance.now()-started>=Math.max(1500,group.quietMs)){
        this.sendLine(row,group);entered=true;nudgeAt=performance.now();return false;
      }
      return this.initialReady(row,group,tail,dialogueDone||nudgeAt);
    },group.loginTimeoutMs,'Telnet 로그인 또는 초기 프롬프트 대기 시간이 초과되었습니다.');
  }
  async connectRow(job,row,group,profileId){
    const started=this.clock(row),modes=row.protocol==='ssh'&&group.sshCompatibility==='auto'?['smartnetwork','legacy']:[group.sshCompatibility==='legacy'?'legacy':'standard'];
    row.attempts=[];row.compatibilityFallback=false;const endpoint=`${row.host}:${row.port}`;
    try{for(let index=0;index<modes.length;index++){
      this.stopped(job,row);
      const remaining=Math.ceil(group.connectTimeoutMs-(this.clock(row)-started));
      if(remaining<=0){row.failureCode='HANDSHAKE_TIMEOUT';throw new BatchFailure('접속 제한 시간이 초과되었습니다. 명령을 전송하지 않았습니다.');}
      // Endpoint-scoped admission (V6-H-01): if this same address still has a
      // teardown whose socket close was never observed, connecting again would put
      // two device sessions on one endpoint — exactly the collision the audit
      // reproduced (server max open sockets=2). Wait a bounded slice of this row's
      // own budget for the truth, and refuse the attempt if it never arrives.
      // Other endpoints are never serialized behind this one.
      await this.awaitEndpointClear(job,row,endpoint,Math.max(50,Math.min(1500,Math.ceil(remaining/3))));
      row.connectionReady=false;row.connectionStatus=undefined;row.connectionError=undefined;row.failureCode='';row.firstFailureCode='';
      const attempt={number:index+1,mode:modes[index],status:'connecting',durationMs:0,failureCode:''},at=this.clock(row);row.attempts.push(attempt);
      try{
        const connected=this.transport.connect(profileId,{passphrase:group.passphrase,cols:180,rows:50,handshakeTimeoutMs:Math.max(10,remaining),sshCompatibility:modes[index],autoEncoding:group.autoEncoding});
        row.connectionId=connected.id;this.connections.set(connected.id,row);
        await this.wait(job,row,()=>row.connectionStatus==='connected',remaining,'접속 제한 시간이 초과되었습니다. 명령을 전송하지 않았습니다.');
        attempt.status='connected';row.compatibilityUsed=modes[index];return;
      }catch(error){
        if(row.failureCode==='RESPONSE_TIMEOUT')row.failureCode='HANDSHAKE_TIMEOUT';
        attempt.status=job.cancelled?'cancelled':'failed';attempt.failureCode=row.failureCode||'CONNECTION_START_FAILED';
        // The handle is taken from the service synchronously and awaited here, so
        // a failed attempt's TCP socket is really closed before this row either
        // retries the same endpoint with another algorithm group or reports the
        // failure. A rejected attempt that is merely detached from the maps (the
        // old behaviour) could still hold the device session open while the
        // operator's next run reached it.
        this.connections.delete(row.connectionId);
        // The close wait is bounded by whatever is left of this row's connect
        // budget as well: a device that stalls its FIN must not push the
        // compatibility retry past the shared deadline the plan promised.
        const closeBudget=Math.max(50,Math.min(2000,Math.ceil(group.connectTimeoutMs-(this.clock(row)-started))));
        row.teardown=await this.closeRowConnection(row,{timeoutMs:closeBudget});
        // A compatibility fallback reconnects to the *same* endpoint. When the
        // first attempt's socket close was not observed, that retry is the
        // collision itself, so it is not taken: the row reports the bounded miss
        // and the endpoint stays quarantined until a later waiter sees the close.
        const retry=index+1<modes.length&&!job.cancelled&&!row.connectionReady&&row.sequence===0&&row.commandIndex===0&&row.failureCode==='SSH_ALGORITHM_MISMATCH'&&row.teardown.closed===true;
        if(!retry){row.connectionId=undefined;attempt.teardownConfirmed=row.teardown.closed;throw error;}
        row.connectionId=undefined;row.connectionError=undefined;row.connectionStatus=undefined;row.failureCode='';row.compatibilityFallback=true;row.phase='구형 호환 재시도';this.notify(true);
      }finally{attempt.durationMs=Math.max(0,Math.round(this.clock(row)-at));}
    }}finally{row.timings.connectMs=Math.max(0,Math.round(this.clock(row)-started));}
  }
  // Endpoint-scoped bounded admission. A teardown whose real socket close was
  // never observed is remembered per address; the next attempt to that address
  // re-asks the owning transport (its retained record answers `true` once the
  // close really happened) instead of blindly opening a second device session.
  async awaitEndpointClear(job,row,endpoint,timeoutMs){
    if(!this.unconfirmedCloses.size)return true;
    if(![...this.unconfirmedCloses.values()].some(entry=>entry.endpoint===endpoint))return true;
    const deadline=performance.now()+Math.max(0,timeoutMs||0);
    while(true){
      const pending=[...this.unconfirmedCloses].filter(([,entry])=>entry.endpoint===endpoint);
      if(!pending.length)return true;
      for(const [id,entry] of pending){
        // A quarantine that outlives the service's own close record can never be
        // cleared by asking the transport again: the record was pruned after its
        // TTL, so the answer is permanently "no evidence" and the endpoint would
        // stay blocked for the rest of the process (V7-M-02). The quarantine owns
        // the close promise itself, so it retires when that promise settles even
        // though the record is gone.
        if(entry.settled===true){this.unconfirmedCloses.delete(id);continue;}
        if(entry.promise){
          let closed=false;
          try{closed=await this.settledWithin(entry.promise,Math.max(0,Math.min(250,deadline-performance.now())));}catch{}
          // The promise settling *is* the evidence: the socket emitted 'close'.
          if(closed){this.unconfirmedCloses.delete(id);continue;}
          continue;
        }
        // No promise (a transport double that only offers `disconnect`): the gate
        // is still bounded, so a pruned record cannot block the endpoint forever.
        // It is never treated as "closed" — only as expired evidence.
        if(entry.expiresAt&&performance.now()>=entry.expiresAt){
          this.unconfirmedCloses.delete(id);
          row.teardownQuarantineExpired=true;
          continue;
        }
        let closed=false;
        try{closed=await this.transport.disconnectAndWaitClosed(id,{timeoutMs:Math.max(0,Math.min(250,deadline-performance.now()))})===true;}catch{}
        // Only this endpoint's own evidence is retired; another address's pending
        // teardown keeps its own record for its own next attempt.
        if(closed)this.unconfirmedCloses.delete(id);
      }
      if(![...this.unconfirmedCloses.values()].some(entry=>entry.endpoint===endpoint))return true;
      if(this.stopped(job,row),performance.now()>=deadline){
        row.failureCode='ENDPOINT_CLOSE_PENDING';
        throw new BatchFailure('이전 연결의 종료가 확인되지 않아 같은 장비에 다시 접속하지 않았습니다. 잠시 후 다시 실행해 주세요.');
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }

  // Resolves true when the promise settles inside the budget, false otherwise.
  // Used for the quarantine's own close promise, which must never be awaited
  // without a bound.
  async settledWithin(promise,timeoutMs){
    if(!(timeoutMs>0))return false;
    return new Promise(resolve=>{
      let done=false;
      const timer=setTimeout(()=>{if(!done){done=true;resolve(false);}},timeoutMs);timer.unref?.();
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve(true);};
      Promise.resolve(promise).then(finish,finish);
    });
  }
  // Waits for this row's own transport close, bounded. The result is metadata,
  // never an invented "closed": `{closed:true}` means the socket close event was
  // observed, `{closed:false,timedOut:true}` means teardown is still unconfirmed
  // when the row finished. Only this connection is awaited, so one stalled device
  // cannot hold the other workers.
  async closeRowConnection(row,{timeoutMs=2000}={}){
    const id=row.connectionId;
    if(typeof id!=='string'||!id)return {closed:true,timeoutMs:0,skipped:true};
    const started=performance.now();
    let closed=false;
    try{
      if(typeof this.transport.disconnectAndWaitClosed==='function')closed=await this.transport.disconnectAndWaitClosed(id,{timeoutMs})===true;
      else if(typeof this.transport.disconnect==='function')await Promise.resolve(this.transport.disconnect(id));
    }catch{}
    // Read the close promise *after* the teardown was requested: the transport
    // creates its record while finishing, so asking earlier would find nothing.
    // Holding the promise is what lets this quarantine outlive the transport's own
    // close-record retention, which prunes the record after a TTL and would
    // otherwise leave the endpoint blocked with no way to ever learn the truth
    // (V7-M-02).
    const promise=typeof this.transport.waitForClose==='function'?this.transport.waitForClose(id):null;
    const endpoint=typeof row.host==='string'&&row.port?`${row.host}:${row.port}`:'';
    // Keep the unconfirmed teardown as evidence: the row reports the bounded miss,
    // and any later attempt to the same endpoint must check it before connecting.
    if(closed)this.unconfirmedCloses.delete(id);
    else{
      const entry={endpoint,at:performance.now(),promise,settled:false};
      // The promise settling means the socket really emitted 'close', so the
      // quarantine retires *itself*: no later attempt has to ask a transport whose
      // close record may already be pruned, and the endpoint is unblocked the
      // moment the truth arrives (V7-M-02).
      if(promise&&typeof promise.then==='function'){
        const retire=()=>{entry.settled=true;if(this.unconfirmedCloses.get(id)===entry)this.unconfirmedCloses.delete(id);};
        promise.then(retire,retire);
      }
      else entry.expiresAt=performance.now()+UNCONFIRMED_CLOSE_TTL_MS;
      this.unconfirmedCloses.set(id,entry);
    }
    return {closed,timeoutMs:Math.round(performance.now()-started),...(closed?{}:{timedOut:true})};
  }
  // Cisco enable, shared by the separate `enableCommand` option and the inline
  // `enable` command. The challenge is answered once, then the transition is
  // only accepted when the device prints a privileged `#` prompt that still
  // belongs to the same device. Transport settling alone is *not* proof of
  // privilege (H-06): a device that returns to the same `Router>` user mode, or
  // prints nothing new at all, is reported as ENABLE_DENIED instead of running
  // the command list unprivileged.
  async privilegeState(job,row,group,mark,offset,timeoutMs,message){
    const started=performance.now(),before=row.tail.activeLine||row.tail.line||lastNonEmptyLine(row.received);
    let passwordSent=false,settledLine='';const markStamp=row.tail.stamp;
    // The proof of privilege must be newer than the last thing the device was
    // told: after answering the challenge, the echo of the password counts as
    // output, and a prompt printed before it cannot prove the transition.
    let passwordStamp=markStamp;
    await this.wait(job,row,()=>{
      const tail=row.tail.activeLine||row.tail.line||lastNonEmptyLine(row.received);
      const response=clean(row.received.slice(offset));
      if(denied(response)||commandError(response)){row.failureCode='ENABLE_DENIED';throw new BatchFailure('권한 전환을 거부한 장비입니다. 명령 목록을 전송하지 않았습니다.');}
      if(row.sequence>mark&&!passwordSent&&/(?:password|passwd)\s*[:>]\s*$/i.test(tail)){
        passwordSent=true;passwordStamp=row.tail.stamp;
        return this.answerDevicePassword(job,row,group,'enable',tail).then(()=>false);
      }
      // Nothing can be concluded before the enable reply (and the challenge
      // answer, when there was one) has actually started arriving.
      if(row.sequence<=mark)return false;
      // The device may print the new prompt on the same physical line as the
      // password challenge (no CRLF in between), so inspect the last complete
      // line of the response as well as the bounded tail.
      const lastLine=lastNonEmptyLine(response)||tail;
      // `Router> Password: OtherDevice# ` has no line break in it: the response
      // ends with the prompt, so take its final token when the tail (which only
      // tracks the current physical line) is not itself prompt-shaped.
      const trailing=/([^\s>]*[#>$%])\s*$/.exec(tail);
      const promptText=candidate(tail)?tail:(trailing?trailing[1]:lastLine);
      // Privilege proof: a fresh `#` prompt for the same device. This is decided
      // on the prompt itself, not on settling, so it stays true while the device
      // keeps printing.
      const proofFrom=passwordSent?passwordStamp:markStamp;
      const promptFresh=row.tail.freshSince(proofFrom);
      // The proof is *not* consumed the moment it appears: the row has to go
      // quiet for quietMs first, exactly like the inline `enable` path. A Cisco
      // device can print `Router#` and then `% Access denied` 60ms later; the old
      // separate-enable fast path returned on the prompt and sent the command
      // list into the rejection (H-06). `denied(response)` above is re-evaluated
      // on every tick, so the late denial is caught while we wait here.
      if(performance.now()-row.lastData<group.quietMs)return false;
      if(promptFresh&&privilegedPrompt(row,group,promptText)){
        settledLine=promptText;row.settledLogin=false;this.promptContract(row,group,promptText);return true;
      }
      // A prompt that provably names another device is unrecoverable: the
      // command list must never be typed into a different box.
      if(candidate(promptText)&&row.matcher.learned&&!row.matcher.sameDevice(promptText)){
        row.failureCode='ENABLE_DENIED';
        throw new BatchFailure('권한 전환 후 같은 장비의 관리자(#) 프롬프트를 확인하지 못했습니다. 명령 목록을 전송하지 않았습니다.');
      }
      // After the challenge was answered, a repeated credential challenge means
      // the device is asking again; settling there would type the command list
      // into the prompt.
      if(credentialPrompt(tail))return false;
      // The stream settled without a privileged prompt. A `>` is the very user
      // mode enable started from, and silence is no evidence at all, so neither
      // may be reported as a successful transition (H-06).
      row.failureCode='ENABLE_DENIED';
      throw new BatchFailure(candidate(promptText)&&promptText===before
        ? '권한 전환 후 프롬프트가 바뀌지 않았습니다. 관리자(#) 프롬프트를 확인하지 못해 명령 목록을 전송하지 않았습니다.'
        : '권한 전환 후 관리자(#) 프롬프트를 확인하지 못했습니다. 명령 목록을 전송하지 않았습니다.');
    },timeoutMs,message);
    // The transition succeeded; the operator's completion phrase now either
    // matches the learned prompt (spelled) or is dropped in favour of it.
    if(settledLine)this.promptContract(row,group,settledLine);
    row.timings.enableMs=Math.round(performance.now()-started);
  }
  // V9-M-06: a queued row must not resolve its secret from an approval that
  // went stale while it waited. Immediately before the secret is used, every
  // credential this row's own group references is re-resolved and proved
  // unchanged; the freshly resolved material is what the row then uses (equal
  // by fingerprint, so the approved value is preserved). A conflict fails this
  // row with CREDENTIAL_CHANGED and asks for a new preview — the latest value
  // is never silently substituted. Another group's revocation is that group's
  // own problem: its rows fail, not this one's.
  rowGroup(job,row,group){
    const bindings=job.credentialBindings;
    if(!bindings?.size||!group.credentialId)return group;
    const binding=bindings.get(group.credentialId);
    if(!binding)return group;
    let resolved;
    try{resolved=this.resolveCredential({...binding.profile,protocol:'ssh'},binding.credentialId);}
    catch(error){
      if(error?.code!=='ERR_NOT_FOUND')throw error;
      const failure=credentialChanged([{group:binding.groups.join(', '),reason:'삭제됨'}]);
      row.failureCode=failure.failureCode;throw failure;
    }
    if(credentialFingerprint(resolved,resolved?.passphrase)!==binding.fingerprint){
      const failure=credentialChanged([{group:binding.groups.join(', '),reason:'변경됨'}]);
      row.failureCode=failure.failureCode;throw failure;
    }
    return {...group,passphrase:group.profile.protocol==='ssh'&&resolved.authType==='key'&&typeof resolved.passphrase==='string'?resolved.passphrase:''};
  }
  async runRow(job,row,group){
    const profileId=randomUUID();row.startedAt=new Date().toISOString();this.setStatus(job,row,'connecting');row.phase='접속';row.received='';row.receivedBytes=0;row.decoder=new StringDecoder('utf8');row.tail=new TerminalTail();row.matcher=new PromptMatcher();row.sequence=0;row.lastData=performance.now();row.authPausedMs=0;row.authWaiting=false;row.settledLogin=false;row.promptContract=null;row.timings={};row.secrets=[];this.notify();
    try{
      group=this.rowGroup(job,row,group);
      if(group.passphrase)row.secrets.push(group.passphrase);
      this.profiles.set(profileId,{...group.profile,id:profileId,host:row.host,port:row.port,logEnabled:false});
      await this.connectRow(job,row,group,profileId);
      const info=this.transport.getConnectionInfo(row.connectionId);row.transport={terminalType:info.terminalType,encoding:info.encoding,authType:info.authType||'telnet',authenticationKey:info.authenticationKey||null,authenticationMethod:info.authenticationMethod||null,authenticationAttempts:info.authenticationAttempts||[],enterKey:group.enterKey,sshCompatibility:row.compatibilityUsed,compatibilityFallback:row.compatibilityFallback,attemptCount:row.attempts.length,negotiated:info.negotiated||null};
      const inlineEnableIndex=group.commands.findIndex(isCiscoEnable);
      // An explicit privileged prompt applies after enable, not to Router> or
      // the paging setup commands that intentionally precede inline enable.
      const loginGroup=group.enableCommand||inlineEnableIndex>=0?{...group,prompt:''}:group;
      row.phase='초기 프롬프트';this.setStatus(job,row,'login');this.notify();const loginStart=performance.now();
      if(row.protocol==='telnet')await this.telnetLogin(job,row,loginGroup);else await this.ready(job,row,loginGroup,0,true);row.timings.loginMs=Math.round(performance.now()-loginStart);
      if(group.enableCommand){
        row.phase='권한 전환';this.notify();
        const mark=row.sequence,offset=row.received.length;
        this.sendLine(row,group,group.enableCommand);
        await this.privilegeState(job,row,group,mark,offset,group.loginTimeoutMs,'권한 전환 후 프롬프트 대기 시간이 초과되었습니다.');
      }
      this.setStatus(job,row,'running');this.notify();
      for(let index=0;index<group.commands.length;index++){
        if(index>0&&group.completion!=='quiet'){row.phase='명령 간 대기';this.notify();const intervalStart=performance.now(),previous=row.outputs.at(-1);while(true){await this.wait(job,row,()=>{
          const tail=row.tail.activeLine||row.tail.line||lastNonEmptyLine(row.received);
          if(credentialPrompt(tail)&&!echoIsCommand(tail,group.commands[index-1],row.matcher.learned?.line||'')){row.failureCode='CREDENTIAL_CHALLENGE';throw new BatchFailure('명령 실행 중 인증 정보를 다시 요청했습니다. 후속 명령을 전송하지 않았습니다.');}
          if(pager(tail)||this.foreignPrompt(row,tail))return false;
          return performance.now()-intervalStart>=group.commandDelayMs&&performance.now()-row.lastData>=group.quietMs;
        },group.timeoutMs);const sequence=row.sequence,response=clean(row.received.slice(previous.rawOffset));
          previous.output=this.redact(row,response);
          if(denied(response)||group.stopOnError&&commandError(response)){row.failureCode='DEVICE_COMMAND_ERROR';throw new BatchFailure('장비가 명령 오류 또는 권한 거부를 반환했습니다. 후속 명령을 중단했습니다.');}
          await this.pollTransport();this.stopped(job,row);
          if(row.sequence===sequence)break;
        }}
        if(group.completion==='quiet'&&index>0){
          row.phase='명령 간 대기';this.notify();const intervalStart=performance.now(),previous=row.outputs.at(-1);
          while(true){
            await this.wait(job,row,()=>{
              const tail=row.tail.activeLine||row.tail.line||lastNonEmptyLine(row.received);
              if(credentialPrompt(tail)){row.failureCode='CREDENTIAL_CHALLENGE';throw new BatchFailure('명령 실행 중 인증 정보를 다시 요청했습니다. 후속 명령을 전송하지 않았습니다.');}
              if(pager(tail)||this.foreignPrompt(row,tail))return false;
              return performance.now()-intervalStart>=group.commandDelayMs&&performance.now()-row.lastData>=group.quietMs;
            },Math.max(group.timeoutMs,group.commandDelayMs+group.quietMs),undefined,{idle:true,settleMs:group.quietMs});
            const sequence=row.sequence,response=clean(row.received.slice(previous.rawOffset));
            previous.output=this.redact(row,response);
            if(denied(response)||group.stopOnError&&commandError(response)){row.failureCode='DEVICE_COMMAND_ERROR';throw new BatchFailure('장비가 명령 오류 또는 권한 거부를 반환했습니다. 후속 명령을 중단했습니다.');}
            row.nextOutputOffset=this.redact(row,clean(row.received)).length;
            await this.pollTransport();this.stopped(job,row);
            if(row.sequence===sequence)break;
          }
        }
        row.phase='명령 응답';
        this.stopped(job,row);row.commandIndex=index+1;const command=group.commands[index],offset=row.received.length,outputOffset=group.completion==='quiet'&&index>0?row.nextOutputOffset:this.redact(row,clean(row.received)).length,mark=row.sequence;const startedAt=new Date().toISOString();
        if(group.completion!=='quiet'||index===0)this.notify();
        this.sendLine(row,group,command);if(group.completion==='quiet'&&index>0)this.notify();let timing=null;
        const commandGroup=!group.enableCommand&&index<inlineEnableIndex?loginGroup:group;
        const output={index:index+1,command:'',outputOffset,rawOffset:offset,timing:null,startedAt,finishedAt:null,output:''};
        const finalize=group.completion==='quiet'?response=>{
          output.command=this.redact(row,command);
          output.output=this.redact(row,response||clean(row.received.slice(offset)));
          if(index+1>=group.commands.length){
            const fullOutput=this.redact(row,clean(row.received));
            row.preparedOutput={sequence:row.sequence,text:fullOutput,bytes:Buffer.byteLength(fullOutput)};
          }
        }:null;
        try{
          timing=await this.ready(job,row,commandGroup,mark,false,command,offset,finalize);
        }finally{
          output.timing=timing||row.lastWait;output.finishedAt=new Date().toISOString();
          if(!timing||!finalize){output.command=this.redact(row,command);output.output=this.redact(row,clean(row.received.slice(offset)));}
          row.outputs.push(output);
        }
      }
      // Report what actually happened: SmartNetwork-style settling can complete
      // a command, so the message must not claim every completion prompt was
      // verified when some finished on output stabilization.
      const settled=row.outputs.some(output=>output.timing?.completion==='quiet');
      this.setStatus(job,row,'success');row.message=(row.compatibilityFallback?'구형 호환으로 연결했습니다. ':'')+(group.completion==='quiet'||settled?'출력 안정화 조건으로 완료했습니다.':'모든 명령의 완료 프롬프트를 확인했습니다.');
    }catch(error){this.setStatus(job,row,job.cancelled?'cancelled':'error');row.message=job.cancelled?'작업을 취소했습니다.':row.outputError||row.connectionError||(error instanceof BatchFailure?error.message:'접속·로그인 또는 명령 실행을 완료하지 못했습니다. 뒤의 명령은 전송하지 않았습니다.');}
    finally{
      this.invalidateLiveResult(row);
      const decoderTail=row.decoder?this.admitOutput(job,row,row.decoder.end()):'';
      if(row.outputError&&!job.cancelled){this.setStatus(job,row,'error');row.message=row.outputError;}
      const prepared=row.status==='success'&&!decoderTail&&row.preparedOutput?.sequence===row.sequence?row.preparedOutput:null;
      row.output=prepared?prepared.text:this.redact(row,clean(row.received));row.outputBytes=prepared?prepared.bytes:Buffer.byteLength(row.output);
      row.finishedAt=new Date().toISOString();row.phase=row.status==='success'?'완료':row.phase;this.connections.delete(row.connectionId);
      // Every row — success, failure, cancel — waits for its *own* TCP socket to
      // report close before it is retired, so the next run of the same device
      // starts from a transport that no longer exists. This waits only on this
      // row's connection (and only up to a bound), so a stalled device can never
      // block the other workers. A bound that expires is kept as explicit
      // metadata (`teardown`) rather than being reported as closed. A row whose
      // connection was already retired inside connectRow keeps that evidence.
      const closing=await this.closeRowConnection(row);
      if(!closing.skipped||!row.teardown)row.teardown=closing;
      for(const output of row.outputs)delete output.rawOffset;
      this.profiles.delete(profileId);for(const key of ['decoder','tail','matcher','received','secrets','connectionId','sequence','lastData','lastDataClock','connectionStatus','connectionReady','connectionError','outputError','authPausedMs','authWaiting','authStarted','settledLogin','promptContract','firstFailureCode','nextOutputOffset','preparedOutput'])delete row[key];
      this.notify();
    }
  }
  // One redaction entry point for every consumer (live detail, timed metadata,
  // final output and exports) so no path can return a shorter-form leak.
  redact(row,text){return scrubStream(text,row?.secrets);}
  cancel(){const j=this.job;this.releaseDraft();this.liveResultCache=null;this.searchCache=null;if(!j?.active)return false;j.cancelled=true;for(const row of this.connections.values()){
    row.endAuth?.();
    try{this.transport.disconnect(row.connectionId);}catch{}
  }this.notify(true);return true;}
  assertJob(id){if(!this.job||id!==this.job.id)throw new Error('결과 작업을 찾을 수 없습니다.');return this.job;}
  rowMetadata(row){return {id:row.id,host:row.host,port:row.port,group:row.group,protocol:row.protocol,username:row.username,status:row.status,statusText:STATUS[row.status],phase:row.phase,message:this.redact(row,row.message||''),failureCode:row.failureCode||'',transport:row.transport||null,auth:row.authSummary?{...row.authSummary}:null,timings:row.timings||{},attempts:(row.attempts||[]).map(a=>({...a})),commandIndex:row.commandIndex,commandCount:row.commandCount,startedAt:row.startedAt,finishedAt:row.finishedAt,
    // Teardown evidence for a re-run: `closed` means the row's own socket close
    // was observed; `timedOut` means it was still pending when the row retired.
    // Exposed so an operator/diagnostic can tell "fresh transport" from
    // "reused while the old socket was still open".
    ...(row.limitScope?{partialOutput:true,limitScope:row.limitScope,receivedBytes:row.receivedBytes||0,rejectedBytes:row.rejectedBytes||0}:{}),
    ...(row.teardown?{teardown:{...row.teardown}}:{})};}
  invalidateLiveResult(row){if(this.liveResultCache?.row===row)this.liveResultCache=null;this.searchCache?.rows.delete(row);}
  resultText(row){
    if(row.received===undefined){this.invalidateLiveResult(row);return row.output;}
    const job=this.job;
    if(!job?.active||job.cancelled||DONE.has(row.status)){this.invalidateLiveResult(row);return this.redact(row,clean(row.received));}
    const secrets=secretFingerprint(row.secrets),cached=this.liveResultCache;
    if(cached&&cached.job===job&&cached.row===row&&cached.received===row.received&&cached.sequence===row.sequence&&cached.secrets===secrets)return cached.text;
    const text=this.redact(row,clean(row.received));
    // One active row at a time. Its raw snapshot is also checked because a
    // content replacement need not always advance sequence.
    this.liveResultCache={job,row,received:row.received,sequence:row.sequence,secrets,text};
    return text;
  }
  filtered(input){
    const j=this.assertJob(input.jobId);const query=typeof input.query==='string'?input.query.slice(0,256):'';
    const needle=input.caseSensitive?query:foldText(query);
    const key=JSON.stringify([j.id,needle,!!input.caseSensitive]);if(this.searchCache?.key!==key)this.searchCache={key,rows:new WeakMap()};const cache=this.searchCache.rows;
    return j.rows.filter(row=>{
    if(input.status&&input.status!==row.status||input.group&&input.group!==row.group)return false;
    if(!needle)return true;
    const previous=cache.get(row),sequence=row.sequence,secrets=secretFingerprint(row.secrets),commands=row.outputs.length;
    // Transport admission invalidates this weak entry before appending bytes;
    // it does not retain a separate copy of each row's transcript.
    if(previous&&previous.sequence===sequence&&previous.status===row.status&&previous.message===row.message&&previous.secrets===secrets&&previous.commands===commands)return previous.match;
    const metadata=[row.host,row.group,row.username,row.message,...row.outputs.map(o=>o.command)].join('\n');
    // Same fold rule as detail()/findOffset(), so a listed match is locatable.
    const haystack=input.caseSensitive?`${metadata}\n${this.resultText(row)}`:`${foldText(metadata)}\n${foldText(this.resultText(row))}`;
    const match=haystack.includes(needle);
    cache.set(row,{sequence,status:row.status,message:row.message,secrets,commands,match});return match;
  });}
  rows(input){input=input||{};const rows=this.filtered(input),offset=Math.max(0,Math.min(5000,Number(input.offset)||0)),limit=Math.max(1,Math.min(200,Number(input.limit)||100));return {total:rows.length,rows:rows.slice(offset,offset+limit).map(row=>this.rowMetadata(row))};}
  detail(input){
    input=input||{};const j=this.assertJob(input.jobId),row=j.rows.find(r=>r.id===input.rowId);if(!row)throw new Error('장비 결과를 찾을 수 없습니다.');
    const output=this.resultText(row);let requestedOffset=Math.max(0,Math.min(output.length,Number(input.offset)||0));
    if(input.find&&typeof input.query==='string'&&input.query){const query=input.query.slice(0,256);const found=findOffset(output,query,input.caseSensitive);if(found>=0)requestedOffset=Math.max(0,found-128);}
    // Both sides use the same nominal boundary, so adjacent requested pages
    // still join exactly even when that boundary falls inside a surrogate pair.
    const splitsPair=at=>at>0&&at<output.length&&output.charCodeAt(at-1)>=0xd800&&output.charCodeAt(at-1)<=0xdbff&&output.charCodeAt(at)>=0xdc00&&output.charCodeAt(at)<=0xdfff;
    const offset=requestedOffset-(splitsPair(requestedOffset)?1:0);
    let end=Math.min(output.length,requestedOffset+128*1024);if(splitsPair(end))end--;
    return {...this.rowMetadata(row),output:output.slice(offset,end),offset,requestedOffset,totalChars:output.length,commands:row.outputs.map(o=>({index:o.index,command:o.command,outputOffset:o.outputOffset,timing:o.timing,startedAt:o.startedAt,finishedAt:o.finishedAt}))};
  }
  exportRows(input){input=input||{};const j=this.assertJob(input.jobId);if(j.active)throw new Error('작업이 종료된 뒤 결과를 저장해 주세요.');return this.filtered(input).map(row=>({...this.rowMetadata(row),output:row.output,outputBytes:row.outputBytes??Buffer.byteLength(row.output||''),outputs:row.outputs.map(o=>({...o,timing:o.timing?{...o.timing,prompt:this.redact(row,o.timing.prompt||'')}:o.timing}))}));}
  async close(){this.closed=true;clearTimeout(this.notificationTimer);this.notificationTimer=null;this.searchCache=null;this.liveResultCache=null;this.releaseDraft();this.cancel();if(this.job?.active)await Promise.allSettled(this.job.workers);this.jobTrust.clear();await this.transport.close();}
}
module.exports={BatchService,clean,scrub,scrubStream,secretForms,obscureTail,obscureFragments,privilegedLine,STATUS,DONE,LIMIT_ROW,LIMIT_TOTAL};
