'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {TelnetCodec,TelnetService}=require('../src/lib/telnet-service.cjs');
const {SessionStore}=require('../src/lib/session-store.cjs');
const {ConnectionService}=require('../src/lib/connection-service.cjs');

function codec(options={}){const writes=[],data=[];const instance=new TelnetCodec({write:b=>writes.push(b),data:b=>data.push(b),...options});return {instance,writes,data};}
function eventually(fn){return new Promise((resolve,reject)=>{const started=Date.now(),timer=setInterval(()=>{try{if(fn()){clearInterval(timer);resolve();}else if(Date.now()-started>5000){clearInterval(timer);reject(new Error('Timed out'));}}catch(e){clearInterval(timer);reject(e);}},10);});}
test('Telnet parser handles every-byte fragmentation, IAC escaping, NVT CR NUL and terminal type',()=>{
  const {instance,writes,data}=codec({terminalType:'vt100'});
  const packet=Buffer.from([65,13,0,66,255,255,255,253,24,255,250,24,1,255,240,67]);
  for(const b of packet)instance.feed(Buffer.from([b]));
  assert.deepEqual(Buffer.concat(data),Buffer.from([65,13,66,255,67]));
  assert(writes.some(b=>b.equals(Buffer.from([255,251,24]))));
  assert(writes.some(b=>b.equals(Buffer.concat([Buffer.from([255,250,24,0]),Buffer.from('vt100'),Buffer.from([255,240])]))));
});
test('option acknowledgments do not loop; unknown options are refused and NAWS escapes 255',()=>{
  const {instance,writes}=codec({cols:255,rows:24});instance.begin();writes.length=0;
  instance.feed(Buffer.from([255,253,31,255,253,31,255,251,1,255,251,1,255,253,99,255,251,100]));
  assert.deepEqual(writes.map(b=>[...b]),[[255,250,31,0,255,255,0,24,255,240],[255,252,99],[255,254,100]]);
  writes.length=0;instance.feed(Buffer.from([255,254,31]));instance.resize(80,24);assert.equal(writes.length,1);assert.deepEqual([...writes[0]],[255,252,31]);
});
test('Telnet Enter mapping and binary receive mode preserve terminal bytes',()=>{
  const {instance,data}=codec({enter:'crlf'});assert.equal(instance.encode('show\rnext\nlast\r\n').toString(),'show\r\nnext\r\nlast\r\n');
  const other=codec({enter:'cr'}).instance;assert.equal(other.encode('\r').toString(),'\r\0');
  other.feed(Buffer.from([255,253,0]));assert.equal(other.encode('\r').toString(),'\r');
  instance.feed(Buffer.from([255,251,0,13,0]));assert.deepEqual(Buffer.concat(data),Buffer.from([13,0]));
});
test('oversized subnegotiation is rejected with bounded parser memory',()=>{
  const {instance}=codec();assert.throws(()=>instance.feed(Buffer.concat([Buffer.from([255,250,24]),Buffer.alloc(4097,65)])),/size limit/);
});

