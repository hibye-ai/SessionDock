'use strict';

/**
 * src/lib/shortcut-keys.cjs
 *
 * 1단계: 설정 가능한 단축키(Windows Electron SSH/Telnet) 문자열/이벤트 유틸리티.
 *
 * - 보조키 표준 순서: Ctrl+Alt+Shift (입력 순서와 무관하게 정규화)
 * - 키 식별: KeyboardEvent.code (물리 키). 예: KeyN, Digit7, F4, NumpadEnter
 * - 입력 별칭: a~z, 0~9, [ ] = -, Esc, Return, Control
 * - 단일 스트로크 최대 60자, 시퀀스 최대 120자/2단계, 구분자는 리터럴 ' then '
 * - 임의의 입력 문자열을 객체 프로퍼티/프로토타입 조회에 사용하지 않는다(Map/Set만 사용).
 */

const STROKE_MAX_LENGTH = 60;
const SEQUENCE_MAX_LENGTH = 120;
const SEQUENCE_SEPARATOR = ' then ';
const DISPLAY_SEPARATOR = ' → ';
const TOKEN_SEPARATOR = '+';

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'];

const MODIFIER_ALIASES = new Map([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
]);

const UNSUPPORTED_MODIFIER_ALIASES = new Set([
  'meta',
  'win',
  'windows',
  'super',
  'cmd',
  'command',
  'altgraph',
]);

const KEY_NAME_ALIASES = new Map([
  ['esc', 'Escape'],
  ['return', 'Enter'],
]);

const CHARACTER_ALIASES = new Map([
  ['[', 'BracketLeft'],
  [']', 'BracketRight'],
  ['=', 'Equal'],
  ['-', 'Minus'],
]);

const DISPLAY_KEY_ALIASES = new Map([
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Equal', '='],
  ['Minus', '-'],
  ['Escape', 'Esc'],
]);

const MENU_MNEMONIC_KEYS = new Set([
  'KeyF',
  'KeyE',
  'KeyV',
  'KeyC',
  'KeyT',
  'KeyH',
]);

const MNEMONIC_PREFIX_STROKE = 'Alt+KeyW';
const MNEMONIC_CONTINUATION_STROKES = new Set(['Alt+KeyV', 'Alt+KeyH']);

const EVENT_BLOCKED_CODES = new Set(['Compose', 'Dead', 'Process', 'Unidentified']);

const EVENT_MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
]);

/**
 * 지원하는 물리 키 코드(KeyboardEvent.code) 목록을 만든다.
 * @returns {string[]}
 */
function buildSupportedKeyCodes() {
  const codes = [];

  for (let index = 0; index < 26; index += 1) {
    codes.push('Key' + String.fromCharCode(65 + index));
  }
  for (let digit = 0; digit <= 9; digit += 1) {
    codes.push('Digit' + digit);
  }
  for (let fn = 1; fn <= 24; fn += 1) {
    codes.push('F' + fn);
  }

  codes.push(
    'Tab',
    'Enter',
    'NumpadEnter',
    'Escape',
    'Space',
    'Backspace',
    'Delete',
    'Insert',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'BracketLeft',
    'BracketRight',
    'Backslash',
    'Semicolon',
    'Quote',
    'Backquote',
    'Comma',
    'Period',
    'Slash',
    'Minus',
    'Equal',
  );

  for (let numpad = 0; numpad <= 9; numpad += 1) {
    codes.push('Numpad' + numpad);
  }

  codes.push(
    'NumpadAdd',
    'NumpadSubtract',
    'NumpadMultiply',
    'NumpadDivide',
    'NumpadDecimal',
  );

  return codes;
}

const SUPPORTED_KEY_CODES = new Set(buildSupportedKeyCodes());

const KEY_CODE_LOOKUP = (() => {
  const lookup = new Map();
  for (const code of SUPPORTED_KEY_CODES) {
    lookup.set(code.toLowerCase(), code);
  }
  return lookup;
})();

