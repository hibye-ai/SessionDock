'use strict';

const iconv = require('iconv-lite');
const { TextDecoder } = require('node:util');
const { sanitizeSession } = require('./session-store.cjs');
const { normalizeTerminalEncoding } = require('./terminal-encoding.cjs');
const {
  PUTTY_REGISTRY_KEY,
  readPuttyRegistryRaw
} = require('./putty-registry.cjs');

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_SESSIONS = 5000;
const MAX_RECORDS = 15000;
const MAX_LINES = 1000000;
const MAX_VALUES_PER_SESSION = 256;
const MAX_KEY_LENGTH = 2048;
const MAX_VALUE_LENGTH = 32768;
const MAX_SESSION_NAME_LENGTH = 1024;
const MAX_TEXT_LENGTH = 256;
const MAX_WARNINGS_PER_SESSION = 64;
const MAX_WARNING_LENGTH = 2048;
const MAX_SUMMARY_WARNINGS = 20;
const MAX_FOLDER_DEPTH = 32;
const MAX_FOLDERS = 10000;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const SAFE_NAME_CONTROL = /[\x00-\x1f\x7f]/;

const STRING_KEYS = new Set([
  'HostName', 'UserName', 'Protocol', 'TerminalType', 'LineCodePage',
  'ProxyUsername', 'ProxyTelnetCommand', 'RemoteCommand'
]);
const DWORD_KEYS = new Set([
  'PortNumber', 'SshProt', 'PingInterval', 'PingIntervalSecs',
  'BackspaceIsDelete', 'TryAgent', 'AgentFwd', 'ProxyMethod',
  'ProxyType', 'ProxySOCKSVersion', 'GroupCollapse'
]);
const PRESENCE_KEYS = new Set([
  'PublicKeyFile', 'DetachedCertificate', 'AuthPlugin', 'GSSCustom',
  'Password', 'ProxyPassword', 'PortForwardings', 'SSHManualHostKeys'
]);

// Only these settings can affect the session emitted to the store. All other
// registry values are ignored before they become parser state.
const ALLOWED_KEYS = new Set([...STRING_KEYS, ...DWORD_KEYS, ...PRESENCE_KEYS]);
const CANONICAL_KEYS = new Map([...ALLOWED_KEYS].map(key => [key.toLowerCase(), key]));

const WARNING = Object.freeze({
  KEY: '개인키 또는 인증서 설정은 가져오지 않았습니다. 연결 전에 인증 방식을 다시 설정해 주세요.',
  KEY_PRESENT: 'PuTTY 개인키/인증서 설정이 저장되어 있었지만 경로는 가져오지 않았습니다. 연결 전에 인증을 다시 설정해 주세요.',
  AGENT: 'SSH 에이전트 전달 설정은 가져오지 않았습니다.',
  PASSWORD: 'PuTTY에 저장된 비밀번호는 가져오지 않았습니다.',
  HOST_KEYS: 'PuTTY의 SSH 호스트 키 신뢰 정보는 가져오지 않았습니다. 첫 연결 시 호스트 키를 확인해 주세요.',
  PROXY: 'PuTTY 프록시/점프 설정은 가져오지 않았습니다. 그대로 연결하면 프록시 없이 직접 접속하므로 연결 전에 접속 경로를 다시 설정해 주세요.',
  TUNNELS: 'PuTTY 포트 포워딩 설정은 가져오지 않았습니다.',
  REMOTE_COMMAND: 'PuTTY 원격 명령 설정은 가져오지 않았습니다.',
  ENVIRONMENT: 'PuTTY 환경 변수 설정은 가져오지 않았습니다.',
  UNSUPPORTED: 'PuTTY의 일부 고급 설정은 가져오지 않았습니다.',
  ENCODING: 'PuTTY 문자 인코딩 설정을 확인할 수 없어 UTF-8로 가져왔습니다. 연결 후 인코딩을 확인해 주세요.'
});

function invalid(message, code = 'ERR_PUTTY_IMPORT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function setOwn(object, key, value) {
  if (FORBIDDEN.has(key)) return;
  Object.defineProperty(object, key, {
    value, enumerable: true, configurable: true, writable: true
  });
}

