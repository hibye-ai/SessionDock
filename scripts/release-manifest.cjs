'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { packagedDirectory } = require('./packaged-location.cjs');
const { verifyFuses } = require('./package-security.cjs');
const { signatureStatus } = require('./verify-release-signature.cjs');
const packageInfo = require('../package.json');
const signing = require('./release-integrity.cjs');
const { atomicRenameSync } = require('../src/lib/atomic-rename.cjs');
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

function historicalReference(project) {
  const filename = path.join(project, 'analysis/securecrt-settings-0.8.1-evidence.json');
  if (!fs.existsSync(filename)) return null;
  const record = JSON.parse(fs.readFileSync(filename, 'utf8')).records?.find(record => record.subject?.name === 'SecureCRT.exe');
  const sha256 = record?.subject?.digest?.sha256;
  if (!/^[a-f\d]{64}$/i.test(sha256 || '')) throw new Error('과거 분석 기록의 SHA256이 올바르지 않습니다.');
  return { sha256, evidenceId: record.evidence_id, source: 'analysis/securecrt-settings-0.8.1-evidence.json', historicalOnly: true };
}

// Describes one published file. `signatureStatus` reads the file itself, so the
// manifest can never claim a signature the binary does not carry.
function artifactRecord(file, kind) {
  const stat = fs.statSync(file);
  return { kind, file: path.basename(file), bytes: stat.size, sha256: hash(file), authenticode: signatureStatus(file) };
}

// Existing candidates, ordered for the legacy single-artifact fields.
function discoverArtifacts(outputDirectory, version) {
  return [
    { kind: 'portable', file: path.join(outputDirectory, `SessionDock-${version}-portable.exe`) },
    { kind: 'zip', file: path.join(outputDirectory, 'SessionDock.zip') }
  ].filter(candidate => fs.existsSync(candidate.file));
}

async function main() {
  const project = path.resolve(__dirname, '..'), directory = packagedDirectory();
  await writeManifest({ project, directory });
}

// Called by the release build inline, right after the last artifact is written, so the
// manifest always describes the build that just finished instead of a separate step an
// operator can forget (V8-M-08). Async because the fuses readback is async.
async function writeManifest({ project = path.resolve(__dirname, '..'), directory = packagedDirectory(), kinds = ['zip'], env = process.env, buildID } = {}) {
  if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !['zip', 'portable'].includes(kind))) throw new Error('요청한 배포 산출물 종류가 올바르지 않습니다.');
  const destination = path.dirname(directory);
  const artifacts = discoverArtifacts(destination, packageInfo.version).filter(artifact => kinds.includes(artifact.kind));
  if (kinds.some(kind => !artifacts.some(artifact => artifact.kind === kind))) throw new Error('요청한 배포 산출물을 찾지 못했습니다.');
  // The instant-startup archive is now part of the release. Omitting it here silently
  // would re-create the "which artifact is the approved one" ambiguity this manifest
  // exists to remove (V8-M-08), so a missing ZIP fails closed.
  if (!artifacts.some(artifact => artifact.kind === 'zip')) {
    throw new Error('즉시 실행 ZIP(SessionDock.zip)이 없어 매니페스트를 만들지 않습니다.');
  }
  if (require('./publish-portable.cjs').zipVersion(artifacts.find(artifact => artifact.kind === 'zip').file) !== packageInfo.version) throw new Error('ZIP의 제품 또는 버전이 빌드와 다릅니다.');
  const zip = artifacts.find(artifact => artifact.kind === 'zip').file;
  buildID = 'sha256-' + signing.fileDigest(zip).sha256;
  const release = signing.createManifest({ zip, version: packageInfo.version, buildID });
  const signedBytes = signing.manifestBytes(release);
  signing.verifyRelease({ manifestBytes: signedBytes, zip, expectedVersion: packageInfo.version, expectedBuildID: buildID });
  const records = artifacts.map(artifact => artifactRecord(artifact.file, artifact.kind));
  const reference = historicalReference(project);
  const application = path.join(directory, 'SessionDock.exe');
  const manifest = {
    product: 'SessionDock', version: packageInfo.version, platform: 'Windows x64', builtAt: new Date().toISOString(),
    // Each requested artifact has its own hash; the default release contains the ZIP.
    artifacts: records,
    buildID, releaseIntegrity: { artifact: 'SessionDock.zip', algorithm: 'SHA256', sourceAuthenticated: false },
    // Legacy single-artifact fields describe the first record: ZIP by default,
    // or portable when both kinds were explicitly requested.
    file: records[0].file, bytes: records[0].bytes, sha256: records[0].sha256,
    sourceEntrySha256: hash(path.join(project, 'src/main.cjs')), packageLockSha256: hash(path.join(project, 'package-lock.json')),
    signatures: { ...(records.find(record => record.kind === 'portable') ? { portable: records.find(record => record.kind === 'portable').authenticode } : {}), application: signatureStatus(application) },
    fuses: fs.existsSync(application) ? await verifyFuses(application) : null,
    historicalSecureCrtReference: reference, originalSecureCrtSha256: reference?.sha256 ?? null
  };
  // Local audit report only. No distribution sidecar is generated.
  if (signing.fileDigest(zip).sha256 !== release.zip.sha256) throw new Error('ZIP changed during audit generation.');
  fs.writeFileSync(path.join(destination, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'),
    records.map(record => `${record.sha256}  ${record.file}`).join('\n') + '\n');
  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}
if (require.main === module) main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
module.exports = { historicalReference, discoverArtifacts, artifactRecord, writeManifest };
