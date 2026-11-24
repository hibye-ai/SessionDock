import { createLayoutPersistence } from './layout-persistence.cjs';
import { applyPasswordVisibility, passwordToggleLabel } from './password-visibility.js';
// These managers only edit saved metadata. Connection/tab operations belong to ctx.
const AUTH_TYPES = [['password', '비밀번호'], ['key', '개인키 파일'], ['agent', 'SSH 에이전트']];
const ENCODINGS = [['utf-8', 'UTF-8'], ['cp949', '한국어 CP949'], ['euc-kr', '한국어 EUC-KR'], ['shift_jis', '일본어 Shift_JIS'], ['gb18030', '중국어 GB18030'], ['big5', '중국어 Big5']];
const MAX_WORKSPACES = 50;
const MIXED = '__operations_mixed__';
const clone = value => structuredClone(value);
const shared = session => !!(session?.sharedSourceId || session?.readOnly || session?.shared || String(session?.id || '').startsWith('shared_'));
const errorText = error => String(error?.message || error || '작업을 완료하지 못했습니다.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

function node(tag, className = '', text) {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}

function input(name, type = 'text', options = {}) {
  const result = node('input');
  result.name = name;
  result.type = type;
  Object.assign(result, options);
  return result;
}

function select(name, choices) {
  const result = node('select');
  result.name = name;
  for (const [value, label] of choices) {
    const option = node('option', '', label);
    option.value = value;
    result.append(option);
  }
  return result;
}

function label(text, control, className = '') {
  const result = node('label', className);
  result.append(node('span', '', text), control);
  return result;
}

function check(text, control) {
  const result = node('label', 'check-label');
  result.append(control, node('span', '', text));
  return result;
}

function button(text, action, className = 'secondary-button small') {
  const result = node('button', className, text);
  result.type = 'button';
  if (action) result.dataset.action = action;
  return result;
}

function hint(text) { return node('p', 'field-hint', text); }

function limitedNames(parent, items, getName = item => item.name) {
  parent.replaceChildren();
  const list = node('ul', 'operations-names');
  for (const item of items.slice(0, 12)) list.append(node('li', '', getName(item)));
  parent.append(list);
  if (items.length > 12) parent.append(hint(`외 ${items.length - 12}개 · 총 ${items.length}개`));
}

// Whitelist metadata even if an older/misconfigured API includes extra fields.
function credentialsFrom(result) {
  const rows = Array.isArray(result) ? result : result?.credentials;
  if (!Array.isArray(rows)) throw new Error('공통 계정 목록 응답이 올바르지 않습니다.');
  return rows.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id) throw new Error('공통 계정 ID가 올바르지 않습니다.');
    const usedBy = Array.isArray(item.usedBy) ? item.usedBy.map(session => typeof session === 'string'
      ? { id: session, name: session } : { id: String(session.id || ''), name: String(session.name || session.id || '') }) : [];
    return { id: item.id, name: String(item.name || ''), username: String(item.username || ''),
      authType: item.authType || 'password', hasPassphrase: !!item.hasPassphrase,
      privateKeyPath: String(item.privateKeyPath || ''), agentPath: String(item.agentPath || ''), usedBy,
      usageCount: Math.max(usedBy.length, Number.isInteger(item.usageCount) ? item.usageCount : 0,
        Number.isInteger(item.usedBy) ? item.usedBy : 0) };
  });
}

function layoutFrom(data) {
  const layout = data?.settings?.layout;
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new Error('화면 배치 설정을 불러오지 못했습니다.');
  return clone(layout);
}

/**
 * Install once after document.body exists. Dialogs are inserted synchronously;
 * open methods also show synchronously, with API failures reported inline.
 * API: listCredentials(), saveCredential(input), deleteCredential(id, {detach}),
 * bootstrap(), updateSessions({ids, patch}), readLayout(), saveLayout(layout).
 */
