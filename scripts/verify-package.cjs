'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const asar=require('@electron/asar');
const {packagedDirectory}=require('./packaged-location.cjs');
const {verifyFuses}=require('./package-security.cjs');
const {verifyReviewedAssets}=require('./verify-reviewed-assets.cjs');
const archive=path.join(packagedDirectory(),'resources/app.asar');
const unpackedRoot=`${archive}.unpacked`;
const reviewedAssets=verifyReviewedAssets(archive);
const archiveEntries=new Set(asar.listPackage(archive).map(file=>file.replaceAll('\\','/').replace(/^\/+/,'')));
const excludedDevelopmentFiles=['node_modules/ssh2/.eslintignore','node_modules/ssh2/.eslintrc.js','node_modules/ssh2/SFTP.md','node_modules/ssh2/install.js','node_modules/ssh2/util/build_pagent.bat','node_modules/ssh2/util/pagent.c','node_modules/bcrypt-pbkdf/CONTRIBUTING.md','node_modules/safer-buffer/Porting-Buffer.md','node_modules/tweetnacl/PULL_REQUEST_TEMPLATE.md','node_modules/saxes/saxes.js.map','node_modules/xmlchars/xml/1.0/ed4.js.map','node_modules/xmlchars/xml/1.0/ed5.js.map','node_modules/xmlchars/xml/1.1/ed2.js.map','node_modules/xmlchars/xmlchars.js.map','node_modules/xmlchars/xmlns/1.0/ed3.js.map'];
for(const file of excludedDevelopmentFiles){
  assert(!archiveEntries.has(file),`Excluded development file remains in ASAR: ${file}`);
  assert.throws(()=>asar.extractFile(archive,path.normalize(file)),undefined,`Excluded development file can be extracted: ${file}`);
  assert(!fs.existsSync(path.join(unpackedRoot,file)),`Excluded development file remains unpacked: ${file}`);
}
for(const file of ['node_modules/ssh2/util/pagent.exe','node_modules/tweetnacl/AUTHORS.md','node_modules/ssh2/lib/agent.js','node_modules/ssh2/lib/protocol/constants.js','node_modules/ssh2/lib/protocol/crypto.js'])assert(asar.extractFile(archive,path.normalize(file)).length,`Required packaged runtime file is missing: ${file}`);
const additionalFiles=['src/lib/windterm-folders.cjs','src/lib/terminal-appearance.cjs','src/lib/system-fonts.cjs','src/lib/interaction-settings.cjs','src/lib/windterm-import.cjs','src/renderer/context-utils.cjs','src/lib/shared-sessions.cjs','src/renderer/session-tree-model.cjs','src/renderer/session-finder.cjs','src/renderer/terminal-gutter-addon.js'];
const files=['src/main.cjs','src/preload.cjs','src/lib/session-store.cjs','src/lib/securecrt-import.cjs','src/lib/ssh-service.cjs','src/lib/telnet-service.cjs','src/lib/connection-service.cjs','src/lib/terminal-output.cjs','src/lib/terminal-encoding.cjs','src/lib/logging-settings.cjs','src/lib/connection-address.cjs','src/lib/layout-settings.cjs','src/renderer/reconnect-policy.cjs','src/renderer/index.html','src/renderer/desktop.css','src/renderer/terminal-colors.cjs','src/renderer/semantic-color-addon.js','src/renderer/bundle.js'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
files.push('src/lib/atomic-rename.cjs','assets/xterm-webgl-cursor-patch.json');
files.push('src/lib/service-shutdown.cjs','assets/ssh2-window-patch.json');
files.push('src/renderer/terminal-docking.cjs', 'src/renderer/terminal-dock-ui.js');
files.push('src/lib/batch-plan.cjs','src/lib/batch-service.cjs','src/lib/batch-export.cjs','src/renderer/batch-ui.js','src/renderer/batch.css');
files.push('src/lib/batch-terminal.cjs','src/lib/ssh-compatibility.cjs','assets/ssh2-legacy-patch.json','assets/ssh2-ecdsa-patch.json','assets/ssh2-dsa-patch.json','assets/ssh2-auth-patch.json');
files.push(...additionalFiles,'src/lib/automation-service.cjs','src/lib/automation-screen.cjs','src/lib/rotating-log.cjs','src/renderer/terminal-keymap.cjs','src/renderer/terminal-compatibility.cjs','src/renderer/terminal-resource-manager.js','src/renderer/operations-ui.js','src/renderer/operations.css','src/renderer/advanced-terminal-ui.js','src/renderer/advanced-terminal.css');
// Include new helpers/workers automatically; app.js compiles into bundle.js.
for(const file of fs.readdirSync(path.resolve('src'),{recursive:true}).map(file=>'src/'+file.replaceAll('\\','/'))){
  if(file!=='src/renderer/app.js'&&fs.statSync(path.resolve(file)).isFile()&&!files.includes(file))files.push(file);
}
for(const file of files)assert.equal(hash(asar.extractFile(archive,path.normalize(file))),hash(fs.readFileSync(path.resolve(file))),`Packaged source differs: ${file}`);
const packaged=JSON.parse(asar.extractFile(archive,'package.json').toString());assert.equal(packaged.version,require('../package.json').version);
const xtermCss='node_modules/@xterm/xterm/css/xterm.css';
assert.equal(hash(asar.extractFile(archive,path.normalize(xtermCss))),hash(fs.readFileSync(path.resolve(xtermCss))),'Packaged xterm stylesheet differs');
for(const module of ['xterm','addon-fit','addon-search','addon-webgl'])assert(asar.extractFile(archive,path.normalize(`node_modules/@xterm/${module}/LICENSE`)).length,'Terminal license missing');
assert(!asar.listPackage(archive).some(file=>/node_modules[\\/]@xterm[\\/][^\\/]+[\\/](lib|src|typings)[\\/]/.test(file)),'Bundled-only terminal development files remain in the package');
const sshPatch=JSON.parse(asar.extractFile(archive,path.normalize('assets/ssh2-legacy-patch.json')));assert.equal(hash(asar.extractFile(archive,path.normalize(sshPatch.file))),sshPatch.patchedSha256,'Reviewed SSH legacy patch is missing or differs');assert.equal(JSON.parse(asar.extractFile(archive,path.normalize('node_modules/ssh2/package.json'))).version,sshPatch.version);assert(asar.extractFile(archive,path.normalize('node_modules/ssh2/LICENSE')).length,'SSH library license missing');
const ecdsaPatch=JSON.parse(asar.extractFile(archive,path.normalize('assets/ssh2-ecdsa-patch.json')));assert.equal(hash(asar.extractFile(archive,path.normalize(ecdsaPatch.file))),ecdsaPatch.patchedSha256,'Reviewed SSH ECDSA patch is missing or differs');assert.equal(ecdsaPatch.version,sshPatch.version);
const dsaPatch=JSON.parse(asar.extractFile(archive,path.normalize('assets/ssh2-dsa-patch.json')));assert.equal(hash(asar.extractFile(archive,path.normalize(dsaPatch.file))),dsaPatch.patchedSha256,'Reviewed SSH DSA verification patch is missing or differs');assert.equal(dsaPatch.version,sshPatch.version);assert.equal(hash(asar.extractFile(archive,path.normalize(dsaPatch.helper))),dsaPatch.helperSha256,'DSA verification helper differs from its reviewed manifest');
const authPatch=JSON.parse(asar.extractFile(archive,path.normalize('assets/ssh2-auth-patch.json')));assert.equal(hash(asar.extractFile(archive,path.normalize(authPatch.file))),authPatch.patchedSha256,'Reviewed SSH partial-authentication patch is missing or differs');assert.equal(authPatch.version,sshPatch.version);
const windowPatch=JSON.parse(asar.extractFile(archive,path.normalize('assets/ssh2-window-patch.json')));assert.equal(hash(asar.extractFile(archive,path.normalize(windowPatch.file))),windowPatch.patchedSha256,'Reviewed SSH receive-window patch is missing or differs');assert.equal(windowPatch.version,sshPatch.version);
const cursorPatch=JSON.parse(asar.extractFile(archive,path.normalize('assets/xterm-webgl-cursor-patch.json')));
assert.equal(cursorPatch.version,'0.19.0');assert.equal(JSON.parse(asar.extractFile(archive,path.normalize('node_modules/@xterm/addon-webgl/package.json'))).version,cursorPatch.version);
for(const file of cursorPatch.files)assert.equal(hash(fs.readFileSync(path.resolve(file.file))),file.patchedSha256,'Reviewed cursor patch source differs');
const cursorBundle=asar.extractFile(archive,path.normalize('src/renderer/bundle.js')).toString('utf8');
assert.match(cursorBundle,/_cursorBlinkStateManager=this\._register\(new [\w$]+(?:\.[\w$]+)?\)/,'Cursor ownership fix is absent from actual renderer bundle');
assert(!/_cursorBlinkStateManager\s*=\s*new\s/.test(cursorBundle),'Unregistered cursor owner remains in renderer bundle');
const resources=path.dirname(archive);
const electronDist=path.resolve('node_modules/electron/dist');
for(const [name,source] of [['LICENSE.electron.txt','LICENSE'],['LICENSES.chromium.html','LICENSES.chromium.html']]){
  const relocated=path.join(resources,'licenses',name);
  assert(fs.lstatSync(relocated).isFile()&&!fs.lstatSync(relocated).isSymbolicLink(),`Electron 고지가 일반 파일이 아닙니다: ${name}`);
  assert.equal(hash(fs.readFileSync(relocated)),hash(fs.readFileSync(path.join(electronDist,source))),`Electron 고지 내용이 원본과 다릅니다: ${name}`);
  assert(!fs.existsSync(path.join(packagedDirectory(),name)),`Electron 고지가 루트에 남아 있습니다: ${name}`);
}
assert.deepEqual(fs.readdirSync(path.join(path.dirname(resources),'locales')).filter(file=>file.endsWith('.pak')).sort(),['en-US.pak','ko.pak']);
const pythonManifest=JSON.parse(fs.readFileSync(path.resolve('analysis/python-runtime-manifest.json'),'utf8'));
for(const file of pythonManifest.files)assert.equal(hash(fs.readFileSync(path.join(resources,'python-runtime',file.name))),file.sha256,'Packaged Python runtime differs: '+file.name);
assert.equal(hash(fs.readFileSync(path.join(resources,'automation','python_bridge.py'))),hash(fs.readFileSync(path.resolve('assets/automation/python_bridge.py'))));
assert.equal(hash(fs.readFileSync(path.join(resources,'automation','update_helper.py'))),hash(fs.readFileSync(path.resolve('assets/automation/update_helper.py'))));
verifyFuses(path.join(packagedDirectory(),'SessionDock.exe')).then(fuses=>console.log(JSON.stringify({passed:true,...reviewedAssets,fuses,pythonVersion:pythonManifest.version,pythonFilesVerified:pythonManifest.files.length,pythonBridgeVerified:true,electronNoticesRelocated:true,ssh2LegacyPatchVerified:true,ssh2EcdsaPatchVerified:true,ssh2DsaPatchVerified:true,ssh2AuthPatchVerified:true,version:packaged.version,filesVerified:files.length},null,2))).catch(error=>{console.error(error);process.exitCode=1;});
