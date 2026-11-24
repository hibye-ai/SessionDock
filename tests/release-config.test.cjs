'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
// Release fixtures require no signing keys.
const { signingConfig, buildOptions } = require('../scripts/build-release.cjs');
const { historicalReference } = require('../scripts/release-manifest.cjs');
// Load the public builder entry first (build-release does this above) to avoid
// its internal platform packagers' circular initialization dependency.
const { WinPackager } = require('app-builder-lib/out/winPackager.js');
const { FileCopier } = require('builder-util');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessiondock-release-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function trustedBuildFixture(root) {
  const project = path.resolve(__dirname, '..');
  for (const relative of ['scripts/build-release.cjs', 'scripts/release-integrity.cjs', 'analysis/python-runtime-manifest.json']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(project, relative), target);
  }
  return { wrapper: path.join(root, 'scripts/build-release.cjs'), env: { ...process.env } };
}

test('a signed release fails closed without an organization certificate', () => {
  assert.throws(() => signingConfig(true, {}), /인증서/);
  assert.equal(signingConfig(false, {}).win.signExecutable, false);
  const config = signingConfig(true, { CSC_LINK: 'synthetic-certificate.pfx' });
  assert.equal(config.forceCodeSigning, true); assert.equal(config.win.signExecutable, true);
  assert.throws(() => signingConfig(true, { SESSIONDOCK_CERT_SHA1: 'invalid' }), /형식/);
  assert.equal(signingConfig(true, { SESSIONDOCK_CERT_SHA1: 'a'.repeat(40) }).win.signtoolOptions.certificateSha1, 'a'.repeat(40));
});

test('output directory CLI options retain path characters and cannot weaken signed builds', () => {
  for (const output of ['dist/release-0.20.6', 'C:\\release folder & files\\build=one', 'dist/release space']) {
    for (const args of [[`--config.directories.output=${output}`], ['--config.directories.output', output]]) {
      const local = buildOptions(args, {});
      assert.equal(local.config.directories.output, output); assert.equal(local.publish, 'never');
      assert.equal(local.config.win.signExecutable, false); assert.equal(local.config.forceCodeSigning, false);
      assert.throws(() => buildOptions([...args, '--signed'], {}), /인증서/);
      const signed = buildOptions(['--signed', ...args], { WIN_CSC_LINK: 'synthetic-certificate.pfx' });
      assert.equal(signed.config.directories.output, output); assert.equal(signed.config.forceCodeSigning, true);
      assert.equal(signed.config.win.signExecutable, true);
      assert(signed.config.win.signExts.length > 0); assert.equal(signed.publish, 'never');
    }
  }
  assert.equal(buildOptions([], {}).config.directories, undefined);
});

test('unknown, duplicate and malformed CLI arguments fail instead of being ignored', () => {
  for (const args of [
    ['--unknown'], ['--signed=false'], ['--signed', '--signed'], ['--publish=always'],
    ['--config.win.signExecutable=false'], ['--config.forceCodeSigning=false'],
    ['--config.directories.output'], ['--config.directories.output='],
    ['--config.directories.output', '--signed'], ['--config.directories.output=  '],
    ['--config.directories.output=one\0two'], ['--config.directories.output=one\ntwo'],
    ['--config.directories.output=a', '--config.directories.output', 'b']
  ]) assert.throws(() => buildOptions(args, { CSC_LINK: 'synthetic-certificate.pfx' }));
  assert.throws(() => buildOptions(['--config.cscLink=PRIVATE_CERT_VALUE'], {}), error =>
    !error.message.includes('PRIVATE_CERT_VALUE') && error.message.includes('--config.cscLink'));
});