function decodeText(bytes, encoding, label, maximum = MAX_INPUT_BYTES) {
  if (bytes.length > maximum) invalid(`PuTTY ${label}의 크기가 제한을 초과했습니다.`, 'ERR_PUTTY_IMPORT_LIMIT');
  let decoded;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    invalid(`PuTTY ${label} 인코딩이 올바르지 않습니다.`, 'ERR_PUTTY_IMPORT_ENCODING');
  }
  return decoded.replace(/^\uFEFF/, '');
}

function decodeRegBytes(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
      invalid('PuTTY .reg 파일이 20 MiB 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
    }
    return input.replace(/^\uFEFF/, '');
  }
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    invalid('PuTTY .reg 입력은 문자열 또는 바이트 버퍼여야 합니다.');
  }
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_INPUT_BYTES) {
    invalid('PuTTY .reg 파일이 20 MiB 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeText(bytes.subarray(2), 'utf-16le', 'UTF-16LE .reg');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    invalid('PuTTY .reg UTF-16BE 인코딩은 지원하지 않습니다. UTF-16LE 또는 UTF-8로 저장해 주세요.', 'ERR_PUTTY_IMPORT_ENCODING');
  }
  if (bytes.length >= 4 &&
      ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) ||
       (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff))) {
    invalid('PuTTY .reg UTF-32 인코딩은 지원하지 않습니다. UTF-16LE 또는 UTF-8로 저장해 주세요.', 'ERR_PUTTY_IMPORT_ENCODING');
  }
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return decodeText(bytes.subarray(offset), 'utf-8', 'UTF-8 .reg');
}

function countLines(text) {
  let lines = 0;
  // newline is a line terminator; a final unterminated line is handled below.
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lines++;
      if (lines > MAX_LINES) invalid('PuTTY .reg 파일의 줄 수가 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
    }
  }
  if (text && text.charCodeAt(text.length - 1) !== 10 && ++lines > MAX_LINES) {
    invalid('PuTTY .reg 파일의 줄 수가 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
  }
  return lines;
}

function splitLines(text) {
  countLines(text);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function isHeader(line) {
  return /^Windows Registry Editor Version \d+\.\d+(?:\s*)$/i.test(line);
}

function registryKeyLine(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  return trimmed.slice(1, -1);
}

function parseRootLeaf(key) {
  if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) return null;
  const normalized = key.replace(/^HKEY_CURRENT_USER/i, 'HKCU');
  if (!normalized.toUpperCase().startsWith(PUTTY_REGISTRY_KEY.toUpperCase() + '\\')) {
    if (normalized.length <= PUTTY_REGISTRY_KEY.length + 200 &&
        /^HKCU\\Software\\SimonTatham\\PuTTY/i.test(normalized)) return { invalid: true };
    return null;
  }
  const remainder = normalized.slice(PUTTY_REGISTRY_KEY.length + 1);
  if (!remainder || remainder.includes('\\') || remainder.length > MAX_SESSION_NAME_LENGTH) {
    return null;
  }
  return { name: remainder };
}

function canonicalRegistryKey(key) {
  if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^HKEY_CURRENT_USER(?=\\)/i, 'HKCU').toUpperCase();
}

// Ordinal comparison must not merge distinct names through expanding mappings
// such as ß -> SS. Keep the original character when uppercase expands it.
function registryLeafIdentity(name) {
  return Array.from(name, char => {
    const upper = char.toUpperCase();
    return upper.length === char.length ? upper : char;
  }).join('');
}

function deletionAffectsSessionSubtree(key) {
  const candidate = canonicalRegistryKey(key);
  if (!candidate) return false;
  const root = PUTTY_REGISTRY_KEY.toUpperCase();
  return candidate === root || candidate.startsWith(root + '\\') ||
    root.startsWith(candidate + '\\');
}

