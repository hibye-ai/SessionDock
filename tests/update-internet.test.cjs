'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { SessionStore } = require('../src/lib/session-store.cjs');
const { UpdateService, updateLocation, createUpdateNotice, runWorker } = require('../src/lib/update-service.cjs');
const METADATA = 'https://sessiondock.norahc.com/update/latest';
const ZIP = 'https://sessiondock.norahc.com/SessionDock.zip';
const bytes = Buffer.from('owned fixture');
const sha = b => createHash('sha256').update(b).digest('hex');
const offer = (overrides = {}, data = bytes) => ({version:'0.1.8',url:ZIP,size:data.length,sha256:sha(data),...overrides});
const json = value => Buffer.from(JSON.stringify(value));
const response = (data, {statusCode = 200, headers = {}, chunks = [data]} = {}) => Object.assign(Readable.from(chunks), {statusCode, headers});

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-internet-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  return root;
}

test('persisted source migration distinguishes absent, blank, legacy inaccessible and explicit settings', t => {
  const root = profile(t), file = path.join(root,'session-store.json');
  const missing = path.join(root,'nonexistent','updates'), unc = '\\\\offline.invalid\\updates';
  assert.equal(new SessionStore(root).getSettings().updateFromLocalFolder,false);
  new SessionStore(root).saveSettings({theme:'light'});
  const original = JSON.parse(fs.readFileSync(file,'utf8'));
  for (const [settings, local] of [[undefined,false],[{},false],[{updateDirectory:'  ',updateCheckOnStartup:false},false],
    [{updateDirectory:missing,updateCheckOnStartup:false},true],[{updateDirectory:unc},true],
    [{updateDirectory:missing,updateFromLocalFolder:false},false],[{updateFromLocalFolder:true},true]]) {
    fs.writeFileSync(file,JSON.stringify({...original,settings}));
    const loaded = new SessionStore(root).getSettings();
    assert.equal(loaded.updateFromLocalFolder,local);
    assert.equal(loaded.updateCheckOnStartup,settings?.updateCheckOnStartup ?? true);
    assert.equal(updateLocation(loaded),local ? settings.updateDirectory ?? '' : null);
  }
  fs.writeFileSync(file,JSON.stringify({...original,settings:{updateDirectory:missing,updateCheckOnStartup:false}}));
  const store = new SessionStore(root);
  assert.throws(() => store.saveSettings({updateFromLocalFolder:'no'}));
  store.saveSettings({updateFromLocalFolder:false});
  const reopened = new SessionStore(root);
  assert.equal(updateLocation(reopened.getSettings()),null);
  assert.equal(reopened.getSettings().updateDirectory,missing);
  assert.equal(reopened.getSettings().updateCheckOnStartup,false);
  reopened.saveSettings({updateFromLocalFolder:true});
  assert.equal(updateLocation(new SessionStore(root).getSettings()),missing);
});

function fixture(t, reply, options = {}) {
  const installDir = profile(t), urls = [], commands = [];
  const get = (url, opts, respond) => {
    urls.push(url);
    assert.equal(opts.rejectUnauthorized,true);
    assert.equal(opts.agent,false);
    const req = new EventEmitter();
    opts.signal.addEventListener('abort', () => req.emit('error',opts.signal.reason), {once:true});
    queueMicrotask(() => {
      if (opts.signal.aborted) return;
      const value = reply(url, opts);
      if (value instanceof Error) req.emit('error',value);
      else if (value) {
        opts.signal.addEventListener('abort', () => value.destroy(opts.signal.reason), {once:true});
        respond(value);
      }
    });
    return req;
  };
  const service = new UpdateService({currentVersion:'0.1.7',installDir,httpsOptions:{get, ...options.httpsOptions},
    worker:async (_python,_helper,command,input) => {
      commands.push({command,input});
      if (options.worker) return options.worker(command,input);
      if (command === 'pending') return {pending:false};
      if (command === 'scan') return {folder:input.folder,candidate:null};
      assert.equal(command,'stage');
      assert.equal(sha(fs.readFileSync(path.join(input.folder,'SessionDock.zip'))),input.expectedBuildID.slice(7));
      return {version:input.expectedVersion,buildID:input.expectedBuildID,archiveSha256:input.expectedBuildID.slice(7),stageDir:input.stageDir};
    }});
  t.after(() => service.close());
  return {service,urls,commands,installDir};
}

