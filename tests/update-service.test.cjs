'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { UpdateService, compareVersions, runWorker } = require('../src/lib/update-service.cjs');
const { SessionStore } = require('../src/lib/session-store.cjs');
const { writeArchiveManifest } = require('./unsigned-release-fixture.cjs');

test('numeric version comparison uses arbitrary precision', () => {
  assert.equal(compareVersions('0.1.40', '0.1.4'), 1);
  assert.equal(compareVersions('900719925474099300000.0.0', '900719925474099299999.0.0'), 1);
  assert.throws(() => compareVersions('0.01.4', '0.1.3'));
});

test('product scan and stage receive installation for interrupted transaction detection', async t => {
  const installDir = path.resolve('isolated-install'), calls = [];
  const service = new UpdateService({ currentVersion:'0.1.3', installDir,
    worker:async (_p,_h,command,input) => {
      calls.push({command,input});
      return command === 'scan' ? {candidate:{name:'SessionDock.zip',version:'0.1.4'}}
        : {version:'0.1.4',stageDir:input.stageDir};
    }});
  t.after(() => service.close());
  await service.check(os.tmpdir()); await service.prepare();
  assert.equal(calls[0].input.installDir, installDir);
  assert.equal(calls[1].input.installDir, installDir);
});

test('duplicate checks and stale responses cannot publish an update', async () => {
  let finish;
  const worker = () => new Promise(resolve => { finish = resolve; });
  const service = new UpdateService({ currentVersion: '0.1.3', worker });
  const first = path.resolve('updates-a'), second = path.resolve('updates-b');
  const pending = service.check(first);
  await assert.rejects(service.check(first), /진행 중/);
  service.setFolder(second);
  finish({ folder: first, candidate: { name: 'SessionDock-0.1.4.zip', version: '0.1.4' } });
  await assert.rejects(pending, /변경/);
  assert.equal(service.status().candidate, null);
  await assert.rejects(service.install(), /준비되지/);
});

test('worker candidate must match exact name and a higher version', async () => {
  const worker = async () => ({ candidate: { name: 'SessionDock-Admin.zip', version: '0.1.4' } });
  const service = new UpdateService({ currentVersion: '0.1.3', worker });
  await assert.rejects(service.check(path.resolve('updates')), /올바르지/);
});

test('settings use empty path and startup checking by default, validate and persist', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  assert.equal(store.getSettings().updateDirectory, '');
  assert.equal(store.getSettings().updateCheckOnStartup, true);
  assert.throws(() => store.saveSettings({updateDirectory:'relative'}), /절대 경로/);
  assert.throws(() => store.saveSettings({updateCheckOnStartup:'yes'}));
  store.saveSettings({updateDirectory:path.join(dir,'updates'),updateCheckOnStartup:false});
  assert.equal(new SessionStore(dir).getSettings().updateCheckOnStartup,false);
  assert.equal(new SessionStore(dir).getSettings().updateDirectory,path.join(dir,'updates'));
});

test('changing the folder during preparation discards the staged result', async () => {
  let resolveStage;
  const worker = async (_python, _helper, command, input) => command === 'scan'
    ? {candidate:{name:'SessionDock-0.1.4.zip',version:'0.1.4'}}
    : await new Promise(resolve => { resolveStage=() => resolve({version:'0.1.4',stageDir:input.stageDir}); });
  const service = new UpdateService({currentVersion:'0.1.3',worker});
  const first=path.join(os.tmpdir(),'updates-a'), second=path.join(os.tmpdir(),'updates-b');
  await service.check(first);
  const preparing=service.prepare();
  while (!resolveStage) await new Promise(resolve=>setImmediate(resolve));
  service.setFolder(second); resolveStage();
  await assert.rejects(preparing,/변경/);
  assert.equal(service.status().prepared,false);
  assert.equal(service.status().candidate,null);
});

