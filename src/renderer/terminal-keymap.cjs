'use strict';

/**
 * Persistable send-text mappings. No DOM, transport, logging or credentials.
 *
 * normalizeKeymap(input) -> fresh [{ key, text, enabled }]. `text` stays in its
 * editable, escaped form; normalization/JSON roundtrips never decode it twice.
 * null/undefined normalize to []; preserve a session's null inheritance marker
 * in the caller's schema if it distinguishes null from an empty override list.
 * Both null and [] inherit global keys when resolving. A session row overrides
 * the same global key; enabled:false masks that global row, restoring normal
 * terminal handling. An enabled empty text consumes a key without sending.
 *
 * resolveKeyMapping(event, sessionKeymap, globalKeymap) -> decoded string|null.
 * createKeymapResolver(sessionKeymap, globalKeymap) compiles a snapshot for the
 * keyboard hot path. Recompile after settings change; no mutable-array cache.
 * matches(event) includes repeated keydowns so the installer can consume a held
 * macro key without sending either the macro or a native xterm key repeatedly.
 *
 * Keys use physical DOM codes when available (KeyA -> A), like the app's own
 * shortcuts, with KeyboardEvent.key fallback for code-less events. AltGraph,
 * IME/dead keys and non-keydown events never resolve. All modifiers are exact.
 * Escapes: \\r, \\n, \\e/\\E, \\xHH, 1-3 octal digits (0-255), \\t, \\b,
 * \\f, \\v and \\\\. Escapes represent Unicode characters, not raw wire bytes;
 * the existing session encoder remains responsible for UTF-8/CP949/etc.
 *
 * Existing REA resource observations: operations-exe-resources.json dialog 102
 * (Keymap Editor), operations-config-resources.json dialog 4425 (Map Selected
 * Key, octal notation). These justify the UI concept/escape input, not parity
 * with SecureCRT's keymap file format, actions, macros or emulation engine.
 */

const KEYMAP_LIMITS = Object.freeze({ entries: 256, keyLength: 64, textLength: 4096, totalTextLength: 65536 });
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MODIFIER_NAMES = new Map([
  ['ctrl', 'Ctrl'], ['control', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift'], ['meta', 'Meta']
]);
const NAMED_KEYS = new Map([
  ...['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
    'Insert', 'Delete', 'Backspace', 'Enter', 'Escape', 'Tab', 'Space'].map(key => [key.toLowerCase(), key]),
  ['up', 'ArrowUp'], ['down', 'ArrowDown'], ['left', 'ArrowLeft'], ['right', 'ArrowRight'],
  ['pgup', 'PageUp'], ['pgdn', 'PageDown'], ['del', 'Delete'], ['esc', 'Escape'], ['return', 'Enter']
]);

function invalid(reason) {
  // Never interpolate input: mapping text could contain a credential.
  const error = new TypeError(`Invalid terminal keymap: ${reason}.`);
  error.code = 'ERR_VALIDATION';
  throw error;
}

function normalizeBaseKey(key) {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^Key[a-z]$/i.test(key)) return key.slice(3).toUpperCase();
  if (/^F(?:[1-9]|1[0-9]|20)$/i.test(key)) return key.toUpperCase();
  return NAMED_KEYS.get(key.toLowerCase()) || null;
}

function normalizeKeyCombination(input) {
  if (typeof input !== 'string' || !input.length || input.length > KEYMAP_LIMITS.keyLength) invalid('unsupported key combination');
  const parts = input.split('+').map(part => part.trim());
  if (!parts.length || parts.length > 5 || parts.some(part => !part)) invalid('unsupported key combination');
  const base = normalizeBaseKey(parts.pop());
  if (!base) invalid('unsupported key');
  const modifiers = new Set();
  for (const part of parts) {
    const modifier = MODIFIER_NAMES.get(part.toLowerCase());
    if (!modifier || modifiers.has(modifier)) invalid('unsupported or duplicate modifier');
    modifiers.add(modifier);
  }
  return [...MODIFIERS.filter(modifier => modifiers.has(modifier)), base].join('+');
}