test('offline and same/older versions never fetch ZIP or fall back to a retained folder', async t => {
  let metadata = new Error('ENETUNREACH');
  const { service,urls,commands,installDir } = fixture(t, () => metadata instanceof Error ? metadata : response(json(metadata)));
  const web = updateLocation({updateFromLocalFolder:false,updateDirectory:installDir});
  await assert.rejects(service.check(web),{message:'sessiondock.norahc.com에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.'});
  assert.equal(service.status().candidate,null);
  const knownPublicOffer = offer({version:'0.1.7',size:159313826,sha256:'ac3826dc3c9f8576509ad2b16f96e60df036e373a0713aef6e29527b55f19b68'});
  for (const item of [knownPublicOffer,offer({version:'0.1.6'})]) {
    metadata = item;
    assert.equal((await service.check(web)).candidate,null);
    await assert.rejects(service.prepare(),/먼저 확인/);
  }
  assert.deepEqual(urls,[METADATA,METADATA,METADATA]);
  assert.deepEqual(commands.map(c=>c.command),['pending','pending','pending']);
});

test('explicit local mode stays local on missing path and scan errors, with no network probe', async t => {
  const error = new Error('offline folder');
  const {service,urls,commands,installDir} = fixture(t, () => { throw Error('network forbidden'); }, {worker:() => { throw error; }});
  await assert.rejects(service.check(updateLocation({updateFromLocalFolder:true,updateDirectory:''})),/폴더를 선택/);
  await assert.rejects(service.check(updateLocation({updateFromLocalFolder:true,updateDirectory:installDir})), e => e === error);
  assert.deepEqual(urls,[]);
  assert.deepEqual(commands.map(c=>c.command),['scan']);
});

test('a newer version checks metadata only and prepare feeds verified bytes into the existing stage plan', async t => {
  const {service,urls,commands,installDir} = fixture(t, url => response(url===METADATA ? json(offer()) : bytes));
  const {candidate} = await service.check();
  assert.equal(candidate.version,'0.1.8');
  assert.deepEqual(urls,[METADATA]);
  await assert.rejects(service.install(),/준비되지/);
  const prepared = await service.prepare();
  assert.deepEqual(urls,[METADATA,ZIP]);
  assert.deepEqual(commands.map(c=>c.command),['pending','pending','stage']);
  assert.equal(commands[0].input.localTempDir,undefined);
  assert.equal(commands[1].input.localTempDir,path.resolve(os.tmpdir()));
  const input = commands.at(-1).input;
  assert.equal(input.installDir,installDir);
  assert.equal(input.expectedVersion,'0.1.8');
  assert.equal(input.expectedBuildID,'sha256-'+sha(bytes));
  assert.equal(input.name,'SessionDock.zip');
  assert.equal(prepared.archiveSha256,sha(bytes));
  assert.equal(fs.existsSync(input.folder),false);
  const root=service.preparedRoot;
  service.setFolder(installDir);
  await service.waitForCleanup();
  assert.equal(fs.existsSync(root),false);
  assert.equal(service.status().candidate,null);
});

