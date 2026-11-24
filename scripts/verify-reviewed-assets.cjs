'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),asar=require('@electron/asar');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const SAXES_SHA='0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e';
const XTERM_MANIFEST_SHA='f9c1e47dc706e4a5a66eb7f93837bc17f5940470830bccf4774791542d26b068';
function verifyReviewedAssets(archive,root=path.resolve(__dirname,'..')) {
 const read=file=>asar.extractFile(archive,path.normalize(file));
 const same=file=>assert.equal(hash(read(file)),hash(fs.readFileSync(path.join(root,file))),'Packaged reviewed asset differs: '+file);
 const license='assets/third-party/saxes-v6-LICENSE.txt',notice='assets/third-party/saxes.json',manifest='assets/xterm-work-budget-patch.json';
 same(license);same(notice);same(manifest);
 assert.equal(hash(read(license)),SAXES_SHA,'Complete saxes v6 license differs');assert.equal(read(license).length,3011);
 const metadata=JSON.parse(read(notice));
 assert.equal(metadata.dependency,'saxes');assert.equal(metadata.version,'6.0.0');assert.equal(metadata.sha256,SAXES_SHA);
 assert.equal(metadata.licenseFile,license);assert.equal(metadata.bytes,3011);
 assert.equal(metadata.source,'https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE');
 assert.equal(JSON.parse(read('node_modules/saxes/package.json')).version,'6.0.0');
 assert.equal(hash(read(manifest)),XTERM_MANIFEST_SHA,'Reviewed F08 manifest differs');
 const patch=JSON.parse(read(manifest));assert.equal(patch.version,'6.0.0');
 assert.equal(JSON.parse(read('node_modules/@xterm/xterm/package.json')).version,patch.version);
 for(const f of patch.files)assert.equal(hash(fs.readFileSync(path.join(root,f.file))),f.patchedSha256,'Reviewed F08 source differs: '+f.file);
 const bundle=read('src/renderer/bundle.js').toString('utf8');
 // Inspect each operation in the actual shipped bundle, not a marker comment.
 for(const method of ['cursorForwardTab','cursorBackwardTab','insertLines','deleteLines','scrollUp','scrollDown']){
  const body=bundle.match(new RegExp(method+'\\([\\w$]+\\)\\{.*?(?=\\}[a-zA-Z_$]+\\()'))?.[0];
  assert(body,'Missing xterm operation: '+method);
  const geometry=method.includes('Tab')?'this\\._bufferService\\.cols':'this\\._activeBuffer\\.scrollBottom-this\\._activeBuffer\\.'+(method.endsWith('Lines')?'y':'scrollTop')+'\\+1';
  assert.match(body,new RegExp('Math\\.min\\([\\w$]+\\.params\\[0\\]\\|\\|1,'+geometry+'\\)'),'Unbounded xterm geometry operation: '+method);
 }
 const rep=bundle.match(/repeatPrecedingCharacter\([\w$]+\)\{.*?(?=\}[a-zA-Z_$]+\()/)?.[0];
 assert(rep,'Missing REP operation');assert.match(rep,/return this\._sessiondockRepeat\([\w$]+,[\w$]+\)/);
 assert(!rep.includes('new Uint32Array'),'Unbounded REP allocation remains');
 const work=bundle.match(/_sessiondockRepeat\([\w$]+,[\w$]+\)\{.*?(?=\}print\()/)?.[0];
 assert(work,'Missing cooperative REP implementation');assert.match(work,/new Uint32Array\(1024\)/);
 assert.match(work,/_sessiondockRepWork/);assert.match(work,/new Promise\(/);assert.match(work,/setTimeout\([\w$]+,0\)/);
 return {saxesLicenseVerified:true,xtermWorkBudgetVerified:true};
}
module.exports={verifyReviewedAssets};