test('isolated worker exchanges UTF-8 Korean paths and errors', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'업데이트-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=path.resolve('tests/updater_helper.py');
  const made=require('node:child_process').spawnSync(path.resolve('assets/python-runtime/python.exe'),['-B','-c',"import importlib.util,sys;s=importlib.util.spec_from_file_location('fixture',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.make_zip(sys.argv[2])",fixture,path.join(root,'SessionDock.zip')],{encoding:'utf8',windowsHide:true});
  assert.equal(made.status,0,made.stderr);
  const python=path.resolve('assets/python-runtime/python.exe');
  const automation=path.join(root,'automation'); fs.mkdirSync(automation);

  const helper=path.join(automation,'update_helper.py');
  fs.copyFileSync(path.resolve('assets/automation/update_helper.py'),helper);
  writeArchiveManifest(path.join(root,'SessionDock.zip'),'0.1.4');
  const result=await runWorker(python,helper,'scan',{folder:root,currentVersion:'0.1.3'});
  assert.equal(result.folder,root);
  assert.equal(result.candidate.version,'0.1.4');
  assert.equal(result.candidate.name,'SessionDock.zip');
  await assert.rejects(runWorker(python,helper,'stage',{folder:root,name:'other.zip',stageDir:path.join(root,'stage')}),/Release requires SessionDock.zip/);
});

test('worker timeout terminates a blocking child', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'updater-timeout-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const script=path.join(root,'blocked.py');
  fs.writeFileSync(script,'import time\ntime.sleep(30)\n');
  const start=Date.now();
  await assert.rejects(runWorker(path.resolve('assets/python-runtime/python.exe'),script,'scan',{},200),/시간이 초과/);
  assert(Date.now()-start<5000);
});

test('streamed progress handles split UTF-8, callback errors and one final response', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'updater-stream-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const script=path.join(root,'worker.py'), python=path.resolve('assets/python-runtime/python.exe');
  const progress={type:'stage-progress',phase:'copy',completed:1,total:2,unit:'bytes'};
  const wire=JSON.stringify(progress)+'\n'+JSON.stringify({ok:true,result:'한글'});
  fs.writeFileSync(script,'import sys\nb='+JSON.stringify(wire)+".encode('utf-8')\nfor x in b:\n sys.stdout.buffer.write(bytes([x])); sys.stdout.buffer.flush()\n");
  let count=0;
  assert.equal(await runWorker(python,script,'stage',{},5000,undefined,()=>{count++;throw Error('display');}),'한글');
  assert.equal(count,1);
  for(const body of [JSON.stringify(progress)+'\n', '{broken}\n', JSON.stringify({ok:true,result:1})+'\n'+JSON.stringify({ok:true,result:2})+'\n']) {
    fs.writeFileSync(script,'import sys\nsys.stdout.write('+JSON.stringify(body)+')\n');
    await assert.rejects(runWorker(python,script,'stage',{},5000));
  }
});

test('stale stage callbacks cannot escape after invalidation or operation completion', async () => {
  let callback, complete;
  const worker=async (_p,_h,command,input,_t,_s,onProgress)=> command==='scan' ? {candidate:{name:'SessionDock-0.1.4.zip',version:'0.1.4'}} : await new Promise(resolve=>{callback=onProgress;complete=()=>resolve({version:'0.1.4',stageDir:input.stageDir});});
  const service=new UpdateService({currentVersion:'0.1.3',worker});
  await service.check(path.join(os.tmpdir(),'stage-owner'));
  const received=[]; const pending=service.prepare(e=>received.push(e));
  while(!callback) await new Promise(resolve=>setImmediate(resolve));
  callback({phase:'copy'}); service.invalidate(); callback({phase:'verify'}); complete();
  await assert.rejects(pending,/변경/); callback({phase:'extract'});
  assert.deepEqual(received,[{phase:'copy'}]);
});

