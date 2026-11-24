'use strict';
// 키캡 버튼이 저장된 키 시퀀스를 보여 주고, 새 키는 캡처 팝업으로 기록한다.
const { ACTIONS } = require('../lib/shortcut-catalog.cjs');
const { normalizeOverrides, validateOverrides } = require('../lib/shortcut-config.cjs');
const { normalizeSequence, formatSequence } = require('../lib/shortcut-keys.cjs');
const { createShortcutCapture } = require('./shortcut-capture.cjs');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const signature = object => JSON.stringify(Object.keys(object).sort().map(key => [key, object[key]]));
const labelScope = mask => [[1, '앱'], [2, '입력칸'], [4, '터미널']].filter(([bit]) => mask & bit).map(([, label]) => label).join('·');
const node = (tag, className, text) => { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };
const compact = text => text.toLocaleLowerCase().replace(/\s+/g, '');
const sequenceText = value => { try { return formatSequence(value); } catch { return String(value); } };
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgNode = (tag, attributes) => { const value = document.createElementNS(SVG_NS, tag); for (const [key, setting] of Object.entries(attributes)) value.setAttribute(key, setting); return value; };
// 장식용 정적 키보드 아이콘. 저장 키는 항상 textContent로만 표시한다.
const keyboardIcon = () => { const icon = svgNode('svg', { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' }); icon.append(svgNode('rect', { x: '1.4', y: '3.4', width: '13.2', height: '9.2', rx: '1.7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }), svgNode('path', { d: 'M4.1 6.5h1.2M7.4 6.5h1.2M10.7 6.5h1.2M4.9 9.5h6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round' })); return icon; };
// Catalog order within each menu group; groups follow their first appearance.
const GROUPS = [...new Set(ACTIONS.map(action => action.group))].map(group => [group, ACTIONS.filter(action => action.group === group)]);
const HINT = '키를 눌러 수정하거나 새 조합을 추가합니다(동작당 최대 4개, 적용 시 저장).';
const HINT_DETAIL = '새 단축키는 일반 입력칸을 제외한 앱과 터미널에서 동작합니다.';
function createShortcutSettings({ root, onDirty = () => {} }) {
  const container = node('div', 'scut-root'), header = node('div', 'scut-head'), search = node('input', 'scut-search');
  search.type = 'search'; search.placeholder = '동작 이름·단축키 검색 (예: Ctrl+K)'; search.setAttribute('aria-label', '단축키 검색'); search.autocomplete = 'off'; search.spellcheck = false;
  const status = node('span', 'scut-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const all = node('button', 'secondary-button small', '전체 기본값 복원'); all.type = 'button'; all.dataset.scut = 'resetall'; all.title = '모든 단축키를 기본값으로 되돌립니다(적용 시 저장).';
  header.append(search, status, all);
  const hint = node('p', 'field-hint scut-hint', HINT); hint.title = HINT_DETAIL;
  const errorBox = node('div', 'form-error scut-error'); errorBox.setAttribute('role', 'alert'); errorBox.tabIndex = -1;
  const table = node('div', 'scut-table'), cols = node('div', 'scut-cols'); cols.setAttribute('aria-hidden', 'true');
  cols.append(node('span', '', '동작'), node('span', '', '단축키'), node('span', 'scut-cols-end', '작업'));
  const list = node('div', 'scut-list'), empty = node('p', 'scut-empty', '일치하는 단축키 동작이 없습니다.');
  table.append(cols, list); container.append(header, hint, errorBox, table); root.append(container);
  let originalInput, original = {}, draft = {}, sendTextKeys = [], loadError = null, correctedInvalid = false, rows = new Map(), sections = [], errorIds = [], capture = null;
  const shown = action => own(draft, action.id) ? draft[action.id] : action.defaults.map(binding => binding.sequence);
  const dirty = () => {
    if (correctedInvalid) return true;
    if (loadError) return false;
    try { return signature(normalizeOverrides(draft)) !== signature(original); }
    catch { return JSON.stringify(draft) !== JSON.stringify(original); }
  };
  function updateStatus(visible) {
    if (loadError) { status.textContent = ''; return; }
    const query = search.value.trim(), custom = [...rows.keys()].filter(id => own(draft, id)).length;
    visible ??= [...rows.values()].filter(row => !row.element.hidden).length;
    status.textContent = (query ? (visible ? visible + '개 일치' : '결과 없음') : '동작 ' + rows.size + '개') + (custom ? ' · 사용자 지정 ' + custom + '개' : '');
  }
  function filter() {
    const query = compact(search.value); let visible = 0;
    for (const row of rows.values()) { const keys = shown(row.action).map(sequenceText).join(' '); row.element.hidden = !!query && !compact(row.action.label + ' ' + row.action.group + ' ' + keys).includes(query); if (!row.element.hidden) visible++; }
    for (const section of sections) { const count = section.rows.filter(row => !row.element.hidden).length; section.element.hidden = !count; section.count.textContent = String(count); }
    empty.hidden = !!loadError || visible > 0; updateStatus(visible);
  }
  function showError(error) {
    errorBox.textContent = error.message; errorIds = error.actionIds || [];
    for (const [id, row] of rows) { const invalid = errorIds.includes(id); row.input.setAttribute('aria-invalid', String(invalid)); row.element.classList.toggle('has-error', invalid); row.error.textContent = invalid ? error.message : ''; }
  }
  function clearError() { errorBox.textContent = ''; errorIds = []; for (const row of rows.values()) { row.error.textContent = ''; row.input.removeAttribute('aria-invalid'); row.element.classList.remove('has-error'); } }
  function value() {
    try {
      if (loadError) throw loadError;
      for (const [id, keys] of Object.entries(draft)) {
        try { normalizeOverrides({ [id]: keys }); }
        catch (error) { error.actionIds = [id]; throw error; }
      }
      const result = validateOverrides(draft, { sendTextKeys }); clearError(); return result;
    } catch (error) { error.code = 'ERR_SHORTCUTS'; showError(error); throw error; }
  }
  // 범위 요약은 한 줄로 유지하고 키별 상세는 툴팁에 둔다.
  function refreshScope(row) {
    const { action } = row, custom = own(draft, action.id), keys = shown(action).map(raw => {
      try { const sequence = normalizeSequence(raw), fallback = action.defaults.find(binding => binding.sequence === sequence); return [formatSequence(sequence), labelScope(fallback ? fallback.contexts : action.contexts & 5)]; }
      catch { return [raw, labelScope(action.contexts & 5)]; }
    });
    row.scope.textContent = keys.length ? [...new Set(keys.map(([, scope]) => scope))].join(' / ') : (custom ? '해제됨' : '키 없음');
    row.scope.title = keys.length ? '적용 범위\n' + keys.map(([key, scope]) => key + ': ' + scope).join('\n') : '';
    row.element.classList.toggle('is-custom', custom); row.badge.hidden = !custom; row.defaults.hidden = !custom;
  }
  function keypair(action, raw, index) {
    const text = sequenceText(raw);
    const pair = node('span', 'scut-keypair');
    const keycap = node('button', 'scut-keycap', text);
    keycap.type = 'button'; keycap.dataset.scut = 'edit-alias'; keycap.dataset.id = action.id; keycap.dataset.index = String(index);
    keycap.title = text + '\n클릭하면 이 단축키를 다시 기록합니다.'; keycap.setAttribute('aria-label', action.label + ' 단축키 ' + (index + 1) + ': ' + text + ', 다시 기록');
    const remove = node('button', 'scut-del');
    const removeIcon = svgNode('svg', { viewBox: '0 0 16 16', width: '12', height: '12', 'aria-hidden': 'true', focusable: 'false' });
    removeIcon.append(svgNode('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }));
    remove.append(removeIcon);
    remove.type = 'button'; remove.dataset.scut = 'delete-alias'; remove.dataset.id = action.id; remove.dataset.index = String(index);
    remove.title = '이 단축키를 삭제합니다.'; remove.setAttribute('aria-label', action.label + ' 단축키 ' + (index + 1) + ' ' + text + ' 삭제');
    pair.append(keycap, remove);
    return pair;
  }
  function render() {
    list.replaceChildren(); rows = new Map(); sections = []; cols.hidden = !!loadError;
    if (loadError) { list.append(node('p', 'field-hint scut-load', '단축키를 읽지 못해 기존 값을 보존했습니다. 기본값 복원 후 적용하세요.')); empty.hidden = true; updateStatus(); return; }
    const fragment = document.createDocumentFragment();
    GROUPS.forEach(([group, actions], index) => {
      const section = node('div', 'scut-section'), head = node('div', 'scut-group-head'), count = node('span', 'scut-group-count');
      head.id = 'shortcut-group-' + index; head.append(node('span', '', group), count); section.setAttribute('role', 'group'); section.setAttribute('aria-labelledby', head.id); section.append(head);
      const entry = { element: section, count, rows: [] };
      for (const action of actions) {
        const element = node('div', 'scut-row'); element.dataset.actionId = action.id;
        const title = node('div', 'scut-name'), label = node('label', 'scut-label', action.label), meta = node('div', 'scut-meta'), badge = node('span', 'scut-badge', '사용자 지정'), scope = node('span', 'scut-scope');
        meta.append(badge, scope); title.append(label, meta);
        const keys = shown(action);
        const defaultKeys = action.defaults.map(binding => sequenceText(binding.sequence)), defaultDetail = action.defaults.map(binding => sequenceText(binding.sequence) + ': ' + labelScope(binding.contexts)).join('\n');
        const edit = node('div', 'scut-edit'), error = node('div', 'form-error scut-row-error'), defaults = node('div', 'scut-default', '기본값: ' + (defaultKeys.join(', ') || '없음'));
        error.id = 'shortcut-' + action.id + '-error'; defaults.id = 'shortcut-' + action.id + '-default'; defaults.title = defaultDetail;
        const opener = node('button', 'scut-open scut-input'); opener.type = 'button'; opener.id = 'shortcut-' + action.id; opener.dataset.scut = 'open'; opener.dataset.id = action.id; opener.dataset.shortcutId = action.id;
        opener.disabled = keys.length >= 4; opener.title = opener.disabled ? '단축키는 최대 4개까지 등록할 수 있습니다.' : '새 키 조합을 기록해 단축키를 추가합니다.';
        opener.setAttribute('aria-label', action.label + ' 단축키 추가'); opener.setAttribute('aria-describedby', error.id + ' ' + defaults.id); opener.append(keyboardIcon());
        edit.append(...keys.map((raw, position) => keypair(action, raw, position)));
        if (!keys.length) edit.append(node('span', 'scut-none', '미지정'));
        edit.append(opener, defaults, error);
        const buttons = node('div', 'scut-btns');
        for (const [command, text, tip] of [['reset', '기본값', '기본값으로 복원 (' + (defaultKeys.join(', ') || '키 없음') + ')'], ['off', '해제', '이 동작의 단축키를 모두 해제']]) {
          const button = node('button', 'scut-act', text); button.type = 'button'; button.dataset.scut = command; button.dataset.id = action.id; button.title = tip; button.setAttribute('aria-label', action.label + ' ' + tip); buttons.append(button);
        }
        element.append(title, edit, buttons); const row = { action, element, input: opener, error, scope, badge, defaults }; rows.set(action.id, row); entry.rows.push(row); refreshScope(row); section.append(element);
      }
      sections.push(entry); fragment.append(section);
    });
    list.append(fragment, empty); filter();
  }
  function notify() { onDirty(); }
  function open(input, options = {}) {
    capture?.cancel();
    originalInput = structuredClone(input); sendTextKeys = Array.from(options.sendTextKeys || []); correctedInvalid = false; loadError = null; clearError(); search.value = '';
    try { original = normalizeOverrides(input); draft = structuredClone(original); }
    catch (error) { loadError = error; original = {}; draft = {}; showError(error); }
    render();
  }
  function onInput(event) { if (event.target === search) filter(); }
  function onKeydown(event) { if (event.target === search && event.key === 'Enter' && !event.isComposing) event.preventDefault(); }
  function focusRow(row) { const target = !row.input.disabled ? row.input : row.element.querySelector('.scut-keycap'); (target || row.input).focus(); }
  function commitAliases(id, keys) {
    if (!keys.length) { draft[id] = []; return; }
    try {
      if (JSON.stringify(normalizeOverrides({ [id]: keys })[id]) === JSON.stringify(rows.get(id).action.defaults.map(binding => binding.sequence))) delete draft[id];
      else draft[id] = keys;
    } catch { draft[id] = keys; }
  }
  function ensureCapture() { if (!capture) capture = createShortcutCapture({ parent: root.closest('dialog') }); return capture; }
  function openCapture(id, index) {
    const row = rows.get(id); if (!row || loadError) return;
    const current = [...shown(row.action)];
    if (index === null ? current.length >= 4 : index < 0 || index >= current.length) return;
    const nextKeys = sequence => index === null ? [...current, sequence] : current.map((value, position) => position === index ? sequence : value);
    const prospect = sequence => ({ ...draft, [id]: nextKeys(sequence) });
    ensureCapture().open({
      label: row.action.label + ' 단축키 ' + (index === null ? '추가' : '편집'),
      validate(sequence) { validateOverrides(prospect(sequence), { sendTextKeys }); },
      onAccept(sequence) {
        validateOverrides(prospect(sequence), { sendTextKeys });
        commitAliases(id, nextKeys(sequence));
        clearError(); render(); try { value(); } catch { /* 복원 충돌은 편집 가능한 초안으로 남긴다. */ } notify();
        const target = index === null ? current.length : index;
        queueMicrotask(() => {
          const dialog = root.closest('dialog');
          if (dialog && !dialog.open) return;
          const fresh = rows.get(id); if (!fresh || !fresh.element.isConnected) return;
          const keycaps = fresh.element.querySelectorAll('.scut-keycap');
          (keycaps[Math.min(target, keycaps.length - 1)] || fresh.input).focus();
        });
      }
    });
  }
  function deleteAlias(id, index) {
    const row = rows.get(id); if (!row) return;
    const keys = shown(row.action);
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) return;
    commitAliases(id, keys.filter((value, position) => position !== index));
  }
  function onClick(event) {
    const button = event.target.closest('button[data-scut]'); if (!button || !container.contains(button)) return;
    const command = button.dataset.scut, id = button.dataset.id;
    if (command === 'open' || command === 'edit-alias') { if (!loadError && rows.has(id)) openCapture(id, command === 'open' ? null : Number(button.dataset.index)); return; }
    if (command === 'resetall') { correctedInvalid ||= !!loadError; loadError = null; draft = {}; }
    else if (!loadError && rows.has(id)) {
      if (command === 'reset') delete draft[id];
      else if (command === 'off') draft[id] = [];
      else if (command === 'delete-alias') deleteAlias(id, Number(button.dataset.index));
      else return;
    } else return;
    clearError(); render(); try { value(); } catch { /* 복원 충돌은 편집 가능한 초안으로 남긴다. */ } notify();
    const row = rows.get(id); if (row) focusRow(row);
  }
  container.addEventListener('input', onInput); container.addEventListener('click', onClick); container.addEventListener('keydown', onKeydown);
  return {
    open, getValue: value, isDirty: dirty, showError,
    focusError() { const row = rows.get(errorIds[0]); if (row) { search.value = ''; filter(); focusRow(row); row.element.scrollIntoView({ block: 'nearest' }); } else errorBox.focus(); },
    cancel() { capture?.cancel(); open(originalInput, { sendTextKeys }); },
    destroy() { container.removeEventListener('input', onInput); container.removeEventListener('click', onClick); container.removeEventListener('keydown', onKeydown); capture?.destroy(); capture = null; container.remove(); rows.clear(); }
  };
}
module.exports = { createShortcutSettings };