function decodePercentName(name) {
  if (typeof name !== 'string' || !name) return null;
  const bytes = [];
  for (let index = 0; index < name.length; index++) {
    const char = name[index];
    if (char === '%' && index + 2 < name.length && /^[0-9a-fA-F]{2}$/.test(name.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(name.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const point = name.codePointAt(index);
      const encoded = iconv.encode(String.fromCodePoint(point), 'utf8');
      if (point > 0xffff) index++;
      bytes.push(...encoded);
    }
  }
  if (bytes.length > MAX_SESSION_NAME_LENGTH) return null;
  try {
    return decodeText(Buffer.from(bytes), 'utf-8', '세션 이름', MAX_SESSION_NAME_LENGTH);
  } catch (error) {
    // Old PuTTY builds may have percent-escaped non-ASCII characters in the
    // Windows code page. Korean Windows users commonly produced CP949 bytes.
    // Use a strict CP949 round trip rather than allowing replacement text.
    try {
      const decoded = iconv.decode(Buffer.from(bytes), 'cp949');
      if (decoded && !decoded.includes('\uFFFD') &&
          Buffer.compare(iconv.encode(decoded, 'cp949'), Buffer.from(bytes)) === 0) return decoded;
    } catch {}
    return null;
  }
}

function parseQuotedValue(text, start) {
  let output = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') return { value: output, next: index + 1 };
    if (char === '\\') {
      const next = text[index + 1];
      if (next === '\\' || next === '"') {
        output += next;
        index += 2;
        continue;
      }
    }
    output += char;
    index++;
    if (output.length > MAX_VALUE_LENGTH) invalid('PuTTY 레지스트리 값이 길이 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
  }
  invalid('PuTTY .reg 문자열 값의 따옴표가 닫히지 않았습니다.');
}

function parseDword(text) {
  const value = text.trim();
  if (!/^dword:/i.test(value)) return undefined;
  const digits = value.slice(6).trim();
  if (!/^[0-9a-fA-F]{1,8}$/.test(digits)) invalid('PuTTY DWORD 값 형식이 올바르지 않습니다.');
  return Number.parseInt(digits, 16);
}

function parseValueLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('"')) {
    // A bare @=... default value is not part of PuTTY's session schema.
    return { ignored: true };
  }
  const name = parseQuotedValue(trimmed, 0);
  const keyName = CANONICAL_KEYS.get(name.value.toLowerCase());
  if (trimmed[name.next] !== '=') return { malformed: true, name: keyName };
  const raw = trimmed.slice(name.next + 1).trim();
  if (!raw) return { malformed: true, name: keyName };
  if (raw === '-') return { deleted: true, name: keyName };
  if (raw.startsWith('"')) {
    const value = parseQuotedValue(raw, 0);
    if (raw.slice(value.next).trim()) return { malformed: true, name: keyName };
    return { name: keyName, type: 'string', value: value.value };
  }
  const dword = parseDword(raw);
  if (dword !== undefined) return { name: keyName, type: 'dword', value: dword };
  if (/^hex(?:\([^)]*\))?:/i.test(raw)) {
    // Multiline REG_BINARY and malformed hex records carry no usable value.
    // Mark required connection settings invalid; tolerate optional records.
    return { name: keyName, type: 'unsupported' };
  }
  return { malformed: true, name: keyName };
}

function safeKeyName(name) {
  return typeof name === 'string' && name.length <= 256 && !FORBIDDEN.has(name) && !SAFE_NAME_CONTROL.test(name);
}

function safeString(value, maximum = MAX_TEXT_LENGTH) {
  return typeof value === 'string' && value.length <= maximum && !SAFE_NAME_CONTROL.test(value);
}

function hasNonEmptyPresence(value) {
  return value === true || (typeof value === 'string' && value.length > 0);
}

