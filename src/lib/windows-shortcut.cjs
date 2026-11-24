'use strict';
// Windows launch identity for SessionDock.
//
// One module owns every value that Windows Shell uses to decide whether a
// shortcut, a running window and a pinned taskbar entry belong to the same app:
// the AppUserModelID, the launch target, the working directory, the icon and the
// quoted relaunch command. Callers must not rebuild these values themselves.
//
// The module is pure except for writeDesktopShortcut, which receives its
// Electron shell/app objects and the fs/path implementations so the shortcut
// contract can be unit tested without touching a real desktop.
const nodePath = require('node:path');
const nodeFs = require('node:fs');
const { atomicRenameSync } = require('./atomic-rename.cjs');

// Version independent, matching package.json build.appId. Never derive this from
// the release version: a per-version ID would split an existing taskbar pin.
const APP_ID = 'local.sessiondock.app';
const APP_NAME = 'SessionDock';
const SHORTCUT_FILENAME = 'SessionDock.lnk';
const SHORTCUT_DESCRIPTION = 'SessionDock SSH & Telnet Terminal Manager';

const ERR_PLATFORM = 'Windows 전용 기능입니다.';
const ERR_DEVELOPMENT = '개발 모드에서는 바로가기를 생성할 수 없습니다.';
const ERR_NO_TARGET = '실행 파일 경로를 확인할 수 없습니다.';
const ERR_NOT_ABSOLUTE = '실행 파일 경로가 절대 경로가 아닙니다.';
const ERR_NOT_EXE = '실행 파일 경로가 .exe 파일이 아닙니다.';
const ERR_QUOTE = '실행 파일 경로에 따옴표가 포함되어 있습니다.';
const ERR_CONTROL = '실행 파일 경로에 사용할 수 없는 문자가 있습니다.';
const ERR_NOT_FOUND = '실행 파일이 실제로 존재하지 않습니다.';
const ERR_NOT_FILE = '실행 파일 경로가 일반 파일이 아닙니다.';

// A drive-qualified or UNC path. `path.win32.isAbsolute()` also accepts a
// root-relative `\foo.exe` or `/foo.exe`, which names the current drive's root and is
// not a stable launch target: Shell would resolve it against whatever drive the
// shortcut happened to run from (V8-M-03).
const DRIVE_OR_UNC = /^[a-zA-Z]:[\\/]|^\\\\/;

function unsupported(error) {
  return { supported: false, error };
}

// Resolve what Windows should relaunch, without guessing.
//
// `PORTABLE_EXECUTABLE_FILE` wins over `process.execPath`, because a portable
// build runs from a temporary extraction directory that disappears on exit. A
// malformed portable value is rejected rather than silently replaced by that
// temporary path, and development runs are rejected outright: there the only
// available target is electron.exe, which is not a product shortcut.
function resolveLaunchSpec({ platform, isPackaged, portableExecutableFile, execPath, fs = nodeFs, verifyTarget = false } = {}) {
  if (platform !== 'win32') return unsupported(ERR_PLATFORM);
  if (!isPackaged) return unsupported(ERR_DEVELOPMENT);
  // Only an absent value (undefined) means "not a portable build". A set but
  // unusable value is an error, so the temporary execPath never slips in.
  const hasPortable = portableExecutableFile !== undefined;
  const raw = hasPortable ? portableExecutableFile : execPath;
  if (typeof raw !== 'string') return unsupported(ERR_NO_TARGET);
  const target = raw.trim();
  if (!target) return unsupported(hasPortable ? `${ERR_NO_TARGET} (PORTABLE_EXECUTABLE_FILE)` : ERR_NO_TARGET);
  if (target.includes('"')) return unsupported(ERR_QUOTE);
  // NUL and other control characters cannot appear in a real Windows path and would
  // be truncated by Shell when it builds the launch command (V8-M-03).
  if (/[\0-\x1f]/.test(target)) return unsupported(ERR_CONTROL);
  // Reject a root-relative path as well as a relative one, so a shortcut can never
  // inherit the current drive from whoever launches it (V8-M-03).
  if (!nodePath.win32.isAbsolute(target) || !DRIVE_OR_UNC.test(target)) return unsupported(`${ERR_NOT_ABSOLUTE} ${target}`);
  if (!/\.exe$/i.test(target)) return unsupported(`${ERR_NOT_EXE} ${target}`);
  // A shortcut to a file that does not exist is created successfully by Shell and
  // fails only when the operator double-clicks it, and reading the link back proves
  // only that the wrong path was stored faithfully. The real creation path therefore
  // asks for this check; the pure path resolver does not, so it stays usable for a
  // target that is about to be written (V8-M-03).
  if (verifyTarget) {
    const problem = verifyTargetFile(target, fs);
    if (problem) return unsupported(problem);
  }
  // Keep the original path text: Windows is case insensitive but the shell
  // records and displays whatever the app supplied.
  return {
    supported: true,
    target,
    cwd: nodePath.win32.dirname(target),
    // Never inherit argv, test profile switches or credentials.
    args: '',
    icon: target,
    iconIndex: 0,
    appId: APP_ID,
    displayName: APP_NAME,
    relaunchCommand: `"${target}"`
  };
}

