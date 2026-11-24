'use strict';
const { outputDisconnectCause, disconnectLabel } = require('./disconnect-cause.cjs');

const { Client, utils } = require('ssh2');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { performance } = require('node:perf_hooks');
const { DEFAULT_LOG_SETTINGS, logLocation, LogFormatter, dateParts } = require('./logging-settings.cjs');
const { RotatingLog, openLogFile, endLogStream } = require('./rotating-log.cjs');
const { TerminalLogQueue } = require('./terminal-log-queue.cjs');
const { normalizeHostKey } = require('./session-store.cjs');
const { TerminalEncoding,AutomaticTerminalEncoding } = require('./terminal-encoding.cjs');
const compatibility = require('./ssh-compatibility.cjs');
const { authenticationHandler, isPasswordChallenge, createAuthenticationState,
  markLoginPasswordSubmitted, markPromptAnswerSubmitted, authenticationSummary,
  requiresFreshConnection, AUTH_RETRY_NEW_CONNECTION_REQUIRED, AUTH_RETRY_NEW_CONNECTION_MESSAGE,
} = require('./ssh-authentication.cjs');

const MAX_BUFFER = 1024 * 1024;
const MAX_TRANSFERS = 8;
const SFTP_OPERATION_TIMEOUT_MS = 30000;

function sftpTimeout() {
  return new ServiceError('SFTP 응답 시간이 초과되었습니다. 원격 목록을 새로고침하고 현재 상태를 확인해 주세요.', 'SFTP_TIMEOUT');
}

function unknownTransferCommit() {
  return new ServiceError('파일 전송 결과를 확인하지 못했습니다. 다시 시도하기 전에 대상 파일을 확인해 주세요.', 'TRANSFER_COMMIT_UNKNOWN');
}
const MAX_FORWARD_SOCKETS = 64;
const RECEIVE_DRAIN_CHUNK = 32 * 1024;
// Retained transport-close records: a batch row reads its own record in its
// `finally`, and an interactive tab may ask again after the status event. 256
// closed records cost a few KB and are pruned by age, so a long-lived app never
// grows without bound while a late waiter still finds the truth.
const TRANSPORT_CLOSE_RETENTION = 256;
const TRANSPORT_CLOSE_TTL_MS = 60 * 1000;
// Bytes retained while a log file is still opening. Transport never pauses for
// this; overflow is an explicit logIncomplete.
const LOG_PENDING_LIMIT = 16 * 1024 * 1024;
// Object count of the pre-open buffer, expressed as a block size instead of an
// entry count. Another terminal wrote one byte per packet: stdout and stderr then
// retained 200,000 separate objects for 400,000 counted bytes (≈68 MiB of heap),
// because each entry is an object holding up to three buffer references (V7-H-02).
// Incoming chunks are therefore copied into fixed blocks, so the object count is
// `bytes / block` and never the packet rate, while every byte, its order and the
// totals stay identical.
const LOG_PENDING_BLOCK = 64 * 1024;
const WINDOWS_AGENT = '\\\\.\\pipe\\openssh-ssh-agent';
const SAFE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE', 'ECONNREFUSED',
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ENOSPC', 'LOG_NAME_COLLISION',
  // The peer vanished while user authentication was in progress. OmniSwitch
  // style AAA does this on its own lockout/session limit, so it must not be
  // presented as a wrong password.
  'AUTH_CONNECTION_CLOSED',
  // The operator never answered an authentication prompt in time.
  'AUTH_RESPONSE_TIMEOUT']);
// Socket outcomes that mean "the peer went away" rather than "the device
// answered". Their safe code is kept even though the phase was authentication.
const PEER_GONE = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_DESTROYED']);

class ServiceError extends Error {
  constructor(message, code = 'SSH_SERVICE_ERROR') {
    super(message);
    this.code = code;
  }
}

// Never relay arbitrary ssh2, filesystem, server, or UI error text: it can contain
// credentials (including a private key or an authentication challenge response).
function publicError(error, message) {
  if (error instanceof ServiceError) return error;
  if (error?.code === 'RECEIVE_CAPACITY') return new ServiceError('수신 대기 예산이 부족하여 연결을 시작하지 못했습니다.', 'RECEIVE_CAPACITY');
  if (error?.message === 'Keepalive timeout') return new ServiceError('서버의 연결 유지 응답이 없어 연결을 종료했습니다.', 'KEEPALIVE_TIMEOUT');
  if(compatibility.isAlgorithmMismatch(error))return new ServiceError('SSH 알고리즘이 장비와 호환되지 않습니다. SSH 호환성 설정을 확인해 주세요.','SSH_ALGORITHM_MISMATCH');
  if(error?.level==='handshake'&&error.message==='Handshake failed: signature verification failed') {
    return new ServiceError('SSH 서버 서명 검증에 실패했습니다. 장비의 SSH 구현 또는 서버 키를 확인해 주세요.','SSH_SIGNATURE_INVALID');
  }
  if (error && error.level === 'client-authentication') {
    return new ServiceError('SSH 인증에 실패했습니다. 사용자 이름과 인증 정보를 확인해 주세요.', 'AUTH_FAILED');
  }
  // A prompt deadline is a user/UI timeout, not a credential or network verdict.
  // Keep its fixed code so a slow operator is never reported as a bad password.
  if (error && error.code === 'AUTH_REQUIRED') {
    return new ServiceError('인증 정보가 올바르지 않습니다.', 'AUTH_REQUIRED');
  }
  if (error && error.code === 'AUTH_RESPONSE_TIMEOUT') {
    return new ServiceError('인증 응답 대기 시간이 초과되었습니다. 다시 연결해 주세요.', 'AUTH_RESPONSE_TIMEOUT');
  }
  const code = error && SAFE_CODES.has(error.code) ? error.code : undefined;
  return new ServiceError(code ? `${message} (${code}).` : `${message}.`, code);
}

function port(value, allowZero = false) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1) || number > 65535) {
    throw new ServiceError('포트는 1부터 65535 사이의 정수여야 합니다.', 'INVALID_PORT');
  }
  return number;
}

function dimensions(cols, rows) {
  if (![cols, rows].every(value => Number.isInteger(value) && value >= 1 && value <= 4096)) {
    throw new ServiceError('터미널 열과 행은 1부터 4096 사이의 정수여야 합니다.', 'INVALID_SIZE');
  }
  return { cols, rows };
}

function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value)
    || !value.isWellFormed() || Buffer.byteLength(value) > 4096) {
    throw new ServiceError('원격 경로는 /로 시작하는 절대 경로여야 합니다.', 'INVALID_PATH');
  }
  return path.posix.normalize(value).replace(/\/$/, '') || '/';
}

function leafName(value) {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..'
    || /[/\\\x00-\x1f\x7f]/.test(value) || !value.isWellFormed() || Buffer.byteLength(value) > 255) {
    throw new ServiceError('경로 구분자나 제어 문자가 없는 원격 파일 이름 하나를 입력해 주세요.', 'INVALID_NAME');
  }
  return value;
}

function remoteEntry(value, attrs) {
  if (!Number.isInteger(attrs?.mode)) {
    throw new ServiceError('서버가 원격 항목의 종류를 알려 주지 않았습니다.', 'INVALID_REMOTE_ATTRIBUTES');
  }
  const kind = attrs.mode & 0o170000;
  const type = kind === 0o120000 ? 'symlink' : kind === 0o040000 ? 'directory' : kind === 0o100000 ? 'file' : 'other';
  const snapshot = {};
  for (const field of ['mode', 'size', 'uid', 'gid', 'atime', 'mtime']) {
    if (Number.isSafeInteger(attrs[field]) && attrs[field] >= 0) snapshot[field] = attrs[field];
  }
  return { path: value, name: path.posix.basename(value), type, ...snapshot,
    permissions: attrs.mode & 0o7777, attrs: snapshot };
}

// SFTP v3 has no inode/generation token. Compare the attributes supplied by the
// caller as a best-effort stale-selection guard, always using lstat for links.
function expectedEntry(value, required = true) {
  if (value === undefined && !required) return null;
  const type = typeof value === 'string' ? value : value?.type;
  if (!['file', 'directory', 'symlink'].includes(type)) {
    throw new ServiceError('항목 종류는 파일, 폴더 또는 심볼릭 링크여야 합니다.', 'INVALID_TYPE');
  }
  const guard = { type };
  if (typeof value === 'object') {
    if (value.attrs !== undefined && (!value.attrs || typeof value.attrs !== 'object' || Array.isArray(value.attrs))) {
      throw new ServiceError('원격 항목 정보가 올바르지 않습니다.', 'INVALID_REMOTE_ATTRIBUTES');
    }
    for (const field of ['mode', 'size', 'uid', 'gid', 'mtime', 'permissions']) {
      const attribute = value.attrs?.[field] ?? value[field];
      if (attribute === undefined) continue;
      if (!Number.isSafeInteger(attribute) || attribute < 0) {
        throw new ServiceError('원격 항목 정보가 올바르지 않습니다.', 'INVALID_REMOTE_ATTRIBUTES');
      }
      guard[field] = attribute;
    }
  }
  return guard;
}

function matchesEntry(entry, expected) {
  if (expected && Object.entries(expected).some(([key, value]) => entry[key] !== value)) {
    throw new ServiceError('원격 항목이 변경되었습니다. 새로고침한 뒤 다시 시도해 주세요.', 'STALE_REMOTE_ENTRY');
  }
}

function pathsOverlap(first, second) {
  return first === second || first === '/' || second === '/'
    || first.startsWith(second + '/') || second.startsWith(first + '/');
}

function abortedTransfer(signal) {
  return signal.reason instanceof ServiceError ? signal.reason
    : new ServiceError('파일 전송을 취소했습니다.', 'TRANSFER_CANCELLED');
}

function destroy(resource) {
  try { resource.destroy(); } catch { /* already closed */ }
}