test('rejects malformed, oversized, non-UTF-8 and inexact-route metadata', async t => {
  let payload;
  const {service,urls} = fixture(t, () => payload);
  for (const body of [Buffer.from('{'),Buffer.from([0xff]),Buffer.alloc(16*1024+1,32),json(null),json([]),
    Buffer.from('{"vers\\u0069on":"0.1.9",'+JSON.stringify(offer()).slice(1)),
    ...[{version:'0.1.08'},{version:'0.1.8\n'},{version:8},{size:0},{size:2**31+1},{size:1.5},{sha256:'x'.repeat(64)},
      {url:'http://sessiondock.norahc.com/SessionDock.zip'},{url:ZIP+'?x=1'},{url:ZIP+'#download'},
      {url:'https://sessiondock.norahc.com:443/SessionDock.zip'},{url:ZIP.replace('/SessionDock','/./SessionDock')},
      {url:'https://sessiondock.norahc.com.evil.invalid/SessionDock.zip'},{url:'https://a@sessiondock.norahc.com/SessionDock.zip'}].map(input => json(offer(input)))]) {
    payload = response(body);
    await assert.rejects(service.check(),/업데이트/);
    assert.equal(service.status().candidate,null);
  }
  payload = response(json(offer()),{statusCode:302,headers:{location:ZIP}});
  await assert.rejects(service.check(),/업데이트/);
  payload = response(json(offer()),{headers:{'content-encoding':'gzip'}});
  await assert.rejects(service.check(),/업데이트/);
  payload = response(json(offer()),{headers:{'content-length':'16385'}});
  await assert.rejects(service.check(),/업데이트/);
  assert.ok(urls.every(url=>url===METADATA));
});

test('rejects redirects, corrupt, truncated and oversized ZIP streams before invoking stage; roots are cleaned', async t => {
  let artifact, ownedRoot;
  const {service,urls,commands} = fixture(t, url => {
    if (url===METADATA) return response(json(offer()));
    ownedRoot=[...service.ownedRoots][0];
    return artifact;
  });
  for (const make of [() => response(bytes,{statusCode:307,headers:{location:ZIP}}),
    () => response(bytes,{headers:{'content-length':String(bytes.length+1)}}),
    () => response(bytes.subarray(1)),() => response(bytes,{chunks:[bytes,Buffer.from('extra')]}),
    () => response(Buffer.alloc(bytes.length)), () => response(bytes,{headers:{'content-encoding':'gzip'}})]) {
    await service.check(); artifact = make();
    await assert.rejects(service.prepare(),/업데이트/);
    assert.equal(service.status().prepared,false);
    assert.equal(service.ownedRoots.size,0);
    assert.ok(ownedRoot);
    assert.equal(fs.existsSync(ownedRoot),false);
  }
  assert.equal(commands.some(c=>c.command==='stage'),false);
  assert.equal(urls.length,12);
});

test('absolute timeout covers headers and body, and source change aborts in-flight download', async t => {
  let state = 'no headers';
  const {service,urls,commands,installDir} = fixture(t, url => {
    if (state === 'no headers') return;
    if (state === 'no body' || url === ZIP) return Object.assign(new Readable({read(){}}),{statusCode:200,headers:{}});
    return response(json(offer()));
  }, {httpsOptions:{metadataTimeoutMs:80,downloadTimeoutMs:3000}});
  await assert.rejects(service.check(),/시간.*초과/);
  state='no body';
  await assert.rejects(service.check(),/시간.*초과/);
  state='download';
  await service.check();
  const pending = service.prepare();
  while (!urls.includes(ZIP)) await new Promise(resolve=>setImmediate(resolve));
  service.setFolder(installDir);
  await assert.rejects(pending,/취소|변경/);
  assert.equal(commands.some(c=>c.command==='stage'),false);
  assert.equal(service.ownedRoots.size,0);
});

test('existing pending guard blocks official checks and downloads without network fallback', async t => {
  let pending = true;
  const {service,urls} = fixture(t, () => response(json(offer())), {worker:command => {
    assert.equal(command,'pending');
    if (pending) throw Error('manual recovery');
    return {pending:false};
  }});
  await assert.rejects(service.check(),/manual recovery/);
  assert.deepEqual(urls,[]);
  pending=false; await service.check(); pending=true;
  await assert.rejects(service.prepare(),/manual recovery/);
  assert.deepEqual(urls,[METADATA]);
});

