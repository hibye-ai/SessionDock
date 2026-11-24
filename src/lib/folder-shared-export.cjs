'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assertOutputPathAsync } = require('./session-file.cjs');

// Match SharedSessions (src/lib/shared-sessions.cjs) and Admin (admin/core.py) limits.
const MAX_SHARED_SESSIONS = 5000;
const MAX_SHARED_FOLDERS = 10000;
const MAX_SHARED_BYTES = 20 * 1024 * 1024;
const PREVIEW_LIMIT = 100;

const ALLOWED_COMMON_FIELDS = Object.freeze([
  'id', 'name', 'folder', 'host', 'protocol', 'port',
  'terminalType', 'encoding', 'backspace', 'keepaliveInterval'
]);
const ALLOWED_SSH_FIELDS = Object.freeze(['authType', 'handshakeTimeout', 'passwordReprompt', 'ctrlArrowMode']);
const ALLOWED_TELNET_FIELDS = Object.freeze(['telnetEnter', 'localEcho']);

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const insideFolder = (candidate, target) => candidate === target || candidate.startsWith(`${target}/`);

function failure(message, code = 'ERR_VALIDATION') {
  return Object.assign(new Error(message), { code });
}

function normalizeFolderPath(input) {
  if (typeof input !== 'string' || input.length > 1024 || /[\x00-\x1f\x7f]/.test(input)) {
    throw failure('폴더 경로가 올바르지 않습니다.', 'ERR_VALIDATION');
  }
  const normalized = input.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
  if (!normalized) throw failure('게시할 로컬 폴더를 선택해 주세요.', 'ERR_VALIDATION');
  if (normalized.split('/').some(part => part === '.' || part === '..')) {
    throw failure('폴더 경로에 상대 경로를 쓸 수 없습니다.', 'ERR_VALIDATION');
  }
  if (normalized === '@shared' || normalized.startsWith('@shared/')) {
    throw failure('공유 폴더는 게시할 수 없습니다.', 'ERR_SHARED_READONLY');
  }
  return normalized;
}

function expandFolders(paths) {
  const result = new Set();
  for (const item of paths) {
    if (typeof item !== 'string' || item.length > 1024 || /[\x00-\x1f\x7f]/.test(item)) {
      throw failure('하위 폴더 경로가 올바르지 않습니다.', 'ERR_VALIDATION');
    }
    const normalized = item.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
    if (normalized.split('/').some(part => part === '.' || part === '..')) {
      throw failure('하위 폴더에 상대 경로를 쓸 수 없습니다.', 'ERR_VALIDATION');
    }
    let parent = '';
    for (const part of normalized.split('/').filter(Boolean)) {
      parent = parent ? `${parent}/${part}` : part;
      result.add(parent);
      if (result.size > MAX_SHARED_FOLDERS) {
        throw failure('폴더는 최대 10,000개까지 게시할 수 있습니다.', 'ERR_SHARED_LIMIT');
      }
    }
  }
  return [...result].sort((a, b) => a.localeCompare(b, 'ko'));
}

// Explicit minimal field allowlist from trusted local store projection.
// Never spread the local session object: passwords, passphrases, key/agent paths,
// credential IDs, personal username, jump/forwards, scripts/keymap, snippets,
// notes/tags/favorite and local display/reconnect/log preferences are excluded.
function projectSharedSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw failure('세션 형식이 올바르지 않습니다.', 'ERR_SHARED_FORMAT');
  }
  const id = session.id;
  if (typeof id !== 'string' || !id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id) ||
      ['__proto__', 'constructor', 'prototype'].includes(id)) {
    throw failure('세션 ID가 올바르지 않습니다.', 'ERR_SHARED_FORMAT');
  }
  const protocol = session.protocol === 'telnet' ? 'telnet' : session.protocol === 'ssh' ? 'ssh' : null;
  if (!protocol) throw failure('SSH와 Telnet 세션만 게시할 수 있습니다.', 'ERR_SHARED_FORMAT');
  const projected = {
    id,
    name: session.name,
    folder: session.folder,
    host: session.host,
    protocol,
    port: session.port,
    terminalType: session.terminalType,
    encoding: session.encoding,
    backspace: session.backspace,
    keepaliveInterval: session.keepaliveInterval
  };
  if (protocol === 'ssh') {
    projected.authType = 'password';
    projected.handshakeTimeout = session.handshakeTimeout;
    if (own(session, 'passwordReprompt') && ['fresh-connection', 'allow-inline'].includes(session.passwordReprompt)) {
      projected.passwordReprompt = session.passwordReprompt;
    }
    if (own(session, 'ctrlArrowMode') && ['word', 'native'].includes(session.ctrlArrowMode)) {
      projected.ctrlArrowMode = session.ctrlArrowMode;
    }
  } else {
    projected.telnetEnter = session.telnetEnter;
    projected.localEcho = session.localEcho;
  }
  return projected;
}

