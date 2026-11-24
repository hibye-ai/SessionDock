'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packagedDirectory } = require('./packaged-location.cjs');
const { version } = require('../package.json');

function signatureStatus(filename) {
  if (process.platform !== 'win32') return 'Unavailable';
  // A Node child can inherit PowerShell 7's module search path. Import the
  // Windows PowerShell built-in module explicitly instead of autoloading it.
  const command = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); '
    + 'Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); '
    + '(Get-AuthenticodeSignature -LiteralPath $env:SESSIONDOCK_SIGNATURE_TARGET).Status.ToString()';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, SESSIONDOCK_SIGNATURE_TARGET: path.resolve(filename) }, encoding: 'utf8', windowsHide: true, timeout: 30000
  }).trim();
}
function verify(directory = packagedDirectory()) {
  const portable = path.join(path.dirname(directory), `SessionDock-${version}-portable.exe`);
  const files = [path.join(directory, 'SessionDock.exe'), portable];
  const statuses = files.map(file => ({ file: path.basename(file), status: fs.existsSync(file) ? signatureStatus(file) : 'Missing' }));
  if (statuses.some(item => item.status !== 'Valid')) throw new Error('배포 서명이 유효하지 않습니다: ' + statuses.map(item => `${item.file}: ${item.status}`).join(', '));
  console.log(JSON.stringify({ passed: true, signatures: statuses }, null, 2));
}
if (require.main === module) try { verify(); } catch (error) { console.error(error.message); process.exitCode = 1; }
module.exports = { signatureStatus, verify };
