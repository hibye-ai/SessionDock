'use strict';
const { SshService } = require('./ssh-service.cjs');
const { TelnetService } = require('./telnet-service.cjs');
const { sanitizeSession } = require('./session-store.cjs');
const { LogBudget } = require('./terminal-log-queue.cjs');
const { randomUUID } = require('node:crypto');

// Bounded memory of connections whose transport close was already confirmed, so a
// duplicate/late close-wait is answered by the same service instead of guessing.
const TRANSPORT_TOMBSTONES = 256;

class ConnectionService {
  constructor(options){
    this.temporarySessions=new Map();
    // Profiles whose renderer document was retired. Retained only while a connection
    // still resolves them (its own teardown reads lookupSession); excluded from the
    // quick-connect admission ceiling so reloads cannot exhaust it (V9-M-05).
    this.retiredTemporary=new Set();
    // connection id -> owning protocol service, kept after the connection leaves
    // the service maps so a late close-wait reaches the service that owns the
    // socket (see disconnectAndWaitClosed).
    this.routes=new Map();
    // connection id -> service, for connections already confirmed closed. A
    // second close-wait for the same id must not fall through to `owner()`'s SSH
    // guess: the retained close record lives in the service that owned the socket.
    this.closedRoutes=new Map();
    this.lookupSession=id=>this.temporarySessions.get(id)||options.lookupSession(id);
    const routed={...options,lookupSession:id=>{
      const profile=this.lookupSession(id);
      return this.temporarySessions.has(id)&&profile?.protocol==='ssh'&&profile.credentialId&&options.resolveTemporaryCredential
        ?options.resolveTemporaryCredential(profile,profile.credentialId):profile;
    }};
    // One log-byte reservation for both protocol services: `globalBytes` must
    // bound the process, not each queue separately (V6-H-02).
    const logBudget=options.logBudget instanceof LogBudget?options.logBudget:new LogBudget(options.logBudgetBytes);
    const budgeted={...routed,logBudget};
    this.ssh=new SshService(budgeted);this.telnet=new TelnetService(budgeted);
  }
  connectTemporary(input,options={}){
    this._pruneRetiredTemporary();
    // Only profiles a live document can still reach count toward the ceiling: a
    // retired profile that is merely retained for its closing connection must not
    // make the next quick connect fail (V9-M-05).
    let admitted=0;
    for(const id of this.temporarySessions.keys())if(!this.retiredTemporary.has(id))admitted++;
    if(admitted>=128)throw new Error('임시 세션은 최대 128개까지 열 수 있습니다.');
    const sanitized=sanitizeSession({...input,rememberPassphrase:false});
    // The address bar's detection metadata is deliberately outside the session
    // whitelist; keep it so the renderer can retry SSH-refused devices over Telnet.
    const detected=input?.autoProtocol===true?{
      autoProtocol:true,
      rawAddress:typeof input.rawAddress==='string'?input.rawAddress.slice(0,1024):undefined,
      ...(Number.isInteger(input.fallbackFromPort)?{fallbackFromProtocol:'ssh',fallbackFromPort:input.fallbackFromPort}:{})
    }:{};
    const profile={...sanitized,...detected,id:`temporary_${randomUUID()}`,temporary:true,hasPassphrase:false};
    if(profile.jumpSessionId)throw new Error('빠른 연결의 점프 서버는 저장된 세션 설정을 사용해 주세요.');
    this.temporarySessions.set(profile.id,profile);
    try{return {...this.connect(profile.id,profile.credentialId?{...options,passphrase:undefined}:options),session:{...profile}};}
    catch(error){this.temporarySessions.delete(profile.id);throw error;}
  }
  releaseTemporary(id){
    if(this.listConnections().some(connection=>connection.sessionId===id))throw new Error('임시 세션의 연결을 먼저 종료해 주세요.');
    return this.temporarySessions.delete(id);
  }
  // Retirement path for a renderer page that is gone (V9-M-05).
  //
  // The page that created the profile can no longer call releaseTemporary, so the main
  // process must. Two constraints shape this:
  //
  //   * The profile must stay resolvable while any connection still references it,
  //     because a timed-out close keeps calling lookupSession through its own teardown.
  //   * The 128-profile admission ceiling must still be reachable: a reload must not
  //     be able to exhaust it, so a retired profile is excluded from that count even
  //     while it is retained for its connection.
  //
  // Returns an outcome instead of throwing, because the caller is a cleanup path.
  releaseTemporaryForRetiredOwner(id){
    if(typeof id!=='string'||!id.startsWith('temporary_'))return false;
    if(!this.temporarySessions.has(id))return {released:false,reason:'unknown-profile'};
    this.retiredTemporary.add(id);
    const active=this.listConnections().find(connection=>connection.sessionId===id);
    if(active)return {released:true,retainedFor:active.id};
    this.retiredTemporary.delete(id);
    this.temporarySessions.delete(id);
    return {released:true};
  }
  // Drops retirement marks whose connection is gone, so the retained profile can no
  // longer be looked up by a late transport callback.
  _pruneRetiredTemporary(){
    if(!this.retiredTemporary.size)return;
    const live=new Set(this.listConnections().map(connection=>connection.sessionId));
    for(const id of this.retiredTemporary){
      if(live.has(id))continue;
      this.retiredTemporary.delete(id);
      this.temporarySessions.delete(id);
    }
  }
  get connections(){return new Map([...this.ssh.connections,...this.telnet.connections]);}
  connect(id,options){const session=this.lookupSession(id);if(!session)throw new Error('세션을 찾을 수 없습니다.');const service=session.protocol==='telnet'?this.telnet:this.ssh;
    // Sessions may extend the SSH/Telnet handshake for slow devices. An explicit
    // per-call timeout (used by tests and batch runs) still takes precedence.
    const timeout=session.handshakeTimeout?session.handshakeTimeout*1000:undefined;
    const result=service.connect(id,timeout&&options?.handshakeTimeoutMs===undefined?{...options,handshakeTimeoutMs:timeout}:options);
    // Remember the owning service for the connection's whole lifetime. Once a
    // Telnet connection is finished it leaves `telnet.connections`, and the
    // `owner()` fallback would then route a late close-wait to the SSH service,
    // which never tracked that socket. The route is what makes a late
    // `disconnectAndWaitClosed` observe the truth instead of guessing.
    if(result&&typeof result.id==='string'){this.routes.set(result.id,service);if(this.routes.size>256)this._pruneRoutes();}
    return result;}
  // A route is dropped only when its socket record is gone as well: a finished
  // Telnet connection still needs the route for its bounded close-wait.
  _pruneRoutes(){for(const [id,service] of this.routes){if(service.connections.has(id)||service.receiving.has(id)||service.transportCloses?.has(id))continue;this.routes.delete(id);}}
  owner(id){const routed=this.routes.get(id);if(routed&&(routed.connections.has(id)||routed.receiving.has(id)||routed.transportCloses?.has(id)))return routed;if(this.telnet.connections.has(id)||this.telnet.receiving.has(id))return this.telnet;return this.ssh;}
  // Owner for a close-wait: the live route first, then the tombstone of an already
  // confirmed close, then the protocol guess.
  ownerForCloseWait(id){
    const routed=this.routes.get(id)||this.closedRoutes.get(id);
    if(routed&&(routed.connections.has(id)||routed.receiving.has(id)||routed.transportCloses?.has(id)))return routed;
    return this.owner(id);
  }
  // Hands out the owning transport's close promise so a caller that outlives the
  // transport's close-record retention (the batch endpoint quarantine) can still
  // observe the truth after the record is pruned (V7-M-02).
  waitForClose(id){
    const known=this.routes.get(id)||this.closedRoutes.get(id)||this.owner(id);
    if(!known||typeof known.waitForClose!=='function')return null;
    try{return known.waitForClose(id);}catch{return null;}
  }
  disconnect(id,cause){return this.owner(id).disconnect(id,cause);}
  // Row-local, bounded teardown used by batch runs: waits for this connection's
  // own socket close so the next run starts clean, without blocking the rest of
  // the service.
  async disconnectAndWaitClosed(id,options){
    // A connection already confirmed closed keeps its owner for the same bounded
    // window the service retains the close record, so a duplicate waiter reads the
    // same truth instead of SSH's untracked guess (V6-M-03).
    const known=this.ownerForCloseWait(id);
    const closed=await known.disconnectAndWaitClosed(id,options);
    // Only forget the route once the socket is confirmed gone; a bounded miss
    // keeps it so a later waiter can still ask the same service.
    if(closed){
      // A confirmed close leaves the live route. The owning service still retains
      // its close record for a bounded TTL, so a *duplicate or late* waiter (a row
      // that reached its finally block twice, or after its own bound expired) must
      // still be answered by that transport instead of falling through to the SSH
      // service, which never tracked this socket (V6-M-03). The tombstone is only
      // an id -> owner lookup for close-waits; it grants no input/resize routing.
      this.routes.delete(id);
      this.closedRoutes.set(id,known);
      if(this.closedRoutes.size>TRANSPORT_TOMBSTONES)this.closedRoutes.delete(this.closedRoutes.keys().next().value);
    }
    return closed;
  }
  input(id,data){return this.owner(id).input(id,data);}
  resize(id,cols,rows){
    const known=this.routes.get(id)||this.closedRoutes.get(id);
    // A unique connection id identifies one attempt. Its renderer can issue a
    // queued resize after the service removed that attempt but before the final
    // status reaches the UI. Only consume valid resizes for an actual, tracked
    // teardown; never hide a live resize failure or an unknown id/invalid size.
    const valid=[cols,rows].every(n=>Number.isInteger(n)&&n>=1&&n<=4096);
    if(valid&&known&&!known.connections.has(id)&&
       (known.receiving.has(id)||known.finishing?.has(id)||known.transportCloses?.has(id)||this.closedRoutes.get(id)===known))return;
    return this.owner(id).resize(id,cols,rows);
  }
  setOutputPaused(id,paused){return this.owner(id).setOutputPaused(id,paused);}
  setLogging(id,enabled,source){return this.owner(id).setLogging(id,enabled,source);}
  async applyGlobalLogging(previous,next){
    if(previous.logEnabled===next.logEnabled)return [];
    // Disable must also queue behind an opening global log. Its source is not
    // assigned until open completes; checking logSource here loses that intent.
    const targets=[...this.connections.values()].filter(connection=>connection.status==='connected'||!next.logEnabled&&(connection.logStream||connection.logOperations));
    const results=await Promise.allSettled(targets.map(connection=>this.setLogging(connection.id,next.logEnabled,'global')));
    return results.flatMap((result,index)=>result.status==='rejected'?[{id:targets[index].id,message:result.reason.message}]:[]);
  }
  getConnectionInfo(id){return this.owner(id).getConnectionInfo(id);}
  sshOnly(id){if(this.telnet.connections.has(id))throw new Error('SFTP는 SSH 세션에서만 사용할 수 있습니다.');return this.ssh;}
  listDirectory(id,path){return this.sshOnly(id).listDirectory(id,path);}
  createDirectory(id,parent,name){return this.sshOnly(id).createDirectory(id,parent,name);}
  renameRemote(id,path,newName,expected){return this.sshOnly(id).renameRemote(id,path,newName,expected);}
  removeRemote(id,path,expectedType){return this.sshOnly(id).removeRemote(id,path,expectedType);}
  remoteProperties(id,path){return this.sshOnly(id).remoteProperties(id,path);}
  cancelTransfer(id,transferId){return this.sshOnly(id).cancelTransfer(id,transferId);}
  upload(id,local,remote,options){return this.sshOnly(id).upload(id,local,remote,options);}
  download(id,remote,local){return this.sshOnly(id).download(id,remote,local);}
  listConnections(){return [...this.ssh.listConnections(),...this.telnet.listConnections()];}
  async close(){await Promise.all([this.ssh.close(),this.telnet.close()]);this.temporarySessions.clear();}
}
module.exports={ConnectionService};