function importRecord(record, decodedName, folder = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { skipped: { name: '', reason: '세션 레코드 형식이 올바르지 않습니다.' } };
  }
  const rawName = record.name;
  if (typeof rawName !== 'string' || !rawName || rawName.length > MAX_KEY_LENGTH) {
    return { skipped: { name: '', reason: '세션 이름 형식이 올바르지 않습니다.' } };
  }
  const name = decodedName === undefined ? decodePercentName(rawName) : decodedName;
  if (!name || !name.trim() || name.length > MAX_SESSION_NAME_LENGTH || SAFE_NAME_CONTROL.test(name)) {
    return { skipped: { name: '', reason: '세션 이름을 안전하게 해석할 수 없습니다.' } };
  }
  if (!folder && name === 'Default Settings') return { skipped: { name, reason: '기본 설정 템플릿은 세션으로 가져오지 않습니다.' } };
  if (!record.values || typeof record.values !== 'object' || Array.isArray(record.values)) {
    return { skipped: { name, reason: '세션 값 형식이 올바르지 않습니다.' } };
  }
  const source = record.values;
  const get = key => hasOwn(source, key) ? source[key] : undefined;

  const host = get('HostName');
  if (!safeString(host, 253) || !host.trim()) {
    return { skipped: { name, reason: '호스트 이름이 없거나 지원하지 않는 형식입니다.' } };
  }
  if (/^\s|\s$/.test(host) || /[\u0000-\u0020\u007f]/.test(host)) {
    return { skipped: { name, reason: '호스트 이름에 공백이나 제어 문자가 있습니다.' } };
  }

  const protocol = get('Protocol');
  if (protocol !== 'ssh' && protocol !== 'telnet') {
    return { skipped: { name, reason: protocol === undefined
      ? 'PuTTY Protocol 값이 명시되어 있지 않습니다.'
      : 'SSH 또는 Telnet 프로토콜만 지원합니다.' } };
  }

  let port = protocol === 'telnet' ? 23 : 22;
  if (hasOwn(source, 'PortNumber')) {
    const rawPort = get('PortNumber');
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      return { skipped: { name, reason: '포트 번호가 1부터 65535 사이의 정수가 아닙니다.' } };
    }
    port = rawPort;
  }

  if (protocol === 'ssh') {
    const rawSsh = get('SshProt');
    if (rawSsh !== undefined && ![0, 1, 2, 3].includes(rawSsh)) {
      return { skipped: { name, reason: 'PuTTY SSH 프로토콜 값이 올바르지 않습니다.' } };
    }
    if (rawSsh === 0) return { skipped: { name, reason: 'SSH-1 전용 PuTTY 세션은 지원하지 않습니다.' } };
  }

  const warnings = new Set();
  const addPresence = (key, warning) => {
    const present = get(key);
    if (hasNonEmptyPresence(present)) warnings.add(warning);
    else if (present !== undefined && typeof present !== 'boolean' && typeof present !== 'string') {
      warnings.add(WARNING.UNSUPPORTED);
    }
  };

  if (hasNonEmptyPresence(get('PublicKeyFile'))) warnings.add(WARNING.KEY_PRESENT);
  if (hasNonEmptyPresence(get('DetachedCertificate')) ||
      hasNonEmptyPresence(get('AuthPlugin')) ||
      hasNonEmptyPresence(get('GSSCustom'))) warnings.add(WARNING.KEY);
  if (get('AgentFwd') === 1 || get('AgentFwd') === true) warnings.add(WARNING.AGENT);
  addPresence('Password', WARNING.PASSWORD);
  addPresence('SSHManualHostKeys', WARNING.HOST_KEYS);
  addPresence('PortForwardings', WARNING.TUNNELS);
  addPresence('RemoteCommand', WARNING.REMOTE_COMMAND);

  let proxy = false;
  if (hasOwn(source, 'ProxyMethod')) {
    const method = get('ProxyMethod');
    if (!Number.isInteger(method) || method < 0 || method > 8) return { skipped: { name, reason: 'PuTTY 프록시 종류 값이 올바르지 않습니다.' } };
    proxy = method !== 0;
  } else if (hasOwn(source, 'ProxyType')) {
    const type = get('ProxyType');
    if (!Number.isInteger(type) || type < 0 || type > 4) return { skipped: { name, reason: 'PuTTY 프록시 종류 값이 올바르지 않습니다.' } };
    proxy = type !== 0;
  }
  if (proxy) warnings.add(WARNING.PROXY);

  let keepalive = 0;
  for (const key of ['PingInterval', 'PingIntervalSecs']) {
    if (!hasOwn(source, key)) continue;
    const value = get(key);
    if (!Number.isInteger(value) || value < 0) return { skipped: { name, reason: 'PuTTY keepalive 시간 값이 올바르지 않습니다.' } };
    keepalive += value * (key === 'PingInterval' ? 60 : 1);
  }
  if (keepalive > 86400) return { skipped: { name, reason: 'PuTTY keepalive 시간이 지원 범위를 초과합니다.' } };

  let backspace = 'del';
  if (hasOwn(source, 'BackspaceIsDelete')) {
    const value = get('BackspaceIsDelete');
    if (value !== 0 && value !== 1 && value !== true && value !== false) {
      return { skipped: { name, reason: 'PuTTY 백스페이스 설정이 올바르지 않습니다.' } };
    }
    backspace = value === 0 || value === false ? 'bs' : 'del';
  }

  let terminalType = 'xterm';
  if (hasOwn(source, 'TerminalType')) {
    const value = get('TerminalType');
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(value)) {
      return { skipped: { name, reason: 'PuTTY 터미널 종류가 지원하지 않는 형식입니다.' } };
    }
    terminalType = value;
  }

  let encoding = 'utf-8';
  if (hasOwn(source, 'LineCodePage')) {
    const codePage = get('LineCodePage');
    if (typeof codePage !== 'string' || !codePage) {
      warnings.add(WARNING.ENCODING);
    } else {
      try { encoding = normalizeTerminalEncoding(codePage); }
      catch { warnings.add(WARNING.ENCODING); }
    }
  }

  const username = get('UserName');
  if (username !== undefined && (typeof username !== 'string' || username.length > 256 || /[\x00-\x1f\x7f]/.test(username))) {
    return { skipped: { name, reason: 'PuTTY 사용자 이름이 지원하지 않는 형식입니다.' } };
  }

  // TryAgent=true is PuTTY's default. SessionDock keeps password as the
  // interactive default and never forces agent authentication for every
  // imported profile. Key/agent material remains an explicit user decision.
  try {
    const session = sanitizeSession({
      name,
      folder,
      host,
      protocol,
      port,
      telnetEnter: protocol === 'telnet' ? 'cr' : 'crlf',
      username: username || '',
      authType: 'password',
      privateKeyPath: '',
      agentPath: '',
      rememberPassword: false,
      tags: ['PuTTY'],
      terminalType,
      encoding,
      keepaliveInterval: keepalive,
      backspace,
      jumpSessionId: '',
      forwards: [],
      importWarnings: [...warnings].slice(0, MAX_WARNINGS_PER_SESSION)
    });
    return { session };
  } catch {
    return { skipped: { name, reason: 'PuTTY 세션 설정을 SessionDock 세션으로 변환할 수 없습니다.' } };
  }
}