test('npm run dist preserves spaced output options and builds the renderer first', t => {
  const root = temporary(t), calls = path.join(root, 'calls.json'), order = path.join(root, 'order.txt');
  const { wrapper, env } = trustedBuildFixture(root);
  const originalScripts = require('../package.json').scripts;
  const wrapperCommand = 'node scripts/build-release.cjs';
  assert(originalScripts.dist.endsWith(wrapperCommand));
  // Preserve the actual npm command chain; replace only its side effects.
  const dist = originalScripts.dist.replace(wrapperCommand, `node --require ./builder-mock.cjs "${wrapper}"`);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'release-wrapper-fixture', private: true,
    scripts: { predist: originalScripts.predist, dist, 'build:renderer': 'node renderer-mock.cjs' } }));
  fs.writeFileSync(path.join(root, 'renderer-mock.cjs'), "require('node:fs').appendFileSync('order.txt','renderer\\n');");
  fs.writeFileSync(path.join(root, 'builder-mock.cjs'), `
const Module = require('node:module'), fs = require('node:fs');
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron-builder') return {
    build: async options => { fs.appendFileSync('order.txt','builder\\n'); fs.writeFileSync('calls.json',JSON.stringify(options)); },
    Platform: { WINDOWS: { createTarget: () => ['portable-x64'] } }, Arch: { x64: 1 }
  };
  if (name === './release-manifest.cjs') return { writeManifest: async () => {} };
  if (name === './publish-portable.cjs') return { prepareZip: () => {}, publishZip: options => { fs.appendFileSync('order.txt','publisher\\n'); fs.writeFileSync('publish.json',JSON.stringify(options)); return {verified:true,removed:[],skipped:[],cleanupErrors:[]}; } };
  return original.call(this, name, ...args);
};
`);
  const result = process.platform === 'win32' ? spawnSync(process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', 'npm.cmd run dist -- "--config.directories.output=dist/release space"'],
    { cwd: root, env, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 15000 }) :
    spawnSync('npm', ['run', 'dist', '--', '--config.directories.output=dist/release space'],
      { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(order, 'utf8'), 'renderer\nbuilder\npublisher\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'publish.json'))).outputDirectory,path.resolve(root,'dist/release space'));
  assert.equal(JSON.parse(fs.readFileSync(calls)).config.directories.output, 'dist/release space');
});

