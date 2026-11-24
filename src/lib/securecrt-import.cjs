'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { sanitizeSession } = require('./session-store.cjs');

const MAX_INI_BYTES = 2 * 1024 * 1024;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_SESSIONS = 5000;
const MAX_DEPTH = 32;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);

function invalid(message, code = 'ERR_SECURECRT_IMPORT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function decode(input, maximum) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > maximum) invalid('가져올 파일이 크기 제한을 초과했습니다.');
    return input.replace(/^\uFEFF/, '');
  }
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) invalid('가져올 파일 내용을 읽을 수 없습니다.');
  const bytes = Buffer.from(input);
  if (bytes.length > maximum) invalid('가져올 파일이 크기 제한을 초과했습니다.');
  let encoding = 'utf-8';
  let offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)); }
  catch { invalid('파일 인코딩을 읽을 수 없습니다. UTF-8 또는 BOM이 있는 UTF-16으로 저장해 주세요.'); }
}

// Only presence is retained for a saved credential. No password decoding or
// decryption is performed, and no credential values leave this parser.
function isSecret(key) { return /password|passphrase/i.test(key) && !/^(?:Save Password|Password Prompt|Password Authentication)$/i.test(key); }

function setOption(options, key, raw, type) {
  if (key.length > 256 || forbidden.has(key) || /[\x00-\x1f\x7f]/.test(key)) return;
  if (isSecret(key)) { options[key] = Boolean(raw.trim()); return; }
  if (typeof raw !== 'string' || raw.length > 32768 || raw.includes('\0')) invalid('세션 설정 값이 너무 길거나 허용되지 않는 문자(NUL)가 있습니다.');
  if (type === 'dword') {
    const text = raw.trim();
    // XML exports may use decimal DWORDs or explicit/padded hexadecimal DWORDs.
    if (/^(?:0x[0-9a-fA-F]{1,8}|[0-9a-fA-F]{8})$/.test(text)) options[key] = Number.parseInt(text.replace(/^0x/i, ''), 16);
    else if (/^\d{1,10}$/.test(text) && Number(text) <= 0xffffffff) options[key] = Number(text);
    else invalid('XML 세션 설정의 DWORD 값이 올바르지 않습니다.');
  } else if (type === 'D') {
    // SecureCRT .ini DWORD values are hexadecimal, including digit-only values.
    if (!/^(?:0x)?[a-fA-F0-9]{1,8}$/.test(raw.trim())) invalid('세션 설정의 16진수 값이 올바르지 않습니다.');
    options[key] = Number.parseInt(raw.trim().replace(/^0x/i, ''), 16);
  } else if (type === 'B' || type === 'binary') {
    // Binary option data is not an application setting we can safely map.
    return;
  } else {
    options[key] = raw;
  }
}

function parseIni(input) {
  const text = decode(input, MAX_INI_BYTES);
  if (text.includes('\0')) invalid('세션 파일에 허용되지 않는 문자(NUL)가 있습니다.');
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 20000) invalid('세션 파일의 줄 수가 너무 많습니다.');
  const options = Object.create(null);
  for (const line of lines) {
    const match = /^\s*([SDB]):"([^"\r\n]+)"\s*=(.*)$/.exec(line);
    if (match) setOption(options, match[2], match[3], match[1]);
  }
  return options;
}

function lookup(options, names, fallback = '') {
  for (const name of names) if (own(options, name)) return options[name];
  return fallback;
}

function enabled(input) { return input === true || (typeof input === 'number' && input !== 0) || /^(?:true|yes|1)$/i.test(String(input)); }

function safeLabel(input) {
  return String(input).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256);
}

