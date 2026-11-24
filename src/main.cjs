'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, session: electronSession, shell, clipboard, protocol, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { APP_SCHEME, APP_URL, createAppProtocol } = require('./lib/app-protocol.cjs');
const { createClipboardWriter, validateClipboardOptions } = require('./lib/clipboard-write.cjs');
const { SessionStore } = require('./lib/session-store.cjs');
const { LogLossJournal } = require('./lib/log-loss-journal.cjs');
const { ConnectionService } = require('./lib/connection-service.cjs');
const { TerminalOutput } = require('./lib/terminal-output.cjs');
const { AutomationService } = require('./lib/automation-service.cjs');
const { AutomationScreenReader } = require('./lib/automation-screen.cjs');
const { BatchService } = require('./lib/batch-service.cjs');
const { writeResultAsync } = require('./lib/batch-export-async.cjs');
const { parseConnectionAddress } = require('./lib/connection-address.cjs');
const { telnetFallbackPorts } = require('./lib/hybrid-connect.cjs');
const { probePort } = require('./lib/port-probe.cjs');
const { logLocation } = require('./lib/logging-settings.cjs');
const { importSecureCrtDirectory, importSecureCrtXml } = require('./lib/securecrt-import.cjs');
const { importWindTermSessions } = require('./lib/windterm-import.cjs');
const { importPuttyReg, readPuttyRegistry } = require('./lib/putty-import.cjs');
const { assertOutputPathAsync, writeAtomicFile, readSessionFile, parseSessionFile, serializeSessionExport } = require('./lib/session-file.cjs');
const { SharedSessions } = require('./lib/shared-sessions.cjs');
const { createSharedStartup } = require('./lib/shared-startup.cjs');
const { installWindowCaption } = require('./lib/window-caption.cjs');
const { displayAtCursor, geometryForDisplay, installWindowGeometry } = require('./lib/window-geometry.cjs');
const { createServiceShutdown } = require('./lib/service-shutdown.cjs');
const { UpdateService, updateLocation, runWorker, createUpdateNotice } = require('./lib/update-service.cjs');
const { createRestartReceipt, retryCleanup } = require('./lib/update-restart.cjs');
const { createUpdateResults } = require('./lib/update-result.cjs');
const { APP_ID, resolveLaunchSpec, writeDesktopShortcut } = require('./lib/windows-shortcut.cjs');