test('prepared roots are removed on recheck, reprepare, and folder change', async () => {
  const worker = async (_python, _helper, command, input) => command === 'scan'
    ? {candidate:{name:'SessionDock-0.1.4.zip',version:'0.1.4'}}
    : (fs.mkdirSync(input.stageDir), {version:'0.1.4',stageDir:input.stageDir,files:{}});
  const service = new UpdateService({currentVersion:'0.1.3',worker});
  const first=path.join(os.tmpdir(),'updates-a'), second=path.join(os.tmpdir(),'updates-b');
  await service.check(first); await service.prepare();
  let root=service.preparedRoot;
  await service.prepare(); await service.waitForCleanup(); assert.equal(fs.existsSync(root),false);
  root=service.preparedRoot;
  await service.check(); await service.waitForCleanup(); assert.equal(fs.existsSync(root),false);
  await service.prepare(); root=service.preparedRoot;
  service.setFolder(second); await service.waitForCleanup(); assert.equal(fs.existsSync(root),false);
});

test('install readiness failure and cancellation remove only owned roots after child exit', async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'updater-owner-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=path.join(base,'runtime');fs.mkdirSync(runtime);
  fs.copyFileSync(path.resolve('assets/python-runtime/python.exe'),path.join(runtime,'python.exe'));
  for(const item of fs.readdirSync(path.resolve('assets/python-runtime'))) {
    if(item==='python.exe')continue;
    fs.cpSync(path.resolve('assets/python-runtime',item),path.join(runtime,item),{recursive:true});
  }
  const helper=path.join(base,'helper.py');

  const service=new UpdateService({currentVersion:'0.1.3',pythonExecutable:path.join(runtime,'python.exe'),helperPath:helper,installDir:base,userDataDir:base,
    worker:async(_p,_h,command,input)=>command==='scan'?{candidate:{name:'SessionDock-0.1.4.zip',version:'0.1.4'}}:(fs.mkdirSync(input.stageDir),{version:'0.1.4',stageDir:input.stageDir,files:{}})});
  await service.check(base);await service.prepare();let root=service.preparedRoot;
  fs.writeFileSync(helper,'print("bad", flush=True)\n');
  await assert.rejects(service.install(),/준비되지/);assert.equal(fs.existsSync(root),false);
  await service.prepare();root=service.preparedRoot;
  fs.writeFileSync(helper,'import sys,json,os,time\nplan=json.load(sys.stdin)\nopen(os.path.join(plan["userDataDir"],"theme-test"),"w").write(plan["theme"])\nprint("{\\"ready\\":true}", flush=True)\ntime.sleep(30)\n');
  const runner=await service.install({theme:"light"});
  assert.equal(fs.readFileSync(path.join(base,"theme-test"),"utf8"),"light");
  service.invalidate();
  assert.equal(fs.existsSync(root),true);
  await runner.cancel();
  assert.equal(fs.existsSync(root),false);
  await service.check(base); await service.prepare();
  const fallback=await service.install({theme:'unexpected'});
  assert.equal(fs.readFileSync(path.join(base,'theme-test'),'utf8'),'dark');
  await fallback.cancel();
  assert.equal(fs.existsSync(base),true);
});

test('helper exit after readiness clears held root and permits retry', async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'updater-exit-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=path.join(base,'runtime'); fs.mkdirSync(runtime);
  fs.cpSync(path.resolve('assets/python-runtime'),runtime,{recursive:true});
  const helper=path.join(base,'helper.py');

  fs.writeFileSync(helper,'import time\nprint("{\\"ready\\":true}", flush=True)\ntime.sleep(0.3)\n');
  const service=new UpdateService({currentVersion:'0.1.3',pythonExecutable:path.join(runtime,'python.exe'),helperPath:helper,installDir:base,userDataDir:base,
    worker:async(_p,_h,command,input)=>command==='scan'?{candidate:{name:'SessionDock-0.1.4.zip',version:'0.1.4'}}:(fs.mkdirSync(input.stageDir),{version:'0.1.4',stageDir:input.stageDir,files:{}})});
  await service.check(base); await service.prepare(); const root=service.preparedRoot;
  const runner=await service.install();
  const limit=Date.now()+5000;
  while (service.status().busy && Date.now()<limit) await new Promise(resolve=>setTimeout(resolve,25));
  await service.waitForCleanup();
  assert.equal(service.status().busy,false);
  assert.equal(service.status().prepared,false);
  assert.equal(service.heldRoots.size,0);
  assert.equal(fs.existsSync(root),false);
  assert.throws(()=>runner.assertReady(), /종료/);
  await service.prepare(); assert.equal(service.status().prepared,true);
  service.invalidate(); await service.waitForCleanup();
});