/**
 * 키 토큰을 표준 KeyboardEvent.code로 변환한다.
 * 실패하면 null을 반환한다.
 * @param {string} token
 * @returns {string|null}
 */
function resolveKeyToken(token) {
  if (token.length === 1) {
    if (/^[a-z]$/i.test(token)) {
      return 'Key' + token.toUpperCase();
    }
    if (/^[0-9]$/.test(token)) {
      return 'Digit' + token;
    }
    const punctuation = CHARACTER_ALIASES.get(token);
    return punctuation === undefined ? null : punctuation;
  }

  const lower = token.toLowerCase();
  const alias = KEY_NAME_ALIASES.get(lower);
  if (alias !== undefined) {
    return alias;
  }

  const known = KEY_CODE_LOOKUP.get(lower);
  return known === undefined ? null : known;
}

/**
 * 단축키 스트로크 문자열을 정규화한다.
 * 보조키는 Ctrl+Alt+Shift 순서로 정렬한 뒤 물리 키 코드를 붙인다.
 * @param {string} value 예: 'ctrl + N', 'alt+7', 'Ctrl+Shift+='
 * @returns {string} 예: 'Ctrl+KeyN', 'Alt+Digit7', 'Ctrl+Shift+Equal'
 */
function normalizeStroke(value) {
  if (typeof value !== 'string') {
    throw new Error('단축키는 문자열이어야 합니다.');
  }
  if (value.length > STROKE_MAX_LENGTH) {
    throw new Error('단축키가 너무 깁니다. 최대 ' + STROKE_MAX_LENGTH + '자까지 허용됩니다.');
  }

  const input = value.trim();
  if (input.length === 0) {
    throw new Error('단축키가 비어 있습니다.');
  }
  if (input.length > STROKE_MAX_LENGTH) {
    throw new Error('단축키가 너무 깁니다. 최대 ' + STROKE_MAX_LENGTH + '자까지 허용됩니다.');
  }

  const rawTokens = input.split(TOKEN_SEPARATOR);
  const modifiers = new Set();
  let keyCode = null;

  for (const rawToken of rawTokens) {
    const token = rawToken.trim();
    if (token.length === 0) {
      throw new Error('단축키에 빈 토큰이 있습니다. "' + TOKEN_SEPARATOR + '" 구분자를 확인하세요.');
    }

    const lower = token.toLowerCase();

    if (UNSUPPORTED_MODIFIER_ALIASES.has(lower)) {
      throw new Error('지원하지 않는 보조키입니다. (Meta/Win/AltGraph는 사용할 수 없습니다.)');
    }

    const modifier = MODIFIER_ALIASES.get(lower);
    if (modifier !== undefined) {
      if (modifiers.has(modifier)) {
        throw new Error('중복된 보조키입니다: ' + modifier);
      }
      modifiers.add(modifier);
      continue;
    }

    const resolved = resolveKeyToken(token);
    if (resolved === null) {
      throw new Error('지원하지 않는 키입니다.');
    }
    if (keyCode !== null) {
      throw new Error('단축키에는 키를 하나만 지정할 수 있습니다.');
    }
    keyCode = resolved;
  }

  if (keyCode === null) {
    throw new Error('보조키만으로는 단축키를 만들 수 없습니다. 키를 하나 포함하세요.');
  }

  const tokens = [];
  for (const modifier of MODIFIER_ORDER) {
    if (modifiers.has(modifier)) {
      tokens.push(modifier);
    }
  }
  tokens.push(keyCode);

  const stroke = tokens.join(TOKEN_SEPARATOR);
  if (stroke.length > STROKE_MAX_LENGTH) {
    throw new Error('정규화된 단축키가 너무 깁니다. 최대 ' + STROKE_MAX_LENGTH + '자까지 허용됩니다.');
  }
  return stroke;
}