export function installOperationsUI(ctx) {
  const { api, state } = ctx;
  const layoutPersistence = ctx.layoutPersistence || createLayoutPersistence({api,onSaved:setLayout});
  const existing = document.getElementById('credentials-dialog');
  if (existing) throw new Error('운영 관리 UI가 이미 설치되어 있습니다.');
  const stylesheet = new URL('operations.css', document.baseURI).href;
  if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === stylesheet)) {
    const link = node('link'); link.rel = 'stylesheet'; link.href = stylesheet;
    link.dataset.operationsStyles = ''; document.head.append(link);
  }

  function announce(text) {
    try { Promise.resolve(ctx.toast?.(text)).catch(() => {}); } catch { /* Persistence has already succeeded. */ }
  }

  function dialog(id, title, className) {
    const element = node('dialog', `modal operations-modal ${className || ''}`);
    element.id = id;
    element.setAttribute('aria-labelledby', `${id}-title`);
    const form = node('form'); form.noValidate = true;
    const header = node('div', 'modal-header');
    const heading = node('h2', '', title); heading.id = `${id}-title`;
    const closeButton = button('×', 'close', 'icon-button modal-close');
    closeButton.setAttribute('aria-label', '닫기'); closeButton.title = '닫기';
    header.append(heading, closeButton);
    const controls = node('fieldset', 'operations-controls');
    const body = node('div', 'modal-body');
    const error = node('div', 'form-error operations-error');
    error.id = `${id}-error`; error.setAttribute('role', 'alert'); error.setAttribute('aria-live', 'assertive');
    const status = node('div', 'operations-status'); status.setAttribute('role', 'status');
    const footer = node('div', 'modal-footer');
    body.append(error, status); controls.append(body, footer); form.append(header, controls); element.append(form);
    document.body.append(element);
    let opener = null, cleaned = true, operation = 0;
    const view = { element, form, body, footer, error, status, busy: false, cancellable: false, generation: 0,
      focus: () => closeButton.focus(), onClose: () => {}, sync: () => {},
      nextFocus: null,
      setError(value) {
        error.textContent = value ? errorText(value) : '';
        if (value && element.open) error.scrollIntoView({ block: 'nearest' });
      },
      content(...children) { body.appendChild(node('div', 'operations-content')).append(...children); },
      show() {
        if (element.open) { view.focus(); return false; }
        if (view.busy) return false;
        opener = document.activeElement; cleaned = false; view.generation++;
        view.setError(''); status.textContent = ''; element.showModal(); view.focus(); return true;
      },
      cleanup() {
        if (cleaned) return;
        cleaned = true; view.generation++; view.onClose();
        if (view.busy && view.cancellable) {
          operation++; view.busy = false; controls.disabled = false; closeButton.disabled = false;
          element.setAttribute('aria-busy', 'false'); view.sync();
        }
      },
      close() {
        if (view.busy && !view.cancellable) return;
        view.cleanup(); element.close();
      },
      async run(task, { cancellable = false } = {}) {
        if (view.busy) return;
        const generation = view.generation, ticket = ++operation;
        view.busy = true; view.cancellable = cancellable; controls.disabled = true; closeButton.disabled = !cancellable;
        element.setAttribute('aria-busy', 'true'); view.setError('');
        try { await task(); }
        catch (error) { if (generation === view.generation && element.open) view.setError(error); }
        finally {
          if (ticket === operation) {
            view.busy = false; controls.disabled = false; closeButton.disabled = false;
            element.setAttribute('aria-busy', 'false'); view.sync();
            if (element.open && view.nextFocus && !view.nextFocus.matches(':disabled')) view.nextFocus.focus();
            else if (element.open && (!element.contains(document.activeElement) || document.activeElement === element || document.activeElement.matches(':disabled'))) view.focus();
            view.nextFocus = null;
          }
        }
      },
      on(control, event, callback, options) {
        control.addEventListener(event, e => {
          e.preventDefault();
          // Calling inside the async task catches synchronous validation errors too.
          void view.run(() => callback(e), options);
        });
      },
      finish() { view.cleanup(); element.close(); }
    };
    closeButton.addEventListener('click', () => view.close());
    form.addEventListener('submit', event => event.preventDefault());
    element.addEventListener('cancel', event => { event.preventDefault(); view.close(); });
    element.addEventListener('close', () => {
      // A queued close event must not clean a dialog that has since reopened.
      if (element.open) return;
      view.cleanup();
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    });
    return view;
  }

  const confirmation = dialog('operations-confirm-dialog', '확인', 'operations-confirm');
  const confirmationText = node('div', 'operations-confirm-text');
  confirmation.content(confirmationText);
  const decline = button('취소', 'cancel'), accept = button('확인', 'confirm', 'primary-button small');
  confirmation.footer.append(decline, accept);
  let resolveConfirmation = null;
  function resolveConfirm(value) {
    const resolve = resolveConfirmation; resolveConfirmation = null;
    confirmation.close(); resolve?.(value);
  }
  confirmation.focus = () => decline.focus();
  confirmation.onClose = () => { const resolve = resolveConfirmation; resolveConfirmation = null; resolve?.(false); };
  decline.addEventListener('click', () => resolveConfirm(false));
  accept.addEventListener('click', () => resolveConfirm(true));
  // Cancel keeps initial focus; removing or overwriting saved data uses the red action.
  function confirm(title, text, action, { danger = true } = {}) {
    if (resolveConfirmation) resolveConfirm(false);
    confirmation.element.querySelector('h2').textContent = title;
    confirmationText.textContent = text; accept.textContent = action; accept.classList.toggle('danger', danger);
    confirmation.show();
    return new Promise(resolve => { resolveConfirmation = resolve; });
  }

  // Credential manager: metadata is the only data ever copied into the editor.
  const credentials = dialog('credentials-dialog', '공통 계정 관리', 'operations-credentials');
  const credentialList = select('credentialList', []); credentialList.size = 11; credentialList.id = 'operations-credential-list';
  const credentialTools = node('div', 'operations-toolbar');
  const newCredential = button('새 계정', 'credential-new'), reloadCredentials = button('새로고침', 'credential-refresh');
  credentialTools.append(newCredential, reloadCredentials);
  const credentialSidebar = node('div', 'operations-list-panel');
  credentialSidebar.append(label('공통 계정', credentialList), credentialTools);
  const credentialEditor = node('div', 'operations-editor');
  const credentialFields = {
    name: input('name', 'text', { maxLength: 256, required: true, autocomplete: 'off', placeholder: '예시 공통 계정 1' }),
    username: input('username', 'text', { maxLength: 256, autocomplete: 'off' }),
    authType: select('authType', AUTH_TYPES),
    privateKeyPath: input('privateKeyPath', 'text', { maxLength: 4096, autocomplete: 'off' }),
    passphrase: input('passphrase', 'password', { autocomplete: 'new-password', maxLength: 16384 }),
    agentPath: input('agentPath', 'text', { maxLength: 4096, autocomplete: 'off', placeholder: '비워 두면 Windows OpenSSH 에이전트 사용' }),

    clearPassphrase: input('clearPassphrase', 'checkbox')
  };
  function credentialActionField(title, control, actionButton) {
    control.id = `operations-credential-${control.name}`;
    const caption = node('label', '', title); caption.htmlFor = control.id;
    const row = node('div', 'operations-input-action'); row.append(control, actionButton);
    const field = node('div', 'operations-credential-field'); field.append(caption, row);
    return field;
  }
  const browseCredentialKey = button('찾아보기…', 'credential-browse-key');
  browseCredentialKey.setAttribute('aria-label', '개인키 파일 찾아보기');
  const secretToggles = new Map();
  function credentialSecretField(title, control) {
    // Same eye glyph as the session dialog: the control is a transparent
    // overlay button inside the field so it never grows the form row.
    const toggle = node('button', `password-toggle-button credential-toggle-${control.name}`);
    toggle.type = 'button'; toggle.dataset.action = `credential-toggle-${control.name}`;
    toggle.setAttribute('aria-label', passwordToggleLabel(title, false));
    toggle.title = passwordToggleLabel(title, false);
    const field = credentialActionField(title, control, toggle);
    field.classList.add('operations-secret-field');
    toggle.setAttribute('aria-controls', control.id);
    secretToggles.set(control, { toggle, title });
    applyPasswordVisibility(control, toggle, false, title);
    toggle.addEventListener('click', () => {
      if (control.disabled) return;
      applyPasswordVisibility(control, toggle, control.type === 'password', title);
    });
    return field;
  }
  const passwordPolicyHint = hint('공통 계정에는 비밀번호를 저장하지 않습니다. 연결할 때 비밀번호를 입력해 주세요.');
  const keyField = credentialActionField('개인키 파일 경로', credentialFields.privateKeyPath, browseCredentialKey);
  const passphraseField = credentialSecretField('새 개인키 암호', credentialFields.passphrase);
  const passphraseHint = hint('저장된 개인키 암호는 표시하지 않으며 비워 두면 기존 값을 유지합니다.');
  const agentField = label('SSH 에이전트 경로', credentialFields.agentPath);

  const clearPassphraseField = check('저장된 개인키 암호 삭제', credentialFields.clearPassphrase);
  const credentialMetadata = node('div', 'operations-metadata');
  const credentialUsage = node('div', 'operations-usage');
  credentialEditor.append(label('이름', credentialFields.name), label('사용자 이름', credentialFields.username),
    label('인증 방식', credentialFields.authType), passwordPolicyHint, keyField, passphraseField, passphraseHint, agentField,
    clearPassphraseField, credentialMetadata, credentialUsage);
  const credentialColumns = node('div', 'operations-columns'); credentialColumns.append(credentialSidebar, credentialEditor);
  credentials.content(credentialColumns);
  const deleteCredential = button('삭제…', 'credential-delete', 'secondary-button small operations-danger');
  const saveCredential = button('저장', 'credential-save', 'primary-button small'); saveCredential.type = 'submit';
  const closeCredentials = button('닫기', 'close');
  deleteCredential.classList.add('footer-start');
  credentials.footer.append(deleteCredential, closeCredentials, saveCredential);
  let credentialRows = [], credentialSessionRows = [], credentialId = '', credentialsLoaded = false;

  function clearPasswordFields() {
    for (const [control, { toggle, title }] of secretToggles) {
      control.value = '';
      applyPasswordVisibility(control, toggle, false, title);
    }
  }
  function updateCredentialFields() {
    const type = credentialFields.authType.value;
    const item = credentialRows.find(row => row.id === credentialId);
    passwordPolicyHint.hidden = type !== 'password';
    keyField.hidden = passphraseField.hidden = passphraseHint.hidden = type !== 'key';
    agentField.hidden = type !== 'agent';
    credentialFields.passphrase.disabled = type !== 'key' || credentialFields.clearPassphrase.checked;
    for (const [control, { toggle }] of secretToggles) toggle.disabled = control.disabled;

    clearPassphraseField.hidden = !credentialId || !item?.hasPassphrase;

    if (clearPassphraseField.hidden) credentialFields.clearPassphrase.checked = false;
    deleteCredential.disabled = !credentialsLoaded || !credentialId;
    saveCredential.disabled = !credentialsLoaded;
  }
  function references(item, sessions = credentialSessionRows, bindings = state.settings?.sharedCredentialBindings || {}, sources = state.sharedSources || []) {
    const local = sessions.filter(session => !shared(session) && session.credentialId === item.id);
    const names = new Map(item.usedBy.map(session => [session.id, session.name]));
    for (const session of local) names.set(session.id, session.name);
    for(const [sourceId,credentialId] of Object.entries(bindings))if(credentialId===item.id)names.set(`shared:${sourceId}`,`공유 목록: ${sources.find(source=>source.id===sourceId)?.name||sourceId}`);
    return { count: Math.max(item.usageCount, names.size), names: [...names.values()] };
  }
  function editCredential(id = '') {
    credentialId = id;
    const item = credentialRows.find(row => row.id === id);
    for (const key of ['name', 'username', 'privateKeyPath', 'agentPath']) credentialFields[key].value = item?.[key] || '';
    credentialFields.authType.value = item?.authType || 'password';
    credentialFields.clearPassphrase.checked = false; clearPasswordFields(); credentialList.value = item?.id || '';
    credentialMetadata.replaceChildren(node('h3', '', '암호 저장 상태'));
    const badges = node('div', 'operations-secret-badges');

    const ppBadge = node('span', `operations-secret-badge${item?.hasPassphrase ? ' is-stored' : ''}`, `개인키 암호: ${item?.hasPassphrase ? '저장됨' : '없음'}`);
    badges.append(ppBadge);
    credentialMetadata.append(badges);
    credentialUsage.replaceChildren(node('h3', '', '사용 중인 세션·공유 목록'));
    if (item) {
      const usage = references(item);
      credentialUsage.append(node('p', 'operations-usage-summary', usage.count
        ? `이 PC에서 ${usage.count}개 세션·공유 목록이 사용 중입니다.`
        : '사용 중인 세션이 없습니다.'));
      if (usage.names.length) limitedNames(credentialUsage.appendChild(node('div')), usage.names, name => name);
      else if (usage.count) credentialUsage.append(hint('사용처 이름을 불러오지 못했습니다.'));
    } else credentialUsage.append(hint('저장한 뒤 세션에서 이 공통 계정을 선택하세요.'));
    credentials.setError(''); updateCredentialFields();
  }
  function renderCredentials(preferred = credentialId) {
    credentialList.replaceChildren();
    for (const row of credentialRows) {
      const authLabel = AUTH_TYPES.find(([value]) => value === row.authType)?.[1] || row.authType;
      const option = node('option', '', `${row.name} · ${row.username || '계정명 없음'} (${authLabel})`);
      option.value = row.id; option.title = option.textContent; credentialList.append(option);
    }
    credentialList.disabled = credentialRows.length === 0;
    credentials.status.textContent = credentialRows.length ? `공통 계정 ${credentialRows.length}개` : '등록된 공통 계정이 없습니다. 새 계정을 추가하세요.';
    editCredential(credentialRows.some(row => row.id === preferred) ? preferred : credentialRows[0]?.id || '');
  }
  async function loadCredentials(preferred = credentialId) {
    const generation = credentials.generation;
    const [result, data] = await Promise.all([api.listCredentials(), api.bootstrap()]);
    const rows = credentialsFrom(result);
    if (!Array.isArray(data.sessions)) throw new Error('공통 계정 사용처를 불러오지 못했습니다.');
    if (generation !== credentials.generation || !credentials.element.open) return;
    credentialRows = rows; credentialSessionRows = data.sessions; state.credentials = clone(rows);
    credentialsLoaded = true; renderCredentials(preferred);
  }
  credentials.sync = updateCredentialFields;
  credentials.focus = () => (credentialRows.length ? credentialList : credentialFields.name).focus();
  credentials.onClose = () => { clearPasswordFields(); credentialFields.clearPassphrase.checked = false; credentialSessionRows=[]; credentialRows=[]; credentialList.replaceChildren(); };
  credentialList.addEventListener('change', () => editCredential(credentialList.value));
  credentialFields.authType.addEventListener('change', () => { clearPasswordFields(); updateCredentialFields(); });

  credentialFields.clearPassphrase.addEventListener('change', () => { if (credentialFields.clearPassphrase.checked) clearPasswordFields(); updateCredentialFields(); });
  newCredential.addEventListener('click', () => { editCredential(); credentialFields.name.focus(); });
  closeCredentials.addEventListener('click', () => credentials.close());
  credentials.on(reloadCredentials, 'click', () => loadCredentials(), { cancellable: true });
  credentials.on(browseCredentialKey, 'click', async () => {
    const generation = credentials.generation;
    let selectedPath;
    try { selectedPath = await api.chooseKey(); }
    catch { throw new Error('개인키 파일을 선택하지 못했습니다. 다시 시도하세요.'); }
    if (generation !== credentials.generation || !credentials.element.open) return;
    if (selectedPath) credentialFields.privateKeyPath.value = selectedPath;
    credentials.nextFocus = credentialFields.privateKeyPath;
  }, { cancellable: true });
  credentials.on(credentials.form, 'submit', async () => {
    const name = credentialFields.name.value.trim();
    if (!name) { credentials.nextFocus = credentialFields.name; throw new Error('공통 계정 이름을 입력하세요.'); }
    const payload = { name, username: credentialFields.username.value.trim(), authType: credentialFields.authType.value,
      privateKeyPath: credentialFields.privateKeyPath.value.trim(), agentPath: credentialFields.agentPath.value.trim() };
    if (credentialId) payload.id = credentialId;

    if (credentialFields.clearPassphrase.checked) payload.clearPassphrase = true;
    else if (payload.authType === 'key' && credentialFields.passphrase.value) payload.passphrase = credentialFields.passphrase.value;
    try {
      const saved = await api.saveCredential(payload);
      if (saved?.id) {
        const metadata = credentialsFrom([saved])[0];
        credentialRows = credentialRows.some(item => item.id === metadata.id)
          ? credentialRows.map(item => item.id === metadata.id ? metadata : item) : [...credentialRows, metadata];
        state.credentials = clone(credentialRows); renderCredentials(metadata.id);
      }
      clearPasswordFields(); credentialFields.clearPassphrase.checked = false;
      credentials.status.textContent = '공통 계정을 저장했습니다.';
      try { await loadCredentials(saved?.id || credentialId); }
      catch (error) { throw new Error(`공통 계정은 저장되었습니다. 목록 새로고침에 실패했습니다: ${errorText(error)}`); }
      announce('공통 계정을 저장했습니다.');
    } catch (error) {
      let text = errorText(error);
      if (payload.passphrase) text = text.split(payload.passphrase).join('[숨김]');
      throw new Error(text);
    } finally {
      clearPasswordFields(); delete payload.passphrase;
    }
  });
  credentials.on(deleteCredential, 'click', async () => {
    const id = credentialId;
    const [result, data] = await Promise.all([api.listCredentials(), api.bootstrap()]);
    const item = credentialsFrom(result).find(row => row.id === id);
    if (!item) { await loadCredentials(); throw new Error('공통 계정이 이미 삭제되었습니다.'); }
    if (!Array.isArray(data.sessions)) throw new Error('공통 계정 사용처를 불러오지 못했습니다.');
    const usage = references(item, data.sessions, data.settings?.sharedCredentialBindings || {}, data.sharedSources || []), detach = usage.count > 0;
    const names = usage.names.slice(0, 12).join('\n');
    const text = detach
      ? `“${item.name}” 참조(${usage.count}곳)를 해제하고 계정과 암호를 삭제합니다(세션·공유 원본 유지).\n${names}${usage.count > 12 ? `\n외 ${usage.count - 12}개` : ''}`
      : `“${item.name}” 공통 계정과 저장된 암호를 삭제합니다.`;
    if (!await confirm(detach ? '참조 해제 후 공통 계정 삭제' : '공통 계정 삭제', text, detach ? '참조 해제 후 삭제' : '삭제')) return;
    await api.deleteCredential(id, { detach });
    clearPasswordFields(); credentialId = ''; credentialRows = credentialRows.filter(item => item.id !== id);
    state.credentials = clone(credentialRows); renderCredentials();
    try { await Promise.all([loadCredentials(), ctx.refreshData?.()]); }
    catch (error) { throw new Error(`공통 계정은 삭제되었습니다. 목록 새로고침에 실패했습니다: ${errorText(error)}`); }
    announce('공통 계정을 삭제했습니다.');
  });

  // Bulk editor: each Apply checkbox has its own independent patch key.
  const bulk = dialog('bulk-edit-dialog', '선택 세션 일괄 설정', 'operations-bulk');
  const bulkSelection = node('div', 'operations-selection');
  const bulkNames = node('div'); bulkSelection.append(node('strong', '', '선택한 로컬 세션'), bulkNames);
  const bulkRules = hint('로컬 세션만 대상이며 ‘적용’을 체크한 항목만 저장합니다.');
  const bulkConnections = hint('변경한 연결 설정은 다음 연결부터 적용됩니다.');
  const bulkFields = node('div', 'operations-bulk-fields');
  const definitions = [
    { key: 'port', title: '포트', number: [1, 65535], fallback: 22 },
    { key: 'username', title: '사용자 이름', max: 256, empty: true, fallback: '', help: '빈 값: 사용자 이름 지움' },
    { key: 'authType', title: '인증 방식', choices: AUTH_TYPES, fallback: 'password' },
    { key: 'credentialId', title: '공통 계정', choices: [['', '지정 안 함 · 세션 자체 계정']], empty: true, fallback: '' },
    { key: 'terminalType', title: '터미널 타입', max: 64, fallback: 'xterm-256color' },
    { key: 'encoding', title: '문자 인코딩', choices: ENCODINGS, fallback: 'utf-8' },
    { key: 'keepaliveInterval', title: 'Keepalive 간격 (초)', number: [0, 86400], fallback: 30, help: '0: 사용 안 함' },
    { key: 'handshakeTimeout', title: 'SSH 연결 제한 시간 (초)', number: [5, 300], fallback: 30 },
    { key: 'autoReconnect', title: '자동 재접속', boolean: true, fallback: false },
    { key: 'reconnectDelay', title: '재접속 대기 (초)', number: [1, 300], fallback: 5 },
    { key: 'reconnectAttempts', title: '재접속 시도 횟수', number: [1, 10], fallback: 1 },
    { key: 'logEnabled', title: '세션 로그', boolean: true, fallback: false },
    { key: 'fontSize', title: '글자 크기 (px)', number: [0, 48], fallback: 0, help: '0: 전체 설정 · 직접 지정: 10–48' }
  ];
  const bulkControls = new Map();
  for (const definition of definitions) {
    const choices = definition.boolean ? [['true', '사용'], ['false', '사용 안 함']] : definition.choices;
    const control = choices ? select(definition.key, choices) : input(definition.key, definition.number ? 'number' : 'text');
    if (definition.number) { control.min = definition.number[0]; control.max = definition.number[1]; control.step = '1'; }
    if (definition.max) control.maxLength = definition.max;
    control.id = `bulk-${definition.key}`; control.disabled = true;
    control.setAttribute('aria-label', definition.title);
    const apply = input(`apply-${definition.key}`, 'checkbox'); apply.setAttribute('aria-label', `${definition.title} 적용`);
    const row = node('div', 'operations-bulk-row');
    const applyLabel = check(`${definition.title} 적용`, apply);
    const value = node('div', 'operations-bulk-value'); value.append(control);
    if (definition.help) value.append(hint(definition.help));
    row.append(applyLabel, value); bulkFields.append(row);
    bulkControls.set(definition.key, { apply, control });
    apply.addEventListener('change', () => { control.disabled = !apply.checked; invalidatePreview(); });
    control.addEventListener('input', invalidatePreview); control.addEventListener('change', invalidatePreview);
  }
  const bulkPreview = node('section', 'operations-preview'); bulkPreview.hidden = true;
  bulkPreview.setAttribute('aria-label', '변경 미리보기'); bulkPreview.setAttribute('aria-live', 'polite');
  bulk.content(bulkSelection, bulkRules, bulkConnections, bulkFields, bulkPreview);
  const previewBulk = button('변경 미리보기', 'bulk-preview'), applyBulk = button('선택 세션에 적용', 'bulk-apply', 'primary-button small');
  const closeBulk = button('취소', 'close'); previewBulk.classList.add('footer-start'); bulk.footer.append(previewBulk, closeBulk, applyBulk);
  let bulkIds = [], bulkRows = [], bulkCredentialRows = [], bulkLoaded = false, preview = null;

  function invalidatePreview() { preview = null; bulkPreview.hidden = true; applyBulk.disabled = true; bulk.setError(''); }
  function localSessions(data) {
    if (!Array.isArray(data.sessions)) throw new Error('세션 목록을 불러오지 못했습니다.');
    if (!bulkIds.length) throw new Error('변경할 로컬 세션을 먼저 선택하세요.');
    const byId = new Map(data.sessions.map(session => [session.id, session]));
    return bulkIds.map(id => {
      const session = byId.get(id);
      if (String(id).startsWith('shared_') || shared(session)) throw new Error('공유 세션은 읽기 전용입니다. 로컬 세션만 선택하세요. 선택 항목은 변경하지 않았습니다.');
      if (!session) throw new Error('선택한 세션이 삭제되었거나 목록이 변경되었습니다. 세션을 다시 선택하세요.');
      return session;
    });
  }
  function fieldValue(session, definition) {
    return session[definition.key] ?? (definition.key === 'port' && session.protocol === 'telnet' ? 23 : definition.fallback);
  }
  function fillBulk(rows) {
    const credentialChoices = bulkControls.get('credentialId').control;
    credentialChoices.replaceChildren();
    for (const [value, text] of [['', '지정 안 함 · 세션 자체 계정'], ...bulkCredentialRows.map(item => [item.id, item.name])]) {
      const option = node('option', '', text); option.value = value; credentialChoices.append(option);
    }
    for (const definition of definitions) {
      const { apply, control } = bulkControls.get(definition.key);
      control.querySelector?.(`option[value="${MIXED}"]`)?.remove();
      const values = rows.map(session => fieldValue(session, definition));
      const different = values.some(value => value !== values[0]);
      apply.checked = false; control.disabled = true;
      if (control.tagName === 'SELECT' && different) {
        const option = node('option', '', '서로 다름 · 값 선택'); option.value = MIXED; option.disabled = true;
        control.prepend(option); control.value = MIXED;
      } else {
        const value = String(values[0] ?? '');
        if (control.tagName === 'SELECT' && ![...control.options].some(option => option.value === value)) {
          const option = node('option', '', `사용 불가: ${value}`); option.value = value; option.disabled = true; control.append(option);
        }
        control.value = different ? '' : value;
        control.placeholder = different ? (definition.empty ? '서로 다름 · 빈 값은 지움' : '서로 다름 · 값 입력') : '';
      }
    }
    limitedNames(bulkNames, rows);
    bulk.status.textContent = `로컬 세션 ${rows.length}개 선택 · 공유 세션 제외`;
    invalidatePreview();
  }
  function readPatch() {
    const patch = {};
    for (const definition of definitions) {
      const { apply, control } = bulkControls.get(definition.key);
      if (!apply.checked) continue;
      const value = control.value.trim();
      const invalid = text => { bulk.nextFocus = control; throw new Error(`${definition.title}: ${text}`); };
      if (value === MIXED) invalid('적용할 값을 선택하세요.');
      if (definition.number) {
        if (!/^\d+$/.test(value)) invalid('정수를 입력하세요. 빈 값으로 지울 수 없습니다.');
        const number = Number(value), [min, max] = definition.number;
        if (!Number.isSafeInteger(number) || number < min || number > max || (definition.key === 'fontSize' && number !== 0 && number < 10)) invalid(definition.help || `${min}–${max} 범위의 정수를 입력하세요.`);
        patch[definition.key] = number;
      } else if (definition.boolean) {
        if (!['true', 'false'].includes(value)) invalid('사용 여부를 선택하세요.');
        patch[definition.key] = value === 'true';
      } else {
        if (!value && !definition.empty) invalid('빈 값으로 지울 수 없습니다.');
        if (definition.max && value.length > definition.max) invalid(`최대 ${definition.max}자입니다.`);
        if (/[\x00-\x1f\x7f]/.test(value)) invalid('제어 문자를 사용할 수 없습니다.');
        if (definition.key === 'terminalType' && !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(value)) invalid('올바른 터미널 타입을 입력하세요.');
        if (definition.choices && definition.key !== 'credentialId' && !definition.choices.some(choice => choice[0] === value)) invalid('지원하는 값을 선택하세요.');
        if (definition.key === 'credentialId' && value && !bulkCredentialRows.some(item => item.id === value)) invalid('사용할 수 있는 공통 계정을 선택하세요.');
        patch[definition.key] = value;
      }
    }
    if (!Object.keys(patch).length) throw new Error('변경할 항목의 적용 체크박스를 선택하세요.');
    return patch;
  }
  function displayValue(key, value) {
    if (key === 'credentialId') return value ? bulkCredentialRows.find(item => item.id === value)?.name || `사용 불가: ${value}` : '지정 안 함';
    if (typeof value === 'boolean') return value ? '사용' : '사용 안 함';
    if (key === 'authType') return AUTH_TYPES.find(choice => choice[0] === value)?.[1] || value;
    if (key === 'fontSize' && value === 0) return '0 (전체 설정)';
    return value === '' ? '(빈 값 · 지움)' : String(value);
  }
  function differences(rows, patch) {
    return rows.map(session => ({ session, fields: definitions.filter(definition => Object.hasOwn(patch, definition.key)
      && fieldValue(session, definition) !== patch[definition.key]) })).filter(item => item.fields.length);
  }
  function fingerprint(rows, patch) {
    return JSON.stringify(rows.map(session => [session.id, session.name, ...definitions.filter(definition => Object.hasOwn(patch, definition.key)).map(definition => fieldValue(session, definition))]));
  }
  function renderPreview(rows, patch) {
    const changes = differences(rows, patch);
    const effective = Object.fromEntries(Object.entries(patch).filter(([key]) => changes.some(item => item.fields.some(definition => definition.key === key))));
    bulkPreview.replaceChildren(node('h3', '', '저장 전 변경 미리보기'));
    if (!changes.length) {
      preview = null; applyBulk.disabled = true; bulkPreview.hidden = false;
      bulkPreview.append(hint('선택한 값과 저장된 값이 같습니다. 변경할 내용이 없습니다.')); return;
    }
    bulkPreview.append(hint(`선택 ${rows.length}개 중 ${changes.length}개 세션 변경 · ${Object.keys(effective).length}개 항목`));
    const summary = node('dl', 'operations-changes');
    for (const definition of definitions.filter(item => Object.hasOwn(effective, item.key))) {
      const count = changes.filter(item => item.fields.includes(definition)).length;
      summary.append(node('dt', '', definition.title), node('dd', '', `${displayValue(definition.key, effective[definition.key])} · ${count}개 세션`));
    }
    bulkPreview.append(summary);
    for (const { session, fields } of changes.slice(0, 12)) {
      const item = node('div', 'operations-preview-session'); item.append(node('strong', '', session.name));
      for (const definition of fields) item.append(node('div', '', `${definition.title}: ${displayValue(definition.key, fieldValue(session, definition))} → ${displayValue(definition.key, patch[definition.key])}`));
      bulkPreview.append(item);
    }
    if (changes.length > 12) bulkPreview.append(hint(`외 ${changes.length - 12}개 변경 · 총 ${changes.length}개`));
    preview = { patch: effective, fingerprint: fingerprint(rows, effective) };
    bulkPreview.hidden = false; applyBulk.disabled = false;
  }
  bulk.sync = () => { previewBulk.disabled = !bulkLoaded; applyBulk.disabled = !bulkLoaded || !preview; };
  bulk.focus = () => (bulkLoaded ? previewBulk : closeBulk).focus();
  bulk.onClose = () => { preview = null;bulkRows=[];bulkIds=[];bulkNames.replaceChildren();bulkPreview.replaceChildren(); };
  closeBulk.addEventListener('click', () => bulk.close());
  bulk.on(previewBulk, 'click', async () => {
    const patch = readPatch(), generation = bulk.generation;
    const rows = localSessions(await api.bootstrap());
    if (generation !== bulk.generation || !bulk.element.open) return;
    bulkRows = rows; renderPreview(bulkRows, patch);
  }, { cancellable: true });
  bulk.on(applyBulk, 'click', async () => {
    if (!preview) throw new Error('변경 미리보기를 먼저 확인하세요.');
    const approved = preview;
    const rows = localSessions(await api.bootstrap());
    if (fingerprint(rows, approved.patch) !== approved.fingerprint) {
      renderPreview(rows, approved.patch);
      throw new Error('미리보기 이후 세션 내용이 변경되었습니다. 최신 변경 미리보기를 확인한 뒤 다시 적용하세요.');
    }
    const request = { ids: [...bulkIds], patch: { ...approved.patch } };
    // The backend supports this optional guard against a write between the
    // last bootstrap and the atomic update. Legacy fixtures may lack dates.
    if (rows.every(session => typeof session.updatedAt === 'string')) request.expectedUpdatedAt = Object.fromEntries(rows.map(session => [session.id, session.updatedAt]));
    await api.updateSessions(request);
    preview = null; applyBulk.disabled = true;
    bulk.status.textContent = '일괄 변경을 저장했습니다.';
    try { if (ctx.refreshData) await ctx.refreshData(); }
    catch (error) { bulkLoaded = false; throw new Error(`변경은 저장되었습니다. 목록 새로고침에 실패했습니다: ${errorText(error)}`); }
    bulk.finish(); announce('선택한 로컬 세션의 설정을 저장했습니다.');
  });

  // Named workspaces are kept alongside, never in place of, legacy layout.workspace.
  const workspaces = dialog('workspaces-dialog', '작업공간 관리', 'operations-workspaces');
  const workspaceList = select('workspaceList', []); workspaceList.size = 11; workspaceList.id = 'operations-workspace-list';
  const reloadWorkspaces = button('새로고침', 'workspace-refresh');
  const workspaceSidebar = node('div', 'operations-list-panel'); workspaceSidebar.append(label('저장한 작업공간', workspaceList), reloadWorkspaces);
  const workspaceName = input('workspaceName', 'text', { maxLength: 256, required: true, autocomplete: 'off', placeholder: '예시 작업공간 1' });
  const workspaceDetails = node('div', 'operations-workspace-details');
  const workspaceEditor = node('div', 'operations-editor');
  const workspaceTools = node('div', 'operations-toolbar');
  const addWorkspace = button('현재 탭으로 추가', 'workspace-add');
  const updateWorkspace = button('현재 탭으로 덮어쓰기', 'workspace-update');
  const renameWorkspace = button('이름 변경', 'workspace-rename');
  const duplicateWorkspace = button('복제', 'workspace-duplicate');
  const deleteWorkspace = button('삭제…', 'workspace-delete', 'secondary-button small operations-danger');
  workspaceTools.append(addWorkspace, updateWorkspace, renameWorkspace, duplicateWorkspace, deleteWorkspace);
  workspaceEditor.append(label('작업공간 이름', workspaceName), workspaceTools,
    hint('현재 탭 순서·선택 탭·분할 배치를 저장합니다. 이름은 중복 없이 입력하세요(최대 50개).'),
    hint('[열기]를 누르면 저장된 세션에 연결하고 배치를 복원합니다.'), workspaceDetails);
  const workspaceColumns = node('div', 'operations-columns'); workspaceColumns.append(workspaceSidebar, workspaceEditor);
  workspaces.content(workspaceColumns);
  const openWorkspace = button('열기', 'workspace-open', 'primary-button small'), closeWorkspaces = button('닫기', 'close');
  workspaces.footer.append(closeWorkspaces, openWorkspace);
  let workspaceRows = [], workspaceId = '', workspacesLoaded = false;

  function namedWorkspaces(layout) {
    if (layout.workspaces === undefined) return [];
    if (!Array.isArray(layout.workspaces)) throw new Error('작업공간 목록이 올바르지 않습니다.');
    return clone(layout.workspaces);
  }
  function setLayout(layout) {
    if (!state.settings) state.settings = {};
    state.settings.layout = clone(layout);
  }
  function selectedWorkspace() { return workspaceRows.find(item => item.id === workspaceId); }
  function syncWorkspaces() {
    const selected = !!selectedWorkspace();
    for (const control of [updateWorkspace, renameWorkspace, duplicateWorkspace, deleteWorkspace, openWorkspace]) control.disabled = !workspacesLoaded || !selected;
    addWorkspace.disabled = !workspacesLoaded || workspaceRows.length >= MAX_WORKSPACES;
    duplicateWorkspace.disabled ||= workspaceRows.length >= MAX_WORKSPACES;
    workspaceList.disabled = !workspaceRows.length;
  }
  function selectWorkspace(id) {
    workspaceId = id; workspaceList.value = id;
    const item = selectedWorkspace(); workspaceName.value = item?.name || '';
    workspaceDetails.replaceChildren(); workspaces.setError('');
    if (item) {
      const descriptor = item.workspace;
      const ids = Array.isArray(descriptor?.sessionIds) ? descriptor.sessionIds : [];
      const byId = new Map((state.sessions || []).map(session => [session.id, session]));
      workspaceDetails.append(hint(`탭 ${ids.length}개 · ${descriptor?.split ? (descriptor.splitDirection === 'rows' ? '위아래 분할' : '좌우 분할') : '일반 탭 보기'}`));
      limitedNames(workspaceDetails.appendChild(node('div')), ids, id => byId.get(id)?.name || `사용할 수 없는 세션: ${id}`);
    } else workspaceDetails.append(hint('이름을 입력하고 현재 탭으로 추가를 누르세요.'));
    syncWorkspaces();
  }
  function renderWorkspaces(layout, preferred = layout.selectedWorkspaceId) {
    workspaceRows = namedWorkspaces(layout); workspaceList.replaceChildren();
    for (const item of workspaceRows) { const option = node('option', '', item.name); option.value = item.id; workspaceList.append(option); }
    workspaces.status.textContent = `작업공간 ${workspaceRows.length}/${MAX_WORKSPACES}개`;
    selectWorkspace(workspaceRows.some(item => item.id === preferred) ? preferred : workspaceRows[0]?.id || '');
  }
  async function loadWorkspaces() {
    const generation = workspaces.generation, layout = layoutFrom(await layoutPersistence.readData());
    if (generation !== workspaces.generation || !workspaces.element.open) return;
    workspacesLoaded = true; setLayout(layout); renderWorkspaces(layout);
  }
  function requiredWorkspaceName() {
    const name = workspaceName.value.trim();
    if (!name || name.length > 256 || /[\x00-\x1f\x7f]/.test(name)) {
      workspaces.nextFocus = workspaceName; throw new Error('작업공간 이름을 1–256자로 입력하세요.');
    }
    return name;
  }
  function uniqueName(rows, name, exceptId = '') {
    if (rows.some(item => item.id !== exceptId && item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('같은 이름의 작업공간이 있습니다. 다른 이름을 입력하세요.');
  }
  function requireUnchanged(rows, expected) {
    const current = rows.find(item => item.id === expected?.id);
    if (!current) throw new Error('작업공간이 삭제되었습니다. 새로고침 후 다시 선택하세요.');
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('다른 작업에서 작업공간을 변경했습니다. 새로고침 후 다시 확인하세요.');
    return current;
  }
  async function persistWorkspaces(change) {
    // Read/mutate in the shared queue, after every earlier autosave or settings
    // response. Confirmation remains outside the queue and its conflict check
    // still runs against the latest stored collection.
    const { layout, result } = await layoutPersistence.update(current => {
      const rows = namedWorkspaces(current);
      const { selectedId, result } = change(rows, current);
      if (rows.length > MAX_WORKSPACES) throw new Error('작업공간은 최대 50개까지 저장할 수 있습니다.');
      return {patch:{workspaces:rows,selectedWorkspaceId:selectedId||''},result};
    });
    setLayout(layout); workspacesLoaded = true; renderWorkspaces(layout);
    return result;
  }
  async function currentWorkspace() {
    if (typeof ctx.captureWorkspace !== 'function') throw new Error('현재 탭 배치를 가져오는 기능이 연결되지 않았습니다.');
    const descriptor = await ctx.captureWorkspace();
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('현재 탭 배치를 가져오지 못했습니다.');
    return clone(descriptor);
  }
  workspaces.sync = syncWorkspaces;
  workspaces.focus = () => (workspaceRows.length ? workspaceList : workspaceName).focus();
  workspaceList.addEventListener('change', () => selectWorkspace(workspaceList.value));
  closeWorkspaces.addEventListener('click', () => workspaces.close());
  workspaces.on(reloadWorkspaces, 'click', loadWorkspaces, { cancellable: true });
  workspaces.on(addWorkspace, 'click', async () => {
    const name = requiredWorkspaceName(), workspace = await currentWorkspace();
    const id = crypto.randomUUID();
    await persistWorkspaces(rows => {
      uniqueName(rows, name); rows.push({ id, name, workspace }); return { selectedId: id };
    });
    announce('현재 탭 배치를 새 작업공간으로 저장했습니다.');
  });
  workspaces.on(updateWorkspace, 'click', async () => {
    const expected = clone(selectedWorkspace()), name = requiredWorkspaceName();
    const workspace = await currentWorkspace();
    if (!await confirm('작업공간 덮어쓰기', `“${expected.name}”을 현재 탭 순서와 배치로 덮어씁니다.`, '덮어쓰기')) return;
    await persistWorkspaces(rows => {
      const item = requireUnchanged(rows, expected); uniqueName(rows, name, item.id);
      item.name = name; item.workspace = workspace; return { selectedId: item.id };
    });
    announce('현재 탭 배치로 작업공간을 갱신했습니다.');
  });
  workspaces.on(renameWorkspace, 'click', async () => {
    const expected = clone(selectedWorkspace()), name = requiredWorkspaceName();
    await persistWorkspaces(rows => {
      const item = requireUnchanged(rows, expected); uniqueName(rows, name, item.id); item.name = name;
      return { selectedId: item.id };
    });
    announce('작업공간 이름을 변경했습니다.');
  });
  workspaces.on(duplicateWorkspace, 'click', async () => {
    const expected = clone(selectedWorkspace()), requested = requiredWorkspaceName(), id = crypto.randomUUID();
    await persistWorkspaces(rows => {
      const source = requireUnchanged(rows, expected);
      let name = requested;
      if (name.toLocaleLowerCase() === source.name.toLocaleLowerCase()) {
        let suffix = 1;
        do { name = `${source.name.slice(0, 238)} 복사${suffix === 1 ? '' : ` ${suffix}`}`; suffix++; }
        while (rows.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase()));
      }
      uniqueName(rows, name); rows.push({ id, name, workspace: clone(source.workspace) }); return { selectedId: id };
    });
    announce('작업공간을 복제했습니다.');
  });
  workspaces.on(deleteWorkspace, 'click', async () => {
    const expected = clone(selectedWorkspace());
    if (!await confirm('작업공간 삭제', `“${expected.name}” 작업공간을 삭제합니다. 세션과 현재 연결은 유지됩니다.`, '삭제')) return;
    await persistWorkspaces(rows => {
      const item = requireUnchanged(rows, expected), index = rows.indexOf(item); rows.splice(index, 1);
      return { selectedId: rows[Math.min(index, rows.length - 1)]?.id || '' };
    });
    announce('작업공간을 삭제했습니다.');
  });
  workspaces.on(openWorkspace, 'click', async () => {
    if (typeof ctx.restoreWorkspace !== 'function') throw new Error('작업공간 복원 기능이 연결되지 않았습니다.');
    const expected = clone(selectedWorkspace());
    const workspace = await persistWorkspaces(rows => {
      const item = requireUnchanged(rows, expected); return { selectedId: item.id, result: clone(item.workspace) };
    });
    await ctx.restoreWorkspace(workspace);
    workspaces.finish();
  });

  return {
    openCredentials() {
      if (credentials.element.open || credentials.busy) { credentials.focus(); return credentials.element; }
      credentialsLoaded = false; credentialRows = []; credentialId = ''; credentials.show();
      credentialList.replaceChildren(); editCredential();
      credentials.status.textContent = '공통 계정을 불러오는 중…';
      void credentials.run(() => loadCredentials(), { cancellable: true });
      return credentials.element;
    },
    openBulk(ids) {
      if (bulk.element.open || bulk.busy) { bulk.focus(); return bulk.element; }
      const selection = ids ?? (state.selection?.size ? state.selection : state.selected ? [state.selected] : []);
      bulkIds = Array.isArray(selection) || selection instanceof Set ? [...new Set(selection)] : [];
      bulkRows = []; bulkLoaded = false; invalidatePreview(); bulk.show(); bulk.sync();
      const byId = new Map((state.sessions || []).map(session => [session.id, session]));
      limitedNames(bulkNames, bulkIds, id => byId.get(id)?.name || String(id));
      bulk.status.textContent = '선택한 세션을 확인하는 중…';
      for (const { apply, control } of bulkControls.values()) { apply.checked = false; control.disabled = true; }
      void bulk.run(async () => {
        if (!(Array.isArray(selection) || selection instanceof Set) || bulkIds.some(id => typeof id !== 'string' || !id)) throw new Error('세션 선택이 올바르지 않습니다. 로컬 세션을 다시 선택하세요.');
        localSessions({ sessions: state.sessions || [] });
        const generation = bulk.generation;
        const [data, credentialData] = await Promise.all([api.bootstrap(), api.listCredentials()]);
        if (generation !== bulk.generation || !bulk.element.open) return;
        bulkRows = localSessions(data); bulkCredentialRows = credentialsFrom(credentialData); bulkLoaded = true; fillBulk(bulkRows);
      }, { cancellable: true });
      return bulk.element;
    },
    openWorkspaces() {
      if (workspaces.element.open || workspaces.busy) { workspaces.focus(); return workspaces.element; }
      workspacesLoaded = false; workspaceRows = []; workspaceId = ''; workspaceName.value = '';
      workspaceList.replaceChildren(); workspaceDetails.replaceChildren(); workspaces.show(); syncWorkspaces();
      workspaces.status.textContent = '작업공간을 불러오는 중…';
      void workspaces.run(loadWorkspaces, { cancellable: true });
      return workspaces.element;
    }
  };
}
