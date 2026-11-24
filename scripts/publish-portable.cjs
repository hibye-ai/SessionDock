'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicRenameSync } = require('../src/lib/atomic-rename.cjs');
function executeAccess(file, checkOnly=false) {
  if(process.platform!=='win32'){
    const stat=fs.statSync(file);if(!checkOnly)fs.chmodSync(file,stat.mode|((stat.mode&0o444)>>2));fs.accessSync(file,fs.constants.X_OK);return {verified:true};
  }
  const {execFileSync}=require('node:child_process');
  const command='& {\n'+fs.readFileSync(path.join(__dirname,'portable-execute-access.ps1'),'utf8')+"\n} -FilePath $env:SESSIONDOCK_ACCESS_FILE -CheckOnly:($env:SESSIONDOCK_ACCESS_CHECK -eq '1')";
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,SESSIONDOCK_ACCESS_FILE:path.resolve(file),SESSIONDOCK_ACCESS_CHECK:checkOnly?'1':'0'},encoding:'utf8',windowsHide:true,timeout:30000}).trim());
}

const VERSION = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const portablePattern = new RegExp(`^SessionDock-(${VERSION})-portable\\.exe(?:\\.blockmap|\\.sha256)?$`);
// Keep legacy artifact classification for downgrade detection, never cleanup.
const zipPattern = new RegExp(`^SessionDock-(${VERSION})\\.zip$`);
const UNPACKED = 'win-unpacked';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const older = (a, b) => { const aa=a.split('.').map(BigInt), bb=b.split('.').map(BigInt); for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]<bb[i]; return false; };
// Which distribution artifact a name is, and for which version. `kind` matters
// because an old archive is a file like a portable, not a release folder.
function artifactOf(name) {
  const portableMatch = portablePattern.exec(name);
  if (portableMatch) return { kind: 'portable', version: portableMatch[1] };
  const zipMatch = zipPattern.exec(name);
  if (zipMatch) return { kind: 'zip', version: zipMatch[1] };
  return null;
}
function directory(root) {
  root=path.resolve(root);const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`일반 배포 폴더가 아닙니다: ${root}`);
  return fs.realpathSync(root);
}
function directChild(root, name) {
  const target=path.resolve(root,name);
  if(path.dirname(target)!==root||path.basename(target)!==name)throw new Error('배포 정리 경로가 허용 폴더를 벗어났습니다.');
  return target;
}
function regular(file) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`일반 배포 파일이 아닙니다: ${file}`);
  return stat;
}
// Archive the packaged tree so an operator can extract once and launch the real
// executable: no per-launch SFX extraction, and the same ASAR/fuses/signature as the
// portable because it is the identical `win-unpacked` directory.
//
// `Compress-Archive` is used on Windows (always present, no external dependency) and
// `zip` elsewhere. The *contents* of the packaged tree are archived, so extracting
// yields `<folder>/SessionDock.exe` — the launch target the shortcut and the taskbar
// pin expect — instead of nesting a `win-unpacked` directory inside the chosen folder.
function createZip({ sourceDirectory, destination, compress = null } = {}) {
  const { execFileSync } = require('node:child_process');
  const parent = path.dirname(sourceDirectory), base = path.basename(sourceDirectory);
  if (typeof compress === 'function') { compress({ sourceDirectory, parent, base, destination }); return destination; }
  if (process.platform === 'win32') {
    const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:SESSIONDOCK_ZIP_SOURCE,$env:SESSIONDOCK_ZIP_TARGET,[IO.Compression.CompressionLevel]::Optimal,$false)";
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, SESSIONDOCK_ZIP_SOURCE: sourceDirectory, SESSIONDOCK_ZIP_TARGET: destination },
      windowsHide: true, timeout: 600000
    });
  } else {
    execFileSync('zip', ['-r', '-q', '-X', destination, '.'], { cwd: sourceDirectory, timeout: 600000 });
  }
  return destination;
}

function publishPortable() {
  throw new Error('Legacy portable publishing is disabled; use ZIP publishZip().');
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--allow-version-reset') || args.length > 1) throw new Error('지원하지 않는 게시 인자.');
    const report = publishZip({ allowVersionReset: args.includes('--allow-version-reset') });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error('ZIP 게시 실패: ' + error.message); process.exitCode = 1; }
}

