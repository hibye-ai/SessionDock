'use strict';
const net=require('node:net');
const {sanitizeSession}=require('./session-store.cjs');
const {sshCompatibility}=require('./ssh-compatibility.cjs');
const MAX_DEVICES=5000,MAX_GROUPS=100;
function text(value,name,max=256){if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||!value.isWellFormed())throw new Error(`${name} 값이 올바르지 않습니다.`);return value;}
function integer(value,min,max,name){if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name}: ${min}–${max} 범위로 입력해 주세요.`);return value;}
function canonical(host){
  if(net.isIP(host)!==6)return host;
  // Zone identifiers (fe80::1%eth0) are valid link-local input but `new URL`
  // throws ERR_INVALID_URL on them, so canonicalize the address part only.
  const zone=host.indexOf('%'),address=zone<0?host:host.slice(0,zone),suffix=zone<0?'':host.slice(zone);
  return new URL(`http://[${address}]/`).hostname.slice(1,-1)+suffix;
}
// Accept pasted Excel columns, comma-separated lists, IPv4/IPv6 and optional
// per-device ports. Hostnames/ranges are deliberately not silently expanded.
function parseTargets(value,defaultPort){
  text(value,'IP 목록',512*1024);const targets=[],seen=new Set();let duplicates=0;
  for(const token of value.split(/[\s,;]+/).filter(Boolean)){
    let host=token,port=defaultPort;const bracket=/^\[([^\]]+)\](?::(\d+))?$/.exec(token);
    if(bracket){host=bracket[1];if(bracket[2])port=Number(bracket[2]);}
    else if(!net.isIP(host)){const pair=/^([^:]+):(\d+)$/.exec(token);if(pair){host=pair[1];port=Number(pair[2]);}}
    if(!net.isIP(host))throw new Error('IP 목록에 올바르지 않은 주소가 있습니다. IPv4/IPv6 주소만 입력해 주세요.');
    integer(port,1,65535,'장비 포트');host=canonical(host);
    const key=`${host}:${port}`;if(seen.has(key)){duplicates++;continue;}seen.add(key);targets.push({host,port});
    if(targets.length>MAX_DEVICES)throw new Error(`장비는 최대 ${MAX_DEVICES}개까지 처리할 수 있습니다.`);
  }
  if(!targets.length)throw new Error('그룹에 장비 IP를 입력해 주세요.');return {targets,duplicates};
}
function normalizePlan(input,resolveCredential,options={}){
  if(!input||!Array.isArray(input.groups)||!input.groups.length||input.groups.length>MAX_GROUPS)throw new Error('그룹은 1–100개로 지정해 주세요.');
  // V9-M-06: a batch service approves *credentials*, never a plaintext
  // snapshot. With `deferSecrets` the resolver is called once per referenced
  // group (so its public metadata is still validated here), but the resolved
  // private material is handed to the caller's recorder and never copied into
  // the plan. The plan keeps the reference only; `start` re-resolves it.
  const deferSecrets=options.deferSecrets===true,recordCredential=typeof options.recordCredential==='function'?options.recordCredential:null;
  const bindings=[];
  const concurrency=integer(input.concurrency??5,1,32,'동시 접속 수');const groups=[],devices=[];const seen=new Set();let duplicates=0;

  for(let index=0;index<input.groups.length;index++){
    const source=input.groups[index];if(!source||typeof source!=='object')throw new Error('그룹 설정이 올바르지 않습니다.');
    const name=text(source.name,'그룹 이름',100).trim();if(!name)throw new Error('그룹 이름을 입력해 주세요.');
    if(groups.some(g=>g.name===name))throw new Error('그룹 이름이 중복됩니다.');
    const protocol=source.protocol??'ssh';if(!['ssh','telnet'].includes(protocol))throw new Error('SSH 또는 Telnet을 선택해 주세요.');
    const port=integer(source.port??(protocol==='telnet'?23:22),1,65535,'기본 포트');
    const commands=text(source.commands,'명령어',64*1024).split(/\r\n|\n|\r/).map(s=>s.trim()).filter(Boolean);
    // 200 is the contract for what the operator actually types; the vendor
    // paging setup command added below is accounted separately so the final
    // list can never exceed the limit either (200 + 1 = 201 was reachable).
    if(!commands.length||commands.length>200||commands.some(c=>c.length>4096))throw new Error('명령어는 한 줄에 하나씩, 최대 200개 / 한 줄 4096자까지 입력해 주세요.');
    // Preserve operator order and avoid duplicate vendor setup, including IOS
    // abbreviations. A Cisco abbreviation must not suppress Huawei setup.
    const pagingMode=source.pagingMode??'none';
    if(!['none','cisco','huawei'].includes(pagingMode))throw new Error('페이지 출력 해제 설정이 올바르지 않습니다.');
    let setupCommand='';
    if(pagingMode==='cisco')setupCommand='terminal length 0';
    else if(pagingMode==='huawei')setupCommand='screen-length 0 temporary';
    if(setupCommand&&!commands.some(c=>pagingMode==='cisco'?/^ter(?:m(?:i(?:n(?:a(?:l)?)?)?)?)?\s+le(?:n(?:g(?:t(?:h)?)?)?)?\s+0$/i.test(c):c.toLowerCase().replace(/\s+/g,' ')===setupCommand))commands.unshift(setupCommand);
    // The limit applies to what is actually sent, so the inserted paging setup
    // command must be counted too: 200 typed commands plus `terminal length 0`
    // used to produce a 201-command plan.
    if(commands.length>200)throw new Error(`명령어는 페이지 출력 해제 명령을 포함해 최종 200개까지 전송할 수 있습니다. 명령을 ${commands.length-200}개 줄여 주세요.`);
    const parsed=parseTargets(source.targets,port);duplicates+=parsed.duplicates;
    let profile=sanitizeSession({name,protocol,host:parsed.targets[0].host,port,username:source.username??'',authType:source.authType??'password',privateKeyPath:source.privateKeyPath??'',encoding:source.encoding??'utf-8',telnetEnter:'crlf',logEnabled:false,...(source.passwordReprompt?{passwordReprompt:source.passwordReprompt}:{})});
    let passphrase=protocol==='ssh'&&profile.authType==='key'?text(source.passphrase??'','개인키 암호',16384):'';
    const credentialId=text(source.credentialId??'','공통 계정',256);
    // A stored reference keeps precedence over an inline value (unchanged
    // policy). When the caller defers secrets (the batch service does), the
    // resolved private material is handed to its recorder instead of the plan:
    // the approved plan retains the reference only, and `start` re-resolves it
    // after proving the fingerprint is unchanged (V9-M-06).
    let deferred=false;
    if(credentialId){
      if(!resolveCredential)throw new Error('공통 계정을 사용할 수 없습니다.');
      const resolved=resolveCredential({...profile,protocol:'ssh'},credentialId);
      profile={...profile,username:resolved.username,...(protocol==='ssh'?{authType:resolved.authType,privateKeyPath:resolved.privateKeyPath,agentPath:resolved.agentPath}:{})};
      passphrase=protocol==='ssh'&&profile.authType==='key'?resolved.passphrase||'':'';
      if(deferSecrets){
        deferred=true;
        // `profile` is the sanitized batch profile (host/port/name plus the
        // resolved authentication metadata) so the same resolver contract can
        // be used again at start and per row; it carries no secret.
        const binding={groupIndex:index,groupName:name,credentialId,
          profile:{...profile,authType:resolved.authType,privateKeyPath:resolved.privateKeyPath,agentPath:resolved.agentPath},
          passphrase:resolved.authType==='key'?resolved.passphrase||'':''};
        bindings.push(binding);recordCredential?.(binding);
      }
    }
    if(!profile.username&&protocol==='ssh')throw new Error(`${name}: 접속 계정을 입력해 주세요.`);

    // The explicit boolean wins: `false` always disables privilege transition,
    // `true` uses the given command or the vendor default, and only an omitted
    // field keeps the legacy `enableCommand`-implies-oniv behaviour.
    if(source.useEnable!==undefined&&typeof source.useEnable!=='boolean')throw new Error('관리자 모드 전환 설정이 올바르지 않습니다.');
    const legacyEnable=source.useEnable===undefined;
    const enableCommand=legacyEnable?text(source.enableCommand??'','권한 전환 명령',256):source.useEnable?text(source.enableCommand||'enable','권한 전환 명령',256):'';
    const group={index,name,profile,passphrase:deferred?'':passphrase,credentialId,commands,pagingMode,prompt:text(source.prompt??'','완료 프롬프트',200),
      enableCommand,
      timeoutMs:integer(source.timeoutMs??30000,1000,300000,'명령 대기 시간'),quietMs:integer(source.quietMs??1000,100,10000,'응답 안정화 시간'),
      connectTimeoutMs:integer(source.connectTimeoutMs??30000,1000,300000,'접속 제한 시간'),loginTimeoutMs:integer(source.loginTimeoutMs??30000,1000,300000,'로그인·초기 프롬프트 대기'),
      responseTimeoutMs:integer(source.responseTimeoutMs??Math.min(10000,source.timeoutMs??30000),1000,300000,'첫 응답 대기'),commandDelayMs:integer(source.commandDelayMs??100,0,10000,'명령 간 간격'),
      terminalType:profile.terminalType,autoEncoding:source.encoding===undefined,sshCompatibility:source.sshCompatibility===undefined||source.sshCompatibility==='auto'?'auto':sshCompatibility(source.sshCompatibility),enterKey:source.enterKey??'cr',stopOnError:source.stopOnError===true,
      completion:source.completion??(typeof source.prompt==='string'&&source.prompt.trim()?'prompt':'quiet'),pager:source.pager!==false};
    group.profile.terminalType=text(source.terminalType??'vt100','터미널 종류',64);if(!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(group.profile.terminalType))throw new Error('터미널 종류가 올바르지 않습니다.');
    if(!['cr','crlf'].includes(group.enterKey))throw new Error('Enter 키는 CR 또는 CRLF로 선택해 주세요.');group.profile.telnetEnter=group.enterKey;
    // A quiet command tests completion before its idle deadline, so equal
    // values are usable. Prompt mode and login still have fixed deadlines and
    // need time to receive a prompt *before* their quiet interval begins.
    if(group.responseTimeoutMs>group.timeoutMs||group.quietMs>group.timeoutMs||(group.completion!=='quiet'&&group.quietMs===group.timeoutMs)||group.quietMs>=group.loginTimeoutMs)throw new Error('첫 응답 대기는 명령 대기 이하여야 하며 출력 안정화는 초기 프롬프트 대기보다 짧아야 합니다. 프롬프트 완료는 명령 대기보다도 짧아야 합니다.');
    if(/[\r\n]/.test(group.enableCommand))throw new Error('권한 전환 명령에 줄바꿈을 넣을 수 없습니다.');
    if(!['prompt','quiet'].includes(group.completion))throw new Error('명령 완료 조건이 올바르지 않습니다.');
    if(/[\r\n]/.test(group.prompt))throw new Error('완료 프롬프트는 한 줄로 입력해 주세요.');
    for(const target of parsed.targets){const key=`${protocol}:${target.host}:${target.port}`;if(seen.has(key))throw new Error('같은 장비가 여러 그룹에 포함되어 있습니다. 그룹 간 중복을 제거해 주세요.');seen.add(key);devices.push({...target,groupIndex:index});}
    groups.push(group);if(devices.length>MAX_DEVICES)throw new Error(`장비는 최대 ${MAX_DEVICES}개까지 처리할 수 있습니다.`);
  }
  const transmissions=devices.reduce((sum,d)=>sum+groups[d.groupIndex].commands.length,0);if(transmissions>50000)throw new Error('한 작업의 장비별 명령 전송 합계는 50,000회까지입니다. 작업을 나누어 실행해 주세요.');

  return {groups,devices,concurrency,duplicates};
}
function publicPlan(plan){return {concurrency:plan.concurrency,deviceCount:plan.devices.length,duplicates:plan.duplicates,
  commandCount:plan.devices.reduce((sum,d)=>sum+plan.groups[d.groupIndex].commands.length,0),
  groups:plan.groups.map(g=>({name:g.name,protocol:g.profile.protocol,username:g.profile.username,deviceCount:plan.devices.filter(d=>d.groupIndex===g.index).length,targets:plan.devices.filter(d=>d.groupIndex===g.index).map(d=>({host:d.host,port:d.port})),commands:[...g.commands],completion:g.completion,prompt:g.prompt,enableCommand:g.enableCommand,pagingMode:g.pagingMode,sshCompatibility:g.sshCompatibility}))};}
module.exports={normalizePlan,publicPlan,parseTargets,MAX_DEVICES};