function buildFolderSharedExport(store, folderPath) {
  const target = normalizeFolderPath(folderPath);
  const allFolders = store.listFolders();
  if (!allFolders.includes(target)) {
    throw failure('폴더를 찾을 수 없습니다.', 'ERR_NOT_FOUND');
  }
  const subtreeFolders = allFolders.filter(item => insideFolder(item, target));
  const localSessions = store.listSessions().filter(item =>
    item && typeof item.folder === 'string' && !item.sharedSourceId && insideFolder(item.folder, target)
  );
  if (!localSessions.length) {
    throw failure('폴더와 하위 폴더에 게시할 세션이 없습니다.', 'ERR_EMPTY_FOLDER');
  }
  if (localSessions.length > MAX_SHARED_SESSIONS) {
    throw failure('한 파일에 최대 5,000개 세션까지 게시할 수 있습니다.', 'ERR_SHARED_LIMIT');
  }
  const ids = new Set();
  const sessions = localSessions.map(item => {
    const projected = projectSharedSession(item);
    if (ids.has(projected.id)) throw failure('중복된 세션 ID가 있습니다.', 'ERR_SHARED_FORMAT');
    ids.add(projected.id);
    return projected;
  }).sort((a, b) =>
    a.folder.localeCompare(b.folder, 'ko') || a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id)
  );
  const catalogFolders = expandFolders([...subtreeFolders, ...sessions.map(item => item.folder)]);
  const catalog = { version: 1, folders: catalogFolders, sessions, snippets: [] };
  let bytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_SHARED_BYTES) {
    bytes = Buffer.from(`${JSON.stringify(catalog)}\n`, 'utf8');
  }
  if (bytes.length > MAX_SHARED_BYTES) {
    throw failure('파일 크기 한도(20 MiB)를 넘었습니다.', 'ERR_SHARED_SIZE');
  }
  const revision = createHash('sha256')
    .update(JSON.stringify([target, subtreeFolders, catalogFolders, sessions]))
    .digest('hex');
  const previewSessions = sessions.slice(0, PREVIEW_LIMIT).map(({ name, folder, host, protocol, port }) => ({
    name, folder, host, protocol, port
  }));
  const preview = {
    folder: target,
    sessionCount: sessions.length,
    folderCount: subtreeFolders.length - 1,
    folders: subtreeFolders,
    previewSessions,
    truncatedCount: Math.max(0, sessions.length - previewSessions.length),
    revision
  };
  return { preview, catalog, bytes, revision };
}

function safeDefaultFilename(folderPath) {
  const leaf = String(folderPath || '').split('/').filter(Boolean).at(-1) || 'shared-sessions';
  let base = leaf.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[\s.]+$/g, '').trim().slice(0, 80);
  if (!base || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = 'shared-sessions';
  return `${base}-shared.json`;
}