test('legacy Telnet negotiation, binary transitions and escaped subnegotiations survive 128 TCP fragmentation patterns',()=>{
  const wire=Buffer.from([
    65,13,0,66,255,251,0,13,0,255,252,0,13,0,255,255,
    255,253,24,255,250,24,1,255,240,
    255,250,200,88,255,255,89,255,240,
    255,253,31,255,253,0,255,254,0,67,
  ]);
  const reference=codec({cols:255,rows:255,terminalType:'vt100'});reference.instance.begin();reference.instance.feed(wire);
  assert.deepEqual(Buffer.concat(reference.data),Buffer.from([65,13,66,13,0,13,255,67]));
  assert(reference.writes.some(b=>b.equals(Buffer.from([255,250,31,0,255,255,0,255,255,255,240]))));
  assert(reference.writes.some(b=>b.includes(Buffer.from('vt100'))));
  assert.equal(reference.instance.encode('\r').toString(),'\r\0');
  let seed=0x13579bdf;
  for(let trial=0;trial<128;trial++){
    const current=codec({cols:255,rows:255,terminalType:'vt100'});current.instance.begin();
    for(let offset=0;offset<wire.length;){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;const length=1+(seed>>>0)%17;current.instance.feed(wire.subarray(offset,offset+length));offset+=length;}
    assert.deepEqual(Buffer.concat(current.data),Buffer.concat(reference.data));
    assert.deepEqual(Buffer.concat(current.writes),Buffer.concat(reference.writes));
    assert.equal(current.instance.encode('\r').toString(),'\r\0');
  }
});
test('Telnet sessions survive reload, default to port 23 and cannot be SSH jump targets',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'telnet-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new SessionStore(root);
  const s=store.saveSession({name:'Switch',protocol:'telnet',host:'switch.test',localEcho:true,telnetEnter:'cr'});assert.equal(s.port,23);assert.equal(new SessionStore(root).listSessions()[0].protocol,'telnet');
  assert.throws(()=>store.saveSession({name:'SSH',host:'ssh.test',jumpSessionId:s.id}),/SSH session/);
  assert.throws(()=>store.saveSession({name:'Switch2',protocol:'telnet',host:'s.test',jumpSessionId:s.id}),/Telnet 세션에서는 SSH 점프 세션이나 포워딩을 사용할 수 없습니다/);
  assert.throws(()=>store.saveSession({name:'Unknown',protocol:'http',host:'s.test'}),/protocol/);
});
test('real TCP Telnet exchanges commands, negotiates terminal size, logs clean data and closes',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'telnet-loopback-'));const received=[];const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.write(Buffer.from([255,251,1,255,253,31]));socket.write('Switch> ');socket.on('data',b=>{received.push(b);if(b.includes(Buffer.from('show version')))socket.write('\r\nSwitchOS 1.0\r\nSwitch> ');});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const events=[];const session={name:'Switch',protocol:'telnet',host:'127.0.0.1',port:server.address().port,terminalType:'vt100',logEnabled:true};
  const service=new ConnectionService({lookupSession:()=>session,emit:e=>events.push(e),ask:async()=>{throw new Error('Telnet must not request SSH authentication');},knownHosts:{get:()=>undefined,set:()=>{}},logDirectory:root});
  t.after(async()=>{await service.close();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const {id}=service.connect('switch',{cols:100,rows:30});await eventually(()=>events.some(e=>e.type==='status'&&e.status==='connected'));service.resize(id,120,40);service.input(id,'show version\r');
  await eventually(()=>events.filter(e=>e.type==='data').map(e=>Buffer.from(e.data,'base64').toString()).join('').includes('SwitchOS'));
  assert(Buffer.concat(received).includes(Buffer.from('show version\r\0')));assert(Buffer.concat(received).includes(Buffer.from([255,250,31,0,120,0,40,255,240])));assert.equal(service.getConnectionInfo(id).protocol,'telnet');assert.throws(()=>service.listDirectory(id,'.'),/SFTP/);
  await service.setLogging(id,false);const logs=fs.readdirSync(root).filter(f=>f.endsWith('.log'));assert.equal(logs.length,1);assert.match(fs.readFileSync(path.join(root,logs[0]),'utf8'),/SwitchOS/);assert(!fs.readFileSync(path.join(root,logs[0])).includes(Buffer.from([255,253,31])));
  service.disconnect(id);await eventually(()=>service.listConnections().length===0);assert(events.some(e=>e.status==='disconnected'));
});
test('connection refusal emits sanitized failure and cancellation clears connections',async()=>{
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));const events=[];
  const service=new TelnetService({lookupSession:()=>({host:'127.0.0.1',port,protocol:'telnet'}),emit:e=>events.push(e),logDirectory:os.tmpdir()});
  service.connect('missing');await eventually(()=>events.some(e=>e.status==='error'));assert.equal(service.listConnections().length,0);await service.close();
});
