import { applyPasswordVisibility } from './password-visibility.js';
import { foldRanges } from '../lib/batch-search.cjs';
const $=id=>document.getElementById(id);
function node(tag,cls='',text){const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;}
const STATUS={queued:'대기',connecting:'접속 중',login:'로그인 중',running:'명령 실행 중',success:'완료',error:'실패',cancelled:'취소'};
function group(index){return {name:`예시 그룹 ${index}`,protocol:'ssh',port:22,credentialId:'',username:'',passphrase:'',authType:'password',privateKeyPath:'',targets:'',commands:'',prompt:'',useEnable:false,enableCommand:'',timeoutMs:30000,quietMs:1000,connectTimeoutMs:30000,sshCompatibility:'auto',pager:true,pagingMode:'none'};}
const ENABLE_COMMAND='enable';
const FIELDS=['name','protocol','port','credentialId','username','passphrase','authType','privateKeyPath','targets','commands','prompt','useEnable','enableCommand','timeoutMs','quietMs','connectTimeoutMs','pager','pagingMode'];
export function installBatchUI({api,toast,showError}){
  const dialog=node('dialog','modal batch-modal');dialog.id='batch-dialog';
  dialog.innerHTML=`<div class="batch-shell"><div class="modal-header"><h2>장비 일괄 실행</h2><span class="flex-spacer"></span><button class="icon-button" id="batch-close" aria-label="일괄 실행 창 닫기">×</button></div>
  <div class="batch-navigation"><button id="batch-config-tab" class="secondary-button small" aria-pressed="true">작업 설정</button><button id="batch-results-tab" class="secondary-button small" aria-pressed="false">실행 결과</button><span class="flex-spacer"></span><button id="batch-retry" class="secondary-button small" hidden>실행 계획 다시 확인</button><output id="batch-progress" aria-live="polite">그룹별 IP · 계정 · 명령어</output></div>
  <section id="batch-config" class="batch-config"><aside class="batch-groups"><strong>장비 그룹</strong><div id="batch-group-list"></div><div class="batch-group-actions"><button id="batch-add" class="secondary-button small">+ 새 그룹</button><button id="batch-remove" class="secondary-button small">삭제</button></div><label>동시 접속 수<input id="batch-concurrency" type="number" min="1" max="32" value="5"></label></aside>
  <form id="batch-group-form" class="batch-group-form"><div class="batch-template-bar"><label class="batch-template-picker">템플릿<select id="batch-template-select"><option value="">저장된 템플릿 선택…</option></select></label><button type="button" id="batch-template-load" class="secondary-button small" disabled>불러오기</button><button type="button" id="batch-template-update" class="secondary-button small" disabled>저장</button><button type="button" id="batch-template-delete" class="secondary-button small danger-button" disabled>삭제</button><span class="batch-template-divider" aria-hidden="true"></span><input id="batch-template-name" maxlength="100" placeholder="새 템플릿 이름 (예: 장비 템플릿 1)" aria-label="새 템플릿 이름"><button type="button" id="batch-template-save" class="secondary-button small">다른 이름으로 저장</button></div><div class="batch-fields"><label>그룹 이름<input name="name" maxlength="100"></label><label>프로토콜<select name="protocol"><option value="ssh">SSH</option><option value="telnet">Telnet</option></select></label><label>기본 포트<input name="port" type="number" min="1" max="65535"></label>
  <label class="batch-credential">공통 계정<select name="credentialId"><option value="">직접 입력</option></select></label><label>사용자 이름<input name="username" maxlength="256" autocomplete="off" placeholder="접속 계정"></label><label>인증 방식<select name="authType"><option value="password">비밀번호</option><option value="key">개인키 파일</option><option value="agent">SSH 에이전트</option></select></label><label data-batch-key-field>개인키 암호<div class="batch-input-action"><input id="batch-passphrase" name="passphrase" type="password" maxlength="16384" autocomplete="new-password"><button type="button" class="password-toggle-button batch-secret-toggle" data-batch-secret="passphrase" aria-controls="batch-passphrase" aria-label="개인키 암호 보기" aria-pressed="false"></button></div></label><label class="batch-wide" data-batch-key-field>개인키 파일<div class="batch-key"><input name="privateKeyPath" readonly><button type="button" id="batch-key" class="secondary-button small">선택…</button></div></label></div>
  <div class="batch-editors"><label><div class="batch-editor-header"><span>장비 IP 목록</span><button type="button" id="batch-import" class="text-button">TXT / CSV 불러오기…</button></div><textarea name="targets" spellcheck="false" maxlength="524288" placeholder="192.0.2.10&#10;192.0.2.11&#10;192.0.2.12:2222"></textarea></label><label><div class="batch-editor-header"><span>그룹 명령어</span></div><textarea name="commands" spellcheck="false" maxlength="65536" placeholder="show version&#10;show interfaces status"></textarea></label></div>
  <details class="batch-options"><summary>실행 설정</summary><div class="batch-fields"><label>연결 제한 시간 (ms)<input name="connectTimeoutMs" type="number" min="1000" max="300000"></label><label>응답 제한 시간 (ms)<input name="timeoutMs" type="number" min="1000" max="300000"></label><label>출력 완료 대기 (ms)<input name="quietMs" type="number" min="100" max="10000"></label><label class="batch-wide">완료 문구 (선택)<input name="prompt" maxlength="200" placeholder="비워 두면 자동 확인"></label><label class="check-label"><input name="pager" type="checkbox">페이지 넘김 자동 처리</label><label class="batch-wide">페이지 출력 해제<select name="pagingMode"><option value="none">사용 안 함 (입력 없음)</option><option value="cisco">Cisco (terminal length 0)</option><option value="huawei">Huawei (screen-length 0 temporary)</option></select></label><label class="check-label batch-enable-toggle"><input name="useEnable" type="checkbox">관리자 모드 전환 (enable)</label><input name="enableCommand" type="hidden" value=""></div></details>
  </form><div id="batch-plan" class="batch-plan" hidden></div></section>
  <section id="batch-results" class="batch-results" hidden><div class="batch-search"><input id="batch-search" maxlength="256" placeholder="IP · 그룹 · 명령어 · 전체 수신 결과 검색" aria-label="일괄 실행 결과 검색"><label class="check-label"><input id="batch-case" type="checkbox">대소문자</label><select id="batch-status" aria-label="결과 상태"><option value="">모든 상태</option>${Object.entries(STATUS).map(([value,text])=>`<option value="${value}">${text}</option>`).join('')}</select><select id="batch-filter-group" aria-label="결과 그룹"><option value="">모든 그룹</option></select></div>
  <div class="batch-result-panes"><div id="batch-result-table-wrap" class="batch-result-table" tabindex="0" role="listbox" aria-label="장비 결과 목록 (↑/↓로 이동)"><table><thead><tr><th>그룹 / 장비</th><th>상태</th><th>명령</th></tr></thead><tbody id="batch-rows" role="presentation"></tbody></table><p id="batch-no-results" class="field-hint">실행 결과가 없습니다.</p></div><div class="batch-preview"><div class="batch-preview-heading"><strong id="batch-device-title">장비를 선택하면 수신 결과가 표시됩니다.</strong><span class="flex-spacer"></span><button id="batch-copy" class="text-button">표시 부분 복사</button></div><div id="batch-device-meta" class="batch-device-meta"></div><div class="batch-find"><span id="batch-hit-count"></span><button id="batch-hit-prev" class="text-button">↑ 이전</button><button id="batch-hit-next" class="text-button">↓ 다음</button><select id="batch-command-jump" aria-label="명령별 결과 위치"><option value="">명령별 이동</option></select></div><pre id="batch-output" tabindex="0"></pre><div class="batch-output-pages"><button id="batch-output-first" class="text-button" disabled>처음</button><button id="batch-output-prev" class="text-button" disabled>이전</button><span class="batch-output-position" aria-live="polite"><span id="batch-output-page"></span><span id="batch-output-range"></span></span><button id="batch-output-next" class="text-button" disabled>다음</button><button id="batch-output-last" class="text-button" disabled>끝</button></div></div></div>
  <div class="batch-result-pages"><button id="batch-page-prev" class="text-button">이전 장비</button><output id="batch-result-count">0개</output><button id="batch-page-next" class="text-button">다음 장비</button><output id="batch-job-identity" class="batch-job-identity"></output><span class="flex-spacer"></span><label class="check-label"><input id="batch-export-filter" type="checkbox">검색·필터 결과만 저장</label><button id="batch-export-txt" class="secondary-button small">TXT 저장…</button><button id="batch-export-xlsx" class="secondary-button small">Excel 저장…</button></div></section>
  <div class="batch-footer"><button id="batch-stop" class="secondary-button small danger-button" disabled>작업 취소</button><button id="batch-preview-plan" class="secondary-button small">실행 계획 확인</button><output id="batch-error" role="alert"></output><span class="flex-spacer"></span><button id="batch-hide" class="secondary-button small">닫기</button><button id="batch-run" class="primary-button small" disabled>전체 실행</button></div></div>`;
  document.body.append(dialog);const form=$('batch-group-form');let groups=[group(1)],selected=0,token=null,summary=null,offset=0,rowId=null,detailOffset=0,detail=null,hits=[],hit=-1,revision=0,timer=null,poll=null,refreshing=false,refreshQueued=false,rowsKey='',listKey='',lastLocked,detailRequest=0,previewRevision=0,starting=false,summaryRequest=0,eventRevision=0,dialogRevision=0,formRevision=0,importRequest=0,keyRequest=0,optionsJob=undefined,knownGroups=new Set(),lastProtocol='ssh',exporting=false;
  const fail=e=>{$('batch-error').textContent=String(e?.message||e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');};
  const DETAIL_PAGE=128*1024;
  let detailPages=[],scrollLoading=null,programScroll=null,closeCleaned=true;
  function rememberOutputScroll(){const target=$('batch-output');programScroll={top:target.scrollTop,left:target.scrollLeft};}
  const secretToggles=new Map(),secretTitle=t=>t.replace(/\s(?:보기|숨기기)$/,'');
  function concealSecret(field){const entry=secretToggles.get(field);if(entry)applyPasswordVisibility(field,entry.toggle,false,entry.title);}
  function concealSecrets(){for(const field of secretToggles.keys())concealSecret(field);}
  for(const toggle of form.querySelectorAll('[data-batch-secret]')){const field=form.elements.namedItem(toggle.dataset.batchSecret);if(!field)continue;const title=secretTitle(toggle.getAttribute('aria-label')||'');secretToggles.set(field,{toggle,title});applyPasswordVisibility(field,toggle,false,title);toggle.addEventListener('click',()=>{if(field.disabled)return;applyPasswordVisibility(field,toggle,field.type==='password',title);});}
  const action=(id,fn)=>$(id).addEventListener('click',()=>Promise.resolve().then(fn).catch(fail));
  function saveGroup(){const g=groups[selected];if(!g)return;for(const name of FIELDS){const field=form.elements.namedItem(name);if(!field)continue;g[name]=field.type==='checkbox'?field.checked:field.type==='number'?Number(field.value):field.value;}
    // The checkbox is the only privilege switch the operator sees; the command
    // it implies is derived so the two can never disagree. A legacy custom
    // command (from an older template) is kept instead of being downgraded.
    g.enableCommand=g.useEnable?(g.enableCommand||ENABLE_COMMAND):'';form.elements.enableCommand.value=g.enableCommand;}
  function nextGroupName(){const used=new Set(groups.map(g=>g.name.trim()));let index=groups.length+1;while(used.has(`예시 그룹 ${index}`))index++;return `예시 그룹 ${index}`;}
  function list(){const key=JSON.stringify([selected,!!summary?.active,starting,groups.map(g=>g.name)]);if(key===listKey)return;listKey=key;const locked=!!summary?.active||starting;const target=$('batch-group-list');target.replaceChildren();groups.forEach((g,index)=>{const button=node('button',index===selected?'selected':'',g.name||`그룹 ${index+1}`);button.type='button';button.disabled=locked;button.addEventListener('click',()=>{saveGroup();selected=index;renderGroup();});target.append(button);});$('batch-remove').disabled=groups.length<=1||locked;}
  function renderGroup(){const g=groups[selected];if(!g){selected=0;return;}if(g.useEnable===undefined)g.useEnable=!!g.enableCommand;for(const name of FIELDS){const field=form.elements.namedItem(name);if(field.type==='checkbox')field.checked=g[name];else field.value=g[name];}lastProtocol=form.elements.protocol.value;concealSecrets();authentication();list();syncTemplateButtons();}
  // `enable` is a fixed command, so the checkbox alone decides whether a
  // privilege transition runs. Its password is requested only if the device asks.
  function syncEnable(){const field=form.elements.enableCommand,enabled=form.elements.useEnable.checked;if(!enabled)field.value='';else if(!field.value.trim())field.value=ENABLE_COMMAND;return enabled;}
  function authentication(){const locked=!!summary?.active||starting,saved=!!form.elements.credentialId.value,telnet=form.elements.protocol.value==='telnet';for(const name of ['username','authType','passphrase','privateKeyPath'])form.elements[name].disabled=locked||saved||telnet&&['authType','passphrase','privateKeyPath'].includes(name);for(const label of form.querySelectorAll('[data-batch-key-field]'))label.hidden=saved||telnet||form.elements.authType.value!=='key';$('batch-key').disabled=saved||telnet||locked;
    syncEnable();form.elements.useEnable.disabled=locked;
    for(const [field,{toggle}] of secretToggles){const keyField=field.closest('[data-batch-key-field]');const hidden=!!(keyField&&keyField.hidden);toggle.hidden=hidden;toggle.disabled=field.disabled||hidden;if(field.disabled||hidden)concealSecret(field);}}
  // ---- Saved PM checklist templates -------------------------------------
  // A template holds connection shape + the checklist commands, never secrets.
  const TEMPLATE_FIELDS=['commands','pagingMode','protocol','port','credentialId','username','targets','prompt','enableCommand','timeoutMs','connectTimeoutMs','quietMs','pager'];
  const templateSelect=$('batch-template-select');
  const templateBar=form.querySelector('.batch-template-bar');
  let templates=[],templateBusy=false,templateListRequest=0;
  const templateBindings=new WeakMap();
  const templateFingerprint=item=>JSON.stringify(item);
  // CAS token for the snapshot currently shown in the dropdown. Every save and
  // delete sends it back, so an edit made in another window is reported instead
  // of being silently overwritten by this stale view.
  let templateRevision=null;
  function syncTemplateButtons(){const chosen=!!templateSelect.value,locked=!!summary?.active||starting||templateBusy,binding=templateBindings.get(groups[selected]);const canUpdate=!!binding&&binding.id===templateSelect.value&&templates.some(item=>item.id===binding.id&&templateFingerprint(item)===binding.snapshot);for(const [id,off] of [['batch-template-load',!chosen],['batch-template-update',!canUpdate],['batch-template-delete',!chosen],['batch-template-save',false]])$(id).disabled=locked||off;}
  function fillTemplates(selectedId=''){templateSelect.replaceChildren(new Option('저장된 템플릿 선택…',''));for(const item of templates)templateSelect.append(new Option(item.name,item.id));templateSelect.value=templates.some(item=>item.id===selectedId)?selectedId:'';syncTemplateButtons();}
  // The main process returns `{templates, revision}`; a bare array is still
  // accepted so an older/preload-less caller cannot break the dialog.
  // `revision` is kept as the exact token the store issued, including the empty
  // document's `'__empty__'`. It is never coerced to null: sending `undefined`
  // would mean "no compare-and-swap" and let this dialog overwrite a template
  // another window created after it opened (V4 M-01).
  async function loadTemplates(selectedId=templateSelect.value,groupAt=groups[selected]){const request=++templateListRequest,at=dialogRevision,selectionAt=templateSelect.value;let snapshot;try{snapshot=await api.listBatchTemplates();}catch(error){if(request===templateListRequest&&at===dialogRevision)templateRevision=null;throw error;}if(request!==templateListRequest||!dialog.open||at!==dialogRevision)return false;templates=Array.isArray(snapshot)?snapshot:(snapshot?.templates||[]);templateRevision=Array.isArray(snapshot)?null:(typeof snapshot?.revision==='string'?snapshot.revision:null);for(const g of groups){const binding=templateBindings.get(g);if(binding&&!templates.some(item=>item.id===binding.id&&templateFingerprint(item)===binding.snapshot))templateBindings.delete(g);}fillTemplates(templateSelect.value===selectionAt&&groups[selected]===groupAt?selectedId:templateSelect.value);return true;}
  // A save/delete needs a proven snapshot. Without one (an older preload that
  // returned a bare array) the request is refused instead of being sent with no
  // CAS token, because an unconditional write is exactly the lost update the
  // token exists to prevent.
  function requireRevision(){if(typeof templateRevision!=='string'||!templateRevision)throw new Error('템플릿 목록을 불러온 뒤 다시 시도해 주세요.');return templateRevision;}
  // A rejected compare-and-swap is recoverable: reload the current list and tell
  // the operator to review the refreshed entries before saving again.
  async function templateConflict(error,at){const message=String(error?.message||error);if(!/ERR_TEMPLATE_CHANGED|다른 창에서 변경/.test(message))return false;if(dialog.open&&dialogRevision===at){templateRevision=null;await loadTemplates().catch(()=>{});if(dialog.open&&dialogRevision===at)fail(new Error('템플릿이 다른 창에서 변경되었습니다. 최신 목록을 확인하고 필요한 템플릿을 다시 불러와 주세요.'));}return true;}
  function templateFromName(name){const key=String(name||'').trim();return key?templates.find(item=>item.name===key):undefined;}
  function applyTemplate(item){const g=groups[selected];if(!g)return;for(const name of TEMPLATE_FIELDS)g[name]=name==='port'?Number(item.port):item[name];
    // Templates written before the checkbox only carry `enableCommand`.
    g.useEnable=!!item.enableCommand;
    // A stored credential can disappear; never leave the group pointing at an ID
    // the select cannot show, or the next edit would silently keep a dead link.
    if(g.credentialId&&![...form.elements.credentialId.options].some(option=>option.value===g.credentialId))g.credentialId='';
    // A template describes another target/account. Keeping the previously typed
    // passphrase or key path would submit a secret
    // that belongs to the old device, and could silently keep key/agent auth
    // while the form shows the template's account. Drop them and fall back to
    // an explicit, visible authentication choice.
    g.passphrase='';
    // Template switching must drop the previous device's authentication choice
    // even when the template references a shared account: otherwise flipping the
    // credential dropdown back to '직접 입력' resurrects the old key/agent state.
    g.authType='password';g.privateKeyPath='';g.agentPath='';
    templateBindings.set(g,{id:item.id,name:item.name,snapshot:templateFingerprint(item)});renderGroup();invalidate();}
  function invalidate(){previewRevision++;formRevision++;token=null;$('batch-run').disabled=true;$('batch-plan').hidden=true;api.clearBatchPreview().catch(fail);}
  function fileResultCurrent(at,groupAt,editAt,request,kind){return dialog.open&&dialogRevision===at&&!starting&&!summary?.active&&groups[selected]===groupAt&&formRevision===editAt&&(kind==='import'?importRequest:keyRequest)===request;}
  const resultsVisible=()=>dialog.open&&!$('batch-results').hidden;
  function tab(result){$('batch-config').hidden=result;$('batch-results').hidden=!result;$('batch-config-tab').setAttribute('aria-pressed',String(!result));$('batch-results-tab').setAttribute('aria-pressed',String(result));if(result)concealSecrets();update();if(result)refresh().catch(fail);}
  function update(){const running=!!summary?.active,locked=running||starting;$('batch-stop').disabled=!locked;$('batch-preview-plan').disabled=locked;$('batch-import').disabled=locked;$('batch-run').disabled=locked||!token;if(lastLocked!==locked){lastLocked=locked;$('batch-add').disabled=locked;for(const field of form.elements)field.disabled=locked;authentication();$('batch-concurrency').disabled=locked;}list();for(const format of ['txt','xlsx'])$(`batch-export-${format}`).disabled=!summary||locked||exporting;syncTemplateButtons();
    if(summary){const c=summary.counts;const done=(c.success||0)+(c.error||0)+(c.cancelled||0);$('batch-progress').textContent=`${starting&&!running?'시작 중':running?'진행':'종료'} ${done}/${summary.total} · 완료 ${c.success||0} · 실패 ${c.error||0} · 취소 ${c.cancelled||0}`;}
    // Which job is on screen, so a new run is visibly a new run: the table looks
    // the same before and after a re-run when the filters happen to hide the new
    // rows, and the old failure summary used to be indistinguishable from a run
    // that never started.
    $('batch-job-identity').textContent=jobIdentity();
    // A finished job with failures offers the correction path explicitly. The
    // secrets are cleared when a job starts, so a re-run needs them re-entered on
    // the settings tab before a new plan can be reviewed.
    const failed=!!summary&&!running&&!starting&&((summary.counts?.error||0)+(summary.counts?.cancelled||0))>0;
    $('batch-retry').hidden=!failed;$('batch-retry').disabled=running||starting;
    if(running&&resultsVisible()){if(!poll)poll=setInterval(()=>refresh().catch(fail),800);}else{clearInterval(poll);poll=null;}}
  // The job identity line: local start time + the leading part of the job id, so
  // two runs of the same group are distinguishable without exposing anything
  // about the targets or credentials.
  function jobIdentity(){if(!summary)return '';const time=summary.startedAt?new Date(summary.startedAt):null;const stamp=time&&!Number.isNaN(time.getTime())?time.toLocaleTimeString('ko-KR',{hour12:false}):'';const id=String(summary.id||'').slice(0,8);return `${summary.active?'실행 중':'마지막 실행'} ${stamp}${id?' · '+id:''}`;}
  function filters(){return {jobId:summary?.id,query:$('batch-search').value,caseSensitive:$('batch-case').checked,status:$('batch-status').value,group:$('batch-filter-group').value};}
  // True when the current filters would hide rows. The empty table is then a
  // filter result, not evidence that the run produced nothing.
  function filtered(){return !!($('batch-search').value.trim()||$('batch-status').value||$('batch-filter-group').value);}
  // Group names are trimmed by the backend, so option values must be trimmed too.
  // Results can also outlive the local drafts (dialog reopened after a reload),
  // so sync missing groups from the rows we already fetched.
  // `summary.groups` is a plain string array in the DTO; older callers/tests may
  // still pass `{name}` objects, so accept both shapes here instead of silently
  // producing an empty option (which dropped every group past page one).
  const groupName=g=>typeof g==='string'?g:(g&&typeof g.name==='string'?g.name:'');
  function groupOptions(names,jobId){const select=$('batch-filter-group');if(jobId!==optionsJob){optionsJob=jobId;knownGroups=new Set();select.replaceChildren(new Option('모든 그룹',''));select.dataset.optionsKey='';}for(const name of names){const label=String(name??'').trim();if(label)knownGroups.add(label);}const ordered=[...knownGroups];if(!ordered.length)return;const key=JSON.stringify([ordered,select.value]);if(select.dataset.optionsKey===key)return;const value=select.value;select.replaceChildren(new Option('모든 그룹',''));for(const label of ordered)select.append(new Option(label,label));select.value=ordered.includes(value)?value:'';select.dataset.optionsKey=JSON.stringify([ordered,select.value]);}
  async function refresh(){if(!summary||!resultsVisible())return;if(refreshing){refreshQueued=true;return;}refreshing=true;refreshQueued=false;const version=revision,jobId=summary.id;try{const result=await api.batchRows({...filters(),offset,limit:100});if(version!==revision||jobId!==summary?.id||!resultsVisible())return;
    const lastPage=Math.max(0,Math.floor((result.total-1)/100)*100);if(offset>lastPage){offset=lastPage;rowId=null;detail=null;detailOffset=0;revision++;return;}
    groupOptions([...(summary?.groups||[]).map(groupName),...result.rows.map(row=>row.group)],jobId);
    if(!result.rows.some(row=>row.id===rowId)){rowId=result.rows[0]?.id??null;detail=null;detailOffset=0;detailRequest++;paint();}
    const key=JSON.stringify([rowId,result.rows.map(row=>[row.id,row.host,row.port,row.group,row.protocol,row.status,row.statusText,row.commandIndex,row.commandCount])]);const target=$('batch-rows');if(key!==rowsKey){rowsKey=key;target.replaceChildren();for(const row of result.rows){const selectedRow=row.id===rowId;const tr=node('tr',selectedRow?'selected':'');tr.dataset.rowId=row.id;tr.batchRowId=row.id;tr.id=rowElementId(row.id);
      // The wrapper owns the accessible selection state (`role=listbox` +
      // `aria-activedescendant`), so every row must expose `role=option` and its
      // own selected state; a visual class alone told assistive technology
      // nothing about which device was active.
      tr.setAttribute('role','option');tr.setAttribute('aria-selected',selectedRow?'true':'false');const name=node('td');const button=node('button','batch-device',row.host+':'+row.port);button.type='button';button.tabIndex=-1;name.append(button,node('small','',row.group+(row.protocol?' · '+String(row.protocol).toUpperCase():'')));tr.append(name,node('td',`batch-state-${row.status}`,row.statusText),node('td','',`${row.commandIndex}/${row.commandCount}`));target.append(tr);}}
    syncActiveDescendant();
    $('batch-no-results').hidden=!!result.total;$('batch-no-results').textContent=summary.active?'검색 조건에 맞는 장비가 없습니다.':filtered()?'현재 검색·상태·그룹 필터에 맞는 장비가 없습니다. 필터를 초기화하면 이번 작업의 결과를 확인할 수 있습니다.':'검색 조건에 맞는 결과가 없습니다.';$('batch-result-count').textContent=`${result.total?offset+1:0}–${Math.min(offset+100,result.total)} / ${result.total}개`;$('batch-page-prev').disabled=!offset;$('batch-page-next').disabled=offset+100>=result.total;
    if(rowId!==null)await loadDetail();else{detail=null;paint();$('batch-device-title').textContent='검색 조건에 맞는 장비가 없습니다.';$('batch-device-meta').textContent='';$('batch-output-range').textContent='0자';$('batch-command-jump').replaceChildren(new Option('명령별 이동',''));}
  }finally{refreshing=false;if(resultsVisible()&&(refreshQueued||version!==revision))queueMicrotask(()=>refresh().catch(fail));}}
  function resetOutputPages(){$('batch-output-page').textContent='';$('batch-output-range').textContent='';for(const id of ['first','prev','next','last'])$(`batch-output-${id}`).disabled=true;}
  function paint(term=$('batch-search').value){const target=$('batch-output');target.replaceChildren();rememberOutputScroll();hits=[];hit=-1;$('batch-copy').disabled=!detail;if(!detail){detailPages=[];resetOutputPages();$('batch-command-jump').replaceChildren(new Option('명령별 이동',''));$('batch-hit-count').textContent='';$('batch-hit-prev').disabled=true;$('batch-hit-next').disabled=true;return;}const text=String(detail.output??''),query=String(term??'');
    // Highlight with the same fold mapping the backend lists/positions matches
    // with, so a query that matches a row is also highlighted here even when
    // locale lower-casing changes length (İ -> i̇).
    const ranges=foldRanges(text,query,{caseSensitive:$('batch-case').checked,limit:2000});let cursor=0;
    for(const [start,end] of ranges){if(start<cursor)continue;target.append(document.createTextNode(text.slice(cursor,start)));hits.push(node('mark','',text.slice(start,end)));target.append(hits.at(-1));cursor=Math.max(cursor,end);}
    target.append(document.createTextNode(text.slice(cursor)));$('batch-hit-count').textContent=query?`${hits.length}${ranges.length===2000?'+':''}건 · 현재 부분`:'';$('batch-hit-prev').disabled=!hits.length;$('batch-hit-next').disabled=!hits.length;
  }
  function outputPosition(target,offset){const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);let n,left=offset;while((n=walker.nextNode())){if(left<=n.data.length){const range=document.createRange();range.setStart(n,left);range.collapse(true);const rect=range.getBoundingClientRect();return {top:rect.top,left:rect.left};}left-=n.data.length;}return null;}
  async function loadDetail(allowRewind=true,mode='refresh'){if(!summary||rowId===null||!resultsVisible())return;const id=rowId,version=revision,jobId=summary.id,request=++detailRequest;
    // Paging can overshoot a shorter result (live rows shrink as output is
    // scrubbed or the total changes); rewind to the last page instead of
    // rendering an inverted or empty byte range.
    const ceiling=detail&&detail.id===id?Number(detail.totalChars)||0:0;
    if(ceiling>0&&detailOffset>=ceiling)detailOffset=Math.max(0,(Math.ceil(ceiling/DETAIL_PAGE)-1)*DETAIL_PAGE);
    const current=()=>id===rowId&&version===revision&&jobId===summary?.id&&request===detailRequest&&resultsVisible();
    const oldPages=detail&&detail.id===id?detailPages:[],query=$('batch-search').value,caseSensitive=$('batch-case').checked;
    const get=offset=>api.batchDetail({jobId,rowId:id,offset,find:false,query,caseSensitive});let pages,result;
    if(mode==='refresh'&&oldPages.length&&oldPages.some(p=>p.requestedOffset===detailOffset)){
      pages=await Promise.all(oldPages.map(p=>get(p.requestedOffset)));if(!current())return;result=pages.find(p=>p.requestedOffset===detailOffset)||pages[0];
    }else if((mode==='prev'||mode==='next')&&oldPages.length){
      const anchor=mode==='prev'?oldPages[0].requestedOffset-DETAIL_PAGE:oldPages.at(-1).requestedOffset+DETAIL_PAGE;if(anchor<0||anchor>=ceiling)return;
      const offsets=(mode==='prev'?[anchor,...oldPages.map(p=>p.requestedOffset)]:[...oldPages.map(p=>p.requestedOffset),anchor]).slice(mode==='prev'?0:-3,mode==='prev'?3:undefined);
      pages=await Promise.all(offsets.map(get));if(!current())return;result=mode==='prev'?pages[0]:pages.at(-1);
    }else{result=await api.batchDetail({jobId,rowId:id,offset:detailOffset,find:!detail,query,caseSensitive});if(!current())return;
      // Find returns a context offset, not a page boundary. Align around the
      // actual match so both directions can request adjacent nominal pages.
      if(!detail&&query){const match=foldRanges(String(result.output??''),query,{caseSensitive,limit:1})[0];if(match){const aligned=Math.floor((result.offset+match[0])/DETAIL_PAGE)*DETAIL_PAGE;if(aligned!==result.requestedOffset){result=await get(aligned);if(!current())return;}}}
      pages=[result];}
    const reportedTotal=Math.max(0,Number(result.totalChars)||0),requestedOffset=result.requestedOffset??result.offset;
    if(allowRewind&&reportedTotal>0&&requestedOffset>=reportedTotal){detail=result;detailPages=[];detailOffset=Math.max(0,(Math.ceil(reportedTotal/DETAIL_PAGE)-1)*DETAIL_PAGE);return loadDetail(false,'reset');}
    if(!reportedTotal){result={...result,offset:0,requestedOffset:0,output:''};pages=[result];}
    else if(mode==='refresh'){pages=pages.filter(p=>p.requestedOffset<reportedTotal);if(!pages.length){detail=result;detailPages=[];detailOffset=Math.max(0,(Math.ceil(reportedTotal/DETAIL_PAGE)-1)*DETAIL_PAGE);return loadDetail(false,'reset');}}
    // A live result can change while the individual requests are in flight.
    // Do not combine slices unless their returned boundaries and totals agree.
    if(pages.some((p,i)=>p.totalChars!==result.totalChars||(i&&pages[i-1].offset+String(pages[i-1].output??'').length!==p.offset))){detailPages=[];detailOffset=Math.max(0,Math.floor((Number(requestedOffset)||0)/DETAIL_PAGE)*DETAIL_PAGE);return loadDetail(true,'reset');}
    const target=$('batch-output'),oldLeft=target.scrollLeft,shared=oldPages.find(p=>pages.some(q=>q.requestedOffset===p.requestedOffset));
    const oldIndex=shared?oldPages.indexOf(shared):-1,newIndex=shared?pages.findIndex(p=>p.requestedOffset===shared.requestedOffset):-1;
    const lengthBefore=(list,index)=>index<0?0:list.slice(0,index).reduce((n,p)=>n+String(p.output??'').length,0);
    const before=shared&&mode!=='reset'?outputPosition(target,lengthBefore(oldPages,oldIndex)):null;
    const previous=detail,combined=pages.map(p=>String(p.output??'')).join('');detailPages=pages;detail={...result,offset:pages[0].offset,output:combined};
    detailOffset=reportedTotal?requestedOffset:0;$('batch-device-title').textContent=`${result.group} · ${result.host}:${result.port} · ${result.statusText}${result.message?' · '+result.message:''}`;
    if(!previous||previous.id!==detail.id||previous.output!==combined||previous.offset!==detail.offset){paint();const after=before===null?null:outputPosition(target,lengthBefore(pages,newIndex));if(after!==null){target.scrollTop+=after.top-before.top;target.scrollLeft+=after.left-before.left;}else{if(mode==='reset'||!previous||previous.id!==detail.id)target.scrollTop=0;target.scrollLeft=oldLeft;}rememberOutputScroll();}
    const total=reportedTotal,size=combined.length,from=total?Math.min(detail.offset,total-1)+1:0,to=Math.min(detail.offset+size,total),count=Math.ceil(total/DETAIL_PAGE),first=total?Math.floor(pages[0].requestedOffset/DETAIL_PAGE)+1:0,last=total?Math.floor(pages.at(-1).requestedOffset/DETAIL_PAGE)+1:0;$('batch-output-page').textContent=count?`${first===last?first:`${first}–${last}`} / ${count}쪽`:'0 / 0쪽';$('batch-output-range').textContent=`${from}–${to} / ${total}자`;for(const id of ['first','prev'])$(`batch-output-${id}`).disabled=first<=1;for(const id of ['next','last'])$(`batch-output-${id}`).disabled=last>=count;
    const t=result.transport,a=t?.negotiated,times=result.timings||{},parts=[];if(t){if(t.compatibilityFallback)parts.push('구형 호환 자동 적용');parts.push(t.terminalType,t.encoding==='auto'?null:t.encoding,t.enterKey.toUpperCase());if(result.protocol==='ssh'){parts.push(`인증 ${t.authType}${t.authenticationKey?' ('+t.authenticationKey+')':''}`);if(a)parts.push(`서버 키 ${a.srvHostKey}`,a.kex,a.cs?.cipher);}}if(times.connectMs!==undefined)parts.push(`접속 ${times.connectMs}ms`);if(times.loginMs!==undefined)parts.push(`초기 프롬프트 ${times.loginMs}ms`);if(summary?.active)parts.push(result.phase||'');$('batch-device-meta').textContent=parts.filter(Boolean).join(' · ');
    const jump=$('batch-command-jump'),value=jump.value,commands=Array.isArray(result.commands)?result.commands:[];jump.replaceChildren(new Option('명령별 이동',''));for(const item of commands)jump.append(new Option(`${item.index}. ${item.command}`,String(item.index)));jump.value=commands.some(item=>String(item.index)===value)?value:'';return true;
  }
  // The whole row is the hit target; the host button stays for semantics only.
  // Row ids are derived, not stored: a DOM id must be stable across refreshes so
  // `aria-activedescendant` keeps pointing at the selected device.
  const rowElementId=id=>`batch-row-${String(id).replace(/[^\w-]/g,'_')}`;
  // Keep the listbox's active descendant (and every row's aria-selected) in sync
  // with the visual selection, so a screen reader announces the same device the
  // keyboard moved to.
  function syncActiveDescendant(){const wrap=$('batch-result-table-wrap');const rows=[...$('batch-rows').rows];let active=null;for(const tr of rows){const selected=tr.dataset.rowId===String(rowId);tr.classList.toggle('selected',selected);tr.setAttribute('aria-selected',selected?'true':'false');if(selected)active=tr;}if(active)wrap.setAttribute('aria-activedescendant',active.id);else wrap.removeAttribute('aria-activedescendant');}
  function selectRow(id,focus){if(id===undefined||id===null||!resultsVisible())return;const tr=[...$('batch-rows').rows].find(r=>r.dataset.rowId===String(id));if(tr){for(const r of $('batch-rows').querySelectorAll('tr.selected'))r.classList.remove('selected');tr.classList.add('selected');syncActiveDescendant();tr.scrollIntoView({block:'nearest'});if(focus)$('batch-result-table-wrap').focus({preventScroll:true});}if(id===rowId&&detail)return;revision++;rowId=id;detail=null;detailOffset=0;paint();refresh().catch(fail);}
  const rowIdOf=tr=>'batchRowId' in tr?tr.batchRowId:tr.dataset.rowId;
  $('batch-rows').addEventListener('click',e=>{const tr=e.target.closest?.('tr[data-row-id]');if(!tr||!$('batch-rows').contains(tr))return;selectRow(rowIdOf(tr),true);});
  function stepRow(step){const rows=[...$('batch-rows').rows];if(!rows.length)return;let index=rows.findIndex(r=>r.dataset.rowId===String(rowId));index=index<0?(step>0?0:rows.length-1):Math.max(0,Math.min(rows.length-1,index+step));
    // Move DOM focus into the listbox when it was not there yet, so the new
    // `aria-activedescendant` is actually announced as the selection changes.
    const active=document.activeElement,listLike=!active||active===dialog||active===document.body||active.id==='batch-result-table-wrap'||!!active.closest?.('#batch-rows');
    selectRow(rowIdOf(rows[index]),listLike);}
  dialog.addEventListener('keydown',e=>{if(e.key!=='ArrowUp'&&e.key!=='ArrowDown')return;if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||e.defaultPrevented||!resultsVisible())return;const t=e.target;
    // Leave caret/option movement to text fields, selects and the output pane.
    if(t&&t!==dialog&&(t.closest?.('input,textarea,select,[contenteditable=""],[contenteditable=true],#batch-output')))return;    e.preventDefault();stepRow(e.key==='ArrowUp'?-1:1);});
  function hitMove(step){if(!hits.length)return;hit=(hit+step+hits.length)%hits.length;for(const n of hits)n.classList.remove('current');hits[hit].classList.add('current');hits[hit].scrollIntoView({block:'center'});rememberOutputScroll();$('batch-hit-count').textContent=`${hit+1}/${hits.length}건 · 현재 부분`;}
  async function credentials(at){const rows=await api.listCredentials();if(!dialog.open||dialogRevision!==at)return;const select=form.elements.credentialId;const authMap={password:'비밀번호',key:'개인키 파일',agent:'SSH 에이전트'};select.replaceChildren(new Option('직접 입력',''));for(const item of rows){const authLabel=authMap[item.authType]||item.authType||'비밀번호';select.append(new Option(`${item.name} · ${item.username||'계정명 없음'} (${authLabel})`,item.id));}renderGroup();}
  form.addEventListener('submit',e=>e.preventDefault());form.addEventListener('input',e=>{if(templateBar.contains(e.target))return;saveGroup();invalidate();if(document.activeElement===form.elements.name)list();});form.addEventListener('change',e=>{if(templateBar.contains(e.target))return;if(e.target===form.elements.useEnable){saveGroup();authentication();invalidate();return;}if(e.target===form.elements.protocol){const previous=lastProtocol==='telnet'?23:22,next=e.target.value==='telnet'?23:22;const port=form.elements.port.value.trim();if(!port||Number(port)===previous)form.elements.port.value=String(next);lastProtocol=e.target.value;saveGroup();}authentication();invalidate();});$('batch-concurrency').addEventListener('input',invalidate);
  action('batch-add',()=>{saveGroup();if(groups.length>=100)throw new Error('그룹은 최대 100개까지 추가할 수 있습니다.');groups.push({...group(groups.length+1),name:nextGroupName()});selected=groups.length-1;renderGroup();invalidate();});action('batch-remove',()=>{if(groups.length<=1)return;saveGroup();groups.splice(selected,1);selected=Math.max(0,Math.min(selected,groups.length-1));renderGroup();invalidate();});
  action('batch-key',async()=>{if(starting)return;const at=dialogRevision,edit=formRevision,request=++keyRequest,groupAt=groups[selected];try{const file=await api.chooseKey();if(file&&fileResultCurrent(at,groupAt,edit,request,'key')){form.elements.privateKeyPath.value=file;saveGroup();invalidate();}}catch(e){if(fileResultCurrent(at,groupAt,edit,request,'key'))fail(e);}});action('batch-import',async()=>{if(starting)return;const at=dialogRevision,edit=formRevision,request=++importRequest,groupAt=groups[selected];try{const text=await api.importBatchTargets();if(text!==null&&fileResultCurrent(at,groupAt,edit,request,'import')){form.elements.targets.value=text;saveGroup();invalidate();}}catch(e){if(fileResultCurrent(at,groupAt,edit,request,'import'))fail(e);}});
  action('batch-preview-plan',async()=>{if(starting)return;saveGroup();const preview=++previewRevision;$('batch-error').textContent='';
    // A preview that fails starts nothing: no job, no new rows, and the previous
    // result stays on screen. Say that explicitly instead of leaving the operator
    // to wonder whether the old failure came from this click.
    let plan;
    try{plan=await api.previewBatch({groups:groups.map(g=>({...g,loginTimeoutMs:g.connectTimeoutMs,responseTimeoutMs:g.timeoutMs})),concurrency:Number($('batch-concurrency').value)});}
    catch(error){if(preview===previewRevision&&dialog.open&&!starting){token=null;$('batch-run').disabled=true;const message=String(error?.message||error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');fail(new Error(`실행 계획 확인에 실패해 새 작업을 시작하지 않았습니다. ${message}`));}return;}
    if(preview!==previewRevision||!dialog.open||starting)return;token=plan.token;const container=$('batch-plan');container.replaceChildren(node('strong','',`${plan.deviceCount}개 장비 · ${plan.commandCount}회 명령 전송 · 동시 ${plan.concurrency}개`));for(const g of plan.groups){const section=node('div','batch-plan-group');section.append(node('strong','',`${g.name} · ${g.protocol.toUpperCase()} · ${g.username||'로그인 없음'} · ${g.deviceCount}개`),node('pre','',g.commands.join('\n')));if(g.protocol==='ssh')section.append(node('p','field-hint',g.sshCompatibility==='auto'?'구형 알고리즘 포함 협상 → 불일치 시 추가 호환 재시도 1회':g.sshCompatibility==='legacy'?'구형 SSH 호환 적용':'표준 SSH'));if(g.enableCommand)section.append(node('p','field-hint',`관리자 전환: ${g.enableCommand}`));if(g.pagingMode&&g.pagingMode!=='none')section.append(node('p','field-hint',`페이지 해제: ${g.pagingMode==='cisco'?'terminal length 0':'screen-length 0 temporary'}`));const targets=node('details');targets.append(node('summary','',`대상 IP 확인 · ${g.targets.length}개`),node('pre','',g.targets.map(t=>`${t.host.includes(':')?'['+t.host+']':t.host}:${t.port}`).join('\n')));section.append(targets);container.append(section);}container.append(node('p','field-hint',`그룹 내 중복 ${plan.duplicates}개 제외`));container.hidden=false;$('batch-run').disabled=false;container.scrollIntoView({block:'nearest'});});
  action('batch-run',async()=>{const approved=token;if(!approved||starting)return;starting=true;token=null;previewRevision++;importRequest++;keyRequest++;revision++;detailRequest++;update();const eventAt=eventRevision,at=dialogRevision;try{const result=await api.startBatch(approved);if(!dialog.open||dialogRevision!==at)return;if(eventAt===eventRevision)summary=result;rowsKey='';rowId=null;detail=null;detailOffset=0;offset=0;paint();
    // A new job is a new result set. A status/query filter left over from the
    // previous run could hide every row of this one, which looks exactly like "the
    // re-run did not happen" (the failure the diagnosis could not distinguish from
    // a stale table). Group filter is rebuilt below for the same reason.
    $('batch-search').value='';$('batch-case').checked=false;$('batch-status').value='';
    for(const g of groups)g.passphrase='';form.elements.passphrase.value='';concealSecrets();optionsJob=undefined;knownGroups=new Set();const groupFilter=$('batch-filter-group');groupFilter.replaceChildren(new Option('모든 그룹',''));groupFilter.dataset.optionsKey='';groupOptions(groups.map(g=>g.name),summary?.id);tab(true);}catch(e){if(dialog.open&&dialogRevision===at&&eventAt===eventRevision)fail(e);}finally{if(dialog.open&&dialogRevision===at){starting=false;update();}}});action('batch-stop',()=>api.cancelBatch());
  action('batch-retry',()=>{if(summary?.active||starting)return;tab(false);saveGroup();const failed=(summary?.counts?.error||0)+(summary?.counts?.cancelled||0);$('batch-error').textContent=`이전 작업에서 ${failed}개 장비가 실패했습니다. 실행 계획을 확인하고 새로 실행해 주세요.`;$('batch-preview-plan').focus();});
  // One in-flight template write at a time; the buttons stay disabled while the
  // round-trip is pending so a double click cannot create or delete twice.
  const templateAction=fn=>async()=>{if(templateBusy||starting||summary?.active)return;templateBusy=true;syncTemplateButtons();try{await fn();}finally{templateBusy=false;syncTemplateButtons();}};
  templateSelect.addEventListener('change',syncTemplateButtons);
  $('batch-template-load').addEventListener('click',()=>templateAction(async()=>{const item=templates.find(entry=>entry.id===templateSelect.value);if(!item)throw new Error('불러올 템플릿을 선택해 주세요.');
    applyTemplate(item);toast(`템플릿 불러옴: ${item.name}`);})().catch(fail));
  async function saveTemplate(update){saveGroup();const current=groups[selected],at=dialogRevision,selectionAt=templateSelect.value;if(!current)return;
    const binding=templateBindings.get(current),typed=$('batch-template-name').value.trim();
    if(update&&(!binding||binding.id!==selectionAt||!templates.some(item=>item.id===binding.id&&templateFingerprint(item)===binding.snapshot)))throw new Error('템플릿을 다시 불러온 뒤 저장해 주세요.');
    const name=update?binding.name:(typed||current.name.trim());if(!name)throw new Error('템플릿 이름을 입력해 주세요.');
    if(!update&&!typed&&templateFromName(name))throw new Error('같은 이름의 템플릿이 있습니다. 저장할 이름을 직접 입력해 주세요.');
    const existing=update?binding:(typed?templateFromName(typed):undefined),revision=requireRevision();
    const payload={id:existing?.id||'',name,revision};for(const field of TEMPLATE_FIELDS)payload[field]=current[field];
    ++templateListRequest;let saved;try{saved=await api.saveBatchTemplate(payload);}catch(error){if(await templateConflict(error,at))return;if(dialog.open&&dialogRevision===at)throw error;return;}
    if(!dialog.open||dialogRevision!==at)return;
    if(groups.includes(current))templateBindings.set(current,{id:saved.id,name:saved.name,snapshot:templateFingerprint(saved)});
    const sameGroup=groups[selected]===current,unchangedSelection=templateSelect.value===selectionAt;
    if(!update&&sameGroup&&$('batch-template-name').value.trim()===typed)$('batch-template-name').value='';
    try{await loadTemplates(sameGroup&&unchangedSelection?saved.id:templateSelect.value,current);}catch(error){if(dialog.open&&dialogRevision===at)throw error;return;}
    if(dialog.open&&dialogRevision===at)toast(`템플릿 저장됨: ${saved.name}`);
  }
  $('batch-template-update').addEventListener('click',()=>templateAction(()=>saveTemplate(true))().catch(fail));
  $('batch-template-save').addEventListener('click',()=>templateAction(()=>saveTemplate(false))().catch(fail));
  $('batch-template-delete').addEventListener('click',()=>templateAction(async()=>{const id=templateSelect.value,item=templates.find(entry=>entry.id===id),at=dialogRevision;if(!item)throw new Error('삭제할 템플릿을 선택해 주세요.');
    const revision=requireRevision();
    ++templateListRequest;try{await api.deleteBatchTemplate(id,revision);}catch(error){if(await templateConflict(error,at))return;if(dialog.open&&dialogRevision===at)throw error;return;}
    if(!dialog.open||dialogRevision!==at)return;
    for(const g of groups)if(templateBindings.get(g)?.id===id)templateBindings.delete(g);
    try{await loadTemplates(templateSelect.value===id?'':templateSelect.value);}catch(error){if(dialog.open&&dialogRevision===at)throw error;return;}if(dialog.open&&dialogRevision===at)toast(`템플릿 삭제됨: ${item.name}`);})().catch(fail));
  action('batch-config-tab',()=>tab(false));action('batch-results-tab',()=>tab(true));function cleanupClosed(){if(closeCleaned)return;closeCleaned=true;dialogRevision++;summaryRequest++;importRequest++;keyRequest++;revision++;detailRequest++;clearTimeout(timer);rowsKey='';detail=null;$('batch-rows').replaceChildren();syncActiveDescendant();$('batch-command-jump').replaceChildren(new Option('명령별 이동',''));paint();saveGroup();for(const g of groups)g.passphrase='';form.elements.passphrase.value='';concealSecrets();invalidate();clearInterval(poll);poll=null;starting=false;
    // Leave the panel on the settings tab so a reopen never lands on an empty
    // results view and no result polling restarts until it is shown again.
    tab(false);$('batch-device-meta').textContent='';$('batch-output-range').textContent='';
    // Drop group options from the finished job so a later job never offers them.
    optionsJob=undefined;knownGroups=new Set();const filter=$('batch-filter-group');filter.replaceChildren(new Option('모든 그룹',''));filter.value='';filter.dataset.optionsKey='';}
  for(const id of ['batch-close','batch-hide'])action(id,()=>{cleanupClosed();dialog.close();});dialog.addEventListener('close',()=>{if(!dialog.open)cleanupClosed();});
  for(const id of ['batch-search','batch-case','batch-status','batch-filter-group'])$(id).addEventListener(id==='batch-search'?'input':'change',()=>{revision++;offset=0;rowId=null;detail=null;detailOffset=0;paint();clearTimeout(timer);timer=setTimeout(()=>refresh().catch(fail),120);});
  action('batch-page-prev',()=>{revision++;offset=Math.max(0,offset-100);rowId=null;detail=null;detailOffset=0;paint();return refresh();});action('batch-page-next',()=>{revision++;offset+=100;rowId=null;detail=null;detailOffset=0;paint();return refresh();});
  function moveOutput(part){if(!detail||!resultsVisible()||$(`batch-output-${part}`).disabled)return;const total=Math.max(0,Number(detail.totalChars)||0),first=detailPages[0]?.requestedOffset??detailOffset,last=detailPages.at(-1)?.requestedOffset??detailOffset;let next;if(part==='first')next=0;else if(part==='last')next=Math.max(0,Math.floor((total-1)/DETAIL_PAGE)*DETAIL_PAGE);else if(part==='prev')next=Math.max(0,first-DETAIL_PAGE);else next=last+DETAIL_PAGE;revision++;detailOffset=next;return loadDetail(true,'reset');}
  for(const part of ['first','prev','next','last'])action(`batch-output-${part}`,()=>moveOutput(part));
  $('batch-output').addEventListener('scroll',()=>{const target=$('batch-output');if(programScroll&&target.scrollTop===programScroll.top&&target.scrollLeft===programScroll.left)return;programScroll=null;if(!detail||!detailPages.length||!resultsVisible())return;const key=`${summary?.id}:${rowId}:${revision}`;if(scrollLoading?.key===key)return;const vertical=target.scrollHeight>target.clientHeight,horizontal=!vertical&&target.scrollWidth>target.clientWidth;if(!vertical&&!horizontal)return;const position=vertical?target.scrollTop:target.scrollLeft,viewport=vertical?target.clientHeight:target.clientWidth,extent=vertical?target.scrollHeight:target.scrollWidth,threshold=Math.max(60,viewport/2),first=detailPages[0].requestedOffset,last=detailPages.at(-1).requestedOffset,total=Number(detail.totalChars)||0;let mode='';if(position<=threshold&&first>0)mode='prev';else if(extent-viewport-position<=threshold&&last+DETAIL_PAGE<total)mode='next';if(!mode)return;const operation={key};scrollLoading=operation;loadDetail(true,mode).catch(fail).finally(()=>{if(scrollLoading===operation)scrollLoading=null;});});
  action('batch-hit-prev',()=>hitMove(-1));action('batch-hit-next',()=>hitMove(1));$('batch-search').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key==='F3'){e.preventDefault();hitMove(e.shiftKey?-1:1);}});action('batch-copy',()=>detail?api.writeClipboard(detail.output):null);
  $('batch-command-jump').addEventListener('change',()=>{const commands=Array.isArray(detail?.commands)?detail.commands:[];const item=commands.find(c=>String(c.index)===$('batch-command-jump').value);if(!item)return;revision++;detailOffset=Math.floor(Math.max(0,Number(item.outputOffset)||0)/DETAIL_PAGE)*DETAIL_PAGE;loadDetail(true,'reset').then(applied=>{if(applied){paint(item.command);hitMove(1);}}).catch(fail);});
  for(const format of ['txt','xlsx'])action(`batch-export-${format}`,async()=>{if(!summary){fail(new Error('저장할 결과가 없습니다.'));return;}if(summary.active){fail(new Error('작업이 종료된 뒤 결과를 저장해 주세요.'));return;}
    // One export at a time. Each call starts a new worker that holds a copy of
    // every transcript, so repeated clicks could stack workers and memory.
    if(exporting){fail(new Error('이미 결과를 저장하는 중입니다. 완료될 때까지 기다려 주세요.'));return;}
    exporting=true;update();
    try{
      const filter=$('batch-export-filter').checked;const result=await api.exportBatch({jobId:summary.id,format,...(filter?filters():{})});if(result){const message=`${result.devices}개 장비 결과`;if(result.opened===false)toast(`파일은 저장했지만 열지 못했습니다: ${result.openError||'Windows 기본 앱에서 파일을 열 수 없습니다.'} (${result.path})`,true);else toast(`${message}를 저장하고 열었습니다: ${result.path}`);}
    }finally{exporting=false;update();}});
  update();renderGroup();return {open:async()=>{if(!dialog.open){cleanupClosed();dialog.showModal();closeCleaned=false;dialogRevision++;formRevision++;importRequest++;keyRequest++;}$('batch-error').textContent='';const at=dialogRevision;await credentials(at);if(!dialog.open||at!==dialogRevision)return;
    // Templates are machine-local and cheap; refresh them on every open so a
    // template saved in another window/session is immediately selectable.
    await loadTemplates(templateSelect.value).catch(error=>{if(dialog.open&&at===dialogRevision)fail(error);});
    if(!dialog.open||at!==dialogRevision)return;
    const request=++summaryRequest,eventAt=eventRevision;const result=await api.batchSummary();if(!dialog.open||at!==dialogRevision||request!==summaryRequest||eventAt!==eventRevision)return;summary=result;update();if(summary)tab(true);},onEvent:event=>{if(event.type!=='batch')return;eventRevision++;summaryRequest++;if(summary?.id!==event.summary?.id){revision++;detailRequest++;rowId=null;detail=null;offset=0;detailOffset=0;rowsKey='';paint();}summary=event.summary;if(dialog.open){update();refresh().catch(fail);}}};
}