function uniqueSkipped(result, skipped) {
  if (!skipped) return;
  if (result.skipped.length >= MAX_RECORDS) invalid('건너뛴 PuTTY 항목 수가 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
  result.skipped.push(skipped);
}

function safeDisplayName(decoded, raw, index) {
  const source = typeof decoded === 'string' && decoded ? decoded : (typeof raw === 'string' ? raw : '');
  let escaped = '';
  for (const char of source) {
    const part = /[\x00-\x1f\x7f-\x9f]/.test(char) ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char;
    if (escaped.length + part.length > 256) { escaped += '…'; break; }
    escaped += part;
  }
  return escaped.trim() ? escaped : `항목 ${index + 1}`;
}

function addSummaryWarning(result, warning) {
  if (typeof warning !== 'string' || !warning) return;
  if (result.warnings.length >= MAX_SUMMARY_WARNINGS) return;
  const bounded = warning.slice(0, MAX_WARNING_LENGTH);
  if (!result.warnings.includes(bounded)) result.warnings.push(bounded);
}

function importPuttySessions(records, options = {}) {
  if (!Array.isArray(records)) invalid('PuTTY 세션 목록은 배열이어야 합니다.');
  if (records.length > MAX_RECORDS) invalid(`PuTTY 항목은 최대 ${MAX_RECORDS}개까지 가져올 수 있습니다.`, 'ERR_PUTTY_IMPORT_LIMIT');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid('PuTTY 가져오기 옵션이 올바르지 않습니다.');
  const result = { sessions: [], folders: [], skipped: [], warnings: [] };
  if (options.truncated === true) addSummaryWarning(result, 'PuTTY 레지스트리에서 처음 15,000개 항목만 읽었습니다.');
  // A trailing # is the ND group marker. Decode once before looking for it,
  // then use only those explicit prefixes as evidence for child hierarchy.
  const names = records.map(record => typeof record?.name === 'string' && record.name.length <= MAX_KEY_LENGTH ? decodePercentName(record.name) : null);
  const components = name => name.split('#').filter(Boolean);
  const markers = new Set(names.filter(name => name && name.endsWith('#'))
    .map(name => components(name)).filter(parts => parts.length).map(parts => JSON.stringify(parts)));
  const folders = new Set();
  const safePart = part => {
    if (!part || part.length > 256 || /[\/\\\x00-\x1f\x7f]/.test(part)) return false;
    const trimmed = part.trim();
    return !!trimmed && trimmed !== '.' && trimmed !== '..';
  };
  const parsePath = (name, group) => {
    const parts = components(group ? name.slice(0, -1) : name);
    const folderParts = group ? parts : parts.slice(0, -1);
    if (folderParts.length > MAX_FOLDER_DEPTH || !folderParts.every(safePart) || folderParts.join('/').length > 1024 || (!group && !parts.length)) return null;
    return { parts: folderParts, leaf: group ? '' : parts.at(-1) };
  };
  const isHierarchical = (name, group) => {
    if (group) return true;
    if (!name) return false;
    const parts = components(name);
    for (let pos = 1; pos < parts.length; pos++) {
      if (markers.has(JSON.stringify(parts.slice(0, pos)))) return true;
    }
    return false;
  };
  // Reserve names for every raw parent before assigning aliases, including
  // implicit folders and names appearing later in the input.
  const siblings = new Map();
  for (const name of names) {
    const group = !!name && name.endsWith('#');
    if (!isHierarchical(name, group)) continue;
    const parsed = parsePath(name, group);
    if (!parsed) continue;
    const parent = [];
    for (const part of parsed.parts) {
      const parentKey = JSON.stringify(parent);
      if (!siblings.has(parentKey)) siblings.set(parentKey, new Set());
      siblings.get(parentKey).add(part);
      parent.push(part);
    }
  }
  const mappings = new Map();
  for (const [parent, namesForParent] of siblings) {
    const reserved = new Set([...namesForParent].map(name => name.trim()));
    const used = new Set(), mapped = new Map(), nextSuffix = new Map();
    const ordered = [...namesForParent].sort((a, b) => {
      const canonical = Number(b === b.trim()) - Number(a === a.trim());
      return canonical || (a < b ? -1 : a > b ? 1 : 0);
    });
    for (const raw of ordered) {
      const base = raw.trim();
      let candidate = base;
      if (used.has(candidate)) {
        let number = nextSuffix.get(base) || 2;
        do {
          const suffix = ` (${number++})`;
          let prefix = base.slice(0, 256 - suffix.length);
          if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
          candidate = prefix.trimEnd() + suffix;
        } while (reserved.has(candidate) || used.has(candidate));
        nextSuffix.set(base, number);
      }
      used.add(candidate);
      mapped.set(raw, candidate);
    }
    mappings.set(parent, mapped);
  }
  const renamedFolders = new Set();
  const addFolders = (parts, rawParts) => {
    let current = '';
    const rawParent = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], raw = rawParts[i];
      current = current ? current + '/' + part : part;
      folders.add(current);
      if (folders.size > MAX_FOLDERS) invalid('PuTTY 폴더 수가 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
      rawParent.push(raw);
      if (part !== raw.trim()) renamedFolders.add(JSON.stringify(rawParent));
    }
  };
  let sessionRecords = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index], name = names[index];
    const group = !!name && name.endsWith('#');
    const hierarchical = isHierarchical(name, group);
    if (!group && name && !hierarchical && name.includes('#')) addSummaryWarning(result, '그룹 표시가 없는 # 이름은 원래 세션 이름으로 가져왔습니다.');
    if (!group && ++sessionRecords > MAX_SESSIONS) invalid('PuTTY 세션은 최대 5000개까지 가져올 수 있습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
    if (hierarchical) {
      const path = parsePath(name, group);
      if (!path) { uniqueSkipped(result, { name: safeDisplayName(name, record?.name, index), reason: 'PuTTY ND 폴더 경로가 올바르지 않습니다.' }); continue; }
      const rawParent = [];
      const mappedParts = path.parts.map(part => {
        const mapped = mappings.get(JSON.stringify(rawParent)).get(part);
        rawParent.push(part);
        return mapped;
      });
      const mappedPath = mappedParts.join('/');
      if (mappedParts.length > MAX_FOLDER_DEPTH || mappedPath.length > 1024 || !mappedParts.every(safePart)) {
        uniqueSkipped(result, { name: safeDisplayName(name, record?.name, index), reason: 'PuTTY ND 폴더 경로가 올바르지 않습니다.' }); continue;
      }
      if (group) { addFolders(mappedParts, path.parts); continue; }
      const imported = importRecord(record, path.leaf, mappedPath);
      if (imported.session) {
        addFolders(mappedParts, path.parts);
        result.sessions.push(imported.session);
        for (const warning of imported.session.importWarnings) addSummaryWarning(result, warning);
      } else {
        if (imported.skipped && !imported.skipped.name) imported.skipped.name = safeDisplayName(name, record?.name, index);
        uniqueSkipped(result, imported.skipped);
      }
      continue;
    }
    const imported = importRecord(record, name);
    if (imported.session) {
      result.sessions.push(imported.session);
      for (const warning of imported.session.importWarnings) {
        addSummaryWarning(result, warning);
      }
      continue;
    }
    if (imported.skipped && !imported.skipped.name) imported.skipped.name = safeDisplayName(name, record?.name, index);
    uniqueSkipped(result, imported.skipped);
  }
  // Reserve all original names before allocating suffixes, including later records.
  const key = (folder, name) => JSON.stringify([folder, name]);
  const reserved = new Set(result.sessions.map(session => key(session.folder, session.name)));
  const used = new Set(), nextSuffix = new Map();
  let renamed = 0;
  for (const session of result.sessions) {
    const original = key(session.folder, session.name);
    if (!used.has(original)) { used.add(original); continue; }
    let number = nextSuffix.get(original) || 2, candidate;
    do {
      const suffix = ` (${number++})`;
      let prefix = session.name.slice(0, 256 - suffix.length);
      if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
      candidate = prefix.trimEnd() + suffix;
    } while (reserved.has(key(session.folder, candidate)) || used.has(key(session.folder, candidate)));
    nextSuffix.set(original, number);
    session.name = candidate; used.add(key(session.folder, candidate)); renamed++;
  }
  if (renamed) {
    const warning = `이름이 겹친 세션 ${renamed}개에 번호를 붙여 모두 가져왔습니다.`;
    result.warnings = [warning, ...result.warnings].slice(0, MAX_SUMMARY_WARNINGS);
  }
  if (renamedFolders.size) {
    const warning = `이름이 겹친 폴더 ${renamedFolders.size}개에 번호를 붙여 모두 가져왔습니다.`;
    result.warnings = [warning, ...result.warnings].slice(0, MAX_SUMMARY_WARNINGS);
  }
  result.folders = [...folders];
  return result;
}

