'use strict';
const {createHash,checkPrimeSync}=require('node:crypto');
const domains=new Map(),MAX_DOMAINS=128;
const integer=bytes=>BigInt('0x'+bytes.toString('hex'));
function power(base,exponent,modulus){let result=1n;for(base%=modulus;exponent>0n;exponent>>=1n,base=base*base%modulus)if(exponent&1n)result=result*base%modulus;return result;}
function positive(bytes,maxBytes){
  if(!bytes.length||bytes.length>maxBytes||bytes[0]&128)throw new Error('Invalid DSA integer');
  if(bytes[0]===0){if(bytes.length===1||!(bytes[1]&128))throw new Error('Noncanonical DSA integer');bytes=bytes.subarray(1);}
  return bytes;
}
function domain(publicSSH){
  if(!Buffer.isBuffer(publicSSH)||publicSSH.length>512)throw new Error('Invalid DSA public key');
  const cacheKey=publicSSH.toString('base64');if(domains.has(cacheKey))return domains.get(cacheKey);
  let at=0;const field=()=>{if(at+4>publicSSH.length)throw new Error('Truncated key');const size=publicSSH.readUInt32BE(at);at+=4;if(size>publicSSH.length-at)throw new Error('Truncated key');const bytes=publicSSH.subarray(at,at+size);at+=size;return bytes;};
  if(!field().equals(Buffer.from('ssh-dss')))throw new Error('Not a DSA key');
  const pBytes=positive(field(),129),qBytes=positive(field(),21),gBytes=positive(field(),129),yBytes=positive(field(),129);
  if(at!==publicSSH.length)throw new Error('Trailing key data');
  const p=integer(pBytes),q=integer(qBytes),g=integer(gBytes),y=integer(yBytes),bits=p.toString(2).length;
  // Legacy DSS permits 512..1024-bit p in 64-bit increments, with 160-bit q.
  // The reported OmniSwitch uses 512 bits; do not silently truncate parameters.
  if(bits<512||bits>1024||bits%64||q.toString(2).length!==160||(p-1n)%q||g<=1n||g>=p||y<=1n||y>=p)throw new Error('Invalid DSA domain');
  if(!checkPrimeSync(qBytes,{checks:64})||!checkPrimeSync(pBytes,{checks:64})||power(g,q,p)!==1n||power(y,q,p)!==1n)throw new Error('Invalid DSA subgroup');
  const result={p,q,g,y};domains.set(cacheKey,result);if(domains.size>MAX_DOMAINS)domains.delete(domains.keys().next().value);return result;
}
function signatureIntegers(signature){
  if(!Buffer.isBuffer(signature)||signature.length<8||signature.length>48||signature[0]!==0x30||signature[1]!==signature.length-2)throw new Error('Invalid DSA signature');
  let at=2;const read=()=>{if(signature[at++]!==2)throw new Error('Invalid signature integer');const size=signature[at++];if(!size||at+size>signature.length)throw new Error('Truncated signature');const value=integer(positive(signature.subarray(at,at+size),21));at+=size;return value;};
  const r=read(),s=read();if(at!==signature.length)throw new Error('Trailing signature data');return {r,s};
}
// Public-key verification only. No private keys, signing or trust decisions.
// Called solely when native crypto reports that DSA itself is unsupported.
function verifyDsaHostSignature(publicSSH,data,signature){
  try{
    if(!Buffer.isBuffer(data)||data.length>4096)return false;
    const {r,s}=signatureIntegers(signature),{p,q,g,y}=domain(publicSSH);
    // Do not reduce an out-of-range r or s: that would accept invalid signatures.
    if(r<=0n||r>=q||s<=0n||s>=q)return false;
    const h=integer(createHash('sha1').update(data).digest()),w=power(s,q-2n,q);
    return (power(g,h*w%q,p)*power(y,r*w%q,p)%p)%q===r;
  }catch{return false;}
}
module.exports={verifyDsaHostSignature};
