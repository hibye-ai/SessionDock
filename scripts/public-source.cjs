'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const DENIED=/(?:^|\/)(?:analysis|evidence|test-artifacts|dist|node_modules|profiles?|user-data|cache|\.git|\.tools|\.review|\.venv)(?:\/|$)/i;
function validPath(p){
 if(typeof p!=='string'||!p||p.includes('\\')||/[:*?\x00-\x1f]/.test(p)||p.startsWith('/')||p.split('/').some(s=>!s||s==='.'||s==='..'||/[ .]$/.test(s)||/[<>|]/.test(s)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s))||DENIED.test(p)||/(?:^|\/)(?:\.env(?:\..*)?|credentials?[^/]*|secrets?[^/]*|.*\.(?:pfx|p12|pem|key|sqlite3?))$/i.test(p))throw Error('Invalid public manifest path');
 return p;
}
function safeFile(root,p){
 validPath(p);let current=path.resolve(root);
 if(fs.lstatSync(current).isSymbolicLink())throw Error('Public source root must not be a link');
 for(const part of p.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Public source links are forbidden');}
 if(!fs.lstatSync(current).isFile())throw Error('Public source must be a regular file');return current;
}
function scanText(file,text){
 const patterns={
  personalPath:/\b[A-Za-z]:[\\/]+Users[\\/]+[^\s\\/<>"'`]+/g,
  privateIPv4:/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
  privateKey:/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  token:/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
  credentialLiteral:/\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\r\n]{8,}["']/gi
 };
 return Object.entries(patterns).flatMap(([category,re])=>{const count=[...text.matchAll(re)].length;return count?[{path:file,category,count}]:[];});
}
function checkManifest(root=path.resolve(__dirname,'..'),manifest){
 manifest??=JSON.parse(fs.readFileSync(path.join(root,'public-source-manifest.json'),'utf8'));
 if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||!manifest.files.length)throw Error('Invalid public manifest');
 const seen=new Set(),findings=[],reviewedFindings=[];
 for(const entry of manifest.files){
  const file=validPath(entry.path),key=file.toLowerCase();if(seen.has(key))throw Error('Duplicate public manifest path');seen.add(key);
  if(!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw Error('Missing public source hash');
  const data=fs.readFileSync(safeFile(root,file));if(hash(data)!==entry.sha256)throw Error('Public source SHA mismatch: '+file);
  const detected=data.includes(0)?[]:scanText(file,data.toString('utf8'));
  const accepted=entry.reviewedFindings||[];
  for(const review of accepted){
   if(typeof review.reason!=='string'||review.reason.length<10||!detected.some(x=>x.category===review.category&&x.count===review.count))throw Error('Stale public finding review');
  }
  for(const row of detected){
   if(accepted.some(x=>x.category===row.category&&x.count===row.count))reviewedFindings.push(row);else findings.push(row);
  }
 }
 return {ok:findings.length===0,files:seen.size,findings,reviewedFindings,publicationApproved:false};
}
function exportSource(root,destination){
 root=path.resolve(root);destination=path.resolve(destination);
 const inside=(a,b)=>{const rel=path.relative(a,b);return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
 if(inside(root,destination)||inside(destination,root)||fs.existsSync(destination))throw Error('Export requires a new directory outside the workspace');
 let parent=path.dirname(destination);while(parent!==path.dirname(parent)){if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw Error('Export parent must not be a link');parent=path.dirname(parent);}
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'public-source-manifest.json'),'utf8')),result=checkManifest(root,manifest);
 if(!result.ok)throw Error('Public source scan has findings; review counts without printing values');
 fs.mkdirSync(destination,{recursive:false});
 for(const entry of manifest.files){
  const source=safeFile(root,entry.path),data=fs.readFileSync(source);if(hash(data)!==entry.sha256)throw Error('Public source changed during export');
  const target=path.join(destination,entry.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data,{flag:'wx'});
  if(hash(fs.readFileSync(target))!==entry.sha256)throw Error('Public source copy verification failed');
 }
 fs.writeFileSync(path.join(destination,'public-source-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return result;
}
if(require.main===module){
 try{const args=process.argv.slice(2);let result;if(args.length===1&&args[0]==='--check')result=checkManifest();else if(args.length===2&&args[0]==='--export')result=exportSource(path.resolve(__dirname,'..'),args[1]);else throw Error('Use --check or --export NEW-DIRECTORY');console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
 catch{console.error('Public source check/export failed; inspect manifest paths and hashes locally. No matched values are logged.');process.exitCode=1;}
}
module.exports={validPath,scanText,checkManifest,exportSource};
