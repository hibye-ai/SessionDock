'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { sanitizeSession } = require('./session-store.cjs');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SUBSCRIPTION_BYTES = 128 * 1024;
const MAX_SESSIONS = 5000;
const MAX_SOURCES = 8;
const MAX_TOTAL = 10000;
const READ_TIMEOUT_MS = 10000;
const locks = new Set();
const pendingReads = new Map();
const catalogReadQueue = [];
const MAX_CATALOG_READS = 2, MAX_QUEUED_CATALOG_READS = 32;
let activeCatalogReads = 0;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const digest = value => createHash('sha256').update(value).digest('hex');
const lockKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function failure(message, code = 'ERR_SHARED_VALIDATION') {
  return Object.assign(new Error(message), { code });
}

function plain(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw failure(`${label}: 객체가 필요합니다.`);
  }
}

function text(input, label, maximum, trim = false) {
  if (typeof input !== 'string' || input.length > maximum || /[\x00-\x1f\x7f]/.test(input)) {
    throw failure(`${label}: 유효한 문자열이 필요합니다.`);
  }
  const result = trim ? input.trim() : input;
  if (!result) throw failure(`${label}: 값이 필요합니다.`);
  return result;
}

function identifier(input) {
  const id = text(input, 'ID', 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) {
    throw failure('공유 세션 ID가 올바르지 않습니다.');
  }
  return id;
}

function catalogPath(input) {
  const filename = text(input, '공유 JSON 경로', 4096);
  if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.json' ||
      (process.platform === 'win32' &&
       (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])/.test(filename) ||
        /^[\\/]{2}[?.][\\/]/.test(filename)))) {
    throw failure('공유 파일은 로컬 또는 UNC의 절대 .json 경로여야 합니다.');
  }
  return path.resolve(filename);
}

function acquire(filename) {
  const key = lockKey(filename);
  if (locks.has(key)) throw failure('다른 공유 세션 작업이 진행 중입니다.', 'ERR_SHARED_BUSY');
  locks.add(key);
  return () => locks.delete(key);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function catalogReadSlot(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = catalogReadQueue.indexOf(waiter); if (index >= 0) catalogReadQueue.splice(index, 1);
      signal.removeEventListener('abort', abort); reject(signal.reason);
    };
    const waiter = { grant() {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(signal.reason); return; }
      activeCatalogReads++; let released = false;
      resolve(() => {
        if (released) return; released = true; activeCatalogReads--;
        while (catalogReadQueue.length && activeCatalogReads < MAX_CATALOG_READS) catalogReadQueue.shift().grant();
      });
    } };
    if (signal.aborted) { reject(signal.reason); return; }
    if (activeCatalogReads < MAX_CATALOG_READS) waiter.grant();
    else if (catalogReadQueue.length >= MAX_QUEUED_CATALOG_READS) reject(failure('공유 파일 읽기 작업이 많습니다. 잠시 후 다시 시도해 주세요.', 'ERR_SHARED_BUSY'));
    else { catalogReadQueue.push(waiter); signal.addEventListener('abort', abort, { once: true }); }
  });
}