test('close aborts stage, waits for worker completion, and removes only owned roots', async t => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-other-'));
  t.after(() => fs.rmSync(other, {recursive:true,force:true}));
  let finish, signal;
  const service = new UpdateService({currentVersion:'0.1.3', worker:async (_p,_h,command,input,_timeout,s) => {
    if (command === 'scan') return {candidate:{name:'SessionDock-0.1.4.zip',version:'0.1.4'}};
    fs.mkdirSync(input.stageDir); signal = s;
    return await new Promise(resolve => { finish = () => resolve({version:'0.1.4',stageDir:input.stageDir}); });
  }});
  await service.check(other); const stage = service.prepare();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const root = [...service.ownedRoots][0];
  let closed = false; const close = service.close(); assert.equal(service.close(), close); close.then(() => {closed = true;});
  assert.equal(signal.aborted,true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed,false); assert.equal(fs.existsSync(root),true);
  await assert.rejects(service.check(other), /종료/);
  finish(); await assert.rejects(stage, /변경/); await close;
  assert.equal(fs.existsSync(root),false); assert.equal(fs.existsSync(other),true);
  assert.equal(service.status().prepared,false); assert.equal(service.ownedRoots.size,0);
});

test('close removes a prepared root and blocks subsequent work', async () => {
  const service = new UpdateService({currentVersion:'0.1.3',worker:async (_p,_h,command,input) => command === 'scan'
    ? {candidate:{name:'SessionDock-0.1.4.zip',version:'0.1.4'}}
    : (fs.mkdirSync(input.stageDir), {version:'0.1.4',stageDir:input.stageDir})});
  await service.check(os.tmpdir()); await service.prepare(); const root = service.preparedRoot;
  await service.close(); assert.equal(fs.existsSync(root),false);
  await assert.rejects(service.prepare(),/종료/); await assert.rejects(service.install(),/종료/);
});

test('close cancels an unapproved helper and preserves an approved handoff', async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'updater-handoff-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=path.join(base,'runtime'); fs.cpSync(path.resolve('assets/python-runtime'),runtime,{recursive:true});
  const helper=path.join(base,'helper.py');

  fs.writeFileSync(helper, 'import sys,time,json,os\nplan=json.loads(sys.stdin.read())\nprint("{\\"ready\\":true}", flush=True)\nwhile not os.path.exists(plan["approvalPath"]): time.sleep(.02)\nopen(os.path.join(plan["userDataDir"],"approved-marker"),"w").write("ok")\n');
  const make=()=>new UpdateService({currentVersion:'0.1.3',pythonExecutable:path.join(runtime,'python.exe'),helperPath:helper,installDir:base,userDataDir:base,
    worker:async(_p,_h,command,input)=>command==='scan'?{candidate:{name:'SessionDock-0.1.4.zip',version:'0.1.4'}}:(fs.mkdirSync(input.stageDir),{version:'0.1.4',stageDir:input.stageDir,files:{}})});
  const pending=make(); await pending.check(base); await pending.prepare(); const abandoned=pending.preparedRoot;
  const runner=await pending.install(); await pending.close();
  assert.equal(fs.existsSync(abandoned),false); await assert.rejects(runner.approve(),/종료|변경/);
  const approved=make(); await approved.check(base); await approved.prepare(); const retained=approved.preparedRoot;
  const live=await approved.install(); await live.approve(); await approved.close();
  assert.equal(fs.existsSync(retained),true); assert.equal(approved.handoffRoot,retained);
  const marker=path.join(base,'approved-marker'), deadline=Date.now()+5000;
  while (!fs.existsSync(marker) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(fs.existsSync(marker),true);
  await new Promise(resolve=>setTimeout(resolve,100));
  fs.rmSync(retained,{recursive:true,force:true});
});
