'use strict';

const fs = require('node:fs');
const { atomicRenameSync } = require('./atomic-rename.cjs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { windTermFolder } = require('./windterm-folders.cjs');
const { isIP } = require('node:net');
const { DEFAULT_LOG_SETTINGS, validateLogTemplate } = require('./logging-settings.cjs');
const { layoutSettings } = require('./layout-settings.cjs');
const { normalizeTerminalEncoding } = require('./terminal-encoding.cjs');
const { INTERACTION_DEFAULTS, interactionSettings } = require('./interaction-settings.cjs');
const { APPEARANCE_DEFAULTS, appearanceSettings } = require('./terminal-appearance.cjs');
const { normalizeKeymap } = require('../renderer/terminal-keymap.cjs');
const { normalizeOverrides, effectiveBindings, validateOverrides, collectSendTextKeys } = require('./shortcut-config.cjs');

const VERSION = 1;
const LOG_FORMAT_PREFERENCE_REVISION = 1;
const MAX_FOLDERS = 10000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SESSIONS = 20000;
const MAX_SNIPPETS = 1000;
const MAX_CREDENTIALS = 1000;
const MAX_HOSTS = 20000;
const MAX_BATCH_TEMPLATES = 100;
const MAX_BATCH_TEMPLATE_BYTES = 32 * 1024 * 1024;
const BATCH_TEMPLATE_SCHEMA = 1;
// Compare-and-swap token for "no template document exists yet". It must be a
// real token, not `null`: the UI mapped `null` to `undefined`, `undefined` means
// "no CAS", and two windows that both opened the empty dialog could then create
// the same template name with the second one silently overwriting the first
// (V4 M-01). A constant is correct here because the state it names ("file
// absent") is a single state; `#checkTemplateRevision` accepts it only while the
// file is still absent.
const EMPTY_TEMPLATE_REVISION = '__empty__';
const DEFAULT_SETTINGS = Object.freeze({ fontSize: 14, scrollback: 10000, theme: 'dark', terminalColorScheme: 'wind', semanticColoring: true, terminalLineNumbers:false, terminalTimestamps:false, ...APPEARANCE_DEFAULTS, ...DEFAULT_LOG_SETTINGS, logFormatPreferenceRevision: LOG_FORMAT_PREFERENCE_REVISION, logRotateDaily: false, updateDirectory: '', updateFromLocalFolder: false, updateCheckOnStartup: true, updateSnoozeUntil: 0, keymap: [], shortcuts: {}, sharedCredentialBindings: {}, ...INTERACTION_DEFAULTS, quickUsername: '', layout: layoutSettings() });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const value = (object, key, fallback) => own(object, key) && object[key] !== undefined ? object[key] : fallback;

function fail(message, code = 'ERR_VALIDATION') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function record(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail(`${label} 값은 객체여야 합니다.`);
  }
  return input;
}

