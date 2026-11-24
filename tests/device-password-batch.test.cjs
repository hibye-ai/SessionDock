'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { BatchService } = require('../src/lib/batch-service.cjs');
const { batchFixture } = require('../scripts/batch-fixture.cjs');
const wait = async fn => { const end=Date.now()+5000; while(!fn()){assert(Date.now()<end,'bounded fixture wait');await new Promise(r=>setTimeout(r,15));} };

test('one batch group asks separately for each SSH target and retry; Telnet login and enable are separate live challenges', async t => {
  const a=await batchFixture({password:'synthetic-A'});
  const b=await batchFixture({password:'synthetic-B'});
  const c=await batchFixture({protocol:'telnet',password:'synthetic-C',privilegePassword:'synthetic-enable'});
  const fixtures=[a,b,c], observed=[];
  t.after(async()=>{for(const f of fixtures)await f.close();});
  const service=new BatchService({autoTrustHostKey:true,resolveCredential:()=>({username:a.username,authType:'password',password:'synthetic-legacy'}),ask:p=>{
    assert.equal(p.kind,'credentials');
    const peer=fixtures.find(x=>x.port===p.session.port);
    assert(peer);assert.equal(p.session.host,'127.0.0.1');
    observed.push({id:p.connectionId,port:p.session.port,purpose:p.purpose});
    return {password:p.purpose==='enable'?peer.privilegePassword:peer.password};
  }});
  t.after(()=>service.close());
  const input={concurrency:2,groups:[
    {name:'SSH',credentialId:'synthetic-reference',targets:`127.0.0.1:${a.port}\n127.0.0.1:${b.port}`,commands:'echo CHECK',quietMs:100,password:'synthetic-stale'},
    {name:'Telnet',protocol:'telnet',username:c.username,targets:`127.0.0.1:${c.port}`,commands:'echo CHECK',useEnable:true,quietMs:100,password:'synthetic-stale',enablePassword:'synthetic-stale'},
  ]};
  for(let i=0;i<2;i++){
    service.start(service.preview(input).token);
    await wait(()=>!service.summary().active);
    assert.equal(service.summary().counts.success,3);
    const rows=service.exportRows({jobId:service.summary().id});
    assert.equal(rows.every(x=>x.teardown.closed),true);
    for(const f of fixtures)assert.equal(JSON.stringify(rows).includes(f.password),false);
  }
  for(const f of [a,b])assert.deepEqual(f.metrics.commands,['echo CHECK','echo CHECK']);
  assert.deepEqual(c.metrics.commands,['enable','echo CHECK','enable','echo CHECK']);
  assert.equal(new Set(observed.map(p=>p.id)).size,6);
  for(const f of [a,b])assert.equal(observed.filter(p=>p.port===f.port).length,2);
  assert.deepEqual(observed.filter(p=>p.port===c.port).map(p=>p.purpose),['telnet-login','enable','telnet-login','enable']);
});

test('a changed Telnet device challenge blocks a late password and all commands',async t=>{
  let socket, writes='';
  const server=net.createServer(s=>{socket=s;s.on('data',x=>writes+=x);s.on('error',()=>{});s.write('Password: ');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{socket?.destroy();await new Promise(r=>server.close(r));});
  let answer;
  const service=new BatchService({ask:()=>new Promise(r=>{answer=r;})});t.after(()=>service.close());
  service.start(service.preview({groups:[{name:'Synthetic',protocol:'telnet',targets:'127.0.0.1',port:server.address().port,commands:'MUST_NOT_WRITE'}]}).token);
  await wait(()=>answer);
  socket.write('\r\nsynthetic-device# ');
  await wait(()=>service.job.rows[0].received.includes('synthetic-device#'));
  answer({password:'synthetic-must-not-write'});
  await wait(()=>!service.summary().active);
  assert.equal(service.exportRows({jobId:service.summary().id})[0].failureCode,'CREDENTIAL_CHALLENGE');
  assert.doesNotMatch(writes,/synthetic-must-not-write|MUST_NOT_WRITE/);
});
