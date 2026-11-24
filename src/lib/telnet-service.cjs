'use strict';

const net = require('node:net');
const { SshService } = require('./ssh-service.cjs');
const { TerminalEncoding,AutomaticTerminalEncoding, encodeTerminalInput, normalizeTerminalEncoding } = require('./terminal-encoding.cjs');
const IAC=255, DO=253, DONT=254, WILL=251, WONT=252, SB=250, SE=240;
const BINARY=0, ECHO=1, SGA=3, TTYPE=24, NAWS=31;

function escapeIac(bytes) {
  const out=[]; for(const byte of bytes) {out.push(byte);if(byte===IAC)out.push(IAC);}return Buffer.from(out);
}

// Streaming RFC 854 parser: control sequences can span any TCP packet boundary.
// RFC 1073 NAWS and RFC 1091 TTYPE share the same escaped subnegotiation framing.
class TelnetCodec {
  constructor({ write, data, cols=80, rows=24, terminalType='xterm-256color', enter='cr', encoding='utf-8' }) {
    Object.assign(this,{write,data,cols,rows,terminalType,enter});
    this.encoding=normalizeTerminalEncoding(encoding);
    this.local=new Set();this.remote=new Set();this.localPending=new Set();this.remotePending=new Set();
    this.phase='data';this.sub=[];this.lastCr=false;
  }
  command(verb,option){this.write(Buffer.from([IAC,verb,option]));}
  // Like PuTTY, offer terminal/echo options initially and accept BINARY when
  // requested by the peer. Do not force a legacy server to change data mode.
  begin(){for(const option of [SGA,TTYPE,NAWS]){this.localPending.add(option);this.command(WILL,option);}for(const option of [SGA,ECHO]){this.remotePending.add(option);this.command(DO,option);}}
  negotiate(verb,option) {
    if(verb===DO){
      if(![BINARY,SGA,TTYPE,NAWS].includes(option)){this.command(WONT,option);return;}
      if(this.local.has(option))return;
      this.local.add(option);if(!this.localPending.delete(option))this.command(WILL,option);
      if(option===NAWS)this.resize(this.cols,this.rows);
    }else if(verb===DONT){const enabled=this.local.delete(option),pending=this.localPending.delete(option);if(option===NAWS){this.sentCols=this.sentRows=undefined;}if(enabled&&!pending)this.command(WONT,option);}
    else if(verb===WILL){
      if(![BINARY,ECHO,SGA].includes(option)){this.command(DONT,option);return;}
      if(this.remote.has(option))return;
      this.remote.add(option);if(!this.remotePending.delete(option))this.command(DO,option);
    }else if(verb===WONT){const enabled=this.remote.delete(option),pending=this.remotePending.delete(option);if(enabled&&!pending)this.command(DONT,option);}
  }
  subnegotiation(){if(this.sub[0]===TTYPE&&this.sub[1]===1&&this.local.has(TTYPE))this.write(Buffer.concat([Buffer.from([IAC,SB,TTYPE,0]),escapeIac(Buffer.from(this.terminalType,'ascii')),Buffer.from([IAC,SE])]));}
  feed(bytes){
    const output=[];const emit=byte=>{if(!(byte===0&&this.lastCr&&!this.remote.has(BINARY)))output.push(byte);this.lastCr=byte===13;};
    for(const byte of bytes){
      switch(this.phase){
        case 'data':if(byte===IAC)this.phase='iac';else emit(byte);break;
        case 'iac':if(byte===IAC){emit(IAC);this.phase='data';}else if([DO,DONT,WILL,WONT].includes(byte)){this.verb=byte;this.phase='option';}else if(byte===SB){this.sub=[];this.phase='sub';}else this.phase='data';break;
        case 'option':this.negotiate(this.verb,byte);this.phase='data';break;
        case 'sub':if(byte===IAC)this.phase='sub-iac';else this.sub.push(byte);break;
        case 'sub-iac':if(byte===SE){this.subnegotiation();this.sub=[];this.phase='data';}else if(byte===IAC){this.sub.push(IAC);this.phase='sub';}else{this.sub=[];this.phase='data';}break;
      }
      if(this.sub.length>4096)throw new Error('Telnet subnegotiation exceeds the size limit.');
    }
    if(output.length)this.data(Buffer.from(output));
  }
  encode(text){const binary=this.local.has(BINARY);return escapeIac(encodeTerminalInput(text.replace(/\r\n|\r|\n/g,match=>match==='\r'&&this.enter==='cr'?(binary?'\r':'\r\0'):'\r\n'),this.encoding));}
  resize(cols,rows){
    this.cols=cols;this.rows=rows;
    if(!this.local.has(NAWS))return;
    // A repeated NAWS with unchanged dimensions still makes a network device
    // treat it as a window change and repaint (EXOS restarts the pager at page
    // 1). Send only what the peer does not already know.
    if(this.sentCols===cols&&this.sentRows===rows)return;
    this.sentCols=cols;this.sentRows=rows;
    const bytes=Buffer.alloc(4);bytes.writeUInt16BE(cols,0);bytes.writeUInt16BE(rows,2);this.write(Buffer.concat([Buffer.from([IAC,SB,NAWS]),escapeIac(bytes),Buffer.from([IAC,SE])]));
  }
}

