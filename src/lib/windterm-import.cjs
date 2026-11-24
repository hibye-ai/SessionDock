'use strict';
const { TextDecoder } = require('node:util');
const { sanitizeSession } = require('./session-store.cjs');
const { parseConnectionAddress } = require('./connection-address.cjs');
const { normalizeTerminalEncoding } = require('./terminal-encoding.cjs');
const { windTermFolder } = require('./windterm-folders.cjs');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 5000;
const own = (object, key) => Object.hasOwn(object, key);
function invalid(message) { const error = new Error(message); error.code = 'ERR_WINDTERM_IMPORT'; throw error; }
function parseWindTermFile(input) {
  let text;
  if (typeof input === 'string') { if (Buffer.byteLength(input) > MAX_BYTES) invalid('WindTerm 설정 파일은 8MB 이하만 지원합니다.'); text = input; }
  else {
    if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) invalid('WindTerm 세션 파일을 선택해 주세요.');
    if (input.byteLength > MAX_BYTES) invalid('WindTerm 설정 파일은 8MB 이하만 지원합니다.');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { invalid('WindTerm 세션 파일은 UTF-8이어야 합니다.'); }
  }
  let data; try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { invalid('세션 설정 파일의 JSON 형식이 올바르지 않습니다.'); }
  return data;
}
function plain(input) { return input && typeof input === 'object' && !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input)); }
function active(value) { return value !== undefined && value !== null && value !== false && value !== 0 && value !== '' && !(typeof value === 'string' && /^(none|off|false|0)$/i.test(value)) && !(Array.isArray(value) && !value.length) && !(plain(value) && !Object.keys(value).length); }
function label(input, fallback) { return typeof input === 'string' && input.trim() ? input.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 256) : fallback; }

function importWindTermSessions(input) {
  const data = typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array ? parseWindTermFile(input) : input;
  if (!Array.isArray(data)) invalid('WindTerm의 user.sessions 또는 세션 JSON 배열을 선택해 주세요.');
  if (data.length > MAX_SESSIONS) invalid('WindTerm 세션은 한 번에 5,000개 이하만 가져올 수 있습니다.');
  const sessions = [], skipped = [], ids = new Set();
  for (let index = 0; index < data.length; index++) {
    const source = data[index], fallback = `항목 ${index + 1}`;
    if (!plain(source)) { skipped.push({ name: fallback, reason: '세션 항목 형식이 올바르지 않습니다.' }); continue; }
    const name = label(source['session.label'], fallback), protocol = typeof source['session.protocol'] === 'string' ? source['session.protocol'].toLowerCase() : '';
    if (!['ssh', 'ssh2', 'telnet'].includes(protocol)) { skipped.push({ name, reason: 'SSH 또는 Telnet 세션이 아닙니다.' }); continue; }
    try {
      const mappedProtocol = protocol === 'telnet' ? 'telnet' : 'ssh';
      const session = parseConnectionAddress(source['session.target'], mappedProtocol);
      if (session.protocol !== mappedProtocol) throw new Error('Protocol mismatch');
      const warnings = [];
      session.name = label(source['session.label'], session.host);
      if (own(source, 'session.port')) session.port = source['session.port'];
      if (own(source, 'session.group')) {
        if (typeof source['session.group'] !== 'string') throw new Error('Invalid folder');
        session.folder = windTermFolder(source['session.group']);
      }
      if (own(source, 'session.charset')) {
        try { session.encoding = normalizeTerminalEncoding(source['session.charset']); }
        catch { warnings.push('지원하지 않는 문자 인코딩은 UTF-8로 가져왔습니다. 세션 속성에서 확인해 주세요.'); }
      }
      if (own(source, 'session.term')) session.terminalType = source['session.term'];
      if (own(source, 'session.keepAlive')) session.keepaliveInterval = source['session.keepAlive'];
      if (own(source, 'window.caretStyle')) {
        if (['bar', 'block', 'underline'].includes(source['window.caretStyle'])) session.cursorStyle = source['window.caretStyle'];
        else warnings.push('커서 모양은 세션 속성에서 다시 지정해 주세요.');
      }
      if (own(source, 'window.scrollbackLimit')) {
        const limit = source['window.scrollbackLimit'];
        if (Number.isSafeInteger(limit) && limit >= 1000) { session.scrollback = Math.min(limit, 100000); if (limit > 100000) warnings.push('스크롤백 줄 수를 지원 범위인 100,000줄로 줄였습니다.'); }
        else warnings.push('스크롤백은 전체 설정의 기본값을 사용합니다.');
      }
      if (Object.entries(source).some(([key, value]) => /password|passphrase|autoLogin/i.test(key) && active(value))) warnings.push('저장된 비밀번호·자동 로그인은 가져오지 않았습니다. 연결할 때 다시 입력해 주세요.');
      if (Object.entries(source).some(([key, value]) => /proxy|jump|tunnel|forward/i.test(key) && !/proxyDns|proxyWorkingDirectory/i.test(key) && active(value))) warnings.push('프록시 또는 점프 서버·포트포워딩 설정은 세션 속성에서 접속 전에 확인해 주세요.');
      if (Object.entries(source).some(([key, value]) => /identity|privateKey|publicKeyFile/i.test(key) && active(value)) || source['ssh.authAgent'] === true) warnings.push('개인키·에이전트 인증은 세션 속성에서 다시 지정해 주세요.');
      if (Object.entries(source).some(([key, value]) => /script|trigger|autoExecution|startupCommand/i.test(key) && active(value))) warnings.push('스크립트·자동 실행·트리거는 가져오지 않았습니다.');
      if (active(source['session.logType'])) warnings.push('로그 저장 형식·경로는 전체 설정 또는 세션 속성에서 다시 설정해 주세요.');
      session.importWarnings = [...new Set(warnings)]; session.rememberPassword = false;
      const clean = sanitizeSession(session);
      if (typeof source['session.uuid'] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(source['session.uuid']) && !['__proto__', 'constructor', 'prototype'].includes(source['session.uuid'])) {
        if (ids.has(source['session.uuid'])) invalid('WindTerm 파일에 중복된 세션 ID가 있습니다.');
        clean.id = source['session.uuid']; ids.add(clean.id);
      }
      sessions.push(clean);
    } catch (error) {
      if (error.code === 'ERR_WINDTERM_IMPORT') throw error;
      // Never include source values or parser diagnostics: they may contain credentials.
      skipped.push({ name, reason: '주소·포트·폴더 또는 터미널 설정이 올바르지 않습니다.' });
    }
  }
  const warnings = ['WindTerm에 저장된 자격 증명과 호스트 키는 가져오지 않습니다. 처음 SSH로 접속할 때 서버 지문을 다시 확인합니다.', ...new Set(sessions.flatMap(session => session.importWarnings))];
  return { sessions, skipped, warnings };
}
module.exports = { parseWindTermFile, importWindTermSessions };