function parseRegSections(text) {
  const lines = splitLines(text);
  let headerSeen = false;
  let deleted = false;
  const sections = new Map();
  const sectionOrder = [];
  let current = null;
  for (const sourceLine of lines) {
    const line = sourceLine.trim();
    if (!line) continue;
    if (!headerSeen && isHeader(line)) { headerSeen = true; continue; }
    if (!headerSeen) {
      if (/^Windows Registry Editor/i.test(line)) invalid('PuTTY .reg 헤더가 올바르지 않습니다.');
      continue;
    }
    const keyBody = registryKeyLine(line);
    if (keyBody !== null) {
      current = null;
      if (keyBody.startsWith('-')) {
        const removed = keyBody.slice(1);
        if (deletionAffectsSessionSubtree(removed)) deleted = true;
        continue;
      }
      if (/^hex/i.test(keyBody)) continue;
      const parsed = parseRootLeaf(keyBody);
      if (!parsed || parsed.invalid) continue;
      const identity = registryLeafIdentity(parsed.name);
      current = sections.get(identity);
      if (!current) {
        if (sections.size >= MAX_RECORDS) {
          invalid(`PuTTY 항목은 최대 ${MAX_RECORDS}개까지 가져올 수 있습니다.`, 'ERR_PUTTY_IMPORT_LIMIT');
        }
        current = Object.create(null);
        setOwn(current, 'name', parsed.name);
        setOwn(current, 'values', Object.create(null));
        setOwn(current, 'valueCount', 0);
        sections.set(identity, current);
        sectionOrder.push(current);
      }
      continue;
    }
    if (!current) continue;
    const parsedValue = parseValueLine(line);
    if (parsedValue.malformed) {
      // A malformed value is relevant only when its value name is required.
      // The parser never retains the rest of a malformed, potentially secret
      // record. If it is a required key, let the mapper skip the session.
      if (parsedValue.name) setOwn(current.values, parsedValue.name, Object.freeze({ invalid: true }));
      continue;
    }
    if (parsedValue.ignored) continue;
    if (parsedValue.deleted) {
      if (safeKeyName(parsedValue.name) && ALLOWED_KEYS.has(parsedValue.name)) deleted = true;
      continue;
    }
    if (!safeKeyName(parsedValue.name) || !ALLOWED_KEYS.has(parsedValue.name)) {
      continue;
    }
    if (current.valueCount >= MAX_VALUES_PER_SESSION) invalid('PuTTY 세션의 값 개수가 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
    current.valueCount++;
    setOwn(current.values, parsedValue.name, parsedValue.type === 'unsupported' ? Object.freeze({ invalid: true }) : parsedValue.value);
  }
  if (!headerSeen) invalid('PuTTY .reg 파일이 아닙니다. Windows Registry Editor 헤더를 확인해 주세요.');
  if (deleted) invalid('PuTTY .reg 파일에 삭제 항목이 있어 가져오지 않았습니다. 삭제 항목을 빼고 다시 내보내 주세요.', 'ERR_PUTTY_REG_DELETE');
  return sectionOrder;
}

function normalizeRegSource(source) {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && typeof source.data === 'string') return source.data;
  if (source && typeof source === 'object' && source.data instanceof Uint8Array) return source.data;
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) return source;
  invalid('PuTTY .reg 입력은 문자열 또는 바이트 버퍼여야 합니다.');
}

