// User-selected terminal automation and keyboard mappings. No script runs on startup.
export function installAdvancedTerminalUI({ api, state, refreshData, message, toast, showError }) {
  const node = (tag, text, className) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(className)n.className=className; return n; };
  const input = (name, value='', type='text') => { const n=node('input'); n.name=name; n.type=type; n.value=value; n.autocomplete='off'; return n; };
  const label = (text, control) => { const n=node('label',text); n.append(control); return n; };
  const select = (name, choices, value) => { const n=node('select');n.name=name;for(const [key,text] of choices)n.add(new Option(text,key));if(value!==undefined)n.value=value;return n; };
  const button = (text, callback, kind='secondary-button') => { const b=node('button',text,kind);b.type='button';b.addEventListener('click',()=>Promise.resolve(callback()).catch(showError));return b; };
  function dialog(id,title){
    const d=node('dialog',undefined,'modal advanced-terminal-modal');d.id=id;
    const f=node('form'),head=node('div',undefined,'modal-header'),body=node('div',undefined,'modal-body advanced-terminal-body'),foot=node('div',undefined,'modal-footer'),error=node('p','', 'form-error');
    error.setAttribute('role','alert');head.append(node('h2',title),button('×',()=>d.close(),'icon-button'));
    const cancel=button('닫기',()=>d.close()),submit=node('button','저장','primary-button');submit.type='submit';foot.append(cancel,submit);f.append(head,body,error,foot);d.append(f);document.body.append(d);
    return {d,f,body,foot,error,submit};
  }
  const keymap=dialog('keymap-dialog','키 매핑'),keyRows=node('div',undefined,'keymap-rows');
  const scope=select('scope',[['global','모든 세션의 기본값']], 'global');
  const inherit=input('inherit','','checkbox');inherit.id='keymap-inherit';
  const inheritLabel=label('전체 키 매핑 상속',inherit);inheritLabel.className='check-label';inheritLabel.htmlFor=inherit.id;inheritLabel.prepend(inherit);
  keymap.body.append(label('적용 대상',scope),inheritLabel,node('p','키 조합과 전송 문자열(\\r, \\e, \\x1b, \\033 제어 문자 지원)을 입력합니다.','field-hint'),keyRows);
  const scopeHint=node('p','','field-hint');scopeHint.id='keymap-scope-hint';scopeHint.setAttribute('role','status');
  const inheritedRows=node('div',undefined,'keymap-inherited');inheritedRows.id='keymap-inherited';
  const headings=node('div',undefined,'keymap-row keymap-headings');for(const title of ['사용','키','전송 문자열',''])headings.append(node('span',title));
  keyRows.before(scopeHint,headings,inheritedRows);
  const mappingStatus=row=>row.enabled===false?'사용 해제: 기본 키 동작':row.text?'사용: 지정한 문자열 전송':'빈 문자열: 키 입력 무시';
  function addKey(row={}){
    const r=node('div',undefined,'keymap-row'),key=input('key',row.key||''),text=input('text',row.text||''),enabled=input('enabled','','checkbox');
    key.placeholder='예: Ctrl+F2';text.placeholder='예: show version\\r';enabled.checked=row.enabled!==false;key.maxLength=80;text.maxLength=4096;
    key.setAttribute('aria-label','키 조합');text.setAttribute('aria-label','전송 문자열');enabled.setAttribute('aria-label','사용');
    const status=node('small','','keymap-row-hint');
    const updateStatus=()=>{status.textContent=mappingStatus({enabled:enabled.checked,text:text.value});};
    enabled.addEventListener('change',updateStatus);text.addEventListener('input',updateStatus);updateStatus();
    r.append(enabled,key,text,button('삭제',()=>r.remove(),'text-button'),status);keyRows.append(r);
  }
  const addKeyButton=button('키 매핑 추가',()=>addKey());keymap.body.append(addKeyButton);
  keymap.body.append(node('p','사용 해제는 기본 키 동작을 유지하고 사용 중 빈 문자열은 키 입력을 무시합니다.','field-hint'));
  function updateInheritance(){
    const inherited=scope.value!=='global'&&inherit.checked;
    scopeHint.textContent=inherited?'상속 중 · 전체 키 매핑 (읽기 전용)':scope.value==='global'?'모든 세션의 기본 키 매핑':'이 세션에서 재정의 · 같은 키는 우선 적용, 나머지는 전체 키 매핑 사용';
    keyRows.hidden=inherited;inheritedRows.hidden=!inherited;addKeyButton.disabled=inherited;
    keyRows.querySelectorAll('input,button').forEach(n=>n.disabled=inherited);
    inheritedRows.replaceChildren();
    if(inherited){
      for(const row of state.settings.keymap||[]){const r=node('div',undefined,'keymap-row');r.append(node('span',row.enabled===false?'해제':'사용'),node('span',row.key),node('code',row.text||'(빈 문자열)'),node('span',''),node('small',mappingStatus(row),'keymap-row-hint'));inheritedRows.append(r);}
      if(!inheritedRows.children.length)inheritedRows.append(node('p','등록된 전체 키 매핑이 없어 기본 키 동작을 사용합니다.','field-hint'));
    }
  }
  function loadKeyRows(){
    const s=state.sessions.find(s=>s.id===scope.value),mapping=s?s.keymap:state.settings.keymap;
    inherit.closest('label').classList.toggle('hidden',!s);inherit.checked=!!s&&mapping==null;
    keyRows.replaceChildren();for(const row of mapping||[])addKey(row);if(!keyRows.children.length)addKey();
    updateInheritance();keymap.error.textContent='';
  }
  scope.addEventListener('change',loadKeyRows);inherit.addEventListener('change',updateInheritance);
  keymap.f.addEventListener('submit',async event=>{event.preventDefault();keymap.submit.disabled=true;try{
    const values=[...keyRows.children].map(r=>({key:r.querySelector('[name=key]').value.trim(),text:r.querySelector('[name=text]').value,enabled:r.querySelector('[name=enabled]').checked})).filter(r=>r.key||r.text);
    if(scope.value==='global')await api.saveSettings({keymap:values});else await api.saveSession({id:scope.value,keymap:inherit.checked?null:values});
    await refreshData();keymap.d.close();toast('키 매핑이 적용되었습니다.');
  }catch(error){keymap.error.textContent=error.message;}finally{keymap.submit.disabled=false;}});

  const automation=dialog('automation-dialog','명령 자동화'),name=input('name','장비 점검'),steps=node('div',undefined,'automation-steps'),destination=input('outputFile');destination.readOnly=true;
  const hint=node('p','','field-hint'),status=node('output','','automation-status');status.setAttribute('aria-live','polite');
  automation.body.append(hint,label('작업 이름',name),steps);
  const types=[['sendLine','명령 전송'],['waitFor','문자 대기'],['expectSend','대기 후 응답'],['capture','결과 읽기'],['sleep','잠시 대기']];
  function addStep(step={type:'sendLine'}){
    const r=node('div',undefined,'automation-step'),kind=select('type',types,step.type),text=input('text',step.text||''),pattern=input('pattern',step.pattern||''),timeout=input('timeout',String((step.timeoutMs||10000)/1000),'number');
    r.originalStep=structuredClone(step);if(step.pattern&&typeof step.pattern!=='string')r.flowStep=structuredClone(step);
    if(!types.some(([type])=>type===step.type)){kind.add(new Option('불러온 조건 분기',step.type));kind.value=step.type;r.flowStep=structuredClone(step);}
    timeout.min='.1';timeout.max='300';timeout.step='.1';text.maxLength=32768;pattern.maxLength=1024;
    const response=label('보낼 명령 / 응답',text),expect=label('기다릴 문자',pattern),seconds=label('대기 시간 (초)',timeout);
    const update=()=>{response.classList.toggle('hidden',!['sendLine','expectSend'].includes(kind.value));expect.classList.toggle('hidden',!['waitFor','expectSend','capture'].includes(kind.value));};
    kind.addEventListener('change',update);r.append(label('동작',kind),response,expect,seconds,button('삭제',()=>r.remove(),'text-button'));steps.append(r);update();
  }
  const outputRow=node('div',undefined,'input-with-button');outputRow.append(destination,button('저장 위치…',async()=>{const path=await api.chooseAutomationOutput();if(path)destination.value=path;}),button('해제',()=>destination.value='','text-button'));
  const tools=node('div',undefined,'automation-tools');tools.append(button('단계 추가',()=>addStep()),button('불러오기…',async()=>{const flow=await api.openAutomationFlow();if(!flow)return;name.value=flow.name||'장비 점검';steps.replaceChildren();for(const step of flow.steps||[])addStep(step);}),button('저장…',async()=>{await api.saveAutomationFlow(readFlow());toast('자동화 작업을 저장했습니다.');}));
  automation.body.append(tools,label('결과 저장 파일 (선택)',outputRow),status);automation.submit.textContent='현재 탭에서 실행';
  function active(){const c=state.connections.get(state.active);if(!c||c.status!=='connected')throw new Error('자동화할 연결된 탭을 선택해 주세요.');return c;}
  function current(c,id){return c.id===id&&state.connections.get(id)===c&&c.status==='connected'&&!c.closing&&!c.manualDisconnect&&!c.reconnecting&&!c.reconnectOperation;}
  function readFlow(){return {name:name.value.trim(),steps:[...steps.children].map(r=>{const kind=r.querySelector('[name=type]').value;if(r.flowStep&&kind===r.flowStep.type)return structuredClone(r.flowStep);const text=r.querySelector('[name=text]').value,pattern=r.querySelector('[name=pattern]').value,timeoutMs=Math.round(Number(r.querySelector('[name=timeout]').value)*1000);return {...(r.originalStep?.type===kind?r.originalStep:{}),type:kind,text,pattern,timeoutMs,...(kind==='sleep'?{durationMs:timeoutMs}:{})};})};}
  automation.f.addEventListener('submit',async event=>{event.preventDefault();automation.submit.disabled=true;try{
    const c=active(),connectionId=c.id,flow=readFlow();
    if(!flow.steps.length)throw new Error('실행할 단계를 추가해 주세요.');
    if(!await message('명령 자동화 실행',`${c.name} · ${flow.steps.length}단계\n이 탭에서 명령을 실행합니다.`,{confirm:true,action:'실행'}))return;
    if(!current(c,connectionId))throw new Error('연결 대상이 바뀌었습니다. 다시 선택해 주세요.');
    const job=await api.startAutomation({connectionId,...flow,outputFile:destination.value||undefined});if(!current(c,connectionId))return;jobs.set(connectionId,typeof job==='string'?job:job.id||job.jobId);status.textContent='실행 중';automation.d.close();
  }catch(error){automation.error.textContent=error.message;}finally{automation.submit.disabled=false;}});
  const jobs=new Map();
  const sharedCredential=dialog('shared-credential-dialog','공유 목록의 공통 계정'),sharedSelect=select('credentialId', [['','세션에 지정된 계정 사용']]),sharedName=node('p','');let sharedSourceId='';
  sharedCredential.body.append(sharedName,node('p','이 PC에서 SSH로 연결할 때만 사용합니다.','field-hint'),label('공통 계정',sharedSelect));
  sharedCredential.f.addEventListener('submit',async event=>{event.preventDefault();sharedCredential.submit.disabled=true;try{await api.bindSharedCredential({sourceId:sharedSourceId,credentialId:sharedSelect.value});await refreshData();sharedCredential.d.close();toast('공유 목록의 로컬 계정 설정을 저장했습니다.');}catch(error){sharedCredential.error.textContent=error.message;}finally{sharedCredential.submit.disabled=false;}});
  async function openPython(){
    const c=active(),connectionId=c.id,script=await api.choosePythonScript();if(!script)return;
    if(!current(c,connectionId))throw new Error('연결 대상이 바뀌었습니다.');
    if(!await message('Python 스크립트 실행',`${c.name}\n${script}\n선택한 로컬 스크립트를 실행합니다.`,{confirm:true,action:'실행'}))return;
    if(!current(c,connectionId))throw new Error('연결 대상이 바뀌었습니다.');
    const job=await api.startPython({connectionId,scriptPath:script});if(!current(c,connectionId))return;jobs.set(connectionId,typeof job==='string'?job:job.id||job.jobId);toast('Python 스크립트를 실행했습니다.');
  }
  return {
    openSharedCredential(source){sharedSourceId=source.id;sharedName.textContent=source.name;sharedSelect.replaceChildren(new Option('세션에 지정된 계정 사용',''),...(state.credentials||[]).map(c=>new Option(c.name,c.id)));sharedSelect.value=state.settings.sharedCredentialBindings?.[source.id]||'';sharedCredential.error.textContent='';sharedCredential.d.showModal();},
    openKeymap(){keymap.error.textContent='';scope.replaceChildren(new Option('모든 세션의 기본값','global'),...state.sessions.filter(s=>!s.sharedSourceId).map(s=>new Option(s.name,s.id)));scope.value='global';loadKeyRows();keymap.d.showModal();},
    openAutomation(){const c=active();hint.textContent=`실행 대상: ${c.name}`;automation.error.textContent='';if(!steps.children.length){addStep({type:'sendLine',text:'show version'});addStep({type:'waitFor',pattern:'#'});}automation.d.showModal();},
    openPython,
    async cancelActive(){const job=(await api.automationJobs()).find(job=>job.connectionId===state.active);const id=job?.jobId;if(!id){toast('현재 탭에 실행 중인 자동화가 없습니다.');return;}await api.cancelAutomation(id);},
    onEvent(event){
      const c=state.connections.get(event.connectionId);if(c)c.automationRunning=event.status==='running';
      document.querySelectorAll('.terminal-tab').forEach(tab=>{if(tab.dataset.connectionId===event.connectionId)tab.classList.toggle('automation-running',event.status==='running');});
      if(event.status==='running'||event.status==='started')jobs.set(event.connectionId,event.id||event.jobId);
      if(['completed','cancelled','error','failed'].includes(event.status)){jobs.delete(event.connectionId);status.textContent=event.status==='completed'?'완료':event.status==='cancelled'?'중지':'실패';toast(event.status==='completed'?'자동화가 완료되었습니다.':event.status==='cancelled'?'자동화를 중지했습니다.':event.message||'자동화를 완료하지 못했습니다.',['error','failed'].includes(event.status));}
    }
  };
}
