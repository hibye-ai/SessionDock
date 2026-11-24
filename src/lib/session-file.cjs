'use strict';
const fs = require('node:fs');
const { atomicRenameSync, atomicRename } = require('./atomic-rename.cjs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_FILE_BYTES, freshImportSize } = require('./session-store.cjs');
const { parseWindTermFile } = require('./windterm-import.cjs');

const LEGACY_FILE_BYTES = 8 * 1024 * 1024;
function failure(message, code = 'ERR_SESSION_FILE') { return Object.assign(new Error(message), { code }); }
function comparable(filename) {
  const resolved = path.resolve(filename);
  return process.platform === 'win32' ? resolved.replace(/[ .]+(?=[\\/]|$)/g, '').toLowerCase() : resolved;
}
function canonical(filename) {
  try { return fs.realpathSync.native(filename); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(canonical(parent), path.basename(filename));
  }
}
function identity(filename) {
  try { const stat = fs.statSync(filename, { bigint: true }); return stat.ino ? `${stat.dev}:${stat.ino}` : null; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}

// Compare both directory aliases and file identities: a junction or hard link
// must not let a user-selected output replace the live profile.
function assertOutputPath(filename, protectedFiles = []) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')) throw failure('저장 경로가 올바르지 않습니다.');
  const target = path.resolve(filename);
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(filename) || target.slice(path.parse(target).root.length).includes(':'))) {
    throw failure('일반 파일 경로를 선택해 주세요.');
  }
  const resolvedTarget = canonical(target);
  const targetPaths = new Set([comparable(target), comparable(resolvedTarget)]);
  const targetId = identity(target);
  for (const file of protectedFiles.filter(Boolean)) {
    if (targetPaths.has(comparable(file)) || targetPaths.has(comparable(canonical(path.resolve(file)))) || (targetId && targetId === identity(file))) {
      throw failure('앱이 사용 중인 설정 파일에는 저장할 수 없습니다. 다른 파일 이름을 선택해 주세요.', 'ERR_PROTECTED_OUTPUT');
    }
  }
  return resolvedTarget;
}

let activeOutputChecks = 0;
async function assertOutputPathAsync(filename, protectedFiles = [], { timeoutMs = 10000 } = {}) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')) throw failure('저장 경로가 올바르지 않습니다.');
  const target = path.resolve(filename);
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(filename) || target.slice(path.parse(target).root.length).includes(':'))) throw failure('일반 파일 경로를 선택해 주세요.');
  if (activeOutputChecks >= 2) throw failure('이전 저장 경로 확인이 아직 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.', 'ERR_OUTPUT_PATH_BUSY');
  const real = async file => {
    try { return await fs.promises.realpath(file); }
    catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code) || path.dirname(file) === file) throw error; return path.join(await real(path.dirname(file)), path.basename(file)); }
  };
  const id = async file => {
    try { const stat = await fs.promises.stat(file, {bigint:true}); return stat.ino ? `${stat.dev}:${stat.ino}` : null; }
    catch (error) { if (['ENOENT','ENOTDIR'].includes(error.code)) return null; throw error; }
  };
  activeOutputChecks++;
  let timer;
  // UNC path lookup can outlive the UI deadline. Keep its slot until actual
  // I/O finishes, so repeated clicks cannot fill the filesystem worker queue.
  const task = (async () => {
    const destination = await real(target), targetId = await id(destination);
    const candidates = new Set([comparable(target), comparable(destination)]);
    for (const file of protectedFiles.filter(Boolean)) {
      if (candidates.has(comparable(file)) || candidates.has(comparable(await real(path.resolve(file)))) || (targetId && targetId === await id(file))) {
        throw failure('앱이 사용 중인 설정 파일에는 저장할 수 없습니다. 다른 파일 이름을 선택해 주세요.', 'ERR_PROTECTED_OUTPUT');
      }
    }
    return destination;
  })().finally(() => { activeOutputChecks--; });
  try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('저장 경로 확인 시간이 초과되었습니다. 네트워크 경로를 확인해 주세요.', 'ERR_OUTPUT_PATH_TIMEOUT')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

