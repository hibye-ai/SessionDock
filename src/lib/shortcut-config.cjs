'use strict';
// Application shortcut validation. Send-text values never cross this boundary.
const overrides = require('./shortcut-overrides.cjs');
const { ACTIONS, getAction } = require('./shortcut-catalog.cjs');
const { normalizeStroke, isReservedSequence } = require('./shortcut-keys.cjs');
const terminalDefaults = new Set(overrides.effectiveBindings().filter(b => b.contexts & 4).flatMap(b => b.sequence.split(' then ')));
const browserReserved = new Set(['F5', 'F12', 'Ctrl+KeyR', 'Ctrl+Shift+KeyR', 'Ctrl+Shift+KeyI', 'Ctrl+Shift+KeyJ']);
// A Shift-only binding whose base key also types a character would swallow
// ordinary terminal input: Shift+A is a capital A, Shift+1 is '!', Shift+Space
// is a space. Numpad `+ - * / .` are printable too (`+`, `-`, `*`, `/`, `.`
// with NumLock, and layout/AltGraph-dependent characters without it), so only
// genuinely non-printing special/function keys may use Shift alone.
const SHIFT_ONLY_KEYS = new Set([
  'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Tab', 'Enter',
  'NumpadEnter',
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
]);
function isShiftOnly(stroke) {
  return /(?:^|\+)Shift\+/.test(stroke) && !/(?:^|\+)(?:Ctrl|Alt)\+/.test(stroke);
}

function fail(message, actionIds = []) {
  const error = new Error(message); error.code = 'ERR_SHORTCUTS'; error.actionIds = actionIds; throw error;
}
function collectSendTextKeys(globalKeymap = [], sessions = []) {
  const result = new Set();
  const collect = rows => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || row.enabled === false || typeof row.key !== 'string') continue;
      // Old terminal maps may contain Meta keys, which app shortcuts cannot use.
      try { result.add(normalizeStroke(row.key)); } catch { /* preserve legacy map */ }
    }
  };
  collect(globalKeymap); for (const session of sessions) collect(session?.keymap);
  return [...result];
}
function validateOverrides(input, { sendTextKeys = [] } = {}) {
  let normalized;
  try { normalized = overrides.normalizeOverrides(input); }
  catch (error) { error.code = 'ERR_SHORTCUTS'; throw error; }
  if (!(Array.isArray(sendTextKeys) || sendTextKeys instanceof Set) || sendTextKeys.size > 4096 || sendTextKeys.length > 4096) fail('터미널 키 매핑 목록이 올바르지 않습니다.');
  const mapped = new Set();
  for (const key of sendTextKeys) {
    if (typeof key !== 'string') fail('터미널 키 매핑 목록이 올바르지 않습니다.');
    try { mapped.add(normalizeStroke(key)); } catch { /* unsupported legacy key */ }
  }
  const bindings = overrides.effectiveBindings(normalized);
  for (const binding of bindings) {
    const { actionId, sequence, isDefault, contexts } = binding, strokes = sequence.split(' then '), label = getAction(actionId).label;
    if (isReservedSequence(sequence) || strokes.some(stroke => browserReserved.has(stroke))) fail(`${label}: Windows·메뉴·프로그램 예약키는 지정할 수 없습니다.`, [actionId]);
    if (!isDefault) {
      const first = strokes[0], base = first.split('+').at(-1);
      if (!/Ctrl\+|Alt\+|Shift\+/.test(first) && !/^F(?:[1-9]|1\d|2[0-4])$/.test(base)) fail(`${label}: Ctrl·Alt·Shift 조합 또는 F키를 사용해 주세요.`, [actionId]);
      if (strokes.includes('Escape')) fail(`${label}: Escape는 취소 동작으로 사용합니다.`, [actionId]);
      // Shift-only combinations must be non-printing keys. A printable base key
      // (KeyA-Z, Digit*, punctuation, Space) is ordinary terminal input and would
      // be stolen from the remote session.
      for (const stroke of strokes) {
        if (!isShiftOnly(stroke)) continue;
        const base = stroke.split('+').at(-1);
        if (!SHIFT_ONLY_KEYS.has(base)) fail(`${label}: Shift 단독 조합은 Delete·Insert·방향키·F키 같은 특수키에만 사용할 수 있습니다.`, [actionId]);
      }
      if (contexts & 4) {
        for (const stroke of strokes) {
          if (/^Ctrl\+Key[A-Z]$/.test(stroke) && !terminalDefaults.has(stroke)) fail(`${label}: 원격 터미널의 제어키는 앱 단축키로 지정할 수 없습니다.`, [actionId]);
          if (mapped.has(stroke)) fail(`${label}: 터미널 전송 키 매핑에서 사용하는 키와 충돌합니다.`, [actionId]);
        }
      }
    }
  }
  for (let i = 0; i < bindings.length; i++) for (let j = i + 1; j < bindings.length; j++) {
    const a = bindings[i], b = bindings[j]; if (!(a.contexts & b.contexts)) continue;
    const aParts = a.sequence.split(' then '), bParts = b.sequence.split(' then ');
    const duplicate = a.sequence === b.sequence;
    const prefix = aParts[0] === bParts[0] && aParts.length !== bParts.length;
    if (duplicate || prefix) fail(`${getAction(a.actionId).label} · ${getAction(b.actionId).label}: ${duplicate ? '같은 키 조합을 사용합니다.' : '한 단계 키와 두 단계 접두사가 충돌합니다.'}`, [a.actionId, b.actionId]);
  }
  return normalized;
}
module.exports = { ...overrides, validateOverrides, collectSendTextKeys };