// A peer that disappears *after* the session is up (a power-cycled switch sends
// RST, a firewall resets the flow, negotiation bytes land in a half-closed
// socket) is a disconnect, not a connection failure. SSH already reports those
// as `disconnected`; Telnet routed every socket error through `_fail`, so the
// tab showed "연결 실패" and the final status the UI selects on
// (`.terminal-tab.disconnected`) never appeared — the intermittent close/retry
// failures in the Telnet UI tests (V3-M-11).
const PEER_GONE = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

// The shared transport owner supplies cancellation, bounded output logging and
// orderly shutdown. Telnet never invokes SSH authentication or stores host trust.
class TelnetService extends SshService {
  constructor(options){super({...options,ask:async()=>null,knownHosts:{get:()=>undefined,set:()=>{}}});this.transportName='Telnet';}
  _fail(connection, error) {
    // Once the TCP session is established, a peer-gone error is the end of the
    // session, not a failure to connect. `status` is only 'connected' after the
    // log/shell setup finishes, so checking it alone reported a normal device
    // disconnect as "연결 실패" whenever the peer vanished inside that window.
    if ((connection.status === 'connected' || connection.transportUp) && PEER_GONE.has(error?.code)) {
      return this._finish(connection, 'disconnected', 'Telnet 연결이 종료되었습니다.', error.code);
    }
    return super._fail(connection, error);
  }
  async _start(connection){
    const session=await this._await(connection,()=>this.lookupSession(connection.sessionId));
    if(!session||typeof session.host!=='string'||!session.host||/[\s\0]/.test(session.host)||!Number.isInteger(session.port)||session.port<1||session.port>65535)throw new Error('Telnet 세션 설정이 올바르지 않습니다.');
    if(session.jumpSessionId||session.forwards?.length)throw new Error('Telnet 세션에서는 SSH 포워딩을 사용할 수 없습니다.');
    connection.terminalEncoding=connection.autoEncoding?new AutomaticTerminalEncoding():new TerminalEncoding(session.encoding);
    connection.info={name:session.name,host:session.host,port:session.port,username:'',protocol:'telnet',terminalType:session.terminalType||'xterm-256color',encoding:connection.terminalEncoding.encoding};
    connection.sessionLogEnabled=!!session.logEnabled;
    const autoLog=session.logEnabled||this.getLogSettings().logEnabled;
    connection.initialLogRequested=!!autoLog;
    if(autoLog)connection.logFormat=this.getLogSettings().logFormat||'text';
    const socket=new net.Socket();connection.shell=socket;this._resource(connection,socket,'Telnet 연결에 실패했습니다');socket.setNoDelay(true);if(session.keepaliveInterval)socket.setKeepAlive(true,session.keepaliveInterval*1000);
    // Track the socket's own 'close' from the moment it exists, not from
    // teardown. Registering the listener inside _finish raced the destroy() that
    // _finish itself performs, so a Telnet close-wait could return true while the
    // socket had only been destroyed and never reported its close (V6-M-03).
    this._trackSocketClose(connection,socket);
    // No socket.pause() for logging: the log pump buffers, never blocks the wire.
    const write=bytes=>{if(connection.closed)return;if(socket.writableLength+bytes.length>1024*1024)throw new Error('Telnet 입력 버퍼가 가득 찼습니다. 잠시 후 다시 입력해 주세요.');socket.write(bytes);};
    connection.codec=new TelnetCodec({write,data:bytes=>this._terminalData(connection,bytes),cols:connection.cols,rows:connection.rows,terminalType:connection.info.terminalType,enter:session.telnetEnter||'cr',encoding:session.encoding});
    connection.localEcho=!!session.localEcho;
    connection.stdoutData=bytes=>{try{connection.codec.feed(bytes);}catch{this._finish(connection,'error','Telnet 프로토콜 데이터가 올바르지 않거나 버퍼 한도를 초과했습니다.');}};
    socket.on('data',connection.stdoutData);
    socket.once('close',()=>{if(!connection.closed)this._finish(connection,'disconnected','Telnet 연결이 종료되었습니다.');});
    // A peer FIN only half-closes the socket: without ending our own side (or being
    // reset by a later write) `close` never fires, so the tab stayed "connected"
    // after the device went away. The readable side finishing *is* the session
    // ending; flushes any partial character before the status, like `close` does.
    socket.once('end',()=>{if(!connection.closed)this._finish(connection,'disconnected','Telnet 연결이 종료되었습니다.');});
    await this._pending(connection,done=>{const timer=setTimeout(()=>{done(new Error('Timeout'));this._finish(connection,'error','Telnet 연결 시간이 초과되었습니다. 주소와 포트를 확인해 주세요.','ETIMEDOUT');},connection.handshakeTimeoutMs);timer.unref();const stop=()=>clearTimeout(timer);socket.once('connect',()=>{socket.__everConnected=true;stop();connection.transportUp=true;done(null);});socket.once('error',error=>{stop();done(error);});socket.once('close',()=>{stop();done(new Error('Connection closed'));});socket.connect(session.port,session.host);});
    this._assertOpen(connection);if(autoLog)await this._startAutomaticLogging(connection,session);connection.initialLogRequested=false;this._assertOpen(connection);connection.status='connected';this._emit({type:'status',id:connection.id,status:'connected'});connection.codec.begin();
  }
  // Keep the pre-existing raw log boundary: terminal payload after RFC 854
  // unescaping, before character conversion. Negotiation bytes are not logged.
  _terminalData(connection,bytes){
    if(connection.closed&&!connection.receiveDrain)return;
    const display=connection.terminalEncoding.decode(bytes);
    if(connection.autoEncoding){connection.info.encoding=connection.terminalEncoding.encoding;if(connection.info.encoding!=='auto')connection.codec.encoding=connection.info.encoding;}
    this._writeTerminalLog(connection,bytes,display);
    if(connection.closed&&!connection.receiveDrain)return;
    if(display.length)this._emit({type:'data',id:connection.id,data:this.binaryOutput?display:display.toString('base64')});
  }
  _drainTerminalData(connection,bytes){connection.codec.feed(bytes);}
  _flushTerminalDecoders(connection){
    const tail=connection.terminalEncoding?.end();
    if(tail?.length){this._writeTerminalLog(connection,Buffer.alloc(0),tail);this._emit({type:'data',id:connection.id,data:this.binaryOutput?tail:tail.toString('base64')});}
  }
  _prepareTerminalInput(id,text){
    const c=this._connection(id);
    if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)throw new Error('Telnet 입력이 올바르지 않습니다.');
    const bytes=c.codec.encode(text);
    if(c.shell.writableLength+bytes.length>1024*1024){
      const error=new Error('Telnet 입력 버퍼가 가득 찼습니다. 잠시 후 다시 입력해 주세요.');
      error.commandRetryable=bytes.length<=1024*1024;
      throw error;
    }
    return { connection:c, bytes, text };
  }
  _writeTerminalInput({connection:c,bytes,text}){
    c.shell.write(bytes);
    if(c.localEcho){const echo=Buffer.from(text.replace(/\r(?!\n)/g,'\r\n'),'utf8');this._emit({type:'data',id,data:this.binaryOutput?echo:echo.toString('base64')});}
  }
  resize(id,cols,rows){const c=this._connection(id,false);if(![cols,rows].every(n=>Number.isInteger(n)&&n>=1&&n<=4096))throw new Error('터미널 크기가 올바르지 않습니다.');c.cols=cols;c.rows=rows;c.codec?.resize(cols,rows);}
}

module.exports={TelnetService,TelnetCodec,escapeIac};
