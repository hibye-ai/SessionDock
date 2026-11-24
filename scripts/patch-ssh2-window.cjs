'use strict';
// Optional shell-only receive credit. Default exec/SFTP/forward channels retain
// upstream window behaviour. The owner reserves capacity BEFORE grantReceive().
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const changes=[
 ['              window: MAX_WINDOW,\n              packetSize: PACKET_SIZE,', '              window: channel.sessiondockReceiveWindow ? 0 : MAX_WINDOW,\n              packetSize: PACKET_SIZE,'],
 ['          this._chanMgr.update(info.recipient, instance);', '          if (channel.sessiondockReceiveWindow) instance._sessiondockReceiveWindow = true;\n          this._chanMgr.update(info.recipient, instance);'],
 ["    openChannel(this, 'session', (err, chan) => {\n      if (err) {\n        cb(err);\n        return;\n      }\n\n      const todo = [];", "    openChannel(this, 'session', { sessiondockReceiveWindow: !!opts?.sessiondockReceiveWindow }, (err, chan) => {\n      if (err) {\n        cb(err);\n        return;\n      }\n\n      const todo = [];"],
 ['  wrapper.type = type;', '  wrapper.type = type;\n  wrapper.sessiondockReceiveWindow = opts.sessiondockReceiveWindow === true;'],
 ['      self._protocol.session(localChan, initWindow, maxPacket);', '      self._protocol.session(localChan, wrapper.sessiondockReceiveWindow ? 0 : initWindow, maxPacket);'],
];
// The openChannel anchor also occurs in exec; restrict its replacement to shell.
function transform(text,reverse=false){
 for(let i=0;i<changes.length;i++){
  const [a,b]=reverse?[changes[i][1],changes[i][0]]:changes[i];
  if(i===2){const start=text.indexOf('  shell(wndopts, opts, cb) {'),end=text.indexOf('  subsys(name, cb) {',start);let part=text.slice(start,end);if(!part.includes(a)){if(reverse)continue;throw Error('SSH shell window anchor differs');}part=part.replace(a,b);text=text.slice(0,start)+part+text.slice(end);}
  else {if(!text.includes(a)){if(reverse)continue;throw Error('SSH window anchor differs: '+i);}text=text.replace(a,b);}
 }
 return text;
}
const channelOld='function windowAdjust(self) {\n  if (self.outgoing.state';
const channelNew='function windowAdjust(self) {\n  // SessionDock managed shell: only budget-owned explicit grants replenish.\n  if (self._sessiondockReceiveWindow) return;\n  if (self.outgoing.state';
const methodOld='  // Session type-specific methods =============================================';
const methodNew=`  grantReceive(bytes) {
    if (!this._sessiondockReceiveWindow || !Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error('Invalid managed receive grant');
    if (this.incoming.state !== 'open' || this.outgoing.state !== 'open') return false;
    this.incoming.window += bytes;
    this._client._protocol.channelWindowAdjust(this.outgoing.id, bytes);
    return true;
  }

${methodOld}`;
function apply(){
 const file='node_modules/ssh2/lib/Channel.js',target=path.join(root,file),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 const text=fs.readFileSync(target,'utf8'),original=text.replace(channelNew,channelOld).replace(methodNew,methodOld);
 if(hash(original)!=='53e92988a025009b192b72be110bd240b5653f88dbdec93e515e3e401e7f94aa')throw Error('SSH Channel differs from reviewed 1.17.0');
 const patched=original.replace(channelOld,channelNew).replace(methodOld,methodNew);fs.writeFileSync(target,patched);
 const client=path.join(root,'node_modules/ssh2/lib/client.js');fs.writeFileSync(client,transform(transform(fs.readFileSync(client,'utf8'),true)));
 fs.writeFileSync(path.join(root,'assets/ssh2-window-patch.json'),JSON.stringify({dependency:'ssh2',version:'1.17.0',file,upstreamSha256:hash(original),patchedSha256:hash(patched),reason:'Opt-in shell window=0; receive budget grants counted shared stdout/stderr wire credit; other channels unchanged.'},null,2)+'\n');
}
module.exports={stripClient:text=>transform(text,true),apply};