function writeAtomicFile(filename, bytes, protectedFiles = []) {
  const target = assertOutputPath(filename, protectedFiles);
  const temporary = path.join(path.dirname(target), `.sessiondock-export-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    assertOutputPath(target, protectedFiles);
    atomicRenameSync(temporary, target);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') { /* Preserve the original write error. */ } }
  }
  return target;
}

// Non-blocking twin of `writeAtomicFile`, for the one caller that must not hold the
// main event loop: a large batch export commit. The open/write/fsync/rename chain
// used to run synchronously after the worker finished encoding, so a slow UNC path
// or a locked target stalled IPC, SSH input and cancel timers for the whole
// duration — a 300ms injected fsync produced a 325.78ms heartbeat gap (V7-M-07).
// The discipline is unchanged: same protected-path check, same temp file in the
// destination directory, same fsync-before-rename, same revalidation, same atomic
// replace, same cleanup of the temp file on failure.
async function writeAtomicFileAsync(filename, bytes, protectedFiles = []) {
  const target = await assertOutputPathAsync(filename, protectedFiles);
  const temporary = path.join(path.dirname(target), `.sessiondock-export-${randomUUID()}.tmp`);
  let handle;
  try {
    // `wx` never reuses or truncates an existing file, exactly like the sync path.
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    // Durability before the rename: the target must never appear with a
    // partially-flushed body, so the fsync is kept — it is just no longer on the
    // main thread.
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Revalidate after the write, before the target is replaced.
    await assertOutputPathAsync(target, protectedFiles);
    await atomicRename(temporary, target);
  } finally {
    if (handle) { try { await handle.close(); } catch { /* preserve the original error */ } }
    try { await fs.promises.unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') { /* Preserve the original write error. */ } }
  }
  return target;
}

function readSessionFile(filename, { legacy = false } = {}) {
  const limit = legacy ? LEGACY_FILE_BYTES : MAX_FILE_BYTES;
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw failure(`설정 파일은 ${limit / 1024 / 1024}MiB 이하의 일반 파일이어야 합니다.`);
    const chunks = []; let length = 0;
    while (length <= limit) {
      const block = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - length));
      const count = fs.readSync(fd, block, 0, block.length, null);
      if (!count) break;
      chunks.push(block.subarray(0, count)); length += count;
    }
    if (length > limit) throw failure('설정 파일이 허용 크기를 초과했습니다.');
    return Buffer.concat(chunks, length);
  } finally { fs.closeSync(fd); }
}

function parseSessionFile(bytes, { windterm = false } = {}) {
  if (windterm) return parseWindTermFile(bytes);
  if (bytes.length > MAX_FILE_BYTES) throw failure(`SessionDock 설정 파일은 ${MAX_FILE_BYTES / 1024 / 1024}MiB 이하만 지원합니다.`);
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '')); }
  catch { throw failure('올바른 UTF-8 JSON 설정 파일을 선택해 주세요.'); }
  // WindTerm's array format keeps its own smaller parser limit.
  return Array.isArray(data) ? parseWindTermFile(bytes) : data;
}

function serializeSessionExport(data) {
  let text = JSON.stringify(data, null, 2);
  // File size and the fully normalized fresh-store size must both fit. Compact
  // export JSON alone cannot account for defaults, new IDs and import metadata.
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) text = JSON.stringify(data);
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw failure(`내보내기 파일이 ${MAX_FILE_BYTES / 1024 / 1024}MiB를 초과합니다.`);
  if (freshImportSize(data) > MAX_FILE_BYTES) {
    throw failure(`내보내기 내용을 새 저장소로 가져오면 기본 설정과 세션 정보를 포함하여 ${MAX_FILE_BYTES / 1024 / 1024}MiB를 초과합니다. 세션 메모나 목록 크기를 줄인 뒤 다시 내보내 주세요.`, 'ERR_SESSION_EXPORT_SIZE');
  }
  return text;
}

module.exports = { assertOutputPath, assertOutputPathAsync, writeAtomicFile, writeAtomicFileAsync, readSessionFile, parseSessionFile, serializeSessionExport, LEGACY_FILE_BYTES };