test('CLI entry rejects unknown arguments and missing certificates before invoking builder', t => {
  const root = temporary(t), preload = path.join(root, 'mock.cjs');
  fs.writeFileSync(preload, `
const Module = require('node:module'), original = Module._load;
Module._load = function(name,...args) {
  if(name==='electron-builder') return { build:()=>{throw Error('BUILDER_MUST_NOT_RUN')}, Platform:{WINDOWS:{createTarget:()=>[]}}, Arch:{x64:1} };
  return original.call(this,name,...args);
};
`);
  const env = { ...process.env };
  for (const key of ['CSC_LINK', 'WIN_CSC_LINK', 'SESSIONDOCK_CERT_SHA1']) delete env[key];
  for (const args of [['--config.directories.ouptut=dist/typo'], ['--signed']]) {
    const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../scripts/build-release.cjs'), ...args],
      { env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert(!result.stderr.includes('BUILDER_MUST_NOT_RUN'));
    assert.match(result.stderr, args[0] === '--signed' ? /인증서/ : /지원하지 않는 빌드 인자/);
  }
});

test('explicit CI build-only mode avoids the mapped drive and does not bypass signing checks',t=>{
  assert.equal(buildOptions(['--build-only'],{}).publish,'never');assert.throws(()=>buildOptions(['--build-only','--build-only'],{}));assert.throws(()=>buildOptions(['--build-only','--signed'],{}),/인증서/);
  const root=temporary(t),preload=path.join(root,'mock.cjs');
  fs.writeFileSync(preload,`const Module=require('node:module'),original=Module._load;Module._load=function(name,...args){if(name==='electron-builder')return{build:async()=>{},Platform:{WINDOWS:{createTarget:()=>[]}},Arch:{x64:1}};if(name==='./publish-portable.cjs')return{prepareZip:()=>{},publishZip:()=>{throw Error('PUBLISH_MUST_NOT_RUN')}};if(name==='./release-manifest.cjs')return{writeManifest:async()=>{}};return original.call(this,name,...args);};`);
  const result=spawnSync(process.execPath,['--require',preload,path.resolve(__dirname,'../scripts/build-release.cjs'),'--build-only'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
});

test('a failed builder never publishes or starts old-release cleanup',t=>{
  const root=temporary(t),preload=path.join(root,'mock.cjs');
  fs.writeFileSync(preload,`const Module=require('node:module'),original=Module._load;Module._load=function(name,...args){if(name==='electron-builder')return{build:async()=>{process.on('exit',()=>{process.exitCode=0;});throw Error('SYNTHETIC_BUILD_FAILURE')},Platform:{WINDOWS:{createTarget:()=>[]}},Arch:{x64:1}};if(name==='./publish-portable.cjs')throw Error('PUBLISH_MUST_NOT_RUN');return original.call(this,name,...args);};`);
  const result=spawnSync(process.execPath,['--require',preload,path.resolve(__dirname,'../scripts/build-release.cjs'),'--build-only'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});assert.ifError(result.error);assert.equal(result.status,1);assert.match(result.stderr,/SYNTHETIC_BUILD_FAILURE/);assert(!result.stderr.includes('PUBLISH_MUST_NOT_RUN'));
});

test('installed builder preserves pinned Python copies but signs the app, portable and unrelated executables', async t => {
  const root = temporary(t), appOutDir = path.join(root, 'win-unpacked'), signedFiles = [];
  const config = signingConfig(true, { CSC_LINK: 'synthetic-certificate.pfx' });
  const packager = { platformSpecificBuildOptions: config.win, signingQueue: Promise.resolve(true),
    shouldSignFile: WinPackager.prototype.shouldSignFile, signIf: WinPackager.prototype.signIf,
    async _sign(file) { signedFiles.push(file); fs.appendFileSync(file, 'SYNTHETIC_SIGNATURE'); return true; } };
  const transformer = WinPackager.prototype.createTransformerForExtraFiles.call(packager, { appOutDir });
  const copier = new FileCopier(() => false, transformer), manifest = require('../analysis/python-runtime-manifest.json');
  for (const { name } of manifest.files) {
    for (const prefix of ['C:\\source\\assets\\python-runtime\\', 'C:/output/resources/python-runtime/']) {
      assert.equal(packager.shouldSignFile(prefix + name, true), false, name);
    }
  }
  const destination = path.join(appOutDir, 'resources/python-runtime'); fs.mkdirSync(destination, { recursive: true });
  for (const file of manifest.files.filter(file => file.name.endsWith('.exe'))) {
    const source = path.resolve(__dirname, '../assets/python-runtime', file.name), target = path.join(destination, file.name);
    await copier.copy(source, target, fs.statSync(source));
    assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'), file.sha256);
  }
  assert.deepEqual(signedFiles, []);
  const otherSource = path.join(root, 'tools/python.exe'), otherTarget = path.join(appOutDir, 'resources/tools/python.exe');
  fs.mkdirSync(path.dirname(otherSource), { recursive: true }); fs.mkdirSync(path.dirname(otherTarget), { recursive: true });
  fs.writeFileSync(otherSource, 'unrelated executable');
  await copier.copy(otherSource, otherTarget, fs.statSync(otherSource));
  for (const file of [path.join(appOutDir, 'SessionDock.exe'), path.join(root, 'SessionDock-test-portable.exe')]) {
    fs.writeFileSync(file, 'application executable'); await packager.signIf(file);
  }
  assert.deepEqual(signedFiles.map(file => path.relative(root, file)), [
    path.relative(root, otherTarget), path.join('win-unpacked', 'SessionDock.exe'), 'SessionDock-test-portable.exe'
  ]);
  for (const file of signedFiles) assert(fs.readFileSync(file, 'utf8').endsWith('SYNTHETIC_SIGNATURE'));
  packager.platformSpecificBuildOptions = signingConfig(false, {}).win;
  assert.equal(WinPackager.prototype.createTransformerForExtraFiles.call(packager, { appOutDir }), null);
  assert.equal(await packager.signIf(path.join(appOutDir, 'SessionDock.exe')), false); assert.equal(signedFiles.length, 3);
});
test('the explicit version-reset flag is parsed once and forwarded to the publisher', () => {
  assert.equal(buildOptions([], {}).allowVersionReset, false);
  assert.equal(buildOptions(['--allow-version-reset'], {}).allowVersionReset, true);
  assert.equal(buildOptions(['--build-only', '--allow-version-reset'], {}).allowVersionReset, true);
  assert.throws(() => buildOptions(['--allow-version-reset', '--allow-version-reset'], {}), /한 번만/);
  assert.throws(() => buildOptions(['--allow-version-reset=true'], {}), /지원하지 않는 빌드 인자/);
  assert.throws(() => buildOptions(['--allow-version-resett'], {}), /지원하지 않는 빌드 인자/);
  // The flag must never leak into the electron-builder configuration object.
  const options = buildOptions(['--allow-version-reset'], {});
  assert.deepEqual(Object.keys(options).sort(), ['allowVersionReset', 'config', 'publish', 'targets']);
});

test('build-release passes allowVersionReset to publishZip and only on explicit request', t => {
  const root = temporary(t), { wrapper, env } = trustedBuildFixture(root);
  const preload = path.join(root, 'mock.cjs'), published = path.join(root, 'publish.json');
  fs.writeFileSync(preload, `
const Module = require('node:module'), fs = require('node:fs'), original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron-builder') return { build: async () => {}, Platform: { WINDOWS: { createTarget: () => ['portable-x64'] } }, Arch: { x64: 1 } };
  if (name === './release-manifest.cjs') return { writeManifest: async () => {} };
  if (name === './publish-portable.cjs') return { prepareZip: () => {}, publishZip: options => {
    fs.writeFileSync(${JSON.stringify(published)}, JSON.stringify(options));
    return { verified: true, version: '0.1.1', versionReset: options.allowVersionReset === true,
      previousHigherVersions: [], preservedHigherVersions: [], target: 'Z:/synthetic.exe',
      zip: { file: 'SessionDock-0.1.1.zip', verified: true, sha256: 'b'.repeat(64), bytes: 1, skipped: null },
      sha256: 'a'.repeat(64), removed: [], skipped: [], cleanupErrors: [] };
  } };
  return original.call(this, name, ...args);
};
`);
  for (const [args, expected] of [[[], false], [['--allow-version-reset'], true]]) {
    fs.rmSync(published, { force: true });
    const result = spawnSync(process.execPath, ['--require', preload, wrapper, ...args],
      { cwd: root, env: { ...env, CSC_LINK: '' }, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const options = JSON.parse(fs.readFileSync(published, 'utf8'));
    assert.equal(options.allowVersionReset, expected, args.join(' '));
    assert.deepEqual(Object.keys(options).sort(), ['allowVersionReset', 'outputDirectory']);
  }
});

test('package.json and both package-lock root versions stay on 0.1.8', () => {
  const pkg = require('../package.json');
  const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package-lock.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.8');
  assert.equal(lock.version, '0.1.8');
  assert.equal(lock.packages[''].version, '0.1.8');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  // The portable artifact name embeds this version, so a drift would publish
  // SessionDock-<other>-portable.exe while the UI reports 0.1.8.
  assert.equal(pkg.build.portable.artifactName, 'SessionDock-${version}-portable.exe');
  assert.equal(pkg.build.appId, 'local.sessiondock.app');
});

test('release provenance uses optional historical evidence without an installed reference app', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessiondock-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(historicalReference(root), null);
  fs.mkdirSync(path.join(root, 'analysis'));
  fs.writeFileSync(path.join(root, 'analysis/securecrt-settings-0.8.1-evidence.json'), JSON.stringify({ records: [{ subject: { name: 'SecureCRT.exe', digest: { sha256: 'a'.repeat(64) } }, evidence_id: 'synthetic-evidence' }] }));
  assert.deepEqual(historicalReference(root), { sha256: 'a'.repeat(64), evidenceId: 'synthetic-evidence', source: 'analysis/securecrt-settings-0.8.1-evidence.json', historicalOnly: true });
});


test('ZIP-only manifest ignores a stale same-version portable and waits for fuse verification', async t => {
  const root=temporary(t), dir=path.join(root,'custom output','win-unpacked'), output=path.dirname(dir);
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/main.cjs'),'main');fs.writeFileSync(path.join(root,'package-lock.json'),'lock');
  const zipName = 'SessionDock.zip';
  const portableName = `SessionDock-${require('../package.json').version}-portable.exe`;
  fs.writeFileSync(path.join(dir,'SessionDock.exe'),'app');
  const made=spawnSync(path.resolve('assets/python-runtime/python.exe'),['-B','-c',"import importlib.util,sys;s=importlib.util.spec_from_file_location('f',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.make_zip(sys.argv[2],sys.argv[3])",path.resolve('tests/updater_helper.py'),path.join(output,zipName),require('../package.json').version],{encoding:'utf8',windowsHide:true});assert.equal(made.status,0,made.stderr);
  fs.writeFileSync(path.join(output,portableName),'stale');
  const script=path.join(root,'check.cjs');
  fs.writeFileSync(script, "const M=require('node:module'),o=M._load; M._load=function(n,...a){if(n==='./package-security.cjs')return {verifyFuses:async()=>{await new Promise(r=>setTimeout(r,20));return {checked:true}}};if(n==='./verify-release-signature.cjs')return {signatureStatus:()=>({status:'fixture'})};return o.call(this,n,...a)}; require("+JSON.stringify(path.resolve(__dirname,'../scripts/release-manifest.cjs'))+").writeManifest({project:"+JSON.stringify(root)+",directory:"+JSON.stringify(dir)+"}).catch(e=>{console.error(e);process.exitCode=1})");
  const result=spawnSync(process.execPath,[script],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'release-manifest.json'),'utf8'));assert.deepEqual(manifest.artifacts.map(a=>a.kind),['zip']);assert.equal(manifest.file,zipName);assert.equal(manifest.fuses.checked,true);assert(!manifest.signatures.portable);
  assert(!fs.readFileSync(path.join(output,'SHA256SUMS.txt'),'utf8').includes('portable'));
});

test('the default Windows target is directory only',()=>{
  const options=buildOptions([],{});const targets=options.targets.get(require('electron-builder').Platform.WINDOWS);assert.deepEqual([...targets.get(require('electron-builder').Arch.x64)],['dir']);
});

test('manifest rejects invalid artifact kinds before looking for files', async t => {
  const { writeManifest } = require('../scripts/release-manifest.cjs');
  const root = temporary(t);
  for (const kinds of [null, 42, {}, 'zip', [], ['invalid']]) {
    await assert.rejects(writeManifest({ project: root, directory: path.join(root, 'win-unpacked'), kinds }),
      error => error.constructor === Error && /종류가 올바르지 않습니다/.test(error.message));
  }
  await assert.rejects(writeManifest({ project: root, directory: path.join(root, 'win-unpacked'), kinds: ['zip'] }), /산출물을 찾지 못했습니다/);
});