protocol.registerSchemesAsPrivileged([{scheme:APP_SCHEME,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);

const requestedUserData=app.commandLine.getSwitchValue('user-data-dir');
if(requestedUserData)app.setPath('userData',path.resolve(requestedUserData));
else if (!app.isPackaged && process.env.SESSIONDOCK_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.SESSIONDOCK_TEST_USER_DATA));
// One version independent AppUserModelID ties the process, window, shortcut and
// pin together. Development pollution of the production ID is prevented by
// blocking development shortcut generation, not by a second identity here.
app.setAppUserModelId(APP_ID);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
const pageUrl = APP_URL;
let window, store, ssh, terminalOutput, shared, sharedStartup, automation, screenReader, batch, updater;
let updateRestartReceipt, updateResults;
let logLossJournal;
let updateShutdown = false, updateNotice, startupUpdateGeneration = 0, settingsSaveGeneration = 0;
// Window surfaces cannot switch between opaque and transparent without recreating
// the native window. Keep the startup decision stable for this process so a saved
// setting can affect the next launch while existing connections remain untouched.
let runtimeTransparent = false;
const legacyOutput = !app.isPackaged && process.env.SESSIONDOCK_TEST_OUTPUT_MODE === 'legacy';
let quitting = false;
let quitReady = false;
let serviceShutdown;
function shutdownServices() {
  serviceShutdown ||= createServiceShutdown([() => batch?.close(), () => automation?.close(), () => ssh?.close()]);
  return serviceShutdown();
}
app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
const requests = new Map();
// A batch job owns its own prompt: its multifactor question must survive a renderer
// reload (the job is still running and its own owner answers it), so it is never
// rejected by `rejectStaleRequests` and never cancelled by a document retirement.
const BATCH_REQUEST_OWNER = 'batch';
const selectedScripts=new Set(),selectedAutomationOutputs=new Set();
const defaultConfigPath = path.join(process.env.APPDATA || app.getPath('appData'), 'VanDyke', 'Config');
function trackLogLoss(event) {
  if (!logLossJournal || !['log','log-error','status'].includes(event.type)) return event;
  // Bind while the transport still exists; the journal retains only bounded ids
  // so late log-close failures remain attributable after teardown/reconnect.
  if (!logLossJournal.bindings.has(event.id)) {
    try { logLossJournal.bind(event.id, ssh?.getConnectionInfo(event.id)?.sessionId); } catch { /* already closed */ }
  }
  const revision = logLossJournal.revision;
  const logLoss = logLossJournal.observe(event);
  if (revision !== logLossJournal.revision && window && !window.isDestroyed()) {
    window.webContents.send('app:event', { type:'log-loss', profileId:logLoss.profileId, logLoss });
  }
  return logLoss ? { ...event, logLoss } : event;
}
const send = input => {
  const event = trackLogLoss(input);
  if(event.type==='data')automation?.onData({id:event.id,data:typeof event.data==='string'?Buffer.from(event.data,'base64'):event.data});
  if(event.type==='status'){automation?.onStatus(event);if(['disconnected','error'].includes(event.status))screenReader?.cancelConnection(event.id);}
  if(event.type==='status' && event.status==='connected'){
    const connection=ssh?.connections.get(event.id),globalEnabled=store.getSettings().logEnabled;
    // Reconcile changes made while authentication or the TCP handshake was pending.
    if(connection && (globalEnabled?!connection.logStream:connection.logSource==='global')){
      ssh.setLogging(event.id,globalEnabled,'global').catch(error=>sendDirect({type:'log-error',id:event.id,message:error.message}));
    }
  }
  if (terminalOutput && event.type === 'data') {
    const epoch = ownerEpochOf(event.id);
    // Output produced by a transport whose document is gone is drained by the
    // transport and never forwarded: not as data, and not as a reason to open a
    // display channel for the replacement page (V9-M-05).
    if (epoch !== null && !ownerIsCurrent(epoch)) return;
    terminalOutput.push(event.id, event.data, epoch === null ? {} : { ownerEpoch: epoch });
    return;
  }
  if (terminalOutput && event.type === 'status' && (event.status === 'connecting' || event.status === 'connected')) {
    // The owner opens the display channel when its connection starts, not when the
    // first byte arrives: output may be produced before this status is handled, and a
    // push must never be the thing that creates a channel (V9-M-05). A retired
    // owner's channel stays closed, so a stale connect cannot revive it.
    const epoch = ownerEpochOf(event.id);
    if (epoch === null || ownerIsCurrent(epoch)) terminalOutput.open(event.id, epoch ?? rendererEpoch);
  }
  if (terminalOutput && event.type === 'status' && ['error','disconnected'].includes(event.status)) {
    const epoch = ownerEpochOf(event.id);
    terminalOutput.finish(event, epoch === null ? {} : { ownerEpoch: epoch });
    return;
  }
  sendDirect(event);
};
const sendDirect = input => {
  // Persist before the renderer-owner gate: an old page cannot consume this
  // failure, but the next connection to its profile must still see the warning.
  const event = trackLogLoss(input);
  // Events belonging to a retired renderer document are not delivered to its
  // replacement: the transport drains and logs them, but the fresh page has no such
  // tab and must never receive a status for a session it did not open (V9-M-05).
  if (typeof event?.id === 'string') {
    const owner = ownerEpochOf(event.id);
    if (owner !== null && !ownerIsCurrent(owner)) return;
  }
  if (event.type === 'auth-state' && (event.generation !== event.id || ownerEpochOf(event.id) === null || !ownerIsCurrent(ownerEpochOf(event.id)))) return;
  if (event.type === 'status' && ['error', 'disconnected'].includes(event.status)) {
    for (const [id, request] of requests) {
      if (request.connectionId !== event.id) continue;
      requests.delete(id); clearTimeout(request.timer);
      if (window && !window.isDestroyed()) window.webContents.send('app:event', { type: 'prompt-expired', requestId: id });
      request.reject(new Error('연결이 종료되었습니다.'));
    }
  }
  if (window && !window.isDestroyed()) window.webContents.send('app:event', event);
};

// Renderer ownership boundary (V8-M-05, extended by V9-M-05).
//
// Every interactive connection belongs to the renderer document that opened it. A
// reload replaces that document — the renderer comes back with zero tabs — but the
// main process used to keep the sockets, their auth prompts and their display
// channels alive, and it also kept *pending* work alive: an `ssh:address-connect`
// that was still awaiting its auto-protocol probe created a connection, a server
// socket and a temporary profile after the page was already gone. A snapshot of the
// connection ids taken at navigation start cannot see that, because the id does not
// exist yet.
//
// Ownership is therefore an epoch, not an id list. `rendererEpoch` is bumped at the
// START of every top-level navigation and of a renderer crash; every IPC callback
// captures the epoch it started under and re-checks it after every await and
// immediately before it asks a transport for a socket.
let orphanCandidates = null;
// Bounded id -> owner maps. An entry is retained after retirement on purpose: it is
// what proves that late output from the retiring transport is stale rather than a
// new session, so a stray callback can never re-create a display channel.
const OWNER_RETENTION = 4096;
let rendererEpoch = 0;
let addressConnectGeneration = 0;
const clipboardWriter = createClipboardWriter({ clipboard });
const connectionOwners = new Map();
const profileOwners = new Map();
function rememberOwner(map, id, epoch) {
  if (typeof id !== 'string') return;
  map.set(id, epoch);
  if (map.size > OWNER_RETENTION) map.delete(map.keys().next().value);
}
function ownerEpochOf(id) {
  return connectionOwners.has(id) ? connectionOwners.get(id) : null;
}
function ownerIsCurrent(epoch) {
  return epoch === rendererEpoch;
}
function staleOwnerError() {
  const error = new Error('화면이 다시 로드되어 이전 연결 요청을 취소했습니다.');
  error.code = 'RENDERER_GONE';
  return error;
}
// The gate every connection-creating path passes through: after the last await and
// before the transport allocates a socket.
function startOwnedConnect(ownerEpoch, start) {
  if (updateShutdown) throw new Error('업데이트 종료 정리가 진행 중입니다.');
  if (!ownerIsCurrent(ownerEpoch) || !window || window.isDestroyed()) throw staleOwnerError();
  const result = start();
  if (result && typeof result.id === 'string') {
    rememberOwner(connectionOwners, result.id, ownerEpoch);
    const profileId = result.session?.id ?? result.sessionId;
    if (typeof profileId === 'string' && profileId.startsWith('temporary_')) rememberOwner(profileOwners, profileId, ownerEpoch);
  }
  if (result && logLossJournal) {
    const logLoss = logLossJournal.bind(result.id, result.session?.id ?? result.sessionId);
    if (logLoss) result.logLoss = logLoss;
  }
  return result;
}
// Prompts the retired document can never answer are settled with an explicit code.
// A batch prompt belongs to the job's own owner, so it is never touched here: only
// the batch can cancel its own multifactor question.
function rejectStaleRequests() {
  for (const [id, request] of requests) {
    if (request.epoch === BATCH_REQUEST_OWNER || request.epoch === rendererEpoch) continue;
    requests.delete(id);
    clearTimeout(request.timer);
    if (window && !window.isDestroyed()) window.webContents.send('app:event', { type: 'prompt-expired', requestId: id });
    try { request.reject(staleOwnerError()); } catch { /* already settled */ }
  }
}
function retireRendererPage(reason) {
  rejectStaleRequests();
  const retired = [];
  // Profiles created by a retired document are released, but only after the
  // transports that used them are gone (below).
  const retiredProfiles = new Set();
  for (const [profileId, epoch] of profileOwners) if (epoch !== rendererEpoch) retiredProfiles.add(profileId);
  const connectionIds = new Set(connectionOwners.keys());
  for (const connection of ssh?.listConnections?.() || []) connectionIds.add(connection.id);
  const teardowns = [];
  for (const connectionId of connectionIds) {
    const owner = ownerEpochOf(connectionId);
    // Created by the live document: never touched by a retirement.
    if (owner === rendererEpoch) continue;
    // `getConnectionInfo` throws for an id its transport no longer tracks, which is a
    // normal outcome here: the connection may already be fully closed.
    let info = null;
    try { info = typeof connectionId === 'string' ? ssh?.getConnectionInfo?.(connectionId) : null; } catch { info = null; }
    if (typeof info?.sessionId === 'string' && info.sessionId.startsWith('temporary_')) retiredProfiles.add(info.sessionId);
    // A tombstone, not a plain dispose: the transport is still emitting and its
    // output must not be replayed into the replacement document.
    try { terminalOutput?.retire(connectionId); } catch { /* queue is already closed */ }
    if (!info || !['connecting', 'connected'].includes(info.status)) continue;
    retired.push(connectionId);
    try { screenReader?.cancelConnection(connectionId); } catch { /* no job for it */ }
    // Graceful close: the transport finishes its own cleanup (log stream, SFTP, close
    // confirmation) instead of the socket being dropped under it. The profile is
    // released only after this bounded wait, so a late connect cannot adopt a profile
    // that is being torn down.
    teardowns.push(Promise.resolve()
      .then(() => ssh.disconnectAndWaitClosed(connectionId, { timeoutMs: 2000 }))
      .catch(error => console.error(`Failed to retire connection ${connectionId} after a renderer ${reason}:`, error?.message)));
  }
  if (retiredProfiles.size) {
    // Bounded, and independent of the new document: the profile ids in this set were
    // created by the retired epoch, so releasing them cannot disturb a quick connect
    // the fresh page has already started.
    Promise.all(teardowns)
      .then(() => {
        for (const profileId of retiredProfiles) {
          if (profileOwners.get(profileId) === rendererEpoch) continue;
          try { ssh?.releaseTemporaryForRetiredOwner?.(profileId); } catch { /* already released */ }
        }
      })
      .catch(() => {});
  }
  orphanCandidates = null;
  return retired;
}
function expireBatchPrompts(event){for(const [id,request] of requests){if(request.connectionId!==event.id)continue;requests.delete(id);clearTimeout(request.timer);if(window&&!window.isDestroyed())window.webContents.send('app:event',{type:'prompt-expired',requestId:id});request.reject(new Error('일괄 연결이 종료되었습니다.'));}}
const ask = prompt => new Promise((resolve, reject) => {
  const requestId = crypto.randomUUID();
  // Ownership of the question. A batch question belongs to its job (which outlives a
  // renderer reload and cancels itself), every other question belongs to the document
  // that opened the connection (V9-M-05).
  const isBatch = prompt?.batch === true;
  const epoch = isBatch ? BATCH_REQUEST_OWNER : ownerEpochOf(prompt?.connectionId);
  if (!window || window.isDestroyed() || !window.webContents ||
      (isBatch ? (!batch?.job?.active || batch.job.cancelled || !batch.connections?.has(prompt?.connectionId))
        : (epoch === null || !ownerIsCurrent(epoch) || !ssh?.listConnections().some(item => item.id === prompt?.connectionId && ['connecting','connected'].includes(item.status))))) {
    return reject(staleOwnerError());
  }
  if (prompt.kind === 'credentials' && (!Array.isArray(prompt.fields) || !prompt.fields.length ||
      new Set(prompt.fields).size !== prompt.fields.length || prompt.fields.some(name => !['username','password','passphrase'].includes(name)))) {
    return reject(new Error('인증 요청이 올바르지 않습니다.'));
  }
  const ownerWebContents = window.webContents, replyEpoch = rendererEpoch;
  const timer = setTimeout(() => {
    requests.delete(requestId); send({ type: 'prompt-expired', requestId });
    // A fixed code, so a prompt deadline is never reported as a credential
    // rejection or as a generic connection failure.
    const error = new Error('인증 응답 대기 시간이 초과되었습니다. 다시 연결해 주세요.');
    error.code = 'AUTH_RESPONSE_TIMEOUT';
    reject(error);
  }, 120000);
  requests.set(requestId, { resolve, reject, timer, connectionId: prompt.connectionId, epoch,
    ownerWebContents, replyEpoch, kind: prompt.kind, fields: prompt.fields, deadline: Date.now() + 120000 });
  send({ type: 'prompt', requestId, ...prompt });
});
function authorized(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pageUrl) throw new Error('허용되지 않은 요청입니다.');
}
function handle(channel, callback, options = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    authorized(event);
    if (options.mainFrame && (!window.webContents.mainFrame || event.senderFrame !== window.webContents.mainFrame)) return false;
    if ((updateShutdown || quitting) && /^(ssh:(connect|quick-connect|address-connect)|batch:start|automation:(start|python)|settings:save|update:)/.test(channel)) throw new Error('종료 정리가 진행 중입니다.');
    const payload = JSON.stringify(args);
    if (payload.length > 2 * 1024 * 1024) {
      // Still pass a credential reply through the request-owner checks so the
      // associated prompt is consumed instead of lingering until its TTL.
      if (options.oversize) return options.oversize(...args);
      throw new Error('요청이 너무 큽니다.');
    }
    return callback(...args);
  });
}
function assertLocalSessions(ids) {
  if (Array.isArray(ids) && ids.some(id => typeof id === 'string' && id.startsWith('shared_'))) throw new Error('공유 세션은 읽기 전용입니다. 관리자가 공유 파일을 갱신해야 합니다.');
}
function protectedOutputFiles() { return [store.filePath, store.templateFilePath, shared.filePath, logLossJournal?.filePath]; }
function checkOutputPath(filename) { return assertOutputPathAsync(filename, protectedOutputFiles()); }
function windowState() {
  return window && !window.isDestroyed()
    ? { maximized: window.isMaximized(), focused: window.isFocused(), runtimeTransparent }
    : { maximized: false, focused: false, runtimeTransparent };
}
function lookupSessionForConnection(id) {
  if(typeof id!=='string'||!id.startsWith('shared_'))return store.getSessionForConnection(id);
  const profile=shared.getSession(id),credentialId=store.getSettings().sharedCredentialBindings[profile.sharedSourceId];
  return profile.protocol!=='telnet'&&credentialId?store.resolveSessionWithCredential(profile,credentialId):profile;
}
function installHandlers() {
  handle('batch:preview',input=>batch.preview(input));
  handle('batch:clear-preview',()=>batch.clearPreview());
  handle('batch:start',token=>batch.start(token));
  handle('batch:summary',()=>batch.summary());
  handle('batch:cancel',()=>batch.cancel());
  handle('batch:rows',input=>batch.rows(input||{}));
  handle('batch:detail',input=>batch.detail(input||{}));
  handle('batch:list-templates',()=>store.batchTemplateSnapshot());
  handle('batch:save-template',input=>store.saveBatchTemplate(input));
  handle('batch:delete-template',(id,revision)=>store.deleteBatchTemplate(id,revision));
  handle('batch:import-targets',async()=>{const result=await dialog.showOpenDialog(window,{title:'IP 목록 불러오기',properties:['openFile'],filters:[{name:'IP 목록 (UTF-8)',extensions:['txt','csv']}]});if(result.canceled)return null;const file=result.filePaths[0],stat=fs.statSync(file);if(!stat.isFile()||stat.size>512*1024)throw new Error('IP 목록은 512KiB 이하의 텍스트 파일을 선택해 주세요.');return fs.readFileSync(file,'utf8').replace(/^\ufeff/,'');});
  handle('batch:export',async input=>{if(!input||!['txt','xlsx'].includes(input.format))throw new Error('결과 저장 형식이 올바르지 않습니다.');const rows=batch.exportRows(input);if(!rows.length)throw new Error('저장할 결과가 없습니다.');const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','_');const result=await dialog.showSaveDialog(window,{title:'일괄 실행 결과 저장',defaultPath:`batch_${stamp}.${input.format}`,filters:[{name:input.format==='xlsx'?'Excel 통합 문서':'텍스트',extensions:[input.format]}]});if(result.canceled)return null;const saved=await writeResultAsync(await checkOutputPath(result.filePath),input.format,rows,{protectedFiles:protectedOutputFiles()});let openError;try{openError=await shell.openPath(saved.path);}catch(error){openError=String(error?.message||error||'Windows 기본 앱에서 파일을 열지 못했습니다.');}return openError?{...saved,opened:false,openError:String(openError)}:{...saved,opened:true};});
  handle('automation:screen-reply',(requestId,text)=>screenReader.reply(requestId,text));
  handle('automation:jobs',()=>automation.listJobs());
  handle('automation:cancel',id=>automation.cancel(id));
  const checkOutput=async input=>{if(input.outputFile){if(!selectedAutomationOutputs.has(path.resolve(input.outputFile)))throw new Error('결과 저장 위치를 먼저 선택해 주세요.');await checkOutputPath(input.outputFile);}};
  handle('automation:start',async input=>{const ownerEpoch=rendererEpoch;await checkOutput(input);if(!ownerIsCurrent(ownerEpoch)||updateShutdown)throw staleOwnerError();return automation.start(input);});
  handle('automation:python',async input=>{const ownerEpoch=rendererEpoch;await checkOutput(input);if(!ownerIsCurrent(ownerEpoch)||updateShutdown)throw staleOwnerError();if(!selectedScripts.has(path.resolve(input.scriptPath||'')))throw new Error('실행할 Python 파일을 먼저 선택해 주세요.');return automation.startPython(input);});
  handle('automation:choose-python',async()=>{const result=await dialog.showOpenDialog(window,{title:'Python 스크립트 선택',properties:['openFile'],filters:[{name:'Python',extensions:['py']}]});if(result.canceled)return null;const filename=path.resolve(result.filePaths[0]),stat=fs.statSync(filename);if(!stat.isFile()||stat.size>1024*1024)throw new Error('스크립트 파일은 1MiB 이하로 선택해 주세요.');selectedScripts.add(filename);return filename;});
  handle('automation:choose-output',async()=>{const result=await dialog.showSaveDialog(window,{title:'자동화 결과 저장',defaultPath:'automation-output.txt'});if(result.canceled)return null;const filename=await checkOutputPath(result.filePath);selectedAutomationOutputs.add(filename);return filename;});
  handle('automation:open-flow',async()=>{const result=await dialog.showOpenDialog(window,{title:'자동화 작업 불러오기',properties:['openFile'],filters:[{name:'SessionDock 자동화',extensions:['json']}]});if(result.canceled)return null;const filename=result.filePaths[0],stat=fs.statSync(filename);if(!stat.isFile()||stat.size>512*1024)throw new Error('자동화 작업 파일이 너무 큽니다.');const flow=JSON.parse(fs.readFileSync(filename,'utf8'));if(flow.version!==1||!Array.isArray(flow.steps)||flow.steps.length>500)throw new Error('자동화 작업 파일 형식이 올바르지 않습니다.');return {name:flow.name,steps:flow.steps};});
  handle('automation:save-flow',async input=>{if(!input||!Array.isArray(input.steps)||input.steps.length>500)throw new Error('자동화 단계가 올바르지 않습니다.');const content=JSON.stringify({version:1,name:String(input.name||'').slice(0,100),steps:input.steps},null,2);if(Buffer.byteLength(content)>512*1024)throw new Error('자동화 작업이 너무 큽니다.');const result=await dialog.showSaveDialog(window,{title:'자동화 작업 저장',defaultPath:'automation.json',filters:[{name:'SessionDock 자동화',extensions:['json']}]});if(result.canceled)return null;return writeAtomicFile(result.filePath,content,protectedOutputFiles());});
  handle('settings:fonts', () => require('./lib/system-fonts.cjs').systemFonts());
  handle('folders:windterm-plan', () => store.planWindTermFolders());
  handle('folders:windterm-repair', revision => store.repairWindTermFolders(revision));
  handle('app:bootstrap', () => ({ folders: store.listFolders(), sessions: [...store.listSessions(), ...shared.listSessions()], sharedSources: shared.listSources(), snippets: store.listSnippets(), credentials: store.listCredentials(), settings: store.getSettings(), windowState: windowState(), defaultLogDirectory: path.join(app.getPath('userData'),'logs'), version: app.getVersion(), encryptionAvailable: safeStorage.isEncryptionAvailable(), defaultConfigPath, testMode: !app.isPackaged && !!process.env.SESSIONDOCK_TEST_USER_DATA }));
  handle('app:renderer-ready', () => { updateRestartReceipt?.rendererReady(); return true; });
  handle('folders:save', input => store.saveFolder(input));
  handle('folders:delete-plan', path => store.planFolderDeletion(path));
  handle('folders:delete', (path, revision) => {
    const plan = store.planFolderDeletion(path);
    if (plan) {
      const ids = new Set(plan.sessionIds);
      if (ssh.listConnections().some(c => ids.has(c.sessionId) && ['connecting', 'connected'].includes(c.status))) throw new Error('폴더 안의 세션을 삭제하기 전에 연결을 종료해 주세요.');
    }
    return store.deleteFolder(path, revision);
  });
  handle('sessions:save', input => { assertLocalSessions([input?.id]); return store.saveSession(input); });
  handle('credentials:list', () => store.listCredentials());
  handle('credentials:save', input => store.saveCredential(input));
  handle('credentials:delete', (id, options) => store.deleteCredential(id, options));
  handle('shared:credential',({sourceId,credentialId})=>{if(!shared.listSources().some(source=>source.id===sourceId))throw new Error('공유 목록을 찾을 수 없습니다.');const bindings={...store.getSettings().sharedCredentialBindings};if(credentialId)bindings[sourceId]=credentialId;else delete bindings[sourceId];return store.saveSettings({sharedCredentialBindings:bindings});});
  handle('sessions:update-many', input => { assertLocalSessions(input?.ids); return store.updateSessions(input); });
  handle('sessions:move', input => { assertLocalSessions(input?.ids); return store.moveSessions(input); });
  handle('sessions:delete-many', ids => {
    if (!Array.isArray(ids)) throw new Error('세션 선택이 올바르지 않습니다.');
    assertLocalSessions(ids);
    if (ssh.listConnections().some(c => ids.includes(c.sessionId) && ['connecting', 'connected'].includes(c.status))) throw new Error('선택한 세션을 삭제하기 전에 연결을 종료해 주세요.');
    return store.deleteSessions(ids);
  });
  handle('sessions:delete', id => { assertLocalSessions([id]); if (ssh.listConnections().some(c => c.sessionId === id && ['connecting', 'connected'].includes(c.status))) throw new Error('세션을 삭제하기 전에 연결을 종료해 주세요.'); return store.deleteSession(id); });
  handle('shared:choose-file', async () => { const result = await dialog.showOpenDialog(window, { title:'공유 세션 파일 선택', properties:['openFile'], filters:[{name:'SessionDock 공유 세션',extensions:['json']}] }); return result.canceled ? null : result.filePaths[0]; });
  handle('shared:add', async input => { const result = await shared.addSource(input); sendDirect({type:'shared-sessions-changed'}); return result; });
  handle('shared:refresh', async id => { try { return await shared.refreshSource(id); } finally { sendDirect({type:'shared-sessions-changed'}); } });
  handle('shared:startup-notice', () => sharedStartup.takeNotice());
  handle('shared:remove', async id => { const result = await shared.removeSource(id); sendDirect({type:'shared-sessions-changed'}); return result; });
  handle('sessions:import', async kind => {
    if (kind === 'securecrt') {
      const chosen = await dialog.showOpenDialog(window, { title: 'SecureCRT의 Config 또는 Sessions 폴더 선택', defaultPath: fs.existsSync(defaultConfigPath) ? defaultConfigPath : app.getPath('documents'), properties: ['openDirectory'] });
      if (chosen.canceled) return null;
      const result = await importSecureCrtDirectory(chosen.filePaths[0]);
      const { sessions } = store.importData({ version: 1, sessions: result.sessions });
      return { ...result, sessions, added: sessions.length };
    }
    if (kind === 'putty') {
      const result = await readPuttyRegistry();
      if (!result.sessions.length && !result.folders.length) return { ...result, sessions: [], added: 0 };
      const { sessions } = store.importData({ version: 1, sessions: result.sessions, folders: result.folders });
      return { ...result, sessions, added: sessions.length };
    }
    if (!['file', 'windterm', 'putty-file'].includes(kind)) throw new Error('가져오기 형식이 올바르지 않습니다.');
    if (kind === 'putty-file') {
      const chosen = await dialog.showOpenDialog(window, { title: 'PuTTY 세션 .reg 파일 선택', properties: ['openFile'], filters: [{ name: 'PuTTY 레지스트리 내보내기', extensions: ['reg'] }, { name: '모든 파일', extensions: ['*'] }] });
      if (chosen.canceled) return null;
      const result = importPuttyReg(readSessionFile(chosen.filePaths[0]));
      if (!result.sessions.length && !result.folders.length) return { ...result, sessions: [], added: 0 };
      const { sessions } = store.importData({ version: 1, sessions: result.sessions, folders: result.folders });
      return { ...result, sessions, added: sessions.length };
    }
    const windterm = kind === 'windterm';
    const chosen = await dialog.showOpenDialog(window, { title: windterm ? 'WindTerm의 user.sessions 파일 선택' : '세션 설정 가져오기', properties: ['openFile'], filters: [{ name: windterm ? 'WindTerm' : 'SessionDock / SecureCRT / WindTerm / PuTTY', extensions: windterm ? ['sessions', 'json'] : ['json', 'xml', 'sessions', 'reg'] }, { name: '모든 파일', extensions: ['*'] }] });
    if (chosen.canceled) return null;
    const filename = chosen.filePaths[0];
    const isXml = !windterm && path.extname(filename).toLowerCase() === '.xml';
    const isPutty = !windterm && path.extname(filename).toLowerCase() === '.reg';
    const fileBytes = readSessionFile(filename, { legacy: windterm || isXml });
    if (isPutty) {
      const result = importPuttyReg(fileBytes);
      if (!result.sessions.length && !result.folders.length) return { ...result, sessions: [], added: 0 };
      const { sessions } = store.importData({ version: 1, sessions: result.sessions, folders: result.folders });
      return { ...result, sessions, added: sessions.length };
    }
    if (!windterm && path.extname(filename).toLowerCase() === '.xml') {
      const result = await importSecureCrtXml(fileBytes);
      const { sessions } = store.importData({ version: 1, sessions: result.sessions });
      return { ...result, sessions, added: sessions.length };
    }
    const data = parseSessionFile(fileBytes, { windterm });
    if (windterm || Array.isArray(data)) {
      const result = importWindTermSessions(data), { sessions } = store.importData({ version: 1, sessions: result.sessions });
      return { ...result, sessions, added: sessions.length };
    }
    const result = store.importData(data);
    return { added: typeof result === 'number' ? result : result?.added ?? result?.sessions?.length ?? 0, sessions: store.listSessions(), skipped: [], warnings: [] };
  });
  handle('sessions:export', async () => {
    const chosen = await dialog.showSaveDialog(window, { title: '세션 설정 내보내기', defaultPath: 'SessionDock-sessions.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (chosen.canceled) return null;
    const destination = writeAtomicFile(chosen.filePath, serializeSessionExport(store.exportData()), protectedOutputFiles());
    return { path: destination };
  });
  handle('snippets:save', input => store.saveSnippet(input));
  handle('snippets:delete', id => store.deleteSnippet(id));
  handle('settings:save', async input => {
    const epoch = rendererEpoch;
    const saveGeneration = ++settingsSaveGeneration;
    const previous = store.getSettings();
    const changesSource = (input.updateDirectory !== undefined && input.updateDirectory !== previous.updateDirectory) ||
      (input.updateFromLocalFolder !== undefined && input.updateFromLocalFolder !== previous.updateFromLocalFolder);
    if (updater?.installPending && changesSource) throw new Error('업데이트 설치 준비를 먼저 취소해 주세요.');
    const useLocalFolder = (input.updateFromLocalFolder ?? previous.updateFromLocalFolder) === true;
    if (useLocalFolder && input.updateDirectory && input.updateDirectory !== previous.updateDirectory) {
      const normalized = await runWorker(updater.pythonExecutable, updater.helperPath, 'normalize', {folder:input.updateDirectory}, 10000);
      input = {...input, updateDirectory:normalized.folder};
    }
    if (!ownerIsCurrent(epoch) || updateShutdown || quitting || saveGeneration !== settingsSaveGeneration) throw staleOwnerError();
    if (updater?.installPending && changesSource) throw new Error('업데이트 설치 준비를 먼저 취소해 주세요.');
    const next = store.saveSettings(input);
    if (updateLocation(next) !== updateLocation(previous) || !next.updateCheckOnStartup || next.updateSnoozeUntil > Date.now()) { startupUpdateGeneration++; updateNotice.clear(); }
    updater?.setFolder(updateLocation(next));
    for (const error of await ssh.applyGlobalLogging(previous, next)) send({ type: 'log-error', ...error });
    return next;
  });
  handle('settings:layout', input => store.saveSettings({ layout: input }).layout);
  handle('dialog:update-directory', async () => { const chosen = await dialog.showOpenDialog(window, { title:'업데이트 폴더 선택', properties:['openDirectory'] }); return chosen.canceled ? null : chosen.filePaths[0]; });
  handle('update:status', () => updater.status());
  handle('update:open-website', () => shell.openExternal('https://sessiondock.norahc.com/'), { mainFrame: true });
  handle('update:notice', () => updateNotice.peek());
  handle('update:respond', input => updateNotice.respond(input));
  handle('update:result', async () => {
    const result = await updateResults.read();
    if (updateRestartReceipt && result?.receiptToken !== updateRestartReceipt.token) return null;
    return result;
  });
  handle('update:restart-pending', () => !!updateRestartReceipt);
  handle('update:result-ack', id => updateResults.ack(id));
  handle('update:check', async () => { if (!updater.status().busy) { startupUpdateGeneration++; updateNotice.clear(); } const epoch=rendererEpoch; const result=await updater.check(updateLocation(store.getSettings())); if(!ownerIsCurrent(epoch)){updater.invalidate();throw staleOwnerError();} return result; });
  const updateProgressIds = new Set();
  handle('update:prepare', async (expected, opId) => {
    const epoch=rendererEpoch, generation=updater.generation;
    if (opId !== undefined && (typeof opId !== 'string' || !/^[0-9a-f-]{36}$/.test(opId) || updateProgressIds.has(opId) || updateProgressIds.size >= 4096)) throw new Error('업데이트 작업 식별자가 올바르지 않습니다.');
    const status=updater.status();
    if ((!expected && status.folder === null) || (expected && (expected.generation!==generation || expected.name!==status.candidate?.name || expected.version!==status.candidate?.version))) throw new Error('업데이트가 변경되었습니다. 다시 확인해 주세요.');
    if (opId) updateProgressIds.add(opId);
    let active = true, sequence = 0, lastProgress = '';
    try {
      const result=await updater.prepare(progress => {
        const key = JSON.stringify([progress.phase,progress.completed,progress.total,progress.unit]);
        if (active && opId && key !== lastProgress && generation === updater.generation && ownerIsCurrent(epoch)) { lastProgress = key; sendDirect({...progress, opId, sequence:++sequence}); }
      });
      if(!ownerIsCurrent(epoch)){updater.invalidate();throw staleOwnerError();}
      return result;
    } finally { active = false; }
  });
  handle('update:install', async () => {
    if (!app.isPackaged) throw new Error('설치된 앱에서만 업데이트할 수 있습니다.');
    if (updater.status().busy) throw new Error('업데이트 작업이 진행 중입니다.');
    if (!updater.prepared) throw new Error('업데이트가 준비되지 않았습니다.');
    const epoch=rendererEpoch, generation=updater.generation, prepared=updater.prepared;
    updater.confirming = true;
    let confirmed;
    try { confirmed = await dialog.showMessageBox(window, {type:'question',title:'업데이트 후 다시 시작',message:'열린 연결과 작업을 종료하고 업데이트하시겠습니까?',buttons:['나중에','업데이트 후 다시 시작'],defaultId:0,cancelId:0}); }
    finally { updater.confirming = false; }
    if (confirmed.response !== 1 || quitting || !ownerIsCurrent(epoch)) return false;
    if (generation !== updater.generation || prepared !== updater.prepared) throw new Error('업데이트가 변경되었습니다. 다시 확인해 주세요.');
    const runner=await updater.install({profileArg:requestedUserData ? '--user-data-dir='+path.resolve(requestedUserData) : '', theme:store.getSettings().theme});
    if (quitting || !ownerIsCurrent(epoch)) { await runner.cancel(); throw staleOwnerError(); }
    try { runner.assertReady(); } catch(error) { await runner.cancel(); throw error; }
    updateShutdown=true;
    const result=await shutdownServices();
    if(quitting || result.timedOut || result.failed) {
      await runner.cancel();
      throw new Error('종료 정리가 실패하여 업데이트를 취소했습니다. 일부 연결이 종료되었으므로 앱을 종료하고 다시 실행해 주세요.');
    }
    try { await runner.approve(); } catch(error) { await runner.cancel(); throw new Error('업데이트 승인이 실패했습니다. 앱을 종료하고 다시 실행해 주세요.'); }
    if (quitting) return true;
    quitting=true; quitReady=true;
    if(window && !window.isDestroyed()) window.forceClose=true;
    app.quit();
    return true;
  });
  handle('settings:layout-read', () => store.getSettings().layout);
  handle('settings:log-preview', input => { const current=store.getSettings();return logLocation({...current,...input},path.join(app.getPath('userData'),'logs'),{name:'예시 세션 1',host:'192.0.2.10',port:22,username:'example-user',protocol:'ssh'},'preview1').filename; });
  handle('ssh:connect', (id, { cols, rows, handshakeTimeoutMs, sshCompatibility, autoEncoding } = {}) =>
    startOwnedConnect(rendererEpoch, () => ssh.connect(id, { cols, rows, handshakeTimeoutMs, sshCompatibility, autoEncoding })));
  handle('ssh:quick-connect', (input, { cols, rows, handshakeTimeoutMs, sshCompatibility, autoEncoding, passphrase } = {}) =>
    startOwnedConnect(rendererEpoch, () => ssh.connectTemporary(input, { cols, rows, handshakeTimeoutMs, sshCompatibility, autoEncoding, passphrase })));
  handle('ssh:address-connect', async (address, protocol) => {
    // The owner epoch is captured when the request starts, not when it finishes: an
    // auto-connect that is still awaiting its protocol probe when the document is
    // replaced must not create a connection (and a temporary profile) afterwards
    // (V9-M-05).
    const ownerEpoch = rendererEpoch, requestGeneration = ++addressConnectGeneration;
    // Automatic mode classifies the SSH port before the SSH service opens a
    // credential prompt. A refused port, or a peer that answers with a Telnet
    // banner, is redirected to Telnet at once; a timeout or an unreadable
    // answer keeps SSH so a firewall delay never rewrites the user's intent.
    const session = parseConnectionAddress(address, protocol, store.getSettings().quickUsername);
    if (session.protocol === 'ssh' && protocol === 'auto' && session.autoProtocol && !session.explicitScheme) {
      const state = await probePort(session.host, session.port);
      // Re-checked after every await: the probe can take up to 2s, which is longer
      // than a reload.
      if (!ownerIsCurrent(ownerEpoch)) throw staleOwnerError();
      if (requestGeneration !== addressConnectGeneration) return null;
      if (state === 'refused' || state === 'telnet') {
        const { to } = telnetFallbackPorts(session.port);
        const confirmed = await dialog.showMessageBox(window, { type:'warning', title:'Telnet 연결 확인', message:`${session.host}:${to}에 Telnet으로 연결하시겠습니까?`, detail:'Telnet은 암호화되지 않으며 로그인 정보가 노출될 수 있습니다.', buttons:['취소','Telnet 연결'], defaultId:0, cancelId:0 });
        if (confirmed.response !== 1 || quitting || !ownerIsCurrent(ownerEpoch) || requestGeneration !== addressConnectGeneration) return null;
        const telnet = parseConnectionAddress(`telnet://${session.host.includes(':') ? `[${session.host}]` : session.host}:${to}`, 'telnet');
        return startOwnedConnect(ownerEpoch, () => ({ ...ssh.connectTemporary({ ...telnet, fallbackFromPort: session.port }), autoFallback: { from: session.port, to, protocol: 'ssh', reason: state } }));
      }
    }
    return startOwnedConnect(ownerEpoch, () => ssh.connectTemporary(session));
  });
  handle('ssh:release-temporary', id => ssh.releaseTemporary(id));
  handle('ssh:disconnect', async id => { await ssh.disconnect(id); await terminalOutput?.drain(id); });
  handle('ssh:disconnect-and-wait-closed', async id => {
    if (typeof id !== 'string' || ownerEpochOf(id) !== rendererEpoch) return false;
    const closed = await ssh.disconnectAndWaitClosed(id, { timeoutMs: 2000 });
    await terminalOutput?.drain(id);
    return closed === true && ownerEpochOf(id) === rendererEpoch;
  }, { mainFrame: true });
  ipcMain.on('terminal:ack', (event, id, sequence) => { try{authorized(event);}catch{return;} if (typeof id === 'string' && id.length <= 128 && Number.isSafeInteger(sequence) && sequence > 0) terminalOutput?.acknowledge(id, sequence); });
  handle('terminal:stats', () => terminalOutput ? { ...terminalOutput.snapshot(), channels: terminalOutput.channels.size } : { mode:'legacy' });
  // Authorized input is the only signal that lets the next output chunk skip the
  // coalescing window once, so a key echo is instant while a flood stays batched.
  // The hint is taken *before* the write so the echo cannot arrive first, and it
  // never inspects the bytes: it is not a prompt/password heuristic.
  handle('ssh:input', (id, data) => {
    if (typeof data !== 'string' || data.length > 1024 * 1024) throw new Error('입력이 너무 큽니다.');
    try { terminalOutput?.noteInput(id, { bytes: data.length }); } catch { /* a hint must not block input */ }
    return ssh.input(id, data);
  });
  handle('ssh:command-input', (id, data) => {
    if (typeof id !== 'string' || ownerEpochOf(id) !== rendererEpoch ||
        typeof data !== 'string' || data.length > 1024 * 1024 || updateShutdown || quitting) {
      return { status: 'not-sent', retryable: false };
    }
    return ssh.commandInput(id, data, () => {
      try { terminalOutput?.noteInput(id, { bytes: data.length }); } catch { /* a hint must not block input */ }
    });
  }, { mainFrame: true });
  handle('ssh:resize', (id, cols, rows) => ssh.resize(id, cols, rows));
  handle('ssh:logging', (id, enabled) => ssh.setLogging(id, !!enabled));
  handle('ssh:info', id => ssh.getConnectionInfo(id));
  const rejectOversizedReply = Symbol('rejectOversizedReply');
  const replyToPrompt = (id, answer) => {
    const request = requests.get(id);
    if (!request || request.ownerWebContents !== window.webContents || request.replyEpoch !== rendererEpoch || Date.now() >= request.deadline) return false;
    if (request.epoch === BATCH_REQUEST_OWNER) {
      if (!batch?.job?.active || batch.job.cancelled || !batch.connections?.has(request.connectionId)) return false;
    } else if (!ownerIsCurrent(request.epoch) || ownerEpochOf(request.connectionId) !== request.epoch ||
        !ssh?.listConnections().some(item => item.id === request.connectionId && ['connecting','connected'].includes(item.status))) return false;
    const rejectInvalid = () => {
      const error = new Error('인증 응답이 올바르지 않습니다.'); error.code = 'AUTH_REQUIRED';
      requests.delete(id); clearTimeout(request.timer);
      window.webContents.send('app:event', { type: 'prompt-expired', requestId: id });
      request.reject(error);
      return false;
    };
    if (answer === rejectOversizedReply) {
      if (request.kind === 'credentials') return rejectInvalid();
      throw new Error('요청이 너무 큽니다.');
    }
    if (request.kind === 'credentials') {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return rejectInvalid();
      if (answer.cancelled === true) {
        if (Object.keys(answer).some(key => !['cancelled','accept'].includes(key)) || (answer.accept !== undefined && answer.accept !== false)) return rejectInvalid();
      } else {
        if (Object.keys(answer).some(key => !request.fields.includes(key)) || request.fields.some(field =>
          typeof answer[field] !== 'string' || answer[field].length > (field === 'username' ? 256 : 16384) ||
          (field === 'username' && (!answer[field].trim() || /[\x00-\x1f\x7f]/.test(answer[field]))))) return rejectInvalid();
      }
    }
    requests.delete(id); clearTimeout(request.timer); request.resolve(answer); return true;
  };
  handle('ssh:reply', replyToPrompt, { mainFrame: true, oversize: id => replyToPrompt(id, rejectOversizedReply) });
  handle('files:list', (id, remotePath) => ssh.listDirectory(id, remotePath));
  handle('files:create-directory', (id, parent, name) => ssh.createDirectory(id, parent, name));
  handle('files:rename', (id, remotePath, newName, expected) => ssh.renameRemote(id, remotePath, newName, expected));
  handle('files:remove', (id, remotePath, expectedType) => ssh.removeRemote(id, remotePath, expectedType));
  handle('files:properties', (id, remotePath) => ssh.remoteProperties(id, remotePath));
  handle('files:cancel-transfer', (id, transferId) => ssh.cancelTransfer(id, transferId));
  handle('files:download', async (id, remotePath) => {
    const chosen = await dialog.showSaveDialog(window, { title: '파일 다운로드', defaultPath: path.posix.basename(remotePath) });
    if (chosen.canceled) return null;
    const destination = await checkOutputPath(chosen.filePath);
    try { await ssh.download(id, remotePath, destination); }
    catch (error) { if (error.code === 'TRANSFER_CANCELLED') return null; throw error; }
    return { path: destination };
  });
  handle('files:upload', async (id, remoteDirectory) => {
    const chosen = await dialog.showOpenDialog(window, { title: '업로드할 파일 선택', properties: ['openFile', 'multiSelections'] });
    if (chosen.canceled) return null;
    const existing = await ssh.listDirectory(id, remoteDirectory);
    const existingNames = new Set(existing.entries.map(entry => entry.name));
    const notifySkipped = name => dialog.showMessageBox(window, {
      type: 'info', title: '업로드 건너뛰기',
      message: `원격에 “${name}” 파일이 있어 업로드하지 않았습니다. 기존 파일은 그대로입니다.`,
      detail: '다른 이름으로 저장하려면 로컬 파일의 이름을 변경한 뒤 다시 업로드해 주세요.',
      buttons: ['건너뛰기'],
    });
    let count = 0;
    for (const localPath of chosen.filePaths) {
      const name = path.basename(localPath);
      if (existingNames.has(name)) { await notifySkipped(name); continue; }
      try {
        await ssh.upload(id, localPath, path.posix.join(existing.path, name));
        existingNames.add(name);
        count++;
      } catch (error) {
        if (error.code === 'TRANSFER_CANCELLED') return { count, cancelled: true };
        if (error.code !== 'UPLOAD_DESTINATION_EXISTS') throw error;
        existingNames.add(name);
        await notifySkipped(name);
      }
    }
    return { count };
  });
  handle('dialog:key', async () => {
    const chosen = await dialog.showOpenDialog(window, { title: 'SSH 개인키 선택', properties: ['openFile'], filters: [{ name: '모든 파일', extensions: ['*'] }] });
    return chosen.canceled ? null : chosen.filePaths[0];
  });
  handle('dialog:log-directory', async () => { const chosen=await dialog.showOpenDialog(window,{title:'로그 저장 폴더 선택',defaultPath:store.getSettings().logDirectory||path.join(app.getPath('userData'),'logs'),properties:['openDirectory','createDirectory']});return chosen.canceled?null:chosen.filePaths[0]; });
  handle('app:show-data', () => shell.openPath(app.getPath('userData')));
  handle('app:create-shortcut', async () => {
    // The renderer supplies no target, ID or path: main resolves launch identity
    // so a compromised renderer cannot point a shortcut at another executable.
    const result = writeDesktopShortcut({ shell, app, fs, path });
    return result.success ? result : { success: false, error: result.error };
  });
  handle('app:show-logs', async () => { const directory=store.getSettings().logDirectory||path.join(app.getPath('userData'),'logs');await fs.promises.mkdir(directory,{recursive:true});return shell.openPath(directory); });
  handle('clipboard:read', async () => (await clipboard.readText()).slice(0, 1024 * 1024));
  handle('clipboard:write', (text, options) => {
    validateClipboardOptions(options);
    const epoch = rendererEpoch, ownerWindow = window;
    return clipboardWriter.write(text, { isCurrent: () => !quitting && !updateShutdown && ownerIsCurrent(epoch) && !!ownerWindow && window === ownerWindow && !ownerWindow.isDestroyed() && !ownerWindow.webContents.isDestroyed() });
  });
  handle('window:state', windowState);
  handle('window:action', action => { if (action === 'minimize') window.minimize(); else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize(); else if (action === 'close') window.close(); });
}
function createWindow() {
  // This terminal app already disables spellcheck per window. Disable it on the
  // session too, so Chromium does not download unused dictionaries on first run.
  electronSession.defaultSession.setSpellCheckerEnabled(false);
  const geometry = geometryForDisplay(displayAtCursor(screen));
  runtimeTransparent = Number(store.getSettings().terminalTransparency) > 0;
  const surface = runtimeTransparent
    ? { transparent: true, backgroundColor: '#00000000' }
    : { transparent: false, backgroundColor: '#1d2024' };
  window = new BrowserWindow({ ...geometry, ...surface, title: 'SessionDock', icon: path.join(__dirname, '..', 'assets', 'icon.png'), autoHideMenuBar: true, show: false, frame: false, thickFrame: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  // The caption fallback exists only for the transparent Electron window whose
  // forced thickFrame:false loses native double-click handling. Opaque frameless
  // windows retain the normal Windows hit-testing path and must not be intercepted.
  if (runtimeTransparent) installWindowCaption(window);
  installWindowGeometry(window, screen);
  if (process.platform === 'win32' && typeof window.setAppDetails === 'function') {
    const launch = resolveLaunchSpec({
      platform: process.platform,
      isPackaged: app.isPackaged,
      portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
      execPath: process.execPath
    });
    if (launch.supported) {
      try {
        // relaunchCommand and relaunchDisplayName must be set together so the
        // running window's pin relaunches the original portable, not the
        // temporary extraction directory.
        window.setAppDetails({
          appId: launch.appId,
          appIconPath: launch.icon,
          appIconIndex: launch.iconIndex,
          relaunchCommand: launch.relaunchCommand,
          relaunchDisplayName: launch.displayName
        });
      } catch (error) {
        console.error('Failed to set app details:', error);
      }
    } else if (!app.isPackaged) {
      // Expected in development: no product shortcut target exists, and writing
      // window relaunch details would point a pin at electron.exe.
      console.warn('Skipping app details:', launch.error);
    } else {
      console.error('Failed to set app details:', launch.error);
    }
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== pageUrl) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // A top-level renderer navigation replaces the document that owned every
  // interactive connection. The epoch is bumped here, at the START of the load, so
  // work that is still awaiting (an auto-probe, an authentication reply, a log open)
  // is fenced before it can create a socket. Ids are also snapshotted, which covers a
  // connection whose owner stamp was never recorded (V9-M-05).
  window.webContents.on('did-start-navigation', details => {
    const isMainFrame = details?.isMainFrame !== false;
    if (!isMainFrame || details?.isSameDocument) return;
    orphanCandidates = new Set((ssh?.listConnections?.() || []).map(connection => connection.id));
    rendererEpoch++;
  });
  window.webContents.on('did-finish-load', () => {
    // The new page starts with no tabs, so it cannot adopt the previous page's
    // sockets. Retire them and drop the display backlog that can never be rendered.
    // The epoch gate above already stopped new work; this is the teardown. Retirement
    // is filtered by owner epoch, so a connection the reloaded document has already
    // opened is never touched.
    const retired = retireRendererPage('reload');
    if (retired.length) console.warn(`Renderer reloaded: retired ${retired.length} orphaned connection(s).`);
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
    // A failed load leaves the old page's sockets behind while the epoch has already
    // been bumped: nothing can adopt or answer them, so the same retirement has to run
    // without waiting for a `did-finish-load` that will never arrive (V9-M-05).
    if (isMainFrame === false || errorCode === -3 /* ERR_ABORTED: a newer load superseded this one */) return;
    if (url && url !== pageUrl) return;
    const retired = retireRendererPage('navigation-failure');
    if (retired.length) console.warn(`Renderer load failed (${errorDescription}): retired ${retired.length} connection(s).`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    // A crashed renderer leaves the same orphans; the next page cannot adopt them.
    orphanCandidates = new Set((ssh?.listConnections?.() || []).map(connection => connection.id));
    rendererEpoch++;
    const retired = retireRendererPage('crash');
    if (retired.length) console.warn(`Renderer gone (${details?.reason || 'crashed'}): retired ${retired.length} connection(s).`);
  });
  for (const name of ['maximize', 'unmaximize', 'restore', 'focus', 'blur']) window.on(name, () => sendDirect({ type: 'window-state', ...windowState() }));
  window.once('ready-to-show', () => { window.show(); updateRestartReceipt?.shown(); });
  window.on('close', event => {
    const connections = ssh.listConnections().filter(c => ['connected', 'connecting'].includes(c.status));
    const batchRunning=batch?.summary()?.active;
    if ((connections.length||batchRunning) && store.getSettings().confirmAppExit && !window.forceClose) {
      event.preventDefault();
      if (window.closePrompt) return;
      const target = window; target.closePrompt = true;
      dialog.showMessageBox(target, { type: 'question', title: 'SessionDock 종료', message: `${batchRunning?'실행 중인 일괄 작업을 취소하고 ':''}${connections.length}개의 연결을 종료한 뒤 앱을 닫으시겠습니까?`, buttons: ['돌아가기', '연결 종료 후 닫기'], defaultId: 0, cancelId: 0 }).then(answer => { if (answer.response === 1 && !target.isDestroyed()) { target.forceClose = true; target.close(); } }).finally(() => { target.closePrompt = false; });
    }
  });
  window.on('closed', () => { screenReader?.close();terminalOutput?.close(); if (!quitting) void updater?.close(); shutdownServices(); for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('앱이 종료되었습니다.')); } requests.clear(); window = null; });
  window.loadURL(pageUrl);
}
app.whenReady().then(() => {
  if (!primaryInstance) return;
  protocol.handle(APP_SCHEME, createAppProtocol(path.join(__dirname, '..')));
  const root = app.getPath('userData');
  logLossJournal = new LogLossJournal(root);
  updateResults = createUpdateResults(root);
  if (app.isPackaged) {
    const installDir = path.dirname(process.execPath);
    const receiptRoot = app.commandLine.getSwitchValue('sessiondock-update-root');
    const receiptToken = app.commandLine.getSwitchValue('sessiondock-update-token');
    if (receiptRoot && receiptToken) updateRestartReceipt = createRestartReceipt({ root: receiptRoot, token: receiptToken, installDir, userDataDir: root, version: app.getVersion() });
    retryCleanup({ installDir, userDataDir: root });
  }
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  store = new SessionStore(root, {
    encrypt: text => { if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 자격 증명 암호화를 사용할 수 없습니다. 개인키 암호 저장 옵션을 해제해 주세요.'); return safeStorage.encryptString(text).toString('base64'); },
    decrypt: text => { if (!safeStorage.isEncryptionAvailable()) throw new Error('저장된 자격 증명을 복호화할 수 없습니다.'); return safeStorage.decryptString(Buffer.from(text, 'base64')); }
  });
  updater = new UpdateService({pythonExecutable:app.isPackaged?path.join(process.resourcesPath,'python-runtime','python.exe'):path.join(__dirname,'../assets/python-runtime/python.exe'),helperPath:app.isPackaged?path.join(process.resourcesPath,'automation','update_helper.py'):path.join(__dirname,'../assets/automation/update_helper.py'),currentVersion:app.getVersion(),installDir:path.dirname(process.execPath),userDataDir:root});
  updater.setFolder(updateLocation(store.getSettings()));
  shared = new SharedSessions({root});
  sharedStartup = createSharedStartup({ initialize: () => shared.initialize(), onChanged: () => sendDirect({type:'shared-sessions-changed'}), onNotice: () => sendDirect({type:'shared-startup-notice'}) });
  ssh = new ConnectionService({ lookupSession: lookupSessionForConnection, resolveTemporaryCredential: (profile, id) => store.resolveSessionWithCredential(profile, id), emit: send, ask, knownHosts: { get: key => store.getKnownHost(key), set: (key, fingerprint, expected) => store.trustKnownHost(key, fingerprint, expected) }, logDirectory: path.join(root, 'logs'), getLogSettings:()=>store.getSettings(), binaryOutput: !legacyOutput, receiveSource:source=>terminalOutput?.attachReceiveSource(source.id,source) });
  screenReader=new AutomationScreenReader({synchronize:(id,options)=>terminalOutput?.synchronize(id,options),isConnected:id=>!!window&&!window.isDestroyed()&&ssh.getConnectionInfo(id).status==='connected',send:sendDirect});
  automation=new AutomationService({readScreen:(...args)=>screenReader.read(...args),getConnectionInfo:id=>ssh.getConnectionInfo(id),input:(id,text,options)=>options?.disconnect?ssh.disconnect(id):ssh.input(id,text),emit:sendDirect,logDirectory:path.join(root,'logs'),pythonExecutable:app.isPackaged?path.join(process.resourcesPath,'python-runtime','python.exe'):path.join(__dirname,'../assets/python-runtime/python.exe'),bridgePath:app.isPackaged?path.join(process.resourcesPath,'automation','python_bridge.py'):path.join(__dirname,'../assets/automation/python_bridge.py')});
  batch=new BatchService({
    // New keys are accepted unattended for the duration of one job only; the
    // batch writes them to its own ephemeral map, never to the interactive
    // known-hosts store. A *changed* key is a spoofing signal and always needs
    // an operator decision, so it is not auto-accepted here.
    autoTrustHostKey:true,
    autoTrustChangedHostKey:false,
    knownHosts:{get:key=>store.getKnownHost(key)},
    resolveCredential:(profile,id)=>store.resolveSessionWithCredential(profile,id),
    emit:sendDirect,
    ask,
    onDisconnect:expireBatchPrompts
  });
  if(!legacyOutput)terminalOutput = new TerminalOutput({
    send:sendDirect,
    // Addon pressure is independent of receive high/low-water channel control.
    onReceivePressure:pressure=>sendDirect({type:'receive-pressure',id:pressure.id,paused:pressure.paused,reason:pressure.reason}),
    onPressure:pressure=>{
      if(!window||window.isDestroyed())return;
      window.webContents.send('app:event',{type:'output-pressure',id:pressure.id,burst:pressure.burst,soft:pressure.soft,queuedBytes:pressure.queuedBytes,inFlightBytes:pressure.inFlightBytes});
    },
    // Bounded memory: only an explicit, one-shot backlog decision ends a session.
    // The normal disconnect path still produces the final status; this only
    // records the cause so the UI can name it instead of blaming the network.
    onOverflow:overflow=>{
      const notify=(message,code)=>sendDirect({type:'overflow',id:overflow.id,code,message});
      try{
        if(overflow.reason==='consumer-gone'){
          notify('화면 프로세스가 출력을 받을 수 없어 연결을 종료했습니다.','CONSUMER_GONE');
          ssh?.disconnect(overflow.id,{...overflow,code:'CONSUMER_GONE'});
          return;
        }
        notify('출력 처리 대기 한도를 초과했습니다. 연결을 안전하게 종료했습니다.','OUTPUT_BACKLOG_LIMIT');
        // The connection is still live here: this is an intentional close, never
        // a silent reconnect or chunk drop.
        ssh?.disconnect(overflow.id,{...overflow,code:'OUTPUT_BACKLOG_LIMIT'});
      }catch{}
    }
  });
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  require('./lib/session-table-ipc.cjs').registerTableImport({handle,dialog,getWindow:()=>window,store,protectedFiles:protectedOutputFiles,owner:()=>rendererEpoch});
  require('./lib/folder-shared-export-ipc.cjs').registerFolderSharedExport({handle,dialog,getWindow:()=>window,store,protectedFiles:()=>[...protectedOutputFiles(),...shared.listSources().map(source=>source.path)],owner:()=>rendererEpoch,isShuttingDown:()=>updateShutdown||quitting});
  installHandlers(); createWindow();
  sharedStartup.start();
  updateNotice = createUpdateNotice({ getSettings:()=>store.getSettings(), saveSettings:input=>store.saveSettings(input), getStatus:()=>updater.status(), getGeneration:()=>updater.generation, onNotice:()=>sendDirect({type:'update-notice'}) });
  if(store.getSettings().updateCheckOnStartup) {
    const folder=updateLocation(store.getSettings()), startupGeneration=startupUpdateGeneration;
    if (folder !== '') updater.check(folder).then(result=>{if(startupGeneration===startupUpdateGeneration)updateNotice.publish(result.candidate,folder,result.generation);}).catch(()=>{});
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => { dialog.showErrorBox('SessionDock 시작 실패', error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) { if (!quitReady) event.preventDefault(); return; }
  event.preventDefault(); quitting = true;
  let serviceResult;
  const shutdown = createServiceShutdown([async () => { serviceResult = await shutdownServices(); }, () => updater?.close()]);
  shutdown().then(result => {
    if (result.timedOut || serviceResult?.timedOut) { console.error('SessionDock 종료 정리가 제한 시간을 초과했습니다. 미완료 파일 작업이 있을 수 있습니다.'); app.exit(1); }
    else { quitReady = true; app.quit(); }
  });
});