class SshService {
  constructor({ lookupSession, emit, ask, knownHosts, logDirectory, getLogSettings, logClock = () => new Date(), handshakeTimeoutMs = 30000, receiveDrainTimeoutMs = 5000, logOpenTimeoutMs = 10000, binaryOutput = false, logBudget = null, receiveSource = null } = {}) {
    if (typeof lookupSession !== 'function' || typeof emit !== 'function'
      || typeof ask !== 'function' || !knownHosts
      || typeof knownHosts.get !== 'function' || typeof knownHosts.set !== 'function') {
      throw new TypeError('SshService requires lookupSession, emit, ask, and knownHosts.get/set.');
    }
    if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 10 || handshakeTimeoutMs > 300000) {
      throw new TypeError('handshakeTimeoutMs must be an integer between 10 and 300000.');
    }
    if (!Number.isInteger(receiveDrainTimeoutMs) || receiveDrainTimeoutMs < 10 || receiveDrainTimeoutMs > 300000) {
      throw new TypeError('receiveDrainTimeoutMs must be an integer between 10 and 300000.');
    }
    this.lookupSession = lookupSession;
    this.emit = emit;
    this.ask = ask;
    this.knownHosts = knownHosts;
    this.logDirectory = logDirectory;
    this.getLogSettings = getLogSettings || (() => DEFAULT_LOG_SETTINGS);
    this.logClock = logClock;
    if (!Number.isInteger(logOpenTimeoutMs) || logOpenTimeoutMs < 10 || logOpenTimeoutMs > 300000) throw new TypeError('Invalid log opening deadline.');
    this.logOpenTimeoutMs = logOpenTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.sftpOperationTimeoutMs = SFTP_OPERATION_TIMEOUT_MS;
    this.sftpChannels = new WeakMap();
    this.receiveDrainTimeoutMs = receiveDrainTimeoutMs;
    this.connections = new Map();
    this.receiving = new Map();
    // In-flight terminal teardown, keyed by connection id. `connections` is
    // deleted as soon as a finish starts, so a caller that only has the id
    // (a batch row) needs this to wait for its own close without waiting for
    // every other connection in the service.
    this.finishing = new Map();
    // Observed transport close per connection id, deliberately separate from
    // `finishing`/`finishPromise`. Finishing covers the status event, the
    // receive drain and the log flush; it can complete while the TCP socket is
    // still open (a delayed `destroy()`, a half-closed socket). A batch row that
    // needs the previous device session to be gone must wait on this record, and
    // it is retained after the connection leaves every other map so a late
    // waiter still gets the truth instead of "nothing is tracked, so assume
    // closed".
    this.transportCloses = new Map();
    this.trustQueues = new Map();
    this.cleanups = new Set();
    this.closed = false;
    this.transportName = 'SSH';
    this.binaryOutput = binaryOutput;
    this.receiveSource = receiveSource;
    // Shared with the other protocol service when the owner supplies one.
    this.logBudget = logBudget;
    // A slow or failing log writer must never pause the transport: it only backs
    // up (and if necessary fails) its own bounded queue. The byte reservation is
    // shared with the other protocol service when the owner supplies one, so the
    // process ceiling is real and not per queue.
    this.logQueue = new TerminalLogQueue({
      ...(logBudget ? { budget: logBudget } : {}),
      onFailure: failure => this._logQueueFailure(failure),
      onProgress: (id, generation) => this._receiveLogPressure(id, generation),
    });
  }

  // One-shot explicit log failure: the session stays connected and the operator
  // is told the recording is incomplete. Nothing is silently discarded.
  _logQueueFailure({ id, code, message, droppedLogBytes, generation }) {
    const connection = this.connections.get(id) || this.receiving.get(id);
    if (connection) {
      if (connection.logQueueGeneration !== generation && generation !== undefined) return;
      connection.logIncomplete = true;
      connection.logDroppedBytes = (connection.logDroppedBytes || 0) + (droppedLogBytes || 0);
      connection.logDroppedReported = Math.max(connection.logDroppedReported || 0, this.logQueue.dropped(id) || 0);
      this._detachLogWriter(connection);
    }
    this._emit({ type: 'log', id, enabled: false, path: null, incomplete: true, droppedLogBytes: droppedLogBytes || 0 });
    this._emit({ type: 'log-error', id, message: message || '세션 로그 저장이 터미널 출력 속도를 따라가지 못했습니다.', code: code || 'LOG_FAILED' });
  }

  // Stops feeding the writer without ending the session and without discarding
  // bytes the writer already accepted: the pump stops, the file is drained and
  // closed normally, and only genuinely unwritable bytes are reported as dropped.
  _detachLogWriter(connection) {
    const stream = connection.logWriter;
    if (!stream) return;
    connection.logWriter = null;
    connection.logSource = null;
    connection.logOpening = false;
    connection.logStream = null;
    connection.logStopping = stream;
    this._unlistenLogDrain(connection);
    // The error listener is owned per attempt (`logErrorListener`), so retiring a
    // writer also removes its handler: leaving it installed let a retired writer's
    // late error reach the next attempt's queue (V7-M-01).
    this._unlistenLogError(connection, stream);
    const stopping = this._cleanup((async () => {
      // Drain whatever the writer already holds, then close. Bounded, and a stuck
      // stream is force-destroyed so shutdown cannot hang.
      if (!stream.closed) {
        await new Promise(resolve => {
          const timer = setTimeout(() => stream.destroy(), 1000);
          timer.unref();
          stream.once('close', () => {
            if (connection.logStopping === stream) connection.logStopping = null;
            clearTimeout(timer);
            resolve();
          });
          try { stream.end(); } catch { stream.destroy(); }
        });
      } else {
        if (connection.logStopping === stream) connection.logStopping = null;
      }
      const lost = this.logLossBytes(connection);
      if (lost > (connection.logDroppedBytes || 0)) this._reportLogIncomplete(connection, 'LOG_WRITE_FAILED',
        '세션 로그를 저장하지 못해 일부 출력의 기록을 확인할 수 없습니다.', lost);
    })());
    connection.logStoppingPromise = stopping;
    stopping.then(() => { if (connection.logStoppingPromise === stopping) connection.logStoppingPromise = null; },
      () => { if (connection.logStoppingPromise === stopping) connection.logStoppingPromise = null; });
  }

  // Removes one writer's error handler. Without this, every stopped attempt left a
  // listener attached to a closed stream, and a dedicated listener per attempt
  // leaked with it. Removing the handler is not enough on its own: an 'error' event
  // with no listener makes Node throw, so a retired writer gets a no-op sink. The
  // retired stream is unreachable once it closes, so the sink goes with it.
  _unlistenLogError(connection, stream) {
    const listener = connection.logErrorListener;
    if (!listener) return;
    if (stream && listener.stream !== stream) return;
    listener.stream.removeListener('error', listener.onError);
    listener.stream.on('error', () => {});
    connection.logErrorListener = null;
  }


  _emit(event) {
    try { this.emit(event); } catch { /* an IPC consumer must not crash SSH callbacks */ }
  }

  _authState(connection, phase) {
    // IDs are unique per attempt and form the generation token end-to-end. A
    // callback from a retired client cannot publish into a newer attempt.
    if (connection.closed || this.connections.get(connection.id) !== connection || connection.authPhase === phase || connection.authPhase === 'ready') return;
    connection.authPhase = phase;
    const sequence = connection.authSequence = (connection.authSequence || 0) + 1;
    this._emit({ type: 'auth-state', id: connection.id, generation: connection.id, sequence, phase });
  }

  _assertOpen(connection, connected = false) {
    if (connection.closed || (connected && connection.status !== 'connected')) {
      throw new ServiceError('SSH에 연결되어 있지 않습니다.', 'NOT_CONNECTED');
    }
  }

  _connection(id, connected = true) {
    const connection = this.connections.get(id);
    if (!connection) throw new ServiceError('SSH에 연결되어 있지 않습니다.', 'NOT_CONNECTED');
    this._assertOpen(connection, connected);
    return connection;
  }

  // All pending callbacks/asks settle immediately on disconnect, even if a remote
  // server or an unanswered dialog never completes its own callback.
  _pending(connection, start, signal, deadline) {
    this._assertOpen(connection);
    if (signal?.aborted) return Promise.reject(abortedTransfer(signal));
    if (connection.pending.size >= 128) {
      return Promise.reject(new ServiceError('처리 대기 중인 SSH 작업이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 'BUSY'));
    }
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const done = (error, value) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        connection.pending.delete(cancel);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
        return true;
      };
      const cancel = () => done(new ServiceError('SSH 연결이 끊어졌습니다.', 'NOT_CONNECTED'));
      const abort = () => done(abortedTransfer(signal));
      connection.pending.add(cancel);
      signal?.addEventListener('abort', abort, { once: true });
      if (deadline) timer = setTimeout(() => done(deadline.error()), deadline.ms);
      try { start(done); } catch (error) { done(error); }
    });
  }

  _await(connection, operation, signal) {
    return this._pending(connection, done => {
      Promise.resolve().then(() => {
        this._assertOpen(connection);
        if (signal?.aborted) throw abortedTransfer(signal);
        return operation();
      }).then(value => done(null, value), error => done(error));
    }, signal);
  }

  connect(sessionId, { cols = 100, rows = 30, password, passphrase,handshakeTimeoutMs=this.handshakeTimeoutMs,sshCompatibility='compatible',autoEncoding=false } = {}) {
    if (this.closed) throw new ServiceError('SSH 서비스가 종료되었습니다.', 'SERVICE_CLOSED');
    if(!Number.isInteger(handshakeTimeoutMs)||handshakeTimeoutMs<10||handshakeTimeoutMs>300000)throw new ServiceError('접속 제한 시간은 10–300000ms 범위여야 합니다.','INVALID_TIMEOUT');
    sshCompatibility=compatibility.sshCompatibility(sshCompatibility);
    const id = randomUUID();
    const connection = {
      id, sessionId, status: 'connecting', closed: false, ...dimensions(cols, rows),
      info: {},handshakeTimeoutMs,sshCompatibility,autoEncoding:autoEncoding===true, pending: new Set(), clients: new Map(), resources: new Set(), handshakes: new Set(),
      servers: new Set(), forwardSockets: new Set(), forwards: [], jobs: new Map(),
      shell: null, sftp: null, sftpPromise: null, logStream: null, logPath: null,
      logQueue: Promise.resolve(),
      // Logging state must exist from the first byte. It used to be created
      // lazily, so the pre-open byte cap compared `undefined + bytes` → NaN,
      // which is never greater than LOG_PENDING_LIMIT: the 16 MiB limit was
      // silently disabled for every connection's first log open.
      logPending: null, logPendingBytes: 0, logOpening: false, initialLogRequested: false,
      logIncomplete: false, logIntendedBytes: 0, logBytesWritten: 0, logDroppedBytes: 0,
      logWriter: null, logFormatter: null, logSource: null, logFormat: null, logStopping: null,
      // Per-attempt writer handlers, so retiring a writer removes exactly its own
      // listeners instead of leaving them for the next attempt (V7-M-01).
      logErrorListener: null, logDrainListener: null,
    };
    this.connections.set(id, connection);
    // The caller must receive the ID and allocate its terminal before any event.
    setImmediate(() => {
      if (connection.closed) return;
      this._emit({ type: 'status', id, status: 'connecting', message: 'Connecting…' });
      this._start(connection, { password, passphrase }).catch(error => {
        this._fail(connection, publicError(error, `${this.transportName} 연결을 설정하지 못했습니다`));
      });
    });
    return { id, sessionId };
  }

  async _session(connection, id) {
    const session = await this._await(connection, () => this.lookupSession(id));
    this._assertOpen(connection);
    if (!session || typeof session.host !== 'string' || !session.host.trim()
      || /[\s\0]/.test(session.host) || typeof session.username !== 'string') {
      throw new ServiceError('세션의 호스트와 사용자 이름을 입력해 주세요.', 'INVALID_SESSION');
    }
    return { ...session, host: session.host.trim(), port: port(session.port ?? 22) };
  }

  async _authentication(connection, session, overrides = {}, { authState = createAuthenticationState(), clock = connection.setupClock } = {}) {
    const authType = session.authType === 'publickey' ? 'key' : (session.authType || 'password');
    const allowPasswordReprompt = (overrides.passwordReprompt ?? session.passwordReprompt) === 'allow-inline';
    // A profile (including a jump host) is never an authority for a device password.
    let password = overrides.password;
    let passphrase = overrides.passphrase ?? session.passphrase;
    let privateKey, parsed;
    const fields = [];
    if (!session.username || !session.username.trim()) fields.push('username');
    if (authType === 'password' && (password === undefined || password === null || password === '')) fields.push('password');
    if (authType === 'key') {
      const keyPath = session.keyPath || session.privateKeyPath;
      if (typeof keyPath !== 'string' || !keyPath) throw new ServiceError('이 세션에서 사용할 개인키 파일을 선택해 주세요.', 'KEY_REQUIRED');
      const stats = await this._await(connection, () => fs.promises.stat(keyPath));
      this._assertOpen(connection);
      if (!stats.isFile() || stats.size > MAX_BUFFER) throw new ServiceError('개인키 파일이 올바르지 않거나 너무 큽니다.', 'INVALID_KEY');
      privateKey = await this._await(connection, () => fs.promises.readFile(keyPath));
      this._assertOpen(connection);
      parsed = utils.parseKey(privateKey, passphrase);
      if (parsed instanceof Error && !passphrase && /no passphrase given/i.test(parsed.message)) fields.push('passphrase');
      else if (parsed instanceof Error || !parsed) throw new ServiceError('개인키를 읽지 못했습니다. 키 형식과 암호를 확인해 주세요.', 'INVALID_KEY');
    }
    if (!['password', 'key', 'agent', 'keyboard-interactive'].includes(authType)) throw new ServiceError('지원하지 않는 SSH 인증 방식입니다.', 'INVALID_AUTH');
    if (fields.length) {
      this._authState(connection, 'credential-await');
      let reply;
      clock?.pause();
      try {
        reply = await this._await(connection, () => this.ask({
          kind: 'credentials', connectionId: connection.id, fields,
          session: { name: session.name, host: session.host, port: session.port, username: session.username, authType, needsUsername: fields.includes('username') },
        }));
      } finally { clock?.resume(); }
      this._assertOpen(connection);
      if (!reply || reply.cancelled) throw new ServiceError('인증을 취소했습니다.', 'AUTH_CANCELLED');
      if (typeof reply !== 'object' || Array.isArray(reply)
          || Object.keys(reply).some(key => !fields.includes(key) && !(key === 'cancelled' && reply[key] === false))) {
        throw new ServiceError('인증 정보가 올바르지 않습니다.', 'AUTH_REQUIRED');
      }
      for (const field of fields) if (typeof reply[field] !== 'string' || reply[field].length > (field === 'username' ? 256 : 16384)) {
        throw new ServiceError('인증 정보가 올바르지 않습니다.', 'AUTH_REQUIRED');
      }
      if (fields.includes('username')) {
        if (!reply.username.trim() || /[\x00-\x1f\x7f]/.test(reply.username)) throw new ServiceError('유효한 SSH 사용자 이름을 입력해 주세요.', 'AUTH_REQUIRED');
        session.username = reply.username.trim();
      }
      if (fields.includes('password')) password = reply.password;
      if (fields.includes('passphrase')) passphrase = reply.passphrase;
    }
    if (typeof session.username !== 'string' || !session.username.trim() || session.username.length > 256 || /[\x00-\x1f\x7f]/.test(session.username)) {
      throw new ServiceError('유효한 SSH 사용자 이름을 입력해 주세요.', 'AUTH_REQUIRED');
    }
    session.username = session.username.trim();
    if (authType === 'password') {
      if (typeof password !== 'string' || !password.length || password.length > 16384 || password.includes('\0')) throw new ServiceError('비밀번호를 입력해 주세요.', 'AUTH_REQUIRED');
      return { password, authState, allowPasswordReprompt, authHandler: authenticationHandler(['keyboard-interactive', 'password'], authState) };
    }
    if (authType === 'key') {
      if (fields.includes('passphrase')) parsed = utils.parseKey(privateKey, passphrase);
      if (parsed instanceof Error || !parsed) throw new ServiceError('개인키를 읽지 못했습니다. 키 형식과 암호를 확인해 주세요.', 'INVALID_KEY');
      connection.info.authenticationKey = (Array.isArray(parsed) ? parsed[0] : parsed).type;
      return { privateKey, passphrase, authState, allowPasswordReprompt, authHandler: authenticationHandler(['publickey', 'keyboard-interactive'], authState) };
    }
    if (authType === 'agent') {
      const agent = session.agentPath || session.agent || (process.platform === 'win32' ? WINDOWS_AGENT : process.env.SSH_AUTH_SOCK);
      if (!agent) throw new ServiceError('SSH 에이전트를 사용할 수 없습니다. 에이전트 소켓을 설정해 주세요.', 'AGENT_REQUIRED');
      return { agent, authState, allowPasswordReprompt, authHandler: authenticationHandler(['agent', 'keyboard-interactive'], authState) };
    }
    return { password: typeof password === 'string' ? password : undefined, authState, allowPasswordReprompt, authHandler: authenticationHandler(['keyboard-interactive'], authState) };
  }

  _verifyHost(connection, session, key, deferUntilVerified = false) {
    const hostKey = normalizeHostKey(`${session.host}:${session.port}`);
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    // Serialize trust decisions so each dialog refers to the latest saved key.
    const previousTask = this.trustQueues.get(hostKey) || Promise.resolve();
    let release = () => {};
    let hold = Promise.resolve();
    if (deferUntilVerified) {
      hold = this._pending(connection, done => { release = () => done(null, true); });
    }
    const task = previousTask.catch(() => {}).then(async () => {
      this._assertOpen(connection);
      const previous = (await this._await(connection, () => this.knownHosts.get(hostKey))) || null;
      this._assertOpen(connection);
      if (previous === fingerprint) {
        if (deferUntilVerified) release();
        return true;
      }
      const reply = await this._await(connection, () => this.ask({
        kind: previous ? 'host-key-changed' : 'host-key', connectionId: connection.id,
        host: session.host, port: session.port, fingerprint,
        previousFingerprint: previous,
      }));
      this._assertOpen(connection);
      if (previous && (!reply || reply.accept !== true || reply.replace !== true)) {
        throw new ServiceError(`${hostKey} 서버의 호스트 키 교체를 취소했습니다.`, 'HOST_KEY_CHANGED');
      }
      if (!reply || reply.accept !== true) {
        throw new ServiceError('서버 호스트 키를 승인하지 않아 연결하지 않았습니다.', 'HOST_KEY_REJECTED');
      }
      const commit = async () => {
        const current = (await this._await(connection, () => this.knownHosts.get(hostKey))) || null;
        this._assertOpen(connection);
        if (current !== previous && current !== fingerprint) {
          throw new ServiceError('확인 중 저장된 호스트 키가 바뀌었습니다. 다시 연결해 확인해 주세요.', 'HOST_KEY_CHANGED');
        }
        if ((previous || reply.remember === true) && current !== fingerprint) {
          await this._await(connection, () => this.knownHosts.set(hostKey, fingerprint, current));
          this._assertOpen(connection);
        }
      };
      if (deferUntilVerified) return async () => {
        try { await commit(); } finally { release(); }
      };
      await commit();
      return true;
    });
    task.catch(() => release());
    const tail = Promise.allSettled([task, hold]);
    this.trustQueues.set(hostKey, tail);
    const clear = () => { if (this.trustQueues.get(hostKey) === tail) this.trustQueues.delete(hostKey); };
    tail.then(clear, clear);
    return task;
  }

  _handshakeTimer(connection) {
    let timer, started, paused = 0, stopped = false;
    let remaining = connection.handshakeTimeoutMs;
    const clock = {
      start: () => {
        if (stopped || connection.closed || paused || timer) return;
        started = performance.now();
        timer = setTimeout(() => {
          clock.stop();
          this._fail(connection, new ServiceError('SSH 연결 협상 시간이 초과되었습니다. 서버 상태를 확인한 뒤 다시 연결해 주세요.', 'HANDSHAKE_TIMEOUT'));
        }, Math.max(1, remaining));
      },
      pause: () => {
        if (stopped) return;
        paused++;
        if (timer) {
          remaining = Math.max(0, remaining - (performance.now() - started));
          clearTimeout(timer); timer = null;
        }
      },
      resume: () => {
        if (stopped) return;
        if (paused) paused--;
        clock.start();
      },
      stop: () => {
        stopped = true;
        clearTimeout(timer); timer = null;
        connection.handshakes.delete(clock);
      },
    };
    connection.handshakes.add(clock);
    return clock;
  }

  async _openClient(connection, session, overrides, sock) {
    // The clock starts before connecting; only real user prompt time is paused.
    this._assertOpen(connection);
    let authentication = null, preparePromise = null, pendingContinuation = null, clientClosed = false;
    const client = new Client();
    // KEX completing means everything after this point is authentication, so a
    // peer that vanishes here is judged differently from an unreachable host.
    let handshakeSeen = false;
    let pendingHostCommit = null, hostCommitPromise = Promise.resolve();
    // ssh2 emits handshake only after verifying the exchange signature. Keep
    // deferred trust writes ahead of any credential preparation/USERAUTH.
    client.on('handshake', () => {
      if (!pendingHostCommit) return;
      const commit = pendingHostCommit; pendingHostCommit = null;
      hostCommitPromise = Promise.resolve().then(commit);
      hostCommitPromise.catch(error => this._fail(connection, publicError(error, '서버 호스트 키를 저장하지 못했습니다')));
    });
    // `ready` splits the client's life into an authentication phase and a
    // connected phase. Every later error belongs to the connected phase: the
    // session was already established, so "SSH 인증 중 연결이 끊겼습니다" would tell
    // an operator to suspect their credentials or an account lockout for a
    // perfectly ordinary drop (V6-L-01).
    let readySeen = false;
    client.on('handshake', info => { handshakeSeen = true; connection.info.negotiated = compatibility.negotiated(info); });
    const transportClosed = new Promise(resolve => client.once('close', resolve));
    connection.clients.set(client, null);
    const handshake = connection.setupClock ||= this._handshakeTimer(connection);
    let verificationError,dsaHostKey=false,passwordChallengeUsed=false,keyboardRounds=0,handleKeyboardInteractive;
    const authenticationAttempts = [];
    // Each hop owns its selector state and pending continuation.
    const authState = createAuthenticationState();
    connection.authState = authState;
    client.once('close', () => { clientClosed = true; pendingContinuation = null; authentication = null; preparePromise = null; });
    const publishAuthentication = () => {
      connection.info.authenticationAttempts = [...authenticationAttempts];
      connection.info.authenticationPhase = authState.phase;
      connection.info.authenticationSubmissions = authState.submissionCount;
    };
    const deferredHandler = (methodsLeft, partialSuccess, callback) => {
      if (connection.closed || clientClosed) return;
      if (pendingContinuation) {
        this._fail(connection, new ServiceError('중복된 SSH 인증 요청을 처리할 수 없습니다.', 'AUTH_FAILED'));
        return;
      }
      const token = {}; pendingContinuation = token;
      if (!preparePromise) preparePromise = hostCommitPromise.then(() => this._authentication(connection, session, overrides, { authState, clock: handshake }));
      preparePromise.then(value => {
        if (connection.closed || clientClosed || pendingContinuation !== token) return;
        authentication = value;
        const method = authentication.authHandler(methodsLeft, partialSuccess);
        let payload = false;
        if (method) {
          this._authState(connection, 'authenticating');
          const username = session.username;
          if (method === 'none') payload = { type: method, username };
          else if (method === 'password') payload = { type: method, username, password: authentication.password };
          else if (method === 'publickey') payload = { type: method, username, key: authentication.privateKey, passphrase: authentication.passphrase };
          else if (method === 'agent') payload = { type: method, username, agent: authentication.agent };
          else if (method === 'keyboard-interactive') payload = { type: method, username, prompt: handleKeyboardInteractive };
          else throw new ServiceError('지원하지 않는 SSH 인증 방식입니다.', 'INVALID_AUTH');
          authenticationAttempts.push(method); connection.info.authenticationMethod = method;
        }
        publishAuthentication();
        pendingContinuation = null;
        callback(payload);
      }).catch(error => {
        if (connection.closed || clientClosed || pendingContinuation !== token) return;
        pendingContinuation = null;
        this._fail(connection, publicError(error, 'SSH 인증 정보를 준비하지 못했습니다'));
      });
    };
    const ready = this._pending(connection, done => {
      // The handshake flag is the outer one: registering a second listener here
      // was redundant (the same client emitted the same handshake twice) and made
      // `handshakeSeen` a different variable from the one the error classifier
      // reads. It is now recorded once, per client.
      client.once('connect', () => { client.setNoDelay(true); this._authState(connection, 'transport-ready'); });
      client.once('ready', () => {
        if (authentication) authentication.password = undefined;
        readySeen = true; connection.authPhaseComplete = true; connection.info.authPhase = 'connected'; done(null, client);
      });
      client.on('error', error => {
        handshake.stop();
        // A reset during authentication is not a wrong password: OmniSwitch
        // style AAA also drops the session on its own lockout or session limit.
        // Keep the safe socket code instead of collapsing it into AUTH_FAILED.
        // After `ready` the same socket code is a session end, not an auth
        // verdict, so it is reported as a disconnect with the transport code.
        const authenticated = !readySeen && handshakeSeen && authState.methodTrace.length > 0;
        const safe = verificationError || (readySeen && PEER_GONE.has(error?.code)
          ? new ServiceError(`SSH 연결이 종료되었습니다. 장비 또는 네트워크가 세션을 끊었습니다. (${error.code})`, error.code)
          : authenticated && PEER_GONE.has(error?.code)
            ? new ServiceError(`SSH 인증 중 연결이 끊겼습니다. 장비의 접속 제한·잠금 상태를 확인해 주세요. (${error.code})`, error.code)
            : publicError(error, 'SSH 연결에 실패했습니다'));
        // A post-ready error is a session end, not an auth verdict. The message is
        // reclassified here, but the *termination* stays with the shell channel so
        // already-received bytes are still drained and logged (the drain path owns
        // that). If no shell exists yet, nothing else can end the connection.
        if (readySeen) {
          done(safe);
          connection.transportError = safe;
          if (!connection.closed && !connection.shell) this._finish(connection, 'disconnected', safe.message, safe.code);
          return;
        }
        done(safe);
        this._fail(connection, safe);
      });
      client.once('close', () => {
        handshake.stop();
        // A peer close mid-authentication keeps its own safe code so the
        // operator is told to check the device's access limit instead of being
        // shown a generic rejection. Nothing is claimed about the password.
        // After `ready` this is a normal end of an established session.
        if (readySeen) {
          if (!connection.closed && !connection.shell) this._finish(connection, 'disconnected', 'SSH 연결이 종료되었습니다.');
          return;
        }
        const cut = handshakeSeen && authState.methodTrace.length > 0 && !verificationError;
        const error = new ServiceError(
          cut ? 'SSH 인증 중 연결이 끊겼습니다. 장비의 접속 제한·잠금 상태를 확인해 주세요.' : 'SSH 연결이 준비되기 전에 닫혔습니다.',
          cut ? 'AUTH_CONNECTION_CLOSED' : 'NOT_CONNECTED');
        if (done(error) && !connection.closed) this._finish(connection, 'disconnected', cut ? error.message : 'SSH connection closed.', cut ? error.code : undefined);
      });
      client.on('change password', () => {
        if (connection.closed) return;
        // RFC 4252 password expiry is not a network timeout. Do not send the
        // saved password as a replacement or retain arbitrary server text.
        handshake.stop();
        const error = new ServiceError('SSH 비밀번호 변경이 필요합니다. 장비에서 비밀번호를 변경한 뒤 다시 연결해 주세요.', 'AUTH_PASSWORD_CHANGE_REQUIRED');
        done(error);
        this._fail(connection, error);
      });
      handleKeyboardInteractive = (name, instructions, language, prompts, finish) => {
        if (connection.closed) return;
        if (++keyboardRounds > 32) { this._fail(connection, new ServiceError('서버 인증 질문 횟수를 초과했습니다.', 'AUTH_FAILED')); return; }
        const passwordChallenge = prompts.length > 0 && typeof authentication.password === 'string'
          && isPasswordChallenge(prompts, name, instructions);
        // Auto-answering is only ever the *first* configured-secret answer of this
        // client. `loginPasswordSubmitted` is client-wide, so a factor that already
        // used the login password (ssh2's plain `password` method, or an earlier
        // keyboard factor) never gets that secret silently replayed into a later
        // prompt — an OTP/verification factor must be answered by the operator.
        const mayAutoAnswerPassword = !passwordChallengeUsed && !authState.loginPasswordSubmitted;
        // `fresh-on-password-reprompt`: the configured login secret was already
        // answered in this factor and the device now asks for `Password:` again
        // on the same transport. Alcatel/OmniSwitch AAA keeps the failed context
        // for the life of the SSH session, so a second answer is rejected even
        // when it is correct and only spends another lockout attempt. End this
        // connection instead, with a code that tells the operator to run again on
        // a fresh one. OTP/PIN/verification/challenge prompts, echo prompts,
        // operator-answered prompts and post-partial-success factors are all
        // outside this rule (see ssh-authentication.requiresFreshConnection).
        if (passwordChallenge && !authentication.allowPasswordReprompt && requiresFreshConnection(authState)) {
          authState.repromptBlocked = true; authState.phase = 'rejected';
          const error = new ServiceError(AUTH_RETRY_NEW_CONNECTION_MESSAGE, AUTH_RETRY_NEW_CONNECTION_REQUIRED);
          publishAuthentication();
          this._fail(connection, error);
          return;
        }
        if (!prompts.length || (mayAutoAnswerPassword && passwordChallenge)) {
          if (prompts.length) {
            passwordChallengeUsed = true;
            // This is the configured login password going on the wire. Record
            // the submission *before* finishing so an ordinary rejection in the
            // same factor can never be answered with the same secret again.
            authState.promptRounds += 1;
            markLoginPasswordSubmitted(authState, 'keyboard-interactive');
            publishAuthentication();
          }
          try { finish(prompts.length ? [authentication.password] : []); }
          catch (error) { this._fail(connection, publicError(error, '키보드 대화형 인증에 실패했습니다')); }
          return;
        }
        this._authState(connection, 'credential-await');
        handshake.pause();
        this._await(connection, () => this.ask({
          kind: 'keyboard-interactive', connectionId: connection.id,
          session: { host: session.host, port: session.port, protocol: 'ssh' },
          name, instructions, prompts: prompts.map(({ prompt, echo }) => ({ prompt, echo: !!echo })),
        })).then(reply => {
          handshake.resume();
          this._assertOpen(connection);
          if (!reply || !Array.isArray(reply.answers) || reply.answers.length !== prompts.length
            || !reply.answers.every(answer => typeof answer === 'string')) {
            throw new ServiceError('키보드 대화형 인증을 취소했습니다.', 'AUTH_CANCELLED');
          }
          // The operator's answer is a real submission too, so a rejection of it
          // must not silently replay the configured login password afterwards.
          // It is never promoted to the login password: it may be an OTP or
          // another factor entirely.
          authState.promptRounds += 1;
          markPromptAnswerSubmitted(authState, 'keyboard-interactive');
          publishAuthentication();
          this._authState(connection, 'authenticating');
          finish(reply.answers);
        }).catch(error => { handshake.stop(); this._fail(connection, publicError(error, '키보드 대화형 인증에 실패했습니다')); });
      };
      const keepalive = Number(session.keepaliveSeconds ?? session.keepaliveInterval ?? 30);
      if (!Number.isFinite(keepalive) || keepalive < 0 || keepalive > 86400) {
        throw new ServiceError('Keepalive 간격은 0부터 86400초 사이여야 합니다.', 'INVALID_KEEPALIVE');
      }
      handshake.start();
      client.connect({
        host: session.host, port: session.port, username: session.username || '',
        algorithms:compatibility.algorithms(connection.sshCompatibility),
        // Inspect only fixed library diagnostics, without retaining or relaying raw text.
        debug:connection.sshCompatibility==='legacy'?line=>{if(line==='Handshake: Host key format: ssh-dss')dsaHostKey=true;if(dsaHostKey&&line.startsWith('Signature verification failed:')&&line.includes('UNSUPPORTED_ALGORITHM'))verificationError=new ServiceError('이 장비의 DSA 전용 호스트 키를 지원하지 않습니다. RSA 호스트 키 사용 여부를 확인해 주세요.','SSH_DSA_UNSUPPORTED');}:undefined,
        authHandler: deferredHandler, sock, tryKeyboard: true,
        keepaliveInterval: Math.round(keepalive * 1000), keepaliveCountMax: 3,
        // Main owns the prompt deadline; this clock counts only network wait.
        readyTimeout: 0,
        hostVerifier: (key, callback) => {
          // This also covers waiting for another first-trust dialog in the queue.
          this._authState(connection, 'host-key');
          handshake.pause();
          this._verifyHost(connection, session, key, true).then(accepted => {
            handshake.resume();
            if (!connection.closed && typeof accepted === 'function') pendingHostCommit = accepted;
            try { callback(!connection.closed && !!accepted); } catch { /* transport closed */ }
          }, error => {
            handshake.stop();
            verificationError = publicError(error, '서버 호스트 키를 확인하지 못했습니다');
            try { callback(false); } catch { /* transport closed */ }
          });
        },
      });
      if (!connection.closed) { this._trackClientClose(connection, client); connection.clients.set(client, transportClosed); }
    });
    return ready;
  }

  _resource(connection, stream, message) {
    if (connection.closed) { destroy(stream); return stream; }
    connection.resources.add(stream);
    stream.on('error', error => this._fail(connection, publicError(error, message)));
    stream.once('close', () => connection.resources.delete(stream));
    return stream;
  }

  async _forwardOut(connection, client, sourceHost, sourcePort, host, targetPort) {
    return this._pending(connection, done => {
      client.forwardOut(sourceHost, sourcePort, host, targetPort, (error, stream) => {
        if (connection.closed) { if (stream) destroy(stream); return; }
        if (error) { done(error); return; }
        this._resource(connection, stream, 'SSH 포워딩 채널에 오류가 발생했습니다');
        if (!done(null, stream)) destroy(stream);
      });
    });
  }

  async _start(connection, overrides) {
    const session = await this._session(connection, connection.sessionId);
    connection.terminalEncoding = connection.autoEncoding?new AutomaticTerminalEncoding():new TerminalEncoding(session.encoding);
    connection.stderrEncoding = connection.autoEncoding?new AutomaticTerminalEncoding():new TerminalEncoding(session.encoding);
    connection.info = { name: session.name, host: session.host, port: session.port, protocol: 'ssh',
      username: session.username, authType: session.authType || 'password',
      encoding: connection.terminalEncoding.encoding,
      jumpSessionId: session.jumpSessionId || null, terminalType: session.terminalType || 'xterm-256color' };
    let sock;
    if (session.jumpSessionId) {
      if (session.jumpSessionId === connection.sessionId) {
        throw new ServiceError('세션 자신을 점프 호스트로 사용할 수 없습니다.', 'INVALID_JUMP');
      }
      const jump = await this._session(connection, session.jumpSessionId);
      if (jump.jumpSessionId) {
        throw new ServiceError('점프 호스트는 한 단계만 지원합니다. 점프 세션에 지정된 점프 호스트를 해제해 주세요.', 'INVALID_JUMP');
      }
      const jumpClient = await this._openClient(connection, jump);
      sock = await this._forwardOut(connection, jumpClient, '127.0.0.1', 0, session.host, session.port);
    }
    connection.client = await this._openClient(connection, session, overrides, sock);
    connection.info.username = session.username;
    this._assertOpen(connection);
    connection.sessionLogEnabled = !!session.logEnabled;
    const autoLog = session.logEnabled || this.getLogSettings().logEnabled;
    connection.initialLogRequested = !!autoLog;
    if (autoLog) connection.logFormat = this.getLogSettings().logFormat || DEFAULT_LOG_SETTINGS.logFormat;
    // Remember the size the PTY is actually opened with, so a later resize that
    // asks for the same dimensions is not sent as a window-change.
    const opened = dimensions(connection.cols, connection.rows);
    // Open managed shells with zero wire credit. Explicit grants reserve raw
    // bytes plus worst decoder expansion before advertising a shared window.
    // Idle channels no longer reserve two HWM buffers plus a default window.
    connection.receiveLease = this.receiveSource?.({ id: connection.id,
      reserveBytes: 0, maxChunkBytes: 128 * 1024,
      windowControl: {
        ready: () => !!connection.shell && !connection.closed && !connection.receiveLogPaused && !connection.transportPaused && !connection.logOpening,
        grant: bytes => connection.shell.grantReceive(bytes),
      },
      setPaused: paused => {
        connection.receivePaused = !!paused;
        if (connection.closed) return;
        if (paused) { connection.shell?.pause(); connection.shell?.stderr?.pause(); }
        else if (!connection.transportPaused && !connection.receiveLogPaused && !connection.logOpening) {
          connection.shell?.resume(); connection.shell?.stderr?.resume();
        }
        this._watchPausedShell(connection);
      } });
    const shell = await this._pending(connection, done => {
      connection.client.shell({ term: connection.info.terminalType, cols: opened.cols,
        rows: opened.rows, width: 0, height: 0 }, { sessiondockReceiveWindow: !!connection.receiveLease }, (error, stream) => {
        if (connection.closed) { if (stream) destroy(stream); return; }
        if (error) { done(error); return; }
        this._resource(connection, stream, '터미널 채널에 오류가 발생했습니다');
        // Own the receive buffers before resolving the promise: transport
        // closure may be delivered before _start's await continuation runs.
        connection.shell = stream;
        connection.shellCols = opened.cols; connection.shellRows = opened.rows;
        if (!done(null, stream)) destroy(stream);
      });
    });
    this._assertOpen(connection);
    connection.shell = shell;
    connection.setupClock.stop();
    // Logging must not stop the channel: bytes that arrive before the file is
    // open are retained in a bounded pre-open buffer and formatted once it is.
    connection.stdoutData = data => this._terminalData(connection, data);
    connection.stderrData = data => this._terminalData(connection, data, 'stderr');
    shell.on('data', connection.stdoutData);
    shell.stderr.on('data', connection.stderrData);
    connection.receiveLease?.ready();
    if (connection.receivePaused) { shell.pause(); shell.stderr.pause(); this._watchPausedShell(connection); }
    shell.stderr.on('error', error => this._fail(connection, publicError(error, '터미널 채널에 오류가 발생했습니다')));
    shell.once('close', () => {
      // A post-ready transport error already produced a classified message
      // ("연결이 종료되었습니다 … (ECONNRESET)") — reuse it instead of the generic
      // channel-close text, so an established session dropping is never reported
      // as an authentication problem (V6-L-01).
      if (!connection.closed) this._finish(connection, 'disconnected', connection.transportError?.message || 'Terminal session closed.', connection.transportError?.code);
    });
    shell.stderr.once('close', () => {
      if (!connection.closed) this._finish(connection, 'disconnected', 'Terminal session closed.');
    });
    if (shell.incoming?.state === 'closed') {
      this._finish(connection, 'disconnected', 'Terminal session closed.');
      return;
    }
    // Automatic logging is a side service, not part of the transport: a failed
    // open (invalid template, EACCES, ENOSPC, slow UNC path) must never reject the
    // session. It keeps `logIncomplete` + a `log-error` event and the interactive
    // connection continues, per §4.2.
    if (autoLog) await this._startAutomaticLogging(connection, session);
    connection.initialLogRequested = false;
    await this._startForwards(connection, session.forwards || session.forwardings || []);
    this._assertOpen(connection);
    connection.status = 'connected';
    this._authState(connection, 'ready');
    this._emit({ type: 'status', id: connection.id, status: 'connected', username: session.username, message: 'Connected.' });
  }

  // Starts the session/global recording an automatic policy asked for, without
  // ever turning a log problem into a connection failure. Ownership of the
  // transport stays with _start(); this only reports the recording state.
  async _startAutomaticLogging(connection, session) {
    const source = session.logEnabled ? 'session' : 'global';
    try {
      await this.setLogging(connection.id, true, source);
      return true;
    } catch (error) {
      if (connection.closed) return false;
      const safe = publicError(error, '세션 로그 파일을 열지 못했습니다');
      // `publicError` collapses an uncoded filesystem failure into the generic
      // service code; report it as a log-open failure so the UI can distinguish
      // "recording unavailable" from "connection failed".
      const code = !safe.code || safe.code === 'SSH_SERVICE_ERROR' ? 'LOG_OPEN_FAILED' : safe.code;
      // The bytes already received can never be written to that file, so the loss
      // is explicit rather than silent, and the session stays usable.
      connection.logIncomplete = true;
      connection.logOpening = false;
      connection.initialLogRequested = false;
      this._emit({
        type: 'log', id: connection.id, enabled: false, path: null,
        incomplete: true, droppedLogBytes: connection.logDroppedBytes || 0,
      });
      this._emit({ type: 'log-error', id: connection.id, message: safe.message, code });
      return false;
    }
  }

  // Independent pause reason: healthy disk backlogs drain without consuming
  // display ACKs. Existing log stall/error/hard guards still fail the log only.
  _receiveLogPressure(id, generation) {
    const connection = this.connections.get(id);
    if (!connection?.receiveLease || connection.closed || connection.logQueueGeneration !== generation) return;
    const pending = this.logQueue.pending(id);
    const paused = !this.logQueue.failed(id) && (pending >= 4 * 1024 * 1024
      || (connection.receiveLogPaused && pending >= 2 * 1024 * 1024));
    if (!!connection.receiveLogPaused === paused) return;
    connection.receiveLogPaused = paused;
    if (!paused) connection.receiveLease.ready?.();
    if (paused) { connection.shell?.pause(); connection.shell?.stderr?.pause(); }
    else if (!connection.receivePaused && !connection.transportPaused && !connection.logOpening) {
      connection.shell?.resume(); connection.shell?.stderr?.resume();
    }
    this._watchPausedShell(connection);
  }

  _terminalData(connection, data, channel = 'stdout', draining = false) {
    const action = () => this._consumeTerminalData(connection, data, channel, draining);
    return connection.receiveLease?.consume ? connection.receiveLease.consume(data.length, action) : action();
  }

  _consumeTerminalData(connection, data, channel = 'stdout', draining = false) {
    if (connection.closed && !(draining && connection.receiveDrain)) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const decoder = channel === 'stderr' ? connection.stderrEncoding : connection.terminalEncoding;
    const decoded = decoder ? decoder.decode(bytes) : bytes;
    // Complete characters independently before merging stdout/stderr. Sending
    // partial UTF-8 wire bytes lets the other stream corrupt xterm's decoder.
    const display = decoded;
    if(connection.autoEncoding&&decoder?.encoding!=='auto')connection.info.encoding=decoder.encoding;
    // Raw logs retain transport bytes. Text logs consume UTF-8 already decoded
    // independently for stdout/stderr, so partial characters cannot cross streams.
    this._writeTerminalLog(connection, bytes, display);
    this._receiveLogPressure(connection.id, connection.logQueueGeneration);
    // A log failure can synchronously complete a connection with no receive
    // backlog. Never send this chunk after its final status/decoder flush.
    if (connection.closed && !(draining && connection.receiveDrain)) return;
    // A consumer may synchronously disconnect in response to output. Record
    // this chunk before handing it over, so synchronous closure cannot lose it.
    if (display.length) this._emit({ type: 'data', id: connection.id, data: this.binaryOutput ? display : display.toString('base64') });
  }

  _writeTerminalLog(connection, bytes, display) {
    if (connection.logWriter && connection.logFormatter) {
      this._enqueueTerminalLog(connection, bytes, display, this.logClock());
      return;
    }
    // A log open is in flight. Keep the exact raw/decoded bytes so the file still
    // starts at the first received byte, without pausing the transport.
    if (!connection.logOpening && !connection.initialLogRequested) {
      // Logging is off, or this writer was detached after a failure. In the second
      // case the output can never be recorded, so count it as an explicit loss.
      if (connection.logIncomplete) connection.logIntendedBytes = (connection.logIntendedBytes || 0) + (connection.logFormat === 'raw' ? bytes.length : display.length);
      return;
    }
    const pending = connection.logPending || (connection.logPending = []);
    const retained = connection.logPendingBytes || 0;
    // The pre-open buffer retains the raw wire bytes AND the display copy, so the
    // cap has to be charged for both. Counting only `bytes` let 16 × (1 MiB raw +
    // 3 MiB display) pass a "16 MiB" limit while 64 MiB of buffers were held
    // (V6-H-02). The shared reservation is also taken here, so pre-open memory is
    // part of the process log budget instead of a separate, invisible 16 MiB per
    // connection.
    const cost = bytes.length + (display && display !== bytes ? display.length : 0);
    if (retained + cost > LOG_PENDING_LIMIT || (this.logBudget && !this.logBudget.has(cost))) {
      connection.logIncomplete = true;
      connection.logIntendedBytes = (connection.logIntendedBytes || 0) + (connection.logFormat === 'raw' ? bytes.length : display.length);
      return;
    }
    const now = this.logClock();
    this._appendLogPending(connection, pending, retained, bytes, display, now, cost);
  }

  // Retains one received chunk in the pre-open buffer using fixed-size blocks.
  //
  // A stream that delivers one byte per packet used to allocate one object per
  // byte: 200,000 entries, each with its own header and two buffer references,
  // measured ≈68 MiB of heap for 400,000 counted bytes (V7-H-02). Copying into
  // 64 KiB blocks makes the object count a function of the byte total, which is
  // what the byte cap already bounds, instead of the packet rate. Bytes, their
  // order and `logPendingBytes` are unchanged; the copy only replaces the retained
  // reference, so the incoming chunk itself is released immediately.
  _appendLogPending(connection, pending, retained, bytes, display, now, cost) {
    // The display copy is a different allocation only when the log format decodes
    // the wire bytes (text logs). For a raw log it *is* `bytes`, so it is neither
    // counted nor stored twice.
    const separateDisplay = display && display !== bytes ? display : null;
    const displayLength = separateDisplay ? separateDisplay.length : bytes.length;
    const tail = pending[pending.length - 1];
    // Block entries are the only mergeable ones: a large chunk retained as-is is
    // already bounded and re-copying it would double its memory for no gain.
    // A tail whose display copy was its own wire bytes (a raw log) currently has no
    // display block; if this chunk needs a separate one, the earlier wire bytes are
    // valid display text for that prefix and are copied over before appending.
    const displayAt = tail ? (tail.displayBlock ? tail.displayUsed : tail.used) : 0;
    const fits = !!tail && tail.block
      && tail.used + bytes.length <= LOG_PENDING_BLOCK
      // A block must not straddle a day boundary: the text formatter stamps from
      // this timestamp and the daily writer picks its file from it.
      && dateParts(tail.now).date === dateParts(now).date;
    const charge = () => {
      connection.logPendingBytes = retained + cost;
      if (this.logBudget) { this.logBudget.reserve(cost); connection.logPendingReserved = (connection.logPendingReserved || 0) + cost; }
    };
    if (fits) {
      // Record the receive time of *this* chunk before touching `tail.now`: the
      // formatter must stamp every segment with the moment its own bytes arrived.
      // Overwriting `tail.now` alone rewrote an earlier chunk's 00:00:01 as the
      // later 00:00:04 in the text log (V7-H-02).
      if (!tail.segments) tail.segments = [{ rawAt: 0, displayAt: 0, now: tail.now }];
      const last = tail.segments[tail.segments.length - 1];
      if (!last || +last.now !== +now) tail.segments.push({ rawAt: tail.used, displayAt, now });
      // Allocate/extend the display copy *before* the raw append, so seeding it
      // from the wire bytes still sees the previous `used` length.
      const block = SshService._ensureDisplayBlock(tail, displayAt + displayLength);
      bytes.copy(tail.bytes, tail.used);
      tail.used += bytes.length;
      if (separateDisplay) separateDisplay.copy(block, tail.displayUsed);
      // A raw chunk's display text is its own wire bytes, but a display block that
      // already exists must still receive a copy: bumping `displayUsed` alone left
      // an uninitialised hole the replay then handed out as display text (V7-H-02).
      else bytes.copy(block, tail.displayUsed);
      tail.displayUsed += displayLength;
      tail.now = now;
      tail.cost += cost;
      charge();
      return;
    }
    if (bytes.length >= LOG_PENDING_BLOCK) {
      // A chunk at least as large as a block is already its own allocation:
      // retain it as-is instead of copying it again.
      pending.push({ bytes, display: separateDisplay || undefined, now, cost, used: bytes.length, displayUsed: separateDisplay ? separateDisplay.length : 0, block: false });
    } else {
      const block = Buffer.allocUnsafe(LOG_PENDING_BLOCK);
      bytes.copy(block, 0);
      const displayBlock = separateDisplay
        ? Buffer.allocUnsafe(Math.max(LOG_PENDING_BLOCK, separateDisplay.length)) : null;
      if (displayBlock) separateDisplay.copy(displayBlock, 0);
      pending.push({ bytes: block, displayBlock, now, cost, used: bytes.length,
        displayUsed: separateDisplay ? separateDisplay.length : 0, block: true,
        segments: [{ rawAt: 0, displayAt: 0, now }] });
    }
    charge();
  }

  // Grows a block's display allocation to hold `needed` bytes. The wire block is
  // fixed, but the decoded display form can be longer than the raw chunk (CP949 →
  // UTF-8), so a display copy larger than one block must extend instead of being
  // silently clipped at 64 KiB (V7-H-02).
  static _ensureDisplayBlock(entry, needed) {
    if (!entry.displayBlock) {
      const seeded = Buffer.allocUnsafe(Math.max(LOG_PENDING_BLOCK, needed));
      entry.bytes.copy(seeded, 0, 0, entry.used);
      entry.displayBlock = seeded;
      entry.displayUsed = entry.used;
      return seeded;
    }
    const block = entry.displayBlock;
    if (block.length >= needed) return block;
    const grown = Buffer.allocUnsafe(Math.max(needed, block.length * 2));
    block.copy(grown, 0, 0, entry.displayUsed);
    entry.displayBlock = grown;
    return grown;
  }

  // The exact bytes of one pre-open entry. A block entry owns a 64 KiB allocation
  // of which only `used` bytes were filled, so the uninitialised suffix is never
  // handed to the formatter (it would write garbage into the log).
  static _pendingChunk(entry) {
    if (!entry.block || entry.used === entry.bytes.length) return entry.bytes;
    return entry.bytes.subarray(0, entry.used);
  }

  // The exact display copy of one pre-open entry. Without a separate display the
  // wire bytes were themselves the display text — but a chunk retained as a whole
  // buffer (raw >= 64 KiB) keeps its distinct decode in `display`, and reading only
  // `displayBlock` replayed raw bytes as display text (V7-H-02).
  static _pendingDisplay(entry) {
    if (!entry.displayBlock) {
      if (entry.display) return entry.display;
      return SshService._pendingChunk(entry);
    }
    const block = entry.displayBlock;
    return entry.displayUsed === block.length ? block : block.subarray(0, entry.displayUsed);
  }

  // Give the pre-open reservation back exactly once, whatever path ended the
  // recording (replay, failed open, close).
  _releaseLogPending(connection) {
    const reserved = connection.logPendingReserved || 0;
    if (reserved && this.logBudget) this.logBudget.release(reserved);
    connection.logPendingReserved = 0;
  }

  // Formats at the queue boundary (the formatter owns the raw/text definition and
  // its per-stream decoder) and hands the result to the bounded log pump. No file
  // I/O and no flow control happens on the transport callback.
  _enqueueTerminalLog(connection, bytes, display, now) {
    const formatter = connection.logFormatter;
    if (!formatter) {
      // The writer was detached (a previous log failure). This output can never be
      // recorded, so it is counted as an explicit loss instead of vanishing.
      if (connection.logIncomplete) connection.logIntendedBytes = (connection.logIntendedBytes || 0) + (connection.logFormat === 'raw' ? bytes.length : display.length);
      return;
    }
    let logBytes;
    try { logBytes = formatter.write((formatter.raw ?? (connection.logFormat === 'raw')) ? bytes : display, now); }
    catch (error) {
      connection.logIntendedBytes = (connection.logIntendedBytes || 0) + ((formatter.raw ?? (connection.logFormat === 'raw')) ? bytes.length : display.length);
      this.logQueue.fail(connection.id, 'LOG_FORMAT_FAILED', publicError(error, '세션 로그를 저장하지 못했습니다').message);
      return;
    }
    connection.logIntendedBytes = (connection.logIntendedBytes || 0) + logBytes.length;
    if (!this.logQueue.enqueue(connection.id, { bytes: logBytes, raw: bytes, text: display, now })) {
      connection.logIncomplete = true;
      connection.logDroppedReported = Math.max(connection.logDroppedReported || 0, this.logQueue.dropped(connection.id) || 0);
    }
    // Every byte this recording intended to store. Loss is derived once at close
    // as intended-minus-written, so no path can be double counted or forgotten.
  }

  // Bytes not confirmed by the file callback, including refused bytes. A failed
  // write may have reached disk partially, so this is not an exact disk-size loss.
  logLossBytes(connection) {
    return Math.max(0, (connection.logIntendedBytes || 0) - (connection.logBytesWritten || 0));
  }

  // Replays bytes captured before the file was open, in receive order.
  _replayTerminalLog(connection) {
    const pending = connection.logPending;
    connection.logPending = null;
    connection.logPendingBytes = 0;
    // The bytes are about to be charged to the queue, so their pre-open
    // reservation is returned first; otherwise the same memory would be counted
    // twice against the process budget.
    this._releaseLogPending(connection);
    if (!pending || !pending.length) return;
    // `shift()` and not `for…of`: the formatter allocates the expanded text-log
    // form of every chunk, and holding the whole pre-open array alongside it keeps
    // both allocations resident for the entire replay. Dropping each consumed entry
    // releases its block before the next one is formatted (V7-H-02).
    while (pending.length) {
      const entry = pending.shift();
      if (!entry) continue;
      // A block merged chunks that arrived at different moments; each run of
      // chunks with one receive time is formatted separately so the text log keeps
      // the time its bytes actually arrived (V7-H-02).
      const segments = entry.segments;
      if (segments && segments.length > 1) {
        const chunk = SshService._pendingChunk(entry);
        const shown = SshService._pendingDisplay(entry);
        for (let index = 0; index < segments.length; index++) {
          const from = segments[index];
          const to = segments[index + 1];
          const rawEnd = to ? to.rawAt : entry.used;
          const displayEnd = to ? to.displayAt : entry.displayUsed;
          this._enqueueTerminalLog(connection, chunk.subarray(from.rawAt, rawEnd),
            shown.subarray(from.displayAt, displayEnd), from.now);
        }
        continue;
      }
      this._enqueueTerminalLog(connection, SshService._pendingChunk(entry), SshService._pendingDisplay(entry), entry.now);
    }
  }

  _resumeTerminal(connection) {
    connection.logPaused = false;
    connection.receiveLease?.ready();
    if (connection.receiveDrain) { this._scheduleReceiveDrain(connection); return; }
    // Only an explicit transport pause or an unfinished log open may stop reads.
    if (!connection.closed && connection.shell && !connection.transportPaused && !connection.receivePaused && !connection.receiveLogPaused && !connection.logOpening) {
      connection.shell.resume();
      connection.shell.stderr?.resume();
    }
    this._watchPausedShell(connection);
  }

  // Legacy explicit transport pause. The production display path no longer calls
  // this: display credit is renderer-only and never pauses an interactive
  // channel. It remains as a seam for tests that must create an already received
  // backlog, and for any future deliberate transport stop.
  // @deprecated use only for explicit transport control, never for display pressure.
  setOutputPaused(id, paused) {
    const connection = this.connections.get(id) || this.receiving.get(id); if(!connection)return;
    connection.transportPaused = !!paused;
    if (connection.receiveDrain) { this._scheduleReceiveDrain(connection); return; }
    if(connection.closed)return;
    if(paused){connection.shell?.pause();connection.shell?.stderr?.pause();}
    else if(!connection.logOpening&&!connection.receivePaused&&!connection.receiveLogPaused){connection.shell?.resume();connection.shell?.stderr?.resume();}
    this._watchPausedShell(connection);
  }

  _watchPausedShell(connection) {
    clearTimeout(connection.shellCloseTimer); connection.shellCloseTimer = null;
    if (connection.closed || connection.info.protocol !== 'ssh' || !connection.shell
      || !(connection.transportPaused || connection.receivePaused || connection.receiveLogPaused || connection.logOpening)) return;
    // ssh2 emits stream close only after that stream is consumed. When both
    // streams are paused, observe its channel-close state without consuming or
    // bypassing backpressure. EOF alone is not a full channel close.
    connection.shellCloseTimer = setTimeout(() => {
      connection.shellCloseTimer = null;
      if (connection.shell?.incoming?.state === 'closed') {
        this._finish(connection, 'disconnected', 'Terminal session closed.');
      } else this._watchPausedShell(connection);
    }, 50);
    connection.shellCloseTimer.unref();
  }

  _prepareTerminalInput(id, data) {
    const connection = this._connection(id);
    if (typeof data !== 'string') throw new ServiceError('터미널 입력 형식이 올바르지 않습니다.', 'INVALID_INPUT');
    if (Buffer.byteLength(data) > MAX_BUFFER) {
      throw new ServiceError('터미널 입력 버퍼가 가득 찼습니다. 잠시 후 다시 입력해 주세요.', 'INPUT_BACKPRESSURE');
    }
    const bytes = connection.terminalEncoding ? connection.terminalEncoding.encode(data) : Buffer.from(data, 'utf8');
    if (bytes.length + connection.shell.writableLength > MAX_BUFFER) {
      const error = new ServiceError('터미널 입력 버퍼가 가득 찼습니다. 잠시 후 다시 입력해 주세요.', 'INPUT_BACKPRESSURE');
      // A drained queue can make this command usable; an oversized command cannot.
      error.commandRetryable = bytes.length <= MAX_BUFFER;
      throw error;
    }
    return { connection, bytes };
  }

  _writeTerminalInput({ connection, bytes }) {
    try { return connection.shell.write(bytes); }
    catch (error) { throw publicError(error, '터미널 입력을 보내지 못했습니다'); }
  }

  input(id, data) { return this._writeTerminalInput(this._prepareTerminalInput(id, data)); }

  commandInput(id, data, beforeWrite) {
    let input;
    try { input = this._prepareTerminalInput(id, data); }
    catch (error) { return { status: 'not-sent', retryable: error?.commandRetryable === true }; }
    const shell = input.connection.shell;
    if (!shell || shell.destroyed || shell.writableEnded || shell.writable === false) {
      return { status: 'not-sent', retryable: false };
    }
    // Intentionally outside the pre-write catch: once the write path begins,
    // an error cannot prove that no bytes were accepted. A Writable returning
    // false signals backpressure on an accepted write, not a rejection.
    beforeWrite?.();
    this._writeTerminalInput(input);
    return { status: 'accepted' };
  }

  resize(id, cols, rows) {
    const connection = this._connection(id, false);
    const next = dimensions(cols, rows);
    Object.assign(connection, next);
    if (!connection.shell) return;
    // A window-change with unchanged dimensions costs a round trip and makes a
    // device pager (EXOS `show ports`) redraw from its first page, so a resize
    // back to the size the PTY already has is dropped.
    if (connection.shellCols === next.cols && connection.shellRows === next.rows) return;
    try { connection.shell.setWindow(rows, cols, 0, 0); }
    catch (error) { throw publicError(error, '터미널 크기를 바꾸지 못했습니다'); }
    connection.shellCols = next.cols; connection.shellRows = next.rows;
  }

  async _startForwards(connection, configs) {
    if (!Array.isArray(configs) || configs.length > 32) {
      throw new ServiceError('로컬 포트 포워딩은 최대 32개까지 지정할 수 있습니다.', 'INVALID_FORWARD');
    }
    for (const config of configs) {
      if (!config || config.enabled === false) continue;
      if (config.type && config.type !== 'local') {
        throw new ServiceError('로컬 포트 포워딩만 지원합니다.', 'INVALID_FORWARD');
      }
      const bindHost = config.bindHost ?? config.bindAddress ?? '127.0.0.1';
      if (bindHost !== '127.0.0.1' && bindHost !== '::1') {
        throw new ServiceError('로컬 포트 포워딩은 127.0.0.1 또는 ::1에서만 열 수 있습니다.', 'INVALID_FORWARD');
      }
      const bindPort = port(config.bindPort, true);
      const destPort = port(config.destPort);
      if (typeof config.destHost !== 'string' || !config.destHost || /[\s\0]/.test(config.destHost)) {
        throw new ServiceError('로컬 포트 포워딩의 대상 호스트를 입력해 주세요.', 'INVALID_FORWARD');
      }
      this._assertOpen(connection);
      const server = net.createServer(socket => {
        socket.on('error', () => destroy(socket));
        if (connection.closed || connection.forwardSockets.size >= MAX_FORWARD_SOCKETS) {
          destroy(socket); return;
        }
        connection.forwardSockets.add(socket);
        connection.resources.add(socket);
        socket.once('close', () => {
          connection.forwardSockets.delete(socket);
          connection.resources.delete(socket);
        });
        socket.pause();
        this._forwardOut(connection, connection.client, socket.remoteAddress || bindHost,
          socket.remotePort || 0, config.destHost, destPort).then(channel => {
          if (socket.destroyed || connection.closed) { destroy(channel); return; }
          socket.once('close', () => destroy(channel));
          channel.once('close', () => destroy(socket));
          socket.pipe(channel).pipe(socket);
          socket.resume();
        }).catch(() => destroy(socket));
      });
      connection.servers.add(server);
      await this._pending(connection, done => {
        server.on('error', error => {
          const safe = publicError(error, '로컬 포워딩 포트를 열지 못했습니다');
          done(safe);
          this._fail(connection, safe);
        });
        server.listen({ host: bindHost, port: bindPort }, () => {
          if (connection.closed) { this._closeServer(server); return; }
          done(null);
        });
      });
      connection.forwards.push({ bindHost, bindPort: server.address().port, destHost: config.destHost, destPort });
    }
  }

  _retireSftp(connection, sftp, state, alreadyClosed = false) {
    if (state.retired) return;
    state.retired = true;
    if (connection.sftp === sftp) connection.sftp = null;
    if (!connection.closed && !alreadyClosed) {
      // ssh2.destroy() sends CHANNEL_CLOSE but does not release the channel
      // until the peer acknowledges it. Never open another while this is stuck.
      const fence = state.fence = {};
      fence.promise = new Promise(resolve => { fence.resolve = resolve; });
      connection.sftpClosing = fence;
      fence.timer = setTimeout(() => this._fail(connection, new ServiceError(
        'SFTP 채널 닫기 응답이 없어 SSH 연결을 종료했습니다. 다시 연결해 주세요.', 'SFTP_CHANNEL_CLOSE_TIMEOUT',
      )), this.sftpOperationTimeoutMs);
      fence.timer.unref();
    }
    const reason = new ServiceError('SFTP 채널이 닫혔습니다. 새로고침해서 다시 열어 주세요.', 'SFTP_CLOSED');
    for (const finish of state.requests) finish(reason);
    for (const job of connection.jobs.values()) if (job.sftp === sftp) job.controller.abort(reason);
    if (!connection.closed) this._emit({ type: 'sftp-closed', id: connection.id });
    if (!alreadyClosed) destroy(sftp);
  }

  async _sftp(connection) {
    this._assertOpen(connection, true);
    while (connection.sftpClosing) {
      const closing = connection.sftpClosing;
      await this._await(connection, () => closing.promise);
      this._assertOpen(connection, true);
    }
    if (connection.sftp) return connection.sftp;
    if (!connection.sftpPromise) {
      connection.sftpPromise = this._pending(connection, done => {
        connection.client.sftp((error, sftp) => {
          if (error) { done(error); return; }
          if (!done(null, sftp)) {
            sftp.on('error', () => {});
            destroy(sftp);
            return;
          }
          connection.resources.add(sftp);
          const state = { requests: new Set(), retired: false };
          this.sftpChannels.set(sftp, state);
          sftp.once('close', () => {
            this._retireSftp(connection, sftp, state, true);
            connection.resources.delete(sftp);
            if (state.fence) {
              clearTimeout(state.fence.timer);
              if (connection.sftpClosing === state.fence) connection.sftpClosing = null;
              state.fence.resolve();
            }
          });
          sftp.once('end', () => this._retireSftp(connection, sftp, state));
          sftp.on('error', () => this._retireSftp(connection, sftp, state));
          connection.sftp = sftp;
        });
      }, undefined, { ms: this.sftpOperationTimeoutMs, error: () => {
        // The client API does not expose a channel before initialization.
        // Release the transport instead of queuing further half-open channels.
        const reason = new ServiceError('SFTP 채널 열기 응답이 없어 SSH 연결을 종료했습니다. 다시 연결해 주세요.', 'SFTP_OPEN_TIMEOUT');
        queueMicrotask(() => this._fail(connection, reason));
        return reason;
      } });
    }
    const pending = connection.sftpPromise;
    try { return await pending; }
    finally { if (connection.sftpPromise === pending) connection.sftpPromise = null; }
  }

  async listDirectory(id, value = '.') {
    const connection = this._connection(id);
    let directory = value === '.' ? null : remotePath(value);
    try {
      const sftp = await this._sftp(connection);
      this._assertOpen(connection, true);
      if (directory === null) {
        directory = remotePath(await this._sftpRequest(connection, sftp, done => sftp.realpath('.', done)));
        this._assertOpen(connection, true);
      }
      const entries = await this._sftpRequest(connection, sftp, done => sftp.readdir(directory, done));
      this._assertOpen(connection, true);
      return { path: directory, entries: entries.filter(entry => entry.filename !== '.' && entry.filename !== '..')
        .map(({ filename, attrs }) => ({ name: filename,
          type: attrs.isSymbolicLink() ? 'symlink' : attrs.isDirectory() ? 'directory' : 'file',
          size: attrs.size, mtime: attrs.mtime, permissions: attrs.mode & 0o7777 })) };
    } catch (error) { throw publicError(error, '원격 폴더 목록을 읽지 못했습니다'); }
  }

  async remoteProperties(id, value) {
    const connection = this._connection(id), remote = remotePath(value);
    try {
      const sftp = await this._sftp(connection);
      const attrs = await this._sftpRequest(connection, sftp, done => sftp.lstat(remote, done));
      this._assertOpen(connection, true);
      return remoteEntry(remote, attrs);
    } catch (error) { throw publicError(error, '원격 항목 정보를 확인하지 못했습니다'); }
  }

  _assertRemoteIdle(connection, paths) {
    for (const job of connection.jobs.values()) {
      if (paths.some(value => pathsOverlap(value, job.remotePath)
        || (job.direction === 'upload' && job.staged && pathsOverlap(value, job.staged)))) {
        throw new ServiceError('파일 전송이 이 원격 경로를 사용 중입니다. 전송이 끝나거나 취소한 뒤 다시 시도해 주세요.', 'REMOTE_BUSY');
      }
    }
  }

  _remoteMutation(connection, paths, operation) {
    this._assertRemoteIdle(connection, paths);
    connection.remoteMutations ||= new Set();
    connection.remoteMutations.add(paths);
    // Serialize our management requests so concurrent preflights cannot both
    // claim an absent destination. The server must also honor v3 RENAME's
    // no-overwrite contract against changes made by other clients.
    const task = (connection.remoteMutationQueue || Promise.resolve()).catch(() => {}).then(async () => {
      this._assertOpen(connection, true);
      this._assertRemoteIdle(connection, paths);
      const sftp = await this._sftp(connection);
      return operation(sftp);
    });
    connection.remoteMutationQueue = task;
    return task.finally(() => connection.remoteMutations.delete(paths));
  }

  async _absentRemote(connection, sftp, value) {
    try { await this._sftpRequest(connection, sftp, done => sftp.lstat(value, done)); }
    catch (error) { if (error.code === 2) return; throw error; }
    throw new ServiceError('대상 위치에 같은 이름의 원격 항목이 이미 있습니다.', 'REMOTE_EXISTS');
  }

  async createDirectory(id, parent, name) {
    const connection = this._connection(id), directory = remotePath(parent);
    const remote = remotePath(path.posix.join(directory, leafName(name)));
    try {
      return await this._remoteMutation(connection, [remote], async sftp => {
        const attrs = await this._sftpRequest(connection, sftp, done => sftp.stat(directory, done));
        if (remoteEntry(directory, attrs).type !== 'directory') {
          throw new ServiceError('상위 경로는 원격 폴더여야 합니다.', 'INVALID_TYPE');
        }
        await this._absentRemote(connection, sftp, remote);
        await this._sftpRequest(connection, sftp, done => sftp.mkdir(remote, { mode: 0o755 }, done));
        const created = await this._sftpRequest(connection, sftp, done => sftp.lstat(remote, done));
        this._assertOpen(connection, true);
        return { ...remoteEntry(remote, created), parent: directory, created: true };
      });
    } catch (error) { throw publicError(error, '원격 폴더를 만들지 못했습니다'); }
  }

  async renameRemote(id, value, newName, expected) {
    const connection = this._connection(id), remote = remotePath(value), name = leafName(newName);
    if (remote === '/') throw new ServiceError('원격 루트 폴더는 이름을 바꿀 수 없습니다.', 'INVALID_PATH');
    const parent = path.posix.dirname(remote), target = remotePath(path.posix.join(parent, name));
    const guard = expectedEntry(expected, false);
    try {
      return await this._remoteMutation(connection, [remote, target], async sftp => {
        const attrs = await this._sftpRequest(connection, sftp, done => sftp.lstat(remote, done));
        const entry = remoteEntry(remote, attrs);
        matchesEntry(entry, guard);
        if (target === remote) return { ...entry, parent, oldPath: remote, renamed: false };
        await this._absentRemote(connection, sftp, target);
        // Never use posix-rename here: that extension deliberately overwrites.
        await this._sftpRequest(connection, sftp, done => sftp.rename(remote, target, done));
        this._assertOpen(connection, true);
        return { ...entry, path: target, name, parent, oldPath: remote, renamed: true };
      });
    } catch (error) { throw publicError(error, '원격 항목 이름을 바꾸지 못했습니다'); }
  }

  async removeRemote(id, value, expectedType) {
    const connection = this._connection(id), remote = remotePath(value);
    if (remote === '/') throw new ServiceError('원격 루트 폴더는 삭제할 수 없습니다.', 'INVALID_PATH');
    const expected = expectedEntry(expectedType);
    try {
      return await this._remoteMutation(connection, [remote], async sftp => {
        const inspect = async () => remoteEntry(remote,
          await this._sftpRequest(connection, sftp, done => sftp.lstat(remote, done)));
        const entry = await inspect();
        matchesEntry(entry, expected);
        if (entry.type === 'directory') {
          const children = await this._sftpRequest(connection, sftp, done => sftp.readdir(remote, done));
          if (children.some(child => child.filename !== '.' && child.filename !== '..')) {
            throw new ServiceError('비어 있는 원격 폴더만 삭제할 수 있습니다.', 'DIRECTORY_NOT_EMPTY');
          }
          matchesEntry(await inspect(), expectedEntry(entry));
        }
        // RMDIR also refuses children created after the listing. Unlink acts on
        // the link itself, including a dangling link or a link to a directory.
        await this._sftpRequest(connection, sftp, done => entry.type === 'directory'
          ? sftp.rmdir(remote, done) : sftp.unlink(remote, done));
        this._assertOpen(connection, true);
        return { ...entry, parent: path.posix.dirname(remote), removed: true };
      });
    } catch (error) { throw publicError(error, '원격 항목을 삭제하지 못했습니다'); }
  }

  cancelTransfer(id, transferId) {
    const connection = this._connection(id);
    if (typeof transferId !== 'string' || !transferId || transferId.length > 128) {
      throw new ServiceError('전송 작업 ID가 올바르지 않습니다.', 'INVALID_TRANSFER');
    }
    const job = connection.jobs.get(transferId);
    if (!job) return { transferId, cancelled: false, status: 'not-found' };
    if (job.phase === 'committing' || job.phase === 'completed') {
      return { transferId, cancelled: false, status: job.phase };
    }
    if (job.controller.signal.aborted) {
      const cancelled = job.controller.signal.reason?.code === 'TRANSFER_CANCELLED';
      return { transferId, cancelled, status: cancelled ? 'cancelled' : 'error' };
    }
    job.cancel(new ServiceError('파일 전송을 취소했습니다.', 'TRANSFER_CANCELLED'));
    return { transferId, cancelled: true, status: 'cancelled' };
  }

  upload(id, localPath, targetPath) { return this._transfer(id, 'upload', localPath, targetPath); }
  download(id, sourcePath, localPath) { return this._transfer(id, 'download', localPath, sourcePath); }

  _sftpRequest(connection, sftp, start, signal, timeoutMs = this.sftpOperationTimeoutMs) {
    const state = this.sftpChannels.get(sftp);
    return this._pending(connection, done => {
      let complete = false, timer;
      const finish = (error, value) => {
        if (complete) return false; complete = true;
        clearTimeout(timer);
        state?.requests.delete(finish);
        signal?.removeEventListener('abort', abort);
        connection.pending.delete(cancel);
        // ssh2 flushes callbacks before emitting end/close, using this fixed
        // local error. Convert it without relaying arbitrary server text.
        if (error?.message === 'No response from server' && error.code === undefined) {
          error = new ServiceError('SFTP 채널이 닫혔습니다.', 'SFTP_CLOSED');
        }
        return done(error, value);
      };
      const closed = () => finish(new ServiceError('SFTP 채널이 닫혔습니다. 새로고침해서 다시 열어 주세요.', 'SFTP_CLOSED'));
      const cancel = () => finish(new ServiceError('SSH 연결이 끊어졌습니다.', 'NOT_CONNECTED'));
      const abort = () => finish(abortedTransfer(signal));
      if (signal?.aborted) { abort(); return; }
      if (connection.sftp !== sftp || !state || state.retired || sftp.destroyed) { closed(); return; }
      connection.pending.add(cancel);
      state.requests.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
      const activity = () => {
        if (complete) return;
        if (timer) timer.refresh();
        else timer = setTimeout(() => {
          if (finish(sftpTimeout())) this._retireSftp(connection, sftp, state);
        }, timeoutMs);
      };
      activity();
      try { start(finish, activity); } catch (error) { finish(error); }
    });
  }

  async _transfer(id, direction, localPath, value) {
    const connection = this._connection(id);
    const remote = remotePath(value);
    if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || localPath.includes('\0')) {
      throw new ServiceError('로컬 전송 경로는 절대 경로여야 합니다.', 'INVALID_PATH');
    }
    if (connection.jobs.size >= MAX_TRANSFERS) throw new ServiceError('진행 중인 파일 전송이 너무 많습니다. 일부 전송이 끝난 뒤 다시 시도해 주세요.', 'BUSY');
    this._assertRemoteIdle(connection, [remote]);
    if ([...(connection.remoteMutations || [])].some(paths => paths.some(value => pathsOverlap(value, remote)))
      || [...connection.jobs.values()].some(job => direction === 'download' && job.direction === 'download'
        && path.resolve(job.localPath).toLowerCase() === path.resolve(localPath).toLowerCase())) {
      throw new ServiceError('다른 작업이 이 전송 대상을 사용 중입니다.', 'REMOTE_BUSY');
    }
    const transferId = randomUUID();
    const job = { transferId, direction, localPath, remotePath: remote, transferred: 0,
      total: 0, controller: new AbortController(), lastProgress: 0, phase: 'preparing', terminal: false };
    connection.jobs.set(transferId, job);
    const event = (status, fields = {}) => {
      if (job.terminal) return;
      if (['completed', 'cancelled', 'error'].includes(status)) job.terminal = true;
      this._emit({ type: 'transfer', id,
      transferId, direction, localPath, remotePath: remote,
      transferred: job.transferred, total: job.total, status, ...fields });
    };
    job.cancel = (reason = new ServiceError('연결이 끊어졌습니다.', 'NOT_CONNECTED')) => {
      if (job.controller.signal.aborted) return;
      job.controller.abort(reason);
      if (job.phase === 'committing') {
        job.commitInterrupted = true;
        const unknown = unknownTransferCommit();
        event('error', { message: unknown.message, code: unknown.code });
      } else if (job.phase === 'completed') event('completed');
      else event('cancelled', { message: reason.message, code: reason.code });
    };
    event('started');
    return this._cleanup(this._runTransfer(connection, job, event));
  }

  async _renameUpload(connection, sftp, staged, target) {
    try {
      // Standard v3 RENAME refuses an existing destination. Do not use
      // overwrite-capable extensions; SFTP has no portable compare-and-swap.
      await this._sftpRequest(connection, sftp, done => sftp.rename(staged, target, done));
    } catch (error) {
      if (connection.closed || ['SFTP_CLOSED', 'SFTP_TIMEOUT', 'NOT_CONNECTED'].includes(error?.code)) {
        throw unknownTransferCommit();
      }
      // v3 typically reports generic FAILURE for a collision. Inspect only
      // after a definite rejection, and never use this check to allow a retry.
      let exists = error?.code === 11;
      if (!exists && error?.code === 4) {
        try {
          await this._sftpRequest(connection, sftp, done => sftp.lstat(target, done));
          exists = true;
        } catch { /* the rejected rename is already definitive */ }
      }
      if (exists) throw new ServiceError('원격에 같은 이름의 파일이 있습니다. 업로드하지 않았습니다. 다른 이름을 사용해 주세요.', 'UPLOAD_DESTINATION_EXISTS');
      throw new ServiceError('업로드를 안전하게 마무리하지 못했습니다. 원격 권한을 확인해 주세요.', 'UPLOAD_COMMIT_FAILED');
    }
  }

  _transferHandle(connection, sftp, job, value, writable) {
    return this._sftpRequest(connection, sftp, done => {
      sftp.open(value, writable ? 'wx' : 'r', 0o600, (error, handle) => {
        if (done(error, handle) || !handle) return;
        // OPEN cannot be recalled on the server. If it succeeds after cancel,
        // close the orphaned handle and remove only our exclusive staging file.
        if (!connection.closed && connection.sftp === sftp && !sftp.destroyed) {
          this._cleanup((async () => {
            await this._closeTransferHandle(connection, sftp, handle);
            if (writable) await this._removeUploadPart(connection, sftp, value);
          })());
        }
      });
    }, job.controller.signal);
  }

  async _closeTransferHandle(connection, sftp, handle) {
    if (connection.closed || connection.sftp !== sftp || sftp.destroyed) return;
    try { await this._sftpRequest(connection, sftp, done => sftp.close(handle, done), undefined, 1000); }
    catch { /* best effort while the remote channel is available */ }
  }

  async _removeUploadPart(connection, sftp, staged) {
    if (connection.closed || connection.sftp !== sftp || sftp.destroyed) return;
    try { await this._sftpRequest(connection, sftp, done => sftp.unlink(staged, done), undefined, 1000); }
    catch { /* best effort while the remote channel is available */ }
  }

  _boundedTransferStream(stream, signal, onTimeout) {
    const close = stream._destroy;
    let resolveClose, rejectClose;
    stream.transferClosed = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    stream.transferClosed.catch(() => {});
    // ssh2's stream destroy otherwise waits indefinitely for a CLOSE response.
    // A CLOSE timeout retires the shared channel; outstanding RPCs cannot linger.
    stream._destroy = function(error, callback) {
      let settled = false, timer;
      const finish = failure => {
        if (settled) return; settled = true; clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        callback(failure);
        if (failure) rejectClose(failure); else resolveClose();
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(error || (signal.aborted ? abortedTransfer(signal)
            : new ServiceError('SFTP 파일 닫기 시간이 초과되었습니다.', 'SFTP_CLOSE_TIMEOUT')));
          onTimeout();
        }, signal.aborted ? 1000 : 30000);
      };
      const abort = () => arm();
      signal.addEventListener('abort', abort, { once: true });
      arm();
      try { close.call(this, error, finish); } catch (failure) { finish(failure); }
    };
    return stream;
  }

  async _runTransfer(connection, job, event) {
    const { direction, localPath, remotePath: remote, transferId } = job;
    const destinationPath = direction === 'upload' ? remote : localPath;
    const paths = direction === 'upload' ? path.posix : path;
    const staged = paths.join(paths.dirname(destinationPath), `.${paths.basename(destinationPath)}.sessiondock-${transferId}.part`);
    job.staged = staged;
    const signal = job.controller.signal;
    const check = () => {
      this._assertOpen(connection, true);
      if (signal.aborted) throw abortedTransfer(signal);
    };
    let sftp, copying, remoteStream, remoteHandle, staging = false, committed = false;
    let commitUnknown = false;
    try {
      // Cancelling one waiter must not cancel shared SFTP initialization.
      sftp = await this._await(connection, () => this._sftp(connection), signal);
      job.sftp = sftp;
      check();
      const stats = direction === 'upload'
        ? await this._await(connection, () => fs.promises.stat(localPath), signal)
        : await this._sftpRequest(connection, sftp, done => sftp.stat(remote, done), signal);
      check();
      if (!stats.isFile()) throw new ServiceError('일반 파일만 전송할 수 있습니다.', 'INVALID_FILE');
      job.total = stats.size;
      remoteHandle = await this._transferHandle(connection, sftp, job,
        direction === 'upload' ? staged : remote, direction === 'upload');
      if (direction === 'upload') staging = true;
      check();
      job.phase = 'copying';
      const retireOnCloseTimeout = () => {
        const state = this.sftpChannels.get(sftp);
        if (state) this._retireSftp(connection, sftp, state);
      };
      await this._sftpRequest(connection, sftp, (done, activity) => {
        let source, destination;
        try {
          source = direction === 'upload' ? fs.createReadStream(localPath)
            : this._boundedTransferStream(sftp.createReadStream(remote, { handle: remoteHandle }), signal, retireOnCloseTimeout);
          if (direction === 'download') { remoteStream = source; remoteHandle = null; }
          source.on('error', () => {});
          destination = direction === 'upload'
            ? this._boundedTransferStream(sftp.createWriteStream(staged, { handle: remoteHandle, flags: 'wx', mode: 0o600 }), signal, retireOnCloseTimeout)
            : fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 });
          if (direction === 'upload') { remoteStream = destination; remoteHandle = null; }
          destination.on('error', () => {});
          // Only remove a staging file whose exclusive OPEN succeeded. An
          // existing .part (even with our random ID) belongs to someone else.
          destination.once('open', () => { staging = true; });
          // Install pipeline handlers synchronously with stream creation, even
          // when cancellation or the pending-operation limit is reached.
          const progress = new Transform({ transform(chunk, encoding, callback) {
            activity();
            job.transferred += chunk.length;
            if (Date.now() - job.lastProgress >= 100) {
              job.lastProgress = Date.now();
              if (!connection.closed) event('progress');
            }
            callback(null, chunk);
          } });
          copying = pipeline(source, progress, destination, { signal: job.controller.signal });
          copying.then(() => done(null), error => done(error));
        } catch (error) {
          if (source) destroy(source);
          if (destination) destroy(destination);
          done(error);
        }
      }, signal);
      // ssh2 uses emitClose:false; pipeline's finish alone need not mean the
      // remote handle has closed. Confirm CLOSE before replacing a destination.
      await this._await(connection, () => remoteStream.transferClosed, signal);
      check();
      // After the final rename has been issued it cannot be recalled safely.
      // Reject late cancellation instead of reporting a cancelled replacement.
      job.phase = 'committing';
      if (direction === 'upload') await this._renameUpload(connection, sftp, staged, remote);
      else await fs.promises.rename(staged, localPath);
      committed = true;
      if (job.commitInterrupted) throw unknownTransferCommit();
      job.phase = 'completed';
      event('completed');
      return { transferId, direction, localPath, remotePath: remote, transferred: job.transferred, total: job.total };
    } catch (error) {
      const safe = publicError(signal.aborted && !connection.closed && !['TRANSFER_COMMIT_UNKNOWN', 'SFTP_TIMEOUT', 'UPLOAD_DESTINATION_EXISTS', 'UPLOAD_COMMIT_FAILED'].includes(error?.code) ? abortedTransfer(signal) : error, `${direction === 'upload' ? '파일을 업로드하지' : '파일을 다운로드하지'} 못했습니다`);
      commitUnknown = safe.code === 'TRANSFER_COMMIT_UNKNOWN';
      if (!connection.closed) event(safe.code === 'TRANSFER_CANCELLED' ? 'cancelled' : 'error', { message: safe.message, code: safe.code });
      throw safe;
    } finally {
      // _pending rejects immediately on disconnect. Streams can still be closing
      // then, especially on Windows; wait before unlinking the staged download.
      if (copying && !committed && !signal.aborted) job.controller.abort();
      if (copying) await Promise.allSettled([copying]);
      if (remoteStream) await Promise.allSettled([remoteStream.transferClosed]);
      if (remoteHandle) await this._closeTransferHandle(connection, sftp, remoteHandle);
      try {
        if (staging && !committed && !commitUnknown) {
          if (direction === 'download') {
            try { await fs.promises.unlink(staged); }
            catch (error) { if (error.code !== 'ENOENT') throw publicError(error, '임시 다운로드 파일을 삭제하지 못했습니다'); }
          } else if (!connection.closed && connection.sftp === sftp && sftp && !sftp.destroyed) {
            // Disconnect may leave a remote .part file; never delete the target.
            await this._removeUploadPart(connection, sftp, staged);
          }
        }
      } finally { connection.jobs.delete(transferId); }
    }
  }

  setLogging(id, enabled, source = 'manual') {
    const connection = this._connection(id, false);
    if ((connection.logOperations || 0) >= 128) return Promise.reject(new ServiceError('처리 대기 중인 로그 작업이 너무 많습니다.', 'BUSY'));
    connection.logOperations = (connection.logOperations || 0) + 1;
    const task = connection.logQueue.catch(() => {}).then(() => this._setLogging(connection, !!enabled, source));
    connection.logQueue = task.finally(() => { connection.logOperations--; });
    return connection.logQueue;
  }

  async _setLogging(connection, enabled, source) {
    this._assertOpen(connection);
    if (connection.logStoppingPromise) {
      await connection.logStoppingPromise;
      this._assertOpen(connection);
    }
    if (!enabled) {
      // Global policy never turns off an explicit session/manual log. Check at
      // execution time, after any pending open in this connection's log queue.
      if (source === 'global' && connection.logSource !== 'global') return { enabled: !!connection.logStream, path: connection.logPath };
      await this._stopLog(connection);
      this._assertOpen(connection);
      return { enabled: false, path: null };
    }
    if (connection.logStream) {
      if (source === 'manual' && connection.logSource !== 'manual') {
        connection.logSource = 'manual';
        this._emit({ type: 'log', id: connection.id, enabled: true, path: connection.logPath, format: connection.logFormat, source: 'manual' });
      }
      return { enabled: true, path: connection.logPath };
    }
    if (connection.pendingLogOpen) throw new ServiceError('이전 로그 파일 열기가 아직 끝나지 않았습니다. 로그 경로를 확인한 뒤 다시 시도해 주세요.', 'LOG_OPEN_PENDING');
    let opened, writer, timer;
    const attempt = { cancelled: false };
    // Opening a log file can take seconds on a UNC path. The transport keeps
    // reading; the bytes are retained in the bounded pre-open buffer instead of
    // pausing the shell (which used to stall the SSH channel window).
    connection.logOpening = true;
    connection.logPending = connection.logPending || [];
    try {
      const settings = { ...DEFAULT_LOG_SETTINGS, ...this.getLogSettings() };
      connection.logFormat = settings.logFormat;
      const now = this.logClock();
      const filenameFor = (date, rotating = false) => {
        const location = logLocation(settings, this.logDirectory, connection.info, connection.id, date);
        const template = settings.logFilenameTemplate;
        if (!rotating || template.includes('{date}') || ['{year}', '{month}', '{day}'].every(token => template.includes(token))) return location.filename;
        const parsed = path.parse(location.filename);
        return path.join(parsed.dir, `${parsed.name}-${dateParts(date).date}${parsed.ext}`);
      };
      const opening = this._cleanup((async () => {
        const candidate = await openLogFile(filenameFor(now), () => connection.closed || attempt.cancelled);
        if (connection.closed || attempt.cancelled) { await endLogStream(candidate.stream); return; }
        opened = candidate;
      })());
      connection.pendingLogOpen = opening;
      const clear = () => { if (connection.pendingLogOpen === opening) connection.pendingLogOpen = null; };
      opening.then(clear, clear);
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
        attempt.cancelled = true;
        reject(new ServiceError('로그 파일 열기 시간이 초과되었습니다. 저장 경로와 네트워크를 확인해 주세요.', 'LOG_OPEN_TIMEOUT'));
      }, this.logOpenTimeoutMs); });
      await this._await(connection, () => Promise.race([opening, deadline]));
      this._assertOpen(connection);
      if (opened.stream.destroyed) throw opened.stream.errored || new ServiceError('세션 로그 파일을 열지 못했습니다.');
      writer = new RotatingLog({ opened, now, filenameFor, rotateDaily: settings.logRotateDaily === true, clock: this.logClock, openTimeoutMs: this.logOpenTimeoutMs,
        trackCleanup: promise => this._cleanup(promise),
        // The writer's completion ledger is the only figure that means "stored". It
        // is wired here so `logBytesWritten` can be derived from confirmed bytes
        // instead of from `writeAt()` acceptance: reporting acceptance as storage is
        // exactly what made a completely failed recording (accepted 65,536, file 0)
        // claim that nothing was lost (V9-M-03 / §9.1).
        onWriteComplete: bytes => {
          if (connection.logWriter !== writer && connection.logStopping !== writer) return;
          connection.logBytesWritten = (connection.logBytesWritten || 0) + bytes;
        },
        // A write the file never confirmed. It is counted as unconfirmed rather than
        // as an exact loss, because a failed write may still have reached the disk;
        // `logUnconfirmedBytes` is reported separately from `droppedLogBytes`.
        onWriteFailed: ({ bytes }) => {
          if (connection.logWriter !== writer && connection.logStopping !== writer) return;
          connection.logUnconfirmedBytes = (connection.logUnconfirmedBytes || 0) + (bytes || 0);
          connection.logIncomplete = true;
        },
        onRotate: next => {
          if (connection.logWriter !== writer || connection.closed) return;
          connection.logStream = next.stream; connection.logPath = next.path;
          this._emit({ type: 'log', id: connection.id, enabled: true, path: next.path, format: settings.logFormat, source: connection.logSource });
        },
        onRotationError: error => this._emit({ type: 'log-error', id: connection.id,
          message: publicError(error, '새 로그 파일로 전환하지 못해 현재 파일에 계속 기록합니다').message })
      });
      // The error handler is fenced on the writer's identity, not just the
      // connection's. A stopped writer can emit a late error after a new attempt
      // has already installed its own writer: answering it aborted the new
      // recording (`logWriter` nulled, new queue marked failed) while the session
      // stayed up (V7-M-01). Ownership is `logWriter` while running and
      // `logStopping` while a stop drains, so only those two may report.
      const onWriterError = error => {
        if (this.connections.has(connection.id) && this.connections.get(connection.id) !== connection) return;
        if (connection.logWriter !== writer && connection.logStopping !== writer) return;
        const safe = publicError(error, '세션 로그를 저장하지 못했습니다');
        this._emit({ type: 'log-error', id: connection.id, message: safe.message });
        // A writer failure no longer kills the session; the log is reported
        // incomplete and the transport keeps running.
        connection.logIncomplete = true;
        this.logQueue.fail(connection.id, safe.code || 'LOG_WRITE_FAILED', safe.message);
        this._detachLogWriter(connection);
      };
      writer.on('error', onWriterError);
      // Named so `_unlistenLogError` can remove exactly this attempt's handler and
      // no other writer's.
      connection.logErrorListener = { stream: writer, onError: onWriterError };
      const formatter = new LogFormatter({ ...settings, encoding: 'utf-8' });
      connection.logWriter = writer; connection.logStream = opened.stream;
      connection.logPath = opened.path;
      connection.logFormatter = formatter;
      connection.logSource = source; connection.logFormat = settings.logFormat;
      // Per-attempt accounting: reset so a previous attempt's totals cannot leak
      // into this recording's loss report — except bytes the pre-open cap already
      // refused. Those were intended for this file and can never be written, so
      // they are carried into the new attempt instead of being reset away.
      const carriedLoss = connection.logIncomplete ? this.logLossBytes(connection) : 0;
      connection.logBytesWritten = 0;
      connection.logIntendedBytes = carriedLoss;
      connection.logUnconfirmedBytes = 0;
      // The pump owns all writer calls. Backpressure waits inside the bounded
      // queue; it never pauses the shell.
      const generation = this.logQueue.attach(connection.id, entry => {
        // While a stop is draining, `logWriter` is already cleared but the pump
        // still legitimately owns this writer until the queue empties.
        if (connection.logWriter !== writer && connection.logStopping !== writer) return 'failed';
        try {
          // false means "buffered, wants a drain", NOT "rejected".
          //
          // This is acceptance, not storage. `logBytesWritten` is maintained by the
          // writer's completion callback: counting here made a hard write failure
          // look like a successful recording (V9-M-03).
          const accepted = writer.writeAt(entry.bytes, entry.now);
          return accepted ? 'ok' : 'accepted-drain';
        } catch (error) {
          const safe = error.code === 'LOG_BACKPRESSURE'
            ? new ServiceError('세션 로그 저장이 터미널 출력 속도를 따라가지 못했습니다.', 'LOG_BACKPRESSURE')
            : publicError(error, '세션 로그를 저장하지 못했습니다');
          connection.logIncomplete = true;
          this.logQueue.fail(connection.id, safe.code || 'LOG_WRITE_FAILED', safe.message);
          return 'failed';
        }
      });
      connection.logQueueGeneration = generation;
      // `writeAt()` returns RotatingLog.write(), so the drain that frees the pump
      // is emitted by the RotatingLog itself — not by the underlying file stream,
      // which never emits one for these writes.
      const onDrain = () => this.logQueue.drained(connection.id, generation);
      writer.on('drain', onDrain);
      connection.logDrainListener = { stream: writer, onDrain };
      this._replayTerminalLog(connection);
      this._emit({ type: 'log', id: connection.id, enabled: true, path: opened.path, format: settings.logFormat, source });
      return { enabled: true, path: opened.path };
    } catch (error) {
      // The open failed: bytes retained for it can never be written, so they are
      // reported instead of being silently dropped. Bytes the pre-open cap already
      // refused were counted in `logIntendedBytes` as they arrived, so they are
      // added here rather than overwritten.
      const pending = (connection.logPending || []).reduce((sum, entry) =>
        sum + (connection.logFormat === 'raw' ? SshService._pendingChunk(entry).length : SshService._pendingDisplay(entry).length), 0);
      connection.logPending = null; connection.logPendingBytes = 0;
      this._releaseLogPending(connection);
      if (pending) {
        connection.logIncomplete = true;
        connection.logIntendedBytes = (connection.logIntendedBytes || 0) + pending;
        connection.logDroppedBytes = this.logLossBytes(connection);
      }
      if (writer) {
        if (connection.logWriter === writer) {
          connection.logWriter = null; connection.logStream = null; connection.logPath = null;
          connection.logFormatter = null; connection.logSource = null; connection.logFormat = null;
          this._unlistenLogDrain(connection);
          this.logQueue.release(connection.id);
        }
        this._unlistenLogError(connection, writer);
        destroy(writer);
      }
      else if (opened) this._cleanup(endLogStream(opened.stream).catch(() => {}));
      throw publicError(error, '세션 로그 파일을 열지 못했습니다');
    } finally { clearTimeout(timer); attempt.cancelled = true; connection.logOpening = false; }
  }

  _cleanup(promise) {
    this.cleanups.add(promise);
    promise.then(() => this.cleanups.delete(promise), () => this.cleanups.delete(promise));
    return promise;
  }

  // ---- transport close bookkeeping ---------------------------------------
  // `finishPromise` answers "is the status/drain/log bookkeeping done?". It is
  // NOT "is the TCP socket gone": `Client.destroy()` only asks the socket to
  // close, and a device that stalls a FIN/RST keeps the file descriptor (and
  // the device's own VTY session) alive for a while longer. A batch row that is
  // about to reconnect to the same address needs the latter, so it is tracked
  // here separately, per connection, and retained after the connection leaves
  // `connections`.
  _transportClose(connection) {
    let record = this.transportCloses.get(connection.id);
    if (record) return record;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    record = {
      id: connection.id, promise, settled: false,
      sockets: 0, requestedAt: performance.now(), settledAt: 0,
      timedOut: false, boundMs: 0,
    };
    record.settle = () => {
      if (record.settled || record.sockets > 0) return;
      record.settled = true;
      record.settledAt = performance.now();
      resolve(true);
    };
    this.transportCloses.set(connection.id, record);
    if (this.transportCloses.size > TRANSPORT_CLOSE_RETENTION) this._pruneTransportCloses(record);
    return record;
  }

  // Bounded retention: a late waiter (a batch row that had not yet reached its
  // finally block) must still be able to read the truth, but a long-running app
  // must not accumulate one record per historic connection. Age is used first so
  // a row's own record is never pruned out from under it by a burst of unrelated
  // connections; the hard cap only applies to genuinely old records.
  _pruneTransportCloses(keep) {
    if (this.transportCloses.size <= TRANSPORT_CLOSE_RETENTION) return;
    const now = performance.now();
    for (const [id, entry] of this.transportCloses) {
      if (this.transportCloses.size <= TRANSPORT_CLOSE_RETENTION) return;
      if (entry === keep || !entry.settled) continue;
      if (now - entry.settledAt < TRANSPORT_CLOSE_TTL_MS) continue;
      this.transportCloses.delete(id);
    }
  }

  // Has this socket's own 'close' event already been delivered? `socket.closed`
  // is NOT that evidence: net.Socket sets it synchronously inside destroy(), long
  // before the event loop emits 'close'. Treating it as an observed close settled
  // a Telnet teardown on the destroy() call itself (V6-M-03). The streams' own
  // closeEmitted flag is the real observation.
  _closeObserved(socket) {
    if (!socket) return true;
    if (socket._readableState?.closeEmitted === true) return true;
    if (socket._writableState?.closeEmitted === true) return true;
    return false;
  }

  // Count one real socket (ssh2's underlying net.Socket, a jump channel, or a
  // Telnet socket) so the aggregate only settles when every owned transport has
  // emitted its own 'close'.
  _trackSocketClose(connection, socket) {
    const record = this._transportClose(connection);
    if (!socket || socket.__transportCloseTracked === record) return record;
    // A socket that never had a handle was never opened (connect() threw before
    // the transport existed): there is nothing left to wait for. A socket that
    // was only *destroyed* is a different case — its 'close' is still coming, so
    // the listener is attached and the record waits for it.
    if (socket.closed === true && socket._handle === null && !socket.__everConnected) return record;
    socket.__transportCloseTracked = record;
    record.sockets += 1;
    let done = false;
    const settleOnce = () => {
      if (done) return;
      done = true;
      record.sockets = Math.max(0, record.sockets - 1);
      record.settle();
    };
    socket.once('close', settleOnce);
    // Swallow transport errors here only so a late socket error after teardown
    // cannot crash the process; the verdict still comes from 'close' alone.
    socket.once('error', () => {});
    // The close may genuinely have been observed before this call.
    if (this._closeObserved(socket)) settleOnce();
    return record;
  }

  _trackClientClose(connection, client) {
    if (!client) return this._transportClose(connection);
    // A TCP socket's own 'close' proves local transport teardown, not that the
    // device received a FIN or released its session. A jump tunnel's channel is
    // not a socket; the jump client's own socket is tracked separately.
    if (client._sock instanceof net.Socket) return this._trackSocketClose(connection, client._sock);
    return this._trackEmitterClose(connection, client);
  }

  // Fallback when the client's socket is not a net.Socket (a jump channel, or a
  // future ssh2 that hides `_sock`). ssh2 emits 'close' only once its transport
  // is gone, so it is the same evidence from one level up.
  _trackEmitterClose(connection, emitter) {
    const record = this._transportClose(connection);
    if (!emitter || typeof emitter.once !== 'function' || emitter.__transportCloseTracked === record) return record;
    emitter.__transportCloseTracked = record;
    record.sockets += 1;
    let done = false;
    emitter.once('close', () => {
      if (done) return;
      done = true;
      record.sockets = Math.max(0, record.sockets - 1);
      record.settle();
    });
    return record;
  }

  // Called once teardown has requested every destroy(). A connection that never
  // owned a socket has nothing to wait for, so its record must not hang. When a
  // socket *is* tracked, settle() refuses to resolve until its own 'close' has
  // been observed.
  _settleTransportClose(connection) {
    const record = connection.transportCloseRecord || this.transportCloses.get(connection.id);
    if (!record) return;
    record.settle();
  }

  // Resolves true when the promise settled inside the budget, false otherwise.
  _settledWithin(promise, timeoutMs) {
    if (!(timeoutMs > 0)) return Promise.resolve(false);
    return new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
      timer.unref?.();
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(true); };
      Promise.resolve(promise).then(finish, finish);
    });
  }

  // Resolves when this connection's own socket close was observed. The retained
  // record is pruned by age once settled, so a caller that must outlive that
  // retention (an endpoint quarantine) holds the promise itself instead of
  // re-asking later and getting "no evidence" for a close that did happen
  // (V7-M-02). Returns null when there is nothing to wait for.
  //
  // Only an *existing* record may be handed out. Creating one here would produce a
  // record with zero tracked sockets, which `settle()` resolves immediately — and an
  // immediately-resolved promise would tell the quarantine "closed" while the socket
  // is in fact still open, admitting a second device session (V6-H-01).
  waitForClose(id) {
    if (typeof id !== 'string' || !id) return null;
    return this.transportCloses.get(id)?.promise ?? null;
  }

  // Safe, secret-free teardown report for local metadata/diagnostics.
  transportCloseReport(id) {
    const record = this.transportCloses.get(id);
    if (!record) return { tracked: false, closed: false, timedOut: false, openSockets: 0, boundMs: 0 };
    return {
      tracked: true, closed: record.settled, timedOut: record.timedOut,
      openSockets: record.sockets, boundMs: record.boundMs,
    };
  }

  _stopLog(connection) {
    const stream = connection.logWriter || connection.logStopping;
    const source = connection.logSource;
    const queueGeneration = connection.logQueueGeneration;
    // The drain listener must stay installed while the queue drains: the pump
    // blocks on 'drain' and removing it here deadlocked every stop that had
    // accepted bytes still queued (the log was then closed truncated).
    const tail = connection.logFormatter?.flush(this.logClock()); connection.logFormatter = null; connection.logSource = null;
    connection.logWriter = null;
    connection.logStream = null;
    connection.logPath = null;
    // Anything still queued for this writer must reach it before `end()`, and
    // bytes retained for an open that never completed are reported, not lost.
    const pendingOpen = (connection.logPending || []).reduce((sum, entry) =>
      sum + (connection.logFormat === 'raw' ? SshService._pendingChunk(entry).length : SshService._pendingDisplay(entry).length), 0);
    connection.logPending = null;
    connection.logPendingBytes = 0;
    this._releaseLogPending(connection);
    if (pendingOpen) {
      connection.logIncomplete = true;
      connection.logIntendedBytes = (connection.logIntendedBytes || 0) + pendingOpen;
    }
    this._resumeTerminal(connection);
    if (!stream) {
      // No writer: whatever this recording intended to store is unsaved, derived
      // from the same single figure as every other incomplete path.
      this.logQueue.release(connection.id);
      const lost = this.logLossBytes(connection);
      if (lost > (connection.logDroppedBytes || 0)) this._reportLogIncomplete(connection, 'LOG_CLOSE_TIMEOUT',
        '세션 로그를 저장하지 못해 일부 출력이 기록되지 않았습니다.', lost);
      return Promise.resolve();
    }
    // The pump still owns this writer until the accepted queue is empty. Ending
    // the stream first silently truncated the log: `writeAt()` after `end()`
    // returns false and every queued byte was reported as lost.
    connection.logStopping = stream;
    if (tail?.length) connection.logIntendedBytes = (connection.logIntendedBytes || 0) + tail.length;
    stream.stopRotation();
    this._emit({ type: 'log', id: connection.id, enabled: false, path: null, source, interrupted: connection.closed });
    if (stream.closed) {
      connection.logStopping = null;
      this.logQueue.release(connection.id);
      // An already-closed writer still owns this attempt's reporting handler. Not
      // removing it left the stale listener installed for the life of the process
      // (V7-M-01).
      this._unlistenLogDrain(connection);
      this._unlistenLogError(connection, stream);
      const lost = this.logLossBytes(connection);
      if (lost > (connection.logDroppedBytes || 0)) this._reportLogIncomplete(connection, 'LOG_WRITE_FAILED',
        '세션 로그를 저장하지 못해 일부 출력의 기록을 확인할 수 없습니다.', lost);
      return Promise.resolve();
    }
    // Wait for the writer to close before calculating unconfirmed bytes.
    const settleLoss = () => {
      // Unconfirmed writes are included once; they may have partially reached disk.
      const lost = this.logLossBytes(connection);
      if (lost <= (connection.logDroppedBytes || 0)) return;
      this._reportLogIncomplete(connection, 'LOG_CLOSE_TIMEOUT',
        '세션 로그 저장이 끝나지 않아 일부 출력을 저장하지 못했습니다.', lost);
    };
    return this._cleanup((async () => {
      // Drain first, then close. Bounded: the pump drains continuously, and a
      // stuck disk must not hold shutdown open indefinitely.
      const flushed = await this.logQueue.flush(connection.id, 1000);
      if (!flushed) {
        this.logQueue.release(connection.id);
        if (queueGeneration !== undefined) connection.logQueueGeneration = undefined;
        this._unlistenLogDrain(connection);
        // This path retired the writer, so its reporting handler must go with it:
        // the early return used to skip the cleanup and leak a listener that
        // answered a later attempt's queue (V7-M-01).
        this._unlistenLogError(connection, stream);
        // Bytes the writer accepted but never flushed die with the destroy below.
        connection.logUnflushedBytes = stream.writableLength || 0;
        stream.destroy(new ServiceError('세션 로그 저장이 끝나지 않아 일부 출력을 저장하지 못했습니다.', 'LOG_CLOSE_TIMEOUT'));
        await new Promise(resolve => { if (stream.closed) resolve(); else stream.once('close', resolve); });
        settleLoss();
        if (connection.logStopping === stream) connection.logStopping = null;
        return;
      }
      let closeTimedOut = false;
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          closeTimedOut = true;
          stream.destroy(new ServiceError('세션 로그를 끝까지 닫지 못해 일부 출력을 저장하지 못했습니다.', 'LOG_CLOSE_TIMEOUT'));
        }, 1000);
        timer.unref();
        stream.once('close', () => { clearTimeout(timer); resolve(); });
        stream.end(tail);
      });
      this.logQueue.release(connection.id);
      if (queueGeneration !== undefined) connection.logQueueGeneration = undefined;
      connection.logStopping = null;
      this._unlistenLogDrain(connection);
      // The attempt is over: its handler must not stay installed on a closed
      // writer, or a late error would be answered by the next attempt (V7-M-01).
      this._unlistenLogError(connection, stream);
      // A forced close leaves any unfinished writes unconfirmed.
      if (closeTimedOut || this.logLossBytes(connection)) settleLoss();
    })());
  }

  // §4.2: report an incomplete log without terminating the session. The count
  // includes unconfirmed writes, which may have partially reached the file.
  _reportLogIncomplete(connection, code, message, droppedBytes) {
    const dropped = droppedBytes || 0;
    if (dropped) connection.logDroppedBytes = Math.max(connection.logDroppedBytes || 0, dropped);
    connection.logIncomplete = true;
    if (connection.finishEvent) {
      connection.finishEvent.logIncomplete = true;
      if (connection.logDroppedBytes) connection.finishEvent.droppedLogBytes = connection.logDroppedBytes;
    }
    this._emit({ type: 'log', id: connection.id, enabled: false, path: null,
      incomplete: true, droppedLogBytes: dropped, unconfirmedLogBytes: connection.logUnconfirmedBytes || 0 });
    this._emit({ type: 'log-error', id: connection.id, message, code });
  }

  // Removing the writer's 'drain' listener must happen after the queue is empty,
  // never before: the pump blocks on that event.
  _unlistenLogDrain(connection) {
    if (!connection.logDrainListener) return;
    const { stream: writer, onDrain } = connection.logDrainListener;
    writer.removeListener('drain', onDrain);
    connection.logDrainListener = null;
  }

  _closeServer(server) {
    return this._cleanup(new Promise(resolve => {
      try { server.close(() => resolve()); } catch { resolve(); }
    }));
  }

  _fail(connection, error) {
    if (!connection.closed) this._finish(connection, 'error', error.message, error.code);
  }

  _finish(connection, status, message, code) {
    if (connection.closed) return connection.finishPromise;
    connection.closed = true;
    connection.receivePaused = false;
    connection.receiveLogPaused = false;
    connection.receiveLease?.closing();
    // Create the close record before any destroy is requested: a caller holding
    // only the id must be able to find the same record and wait on the real
    // socket close, not on this connection's map membership.
    connection.transportCloseRecord = connection.transportCloseRecord || this._transportClose(connection);
    connection.finishEvent = { type: 'status', id: connection.id, status, message, ...(code ? { code } : {}) };
    if (connection.disconnectCause) connection.finishEvent.disconnectCause = connection.disconnectCause;
    // The connection map entry is deleted below, so a failed authentication must
    // carry its secret-free summary on the terminal event itself; a consumer
    // cannot call getConnectionInfo for it afterwards.
    const summary = authenticationSummary(connection.authState);
    if (summary) connection.finishEvent.authentication = summary;
    connection.finishPromise = this._cleanup(new Promise(resolve => { connection.resolveFinish = resolve; }));
    this.finishing.set(connection.id, connection.finishPromise);
    clearTimeout(connection.shellCloseTimer); connection.shellCloseTimer = null;
    const shell = connection.shell;
    if (shell) {
      shell.pause(); shell.stderr?.pause();
      if (connection.stdoutData) shell.removeListener('data', connection.stdoutData);
      if (connection.stderrData) shell.stderr?.removeListener('data', connection.stderrData);
      // net.Socket retains its JS readable buffer after destroy(). Stop further
      // TCP reception now, then parse only those retained bytes as NVT below.
      if (connection.info.protocol === 'telnet') destroy(shell);
      connection.receiveDrain = { shell, timer: null, immediate: null, nextChannel: 0 };
      this.receiving.set(connection.id, connection);
      // This is an absolute deadline: duplicate disconnects, ACKs and log
      // progress cannot keep a closing transport alive indefinitely.
      connection.receiveDrain.timer = setTimeout(() => this._completeFinish(connection, 'timeout'), this.receiveDrainTimeoutMs);
      if (!connection.logWriter && (connection.logOpening || connection.initialLogRequested)
        && (this._pendingReceive(connection).pendingReceiveBytes || connection.logPendingBytes)) {
        connection.finishEvent.logIncomplete = true;
        this._emit({ type: 'log-error', id: connection.id,
          message: '로그 파일을 여는 중 연결이 종료되어 일부 수신 출력을 저장하지 못했습니다.' });
      }
    }
    connection.status = status;
    this.connections.delete(connection.id);
    for (const handshake of connection.handshakes) handshake.stop();
    for (const cancel of [...connection.pending]) cancel();
    for (const job of connection.jobs.values()) job.cancel();
    connection.jobs.clear();
    for (const server of connection.servers) this._closeServer(server);
    connection.servers.clear();
    for (const resource of connection.resources) if (resource !== shell) destroy(resource);
    connection.resources.clear();
    connection.forwardSockets.clear();
    for (const [client, transportClosed] of connection.clients) {
      if (transportClosed) this._cleanup(transportClosed);
      // Record the real socket before destroy() is requested: the close event is
      // what a waiting batch row needs, and it can arrive long after this
      // function returns.
      this._trackClientClose(connection, client);
      destroy(client);
    }
    connection.clients.clear();
    if (connection.sftpClosing) {
      clearTimeout(connection.sftpClosing.timer);
      connection.sftpClosing.resolve();
      connection.sftpClosing = null;
    }
    connection.sftp = connection.client = null;
    // Telnet owns a bare net.Socket as its shell; SSH owns channels here, whose
    // 'close' is not a TCP close, so only a socket is counted.
    if (connection.shell instanceof net.Socket) this._trackSocketClose(connection, connection.shell);
    // Nothing tracked and nothing left to close: the record must not wait for an
    // event that can never arrive.
    this._settleTransportClose(connection);
    // Freeze network input first. Only already received channel bytes are
    // drained; this never waits for additional data or a remote close reply.
    if (shell && this._pendingReceive(connection).pendingReceiveBytes) this._scheduleReceiveDrain(connection);
    else this._completeFinish(connection);
    return connection.finishPromise;
  }

  _pendingReceive(connection) {
    const shell = connection.receiveDrain?.shell;
    const pendingReceiveStdoutBytes = shell?.readableLength || 0;
    const pendingReceiveStderrBytes = shell?.stderr?.readableLength || 0;
    return { pendingReceiveStdoutBytes, pendingReceiveStderrBytes,
      pendingReceiveBytes: pendingReceiveStdoutBytes + pendingReceiveStderrBytes };
  }

  _scheduleReceiveDrain(connection) {
    const drain = connection.receiveDrain;
    if (!drain || drain.immediate) return;
    drain.immediate = setImmediate(() => {
      drain.immediate = null;
      if (connection.receiveDrain !== drain) return;
      this._drainReceived(connection);
    });
  }

  _drainReceived(connection) {
    const drain = connection.receiveDrain;
    if (!drain) return;
    // Read bounded chunks and yield between bursts so timers/cancellation and
    // other connections remain responsive, including without an IPC consumer.
    // Display credit and log queue depth are deliberately NOT conditions here:
    // the transport must finish consuming what the peer already sent, otherwise
    // the SSH channel window stays closed and a device VTY queue can overflow.
    let budget = 8 * RECEIVE_DRAIN_CHUNK;
    while (this._pendingReceive(connection).pendingReceiveBytes) {
      if (connection.transportPaused) return;
      if (budget <= 0) { this._scheduleReceiveDrain(connection); return; }
      const channels = [drain.shell, drain.shell.stderr];
      let index = drain.nextChannel;
      if (!channels[index]?.readableLength) index = 1 - index;
      const stream = channels[index];
      let bytes;
      try { bytes = stream.read(Math.min(RECEIVE_DRAIN_CHUNK, stream.readableLength)); }
      catch { this._completeFinish(connection, 'read-error'); return; }
      if (!bytes?.length) { this._completeFinish(connection, 'read-error'); return; }
      drain.nextChannel = 1 - index;
      budget -= bytes.length;
      try { this._drainTerminalData(connection, bytes, index ? 'stderr' : 'stdout'); }
      catch { this._completeFinish(connection, 'read-error'); return; }
    }
    this._completeFinish(connection);
  }

  _drainTerminalData(connection, bytes, channel) {
    this._terminalData(connection, bytes, channel, true);
  }

  _flushTerminalDecoders(connection) {
    for (const decoder of [connection.terminalEncoding, connection.stderrEncoding]) {
      const tail = decoder?.end();
      if (tail?.length) {
        // A raw log keeps wire bytes only; this decoded tail has no wire bytes.
        this._writeTerminalLog(connection, Buffer.alloc(0), tail);
        this._emit({ type: 'data', id: connection.id, data: this.binaryOutput ? tail : tail.toString('base64') });
      }
    }
  }

  _completeFinish(connection, reason) {
    if (!connection.resolveFinish) return;
    const drain = connection.receiveDrain;
    if (reason) {
      const pending = this._pendingReceive(connection);
      if (pending.pendingReceiveBytes) {
        Object.assign(connection.finishEvent, pending, { outputIncomplete: true,
          pendingOutputBytes: pending.pendingReceiveBytes, receiveDrainTimedOut: reason === 'timeout' });
        connection.finishEvent.message += ' 수신 버퍼의 일부 출력을 처리하지 못했습니다.';
        if (connection.logWriter || connection.logOpening || connection.initialLogRequested) {
          connection.finishEvent.logIncomplete = true;
          connection.finishEvent.message += ' 해당 바이트는 로그에도 저장되지 않았습니다.';
        }
      }
    }
    // Report an incomplete log separately from network failure. Unconfirmed writes
    // may have partially reached disk; their physical loss cannot be determined.
    if (connection.logIncomplete) {
      connection.finishEvent.logIncomplete = true;
      if (connection.logDroppedBytes) connection.finishEvent.droppedLogBytes = connection.logDroppedBytes;
    }
    if (drain) { clearTimeout(drain.timer); clearImmediate(drain.immediate); }
    connection.receiveDrain = null;
    this.receiving.delete(connection.id);
    this._flushTerminalDecoders(connection);
    this._stopLog(connection);
    if (drain) { destroy(drain.shell); if (drain.shell.stderr) destroy(drain.shell.stderr); }
    connection.shell = null;
    connection.receiveLease?.release(); connection.receiveLease = null;
    const resolve = connection.resolveFinish; connection.resolveFinish = null;
    this._emit(connection.finishEvent);
    this.finishing.delete(connection.id);
    resolve();
  }

  disconnect(id, cause) {
    const connection = this.connections.get(id) || this.receiving.get(id);
    if (connection) {
      if (!connection.closed) connection.disconnectCause = outputDisconnectCause(cause);
      const safe = connection.disconnectCause;
      return this._finish(connection, 'disconnected', safe ? disconnectLabel({disconnectCause:safe}) : 'Disconnected.', safe?.code);
    }
  }

  // Bounded, row-local teardown. Resolves true only when this connection's own
  // TCP socket(s) actually emitted 'close' inside the budget — never merely
  // because the connection left the service maps. It never rejects and never
  // waits for the whole service, so one slow device cannot block other workers.
  async disconnectAndWaitClosed(id, { timeoutMs = 2000 } = {}) {
    const bound = Number.isInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 2000;
    if (typeof id !== 'string' || !id) return false;
    const existing = this.transportCloses.get(id);
    let record = existing;
    try {
      // `disconnect` returns the finish promise; the socket close is tracked
      // separately, so the return value is deliberately not used as the verdict.
      const started = this.disconnect(id);
      record = this.transportCloses.get(id) || record;
      // A connection found only in `receiving` (already drained) has no live
      // socket left; _finish() above still created its record.
      if (!record && started) record = this._transportClose(this.connections.get(id) || this.receiving.get(id) || { id });
    } catch { /* already gone; fall through to the tracked record */ }
    if (!record) return false;
    // A socket that closed before this call is a satisfied contract, not a
    // missing one. An untracked connection (never existed, or an old record
    // already pruned) stays false: "no evidence" is not "closed".
    if (record.settled) return true;
    record.boundMs = bound;
    const settled = await this._settledWithin(record.promise, bound);
    if (!settled) {
      // Unknown-safe metadata only: no event is emitted, because the renderer
      // routes an event for a finished connection id into its early-event buffer.
      record.timedOut = true;
      return false;
    }
    return true;
  }

  disconnectAll() {
    for (const connection of [...this.connections.values()]) this.disconnect(connection.id);
  }

  listConnections() {
    return [...this.connections.values()].map(({ id, sessionId, status }) => ({ id, sessionId, status }));
  }

  getConnectionInfo(id) {
    const connection = this._connection(id, false);
    return { id, sessionId: connection.sessionId, status: connection.status,
      ...connection.info, cols: connection.cols, rows: connection.rows,
      forwards: connection.forwards.map(rule => ({ ...rule })),
      logging: { enabled: !!connection.logStream, path: connection.logPath, format: connection.logFormat || DEFAULT_LOG_SETTINGS.logFormat,
        // A failed/truncated recording is part of the connection's observable
        // state, not a hidden counter: the UI has to be able to say the log is
        // incomplete while the session itself keeps working.
        incomplete: !!connection.logIncomplete,
        droppedBytes: connection.logDroppedBytes || 0 } };
  }

  async close() {
    this.closed = true;
    this.disconnectAll();
    while (this.cleanups.size) await Promise.allSettled([...this.cleanups]);
    // Every connection is finished now; drop the retained close records so a
    // closed service holds no per-connection state.
    this.transportCloses.clear();
  }
}

module.exports = { SshService };