function string(input, label, maximum, { empty = true, trim = true, multiline = false } = {}) {
  if (typeof input !== 'string' || input.length > maximum) fail(`${label} 값은 ${maximum}자 이하의 문자열이어야 합니다.`);
  if ((multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(input)) fail(`${label} 값에 제어 문자가 있습니다.`);
  const result = trim ? input.trim() : input;
  if (!empty && !result) fail(`${label} 값을 입력해 주세요.`);
  return result;
}

function integer(input, label, minimum, maximum) {
  if (typeof input === 'string' && /^\d{1,10}$/.test(input)) input = Number(input);
  if (!Number.isSafeInteger(input) || input < minimum || input > maximum) fail(`${label} 값은 ${minimum}부터 ${maximum} 사이의 정수여야 합니다.`);
  return input;
}

function boolean(input, label) {
  if (typeof input !== 'boolean') fail(`${label} 값은 참/거짓이어야 합니다.`);
  return input;
}

function identifier(input, label = 'id', empty = false) {
  const result = string(input, label, 128, { empty, trim: false });
  if (result && (!/^[A-Za-z0-9_-]+$/.test(result) || ['__proto__', 'constructor', 'prototype'].includes(result))) fail(`${label} 값이 올바르지 않습니다.`);
  return result;
}

function host(input, label = 'host') {
  const result = string(input, label, 253, { empty: false });
  const unwrapped = result.startsWith('[') && result.endsWith(']') ? result.slice(1, -1) : result;
  if (!isIP(unwrapped) && !/^[\p{L}\p{N}_.-]+$/u.test(result)) fail(`${label} 값이 올바르지 않습니다.`);
  return unwrapped;
}

function folder(input) {
  const result = string(input, 'folder', 1024).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
  if (result.split('/').some(part => part === '.' || part === '..')) fail('folder cannot contain dot path components');
  return result;
}

function folderPaths(input) {
  if (!Array.isArray(input) || input.length > MAX_FOLDERS * 3) fail('폴더가 너무 많습니다.');
  const paths = new Set();
  for (const item of input) {
    const normalized = folder(item);
    let parent = '';
    for (const part of normalized.split('/').filter(Boolean)) {
      parent = parent ? `${parent}/${part}` : part;
      paths.add(parent);
      if (paths.size > MAX_FOLDERS) fail('폴더가 너무 많습니다.');
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b, 'ko'));
}

const insideFolder = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}/`);

function strings(input, label, count, length) {
  if (!Array.isArray(input) || input.length > count) fail(`${label} 값은 최대 ${count}개의 문자열 목록이어야 합니다.`);
  return [...new Set(input.map(item => string(item, label, length, { empty: false })))];
}

// A whitelist is used for every public boundary, including data read back from disk.
// Secret values and unknown/inherited keys can never become public session fields.
function sanitizeSession(input, previous = {}) {
  record(input, 'session');
  const field = (key, fallback) => value(input, key, value(previous, key, fallback));
  const sessionHost = host(field('host', ''));
  const protocol = string(field('protocol', 'ssh'), 'protocol', 8, { empty: false });
  if (!['ssh', 'telnet'].includes(protocol)) fail('protocol must be ssh or telnet');
  const telnetEnter = string(field('telnetEnter', protocol === 'telnet' ? 'cr' : 'crlf'), 'telnetEnter', 4, { empty: false });
  if (!['crlf', 'cr'].includes(telnetEnter)) fail('telnetEnter must be crlf or cr');
  const authType = string(field('authType', 'password'), 'authType', 16, { empty: false });
  if (!['password', 'key', 'agent'].includes(authType)) fail('authType must be password, key, or agent');
  const forwards = field('forwards', []);
  if (!Array.isArray(forwards) || forwards.length > 32) fail('forwards must contain at most 32 entries');
  const result = {
    name: string(field('name', sessionHost), 'name', 256, { empty: false }),
    folder: folder(field('folder', '')),
    host: sessionHost,
    protocol, telnetEnter, localEcho: boolean(field('localEcho', false), 'localEcho'),
    port: integer(field('port', protocol === 'telnet' ? 23 : 22), 'port', 1, 65535),
    username: string(field('username', ''), 'username', 256),
    authType,
    privateKeyPath: string(field('privateKeyPath', ''), 'privateKeyPath', 4096),
    agentPath: string(field('agentPath', ''), 'agentPath', 4096),
    rememberPassphrase: boolean(field('rememberPassphrase', false), 'rememberPassphrase'),
    favorite: boolean(field('favorite', false), 'favorite'),
    tags: strings(field('tags', []), 'tags', 64, 128),
    notes: string(field('notes', ''), 'notes', 16384, { trim: false, multiline: true }),
    terminalType: string(field('terminalType', 'xterm-256color'), 'terminalType', 64, { empty: false }),
    encoding: normalizeTerminalEncoding(field('encoding', 'utf-8')),
    keymap: field('keymap', null) === null ? null : normalizeKeymap(field('keymap', null)),
    ...appearanceSettings(input, previous, true),
    fontSize: integer(field('fontSize', 0), 'fontSize', 0, 48),
    scrollback: integer(field('scrollback', 0), 'scrollback', 0, 100000),
    cursorStyle: string(field('cursorStyle', 'bar'), 'cursorStyle', 12, { empty: false }),
    cursorBlink: boolean(field('cursorBlink', true), 'cursorBlink'),
    backspace: string(field('backspace', 'del'), 'backspace', 3, { empty: false }),
    autoReconnect: boolean(field('autoReconnect', false), 'autoReconnect'),
    reconnectDelay: integer(field('reconnectDelay', 5), 'reconnectDelay', 1, 300),
    reconnectAttempts: integer(field('reconnectAttempts', 1), 'reconnectAttempts', 1, 10),
    keepaliveInterval: integer(field('keepaliveInterval', 30), 'keepaliveInterval', 0, 86400),
    handshakeTimeout: integer(field('handshakeTimeout', 30), 'handshakeTimeout', 5, 300),
    logEnabled: boolean(field('logEnabled', false), 'logEnabled'),
    jumpSessionId: identifier(field('jumpSessionId', ''), 'jumpSessionId', true),
    forwards: forwards.map(item => {
      record(item, 'forward');
      return {
        bindHost: host(value(item, 'bindHost', '127.0.0.1'), 'bindHost'),
        bindPort: integer(value(item, 'bindPort', undefined), 'bindPort', 1, 65535),
        destHost: host(value(item, 'destHost', ''), 'destHost'),
        destPort: integer(value(item, 'destPort', undefined), 'destPort', 1, 65535)
      };
    }),
    importWarnings: strings(field('importWarnings', []), 'importWarnings', 64, 2048)
  };
  // Empty/omitted references mean session-owned authentication. Keep the field
  // optional so legacy profiles and shared/publication shapes stay compatible.
  const credentialId = identifier(field('credentialId', ''), 'credentialId', true);
  if (credentialId) result.credentialId = credentialId;
  // Reprompt policy opt-out. The default (`fresh-on-password-reprompt`) ends the
  // transport when a device asks for the login password twice in one factor; a
  // device that legitimately asks again in the same session can opt into an
  // inline answer. Only an explicit value is stored, so a profile that never
  // chose one keeps the default and the public shape stays unchanged.
  if (own(input, 'passwordReprompt') || own(previous, 'passwordReprompt')) {
    const passwordReprompt = string(field('passwordReprompt', 'fresh-connection'), 'passwordReprompt', 32, { empty: false });
    if (!['fresh-connection', 'allow-inline'].includes(passwordReprompt)) fail('passwordReprompt must be fresh-connection or allow-inline');
    result.passwordReprompt = passwordReprompt;
  }
  // Absent legacy fields use the renderer's SSH word policy without rewriting disk.
  if (own(input, 'ctrlArrowMode') || own(previous, 'ctrlArrowMode')) {
    const mode = field('ctrlArrowMode', 'word');
    if (!['word', 'native'].includes(mode)) fail('ctrlArrowMode must be word or native');
    result.ctrlArrowMode = mode;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(result.terminalType)) fail('terminalType is invalid');
  if (result.fontSize && result.fontSize < 10) fail('fontSize must be 0 or from 10 to 48');
  if (result.scrollback && result.scrollback < 1000) fail('scrollback must be 0 or from 1000 to 100000');
  if (!['bar', 'block', 'underline'].includes(result.cursorStyle)) fail('cursorStyle is invalid');
  if (!['del', 'bs'].includes(result.backspace)) fail('backspace is invalid');
  if (protocol === 'telnet' && (result.jumpSessionId || result.forwards.length)) fail('Telnet 세션에서는 SSH 점프 세션이나 포워딩을 사용할 수 없습니다.');
  const bindings = new Set();
  for (const forward of result.forwards) {
    const binding = `${forward.bindHost.toLowerCase()}:${forward.bindPort}`;
    if (bindings.has(binding)) fail('forwards contain duplicate local bindings');
    bindings.add(binding);
  }
  return result;
}

function sanitizeSnippet(input, previous = {}) {
  record(input, 'snippet');
  const result = {
    name: string(value(input, 'name', value(previous, 'name', '')), 'snippet name', 256, { empty: false }),
    command: string(value(input, 'command', value(previous, 'command', '')), 'snippet command', 32768, { empty: false, trim: false, multiline: true })
  };
  // Legacy snippets retain their original shape. Omitted fields resolve to
  // folder='' and target='active'; explicitly saved values survive list/export.
  if (own(input, 'folder') || own(previous, 'folder')) result.folder = folder(value(input, 'folder', value(previous, 'folder', '')));
  if (own(input, 'target') || own(previous, 'target')) {
    result.target = string(value(input, 'target', value(previous, 'target', 'active')), 'snippet target', 8, { empty: false });
    if (!['active', 'all', 'selected'].includes(result.target)) fail('snippet target must be active, all, or selected');
  }
  return result;
}

function credentialFields(input, previous = {}) {
  record(input, 'credential');
  const field = (key, fallback) => value(input, key, value(previous, key, fallback));
  const authType = string(field('authType', 'password'), 'authType', 16, { empty: false });
  if (!['password', 'key', 'agent'].includes(authType)) fail('authType must be password, key, or agent');
  return {
    name: string(field('name', ''), 'credential name', 256, { empty: false }),
    username: string(field('username', ''), 'username', 256), authType,
    privateKeyPath: string(field('privateKeyPath', ''), 'privateKeyPath', 4096),
    agentPath: string(field('agentPath', ''), 'agentPath', 4096)
  };
}

function publicCredential(item) {
  return { id: item.id, ...credentialFields(item),
    hasPassphrase: Boolean(item.passphraseEncrypted), createdAt: item.createdAt, updatedAt: item.updatedAt };
}

function validateCredentials(sessions, credentials) {
  const ids = new Set(credentials.map(item => item.id));
  if (sessions.some(item => item.credentialId && !ids.has(item.credentialId))) fail('credentialId must reference an existing local credential');
}

function sharedCredentialBindings(input) {
  record(input, 'sharedCredentialBindings');
  const bindings = {};
  for (const [sourceId, credentialId] of Object.entries(input)) {
    // SharedSessions generates source IDs with randomUUID(). Validate only the
    // namespace here; main owns checking that a selected source is registered.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceId)) fail('sharedCredentialBindings source ID must be a UUID v4');
    const id = sourceId.toLowerCase();
    if (own(bindings, id)) fail('duplicate shared credential source ID');
    bindings[id] = identifier(credentialId, 'shared credential ID');
  }
  return bindings;
}

function validateSharedCredentialBindings(bindings, credentials) {
  const ids = new Set(credentials.map(item => item.id));
  if (Object.values(bindings).some(id => !ids.has(id))) fail('sharedCredentialBindings must reference existing local credentials');
}

function changedAt(previous) {
  // Millisecond collisions must not defeat an optional updatedAt precondition.
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}

const SESSION_PATCH_FIELDS = Object.freeze([
  'host', 'protocol', 'port', 'username', 'authType', 'privateKeyPath', 'agentPath', 'credentialId',
  'passwordReprompt', 'ctrlArrowMode',
  'telnetEnter', 'localEcho', 'terminalType', 'encoding', 'keepaliveInterval', 'handshakeTimeout', 'jumpSessionId', 'forwards',
  'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontSize', 'scrollback',
  'cursorStyle', 'cursorBlink', 'backspace', 'autoReconnect', 'reconnectDelay', 'reconnectAttempts', 'logEnabled', 'keymap'
]);

function settings(input, previous = DEFAULT_SETTINGS, { fromDisk = false } = {}) {
  record(input, 'settings');
  // Reject unknown revisions instead of silently overwriting newer or corrupt preferences.
  if (own(input, 'logFormatPreferenceRevision') && input.logFormatPreferenceRevision !== LOG_FORMAT_PREFERENCE_REVISION) fail('로그 저장 형식 설정 버전이 올바르지 않습니다.');
  previous = { ...DEFAULT_SETTINGS, ...previous };
  const result = {
    ...interactionSettings(input, previous),
    ...appearanceSettings(input, previous),
    fontSize: integer(value(input, 'fontSize', previous.fontSize), 'fontSize', 10, 48),
    scrollback: integer(value(input, 'scrollback', previous.scrollback), 'scrollback', 1000, 100000),
    theme: string(value(input, 'theme', previous.theme), 'theme', 5, { empty: false }),
    terminalColorScheme: string(value(input, 'terminalColorScheme', previous.terminalColorScheme), 'terminalColorScheme', 10, { empty: false }),
    semanticColoring: boolean(value(input, 'semanticColoring', previous.semanticColoring), 'semanticColoring'),
    terminalLineNumbers: boolean(value(input,'terminalLineNumbers',previous.terminalLineNumbers),'terminalLineNumbers'),
    terminalTimestamps: boolean(value(input,'terminalTimestamps',previous.terminalTimestamps),'terminalTimestamps'),
    logEnabled: boolean(value(input,'logEnabled',previous.logEnabled),'logEnabled'),
    logDirectory: string(value(input,'logDirectory',previous.logDirectory),'logDirectory',4096),
    updateDirectory: string(value(input,'updateDirectory',previous.updateDirectory),'updateDirectory',4096),
    updateFromLocalFolder: boolean(value(input,'updateFromLocalFolder',previous.updateFromLocalFolder),'updateFromLocalFolder'),
    updateCheckOnStartup: boolean(value(input,'updateCheckOnStartup',previous.updateCheckOnStartup),'updateCheckOnStartup'),
    updateSnoozeUntil: integer(value(input,'updateSnoozeUntil',previous.updateSnoozeUntil),'updateSnoozeUntil',0,Number.MAX_SAFE_INTEGER),
    logFilenameTemplate: validateLogTemplate(value(input,'logFilenameTemplate',previous.logFilenameTemplate)),
    logFormat: string(value(input,'logFormat',previous.logFormat),'logFormat',8,{empty:false}),
    logFormatPreferenceRevision: LOG_FORMAT_PREFERENCE_REVISION,
    logTimestamps: boolean(value(input,'logTimestamps',previous.logTimestamps),'logTimestamps'),
    logRotateDaily: boolean(value(input,'logRotateDaily',previous.logRotateDaily),'logRotateDaily'),
    keymap: own(input, 'keymap') && input.keymap !== undefined ? normalizeKeymap(input.keymap) : previous.keymap,
    // Preserve malformed/newer on-disk shortcut data until explicit correction.
    // Other store operations must not silently reset it to defaults.
    shortcuts: own(input, 'shortcuts') && input.shortcuts !== undefined
      ? fromDisk ? structuredClone(input.shortcuts) : normalizeOverrides(input.shortcuts)
      : previous.shortcuts,
    sharedCredentialBindings: sharedCredentialBindings(value(input, 'sharedCredentialBindings', previous.sharedCredentialBindings)),
    quickUsername: string(value(input,'quickUsername',previous.quickUsername),'quickUsername',256),
    layout: layoutSettings(value(input,'layout',previous.layout), previous.layout)
  };
  if (!['dark', 'light'].includes(result.theme)) fail('theme must be dark or light');
  if (!['wind', 'securecrt', 'classic'].includes(result.terminalColorScheme)) fail('터미널 색상은 WindTerm 또는 SecureCRT 방식을 선택해 주세요.');
  if(result.logDirectory&&!path.isAbsolute(result.logDirectory))fail('로그 저장 폴더는 절대 경로로 지정해 주세요.');
  if(result.updateDirectory&&!path.isAbsolute(result.updateDirectory))fail('업데이트 폴더는 절대 경로로 지정해 주세요.');
  // Migrate by stored intent, not by whether a mapped drive or UNC is reachable.
  if (fromDisk && !own(input, 'updateFromLocalFolder')) result.updateFromLocalFolder = !!result.updateDirectory;
  if(!['raw','text'].includes(result.logFormat))fail('로그 저장 형식은 원본 또는 일반 텍스트를 선택해 주세요.');
  // Older stores could have inherited raw as the default; migrate only once.
  if (fromDisk && !own(input, 'logFormatPreferenceRevision')) result.logFormat = DEFAULT_LOG_SETTINGS.logFormat;
  return result;
}

function hostKey(input) {
  const key = string(input, 'known host key', 320, { empty: false });
  const match = /^(.*):(\d{1,5})$/.exec(key);
  if (!match) fail('known host key must be host:port');
  const name = host(match[1]).toLowerCase();
  const port = integer(match[2], 'known host port', 1, 65535);
  return `${name.includes(':') ? `[${name}]` : name}:${port}`;
}

function fingerprint(input) {
  const result = string(input, 'fingerprint', 64, { empty: false, trim: false });
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(result)) fail('fingerprint must be a SHA256 SSH fingerprint');
  const encoded = result.slice(7).replace(/=$/, '');
  if (Buffer.from(encoded, 'base64').toString('base64').replace(/=$/, '') !== encoded) fail('fingerprint is invalid');
  return `SHA256:${encoded}`;
}

function cipher(input) {
  if (typeof input !== 'string' || input.length > 65536 || !input || input.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input) ||
      Buffer.from(input, 'base64').toString('base64') !== input) fail('encrypted credential must be bounded base64');
  return input;
}

function timestamp(input, label) {
  if (typeof input !== 'string' || input.length !== 24 || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail(`${label} 값이 올바르지 않습니다.`);
  return input;
}

function publicSession(session) {
  return {
    id: session.id,
    ...sanitizeSession(session),

    hasPassphrase: Boolean(session.passphraseEncrypted),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function validateJumps(sessions) {
  const byId = new Map(sessions.map(session => [session.id, session]));
  for (const session of sessions) {
    const visited = new Set([session.id]);
    let next = session.jumpSessionId;
    while (next) {
      if (!byId.has(next)) fail('jumpSessionId must reference an existing session');
      if (byId.get(next).protocol === 'telnet') fail('jumpSessionId must reference an SSH session');
      if (visited.has(next)) fail('jump sessions cannot contain a cycle');
      visited.add(next);
      next = byId.get(next).jumpSessionId;
    }
  }
}

function initialData() {
  return { version: VERSION, folders: [], sessions: [], credentials: [], snippets: [], settings: structuredClone(DEFAULT_SETTINGS), knownHosts: Object.create(null) };
}

function serializeStore(data) {
  return `${JSON.stringify(data)}\n`;
}

// Bound the retained UTF-16 representation to at most 32 MiB. The only cached
// value is the current committed sessions array; all mutation paths replace it.
const MAX_CACHED_SESSIONS_CHARS = 16 * 1024 * 1024;
function serializeStoreWithSessions(data, sessionsJson) {
  return `{${Object.keys(data).map(key => `${JSON.stringify(key)}:${key === 'sessions' ? sessionsJson : JSON.stringify(data[key])}`).join(',')}}\n`;
}

// Pure preparation shared by real imports and export preflight. Keep ID/jump
// remapping, credential removal, defaults and folder expansion in one path so
// the predicted size is the size #commit will actually write to a fresh store.
function prepareImport(input, current) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_FILE_BYTES) fail('가져올 파일이 크기 제한을 초과했습니다.');
    try { input = JSON.parse(input); } catch { fail('가져올 파일의 JSON 형식이 올바르지 않습니다.'); }
  }
  record(input, 'import');
  if (own(input, 'version') && input.version !== VERSION) fail('지원하지 않는 SessionDock 설정 파일 버전입니다.');
  const rawSessions = value(input, 'sessions', []);
  const rawSnippets = value(input, 'snippets', []);
  if (!Array.isArray(rawSessions)) fail('가져올 세션 목록은 배열이어야 합니다.');
  if (rawSessions.length + current.sessions.length > MAX_SESSIONS) {
    fail(`가져온 뒤 로컬 세션 총 ${current.sessions.length + rawSessions.length}개는 최대 ${MAX_SESSIONS}개를 초과합니다. 현재 ${current.sessions.length}개이며 추가 가능 ${Math.max(0, MAX_SESSIONS - current.sessions.length)}개입니다.`);
  }
  if (!Array.isArray(rawSnippets) || rawSnippets.length + current.snippets.length > MAX_SNIPPETS) fail('가져오면 스니펫 수가 최대 한도를 초과합니다.');
  const ids = new Map();
  const now = new Date().toISOString();
  const importedSessions = rawSessions.map(item => {
    record(item, 'import session');
    const sourceId = identifier(value(item, 'id', ''), 'import id', true);
    if (sourceId && ids.has(sourceId)) fail('duplicate import id');
    const id = randomUUID();
    if (sourceId) ids.set(sourceId, id);
    // Foreign references must never bind to this machine's credentials, even
    // if a supplied ID happens to match a local profile (or is malformed).
    const metadata = sanitizeSession({ ...item, credentialId: '' });
    return { id, ...metadata, rememberPassphrase: false, createdAt: now, updatedAt: now };
  });
  for (const session of importedSessions) session.jumpSessionId = ids.get(session.jumpSessionId) || '';
  const sessions = [...current.sessions, ...importedSessions];
  validateJumps(sessions);
  const importedSnippets = rawSnippets.map(item => ({ id: randomUUID(), ...sanitizeSnippet(item) }));
  const snippets = [...current.snippets, ...importedSnippets];
  const currentFolders = folderPaths([...current.folders, ...current.sessions.map(item => item.folder)]);
  const folders = folderPaths([...currentFolders, ...folderPaths(value(input, 'folders', [])), ...importedSessions.map(item => item.folder)]);
  return { next: { ...current, folders, sessions, snippets }, importedSessions, importedSnippets };
}

function freshImportSize(input) {
  // No SessionStore constructor, path, profile or filesystem operation. UUIDs
  // and ISO timestamps have the same serialized lengths as a subsequent import.
  return Buffer.byteLength(serializeStore(prepareImport(input, initialData()).next));
}

function loadData(input) {
  record(input, 'store');
  if (value(input, 'version') !== VERSION) fail('unsupported store schema version');
  if (!Array.isArray(input.sessions) || input.sessions.length > MAX_SESSIONS ||
      !Array.isArray(input.snippets) || input.snippets.length > MAX_SNIPPETS) fail('invalid store collections');
  const sessionIds = new Set();
  const snippetIds = new Set();
  const credentialIds = new Set();
  const rawCredentials = value(input, 'credentials', []);
  if (!Array.isArray(rawCredentials) || rawCredentials.length > MAX_CREDENTIALS) fail('invalid credential collection');
  const credentials = rawCredentials.map(item => {
    record(item, 'stored credential');
    const id = identifier(value(item, 'id', ''));
    if (credentialIds.has(id)) fail('duplicate credential id');
    credentialIds.add(id);
    const credential = { id, ...credentialFields(item), createdAt: timestamp(item.createdAt, 'createdAt'), updatedAt: timestamp(item.updatedAt, 'updatedAt') };
    if (own(item, 'passphraseEncrypted')) credential.passphraseEncrypted = cipher(item.passphraseEncrypted);
    return credential;
  });
  const sessions = input.sessions.map(item => {
    record(item, 'stored session');
    const id = identifier(value(item, 'id', ''));
    if (sessionIds.has(id)) fail('duplicate session id');
    sessionIds.add(id);
    const session = {
      id, ...sanitizeSession(item),
      createdAt: timestamp(value(item, 'createdAt'), 'createdAt'),
      updatedAt: timestamp(value(item, 'updatedAt'), 'updatedAt')
    };
    if (own(item, 'passphraseEncrypted')) {
      // Older stores had one flag for both kinds of secret.
      if (!own(item, 'rememberPassphrase') && item.rememberPassword === true) session.rememberPassphrase = true;
      if (!session.rememberPassphrase) fail('key passphrase requires rememberPassphrase');
      session.passphraseEncrypted = cipher(item.passphraseEncrypted);
    }
    return session;
  });
  validateJumps(sessions);
  validateCredentials(sessions, credentials);
  const snippets = input.snippets.map(item => {
    record(item, 'stored snippet');
    const id = identifier(value(item, 'id', ''));
    if (snippetIds.has(id)) fail('duplicate snippet id');
    snippetIds.add(id);
    return { id, ...sanitizeSnippet(item) };
  });
  record(input.knownHosts, 'knownHosts');
  const entries = Object.entries(input.knownHosts);
  if (entries.length > MAX_HOSTS) fail('too many known hosts');
  const knownHosts = Object.create(null);
  for (const [key, entry] of entries) {
    const normalized = hostKey(key);
    if (own(knownHosts, normalized)) fail('duplicate known host');
    knownHosts[normalized] = fingerprint(entry);
  }
  const folders = folderPaths([...folderPaths(value(input, 'folders', [])), ...sessions.map(item => item.folder)]);
  const loadedSettings = settings(value(input, 'settings', {}), DEFAULT_SETTINGS, { fromDisk: true });
  validateSharedCredentialBindings(loadedSettings.sharedCredentialBindings, credentials);
  return { version: VERSION, folders, sessions, credentials, snippets, settings: loadedSettings, knownHosts };
}

// Batch templates live in their own JSON document: a corrupt or oversized
// template list must never block loading sessions, snippets or credentials.
// Secrets (password/passphrase/enablePassword) are deliberately absent from this
// whitelist, so a template can never carry credentials to disk.
function sanitizeBatchTemplate(input, previous = {}) {
  record(input, 'batch template');
  const field = (key, fallback) => value(input, key, value(previous, key, fallback));
  const protocol = string(field('protocol', 'ssh'), '템플릿 프로토콜', 8, { empty: false });
  if (!['ssh', 'telnet'].includes(protocol)) fail('템플릿 프로토콜은 ssh 또는 telnet이어야 합니다.');
  const pagingMode = string(field('pagingMode', 'none'), '템플릿 페이지 출력 설정', 8, { empty: false });
  if (!['none', 'cisco', 'huawei'].includes(pagingMode)) fail('템플릿 페이지 출력 설정이 올바르지 않습니다.');
  const result = {
    name: string(field('name', ''), '템플릿 이름', 100, { empty: false }),
    commands: string(field('commands', ''), '템플릿 명령어', 65536, { trim: false, multiline: true }),
    protocol,
    port: integer(field('port', protocol === 'telnet' ? 23 : 22), '템플릿 포트', 1, 65535),
    credentialId: identifier(field('credentialId', ''), 'template credentialId', true),
    username: string(field('username', ''), '템플릿 사용자 이름', 256),
    targets: string(field('targets', ''), '템플릿 장비 IP 목록', 512 * 1024, { trim: false, multiline: true }),
    pagingMode,
    prompt: string(field('prompt', ''), '템플릿 완료 문구', 200),
    enableCommand: string(field('enableCommand', ''), '템플릿 권한 전환 명령', 256),
    timeoutMs: integer(field('timeoutMs', 30000), '템플릿 명령 제한 시간', 1000, 300000),
    connectTimeoutMs: integer(field('connectTimeoutMs', 30000), '템플릿 접속 제한 시간', 1000, 300000),
    quietMs: integer(field('quietMs', 400), '템플릿 출력 대기', 100, 10000),
    pager: boolean(field('pager', true), 'template pager')
  };
  if (/[\r\n]/.test(result.prompt)) fail('완료 문구는 한 줄로 입력해 주세요.');
  if (/[\r\n]/.test(result.enableCommand)) fail('권한 전환 명령은 한 줄로 입력해 주세요.');
  return result;
}

function loadBatchTemplates(input) {
  record(input, 'batch templates');
  if (value(input, 'version') !== BATCH_TEMPLATE_SCHEMA) fail('지원하지 않는 일괄 실행 템플릿 파일 버전입니다.');
  if (!Array.isArray(input.templates) || input.templates.length > MAX_BATCH_TEMPLATES) fail('일괄 실행 템플릿 목록이 올바르지 않습니다.');
  const ids = new Set();
  return input.templates.map(item => {
    record(item, 'stored batch template');
    const id = identifier(value(item, 'id', ''));
    if (ids.has(id)) fail('duplicate batch template id');
    ids.add(id);
    return {
      id, ...sanitizeBatchTemplate(item),
      createdAt: timestamp(value(item, 'createdAt'), 'createdAt'),
      updatedAt: timestamp(value(item, 'updatedAt'), 'updatedAt')
    };
  });
}

class SessionStore {
  #data;
  #serializedSessions = null;
  #encrypt;
  #decrypt;
  #revision = null;
  // Loaded lazily so a damaged template file cannot fail store startup; a null
  // value means "not read yet" and [] means "read, nothing stored".
  #batchTemplates = null;
  // SHA-256 of the template file as last read/written by this instance. Used as
  // the compare-and-swap token so a second window cannot silently overwrite a
  // template the first window just added.
  #templateRevision = null;

  constructor(root, { encrypt, decrypt } = {}) {
    this.root = path.resolve(string(root, 'store root', 4096, { empty: false }));
    this.filePath = path.join(this.root, 'session-store.json');
    this.templateFilePath = path.join(this.root, 'batch-templates.json');
    this.#encrypt = encrypt;
    this.#decrypt = decrypt;
    this.#data = initialData();
    let descriptor, removeLegacyPasswords = false;
    try {
      descriptor = fs.openSync(this.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail('store exceeds the size limit or is not a regular file');
      const bytes = fs.readFileSync(descriptor);
      if (bytes.length > MAX_FILE_BYTES) fail('store exceeds the size limit');
      const stored = JSON.parse(bytes.toString('utf8'));
      this.#data = loadData(stored);
      this.#revision = createHash('sha256').update(bytes).digest('hex');
      removeLegacyPasswords = [...stored.sessions, ...(stored.credentials || [])].some(item =>
        ['password', 'passwordEncrypted', 'rememberPassword', 'hasPassword'].some(key => own(item, key)));
    } catch (error) {
      if (error.code !== 'ENOENT' || descriptor !== undefined) {
        fail('세션 저장 파일을 읽지 못했습니다. 파일이 손상되었거나 지원하지 않는 형식입니다. 기존 파일은 변경하지 않았습니다.', 'ERR_STORE_LOAD');
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    // Scrub the active file with the existing atomic, revision-checked writer;
    // never decrypt a legacy device password or create a backup of the old file.
    if (removeLegacyPasswords) this.#commit(this.#data);
  }

  #checkRevision() {
    let descriptor, revision = null;
    try {
      try { descriptor = fs.openSync(this.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (descriptor !== undefined) {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid store');
        const hash = createHash('sha256'), block = Buffer.allocUnsafe(64 * 1024);
        let length = 0, count;
        while ((count = fs.readSync(descriptor, block, 0, Math.min(block.length, MAX_FILE_BYTES + 1 - length), null))) {
          length += count; if (length > MAX_FILE_BYTES) throw new Error('Store grew');
          hash.update(block.subarray(0, count));
        }
        revision = hash.digest('hex');
      }
      if (revision !== this.#revision) throw new Error('Store changed');
    } catch {
      fail('저장 파일이 다른 작업에서 변경되었거나 읽을 수 없습니다. 기존 파일은 보존했습니다. 앱을 다시 열어 최신 목록을 확인해 주세요.', 'ERR_STORE_CHANGED');
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }

  #commit(next) {
    const shortcutChange = next.settings.shortcuts !== this.#data.settings.shortcuts;
    if (shortcutChange || next.settings.keymap !== this.#data.settings.keymap || next.sessions !== this.#data.sessions) {
      let bindings;
      try { bindings = effectiveBindings(next.settings.shortcuts); }
      catch (error) { if (shortcutChange) throw error; /* unchanged invalid disk data stays inert */ }
      if (bindings && (shortcutChange || bindings.some(binding => !binding.isDefault))) {
        validateOverrides(next.settings.shortcuts, { sendTextKeys: bindings.some(binding => !binding.isDefault) ? collectSendTextKeys(next.settings.keymap, next.sessions) : [] });
      }
    }
    const sessionsJson = this.#serializedSessions?.sessions === next.sessions
      ? this.#serializedSessions.json : JSON.stringify(next.sessions);
    const json = serializeStoreWithSessions(next, sessionsJson);
    if (Buffer.byteLength(json) > MAX_FILE_BYTES) fail('store exceeds the size limit');
    this.#checkRevision();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, `.session-store-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, json, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      atomicRenameSync(temporary, this.filePath, { beforeRename: () => this.#checkRevision() });
      this.#revision = createHash('sha256').update(json).digest('hex');
      this.#data = next;
      this.#serializedSessions = sessionsJson.length <= MAX_CACHED_SESSIONS_CHARS
        ? { sessions: next.sessions, json: sessionsJson } : null;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  #findSession(id) {
    identifier(id);
    const session = this.#data.sessions.find(item => item.id === id);
    if (!session) fail('세션을 찾을 수 없습니다.', 'ERR_NOT_FOUND');
    return session;
  }

  listSessions() { return this.#data.sessions.map(publicSession); }

  // All credential APIs return metadata only. The injected safeStorage adapter
  // is synchronous: encrypt(plaintext)->base64, decrypt(base64)->plaintext.
  listCredentials() { return this.#data.credentials.map(publicCredential); }

  saveCredential(input) {
    record(input, 'credential');
    const requested = identifier(value(input, 'id', ''), 'credential id', true);
    const previous = requested ? this.#data.credentials.find(item => item.id === requested) : undefined;
    if (requested && !previous) fail('자격 증명을 찾을 수 없습니다.', 'ERR_NOT_FOUND');
    if (!previous && this.#data.credentials.length >= MAX_CREDENTIALS) fail('저장할 수 있는 자격 증명 수의 최대 한도에 도달했습니다.');
    const now = changedAt(previous?.updatedAt);
    const credential = { id: previous ? previous.id : randomUUID(), ...credentialFields(input, previous),
      createdAt: previous ? previous.createdAt : now, updatedAt: now };
    const clear = boolean(value(input, 'clearSecrets', false), 'clearSecrets');

    const password = value(input, 'password', '');
    if (typeof password !== 'string' || password.length > 16384 || password.includes('\0')) fail('password must be a bounded string');
    if (password) fail('공통 계정에는 비밀번호를 저장할 수 없습니다. 연결할 때 직접 입력해 주세요.');

    const clearPassphrase = boolean(value(input, 'clearPassphrase', false), 'clearPassphrase') || clear;
    const passphrase = value(input, 'passphrase', '');
    if (typeof passphrase !== 'string' || passphrase.length > 16384 || passphrase.includes('\0')) fail('passphrase must be a bounded string');
    if (clearPassphrase && passphrase) fail('같은 자격 증명 값을 동시에 저장하고 지울 수 없습니다.');
    if (!clearPassphrase && passphrase) {
      if (typeof this.#encrypt !== 'function') fail('Windows 자격 증명 암호화를 사용할 수 없습니다.', 'ERR_SECRET_ENCRYPTION');
      try { credential.passphraseEncrypted = cipher(this.#encrypt(passphrase)); }
      catch { fail('자격 증명을 암호화하지 못했습니다.', 'ERR_SECRET_ENCRYPTION'); }
    } else if (!clearPassphrase && previous?.passphraseEncrypted) credential.passphraseEncrypted = previous.passphraseEncrypted;
    const credentials = previous ? this.#data.credentials.map(item => item.id === credential.id ? credential : item) : [...this.#data.credentials, credential];
    this.#commit({ ...this.#data, credentials });
    return publicCredential(credential);
  }

  deleteCredential(id, { detach = false } = {}) {
    identifier(id, 'credential id');
    boolean(detach, 'detach');
    if (!this.#data.credentials.some(item => item.id === id)) return false;
    const referenced = this.#data.sessions.some(item => item.credentialId === id) ||
      Object.values(this.#data.settings.sharedCredentialBindings).includes(id);
    if (referenced && !detach) fail('이 자격 증명을 사용하는 로컬 세션 또는 공유 세션 연결이 있습니다. 연결을 해제한 뒤 다시 시도해 주세요.', 'ERR_CREDENTIAL_IN_USE');
    const sessions = this.#data.sessions.map(item => {
      if (item.credentialId !== id) return item;
      const { credentialId, ...session } = item;
      return { ...session, updatedAt: changedAt(item.updatedAt) };
    });
    const bindings = Object.fromEntries(Object.entries(this.#data.settings.sharedCredentialBindings).filter(([, credentialId]) => credentialId !== id));
    // Local references, shared bindings, and deletion share one replacement.
    // No profile secrets are copied into either sessions or settings on detach.
    this.#commit({ ...this.#data, sessions, settings: { ...this.#data.settings, sharedCredentialBindings: bindings },
      credentials: this.#data.credentials.filter(item => item.id !== id) });
    return true;
  }

  listFolders() { return folderPaths([...this.#data.folders, ...this.#data.sessions.map(item => item.folder)]); }

  planWindTermFolders() {
    const changes = []; let skippedCount = 0;
    for (const from of this.listFolders().filter(name => name.includes('>'))) {
      try { const to=folder(windTermFolder(from));if(to&&to!==from)changes.push({from,to}); }
      catch { skippedCount++; }
    }
    const paths=new Map(changes.map(item=>[item.from,item.to]));
    // Check the expanded folder limit before offering a plan; commit stays atomic.
    folderPaths(this.listFolders().map(name=>paths.get(name)||name));
    const sessions=this.#data.sessions.filter(item=>paths.has(item.folder));
    const revision=createHash('sha256').update(JSON.stringify([changes,sessions.map(item=>[item.id,item.folder])])).digest('hex');
    return {changes,sessionCount:sessions.length,skippedCount,revision};
  }

  repairWindTermFolders(revision) {
    const plan=this.planWindTermFolders();
    if(typeof revision!=='string'||revision!==plan.revision)fail('폴더 목록이 변경되었습니다. 정리 내용을 다시 확인해 주세요.');
    if(!plan.changes.length)return plan;
    const paths=new Map(plan.changes.map(item=>[item.from,item.to]));
    const sessions=this.#data.sessions.map(item=>paths.has(item.folder)?{...item,folder:paths.get(item.folder),updatedAt:changedAt(item.updatedAt)}:item);
    const folders=folderPaths(this.listFolders().map(name=>paths.get(name)||name));
    this.#commit({...this.#data,folders,sessions});return plan;
  }

  saveFolder(input) {
    record(input, 'folder');
    const parent = folder(value(input, 'parent', ''));
    const name = string(value(input, 'name', ''), '폴더 이름', 256, { empty: false });
    if (/[\\/]/.test(name) || name === '.' || name === '..') fail('폴더 이름에 /, \\ 또는 상대 경로를 사용할 수 없습니다.');
    const source = folder(value(input, 'path', ''));
    const destination = folder(parent ? `${parent}/${name}` : name);
    const folders = this.listFolders();
    if (parent && !folders.includes(parent)) fail('상위 폴더가 없습니다.', 'ERR_NOT_FOUND');
    if (source && !folders.includes(source)) fail('폴더가 없습니다.', 'ERR_NOT_FOUND');
    if (source === destination) return destination;
    if (source && insideFolder(destination, source)) fail('폴더를 자신의 하위 폴더로 이동할 수 없습니다.');
    if (folders.includes(destination)) fail('같은 이름의 폴더가 이미 있습니다.');
    const replace = path => source && insideFolder(path, source) ? destination + path.slice(source.length) : path;
    const nextFolders = folderPaths([...folders.map(replace), destination]);
    const sessions = this.#data.sessions.map(item => {
      const target = replace(item.folder);
      return target === item.folder ? item : { ...item, folder: target, updatedAt: changedAt(item.updatedAt) };
    });
    this.#commit({ ...this.#data, folders: nextFolders, sessions });
    return destination;
  }

  planFolderDeletion(input) {
    const target = folder(input);
    if (!target) fail('삭제할 폴더를 선택하세요.');
    if (target === '@shared' || target.startsWith('@shared/')) fail('공유 폴더는 읽기 전용입니다.', 'ERR_SHARED_READONLY');
    const folders = this.listFolders();
    if (!folders.includes(target)) return null;
    const descendants = folders.filter(item => insideFolder(item, target));
    const sessions = this.#data.sessions.filter(item => insideFolder(item.folder, target));
    const revision = createHash('sha256').update(JSON.stringify([target, descendants, sessions])).digest('hex');
    return { path: target, sessionCount: sessions.length, folderCount: descendants.length - 1, sessionIds: sessions.map(item => item.id), revision };
  }

  deleteFolder(input, revision) {
    const plan = this.planFolderDeletion(input);
    if (revision !== undefined && (typeof revision !== 'string' || revision !== plan?.revision)) fail('폴더 내용이 변경되었습니다. 삭제할 내용을 다시 확인해 주세요.', 'ERR_STALE_PLAN');
    if (!plan) return false;
    const ids = new Set(plan.sessionIds);
    const sessions = this.#data.sessions.filter(item => !ids.has(item.id)).map(item => ids.has(item.jumpSessionId) ? { ...item, jumpSessionId: '', updatedAt: changedAt(item.updatedAt) } : item);
    const folders = this.listFolders().filter(item => !insideFolder(item, plan.path));
    const layout = { ...this.#data.settings.layout, collapsedFolders: this.#data.settings.layout.collapsedFolders.filter(item => !insideFolder(item, plan.path)) };
    // Folder removal, contained sessions, and surviving jump references share
    // one atomic replacement. Failed writes leave memory and disk unchanged.
    this.#commit({ ...this.#data, folders, sessions, settings: { ...this.#data.settings, layout } });
    return true;
  }

  #selectedSessions(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_SESSIONS || new Set(ids).size !== ids.length) fail('세션 선택이 올바르지 않습니다.');
    if (ids.some(id => typeof id === 'string' && id.startsWith('shared_'))) fail('공유 세션은 읽기 전용입니다.', 'ERR_SHARED_READONLY');
    return ids.map(id => this.#findSession(id));
  }

  #sessionUpdatePlan(input) {
    record(input, 'session update');
    const selected = this.#selectedSessions(value(input, 'ids', []));
    const patch = record(value(input, 'patch'), 'session patch');
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !SESSION_PATCH_FIELDS.includes(key) || patch[key] === undefined)) fail('session patch contains an unsupported or empty field');
    const updates = new Map(selected.map(item => [item.id, { ...item, ...sanitizeSession(patch, item) }]));
    // sanitizeSession omits cleared credentialId. Spreading over the previous
    // record must not accidentally restore the old reference.
    if (own(patch, 'credentialId') && patch.credentialId === '') for (const item of updates.values()) delete item.credentialId;
    const sessions = this.#data.sessions.map(item => updates.get(item.id) || item);
    validateJumps(sessions);
    validateCredentials(sessions, this.#data.credentials);
    const references = new Set([...selected, ...updates.values()].map(item => item.credentialId).filter(Boolean));
    const revision = createHash('sha256').update(JSON.stringify([
      selected, [...updates.values()], this.#data.credentials.filter(item => references.has(item.id))
    ])).digest('hex');
    return { selected, updates, sessions, revision };
  }

  // Optional preview: apply exactly these ids/patch with revision to reject a
  // stale preview, including profile edits with unchanged session.updatedAt.
  planSessionUpdates(input) {
    const { selected, revision } = this.#sessionUpdatePlan(input);
    return { ids: selected.map(item => item.id), patch: structuredClone(input.patch), count: selected.length, revision };
  }

  // updateSessions({ids, patch, revision?, expectedUpdatedAt?: {[id]: ISO}})
  // returns redacted sessions in requested order. Every check precedes writing.
  updateSessions(input) {
    const { selected, updates, sessions, revision } = this.#sessionUpdatePlan(input);
    if (own(input, 'revision') && (typeof input.revision !== 'string' || input.revision !== revision)) fail('세션 목록이 변경되었습니다. 변경 내용을 다시 확인해 주세요.', 'ERR_STALE_PLAN');
    if (own(input, 'expectedUpdatedAt')) {
      const expected = record(input.expectedUpdatedAt, 'expectedUpdatedAt');
      if (Object.keys(expected).length !== selected.length || selected.some(item => !own(expected, item.id))) fail('expectedUpdatedAt must cover exactly the selected sessions');
      for (const item of selected) {
        if (timestamp(expected[item.id], 'expectedUpdatedAt') !== item.updatedAt) fail('세션 목록이 변경되었습니다. 변경 내용을 다시 확인해 주세요.', 'ERR_STALE_PLAN');
      }
    }
    for (const item of updates.values()) item.updatedAt = changedAt(item.updatedAt);
    this.#commit({ ...this.#data, sessions });
    return selected.map(item => publicSession(updates.get(item.id)));
  }

  moveSessions(input) {
    record(input, 'session move');
    const selected = this.#selectedSessions(value(input, 'ids', []));
    const target = folder(value(input, 'folder', ''));
    const folders = this.listFolders();
    if (target && !folders.includes(target)) fail('대상 폴더가 없습니다.', 'ERR_NOT_FOUND');
    const ids = new Set(selected.map(item => item.id));
    const sessions = this.#data.sessions.map(item => ids.has(item.id) ? { ...item, folder: target, updatedAt: changedAt(item.updatedAt) } : item);
    this.#commit({ ...this.#data, folders, sessions });
    return sessions.filter(item => ids.has(item.id)).map(publicSession);
  }

  deleteSessions(input) {
    const selected = this.#selectedSessions(input), ids = new Set(selected.map(item => item.id));
    const sessions = this.#data.sessions.filter(item => !ids.has(item.id)).map(item => ids.has(item.jumpSessionId) ? { ...item, jumpSessionId: '', updatedAt: changedAt(item.updatedAt) } : item);
    this.#commit({ ...this.#data, folders: this.listFolders(), sessions });
    return selected.length;
  }

  saveSession(input) {
    record(input, 'session');
    const requested = identifier(value(input, 'id', ''), 'id', true);
    const previous = requested ? this.#findSession(requested) : undefined;
    if (!previous && this.#data.sessions.length >= MAX_SESSIONS) fail(`추가 후 로컬 세션 총 ${this.#data.sessions.length + 1}개는 최대 ${MAX_SESSIONS}개를 초과합니다. 현재 ${this.#data.sessions.length}개이며 추가 가능 ${Math.max(0, MAX_SESSIONS - this.#data.sessions.length)}개입니다.`);
    const now = changedAt(previous?.updatedAt);
    const session = { id: previous ? previous.id : randomUUID(), ...sanitizeSession(input, previous), createdAt: previous ? previous.createdAt : now, updatedAt: now };
    const clear = boolean(value(input, 'clearPassphrase', false), 'clearPassphrase') || boolean(value(input, 'clearSecrets', false), 'clearSecrets');
    if (session.rememberPassphrase && session.protocol === 'ssh') {
      const secret = value(input, 'passphrase', '');
      if (typeof secret !== 'string' || secret.length > 16384 || secret.includes('\0')) fail('passphrase must be a bounded string');
      if (!clear && session.authType === 'key' && secret) {
        if (typeof this.#encrypt !== 'function') fail('Windows 자격 증명 암호화를 사용할 수 없습니다.', 'ERR_SECRET_ENCRYPTION');
        try { session.passphraseEncrypted = cipher(this.#encrypt(secret)); } catch { fail('자격 증명을 암호화하지 못했습니다.', 'ERR_SECRET_ENCRYPTION'); }
      } else if (!clear && previous?.passphraseEncrypted) {
        session.passphraseEncrypted = previous.passphraseEncrypted;
      }
    }
    const sessions = previous ? this.#data.sessions.map(item => item.id === session.id ? session : item) : [...this.#data.sessions, session];
    validateJumps(sessions);
    validateCredentials(sessions, this.#data.credentials);
    const folders = folderPaths([...this.listFolders(), session.folder]);
    this.#commit({ ...this.#data, folders, sessions });
    return publicSession(session);
  }

  deleteSession(id) {
    identifier(id);
    if (!this.#data.sessions.some(item => item.id === id)) return false;
    const sessions = this.#data.sessions.filter(item => item.id !== id).map(item => item.jumpSessionId === id ? { ...item, jumpSessionId: '', updatedAt: changedAt(item.updatedAt) } : item);
    this.#commit({ ...this.#data, folders: this.listFolders(), sessions });
    return true;
  }

  getSessionForConnection(id) {
    const session = this.#findSession(id);
    return this.#resolveCredentials(publicSession(session), session.credentialId ? this.#findCredential(session.credentialId) : session, Boolean(session.credentialId));
  }

  #findCredential(id) {
    identifier(id, 'credential id');
    const credential = this.#data.credentials.find(item => item.id === id);
    if (!credential) fail('자격 증명을 찾을 수 없습니다.', 'ERR_NOT_FOUND');
    return credential;
  }

  // Internal connection-only API, never expose its result through metadata IPC.
  // The explicit ID is authoritative; a credentialId embedded in profile is
  // ignored. Callers must skip this API for Telnet and validate source ownership.
  resolveSessionWithCredential(profile, credentialId) {
    record(profile, 'connection profile');
    const result = sanitizeSession({ ...profile, credentialId: '' });
    if (result.protocol !== 'ssh') fail('자격 증명은 SSH 세션에서만 사용할 수 있습니다.');
    const credential = this.#findCredential(credentialId);
    for (const key of ['id', 'sharedSourceId', 'sourceSessionId']) {
      if (own(profile, key)) result[key] = identifier(profile[key], key);
    }
    if (own(profile, 'sharedSourceName')) result.sharedSourceName = string(profile.sharedSourceName, 'shared source name', 256, { empty: false });
    for (const key of ['createdAt', 'updatedAt']) if (own(profile, key)) result[key] = timestamp(profile[key], key);
    result.credentialId = credential.id;
    return this.#resolveCredentials(result, credential, true);
  }

  #resolveCredentials(profile, source, overrideAuthentication) {
    const result = { ...structuredClone(profile), passphrase: '' };
    if (overrideAuthentication) {
      // A reference chooses all profile authentication fields, including blanks.
      for (const key of ['username', 'authType', 'privateKeyPath', 'agentPath']) result[key] = source[key];
    }
    result.hasPassphrase = Boolean(source.passphraseEncrypted);
    if (result.protocol === 'ssh' && result.authType === 'key' && source.passphraseEncrypted) {
      if (typeof this.#decrypt !== 'function') fail('Windows 자격 증명 복호화를 사용할 수 없습니다.', 'ERR_SECRET_DECRYPTION');
      try {
        const secret = this.#decrypt(source.passphraseEncrypted);
        if (typeof secret !== 'string' || secret.length > 16384 || secret.includes('\0')) throw new Error();
        result.passphrase = secret;
      } catch { fail('저장된 자격 증명을 복호화하지 못했습니다.', 'ERR_SECRET_DECRYPTION'); }
    }
    return result;
  }

  listSnippets() { return this.#data.snippets.map(item => ({ ...item })); }

  saveSnippet(input) {
    record(input, 'snippet');
    const id = identifier(value(input, 'id', ''), 'snippet id', true);
    const previous = id ? this.#data.snippets.find(item => item.id === id) : undefined;
    if (id && !previous) fail('스니펫을 찾을 수 없습니다.', 'ERR_NOT_FOUND');
    if (!previous && this.#data.snippets.length >= MAX_SNIPPETS) fail('스니펫 수가 최대 한도에 도달했습니다.');
    const snippet = { id: previous ? previous.id : randomUUID(), ...sanitizeSnippet(input, previous) };
    const snippets = previous ? this.#data.snippets.map(item => item.id === id ? snippet : item) : [...this.#data.snippets, snippet];
    this.#commit({ ...this.#data, snippets });
    return { ...snippet };
  }

  deleteSnippet(id) {
    identifier(id, 'snippet id');
    if (!this.#data.snippets.some(item => item.id === id)) return false;
    this.#commit({ ...this.#data, snippets: this.#data.snippets.filter(item => item.id !== id) });
    return true;
  }

  // ---- Batch (bulk execution) checklist templates -------------------------
  // Stored in batch-templates.json so template edits never rewrite (or risk)
  // session-store.json and never move its revision hash.
  // Read the file and hash it in one pass. `revision` is the CAS token used at
  // rename time, exactly like the session store's `#checkRevision`.
  #loadTemplateFile() {
    let bytes = null, revision = null, descriptor;
    try {
      descriptor = fs.openSync(this.templateFilePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_BATCH_TEMPLATE_BYTES) fail('일괄 실행 템플릿 파일이 크기 제한을 초과했거나 일반 파일이 아닙니다.', 'ERR_TEMPLATE_LOAD');
      bytes = fs.readFileSync(descriptor);
      if (bytes.length > MAX_BATCH_TEMPLATE_BYTES) fail('일괄 실행 템플릿 파일이 너무 큽니다.', 'ERR_TEMPLATE_LOAD');
      revision = createHash('sha256').update(bytes).digest('hex');
    } catch (error) {
      if (error.code === 'ENOENT' && descriptor === undefined) return { templates: [], revision: EMPTY_TEMPLATE_REVISION };
      if (error.code === 'ERR_TEMPLATE_LOAD') throw error;
      fail('일괄 실행 템플릿 파일을 읽지 못했습니다. 기존 파일은 변경하지 않았습니다.', 'ERR_TEMPLATE_LOAD');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    let templates;
    try { templates = loadBatchTemplates(JSON.parse(bytes.toString('utf8'))); }
    catch { fail('일괄 실행 템플릿 파일을 읽지 못했습니다. 파일이 손상되었거나 지원하지 않는 형식입니다. 기존 파일은 변경하지 않았습니다.', 'ERR_TEMPLATE_LOAD'); }
    return { templates, revision };
  }

  // `fresh` re-reads the file: templates are a separate document that another
  // window/instance may have written since this process cached them, so a write
  // must always start from the current on-disk list.
  #readTemplates({ fresh = false } = {}) {
    if (this.#batchTemplates && !fresh) return this.#batchTemplates;
    const { templates, revision } = this.#loadTemplateFile();
    this.#batchTemplates = templates; this.#templateRevision = revision;
    return templates;
  }

  // Fail closed if the file changed between our read and the rename. Hash
  // comparison cannot close the last TOCTOU window against a rogue concurrent
  // writer, but it does stop ordinary two-window/two-instance lost updates.
  #checkTemplateRevision(expected) {
    const { revision } = this.#loadTemplateFile();
    if (revision !== expected) fail('일괄 실행 템플릿이 다른 창에서 변경되었습니다. 최신 목록을 다시 불러온 뒤 다시 저장해 주세요.', 'ERR_TEMPLATE_CHANGED');
  }

  #writeTemplates(templates, expectedRevision = this.#templateRevision) {
    // Same atomic discipline as the session store: bounded size, private temp
    // file, fsync, then rename. A crash leaves the previous file intact.
    const json = `${JSON.stringify({ version: BATCH_TEMPLATE_SCHEMA, templates }, null, 2)}\n`;
    if (Buffer.byteLength(json) > MAX_BATCH_TEMPLATE_BYTES) fail('일괄 실행 템플릿 저장 용량이 한도를 초과했습니다.');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, `.batch-templates-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, json, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      atomicRenameSync(temporary, this.templateFilePath, { beforeRename: () => this.#checkTemplateRevision(expectedRevision) });
      this.#batchTemplates = templates;
      this.#templateRevision = createHash('sha256').update(json).digest('hex');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return templates;
  }

  listBatchTemplates() { return this.#readTemplates({ fresh: true }).map(item => structuredClone(item)); }

  // Revision of the template document as this instance last saw it. Callers that
  // hold a long-lived snapshot (an open dialog) can pass it back to
  // save/delete so a concurrent edit is rejected instead of overwritten.
  batchTemplateRevision() { this.#readTemplates({ fresh: true }); return this.#templateRevision; }

  // One read that yields both the list and the revision it belongs to. The UI
  // must send that revision back with every save/delete; fetching them in two
  // calls could pair a list with a newer revision and silently reject a
  // legitimate save (or accept a stale one).
  batchTemplateSnapshot() {
    const templates = this.#readTemplates({ fresh: true });
    return { templates: templates.map(item => structuredClone(item)), revision: this.#templateRevision };
  }

  saveBatchTemplate(input) {
    record(input, 'batch template');
    const requested = identifier(value(input, 'id', ''), 'template id', true);
    // Optional compare-and-swap token from `batchTemplateRevision()`. A caller
    // that holds a snapshot must not overwrite another window's template edits.
    const expected = value(input, 'revision', undefined);
    // `null` is a *wrong* token, not "no token". The empty document has its own
    // `EMPTY_TEMPLATE_REVISION`, so a caller that sends null is holding a
    // snapshot it cannot prove — exactly the case that must fail closed.
    if (expected !== undefined && (typeof expected !== 'string' || expected.length > 128)) fail('템플릿 revision 값이 올바르지 않습니다. 최신 목록을 다시 불러온 뒤 다시 저장해 주세요.', 'ERR_TEMPLATE_CHANGED');
    // Always start from the on-disk list: another window may have added or
    // changed templates since this instance cached them, and building the next
    // document from a stale array would silently drop that work.
    const templates = this.#readTemplates({ fresh: true });
    // The fresh read just refreshed `#templateRevision` to the file's current
    // hash, so this compares the caller's snapshot against what is on disk now.
    const expectedRevision = this.#templateRevision;
    if (expected !== undefined && expected !== expectedRevision) fail('일괄 실행 템플릿이 다른 창에서 변경되었습니다. 최신 목록을 다시 불러온 뒤 다시 저장해 주세요.', 'ERR_TEMPLATE_CHANGED');
    const previous = requested ? templates.find(item => item.id === requested) : undefined;
    if (requested && !previous) fail('일괄 실행 템플릿을 찾을 수 없습니다.', 'ERR_NOT_FOUND');
    // Reuse an existing same-name template instead of duplicating it, so saving
    // the same checklist twice updates rather than silently piling up entries.
    // A partial update (id only) keeps the stored name.
    const name = string(value(input, 'name', previous?.name ?? ''), '템플릿 이름', 100, { empty: false });
    const named = templates.find(item => item.name === name);
    if (!requested && !named && templates.length >= MAX_BATCH_TEMPLATES) fail(`일괄 실행 템플릿은 최대 ${MAX_BATCH_TEMPLATES}개까지 저장할 수 있습니다.`);
    const target = previous || named;
    if (named && previous && named.id !== previous.id) fail('같은 이름의 일괄 실행 템플릿이 이미 있습니다.');
    const source = target ? { ...structuredClone(target), ...structuredClone(input), name } : { ...structuredClone(input), name };
    const now = changedAt(target?.updatedAt);
    const template = {
      id: target ? target.id : randomUUID(), ...sanitizeBatchTemplate(source, target),
      createdAt: target ? target.createdAt : now, updatedAt: now
    };
    const next = target ? templates.map(item => item.id === target.id ? template : item) : [...templates, template];
    this.#writeTemplates(next, expectedRevision);
    return structuredClone(template);
  }

  // `revision` is the same CAS token as save: a delete based on a stale snapshot
  // must not remove a template another window has just edited.
  deleteBatchTemplate(id, revision) {
    identifier(id, 'template id');
    if (revision !== undefined && (typeof revision !== 'string' || revision.length > 128)) fail('템플릿 revision 값이 올바르지 않습니다.', 'ERR_TEMPLATE_CHANGED');
    const templates = this.#readTemplates({ fresh: true });
    const expected = this.#templateRevision;
    if (revision !== undefined && revision !== expected) fail('일괄 실행 템플릿이 다른 창에서 변경되었습니다. 최신 목록을 다시 불러온 뒤 다시 삭제해 주세요.', 'ERR_TEMPLATE_CHANGED');
    if (!templates.some(item => item.id === id)) return false;
    this.#writeTemplates(templates.filter(item => item.id !== id), expected);
    return true;
  }

  getSettings() { return structuredClone(this.#data.settings); }
  saveSettings(input) {
    const next = settings(input, this.#data.settings);
    validateSharedCredentialBindings(next.sharedCredentialBindings, this.#data.credentials);
    this.#commit({ ...this.#data, settings: next });
    return structuredClone(next);
  }

  getKnownHost(key) { return this.#data.knownHosts[hostKey(key)] || null; }
  trustKnownHost(key, input, expectedFingerprint) {
    const normalized = hostKey(key);
    const entry = fingerprint(input);
    if (expectedFingerprint !== undefined) {
      const expected = expectedFingerprint === null ? null : fingerprint(expectedFingerprint);
      if ((this.#data.knownHosts[normalized] || null) !== expected) {
        throw Object.assign(new Error('확인 중 저장된 호스트 키가 바뀌었습니다. 다시 연결해 확인해 주세요.'), { code: 'HOST_KEY_CHANGED' });
      }
    }
    if (!own(this.#data.knownHosts, normalized) && Object.keys(this.#data.knownHosts).length >= MAX_HOSTS) fail('저장된 호스트 키 수가 최대 한도에 도달했습니다.');
    const knownHosts = Object.assign(Object.create(null), this.#data.knownHosts);
    knownHosts[normalized] = entry;
    this.#commit({ ...this.#data, knownHosts });
    return entry;
  }

  exportData() {
    // Trust decisions, preferences, and encrypted credentials are machine-local.
    const sessions = this.listSessions().map(item => {
      const metadata = { ...item, rememberPassword: false };
      delete metadata.rememberPassphrase;
      delete metadata.hasPassphrase;
      delete metadata.credentialId;
      return metadata;
    });
    return { version: VERSION, folders: this.listFolders(), sessions, snippets: this.listSnippets() };
  }

  importData(input) {
    const { next, importedSessions, importedSnippets } = prepareImport(input, this.#data);
    this.#commit(next);
    return { sessions: importedSessions.map(publicSession), snippets: importedSnippets.map(item => ({ ...item })) };
  }
}

module.exports = { SessionStore, sanitizeSession, normalizeHostKey: hostKey, SESSION_PATCH_FIELDS, MAX_FILE_BYTES, freshImportSize };
