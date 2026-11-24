'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { SshService } = require('../src/lib/ssh-service.cjs');
const { createFixture } = require('./ssh-fixture.cjs');
const root = path.resolve('test-artifacts', `integration-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
const events = [], asks = [], hosts = new Map();
const wait = async predicate => { const until = Date.now() + 20000; while (Date.now() < until) { const value = predicate(); if(value)return value; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Integration condition timed out: ' + JSON.stringify(events.filter(e => e.type === 'status'))); };
async function main() {
  const fixture = await createFixture(path.join(root, 'remote'));
  const sessions = new Map(); sessions.set('direct', { id: 'direct', name:'Local integration', host: fixture.host, port:fixture.port, username:'tester', authType:'password', password:'fixture-only-password', keepaliveInterval:30, forwards:[] });
  const service = new SshService({ lookupSession: id => sessions.get(id), emit: event => events.push(event), ask: async prompt => { asks.push(prompt); return prompt.kind==='host-key'?{accept:true,remember:true}:{password:'fixture-only-password'}; }, knownHosts: { get:key=>hosts.get(key),set:(key,value)=>hosts.set(key,value) }, logDirectory:path.join(root,'logs') });
  const echoServer = net.createServer(socket=>socket.pipe(socket)); await new Promise(resolve=>echoServer.listen(0,'127.0.0.1',resolve));
  try {
    const direct = service.connect('direct'); await wait(()=>events.find(e=>e.id===direct.id&&e.status==='connected'));
    service.resize(direct.id,120,40); service.input(direct.id,'echo 통합검증완료\r');
    await wait(()=>events.some(e=>e.id===direct.id&&e.type==='data'&&Buffer.from(e.data,'base64').toString().includes('통합검증완료')));
    await wait(()=>fixture.metrics.windowChanges.length); assert.equal(fixture.metrics.windowChanges.at(-1).cols,120);
    const directory = await service.listDirectory(direct.id,'.'); assert.equal(directory.path,'/home/tester'); assert(directory.entries.some(e=>e.name==='welcome.txt'));
    const downloaded = path.join(root,'downloaded.txt'); await service.download(direct.id,'/home/tester/welcome.txt',downloaded); assert(fs.readFileSync(downloaded,'utf8').includes('한글 파일 전송'));
    const uploaded = path.join(root,'upload.bin'); const payload = Buffer.alloc(250000,0x53);fs.writeFileSync(uploaded,payload);await service.upload(direct.id,uploaded,'/home/tester/upload.bin');assert.deepEqual(fs.readFileSync(path.join(root,'remote','upload.bin')),payload);
    const protectedLocal=path.join(root,'existing.txt');fs.writeFileSync(protectedLocal,'KEEP_LOCAL_ORIGINAL');await assert.rejects(service.download(direct.id,'/home/tester/denied.txt',protectedLocal));assert.equal(fs.readFileSync(protectedLocal,'utf8'),'KEEP_LOCAL_ORIGINAL');
    await assert.rejects(service.upload(direct.id,uploaded,'/home/tester/protected.txt'));assert.equal(fs.readFileSync(path.join(root,'remote','protected.txt'),'utf8'),'KEEP_REMOTE_ORIGINAL');assert(!fs.readdirSync(path.join(root,'remote')).some(name=>name.endsWith('.part')));
    const log = await service.setLogging(direct.id,true);service.input(direct.id,'echo LOG_VERIFIED\r');await wait(()=>events.some(e=>e.type==='data'&&Buffer.from(e.data,'base64').toString().includes('LOG_VERIFIED')));await service.setLogging(direct.id,false);assert(fs.readFileSync(log.path,'utf8').includes('LOG_VERIFIED'));
    sessions.set('jump',{...sessions.get('direct'),id:'jump',name:'Jump connection',jumpSessionId:'direct'});const jump=service.connect('jump');await wait(()=>events.find(e=>e.id===jump.id&&e.status==='connected'));assert.equal(asks.filter(p=>p.kind==='host-key').length,1);
    assert.deepEqual(asks.filter(p=>p.kind==='credentials'&&p.connectionId===jump.id).map(p=>p.session.name),['Local integration','Jump connection']);
    sessions.set('forward',{...sessions.get('direct'),id:'forward',name:'Forward connection',forwards:[{bindHost:'127.0.0.1',bindPort:0,destHost:'127.0.0.1',destPort:echoServer.address().port}]});const forward=service.connect('forward');await wait(()=>events.find(e=>e.id===forward.id&&e.status==='connected'));const rule=service.getConnectionInfo(forward.id).forwards[0];
    await new Promise((resolve,reject)=>{const socket=net.connect(rule.bindPort,'127.0.0.1');socket.on('error',reject);socket.on('connect',()=>socket.write('FORWARD_OK'));socket.on('data',data=>{assert.equal(data.toString(),'FORWARD_OK');socket.destroy();resolve();});});
    service.disconnect(direct.id);await wait(()=>events.find(e=>e.id===direct.id&&e.status==='disconnected'));assert.throws(()=>service.input(direct.id,'x'),/SSH에 연결되어 있지 않습니다/);
    const report={passed:true,checks:['password authentication','host-key trust and reuse','SSH UTF-8 terminal I/O','PTY resize','SFTP list/home/download/upload','failed transfers preserve existing local/remote files','session log','SSH jump host','loopback local port forwarding','disconnect cleanup'],hostKeyPrompts:asks.filter(p=>p.kind==='host-key').length,transferredBytes:payload.length};fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {
    // Cleanup must be bounded. `echoServer.close()` only calls back once every
    // accepted socket is gone, and a Windows loopback FIN from the forwarded pipe
    // is sometimes never delivered (the same host behaviour documented in
    // tests/ssh-service.test.cjs), which left this script alive after the report
    // had already been printed. Date.now() based so it cannot itself hang.
    await service.close().catch(() => {});
    await fixture.close().catch(() => {});
    await Promise.race([
      new Promise(resolve => echoServer.close(() => resolve())),
      new Promise(resolve => { const timer = setTimeout(resolve, 2000); timer.unref?.(); }),
    ]);
    if (typeof echoServer.closeAllConnections === 'function') echoServer.closeAllConnections();
  }
}
main().then(() => { process.exit(0); }).catch(error=>{console.error(error);process.exit(1);});