test('TLS and HTTP failures use fixed status text', async t => {
  let payload = Object.assign(new Error('fixture detail'), {code:'CERT_HAS_EXPIRED'});
  const {service,urls} = fixture(t,()=>payload);
  await assert.rejects(service.check(),{message:'sessiondock.norahc.com 보안 연결(HTTPS)을 확인할 수 없습니다.'});
  payload=response(bytes,{statusCode:503,headers:{location:ZIP}});
  await assert.rejects(service.check(),{message:'업데이트 서버 응답에 실패했습니다. (HTTP 503)'});
  assert.deepEqual(urls,[METADATA,METADATA]);
});

test('startup and manual main paths use the saved location; notices track the active source', async t => {
  const root=profile(t), store=new SessionStore(root), folder=path.join(root,'not-accessible');
  const main=fs.readFileSync(path.resolve('src/main.cjs'),'utf8');
  const startup=main.slice(main.indexOf('  if(store.getSettings().updateCheckOnStartup'),main.indexOf("  app.on('activate'"));
  const manual=main.split('\n').find(line=>line.includes("handle('update:check',"));
  assert.ok(startup && manual);
  const {service:updater,urls,commands}=fixture(t,()=>response(json(offer())));
  const notice=createUpdateNotice({getSettings:()=>store.getSettings(), saveSettings:value=>store.saveSettings(value),getStatus:()=>updater.status(),getGeneration:()=>updater.generation});
  const context=vm.createContext({store,updater,updateLocation,updateNotice:notice,startupUpdateGeneration:0,rendererEpoch:1,ownerIsCurrent:()=>true,handle:(_key,fn)=>{context.manual=fn;}});
  vm.runInContext(manual,context);
  updater.setFolder(updateLocation(store.getSettings()));
  vm.runInContext(startup,context);
  await Promise.all([...updater.operations]);
  assert.equal(notice.peek().version,'0.1.8');
  store.saveSettings({updateDirectory:folder,updateFromLocalFolder:true});
  assert.equal(notice.peek(),null);
  await context.manual();
  assert.equal(commands.at(-1).input.folder,folder);
  store.saveSettings({updateFromLocalFolder:false,updateCheckOnStartup:false});
  updater.setFolder(updateLocation(store.getSettings()));
  vm.runInContext(startup,context);
  assert.equal(updater.operations.size,0);
  await context.manual();
  assert.deepEqual(urls,[METADATA,METADATA]);
});

test('main settings save toggles source without normalizing an unchanged legacy folder', async t => {
  const root=profile(t), file=path.join(root,'session-store.json'), folder=path.join(root,'not-accessible');
  const initial=new SessionStore(root);
  initial.saveSettings({theme:'light'});
  const document=JSON.parse(fs.readFileSync(file,'utf8'));
  document.settings={updateDirectory:folder,updateCheckOnStartup:false};
  fs.writeFileSync(file,JSON.stringify(document));
  const store=new SessionStore(root);
  const {service:updater,urls}=fixture(t,()=>{ throw Error('settings save cannot request HTTPS'); });
  updater.setFolder(updateLocation(store.getSettings()));
  assert.equal(updater.status().folder,folder);
  const main=fs.readFileSync(path.resolve('src/main.cjs'),'utf8');
  const start=main.indexOf("  handle('settings:save',");
  const end=main.indexOf("  handle('settings:layout',",start);
  let save, cleared=0;
  vm.runInNewContext(main.slice(start,end),{store,updater,updateLocation,rendererEpoch:1,settingsSaveGeneration:0,startupUpdateGeneration:0,updateShutdown:false,quitting:false,ownerIsCurrent:()=>true,updateNotice:{clear:()=>cleared++},ssh:{applyGlobalLogging:async()=>[]},runWorker(){assert.fail('unchanged legacy folder must not be normalized');},handle:(_key,fn)=>{save=fn;}});
  const off={updateFromLocalFolder:false};
  updater.installPending=true;
  await assert.rejects(save(off),{message:'업데이트 설치 준비를 먼저 취소해 주세요.'});
  assert.equal(updater.status().folder,folder);
  updater.installPending=false;
  await save(off);
  assert.equal(updater.status().folder,null);
  assert.equal(cleared,1);
  const reopened=new SessionStore(root).getSettings();
  assert.equal(reopened.updateFromLocalFolder,false);
  assert.equal(reopened.updateDirectory,folder);
  assert.equal(reopened.updateCheckOnStartup,false);
  await save({updateFromLocalFolder:true});
  assert.equal(updater.status().folder,folder);
  assert.deepEqual(urls,[]);
});