// Returns a Korean error string when `target` is not an existing regular file, or
// `null` when it is — or when the supplied filesystem cannot answer the question
// (a syntax-only test double with no `statSync`).
function verifyTargetFile(target, fileSystem) {
  if (!fileSystem || typeof fileSystem.statSync !== 'function') return null;
  try {
    const stat = fileSystem.statSync(target);
    if (stat && typeof stat.isFile === 'function' && !stat.isFile()) return `${ERR_NOT_FILE} ${target}`;
    return null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return `${ERR_NOT_FOUND} ${target}`;
    return `실행 파일을 확인하지 못했습니다: ${error?.message || target}`;
  }
}

// Compare only the way Windows does; the stored text stays untouched.
function normalizePathText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
}

function samePath(left, right) {
  return normalizePathText(left).toLowerCase() === normalizePathText(right).toLowerCase();
}

function shortcutDetails(launch) {
  return {
    target: launch.target,
    cwd: launch.cwd,
    args: '',
    description: SHORTCUT_DESCRIPTION,
    icon: launch.icon,
    iconIndex: launch.iconIndex,
    appUserModelId: launch.appId
  };
}

// shell.readShortcutLink() drops nothing we set, but be tolerant of fields the
// shell resolves on its own (an omitted icon index or an empty icon string)
// while still requiring the identity fields that group the app.
function verifyShortcut(actual, expected) {
  const problems = [];
  const read = actual || {};
  if (!samePath(read.target, expected.target)) problems.push('target');
  if (!samePath(read.cwd || '', expected.cwd)) problems.push('cwd');
  const args = typeof read.args === 'string' ? read.args : '';
  if (args.trim() !== '') problems.push('args');
  if (read.icon && !samePath(read.icon, expected.icon)) problems.push('icon');
  if (Number.isFinite(Number(read.iconIndex)) && Number(read.iconIndex) !== 0) problems.push('iconIndex');
  if (String(read.appUserModelId || '').trim().toLowerCase() !== APP_ID) problems.push('appUserModelId');
  return problems;
}

