'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),semver=require('semver');
const root=path.resolve(__dirname,'..'),lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
test('F03 all installed and locked minimatch versions are outside GHSA-g3hv-75wg-m249',()=>{
 const affected=[];
 for(const [file,pkg] of Object.entries(lock.packages))if(file.endsWith('node_modules/minimatch')){
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,file,'package.json'))).version,pkg.version);
  if(semver.satisfies(pkg.version,'>=7.0.0 <11.0.1'))affected.push(file+'@'+pkg.version);
 }
 assert.equal(affected.length,0,'Affected dev dependency paths: '+affected.join(', '));
});
test('dependency guard preserves reviewed postinstall hooks and application version',()=>{
 const pkg=require('../package.json');assert.equal(pkg.version,'0.1.8');assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);
 for(const name of ['patch-ssh2-legacy.cjs','patch-xterm-webgl.cjs','patch-xterm-work-budget.cjs'])assert.equal(pkg.scripts.postinstall.includes(name),true);
 const expected={
  'global-agent':'4.1.3',
  'app-builder-lib@26.15.3':{'minimatch@^10.2.5':'11.0.5','@electron/universal@2.0.3':{'minimatch@^9.0.3':'11.0.5'}},
 };
 assert.deepEqual(pkg.overrides,expected,'Only the reviewed consumer/version-scoped override is allowed');
 const {createRequire}=require('node:module');
 for(const parent of ['app-builder-lib','@electron/universal']){
  const req=createRequire(require.resolve(parent+'/package.json'));
  assert.equal(req('minimatch/package.json').version,'11.0.5');
 }
 // Consumers needing older RegExp/makeRe APIs must not receive v11.
 for(const [parent,version] of [['@electron/asar','3.1.5'],['dir-compare','3.1.5'],['glob','3.1.5'],['filelist','5.1.9']]){
  const req=createRequire(require.resolve(parent+'/package.json'));
  assert.equal(req('minimatch/package.json').version,version,parent);
 }
 for(const [n,v] of Object.entries(pkg.devDependencies))assert.equal(lock.packages[''].devDependencies[n],v);
});
