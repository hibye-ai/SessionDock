'use strict';

const INTERACTION_DEFAULTS = Object.freeze({
  middleClickClosesTab: true,
  confirmTabClose: true,
  focusNewTab: true,
  copyOnSelect: false,
  middleClickPaste: false,
  confirmMultilinePaste: true,
  confirmAppExit: true,
  rightClickAction: 'menu'
});
const BOOLEAN_INTERACTION_KEYS = Object.freeze(Object.keys(INTERACTION_DEFAULTS).filter(key => typeof INTERACTION_DEFAULTS[key] === 'boolean'));

function interactionSettings(input, previous = INTERACTION_DEFAULTS) {
  const result = {};
  for (const key of Object.keys(INTERACTION_DEFAULTS)) {
    const value = Object.hasOwn(input, key) && input[key] !== undefined ? input[key] : previous[key] ?? INTERACTION_DEFAULTS[key];
    if (key === 'rightClickAction' ? !['menu', 'paste'].includes(value) : typeof value !== 'boolean') {
      const error = new Error(`조작 설정 ${key}의 값이 올바르지 않습니다.`); error.code = 'ERR_VALIDATION'; throw error;
    }
    result[key] = value;
  }
  return result;
}
module.exports = { INTERACTION_DEFAULTS, BOOLEAN_INTERACTION_KEYS, interactionSettings };
