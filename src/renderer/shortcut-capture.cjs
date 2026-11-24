'use strict';
// src/renderer/shortcut-capture.cjs
// 실제 키 입력으로 단축키 시퀀스를 지정하는 네이티브 팝업. 저장·적용 같은 제품 동작은 이 파일에 두지 않는다.
// 부모는 open({label, validate, onAccept}) / cancel() / destroy()만 호출한다.
const { strokeFromEvent, normalizeSequence, formatSequence } = require('../lib/shortcut-keys.cjs');
const HINT = '사용할 키를 누른 뒤 [지정]을 누르세요(Esc: 취소).';
const EMPTY_HINT = '키 조합을 누르세요';
const WAIT_HINT = '다음 키를 누르세요';

function createShortcutCapture({ parent } = {}) {
  const doc = (parent && parent.ownerDocument) || document;
  const win = doc.defaultView || window;
  const node = (tag, className, text) => { const value = doc.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };
  let active = false, destroyed = false, strokes = [], check = null, accept = null, trigger = null;

  const dialog = node('dialog', 'scut-recorder'); dialog.setAttribute('aria-label', '단축키 지정');
  const title = node('h2', 'scut-recorder-title');
  const guide = node('p', 'scut-recorder-hint scut-recorder-guide', HINT);
  const capture = node('div', 'scut-capture'); capture.tabIndex = 0; capture.setAttribute('aria-label', '단축키 입력');
  const strokesView = node('div', 'scut-strokes'); strokesView.setAttribute('aria-live', 'polite'); capture.append(strokesView);
  const twoStep = node('label', 'scut-two-label scut-two-step');
  const two = node('input', 'scut-two'); two.type = 'checkbox'; two.setAttribute('aria-label', '두 단계 키');
  twoStep.append(two, node('span', 'scut-two-text', '두 단계 키'));
  const errorBox = node('div', 'scut-recorder-error'); errorBox.setAttribute('role', 'alert');
  const confirm = node('button', 'scut-confirm', '지정'); confirm.type = 'button';
  const cancelButton = node('button', 'scut-cancel', '취소'); cancelButton.type = 'button';
  dialog.append(title, guide, capture, twoStep, errorBox, confirm, cancelButton);
  doc.body.append(dialog);

  const maxStrokes = () => (two.checked ? 2 : 1);
  const sequence = () => (strokes.length ? normalizeSequence(strokes.join(' then ')) : '');
  function pendingSecond() { return two.checked && strokes.length === 1; }
  function showPreview() {
    strokesView.classList.toggle('is-empty', strokes.length === 0);
    if (!strokes.length) { strokesView.textContent = EMPTY_HINT; return; }
    try { strokesView.textContent = formatSequence(strokes.join(' then ')); }
    catch { strokesView.textContent = strokes.join(' then '); }
    if (pendingSecond()) strokesView.append(node('span', 'scut-strokes-next', ' ' + WAIT_HINT));
  }
  function clearError() { errorBox.textContent = ''; }
  function resetCandidate() { strokes = []; showPreview(); clearError(); confirm.disabled = true; }
  function fail(message) { errorBox.textContent = message || '이 단축키는 사용할 수 없습니다.'; confirm.disabled = true; }
  function candidateValid() {
    if (strokes.length !== maxStrokes()) { confirm.disabled = true; clearError(); return false; }
    try {
      if (check) check(sequence());
      clearError(); confirm.disabled = false; return true;
    } catch (error) { fail(error && error.message); return false; }
  }
  function addStroke(stroke) {
    if (strokes.length >= maxStrokes()) strokes = []; // 완료된 시퀀스 뒤 새 키는 처음부터 다시 시작한다.
    strokes.push(stroke); showPreview(); candidateValid();
  }
  function restoreTrigger() {
    if (!parent || !parent.open || !trigger || !trigger.isConnected || typeof trigger.focus !== 'function') return;
    trigger.focus();
  }
  function close() {
    if (!active) return;
    active = false;
    if (dialog.open) dialog.close();
    resetCandidate();
    restoreTrigger();
    check = null; accept = null; trigger = null;
  }
  function cancel() { close(); }
  function open(options = {}) {
    if (destroyed) return;
    check = typeof options.validate === 'function' ? options.validate : null;
    accept = typeof options.onAccept === 'function' ? options.onAccept : null;
    title.textContent = options.label ? String(options.label) : '단축키 지정';
    dialog.setAttribute('aria-label', title.textContent);
    two.checked = false;
    resetCandidate();
    active = true;
    if (!dialog.open) {
      trigger = doc.activeElement;
      try { dialog.showModal(); }
      catch (error) { active = false; check = null; accept = null; trigger = null; throw error; }
    }
    capture.focus();
  }
  function onConfirm() {
    if (!active || !candidateValid()) return;
    const value = sequence();
    try {
      if (accept) accept(value);
    } catch (error) { errorBox.textContent = (error && error.message) || '단축키를 적용하지 못했습니다.'; return; }
    close();
  }
  // IME 조합 입력(keyCode 229·Process·Dead)은 Escape·Tab 특수 처리로 새지 않게 상태를 바꾸지 않고 삼킨다.
  function isImeEvent(event) { return event.isComposing === true || event.keyCode === 229 || event.which === 229 || event.key === 'Process' || event.key === 'Dead'; }
  function onKeyDown(event) {
    if (!active) return;
    if (isImeEvent(event)) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation(); cancel(); return; // 이 팝업만 닫고 부모 키 처리는 막는다.
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return; // 수정 키 없는 Tab/Shift+Tab은 기본 포커스 이동
    if (doc.activeElement !== capture) return; // 캡처는 .scut-capture가 포커스일 때만 한다.
    const result = strokeFromEvent(event); // 반복/수식키만/IME/Meta/AltGraph/Dead는 helper가 null로 걸러낸다.
    event.preventDefault(); event.stopPropagation(); // null/repeat여도 부모 폼 제출 등으로 새지 않게 항상 막는다.
    if (result && !result.repeat) addStroke(result.stroke);
  }
  function onWindowBlur() { if (active && strokes.length < maxStrokes()) resetCandidate(); }
  function onTwoChange() { if (!active) return; resetCandidate(); capture.focus(); }
  function onDialogCancel(event) { event.preventDefault(); event.stopPropagation(); cancel(); }
  function onParentClose() { cancel(); }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (active) cancel();
    win.removeEventListener('blur', onWindowBlur);
    dialog.removeEventListener('keydown', onKeyDown);
    dialog.removeEventListener('cancel', onDialogCancel);
    two.removeEventListener('change', onTwoChange);
    confirm.removeEventListener('click', onConfirm);
    cancelButton.removeEventListener('click', cancel);
    if (parent && typeof parent.removeEventListener === 'function') parent.removeEventListener('close', onParentClose);
    dialog.remove();
    check = null; accept = null; trigger = null;
  }

  win.addEventListener('blur', onWindowBlur);
  dialog.addEventListener('keydown', onKeyDown);
  dialog.addEventListener('cancel', onDialogCancel);
  two.addEventListener('change', onTwoChange);
  confirm.addEventListener('click', onConfirm);
  cancelButton.addEventListener('click', cancel);
  if (parent && typeof parent.addEventListener === 'function') parent.addEventListener('close', onParentClose);

  return { open, cancel, destroy };
}

module.exports = { createShortcutCapture };