function resolveKeyReference(input, configPath) {
  if (typeof input !== 'string' || !configPath) return input;
  const match = /^\$\{VDS_CONFIG_PATH\}[\\/]+(.+)$/i.exec(input);
  if (!match || /\$\{|%[^%]+%/.test(match[1]) || /^[A-Za-z]:/.test(match[1]) || /^[\\/]/.test(match[1])) return input;
  const candidate = path.resolve(configPath, match[1].replace(/[\\/]/g, path.sep));
  const relative = path.relative(configPath, candidate);
  // This is metadata substitution only. Never open, inspect, or copy a key.
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return input;
  return candidate;
}

function toSession(options, name, folder, configPath) {
  const protocol = /^telnet$/i.test(lookup(options, ['Protocol Name'])) ? 'telnet' : 'ssh';
  const warnings = [];
  const notes = ['Imported from SecureCRT.'];
  const keyReference = ['Identity Filename V2', 'Identity Filename', 'Public Key Filename']
    .map(key => lookup(options, [key])).find(reference => typeof reference === 'string' && reference.trim()) || '';
  const privateKeyPath = resolveKeyReference(keyReference, configPath);
  const authList = lookup(options, ['Auth List', '[SSH2] Auth List', 'Authentication Methods']);
  const preferences = typeof authList === 'string' ? authList.split(/[,;\s]+/).filter(Boolean) : [];
  let authType = privateKeyPath ? 'key' : 'password';
  for (const method of preferences) {
    if (/^(?:publickey|public-key)$/i.test(method)) { authType = 'key'; break; }
    if (/^(?:password|keyboard-interactive)$/i.test(method)) { authType = 'password'; break; }
    if (/^(?:agent|ssh-agent)$/i.test(method)) { authType = 'agent'; break; }
  }
  if (preferences.length) {
    notes.push(`Authentication preference: ${safeLabel(authList)}.`);
    if (preferences.some(method => !/^(?:publickey|public-key|password|keyboard-interactive|agent|ssh-agent)$/i.test(method))) warnings.push('지원하지 않는 인증 방식은 가져오지 않았습니다.');
  }
  if (authType === 'key' && !privateKeyPath) warnings.push('공개키 인증을 사용하려면 개인키 파일을 선택해 주세요.');
  if (typeof privateKeyPath === 'string' && /\$\{|%[^%]+%/.test(privateKeyPath)) warnings.push('개인키 경로에 SecureCRT 변수나 환경 변수가 있습니다. 연결 전에 이 PC의 키 파일을 선택해 주세요.');
  if (Object.keys(options).some(key => isSecret(key) && options[key])) warnings.push('저장된 비밀번호나 암호가 있었지만 자격 증명은 가져오지 않았습니다.');

  for (const key of ['Firewall Name', 'Firewall', 'Proxy Name', 'Proxy', 'Jump Session', 'Jump Session Name', 'SSH2 Jump Session', 'SSH2 Jump Host', 'Jump Host', '[SSH2] Jump Session']) {
    const reference = lookup(options, [key]);
    if (reference && !/^(?:none|direct|0)$/i.test(String(reference))) {
      notes.push(`${key} reference: ${safeLabel(reference)}.`);
      warnings.push('방화벽/프록시/점프 설정은 가져오지 않았습니다. SSH 점프 세션으로 직접 설정해 주세요.');
    }
  }
  if (lookup(options, ['Firewall Type', 'Proxy Type'], 0)) warnings.push('방화벽/프록시/점프 설정은 가져오지 않았습니다. SSH 점프 세션으로 직접 설정해 주세요.');
  if (enabled(lookup(options, ['Use Script File', 'Use Logon Script', 'Run Script On Connect'], 0)) ||
      lookup(options, ['Script Filename', 'Script File', 'Logon Script', 'Logon Script Filename']) ||
      enabled(lookup(options, ['Use Logon Sequence', 'Logon Sequence'], 0))) warnings.push('로그온 스크립트와 자동 로그온 절차는 가져오거나 실행하지 않았습니다.');

  const utf8 = lookup(options, ['Use UTF-8', 'UTF-8', 'UTF8', 'Use UTF8', 'UTF-8 Encoding'], null);
  const encoding = lookup(options, ['Character Encoding', 'Encoding', 'Code Page', 'Character Set'], null);
  if ((utf8 !== null && !enabled(utf8)) ||
      (encoding !== null && !/^(?:utf-?8|65001)$/i.test(String(encoding)))) warnings.push('UTF-8이 아닌 터미널 인코딩은 가져오지 않았습니다. 이 세션은 UTF-8을 사용합니다.');
  const useTerminalType = lookup(options, ['Use Terminal Type'], null);
  const terminal = useTerminalType !== null && !enabled(useTerminalType) ? 'xterm-256color' : lookup(options, ['Terminal Type'], 'xterm-256color');
  const terminalType = typeof terminal === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(terminal) ? terminal : 'xterm-256color';
  if (terminalType !== terminal) warnings.push('지원하지 않는 터미널 종류를 xterm-256color로 바꿨습니다.');
  const keepaliveEnabled = lookup(options, ['Send Protocol NO-OP', '[SSH2] Keep Alive', 'Keep Alive'], null);
  const keepalive = lookup(options, ['NO-OP Interval', 'Keep Alive Interval', '[SSH2] Keep Alive Interval'], 30);
  if (lookup(options, ['Log Filename V2', 'Log Filename', 'Log File'])) warnings.push('SecureCRT 로그 파일 이름은 가져오지 않았습니다. 로그는 앱의 로그 폴더에 저장됩니다.');
  const session = sanitizeSession({
    name, folder, protocol,
    host: lookup(options, ['Hostname']),
    port: lookup(options, protocol === 'telnet' ? ['[Telnet] Port', 'Port'] : ['[SSH2] Port', 'Port'], protocol === 'telnet' ? 23 : 22),
    username: lookup(options, ['Username']),
    authType, privateKeyPath,
    rememberPassword: false,
    tags: ['SecureCRT'],
    notes: notes.join('\n'),
    terminalType,
    keepaliveInterval: keepaliveEnabled !== null && !enabled(keepaliveEnabled) ? 0 : keepalive,
    logEnabled: enabled(lookup(options, ['Log Session', 'Start Log Upon Connect'], 0)),
    jumpSessionId: '', forwards: [], importWarnings: [...new Set(warnings)]
  });
  return session;
}

function addSession(result, options, name, folder, configPath) {
  const protocol = safeLabel(lookup(options, ['Protocol Name']));
  if (!/^(?:SSH2|Telnet)$/i.test(protocol)) {
    result.skipped.push({ name, protocol, reason: 'SSH2와 Telnet 세션만 지원합니다.' });
    return;
  }
  if (result.sessions.length >= MAX_SESSIONS) invalid('가져올 세션 수가 제한을 초과했습니다.', 'ERR_IMPORT_LIMIT');
  try {
    const session = toSession(options, name, folder, configPath);
    result.sessions.push(session);
    for (const warning of session.importWarnings) result.warnings.push(`${folder ? `${folder}/` : ''}${name}: ${warning}`);
  } catch (error) {
    if (error.code !== 'ERR_VALIDATION') throw error;
    result.skipped.push({ name, protocol, reason: `세션 정보가 올바르지 않습니다: ${error.message}` });
  }
}

function noSymlinkAncestors(directory) {
  let current = directory;
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) invalid('심볼릭 링크 폴더에서는 가져올 수 없습니다.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function importSecureCrtDirectory(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || /[\x00-\x1f]/.test(input)) invalid('SecureCRT의 Config 또는 Sessions 폴더를 선택해 주세요.');
  let directory = path.resolve(input);
  noSymlinkAncestors(directory);
  if (!fs.lstatSync(directory).isDirectory()) invalid('가져올 경로는 폴더여야 합니다.');
  const configPath = path.basename(directory).toLowerCase() === 'sessions' ? path.dirname(directory) : directory;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const sessionsDirectory = entries.find(entry => entry.name.toLowerCase() === 'sessions');
  if (path.basename(directory).toLowerCase() !== 'sessions' && sessionsDirectory) {
    if (sessionsDirectory.isSymbolicLink()) invalid('Sessions 폴더는 심볼릭 링크일 수 없습니다.');
    directory = path.join(directory, sessionsDirectory.name);
    if (!fs.lstatSync(directory).isDirectory()) invalid('Sessions 경로가 폴더가 아닙니다.');
  }
  const result = { sessions: [], skipped: [], warnings: [] };
  let entryCount = 0;
  let totalBytes = 0;
  function visit(current, depth) {
    if (depth > MAX_DEPTH) invalid('폴더 깊이가 가져오기 제한을 초과했습니다.');
    const children = fs.readdirSync(current, { withFileTypes: true });
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of children) {
      if (++entryCount > MAX_ENTRIES) invalid('폴더 안의 항목이 너무 많습니다.');
      const filename = path.join(current, entry.name);
      const relative = path.relative(directory, filename).split(path.sep).join('/');
      if (entry.isSymbolicLink() || fs.lstatSync(filename).isSymbolicLink()) {
        result.warnings.push(`${safeLabel(relative)}: 심볼릭 링크라서 건너뛰었습니다.`);
        continue;
      }
      if (entry.isDirectory()) { visit(filename, depth + 1); continue; }
      if (!entry.isFile() || !/\.ini$/i.test(entry.name) || /^(?:Default|__FolderData__)\.ini$/i.test(entry.name)) continue;
      const name = safeLabel(entry.name.slice(0, -4));
      const folder = path.relative(directory, current).split(path.sep).join('/');
      let descriptor;
      try {
        descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) invalid('세션 항목이 일반 파일이 아닙니다.');
        if (stat.size > MAX_INI_BYTES) invalid('세션 파일이 크기 제한을 초과했습니다.');
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) invalid('가져올 파일의 전체 크기가 제한을 초과했습니다.', 'ERR_IMPORT_LIMIT');
        const options = parseIni(fs.readFileSync(descriptor));
        addSession(result, options, name, folder, configPath);
      } catch (error) {
        if (error.code === 'ERR_IMPORT_LIMIT') throw error;
        // Do not expose parser messages or source data that may contain secrets.
        result.skipped.push({ name, protocol: '', reason: '세션 파일을 읽을 수 없거나 형식이 올바르지 않거나 가져오기 제한을 초과했습니다.' });
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }
  }
  visit(directory, 0);
  return result;
}

