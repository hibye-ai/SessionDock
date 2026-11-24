'use strict';

const { ACTIONS, getAction } = require('./shortcut-catalog.cjs');
const { normalizeSequence, formatSequence } = require('./shortcut-keys.cjs');

const MAX_OVERRIDE_ENTRIES = 64;
const MAX_KEYS_PER_ACTION = 4;
const MAX_RAW_KEY_LENGTH = 120;
const OVERRIDE_CONTEXT_MASK = 5;
const NO_BINDINGS_LABEL = '미지정';
const LABEL_SEPARATOR = ' / ';

const ERR_MAP_TYPE = '사용자 단축키 설정은 일반 객체여야 합니다.';
const ERR_MAP_SYMBOL = '사용자 단축키 설정에 심볼 속성을 사용할 수 없습니다.';
const ERR_MAP_ACCESSOR = '사용자 단축키 설정에 접근자 속성을 사용할 수 없습니다.';
const ERR_MAP_SIZE = '사용자 단축키 항목이 너무 많습니다.';
const ERR_ACTION = '알 수 없는 단축키 동작입니다.';
const ERR_LIST_TYPE = '사용자 단축키 값은 문자열 배열이어야 합니다.';
const ERR_LIST_SHAPE = '사용자 단축키 배열 형식이 올바르지 않습니다.';
const ERR_LIST_SIZE = '동작당 사용자 단축키는 최대 4개까지 허용됩니다.';
const ERR_KEY_TYPE = '단축키는 120자 이하의 문자열이어야 합니다.';
const ERR_KEY_INVALID = '단축키 형식이 올바르지 않습니다.';
const ERR_KEY_DUPLICATE = '같은 동작에 중복된 단축키가 있습니다.';
const ERR_ACTION_ID = '알 수 없는 단축키 동작 ID입니다.';

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasAccessor(descriptor) {
  return descriptor.get !== undefined || descriptor.set !== undefined;
}

function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isIndexName(name, length) {
  const index = Number(name);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === name;
}

function canonicalize(raw) {
  try {
    return normalizeSequence(raw);
  } catch {
    return null;
  }
}

function normalizeKeys(value) {
  if (!Array.isArray(value)) fail(ERR_LIST_TYPE);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(ERR_LIST_SHAPE);
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name !== 'length' && !isIndexName(name, value.length)) fail(ERR_LIST_SHAPE);
  }
  if (value.length > MAX_KEYS_PER_ACTION) fail(ERR_LIST_SIZE);
  const keys = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail(ERR_LIST_SHAPE);
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (hasAccessor(descriptor)) fail(ERR_LIST_SHAPE);
    const raw = descriptor.value;
    if (typeof raw !== 'string' || raw.length > MAX_RAW_KEY_LENGTH) fail(ERR_KEY_TYPE);
    const canonical = canonicalize(raw);
    if (typeof canonical !== 'string' || canonical.length === 0) fail(ERR_KEY_INVALID);
    if (seen.has(canonical)) fail(ERR_KEY_DUPLICATE);
    seen.add(canonical);
    keys.push(canonical);
  }
  return keys;
}

function normalizeOverrides(input) {
  if (input === undefined) return {};
  if (Array.isArray(input) || !isPlainObject(input)) fail(ERR_MAP_TYPE);
  if (Object.getOwnPropertySymbols(input).length > 0) fail(ERR_MAP_SYMBOL);
  const names = Object.getOwnPropertyNames(input);
  if (names.length > MAX_OVERRIDE_ENTRIES) fail(ERR_MAP_SIZE);
  const overrides = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (hasAccessor(descriptor)) fail(ERR_MAP_ACCESSOR);
    if (!getAction(name)) fail(ERR_ACTION);
    defineOwn(overrides, name, normalizeKeys(descriptor.value));
  }
  return overrides;
}

function makeBinding(action, sequence, contexts, isDefault) {
  return Object.freeze({
    actionId: action.id,
    sequence,
    contexts,
    repeat: action.repeat,
    isDefault,
  });
}

function resolveBinding(action, sequence) {
  for (const fallback of action.defaults) {
    if (fallback.sequence === sequence) {
      return makeBinding(action, sequence, fallback.contexts, true);
    }
  }
  return makeBinding(action, sequence, action.contexts & OVERRIDE_CONTEXT_MASK, false);
}

function effectiveBindings(input) {
  const overrides = normalizeOverrides(input);
  const bindings = [];
  for (const action of ACTIONS) {
    if (Object.prototype.hasOwnProperty.call(overrides, action.id)) {
      for (const sequence of overrides[action.id]) {
        bindings.push(resolveBinding(action, sequence));
      }
    } else {
      for (const fallback of action.defaults) {
        bindings.push(makeBinding(action, fallback.sequence, fallback.contexts, true));
      }
    }
  }
  return Object.freeze(bindings);
}

function requireActionId(id) {
  if (typeof id !== 'string' || !getAction(id)) fail(ERR_ACTION_ID);
}

function restoreAction(input, id) {
  const overrides = normalizeOverrides(input);
  requireActionId(id);
  const result = {};
  for (const key of Object.keys(overrides)) {
    if (key !== id) defineOwn(result, key, overrides[key].slice());
  }
  return result;
}

function shortcutLabel(id, input) {
  requireActionId(id);
  const parts = [];
  for (const binding of effectiveBindings(input)) {
    if (binding.actionId === id) parts.push(formatSequence(binding.sequence));
  }
  return parts.length === 0 ? NO_BINDINGS_LABEL : parts.join(LABEL_SEPARATOR);
}

module.exports = {
  normalizeOverrides,
  effectiveBindings,
  restoreAction,
  shortcutLabel,
};