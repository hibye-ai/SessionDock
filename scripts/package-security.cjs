'use strict';
const assert = require('node:assert/strict');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');

const expectedFuses = {
  RunAsNode: false, EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false, GrantFileProtocolExtraPrivileges: false
};
async function verifyFuses(executable) {
  const wire = await getCurrentFuseWire(executable), result = {};
  for (const [name, expected] of Object.entries(expectedFuses)) {
    assert.equal(wire[FuseV1Options[name]], expected ? 49 : 48, `배포 보안 fuse 불일치: ${name}`);
    result[name] = expected;
  }
  return result;
}
module.exports = { expectedFuses, verifyFuses };
