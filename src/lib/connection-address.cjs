'use strict';
const {isIP}=require('node:net');
const {sanitizeSession}=require('./session-store.cjs');
function parseConnectionAddress(input,protocol='ssh',defaultUsername='') {
  const invalid=()=>{throw new Error('IP 또는 호스트 주소를 입력해 주세요. 예: 192.0.2.10, 사용자@호스트:포트');};
  if(typeof input!=='string'||input.length>1024||/[\x00-\x1f\x7f\s]/.test(input.trim()))return invalid();
  if(!['ssh','telnet','auto'].includes(protocol))return invalid();
  const requested=protocol,address=input.trim();
  let username=defaultUsername,hostname,port,scheme=null,rest=address;
  if(!address)return invalid();
  if(address.includes('://')){
    let url;try{url=new URL(address);}catch{return invalid();}
    if(!['ssh:','telnet:'].includes(url.protocol)||url.password||url.search||url.hash||!['','/'].includes(url.pathname))return invalid();
    scheme=url.protocol.slice(0,-1)==='ssh'?'ssh':'telnet';protocol=scheme;
    try{username=url.username?decodeURIComponent(url.username):username;}catch{return invalid();}
    hostname=url.hostname.replace(/^\[|\]$/g,'');port=url.port?Number(url.port):undefined;
  }else{
    if(rest.includes('@')){const pieces=rest.split('@');if(pieces.length!==2||!pieces[0])return invalid();username=pieces[0];rest=pieces[1];}
    const bracket=/^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
    if(bracket){if(isIP(bracket[1])!==6)return invalid();hostname=bracket[1];port=bracket[2]?Number(bracket[2]):undefined;}
    else if(isIP(rest)===6)hostname=rest;
    else {const match=/^([^:/\\?#]+)(?::(\d+))?$/.exec(rest);if(!match)return invalid();hostname=match[1];port=match[2]?Number(match[2]):undefined;}
  }
  if(typeof username!=='string'||username.includes(':'))return invalid();
  // Without a scheme, automatic detection reads the typed port: 23 is Telnet,
  // 22 or no port is SSH. Any other port stays SSH and keeps autoProtocol, so a
  // refused SSH port can be retried over Telnet on that very same port.
  if(requested==='auto'&&!scheme)protocol=port===23?'telnet':'ssh';
  const session=sanitizeSession({host:hostname,port:port??(protocol==='telnet'?23:22),protocol,username:protocol==='ssh'?username:'',name:hostname,rememberPassword:false});
  // sanitizeSession keeps only a fixed whitelist, so the detection metadata is
  // attached afterwards; the renderer needs it to allow the Telnet fallback.
  if(requested!=='auto')return session;
  // autoProtocol marks the automatic mode; explicitScheme records that the user
  // typed ssh:// or telnet:// and therefore stated the protocol themselves.
  return {...session,autoProtocol:true,explicitScheme:!!scheme,rawAddress:input.trim()};
}
module.exports={parseConnectionAddress};
