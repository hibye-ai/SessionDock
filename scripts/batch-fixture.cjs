'use strict';
const net=require('node:net'),{generateKeyPairSync}=require('node:crypto'),{Server}=require('ssh2');
const {TelnetCodec}=require('../src/lib/telnet-service.cjs');
async function batchFixture({protocol='ssh',username='fixture-a',password='fixture-secret-a',privilegePassword='fixture-privilege',encoding='utf8',silentBanner=false}={}){
  const sockets=new Set(),metrics={commands:[],accounts:[],active:0,peak:0,closed:0,pages:0,enterWakeups:0};
  function terminal(write,end,authenticated){let input='',stage=authenticated?'ready':'username',pager=false;
    // Huawei VRP prints a warning banner after login and then waits for a bare
    // CR before drawing <Huawei>; no "Press ENTER" hint is printed at all.
    const readyPrompt=silentBanner&&authenticated?'<Huawei>':'device# ';
    if(authenticated&&silentBanner){stage='banner';write('Warning: Telnet is not a secure protocol.\r\nInfo: The max number of VTY users is 5.\r\n');}
    else write(authenticated?'Fixture ready\r\ndevice> ':'Username: ');
    return bytes=>{if(pager&&bytes.toString()===' '){pager=false;metrics.pages++;write('\r\nPAGE_TWO 한글\r\ndevice# ');return;}
      input+=bytes.toString('utf8');let at;while((at=input.search(/[\r\n]/))>=0){const line=input.slice(0,at);input=input.slice(at+1).replace(/^\n/,'');
        if(!line){if(stage==='banner'){stage='ready';metrics.enterWakeups++;write('\r\n'+readyPrompt);}continue;}
        if(stage==='banner'){stage='ready';metrics.enterWakeups++;write('\r\n'+readyPrompt);}
        if(stage==='username'){metrics.accounts.push(line);stage=line===username?'password':'invalid';write('\r\nPassword: ');continue;}
        if(stage==='password'){if(line!==password){write('\r\nLogin incorrect\r\n');end();return;}stage='ready';write('\r\nFixture ready\r\ndevice> ');continue;}
        if(stage==='enable'){if(line!==privilegePassword){write('\r\nAccess denied\r\n');end();return;}stage='ready';write(line.slice(0,8));setTimeout(()=>write(line.slice(8)+'\r\ndevice# '),35);continue;}
        if(stage==='invalid'){end();return;}
        metrics.commands.push(line);(metrics.commandTimes||(metrics.commandTimes=[])).push(Date.now());if(line==='hang'){write('waiting without prompt\r\n');continue;}
        // A no-echo long command: the device first answers with a bare CRLF (or
        // a run of blank lines) and only later prints the body and prompt. The
        // blank line must never be mistaken for the previous prompt returning.
        if(line==='slow-empty'){metrics.slowSentAt=Date.now();write('\r\n');setTimeout(()=>write('SLOW_BODY\r\ndevice# '),650);continue;}
        // H-01 acceptance fixtures: a prompt that already existed before the
        // command is re-touched only with whitespace or a single re-printed
        // cell, so a stale prompt must not be promoted to "fresh".
        if(line==='pad-prompt'){metrics.slowSentAt=Date.now();write(' ');setTimeout(()=>write('SLOW_BODY\r\ndevice# '),650);continue;}
        if(line==='reprint-cell'){metrics.slowSentAt=Date.now();write('\rR');setTimeout(()=>write('SLOW_BODY\r\ndevice# '),650);continue;}
        if(line==='erase-refresh'){metrics.slowSentAt=Date.now();write('\x1b[2K\r');setTimeout(()=>write('SLOW_BODY\r\ndevice# '),650);continue;}
        if(line==='slow-blanks'){metrics.slowSentAt=Date.now();write('\r\n\r\n\r\n\x1b[H');setTimeout(()=>write('SLOW_BODY\r\ndevice# '),650);continue;}
        if(line==='enable'){stage='enable';write('Password: ');continue;}
        if(line==='paged'){pager=true;write('PAGE_ONE\r\n--More--');continue;}
        if(line==='split-secret'){write(password.slice(0,7));setTimeout(()=>write(password.slice(7)+'\r\n'+readyPrompt),40);continue;}
        // Only the first characters of the password are echoed, then the link
        // is cut: the cancellation/timeout path must still mask that prefix.
        if(line==='partial-echo'){write(password.slice(0,3));continue;}
        if(line==='large-result'){write(('OUTPUT 한글 1234567890\n').repeat(10000));setTimeout(()=>write('FOUND_AFTER_PREVIEW_BOUNDARY\r\n'+readyPrompt),40);continue;}
        if(line==='overflow'){write('X'.repeat(2*1024*1024+1));continue;}
        if(line==='exit'){end();return;}
        write(line+'\r\n');setTimeout(()=>write((line.startsWith('echo ')?line.slice(5):'RESULT '+line)+' 한글 <>&\r\n'+readyPrompt),40);
      }
    };
  }
  let server;
  if(protocol==='ssh'){
    const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
    server=new Server({hostKeys:[key]},client=>{sockets.add(client);metrics.active++;metrics.peak=Math.max(metrics.peak,metrics.active);client.once('close',()=>{sockets.delete(client);metrics.active--;metrics.closed++;});client.on('error',()=>{});
      client.on('authentication',ctx=>{if(ctx.method==='password'&&ctx.username===username&&ctx.password===password){metrics.accounts.push(ctx.username);ctx.accept();}else ctx.reject();});
      client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',acceptPty=>acceptPty());session.on('shell',acceptShell=>{const channel=acceptShell();channel.on('error',()=>{});const feed=terminal(t=>channel.write(t),()=>channel.end(),true);channel.on('data',feed);});}));
    });
  }else server=net.createServer(socket=>{sockets.add(socket);metrics.active++;metrics.peak=Math.max(metrics.peak,metrics.active);socket.once('close',()=>{sockets.delete(socket);metrics.active--;metrics.closed++;});socket.on('error',()=>{});const feed=terminal(t=>socket.write(t),()=>socket.end(),false);const codec=new TelnetCodec({write:()=>{},data:feed});socket.on('data',b=>codec.feed(b));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const close=async()=>{
    // Force-close every accepted socket before closing the listener: an ssh2
    // Connection exposes `end()`, a raw net.Socket exposes `destroy()`, and
    // server.close() only resolves once no client is left.
    for(const socket of sockets){
      try{ if(typeof socket.destroy==='function')socket.destroy(); else socket.end?.(); }catch{}
    }
    sockets.clear();
    await Promise.race([
      new Promise(resolve=>server.close(()=>resolve())),
      new Promise(resolve=>{const timer=setTimeout(resolve,2000);timer.unref?.();}),
    ]);
  };
  return {protocol,host:'127.0.0.1',port:server.address().port,username,password,privilegePassword,metrics,close};
}
module.exports={batchFixture};