// No unbounded readFile: enforce the limit on bytes actually read, including a
// file that grows after stat. Windows UNC stat/open cannot be cancelled by Node;
// keep ownership until the actual I/O/close settles, even after the UI deadline.
// Catalog reads have two slots; local subscription edits retain their own path
// so stalled remote catalogs cannot prevent removing an offline subscription.
async function readBounded(filename, maximum = MAX_FILE_BYTES, optional = false, catalog = true, ownerSignal) {
  const key = lockKey(filename);
  if (pendingReads.has(key)) throw failure('이전 공유 파일 읽기가 아직 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.', 'ERR_SHARED_BUSY');
  const controller = new AbortController();
  const signal = ownerSignal || controller.signal;
  let timer;
  const task = (async () => {
    let handle, release;
    try {
      if (catalog) release = await catalogReadSlot(signal);
      signal.throwIfAborted();
      let before;
      try { before = await fs.promises.lstat(filename); }
      catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
      signal.throwIfAborted();
      if (before.isSymbolicLink() || !before.isFile()) {
        throw failure('공유 파일은 심볼릭 링크가 아닌 일반 파일이어야 합니다.', 'ERR_SHARED_FILE');
      }
      if (before.size > maximum) throw failure('공유 파일 크기 제한을 초과했습니다.', 'ERR_SHARED_SIZE');
      handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      signal.throwIfAborted();
      const opened = await handle.stat();
      signal.throwIfAborted();
      if (!opened.isFile() || !sameFile(before, opened)) {
        throw failure('읽는 동안 공유 파일이 변경되었습니다. 다시 갱신해 주세요.', 'ERR_SHARED_CHANGED');
      }
      const chunks = [];
      let total = 0;
      while (true) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        signal.throwIfAborted();
        total += bytesRead;
        if (total > maximum) throw failure('공유 파일 크기 제한을 초과했습니다.', 'ERR_SHARED_SIZE');
        if (!bytesRead) break;
        chunks.push(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      signal.throwIfAborted();
      if (!sameFile(opened, after) || total !== after.size) {
        throw failure('읽는 동안 공유 파일이 변경되었습니다. 다시 갱신해 주세요.', 'ERR_SHARED_CHANGED');
      }
      const bytes = Buffer.concat(chunks, total);
      return { bytes, stamp: `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}:${digest(bytes)}` };
    } catch (error) {
      if (error.code?.startsWith('ERR_SHARED_')) throw error;
      // Filesystem and JSON errors can quote file contents or machine paths.
      throw failure('공유 파일을 읽을 수 없습니다.', 'ERR_SHARED_READ');
    } finally {
      try {
        if (handle) await handle.close().catch(() => {
          throw failure('공유 파일을 닫을 수 없습니다.', 'ERR_SHARED_READ');
        });
      } finally { release?.(); }
    }
  })();
  pendingReads.set(key, task);
  const retire = () => { if (pendingReads.get(key) === task) pendingReads.delete(key); };
  task.then(retire, retire);
  // A publication has its own user-visible deadline. Its internal owner must
  // await actual I/O/close before releasing the cross-process lock.
  if (ownerSignal) return task;
  try {
    return await Promise.race([task, new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = failure('공유 파일 읽기 시간이 10초를 초과했습니다.', 'ERR_SHARED_TIMEOUT');
        controller.abort(error);
        reject(error);
      }, READ_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function parseJSON(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  } catch {
    throw failure('공유 파일이 올바른 UTF-8 JSON이 아닙니다.', 'ERR_SHARED_FORMAT');
  }
}

function folders(input = [], sessions = []) {
  if (!Array.isArray(input) || input.length > 10000) throw failure('공유 폴더 목록이 올바르지 않습니다.');
  const result = new Set();
  for (const item of [...input, ...sessions.map(session => session.folder)]) {
    if (typeof item !== 'string' || item.length > 1024 || /[\x00-\x1f\x7f]/.test(item)) {
      throw failure('공유 폴더 경로가 올바르지 않습니다.');
    }
    const normalized = item.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
    if (normalized.split('/').some(part => part === '.' || part === '..')) throw failure('공유 폴더에 상대 경로를 사용할 수 없습니다.');
    let parent = '';
    for (const part of normalized.split('/').filter(Boolean)) {
      parent = parent ? `${parent}/${part}` : part;
      result.add(parent);
      if (result.size > 10000) throw failure('공유 폴더가 너무 많습니다.');
    }
  }
  return [...result].sort((a, b) => a.localeCompare(b, 'ko'));
}

function present(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function sharedProfile(input) {
  plain(input, '공유 세션');
  const id = identifier(input.id);
  const warnings = [];
  if (Object.keys(input).some(key => /jump|proxy|forward|tunnel/i.test(key) && present(input[key]))) {
    warnings.push('공유 세션은 점프·프록시·포워딩 경로를 지원하지 않아 제거했습니다. 직접 접속 경로를 확인해 주세요.');
  }
  if (['key', 'agent'].includes(input.authType) ||
      ['privateKeyPath', 'keyPath', 'agentPath', 'agent'].some(key => present(input[key]))) {
    warnings.push('기기별 개인키·에이전트 설정을 제거했습니다. 공유 SSH 세션은 비밀번호로 로그인합니다.');
  }
  let profile;
  try {
    profile = sanitizeSession({ ...input, credentialId: '', privateKeyPath: '', agentPath: '',
      jumpSessionId: '', forwards: [], rememberPassphrase: false,
      authType: ['key', 'agent'].includes(input.authType) && (input.protocol === undefined || input.protocol === 'ssh')
        ? 'password' : (input.authType === undefined ? 'password' : input.authType) });
  } catch {
    throw failure('공유 세션의 연결 설정이 올바르지 않습니다.', 'ERR_SHARED_FORMAT');
  }
  profile.importWarnings = [...new Set([...warnings, ...profile.importWarnings])].slice(0, 64);
  return { id, ...profile, hasPassphrase: false };
}

function parseCatalog(input) {
  plain(input, '공유 카탈로그');
  if (input.version !== 1 || !Array.isArray(input.sessions)) {
    throw failure('SessionDock에서 내보낸 JSON(version 1)만 지원합니다. MobaXterm 형식은 지원하지 않습니다.', 'ERR_SHARED_FORMAT');
  }
  if (input.sessions.length > MAX_SESSIONS) throw failure('공유 원본당 세션은 최대 5,000개입니다.', 'ERR_SHARED_LIMIT');
  if (own(input, 'snippets') && !Array.isArray(input.snippets)) throw failure('공유 내보내기 형식이 올바르지 않습니다.', 'ERR_SHARED_FORMAT');
  const ids = new Set();
  const sessions = Array.from(input.sessions, input => {
    const session = sharedProfile(input);
    if (ids.has(session.id)) throw failure('공유 원본에 중복 세션 ID가 있습니다.', 'ERR_SHARED_FORMAT');
    ids.add(session.id);
    return session;
  });
  // Snippet collections are validated but never returned or republished: shared
  // catalogs carry sessions and folder structure only.
  return { sessions, folders: folders(input.folders, sessions) };
}

async function readCatalog(filename) {
  const loaded = await readBounded(filename, MAX_FILE_BYTES, false, true);
  return parseCatalog(parseJSON(loaded.bytes));
}

// Always rename a completed same-directory file. Never unlink the destination
// to work around Windows/SMB rename errors; failure must leave it intact.
async function atomicWrite(filename, bytes, verify, { preserveTemporary = false, signal } = {}) {
  const temporary = path.join(path.dirname(filename), `.sessiondock-shared-${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    signal?.throwIfAborted();
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    created = true;
    signal?.throwIfAborted();
    await handle.writeFile(bytes);
    signal?.throwIfAborted();
    await handle.sync();
    signal?.throwIfAborted();
    await handle.close();
    handle = undefined;
    await verify();
    signal?.throwIfAborted();
    await fs.promises.rename(temporary, filename);
  } catch (error) {
    if (error.code?.startsWith('ERR_SHARED_')) throw error;
    throw failure('공유 데이터를 저장하지 못했습니다. 기존 파일은 보존했습니다.', 'ERR_SHARED_WRITE');
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created && !preserveTemporary) await fs.promises.unlink(temporary).catch(() => {});
  }
}

function subscriptions(input) {
  plain(input, '공유 구독');
  if (input.version !== 1 || !Array.isArray(input.sources) || input.sources.length > MAX_SOURCES) throw failure('공유 구독 목록이 올바르지 않습니다.');
  const ids = new Set(), paths = new Set();
  return input.sources.map(item => {
    plain(item, '공유 원본');
    const source = { id: identifier(item.id), name: text(item.name, '공유 원본 이름', 256, true), path: catalogPath(item.path) };
    if (ids.has(source.id) || paths.has(lockKey(source.path))) throw failure('공유 구독 목록에 중복 원본이 있습니다.');
    ids.add(source.id); paths.add(lockKey(source.path));
    return source;
  });
}

function publicSource(source) {
  return { id: source.id, name: source.name, path: source.path, status: source.status,
    error: source.error, count: source.profiles.size, updatedAt: source.updatedAt, folders: [...source.folders] };
}

function profilesFor(source, sessions) {
  return new Map(sessions.map(session => {
    // Hash both namespaces separately so 128-character original IDs still fit.
    const id = `shared_${digest(source.id).slice(0, 32)}_${digest(session.id)}`;
    return [id, { ...session, id, sharedSourceId: source.id, sharedSourceName: source.name, sourceSessionId: session.id }];
  }));
}

/** Separate from SessionStore: only {version:1,sources:[{id,name,path}]} is saved.
 * initialize/addSource/refreshSource -> Promise<public source list/source>;
 * removeSource -> Promise<boolean>. Lists and getSession are synchronous copies.
 * Status is loading | ready | error; updatedAt is the last successful read.
 * Call initialize in the background after creating the app window. Nothing here
 * polls, connects, or changes already-open connections. Overlapping mutations
 * for a subscription file reject with ERR_SHARED_BUSY rather than queueing.
 */
class SharedSessions {
  #sources = new Map();
  #index = new Map();
  #initialized = false;
  #stamp;

  constructor({ root }) {
    this.root = path.resolve(text(root, '공유 구독 저장 폴더', 4096));
    this.filePath = path.join(this.root, 'shared-session-sources.json');
  }

  async #operation(action, initializing = false) {
    if (!initializing && !this.#initialized) throw failure('공유 구독을 먼저 초기화해 주세요.', 'ERR_SHARED_NOT_INITIALIZED');
    const release = acquire(this.filePath);
    try { return await action(); } finally { release(); }
  }

  async initialize() {
    return this.#operation(async () => {
      if (this.#initialized) return this.listSources();
      const loaded = await readBounded(this.filePath, MAX_SUBSCRIPTION_BYTES, true, false);
      let registered;
      try { registered = loaded ? subscriptions(parseJSON(loaded.bytes)) : []; }
      catch { throw failure('공유 구독 설정이 손상되었습니다. 기존 설정 파일은 보존했습니다.', 'ERR_SHARED_SUBSCRIPTIONS'); }
      this.#stamp = loaded?.stamp;
      for (const item of registered) this.#sources.set(item.id, { ...item, status: 'loading', error: null, updatedAt: null, profiles: new Map(), folders: [] });
      // Independent sources read concurrently: one offline UNC cannot delay all
      // other sources by its own 10-second deadline eight times in sequence.
      const results = await Promise.allSettled(registered.map(item => readCatalog(item.path)));
      results.forEach((result, index) => {
        const source = this.#sources.get(registered[index].id);
        try {
          if (result.status === 'rejected') throw result.reason;
          this.#apply(source, result.value);
        } catch (error) { source.status = 'error'; source.error = error.message; }
      });
      this.#initialized = true;
      return this.listSources();
    }, true);
  }

  listSources() { return [...this.#sources.values()].map(publicSource); }

  listSessions() { return [...this.#index.values()].map(profile => structuredClone(profile)); }

  getSession(id) {
    const session = this.#index.get(id);
    if (!session) throw failure('공유 세션을 찾을 수 없습니다. 목록을 갱신해 주세요.', 'ERR_NOT_FOUND');
    if (this.#sources.get(session.sharedSourceId)?.status !== 'ready') {
      throw failure('공유 원본을 사용할 수 없습니다. 원본 갱신에 성공한 뒤 다시 접속하세요.', 'ERR_SHARED_UNAVAILABLE');
    }
    return structuredClone(session);
  }

  #apply(source, { sessions, folders }) {
    if (this.#index.size - source.profiles.size + sessions.length > MAX_TOTAL) throw failure('전체 공유 세션은 최대 10,000개입니다.', 'ERR_SHARED_LIMIT');
    const profiles = profilesFor(source, sessions);
    for (const id of source.profiles.keys()) this.#index.delete(id);
    source.profiles = profiles;
    source.folders = [...folders];
    for (const [id, profile] of profiles) this.#index.set(id, profile);
    source.status = 'ready'; source.error = null; source.updatedAt = new Date().toISOString();
  }

  async #persist(sources) {
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, sources: sources.map(({ id, name, path }) => ({ id, name, path })) }, null, 2)}\n`);
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    await atomicWrite(this.filePath, bytes, async () => {
      const current = await readBounded(this.filePath, MAX_SUBSCRIPTION_BYTES, true, false);
      if (current?.stamp !== this.#stamp) throw failure('공유 구독 설정이 다른 작업에서 변경되었습니다. 다시 초기화해 주세요.', 'ERR_SHARED_CHANGED');
    });
    // Read the actual renamed file identity for subsequent concurrent-writer
    // checks. A failure here must not turn a successful commit into a rollback.
    this.#stamp = undefined;
    try { this.#stamp = (await readBounded(this.filePath, MAX_SUBSCRIPTION_BYTES, false, false)).stamp; }
    catch { /* A later mutation fails closed if the registry cannot be read. */ }
  }

  async addSource(input) {
    return this.#operation(async () => {
      plain(input, '공유 원본');
      const source = { id: randomUUID(), name: text(input.name, '공유 원본 이름', 256, true), path: catalogPath(input.path),
        status: 'loading', error: null, updatedAt: null, profiles: new Map(), folders: [] };
      if (this.#sources.size >= MAX_SOURCES) throw failure('공유 원본은 최대 8개입니다.', 'ERR_SHARED_LIMIT');
      if ([...this.#sources.values()].some(item => lockKey(item.path) === lockKey(source.path))) throw failure('이미 등록된 공유 원본입니다.', 'ERR_SHARED_DUPLICATE');
      const catalog = await readCatalog(source.path);
      if (this.#index.size + catalog.sessions.length > MAX_TOTAL) throw failure('전체 공유 세션은 최대 10,000개입니다.', 'ERR_SHARED_LIMIT');
      await this.#persist([...this.#sources.values(), source]);
      this.#apply(source, catalog);
      this.#sources.set(source.id, source);
      return publicSource(source);
    });
  }

  async refreshSource(id) {
    return this.#operation(async () => {
      const source = this.#sources.get(id);
      if (!source) throw failure('공유 원본을 찾을 수 없습니다.', 'ERR_NOT_FOUND');
      source.status = 'loading';
      try {
        const catalog = await readCatalog(source.path);
        this.#apply(source, catalog);
        return publicSource(source);
      } catch (error) {
        source.status = 'error'; source.error = error.message;
        throw error;
      }
    });
  }

  async removeSource(id) {
    return this.#operation(async () => {
      const source = this.#sources.get(id);
      if (!source) return false;
      await this.#persist([...this.#sources.values()].filter(item => item.id !== id));
      this.#sources.delete(id);
      for (const key of source.profiles.keys()) this.#index.delete(key);
      return true;
    });
  }
}

module.exports = { SharedSessions };
