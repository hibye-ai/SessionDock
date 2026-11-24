'use strict';

const APPEARANCE_DEFAULTS = Object.freeze({ fontFamily: 'Consolas', fontWeight: 'normal', lineHeight: 1, letterSpacing: 0, terminalTransparency: 0, scrollOnOutput: false, scrollOnKeypress: true, visualBell: false });
const FONT_FALLBACKS = ['Consolas', 'Malgun Gothic'];
const FONT_SUGGESTIONS = ['Consolas', 'Cascadia Code', 'Cascadia Mono', 'D2Coding', 'D2Coding ligature', 'JetBrains Mono', 'Lucida Console', 'Roboto Mono', 'Source Code Pro'];
const APPEARANCE_KEYS = Object.keys(APPEARANCE_DEFAULTS);
const SESSION_APPEARANCE_KEYS = ['fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontSize', 'scrollback', 'cursorStyle', 'cursorBlink'];
function invalid(key) { throw Object.assign(new Error(`터미널 ${key} 설정이 올바르지 않습니다.`), { code: 'ERR_VALIDATION' }); }
function appearanceSettings(input, previous = APPEARANCE_DEFAULTS, session = false) {
  const defaults = session ? { fontFamily: '', fontWeight: '', lineHeight: 0, letterSpacing: -1 } : APPEARANCE_DEFAULTS;
  const result = {};
  for (const key of Object.keys(defaults)) {
    let value = input[key] === undefined ? (previous[key] ?? defaults[key]) : input[key];
    if (key === 'terminalTransparency') {
      if (typeof value === 'string' && /^\d{1,3}$/.test(value)) value = Number(value);
      if (!Number.isInteger(value) || value < 0 || value > 100) invalid('배경 투명도');
    } else if (key === 'fontFamily') {
      if (typeof value !== 'string' || value.length > 128 || /[\x00-\x1f\x7f"\\,;{}<>]/.test(value)) invalid('글꼴');
      value = value.trim(); if (!session && !value) invalid('글꼴');
    } else if (key === 'fontWeight') {
      if (!['normal', 'bold', ...(session ? [''] : [])].includes(value)) invalid('글꼴 굵기');
    } else if (['lineHeight', 'letterSpacing'].includes(key)) {
      if (typeof value === 'string' && /^-?\d+(?:\.\d{1,2})?$/.test(value)) value = Number(value);
      const inherit = session && value === (key === 'lineHeight' ? 0 : -1);
      if (typeof value !== 'number' || !Number.isFinite(value) || (!inherit && (value < (key === 'lineHeight' ? 1 : 0) || value > (key === 'lineHeight' ? 2 : 5)))) invalid(key === 'lineHeight' ? '줄 간격' : '글자 간격');
    } else if (typeof value !== 'boolean') invalid(key);
    result[key] = value;
  }
  return result;
}
function terminalAppearance(settings, profile = {}) {
  const global = { ...APPEARANCE_DEFAULTS, fontSize: 14, scrollback: 10000, ...settings };
  const family = profile.fontFamily || global.fontFamily;
  return {
    fontFamily: [...new Set([family, ...FONT_FALLBACKS])].map(name => JSON.stringify(name)).join(', ') + ', monospace',
    fontSize: profile.fontSize || global.fontSize, scrollback: profile.scrollback || global.scrollback,
    fontWeight: profile.fontWeight || global.fontWeight, fontWeightBold: 'bold',
    lineHeight: profile.lineHeight || global.lineHeight,
    letterSpacing: profile.letterSpacing >= 0 ? profile.letterSpacing : global.letterSpacing,
    cursorStyle: profile.cursorStyle || 'bar', cursorBlink: profile.cursorBlink ?? true,
    scrollOnUserInput: global.scrollOnKeypress
  };
}
module.exports = { APPEARANCE_DEFAULTS, APPEARANCE_KEYS, SESSION_APPEARANCE_KEYS, FONT_SUGGESTIONS, appearanceSettings, terminalAppearance };