test('main prepare requires the current official offer before any artifact request', async t => {
  const {service:updater,urls}=fixture(t,url=>response(url===METADATA ? json(offer()) : bytes));
  const {candidate,generation}=await updater.check();
  const main=fs.readFileSync(path.resolve('src/main.cjs'),'utf8');
  const start=main.indexOf('  const updateProgressIds = new Set();');
  const end=main.indexOf("  handle('update:install',",start);
  let prepare;
  vm.runInNewContext(main.slice(start,end),{updater,rendererEpoch:1,ownerIsCurrent:()=>true,handle:(_key,fn)=>{prepare=fn;}});
  await assert.rejects(prepare(),/다시 확인/);
  await assert.rejects(prepare({name:candidate.name,version:candidate.version,generation:generation-1}),/다시 확인/);
  assert.deepEqual(urls,[METADATA]);
  await prepare({name:candidate.name,version:candidate.version,generation});
  assert.deepEqual(urls,[METADATA,ZIP]);
  assert.equal(updater.status().prepared,true);
});

test('real bundled helper stages a ZIP-only fixture and rejects a different embedded version despite matching HTTP hash', async t => {
  const root = profile(t), archive = path.join(root,'SessionDock.zip');
  const python = path.resolve('assets/python-runtime/python.exe'), helper = path.resolve('assets/automation/update_helper.py');
  const made = spawnSync(python,['-B','-c',"import importlib.util,sys;s=importlib.util.spec_from_file_location('fixture',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.make_zip(sys.argv[2], '0.1.8')",path.resolve('tests/updater_helper.py'),archive],{encoding:'utf8',windowsHide:true});
  assert.equal(made.status,0,made.stderr);
  const zip=fs.readFileSync(archive);
  let version='0.1.8';
  const {service,commands} = fixture(t,url=>response(url===METADATA ? json(offer({version},zip)) : zip),{worker:(command,input)=>runWorker(python,helper,command,input)});
  await service.check();
  assert.equal((await service.prepare()).archiveSha256,sha(zip));
  assert.equal(fs.existsSync(path.join(service.preparedRoot,'stage','archive.zip')),true);
  assert.equal(fs.existsSync(commands.at(-1).input.folder),false);
  version='0.1.9';
  await service.check();
  await assert.rejects(service.prepare(),{message:'다운로드한 업데이트 파일을 검증하지 못했습니다.'});
  assert.equal(service.status().prepared,false);
  assert.equal(service.ownedRoots.size,0);
});

test('bundled local scanner distinguishes an absent folder from a folder with no update', async t => {
  const root = profile(t);
  const service = new UpdateService({currentVersion:'0.1.7',installDir:root,
    pythonExecutable:path.resolve('assets/python-runtime/python.exe'),helperPath:path.resolve('assets/automation/update_helper.py'),
    httpsOptions:{get(){assert.fail('local check must not request HTTPS');}}});
  t.after(()=>service.close());
  assert.equal((await service.check(root)).candidate,null);
  await assert.rejects(service.check(path.join(root,'absent')),{message:'업데이트 폴더에 접근할 수 없습니다. 경로와 연결 상태를 확인해 주세요.'});
});

test('bundled pending checker rejects a UNC temp target before any write or lookup on the share', async t => {
  const installDir = profile(t);
  const python = path.resolve('assets/python-runtime/python.exe'), helper = path.resolve('assets/automation/update_helper.py');
  await assert.rejects(runWorker(python,helper,'pending',{installDir,localTempDir:'\\\\offline.invalid\\updates'}),
    {message:'업데이트 파일을 다운로드하지 못했습니다. 다시 시도해 주세요.'});
});
