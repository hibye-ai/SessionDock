'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function validRoot(root, token, install, user, allowMissing = false) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || !/^[0-9a-f]{64}$/.test(token || '')) return false;
  const norm = value => path.resolve(value).toLowerCase();
  if (norm(path.dirname(root)) !== norm(os.tmpdir()) || !/^sessiondock-update-[A-Za-z0-9_-]+$/.test(path.basename(root))) return false;
  for (const protectedPath of [install, user]) {
    const rel = path.relative(norm(root), norm(protectedPath));
    const reverse = path.relative(norm(protectedPath), norm(root));
    if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) || !reverse || (!reverse.startsWith('..' + path.sep) && reverse !== '..' && !path.isAbsolute(reverse))) return false;
  }
  try {
    if (allowMissing && !fs.existsSync(root)) {
      for (let p = path.dirname(root); ; p = path.dirname(p)) {
        const stat = fs.lstatSync(p);
        if (stat.isSymbolicLink() || stat.isReparsePoint?.()) return false;
        if (path.dirname(p) === p) break;
      }
      return true;
    }
    for (let p = root; ; p = path.dirname(p)) {
      if (fs.lstatSync(p).isSymbolicLink() || (fs.lstatSync(p).isReparsePoint?.())) return false;
      if (path.dirname(p) === p) break;
    }
    const marker = path.join(root, '.sessiondock-update-owner.json');
    if (fs.lstatSync(marker).isSymbolicLink()) return false;
    return JSON.stringify(JSON.parse(fs.readFileSync(marker, 'utf8'))) === JSON.stringify({ token });
  } catch { return false; }
}

function createRestartReceipt({ root, token, installDir, userDataDir, version, pid = process.pid }) {
  if (!validRoot(root, token, installDir, userDataDir)) return null;
  let shown = false, rendererReady = false, completed = false;
  function confirm() {
    if (completed || !shown || !rendererReady) return completed;
    try {
      if (!validRoot(root, token, installDir, userDataDir)) return false;
      fs.writeFileSync(path.join(root, 'restart-receipt.json'), JSON.stringify({ token, pid, version }), { flag: 'wx' });
      completed = true; return true;
    } catch (error) { console.error('업데이트 재시작 확인 실패:', error.message); }
    return false;
  }
  return { shown() { shown = true; confirm(); }, rendererReady() { rendererReady = true; confirm(); }, isConfirmed() { return completed; }, token };
}

function retryCleanup({ installDir, userDataDir }) {
  try {
    const pending = path.join(userDataDir, 'update-cleanup-pending.json');
    if (fs.lstatSync(pending).isSymbolicLink()) return;
    const data = JSON.parse(fs.readFileSync(pending, 'utf8'));
    if (data.installDir !== installDir || data.userDataDir !== userDataDir || !Number.isSafeInteger(data.helperPid) || data.helperPid <= 0 || !validRoot(data.root, data.token, installDir, userDataDir, true)) return;
    const child = spawn(path.join(installDir, 'resources', 'python-runtime', 'pythonw.exe'), ['-I', '-S', path.join(installDir, 'resources', 'automation', 'update_helper.py'), 'cleanup'], { windowsHide: true, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', error => console.error('업데이트 정리 재시도 실패:', error.message));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(data)); child.unref();
  } catch (error) { if (error.code !== 'ENOENT') console.error('업데이트 정리 확인 실패:', error.message); }
}
module.exports = { createRestartReceipt, retryCleanup, validRoot };
