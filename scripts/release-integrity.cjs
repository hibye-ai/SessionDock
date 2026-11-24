'use strict';
// Release integrity metadata only. SHA256 is not source authentication.
const fs = require('node:fs');
const crypto = require('node:crypto');
const MANIFEST_FILE = 'SessionDock.release.json';
const SIGNATURE_FILE = 'SessionDock.release.sig'; // historical filename only: archive preservation / stale-output cleanup
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const fail = message => { throw new Error(message); };

function fileDigest(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Release file must be a regular, non-link file.');
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let size = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, count)); size += count; }
    const after = fs.fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('Release file changed while hashing.');
    return { size, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
function validateManifest(m) {
  if (!exactKeys(m, ['schemaVersion', 'product', 'platform', 'version', 'buildID', 'zip']) || m.schemaVersion !== 1 || m.product !== 'SessionDock' || m.platform !== 'win32-x64' || typeof m.version !== 'string' || !VERSION.test(m.version) || typeof m.buildID !== 'string' || !BUILD_ID.test(m.buildID) || !exactKeys(m.zip, ['file', 'size', 'sha256']) || m.zip.file !== 'SessionDock.zip' || !Number.isSafeInteger(m.zip.size) || m.zip.size <= 0 || m.zip.size > 2 * 1024 ** 3 || typeof m.zip.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.zip.sha256)) fail('Invalid release manifest schema.');
  return m;
}
function manifestBytes(manifest) {
  const m = validateManifest(manifest);
  // Fixed insertion order, compact JSON, UTF-8, exactly one LF, no BOM.
  return Buffer.from(JSON.stringify({ schemaVersion: 1, product: m.product, platform: m.platform, version: m.version, buildID: m.buildID, zip: { file: m.zip.file, size: m.zip.size, sha256: m.zip.sha256 } }) + '\n', 'utf8');
}
function parseManifest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096) fail('Release manifest must be bounded exact bytes.');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('Invalid release manifest JSON.'); }
  if (!manifestBytes(manifest).equals(bytes)) fail('Non-canonical release manifest bytes.');
  return manifest;
}
function createManifest({ zip, version, buildID }) {
  return validateManifest({ schemaVersion: 1, product: 'SessionDock', platform: 'win32-x64', version, buildID, zip: { file: 'SessionDock.zip', ...fileDigest(zip) } });
}
// Integrity only: no publisher/source authentication.
function verifyRelease({ manifestBytes: bytes, zip, expectedVersion, expectedBuildID }) {
  const manifest = parseManifest(bytes);
  if ((expectedVersion !== undefined && manifest.version !== expectedVersion) || (expectedBuildID !== undefined && manifest.buildID !== expectedBuildID)) fail('Release manifest identity mismatch.');
  const digest = fileDigest(zip);
  if (digest.size !== manifest.zip.size || digest.sha256 !== manifest.zip.sha256) fail('Release ZIP size/SHA256 mismatch.');
  return manifest;
}
module.exports = { MANIFEST_FILE, SIGNATURE_FILE, fileDigest, createManifest, manifestBytes, parseManifest, verifyRelease };
