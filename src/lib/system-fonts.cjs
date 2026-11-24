'use strict';
const { execFile } = require('node:child_process');
const { systemPowerShell } = require('./windows-system-tools.cjs');
const { FONT_SUGGESTIONS } = require('./terminal-appearance.cjs');
let pending;
// Fixed read-only query; no renderer input becomes shell text. Cache per process.
function systemFonts() {
  if (pending) return pending;
  pending = new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ families: FONT_SUGGESTIONS, available: false });
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Drawing; $fonts = New-Object System.Drawing.Text.InstalledFontCollection; try { ConvertTo-Json -Compress -InputObject @($fonts.Families | ForEach-Object { $_.Name } | Sort-Object -Unique) } finally { $fonts.Dispose() }";
    try {
      const executable = systemPowerShell(process.env.SystemRoot);
      execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, output) => {
        try {
          if (error) throw error;
          const names = JSON.parse(output.replace(/^\uFEFF/, ''));
          if (!Array.isArray(names) || names.length > 5000) throw new Error('Invalid fonts');
          const families = names.filter(name => typeof name === 'string' && name.length <= 128 && !/[\x00-\x1f\x7f"\\,;{}<>]/.test(name));
          resolve({ families, available: families.length > 0 });
        } catch { resolve({ families: FONT_SUGGESTIONS, available: false }); }
      });
    } catch { resolve({ families: FONT_SUGGESTIONS, available: false }); }
  });
  return pending;
}
module.exports = { systemFonts };