/**
 * KeyboardEvent에서 스트로크를 추출한다.
 * 부적합한 이벤트는 null을 반환하며, 이벤트를 변경하지 않는다.
 * @param {KeyboardEvent|object} event
 * @returns {{stroke: string, repeat: boolean}|null}
 */
function strokeFromEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  if (event.type !== 'keydown' || event.defaultPrevented === true) {
    return null;
  }
  if (event.isComposing === true) {
    return null;
  }
  if (event.keyCode === 229 || event.which === 229) {
    return null;
  }

  const code = typeof event.code === 'string' ? event.code : '';
  if (code.length === 0) {
    return null;
  }
  if (EVENT_BLOCKED_CODES.has(code) || EVENT_MODIFIER_CODES.has(code)) {
    return null;
  }
  const key = typeof event.key === 'string' ? event.key : '';
  if (EVENT_BLOCKED_CODES.has(key)) {
    return null;
  }
  if (Boolean(event.metaKey)) {
    return null;
  }

  if (typeof event.getModifierState === 'function') {
    let altGraph = false;
    try {
      altGraph = event.getModifierState('AltGraph') === true;
    } catch {
      altGraph = false;
    }
    if (altGraph) {
      return null;
    }
  }

  if (!SUPPORTED_KEY_CODES.has(code)) {
    return null;
  }

  const tokens = [];
  if (Boolean(event.ctrlKey)) {
    tokens.push('Ctrl');
  }
  if (Boolean(event.altKey)) {
    tokens.push('Alt');
  }
  if (Boolean(event.shiftKey)) {
    tokens.push('Shift');
  }
  tokens.push(code);

  return {
    stroke: tokens.join(TOKEN_SEPARATOR),
    repeat: Boolean(event.repeat),
  };
}

/**
 * 단축키 시퀀스(1~2개 스트로크, ' then ' 구분)를 정규화하고 문법을 검증한다.
 * @param {string} value 예: 'alt+w then alt+v'
 * @returns {string} 예: 'Alt+KeyW then Alt+KeyV'
 */
function normalizeSequence(value) {
  if (typeof value !== 'string') {
    throw new Error('단축키 시퀀스는 문자열이어야 합니다.');
  }
  if (value.length > SEQUENCE_MAX_LENGTH) {
    throw new Error('단축키 시퀀스가 너무 깁니다. 최대 ' + SEQUENCE_MAX_LENGTH + '자까지 허용됩니다.');
  }

  const input = value.trim();
  if (input.length === 0) {
    throw new Error('단축키 시퀀스가 비어 있습니다.');
  }
  if (input.length > SEQUENCE_MAX_LENGTH) {
    throw new Error('단축키 시퀀스가 너무 깁니다. 최대 ' + SEQUENCE_MAX_LENGTH + '자까지 허용됩니다.');
  }

  const rawStrokes = input.split(SEQUENCE_SEPARATOR);
  if (rawStrokes.length > 2) {
    throw new Error('단축키 시퀀스는 최대 두 단계까지 지정할 수 있습니다. 구분자는 " then "입니다.');
  }

  const strokes = [];
  for (const rawStroke of rawStrokes) {
    if (rawStroke.trim().length === 0) {
      throw new Error('단축키 시퀀스에 빈 단축키가 있습니다. " then " 구분자를 확인하세요.');
    }
    strokes.push(normalizeStroke(rawStroke));
  }

  const sequence = strokes.join(SEQUENCE_SEPARATOR);
  if (sequence.length > SEQUENCE_MAX_LENGTH) {
    throw new Error('정규화된 단축키 시퀀스가 너무 깁니다. 최대 ' + SEQUENCE_MAX_LENGTH + '자까지 허용됩니다.');
  }
  return sequence;
}

/**
 * 정규화된 스트로크 하나가 예약된 조합인지 판정한다.
 * @param {string} stroke
 * @returns {boolean}
 */