function importPuttyReg(bytes) {
  // Keep the public boundary synchronous. The registry reader is deliberately
  // a promise-only API and is never started by .reg parsing.
  const source = normalizeRegSource(bytes);
  const text = typeof source === 'string' ? source.replace(/^\uFEFF/, '') : decodeRegBytes(source);
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) invalid('PuTTY .reg 파일이 20 MiB 제한을 초과했습니다.', 'ERR_PUTTY_IMPORT_LIMIT');
  const sections = parseRegSections(text);
  return importPuttySessions(sections.map(section => ({ name: section.name, values: section.values })));
}

async function readPuttyRegistry(options = {}) {
  const raw = await readPuttyRegistryRaw(options);
  const result = importPuttySessions(raw.records, { truncated: raw.truncated });
  for (const warning of raw.warnings) addSummaryWarning(result, warning);
  return result;
}

module.exports = {
  importPuttyReg,
  importPuttySessions,
  readPuttyRegistry,
  readPuttyRegistryRaw,
  PUTTY_REGISTRY_KEY,
  READER_SCRIPT: require('./putty-registry.cjs').READER_SCRIPT,
  READER_ARGS: require('./putty-registry.cjs').READER_ARGS,
  READER_OPTIONS: require('./putty-registry.cjs').READER_OPTIONS
};
