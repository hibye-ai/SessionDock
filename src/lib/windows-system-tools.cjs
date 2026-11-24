'use strict';
const path = require('node:path');
// Shared SystemRoot resolver extracted from the PuTTY reader. Never search PATH
// or cwd. Reject drive-relative, root-relative, UNC and malformed environment.
function systemPowerShell(systemRoot) {
  if (typeof systemRoot !== 'string' || !/^[a-z]:[\\/]/i.test(systemRoot)
      || /[\x00-\x1f\x7f"<>|?*;%]/.test(systemRoot)
      || systemRoot.slice(2).includes(':')
      || systemRoot.slice(3).split(/[\\/]/).some(part => part === '.' || part === '..' || /[ .]$/.test(part))) {
    throw new Error('Windows system path is unavailable.');
  }
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
module.exports = { systemPowerShell };