function isReservedStroke(stroke) {
  const tokens = stroke.split(TOKEN_SEPARATOR);
  const keyCode = tokens[tokens.length - 1];
  const modifiers = new Set(tokens.slice(0, tokens.length - 1));

  const hasCtrl = modifiers.has('Ctrl');
  const hasAlt = modifiers.has('Alt');
  const hasShift = modifiers.has('Shift');

  // Alt+Tab / Alt+Escape / Alt+F4 (+ 선택적 Ctrl/Shift)
  if (hasAlt && (keyCode === 'Tab' || keyCode === 'Escape' || keyCode === 'F4' || keyCode === 'Space' || keyCode === ' ')) {
    return true;
  }
  // Ctrl+Alt+Delete (+ 선택적 Shift)
  if (hasCtrl && hasAlt && keyCode === 'Delete') {
    return true;
  }
  // Ctrl+Escape (+ 선택적 Shift, Alt 제외)
  if (hasCtrl && !hasAlt && keyCode === 'Escape') {
    return true;
  }
  // Alt 단독 메뉴 니모닉: Alt+KeyF/E/V/C/T/H
  if (hasAlt && !hasCtrl && !hasShift && MENU_MNEMONIC_KEYS.has(keyCode)) {
    return true;
  }
  return false;
}

/**
 * 시퀀스에 예약된 스트로크가 포함되어 있는지 판정한다.
 * 정규화할 수 없는 입력은 false가 아니라 normalizeSequence의 예외를 그대로 전파한다(호출자는 정규 문법을 사전 검증하고 실패 시 거부해야 한다).
 * Alt+KeyW 뒤의 Alt+KeyV/H 시퀀스는 예외로 허용한다.
 * @param {string} value
 * @returns {boolean}
 * @throws {Error} 입력이 정규화되지 않을 때
 */
function isReservedSequence(value) {
  const sequence = normalizeSequence(value);

  const strokes = sequence.split(SEQUENCE_SEPARATOR);
  if (
    strokes.length === 2
    && strokes[0] === MNEMONIC_PREFIX_STROKE
    && MNEMONIC_CONTINUATION_STROKES.has(strokes[1])
  ) {
    return false;
  }

  for (const stroke of strokes) {
    if (isReservedStroke(stroke)) {
      return true;
    }
  }
  return false;
}

/**
 * 정규화된 키 토큰을 표시용 이름으로 바꾼다.
 * @param {string} token
 * @returns {string}
 */
function formatStrokeToken(token) {
  const letter = /^Key([A-Z])$/.exec(token);
  if (letter !== null) {
    return letter[1];
  }

  const digit = /^Digit([0-9])$/.exec(token);
  if (digit !== null) {
    return digit[1];
  }

  const alias = DISPLAY_KEY_ALIASES.get(token);
  if (alias !== undefined) {
    return alias;
  }
  return token;
}

/**
 * 정규화된 스트로크를 표시용 문자열로 바꾼다.
 * @param {string} stroke
 * @returns {string}
 */
function formatStroke(stroke) {
  const tokens = stroke.split(TOKEN_SEPARATOR);
  const formatted = [];
  for (const token of tokens) {
    formatted.push(formatStrokeToken(token));
  }
  return formatted.join(TOKEN_SEPARATOR);
}

/**
 * 시퀀스를 사용자 표시용 문자열로 바꾼다.
 * @param {string} value 예: 'ctrl+n', 'alt+w then alt+v'
 * @returns {string} 예: 'Ctrl+N', 'Alt+W → Alt+V'
 */
function formatSequence(value) {
  const sequence = normalizeSequence(value);
  const strokes = sequence.split(SEQUENCE_SEPARATOR);
  const formatted = [];
  for (const stroke of strokes) {
    formatted.push(formatStroke(stroke));
  }
  return formatted.join(DISPLAY_SEPARATOR);
}

module.exports = {
  normalizeStroke,
  strokeFromEvent,
  normalizeSequence,
  isReservedSequence,
  formatSequence,
};