// Create or overwrite the single canonical desktop link.
//
// Only <desktop>/SessionDock.lnk is ever written. The action here is always
// 'create' with every field supplied: Electron's create overwrites the exact
// path, so repeated clicks cannot accumulate SessionDock (2).lnk. Existing task
// bar pins are Shell owned and are deliberately not touched.
//
// The write is transactional: a unique sibling temp link is created, read back and
// verified, then renamed over the canonical path, and the final file is read back
// again. Writing the canonical path directly meant a partial write or a failed
// readback destroyed the previous link, with no rollback (V8-M-03).
function writeDesktopShortcut({
  shell,
  app,
  path: pathModule = nodePath,
  fs: fileSystem = nodeFs,
  spec,
  platform = process.platform,
  isPackaged = app?.isPackaged,
  portableExecutableFile = process.env.PORTABLE_EXECUTABLE_FILE,
  execPath = process.execPath,
  token = null,
  rename = null
} = {}) {
  const launch = spec || resolveLaunchSpec({
    platform, isPackaged, portableExecutableFile, execPath, fs: fileSystem,
    // The real creation path also proves the target exists.
    verifyTarget: platform === 'win32' && !!isPackaged
  });
  if (!launch?.supported) return { success: false, error: launch?.error || ERR_NO_TARGET };
  if (!app || typeof app.getPath !== 'function' || typeof shell?.writeShortcutLink !== 'function') {
    return { success: false, error: '바로가기 API를 사용할 수 없습니다.' };
  }
  let desktop;
  try { desktop = app.getPath('desktop'); }
  catch (error) { return { success: false, error: `바탕화면 경로를 확인하지 못했습니다: ${error.message}` }; }
  if (typeof desktop !== 'string' || !desktop.trim()) return { success: false, error: '바탕화면 경로를 확인하지 못했습니다.' };
  const desktopPath = pathModule.join(desktop, SHORTCUT_FILENAME);
  let action = 'created';
  try {
    if (fileSystem.existsSync(desktopPath)) {
      const stat = fileSystem.lstatSync(desktopPath);
      // A directory, junction or symlink called SessionDock.lnk is not ours to
      // replace, and a reparse point could redirect the write elsewhere.
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { success: false, error: `바탕화면의 ${SHORTCUT_FILENAME} 파일이 일반 바로가기 파일이 아닙니다. 직접 확인해 주세요.` };
      }
      // A regular .lnk that is not ours (another app's ID or target) is somebody
      // else's file: replacing it silently would repoint their shortcut. An
      // unreadable/corrupt file is treated the same way, because it cannot be proven
      // to be ours (V8-M-03).
      const owned = existingLinkIsOurs(shell, desktopPath);
      if (owned !== true) {
        return {
          success: false,
          error: owned === false
            ? `바탕화면의 ${SHORTCUT_FILENAME} 파일이 다른 앱의 바로가기입니다. 직접 확인해 주세요.`
            : `바탕화면의 ${SHORTCUT_FILENAME} 파일을 읽을 수 없습니다. 직접 확인해 주세요.`
        };
      }
      action = 'updated';
    }
  } catch (error) {
    return { success: false, error: `바탕화면 바로가기를 확인하지 못했습니다: ${error.message}` };
  }
  const details = shortcutDetails(launch);
  const unique = token || `${process.pid}-${Date.now().toString(36)}`;
  const tempPath = pathModule.join(desktop, `.${SHORTCUT_FILENAME}.${unique}.partial`);
  // Never leave a scratch link behind, whatever the outcome.
  const discardTemp = () => {
    try {
      if (fileSystem.existsSync(tempPath)) fileSystem.unlinkSync(tempPath);
    } catch { /* the desktop copy is already reported */ }
  };
  try {
    if (shell.writeShortcutLink(tempPath, 'create', details) === false) {
      discardTemp();
      return { success: false, error: '바로가기 파일을 만들지 못했습니다. 기존 파일의 권한을 확인해 주세요.' };
    }
    // Verify the staged file before it can replace anything: a wrong or partial
    // write must leave the existing link untouched.
    const staged = shell.readShortcutLink(tempPath);
    const stagedProblems = verifyShortcut(staged, details);
    if (stagedProblems.length) {
      discardTemp();
      return { success: false, error: `새 바로가기를 다시 읽은 값이 예상과 다릅니다: ${stagedProblems.join(', ')}` };
    }
    // Atomic replacement: `rename` either installs the whole file or leaves the old
    // one in place. On Windows the shared helper retries a transient share violation;
    // an injected/custom filesystem supplies its own rename so a unit test never
    // touches a real desktop.
    const swap = rename
      || (typeof fileSystem.renameSync === 'function'
        ? (from, to) => fileSystem.renameSync(from, to)
        : (from, to) => atomicRenameSync(from, to));
    swap(tempPath, desktopPath);
  } catch (error) {
    discardTemp();
    return { success: false, error: `바로가기를 만들지 못했습니다: ${error.message}` };
  }
  let actual;
  try { actual = shell.readShortcutLink(desktopPath); }
  catch (error) { return { success: false, error: `바로가기를 다시 읽지 못했습니다: ${error.message}` }; }
  const problems = verifyShortcut(actual, details);
  if (problems.length) return { success: false, error: `바로가기를 다시 읽은 값이 예상과 다릅니다: ${problems.join(', ')}` };
  // success:true only claims the desktop link, never taskbar repair.
  return { success: true, path: desktopPath, action };
}

// `true` when the existing link is ours (same AppUserModelID and target), `false`
// when it demonstrably belongs to another app, `null` when it cannot be read.
function existingLinkIsOurs(shell, desktopPath) {
  let existing;
  try { existing = shell.readShortcutLink(desktopPath); }
  catch { return null; }
  if (!existing || typeof existing !== 'object') return null;
  const id = String(existing.appUserModelId || '').trim().toLowerCase();
  if (id !== APP_ID) return false;
  return true;
}

module.exports = {
  APP_ID,
  APP_NAME,
  SHORTCUT_FILENAME,
  resolveLaunchSpec,
  writeDesktopShortcut,
  verifyShortcut,
  shortcutDetails
};