async function inspectJsonDestination(filename, protectedFiles = []) {
  if (typeof filename !== 'string' || !filename.trim() || filename.includes('\0')) {
    throw failure('저장 경로가 올바르지 않습니다.', 'ERR_VALIDATION');
  }

  if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.json') {
    throw failure('JSON(.json) 파일 경로를 선택해 주세요.', 'ERR_VALIDATION');
  }
  const resolvedInput = path.resolve(filename);
  if (process.platform === 'win32' &&
      (/^\\\\[?.]\\/.test(filename) || resolvedInput.slice(path.parse(resolvedInput).root.length).includes(':'))) {
    throw failure('일반 파일 경로를 선택해 주세요.', 'ERR_VALIDATION');
  }
  const target = await assertOutputPathAsync(resolvedInput, protectedFiles);
  if (path.extname(target).toLowerCase() !== '.json') {
    throw failure('JSON(.json) 파일 경로를 선택해 주세요.', 'ERR_VALIDATION');
  }
  const stat = await fs.promises.lstat(resolvedInput, { bigint: true }).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw failure('저장 경로를 확인할 수 없습니다.', 'ERR_SHARED_WRITE');
  });
  if (stat && (!stat.isFile() || stat.nlink > 1n)) {
    throw failure('일반 JSON 파일만 덮어쓸 수 있습니다.', 'ERR_VALIDATION');
  }
  return { target, stamp: stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
}

function validateBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SHARED_BYTES) {
    throw failure('파일 크기 한도(20 MiB)를 넘었습니다.', 'ERR_SHARED_SIZE');
  }
}

async function replaceConfirmedJson(filename, bytes, expected, protectedFiles, validate) {
  validateBytes(bytes);
  const check = async () => {
    const current = await inspectJsonDestination(filename, protectedFiles());
    if (!expected.stamp || current.target !== expected.target || current.stamp !== expected.stamp) {
      throw failure('대상 파일이 변경되었습니다. 다시 확인해 주세요.', 'ERR_OUTPUT_CHANGED');
    }
    validate();
  };
  await check();
  const temporary = path.join(path.dirname(expected.target), `.sessiondock-shared-${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await check();
    await fs.promises.rename(temporary, expected.target);
    created = false;
    return { path: expected.target, bytes: bytes.length };
  } catch (error) {
    if (error.code?.startsWith('ERR_')) throw error;
    throw failure('파일을 덮어쓰지 못했습니다. 사용 중인지와 권한을 확인해 주세요.', 'ERR_SHARED_WRITE');
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.promises.unlink(temporary).catch(() => {});
  }
}

async function writeFreshJsonExclusive(filename, bytes, protectedFiles = [], validate = () => {}) {
  validateBytes(bytes);
  const { target, stamp } = await inspectJsonDestination(filename, protectedFiles);
  if (stamp !== null) throw failure('같은 이름의 파일이 있습니다. 다시 저장해 주세요.', 'ERR_FILE_EXISTS');
  validate();
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  let createdByUs = false;
  try {
    handle = await fs.promises.open(target, flags, 0o600);
    createdByUs = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { path: target, bytes: bytes.length };
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve original error */ }
    }
    if (createdByUs) {
      try { await fs.promises.unlink(target); } catch { /* preserve original error */ }
    }
    if (error.code === 'EEXIST' || error.code === 'EISDIR') {
      throw failure('저장 중 같은 이름의 파일이 생겼습니다. 다시 저장해 주세요.', 'ERR_FILE_EXISTS');
    }
    if (error.code?.startsWith('ERR_')) throw error;
    throw failure('파일을 저장하지 못했습니다. 경로와 쓰기 권한을 확인해 주세요.', 'ERR_SHARED_WRITE');
  }
}

module.exports = {
  ALLOWED_COMMON_FIELDS,
  ALLOWED_SSH_FIELDS,
  ALLOWED_TELNET_FIELDS,
  MAX_SHARED_SESSIONS,
  MAX_SHARED_FOLDERS,
  MAX_SHARED_BYTES,
  PREVIEW_LIMIT,
  normalizeFolderPath,
  projectSharedSession,
  buildFolderSharedExport,
  safeDefaultFilename,
  inspectJsonDestination,
  replaceConfirmedJson,
  writeFreshJsonExclusive
};