function importSecureCrtXml(input) {
  const text = decode(input, MAX_XML_BYTES);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFE\uFFFF\p{Cs}]/u.test(text)) invalid('XML 파일에 허용되지 않는 문자가 있습니다.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) invalid('DTD나 엔터티 선언이 있는 XML은 지원하지 않습니다.');
  let SaxesParser;
  try { ({ SaxesParser } = require('saxes')); } catch { invalid('XML 가져오기에 필요한 구성 요소(saxes)를 찾을 수 없습니다.', 'ERR_XML_DEPENDENCY'); }
  const parser = new SaxesParser({ xmlns: true });
  const result = { sessions: [], skipped: [], warnings: [] };
  const stack = [];
  let nodes = 0;
  let roots = 0;
  let sessionsRoots = 0;
  let rootName = '';
  let attributes;
  function attribute(tag, name) { return own(tag.attributes, name) ? tag.attributes[name].value : ''; }
  parser.on('error', () => { invalid('XML 형식이 올바르지 않습니다.'); });
  parser.on('doctype', () => { invalid('DTD가 있는 XML은 지원하지 않습니다.'); });
  parser.on('opentagstart', () => { attributes = new Set(); });
  parser.on('attribute', attribute => {
    if (attributes.has(attribute.name) || forbidden.has(attribute.name)) invalid('XML에 중복되거나 잘못된 속성이 있습니다.');
    attributes.add(attribute.name);
    if (attributes.size > 32 || attribute.value.length > 4096) invalid('XML 속성 개수나 크기가 제한을 초과했습니다.');
  });
  parser.on('processinginstruction', () => { invalid('XML 처리 명령은 지원하지 않습니다.'); });
  parser.on('opentag', tag => {
    if (++nodes > 100000 || stack.length > MAX_DEPTH) invalid('XML 깊이나 항목 수가 제한을 초과했습니다.');
    if (Object.keys(tag.attributes).length > 32) invalid('XML 요소의 속성이 너무 많습니다.');
    for (const key of Object.keys(tag.attributes)) {
      if (tag.attributes[key].value.length > 4096) invalid('XML 속성 값이 크기 제한을 초과했습니다.');
    }
    if (tag.uri) invalid('XML 네임스페이스는 지원하지 않습니다.');
    if (!stack.length) { roots++; rootName = tag.name; }
    const parent = stack[stack.length - 1];
    const name = attribute(tag, 'name');
    const sessionsRoot = tag.name === 'key' && name === 'Sessions' && parent && parent.tag === 'VanDyke';
    if (sessionsRoot) sessionsRoots++;
    const active = Boolean(sessionsRoot || (parent && parent.active));
    const node = { tag: tag.name, name, type: attribute(tag, 'type'), active, sessionsRoot, options: Object.create(null), text: '', folders: [], hasKeys: false };
    if (parent) {
      node.folders = parent.folders;
      if (tag.name === 'key' && parent.active && parent.tag === 'key') {
        parent.hasKeys = true;
        node.folders = parent.sessionsRoot ? [] : [...parent.folders, parent.name];
      }
      if (parent.active && ['string', 'dword', 'value', 'binary'].includes(parent.tag)) invalid('XML 설정 값 안에 다른 요소를 넣을 수 없습니다.');
    }
    stack.push(node);
  });
  function append(raw) {
    const node = stack[stack.length - 1];
    if (!node) {
      if (raw.trim()) invalid('XML 최상위 요소 밖에 텍스트가 있습니다.');
      return;
    }
    // Saved passwords and all Global/License entries are intentionally discarded.
    if (!node.active || isSecret(node.name)) {
      if (node.active && isSecret(node.name) && raw.trim()) node.secretPresent = true;
      return;
    }
    if (node.text.length + raw.length > 32768) invalid('XML 설정 값이 크기 제한을 초과했습니다.');
    node.text += raw;
  }
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    const node = stack.pop();
    const parent = stack[stack.length - 1];
    if (parent && parent.active && parent.tag === 'key' && ['string', 'dword', 'binary', 'value'].includes(node.tag)) {
      if (isSecret(node.name)) {
        if (node.name.length <= 256 && !forbidden.has(node.name)) parent.options[node.name] = Boolean(node.secretPresent);
      } else {
        const type = node.tag === 'value' ? node.type.toLowerCase() : node.tag;
        if (['string', 'dword', 'binary', 'S', 'D', 'B'].includes(type)) setOption(parent.options, node.name, node.text, type);
      }
    }
    if (node.tag === 'key' && node.active && !node.sessionsRoot &&
        (own(node.options, 'Protocol Name') || !node.hasKeys)) {
      if (/^(?:Default|__FolderData__)(?:\.ini)?$/i.test(node.name)) return;
      const name = node.name.replace(/\.ini$/i, '');
      if (!name || name.length > 256 || /[\x00-\x1f\x7f/\\]/.test(name) || forbidden.has(name)) invalid('XML 세션 이름이 올바르지 않습니다.');
      addSession(result, node.options, name, node.folders.join('/'));
    }
  });
  try {
    // The source size is bounded above; option text and attributes have smaller
    // independent limits. No DTD or external entity resolver is ever installed.
    for (let offset = 0; offset < text.length; offset += 4096) parser.write(text.slice(offset, offset + 4096));
    parser.close();
  } catch (error) {
    if (['ERR_SECURECRT_IMPORT', 'ERR_XML_DEPENDENCY', 'ERR_IMPORT_LIMIT'].includes(error.code)) throw error;
    invalid('XML 형식이 올바르지 않습니다.');
  }
  if (roots !== 1 || rootName !== 'VanDyke' || sessionsRoots !== 1) invalid('Sessions 키가 있는 SecureCRT(VanDyke) XML 내보내기 파일을 하나 선택해 주세요.');
  return result;
}

module.exports = { parseIni, importSecureCrtDirectory, importSecureCrtXml };