function treeHashes(root) {
  root=directory(root);const result={},pending=[root];
  while(pending.length){const parent=pending.pop();for(const name of fs.readdirSync(parent)){const child=directChild(parent,name),stat=fs.lstatSync(child);if(stat.isSymbolicLink())throw new Error('패키지에 링크가 있습니다.');if(stat.isDirectory())pending.push(child);else if(stat.isFile())result[path.relative(root,child).replaceAll('\\','/')]=hash(child);else throw new Error('패키지에 특수 파일이 있습니다.');}}
  return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
const sameTree=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function verifyZip({sourceDirectory,zip,extract=null}={}) {
  const os=require('node:os'),{execFileSync}=require('node:child_process'),before=treeHashes(sourceDirectory);
  if(!before['SessionDock.exe']||!before['resources/app.asar'])throw new Error('패키지 실행 파일 또는 소스 ASAR가 없습니다.');
  regular(zip);const zipHash=hash(zip),temp=fs.mkdtempSync(path.join(os.tmpdir(),'sessiondock-zip-verify-'));
  try{
    if(extract)extract({zip,destination:temp});
    else if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:SESSIONDOCK_VERIFY_ZIP,$env:SESSIONDOCK_VERIFY_DIR)"],{env:{...process.env,SESSIONDOCK_VERIFY_ZIP:zip,SESSIONDOCK_VERIFY_DIR:temp},windowsHide:true,timeout:600000});
    else execFileSync('unzip',['-q',zip,'-d',temp],{timeout:600000});
    if(!sameTree(before,treeHashes(temp))||!sameTree(before,treeHashes(sourceDirectory))||hash(zip)!==zipHash)throw new Error('ZIP 압축 해제 파일 또는 패키지 원본의 SHA256이 다르거나 변경됐습니다.');
    return {sha256:zipHash,files:Object.keys(before).length};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function prepareZip({outputDirectory=path.resolve('dist'),version=require('../package.json').version,compress=null,extract=null}={}) {
  if(!new RegExp('^'+VERSION+'$').test(version))throw new Error('배포 버전 형식이 올바르지 않습니다.');
  outputDirectory=directory(outputDirectory);const sourceDirectory=directChild(outputDirectory,UNPACKED),target=directChild(outputDirectory,'SessionDock.zip'),temp=directChild(outputDirectory,'.SessionDock.'+crypto.randomUUID()+'.zip');
  try {
    const before = treeHashes(sourceDirectory);
    createZip({ sourceDirectory, destination: temp, compress });
    const result = verifyZip({ sourceDirectory, zip: temp, extract });
    if (!sameTree(before, treeHashes(sourceDirectory))) throw new Error('ZIP 생성 중 패키지 원본이 변경됐습니다.');
    let previous = null;
    if (fs.existsSync(target)) {
      regular(target); previous = hash(target);
      if (previous !== result.sha256 || ['SessionDock.release.json','SessionDock.release.sig'].some(n => fs.existsSync(directChild(outputDirectory,n)))) {
        const saved = archiveZip({ root: outputDirectory, target });
        for (const name of ['SessionDock.release.json','SessionDock.release.sig']) {
          const stale=directChild(outputDirectory,name);
          if (fs.existsSync(stale)) { regular(stale); const archived=directChild(saved.directory,name); regular(archived); if(hash(stale)!==hash(archived))throw new Error('Historical sidecar not preserved.'); fs.unlinkSync(stale); }
        }
      }
    }
    atomicRenameSync(temp, target, { beforeRename: () => {
      if (previous ? hash(target) !== previous : fs.existsSync(target)) throw new Error('Previous local ZIP changed.');
      if (hash(temp) !== result.sha256) throw new Error('Staged local ZIP changed.');
    } });
    if (hash(target) !== result.sha256) throw new Error('로컬 ZIP 최종 SHA256이 다릅니다.');
    return { source: target, ...result };
  } finally { if (fs.existsSync(temp) && !fs.lstatSync(temp).isSymbolicLink()) fs.unlinkSync(temp); }
}
function zipVersion(file) {
  regular(file);
  const {spawnSync}=require('node:child_process');
  const root=path.resolve(__dirname,'..'), python=path.join(root,'assets','python-runtime','python.exe'), helper=path.join(root,'assets','automation','update_helper.py');
  const result=spawnSync(python,['-I','-S',helper,'metadata'],{input:JSON.stringify({path:file}),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:65536});
  if(result.error||result.status!==0)throw new Error('기존 ZIP의 제품/버전을 확인하지 못했습니다. 기존 배포를 보존합니다.');
  let value;try{value=JSON.parse(result.stdout);}catch{throw new Error('기존 ZIP의 제품/버전을 확인하지 못했습니다.');}
  if(!value.ok||!new RegExp('^'+VERSION+'$').test(value.result?.version||''))throw new Error('기존 ZIP의 제품/버전을 확인하지 못했습니다. 기존 배포를 보존합니다.');
  return value.result.version;
}
// Append-only version+content-addressed snapshots. No retention deletion or
// overwrite, including same-version rebuilds. Filesystem ACL/WORM is operator policy.
function archiveZip({ root, target, copyFile = fs.copyFileSync }) {
  const signing = require('./release-integrity.cjs');
  regular(target);
  const version = zipVersion(target), digest = signing.fileDigest(target);
  const base = directChild(root, '.release-archive');
  if (!fs.existsSync(base)) fs.mkdirSync(base);
  if (directory(base) !== base) throw new Error('Invalid release archive directory.');
  const archive = directChild(base, `${version}-${digest.sha256}`);
  const record = { schemaVersion: 1, product: 'SessionDock', version, file: 'SessionDock.zip', size: digest.size, sha256: digest.sha256 };
  const check = dir => {
    if (directory(dir) !== dir) throw new Error('Invalid immutable archive directory.');
    const zip = directChild(dir, 'SessionDock.zip'), meta = directChild(dir, 'archive.json');
    regular(zip); regular(meta);
    const found = signing.fileDigest(zip);
    if (found.size !== digest.size || found.sha256 !== digest.sha256 || zipVersion(zip) !== version || fs.readFileSync(meta, 'utf8') !== JSON.stringify(record) + '\n') throw new Error('Immutable release archive verification failed.');
    // Historical sidecars, when present, are retained as evidence, not as trust.
    for (const name of [signing.MANIFEST_FILE, signing.SIGNATURE_FILE]) {
      const saved = directChild(dir, name);
      if (fs.existsSync(saved)) regular(saved);
    }
  };
  if (fs.existsSync(archive)) {
    try { check(archive); } catch (error) { throw new Error('Immutable release archive collision: ' + error.message); }
  } else {
    const staged = directChild(base, '.archive-' + crypto.randomUUID() + '.partial');
    fs.mkdirSync(staged);
    try {
      copyFile(target, path.join(staged, 'SessionDock.zip'), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(staged, 'archive.json'), JSON.stringify(record) + '\n', { flag: 'wx' });
      for (const name of [signing.MANIFEST_FILE, signing.SIGNATURE_FILE]) {
        const source = directChild(root, name);
        if (fs.existsSync(source)) {
          regular(source); copyFile(source, path.join(staged, name), fs.constants.COPYFILE_EXCL);
          if (hash(source) !== hash(path.join(staged, name))) throw new Error('Archive sidecar copy mismatch.');
        }
      }
      for (const name of fs.readdirSync(staged)) { const fd = fs.openSync(path.join(staged, name), 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      check(staged);
      if (fs.existsSync(archive)) throw new Error('Immutable release archive already exists.');
      fs.renameSync(staged, archive);
      check(archive);
    } finally { if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true }); }
  }
  const current = signing.fileDigest(target);
  if (current.sha256 !== digest.sha256 || current.size !== digest.size) throw new Error('Previous ZIP changed during archive.');
  return { directory: archive, ...record };
}

function publishZip({ projectRoot = path.resolve(__dirname, '..'), outputDirectory = path.join(projectRoot, 'dist'), destination = 'Z:\\', version = require('../package.json').version, copyFile = fs.copyFileSync, extract = null, allowVersionReset = false, env = process.env } = {}) {
  if (!new RegExp('^' + VERSION + '$').test(version)) throw new Error('배포 버전 형식이 올바르지 않습니다.');
  const signing = require('./release-integrity.cjs');
  projectRoot = directory(projectRoot); outputDirectory = directory(outputDirectory);
  const source = directChild(outputDirectory, 'SessionDock.zip'), unpacked = directChild(outputDirectory, UNPACKED);
  const observed = signing.fileDigest(source);
  const manifest = { buildID: 'sha256-' + observed.sha256, zip: observed };
  const verify = zip => {
    const now = signing.fileDigest(zip);
    if (now.size !== observed.size || now.sha256 !== observed.sha256 || zipVersion(zip) !== version) throw new Error('Release ZIP identity mismatch.');
    return now;
  };
  verify(source);
  destination = directory(destination);
  if (destination === outputDirectory) throw new Error('배포 목적지와 빌드 폴더는 달라야 합니다.');
  const target = directChild(destination, 'SessionDock.zip'), lock = directChild(destination, '.SessionDock-publish.lock'), token = crypto.randomUUID();
  const report = { product: 'SessionDock', version, buildID: manifest.buildID, source, target, verified: false, archived: [], removed: [], skipped: [], cleanupErrors: [], versionReset: allowVersionReset === true, previousHigherVersions: [], preservedHigherVersions: [] };
  const staged = []; let locked = false;
  try {
    const fd = fs.openSync(lock, 'wx'); locked = true; try { fs.writeFileSync(fd, token); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    let previous = null;
    if (fs.existsSync(target)) {
      regular(target); const existing = zipVersion(target); previous = signing.fileDigest(target);
      if (older(version, existing)) { if (allowVersionReset !== true) throw new Error('더 최신 버전이 있어 게시를 중단합니다.'); report.previousHigherVersions.push(existing); }
    }
    for (const name of fs.readdirSync(destination)) {
      const artifact = artifactOf(name);
      if (artifact && older(version, artifact.version)) {
        if (allowVersionReset !== true) throw new Error('더 최신 버전이 있어 게시를 중단합니다.');
        if (!report.previousHigherVersions.includes(artifact.version)) report.previousHigherVersions.push(artifact.version);
      }
    }
    const checked = verifyZip({ sourceDirectory: unpacked, zip: source, extract });
    if (checked.sha256 !== manifest.zip.sha256 || zipVersion(source) !== version) throw new Error('게시 ZIP 제품/버전/해시가 manifest와 다릅니다.');
    const stage = (name, bytes) => {
      const file = directChild(destination, '.' + name + '.' + token + '.partial'); staged.push(file);
      if (bytes) fs.writeFileSync(file, bytes, { flag: 'wx' }); else copyFile(source, file, fs.constants.COPYFILE_EXCL);
      regular(file); const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return file;
    };
    const zipTemp = stage('SessionDock.zip'); verify(zipTemp);
    if (verifyZip({ sourceDirectory: unpacked, zip: zipTemp, extract }).sha256 !== checked.sha256) throw new Error('Staged ZIP mismatch.');
    const unchangedTarget = () => {
      if (previous) { const now = signing.fileDigest(target); if (now.size !== previous.size || now.sha256 !== previous.sha256) throw new Error('Previous ZIP changed before replacement.'); }
      else if (fs.existsSync(target)) throw new Error('Unexpected ZIP appeared before replacement.');
    };
    if (previous && (previous.sha256 !== checked.sha256 || [signing.MANIFEST_FILE, signing.SIGNATURE_FILE].some(name => fs.existsSync(directChild(destination, name))))) report.archived.push(archiveZip({ root: destination, target, copyFile }));
    verify(source);
    if (verifyZip({ sourceDirectory: unpacked, zip: source, extract }).sha256 !== checked.sha256) throw new Error('Source tree changed before publish.');
    // A single atomic ZIP replacement; there is no companion manifest.
    if (!previous || previous.sha256 !== checked.sha256) atomicRenameSync(zipTemp, target, { beforeRename: () => { unchangedTarget(); verify(zipTemp); } });
    else unchangedTarget();
    verify(target);
    // Preserve historical metadata with its ZIP before retiring only old sidecars.
    for (const name of [signing.MANIFEST_FILE, signing.SIGNATURE_FILE]) {
      const stale = directChild(destination, name);
      if (fs.existsSync(stale)) {
        regular(stale);
        const saved=report.archived.at(-1); if(!saved)throw new Error('Historical sidecar has no archived ZIP.');
        const archived=directChild(saved.directory,name); regular(archived);
        if(hash(stale)!==hash(archived))throw new Error('Historical sidecar not preserved.');
        fs.unlinkSync(stale);
      }
    }
    verify(source);
    if (verifyZip({ sourceDirectory: unpacked, zip: target, extract }).sha256 !== checked.sha256) throw new Error('Final ZIP verification failed.');
    report.verified = true; report.sha256 = checked.sha256; report.bytes = manifest.zip.size; report.files = checked.files;
    // Preserve ALL historical artifacts and release folders. Retention is a
    // separate explicit operator action, never an automatic publish side effect.
    for (const root of new Set([destination, outputDirectory])) for (const name of fs.readdirSync(root)) {
      const artifact = artifactOf(name);
      if (artifact && older(version, artifact.version) && !report.preservedHigherVersions.includes(artifact.version)) report.preservedHigherVersions.push(artifact.version);
    }
    fs.writeFileSync(path.join(outputDirectory, 'release-publish.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    for (const file of staged) if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
    if (locked && fs.existsSync(lock) && fs.lstatSync(lock).isFile() && !fs.lstatSync(lock).isSymbolicLink() && fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
  }
}
module.exports={publishPortable,publishZip,prepareZip,verifyZip,treeHashes,older,executeAccess,createZip,artifactOf,zipVersion};