function reservedCombination(combination) {
  const parts = combination.split('+'), base = parts.pop();
  const ctrl = parts.includes('Ctrl'), alt = parts.includes('Alt'), shift = parts.includes('Shift');
  // Match the existing custom key listener, including its modifier supersets.
  return base === 'F3' || (alt && base === 'F4') ||
    (ctrl && ['N', 'K', 'Tab', 'F4'].includes(base)) ||
    (ctrl && shift && ['C', 'F'].includes(base)) ||
    (ctrl && !alt && base === 'V') || (shift && base === 'Insert') ||
    (alt && ['Q', 'G', 'M', 'F', 'E', 'V', 'C', 'T', 'H'].includes(base));
}

function keyCombinationFromEvent(event) {
  if (!event || event.type !== 'keydown' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.which === 229 ||
      ['Dead', 'Process', 'Unidentified', 'Compose'].includes(event.key) ||
      (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph'))) return null;
  // Do not turn numpad Enter/navigation into ordinary keys: xterm owns DECKPAM.
  const source = typeof event.code === 'string' && event.code ? event.code : event.key;
  const base = source === ' ' ? 'Space' : typeof source === 'string' ? normalizeBaseKey(source) : null;
  if (!base) return null;
  return [...MODIFIERS.filter(modifier => event[`${modifier.toLowerCase()}Key`]), base].join('+');
}

function isReservedKeyEvent(event) {
  const combination = keyCombinationFromEvent(event);
  return combination !== null && reservedCombination(combination);
}

function decodeKeyText(input) {
  if (typeof input !== 'string' || input.length > KEYMAP_LIMITS.textLength || !input.isWellFormed()) invalid('invalid send text');
  const escapes = { r: '\r', n: '\n', e: '\x1b', E: '\x1b', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\' };
  let output = '';
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char !== '\\') { output += char; continue; }
    const escape = input[++index];
    if (Object.hasOwn(escapes, escape)) output += escapes[escape];
    else if (escape === 'x') {
      const hex = input.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) invalid('invalid hexadecimal escape');
      output += String.fromCharCode(parseInt(hex, 16));
      index += 2;
    } else if (escape && /^[0-7]$/.test(escape)) {
      let octal = escape;
      while (octal.length < 3 && /^[0-7]$/.test(input[index + 1] || '')) octal += input[++index];
      const code = parseInt(octal, 8);
      if (code > 255) invalid('octal escape exceeds one byte');
      output += String.fromCharCode(code);
    } else invalid('unsupported or unfinished escape');
  }
  return output;
}

function normalizeKeymap(input = []) {
  if (input === null) return [];
  if (!Array.isArray(input) || input.length > KEYMAP_LIMITS.entries) invalid('expected a bounded mapping array');
  const keys = new Set(), result = [];
  let totalTextLength = 0;
  for (const row of input) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
        !Object.hasOwn(row, 'key') || !Object.hasOwn(row, 'text') ||
        Object.keys(row).some(key => !['key', 'text', 'enabled'].includes(key))) invalid('expected key, text and optional enabled');
    const key = normalizeKeyCombination(row.key);
    if (reservedCombination(key)) invalid('key is reserved by the application');
    if (keys.has(key)) invalid('duplicate key combination');
    if (Object.hasOwn(row, 'enabled') && typeof row.enabled !== 'boolean') invalid('enabled must be boolean');
    decodeKeyText(row.text);
    totalTextLength += row.text.length;
    if (totalTextLength > KEYMAP_LIMITS.totalTextLength) invalid('total send text exceeds limit');
    keys.add(key);
    result.push({ key, text: row.text, enabled: row.enabled !== false });
  }
  return result;
}

function createKeymapResolver(sessionKeymap = null, globalKeymap = []) {
  const index = new Map();
  for (const rows of [normalizeKeymap(globalKeymap), normalizeKeymap(sessionKeymap)]) {
    for (const row of rows) index.set(row.key, row.enabled ? decodeKeyText(row.text) : null);
  }
  const lookup = event => {
    const key = keyCombinationFromEvent(event);
    return key === null || reservedCombination(key) ? null : index.get(key) ?? null;
  };
  return Object.freeze({
    resolve: event => event?.repeat ? null : lookup(event),
    matches: event => lookup(event) !== null
  });
}

function resolveKeyMapping(event, sessionKeymap = null, globalKeymap = []) {
  return createKeymapResolver(sessionKeymap, globalKeymap).resolve(event);
}

module.exports = {
  KEYMAP_LIMITS, normalizeKeyCombination, normalizeKeymap, decodeKeyText,
  keyCombinationFromEvent, isReservedKeyEvent, createKeymapResolver, resolveKeyMapping
};
