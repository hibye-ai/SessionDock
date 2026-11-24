import { errorFeedback, setFeedback } from './session-data-feedback.cjs';
import { createCompositionOwnership } from './ime-composition.js';
import { installTerminalCompatibility } from './terminal-compatibility.cjs';
import { installOperationsUI } from './operations-ui.js';
import { createLayoutPersistence } from './layout-persistence.cjs';
import { createAuthenticationPromptTracker, isSensitiveConnection } from './command-privacy.cjs';
import { dispatchTerminalCommand, formatDispatchResults } from './command-dispatch.cjs';
import { installAdvancedTerminalUI } from './advanced-terminal-ui.js';
import { installTerminalDockUI } from './terminal-dock-ui.js';
import { installBatchUI } from './batch-ui.js';
import { dockIds, mapDock, replaceDock, gridDock, dockSnapshot, restoreDock } from './terminal-docking.cjs';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { createTerminalResourceManager } from './terminal-resource-manager.js';
import { createScreenRepaintDetector } from './terminal-screen-repaint.cjs';
import { terminalSurface, terminalContrast, semanticPalette, colorMode } from './terminal-colors.cjs';
import { SemanticColorAddon } from './semantic-color-addon.js';
import { TerminalStreamController } from './terminal-stream-controller.js';
import { disconnectLabel } from '../lib/disconnect-cause.cjs';
import { installFontPicker } from './font-picker.js';
import { ACTIONS } from '../lib/shortcut-catalog.cjs';
import { effectiveBindings, validateOverrides, collectSendTextKeys } from '../lib/shortcut-config.cjs';
import { formatSequence, strokeFromEvent } from '../lib/shortcut-keys.cjs';
import { createShortcutResolver } from '../lib/shortcut-resolver.cjs';
import { createShortcutSettings } from './shortcut-settings.cjs';
import { sessionAddress, visibleTerminalText, commandSelection } from './context-utils.cjs';
import { mayRetry, shouldReconnectOnEnter } from './reconnect-policy.cjs';
import { BOOLEAN_INTERACTION_KEYS } from '../lib/interaction-settings.cjs';
import { SessionTreeModel, viewportRange } from './session-tree-model.cjs';
import { SessionFinder } from './session-finder.cjs';
import { quickConnectionProtocol, protocolForEditedPort, isPortRefusedError, isConnectionTimeout, telnetFallbackPorts, telnetFallbackAddress } from './connection-choice.cjs';
import { TerminalGutterAddon } from './terminal-gutter-addon.js';
import { APPEARANCE_DEFAULTS, APPEARANCE_KEYS, SESSION_APPEARANCE_KEYS, FONT_SUGGESTIONS, terminalAppearance } from '../lib/terminal-appearance.cjs';
import { applyPasswordVisibility, passwordToggleLabel } from './password-visibility.js';

const api = window.sessionDock;
const rendererContexts = new WeakMap();
// A terminal keeps its WebGL renderer for its whole lifetime. Tearing the
// context down on every hidden tab and allocating a new one on the way back is
// what froze the app on Windows: the D3D11/ANGLE layer serialises loss against
// creation, and xterm's render service is swapped underneath a live terminal.
// Hidden panes are already display:none, so the browser stops compositing them
// and xterm's own render loop idles without giving up the context.
const terminalResources = createTerminalResourceManager({
  createRenderer(record, { onContextLoss }) {
    const addon = new WebglAddon();
    const previous = new Set(record.mount.querySelectorAll('canvas'));
    try {
      addon.onContextLoss(onContextLoss); record.terminal.loadAddon(addon);
      for (const canvas of record.mount.querySelectorAll('canvas')) {
        if (previous.has(canvas)) continue;
        const context = canvas.getContext('webgl2');
        if (context) { rendererContexts.set(addon, context.getExtension('WEBGL_lose_context')); break; }
      }
      return addon;
    }
    catch (error) { try { addon.dispose(); } catch {} throw error; }
  },
  // Release the GPU context on disposal. Never call loseContext() on a context
  // that is merely being hidden: the forced loss is the freeze.
  disposeRenderer(addon) {
    rendererContexts.delete(addon);
    try { addon.dispose(); } catch { /* terminal already disposed */ }
  },
  retainHidden(record) { return !record.closing; },
  // Chromium allows 16 live WebGL contexts and silently kills the oldest beyond
  // that. Staying well under it keeps context loss a genuine driver event rather
  // than something we caused with many open tabs.
  maxRenderers: 12
});
const $ = id => document.getElementById(id);
const EARLY_BUFFER_MAX_EVENTS=64,EARLY_BUFFER_MAX_BYTES=512*1024,EARLY_BUFFER_GLOBAL_BYTES=2*1024*1024,EARLY_BUFFER_TTL_MS=10000;
const state = { sessions: [], snippets: [], settings: { fontSize: 14, scrollback: 10000, theme: 'dark' }, settingsLoaded: false, runtimeTransparent: false, connections: new Map(), active: null, filter: 'all', search: '', selected: null, view: 'sessions', split: false, files: false, remotePath: '.', editId: null, snippetId: null, eventBuffer: new Map(), earlyBufferBytes: 0, encryptionAvailable: false };
Object.assign(state, { folders: [], selectedFolder: '', folderEdit: '', moveId: null, emptyWorkspace: true, collapsed: new Set(), snippetsVisible: false, commandVisible: true, splitDirection: 'columns', quick: false });
Object.assign(state, { selection: new Set(), selectionAnchor: null, moveIds: [], treeDrag: null, treeMoveBusy: false, tabDrag: null, splitTracks: { columns: [1, 1], rows: [1] }, sharedSources: [] });
state.dockLayout = null;
const layoutPersistence = createLayoutPersistence({api,onSaved:layout=>{state.settings.layout=layout;}});
let dockUI;
let shortcutResolver = createShortcutResolver([]), shortcutBindings = [], shortcutSettings, shortcutWarning = '';
const shortcutHints = new Map();
const legacyClipboardKeys = new Set(['Ctrl+KeyV', 'Ctrl+Shift+KeyV', 'Shift+Insert', 'Ctrl+Shift+KeyC', 'Ctrl+Insert']);
function shortcutHint(id) { return shortcutHints.get(id)?.[0] || ''; }
function getShortcutSettings() { return shortcutSettings ??= createShortcutSettings({ root: $('shortcut-settings'), onDirty: updateSettingsFooter }); }
function openShortcutSettings() { openSettings(); showSettingsPage('shortcuts'); }
function applyShortcuts() {
  shortcutResolver.dispose();
  try {
    shortcutBindings = effectiveBindings(state.settings.shortcuts);
    validateOverrides(state.settings.shortcuts, { sendTextKeys: shortcutBindings.some(binding => !binding.isDefault) ? collectSendTextKeys(state.settings.keymap, state.sessions) : [] });
    shortcutWarning = '';
  } catch (error) {
    shortcutBindings = [];
    if (shortcutWarning !== error.message) { shortcutWarning = error.message; toast('단축키 설정을 확인해 주세요. ' + error.message, true); }
  }
  shortcutResolver = createShortcutResolver(shortcutBindings); updateShortcutHints();
}
function updateShortcutHints() {
  shortcutHints.clear();
  for (const binding of shortcutBindings) { if (!shortcutHints.has(binding.actionId)) shortcutHints.set(binding.actionId, []); shortcutHints.get(binding.actionId).push(formatSequence(binding.sequence)); }
  for (const button of document.querySelectorAll('.menu-popup button[data-command]')) {
    let span = button.querySelector(':scope > span:not([data-icon])');
    const hint = shortcutHint(button.dataset.command);
    if (!span && hint) { span = el('span'); button.append(span); }
    if (span) { span.textContent = hint; span.title = (shortcutHints.get(button.dataset.command) || []).join('\n'); }
  }
  const search = document.querySelector('.search-box kbd'); if (search) search.textContent = shortcutHint('session-search') || shortcutHint('show-session-search');
  $('terminal-search').title = `터미널 찾기${shortcutHint('terminal-search') ? ` (${shortcutHint('terminal-search')})` : ''}`;
  $('tab-new').title = `새 연결${shortcutHint('quick-connect') ? ` (${shortcutHint('quick-connect')})` : ''}`;
  const summary = $('shortcut-summary'); summary.replaceChildren();
  for (const id of ['quick-connect','toolbar-new','session-search','copy-terminal','paste-terminal']) { const action = ACTIONS.find(action => action.id === id), row = el('div'); row.append(el('span','',action.label),el('kbd','',(shortcutHints.get(id)||[]).join(' / ')||'미지정')); summary.append(row); }
}
const paths = {
  folderChevron: 'M9 6l6 6-6 6', sliders:'M3 6h18M3 12h18M3 18h18M7 3v6M16 9v6M10 15v6',
  stop:'M6 6h12v12H6z', collapse:'M4 6h16M4 12h16M4 18h16M9 3l3 3 3-3M9 21l3-3 3 3',
  server:'M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6', telnet:'M4 3h16v18H4zM8 8h8M12 8v9', terminal:'M4 4h16v16H4zM8 9l3 3-3 3M13 15h4',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 3h4l.7 3 2 .9 2.6-.9 2 3.5-2 2v2l2 2-2 3.5-2.6-.9-2 .9-.7 3h-4l-.7-3-2-.9-2.6.9-2-3.5 2-2v-2l-2-2 2-3.5 2.6.9 2-.9z',
  file:'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6', folder:'M3 6h7l2 2h9v12H3z', plus:'M12 5v14M5 12h14', search:'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5',
  zap:'M13 2 4 14h7l-1 8 10-13h-7z', import:'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5', export:'M12 16V3M7 8l5-5 5 5M4 16v5h16v-5', upload:'M12 16V3M7 8l5-5 5 5M4 18v3h16v-3',
  activity:'M2 12h5l3-8 4 16 3-8h5', star:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z', shield:'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6zM8 12l3 3 5-6',
  chevron:'m8 10 4 4 4-4', split:'M3 4h18v16H3zM12 4v16', splitRows:'M3 4h18v16H3zM3 12h18', refresh:'M20 9a8 8 0 1 0 0 6M20 3v6h-6', arrow:'M4 12h16M14 6l6 6-6 6', play:'m8 4 12 8-12 8z', edit:'m15 3 6 6-12 12H3v-6zM12 6l6 6', check:'m5 12 4 4 10-10', warning:'m12 3 10 18H2zM12 9v5M12 17h.01', close:'M6 6l12 12M18 6 6 18', copy:'M8 8h12v13H8zM4 16V3h12', lock:'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  eye:'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', eyeOff:'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24 M1 1l22 22'
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`; }
function applyIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); }); }
// Password reveal state lives outside the field so a closed dialog can never
// leave a plaintext password visible. Bindings are pruned when their DOM is
// replaced (the auth prompt rebuilds its body for every request).
const passwordToggles = [];
function bindPasswordToggle(wrapper) {
  const input = wrapper.querySelector('input'), toggle = wrapper.querySelector('.password-toggle-button');
  if (!input || !toggle) return;
  if (passwordToggles.some(entry => entry.input === input && entry.wrapper === wrapper)) return;
  const title = (toggle.getAttribute('aria-label') || '비밀번호').replace(/\s(?:보기|숨기기)$/, '');
  const entry = { wrapper, input, toggle, title, visible: false };
  passwordToggles.push(entry);
  applyPasswordVisibility(input, toggle, false, title);
  toggle.addEventListener('click', () => {
    if (input.disabled) return;
    entry.visible = !entry.visible;
    applyPasswordVisibility(input, toggle, entry.visible, title);
    input.focus({ preventScroll: true });
  });
}
function passwordEntries(root = document) {
  for (let index = passwordToggles.length - 1; index >= 0; index--) if (!passwordToggles[index].wrapper.isConnected) passwordToggles.splice(index, 1);
  return passwordToggles.filter(entry => root === document || root.contains(entry.wrapper));
}
function bindPasswordToggles(root = document) {
  passwordEntries(root);
  root.querySelectorAll('.input-password-wrapper').forEach(bindPasswordToggle);
}
function concealPasswordFields(root = document) {
  for (const entry of passwordEntries(root)) { entry.visible = false; applyPasswordVisibility(entry.input, entry.toggle, false, entry.title); }
}
function syncPasswordToggles(root = document) {
  for (const entry of passwordEntries(root)) {
    entry.toggle.disabled = entry.input.disabled;
    if (entry.input.disabled) { entry.visible = false; applyPasswordVisibility(entry.input, entry.toggle, false, entry.title); }
  }
}
function el(tag, className = '', text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(label, iconName, className, callback) { const node = el('button', className); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label); if (iconName) node.innerHTML = icon(iconName); else node.textContent = label; node.addEventListener('click', event => { event.stopPropagation(); Promise.resolve(callback(event)).catch(showError); }); return node; }
function showError(error) { toast(error?.message?.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || String(error), true); }
function toast(text, error = false) { placeToasts(); const node = el('div', `toast${error ? ' error' : ''}`); const symbol = el('span'); symbol.innerHTML = icon(error ? 'warning' : 'check'); node.append(symbol, el('span', '', text)); $('toasts').append(node); setTimeout(() => node.remove(), error ? 9000 : 4500); }
async function showSharedStartupNotice() {
  if (document.body.dataset.ready !== 'true') return;
  const notice = await api.takeSharedStartupNotice(); if (!notice) return;
  const node = el('div', `toast${notice.error ? ' error' : ''}`), symbol = el('span'); symbol.innerHTML = icon(notice.error ? 'warning' : 'check');
  node.append(symbol, el('span', '', notice.message)); $('startup-toasts').replaceChildren(node); setTimeout(() => node.remove(), notice.error ? 6000 : 4000);
}
let updateNoticeId = null, updateNoticeSnooze = false, updateNoticeResponding = false, updateNoticeRequest = 0;
let updateProgressOperation = null, updateProgressSequence = 0;
const updatePhaseLabels = {download:'업데이트 파일 다운로드', copy:'업데이트 파일 복사', verify:'복사본 및 원본 확인', extract:'압축 해제'};
function showUpdateProgress(event) {
  if (!updateProgressOperation || event.opId !== updateProgressOperation || !updatePhaseLabels[event.phase] || !['bytes','files'].includes(event.unit) || !Number.isSafeInteger(event.sequence) || event.sequence <= updateProgressSequence || !Number.isSafeInteger(event.completed) || !Number.isSafeInteger(event.total) || event.completed < 0 || event.total < event.completed) return;
  updateProgressSequence = event.sequence;
  const bar = $('update-progress-bar');
  $('update-progress-status').textContent = updatePhaseLabels[event.phase];
  if (event.total > 0) {
    const percent = Math.min(100, Math.floor(event.completed / event.total * 100));
    bar.value = percent; $('update-progress-detail').textContent = `현재 단계 ${percent}%`;
  } else { bar.removeAttribute('value'); $('update-progress-detail').textContent = '진행 중…'; }
}
async function prepareAndInstallUpdate(expected) {
  if (updateProgressOperation) throw new Error('업데이트 작업이 진행 중입니다.');
  const opId = crypto.randomUUID(), dialog = $('update-progress-dialog');
  updateProgressOperation = opId; updateProgressSequence = 0;
  $('update-progress-status').textContent = '준비 중…'; $('update-progress-detail').textContent = ''; $('update-progress-bar').removeAttribute('value');
  try {
    dialog.showModal();
    await api.prepareUpdate(expected, opId);
    updateProgressOperation = null;
    dialog.close();
    return await api.installUpdate();
  } finally {
    if (updateProgressOperation === opId) updateProgressOperation = null;
    if (dialog.open) dialog.close();
  }
}
$('update-progress-dialog').addEventListener('cancel', event => event.preventDefault());
function renderUpdateNotes(value) {
  const notes=$('update-notice-notes');
  const text=typeof value==='string'?value:'';
  notes.textContent=text;notes.title=text;notes.classList.toggle('hidden',!text);
}
async function refreshUpdateNotice() {
  if (document.body.dataset.ready !== 'true') return;
  const request = ++updateNoticeRequest;
  const notice = await api.takeUpdateNotice();
  if (request !== updateNoticeRequest || updateNoticeResponding) return;
  const dialog = $('update-notice-dialog');
  if (!notice) { if (dialog.open) dialog.close(); updateNoticeId = null; renderUpdateNotes(''); return; }
  if (notice.id !== updateNoticeId) { if(dialog.open)dialog.close(); updateNoticeId = notice.id; updateNoticeSnooze = false; }
  if ([...document.querySelectorAll('dialog[open]')].some(item => item !== dialog)) {
    if (dialog.open) { updateNoticeSnooze = $('update-notice-snooze').checked; dialog.close(); }
    return;
  }
  if (dialog.open) return;
  $('update-notice-message').textContent = '새 업데이트 ' + notice.version + '이 있습니다.';
  renderUpdateNotes(notice.notes);
  $('update-notice-snooze').checked = updateNoticeSnooze;
  $('update-notice-error').textContent = '';
  dialog.showModal(); $('update-notice-cancel').focus();
}
function queueUpdateNotice() { refreshUpdateNotice().catch(showError); }
async function respondUpdateNotice(install) {
  if (updateNoticeResponding || !updateNoticeId) return;
  updateNoticeResponding = true; ++updateNoticeRequest;
  const buttons = ['update-notice-close','update-notice-cancel','update-notice-install'];
  buttons.forEach(id => { $(id).disabled = true; });
  try {
    const expected = await api.respondUpdateNotice({id:updateNoticeId,snooze:$('update-notice-snooze').checked});
    $('update-notice-dialog').close(); updateNoticeId = null;
    if (install && expected) {
      if (!await prepareAndInstallUpdate(expected)) toast('업데이트 설치를 취소했습니다.');
    } else if (install) toast('업데이트가 변경되었습니다. 다시 확인해 주세요.', true);
  } catch (error) {
    if ($('update-notice-dialog').open) $('update-notice-error').textContent = error.message;
    else showError(error);
  } finally {
    updateNoticeResponding = false; buttons.forEach(id => { $(id).disabled = false; });
  }
}
$('update-notice-dialog').addEventListener('cancel', event => { event.preventDefault(); respondUpdateNotice(false); });
listen('update-notice-close', () => respondUpdateNotice(false));
listen('update-notice-cancel', () => respondUpdateNotice(false));
listen('update-notice-install', () => respondUpdateNotice(true));
new MutationObserver(records => { if (records.some(record => record.target.tagName === 'DIALOG')) queueUpdateNotice(); }).observe(document.body, { subtree:true, attributes:true, attributeFilter:['open'] });
// Anchor notifications to the top-right of the terminal area, under the address
// bar/search box and left of SFTP, so the command row and send target stay visible.
function placeToasts() {
  const box = $('toasts'), main = document.querySelector('.main').getBoundingClientRect(), workspace = !$('terminal-workspace').classList.contains('hidden');
  let top = Math.max($('connection-bar').getBoundingClientRect().bottom, workspace ? $('terminal-workspace').getBoundingClientRect().top : main.top) + 8, right = innerWidth - main.right + 18, width = main.width - 36;
  if (!workspace) top = Math.max(top, document.querySelector('#empty-workspace p').getBoundingClientRect().bottom + 8);
  if (workspace && !$('terminal-search-box').classList.contains('hidden')) top = Math.max(top, $('terminal-search-box').getBoundingClientRect().bottom + 6);
  if (workspace && !$('file-panel').classList.contains('hidden')) { const files = $('file-panel').getBoundingClientRect(); right = innerWidth - files.left + 14; width -= files.width; }
  box.style.setProperty('--toast-top', `${Math.round(top)}px`); box.style.setProperty('--toast-right', `${Math.round(Math.max(8, right))}px`); box.style.setProperty('--toast-max', `${Math.round(Math.max(220, width))}px`);
}
function listen(id, fn) { $(id).addEventListener('click', event => { event.preventDefault(); Promise.resolve(fn(event)).catch(showError); }); }
let messageResolve;
function message(title, text, { confirm = false, command, action, danger = false } = {}) {
  if (messageResolve) { messageResolve(false); $('message-dialog').close(); }
  $('message-title').textContent = title; $('message-body').replaceChildren(el('div', 'message-details', text));
  if (command) $('message-body').append(el('pre', 'message-command', command));
  // Paste confirmations default to Run; other confirmations keep the safe Cancel default.
  $('message-cancel').classList.toggle('hidden', !confirm); $('message-ok').textContent = action || (confirm && command ? '실행' : '확인'); $('message-ok').classList.toggle('danger', confirm && danger);
  $('message-dialog').showModal(); (confirm && (!command || danger) ? $('message-cancel') : $('message-ok')).focus(); return new Promise(resolve => { messageResolve = resolve; });
}
$('message-dialog').addEventListener('keydown',event=>{
  if(!$('message-dialog').open||$('message-cancel').classList.contains('hidden')||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();
  (['ArrowLeft','ArrowUp','Home'].includes(event.key)?$('message-cancel'):$('message-ok')).focus();
});
function resolveMessage(value) { $('message-dialog').close(); const resolve = messageResolve; messageResolve = null; resolve?.(value); }
function onlineIds() { return new Set([...state.connections.values()].filter(c => c.status === 'connected').map(c => c.sessionId)); }
let sessionTree = new SessionTreeModel([]), sessionFinder = new SessionFinder([]), treeView, treeCanvas, treeRows = new Map(), treeFrame;
function sessionById(id) { return sessionTree.sessions.get(id); }
async function refreshData() {
  const data = await layoutPersistence.readData(); Object.assign(state, { folders: data.folders || [], sessions: data.sessions, sharedSources: data.sharedSources || [], snippets: data.snippets, credentials: data.credentials || [], settings: data.settings, defaultLogDirectory: data.defaultLogDirectory, encryptionAvailable: data.encryptionAvailable, testMode: data.testMode, settingsLoaded: true });
  // The startup mode belongs to main. Apply it before the first settings paint so
  // an earlier window-state event and the bootstrap response cannot disagree.
  applyRuntimeTransparency(data.windowState?.runtimeTransparent);
  sessionTree = new SessionTreeModel(state.sessions, state.folders, state.sharedSources); treeView = null; treeRows.clear();
  sessionFinder = new SessionFinder(state.sessions);
  if (!state.layoutLoaded) restoreLayout(data.settings.layout);
  if (!sessionTree.folders.has(state.selectedFolder)) state.selectedFolder = '';
  state.selection = new Set([...state.selection].filter(id => sessionById(id))); if (state.selected && !sessionById(state.selected)) state.selected = null;
  for (const c of state.connections.values()) { const saved = sessionById(c.sessionId); if (saved && !c.profile.temporary) { c.name = saved.name; c.pane.querySelector('.pane-heading .pane-title').textContent = c.name; } }
  if($('session-dialog').open){const field=$('session-credential'),selected=field.value;field.replaceChildren(new Option('이 세션에 입력한 계정 사용',''),...(state.credentials||[]).map(c=>new Option(c.name,c.id)));field.value=(state.credentials||[]).some(c=>c.id===selected)?selected:'';updateAuthFields();updateQuickSave();}
  renderSharedSources(); $('app-version').textContent = data.version; applySettings(); updateConnectionBar(); renderSessions(); renderSnippets(); renderTabs();
  if(document.activeElement===$('connection-address'))updateAddressSuggestions();
}
// Autosave dedupe. `lastSaved` is the payload the backend has *confirmed*, and
// `lastAttempt` is the payload currently being written plus the retry state.
// They must be separate: deduping on the payload that was merely *sent* meant a
// single transient failure (EBUSY, ENOSPC, a rejected IPC) silently dropped the
// current layout forever, because the identical payload was never sent again and
// no later change was guaranteed to come (V4-M-13).
let layoutTimer, lastSaved = '', lastAttempt = null;
// Bounded backoff for a failed save. Retrying forever would recreate the toast
// storm the previous fix removed, so the delay doubles and the payload is only
// retried while it is still the newest one.
const LAYOUT_RETRY_BASE_MS = 2000, LAYOUT_RETRY_MAX_MS = 30000, LAYOUT_RETRY_LIMIT = 5;
function restoreLayout(layout) {
  if (layout) {
    document.documentElement.style.setProperty('--sidebar-width', `${layout.sidebarWidth}px`);
    document.body.classList.toggle('sidebar-hidden', !layout.sidebarVisible);
    state.commandVisible=layout.commandVisible;state.snippetsVisible=layout.snippetsVisible;state.splitDirection=layout.splitDirection;
    state.collapsed=new Set(layout.collapsedFolders);state.splitTracks={columns:[...layout.splitColumns],rows:[...layout.splitRows]};state.savedWorkspace=layout.workspace;
  }
  state.layoutLoaded=true;
}
function persistLayout() {
  if (!state.layoutLoaded) return;
  clearTimeout(layoutTimer);
  layoutTimer=setTimeout(flushLayoutSave,180);
}
// The measured payload + write. Split from the debounce so a failed attempt can
// be retried directly, without stacking another 180ms debounce on top of the
// backoff (which would double the delay and make the retry path untestable).
function flushLayoutSave() {
    // Measure the *used* width, not the raw custom property: a fractional value
    // (DPI scaling / zoom) or one a hair outside the 190–430 drag clamp used to
    // make the backend reject the whole autosave, and the resulting toast fired
    // on every timer tick. Round and clamp here so the payload is always legal.
    const declared=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'));
    const sidebarWidth=Math.max(190,Math.min(430,Math.round(Number.isFinite(declared)?declared:258)));
    // A folder can be renamed or deleted between render and this timer, leaving
    // an empty or unresolvable path in `state.collapsed`. Send only paths that
    // still exist (or a shared source), never a bare "".
    const collapsedFolders=[...state.collapsed].filter(path=>typeof path==='string'&&path.trim()&&(state.folders.includes(path)||path.startsWith('@shared/')));
    const tracks=values=>Array.isArray(values)&&values.length?values.map(value=>Number.isFinite(value)?value:1):null;
    const layout={sidebarWidth,sidebarVisible:!document.body.classList.contains('sidebar-hidden'),commandVisible:state.commandVisible,snippetsVisible:state.snippetsVisible,splitDirection:state.splitDirection,splitColumns:tracks(state.splitTracks.columns)||[1,1],splitRows:tracks(state.splitTracks.rows)||[1],collapsedFolders};
    const serialized=JSON.stringify(layout);
    // Nothing to do when this exact payload is already on disk, or already on
    // its way there.
    if(serialized===lastSaved)return;
    if(lastAttempt&&lastAttempt.payload===serialized&&lastAttempt.inFlight)return;
    // Background autosave. A failure must not be mistaken for a save: keep the
    // payload dirty and schedule a bounded retry, so a transient I/O error
    // cannot silently lose the layout. The retry re-sends the *newest* payload
    // (a change during the backoff wins) and gives up after a few attempts with
    // one console warning instead of a toast storm.
    const attempt={payload:serialized,inFlight:true,tries:lastAttempt&&lastAttempt.payload===serialized?lastAttempt.tries:0};
    lastAttempt=attempt;
    layoutPersistence.save(layout).then(()=>{
      attempt.inFlight=false;lastSaved=serialized;
      if(lastAttempt===attempt)lastAttempt=null;
    }).catch(error=>{
      attempt.inFlight=false;
      attempt.tries++;
      // A validation error is not transient: the same payload will always be
      // rejected, so retrying it would only produce noise.
      const code=String(error?.code||'');
      if(typeof console!=='undefined')console.warn('화면 배치를 저장하지 못했습니다.',error);
      if(lastAttempt!==attempt)return;
      if(code==='ERR_VALIDATION'||attempt.tries>=LAYOUT_RETRY_LIMIT){lastAttempt=null;return;}
      const delay=Math.min(LAYOUT_RETRY_MAX_MS,LAYOUT_RETRY_BASE_MS*2**(attempt.tries-1));
      clearTimeout(layoutTimer);
      layoutTimer=setTimeout(()=>{
        // Only retry if this payload is still the current one; otherwise the
        // change handler already queued the newer payload.
        if(lastAttempt===attempt)flushLayoutSave();
      },delay);
    });
}
function applySettings() {
  applyShortcuts();
  document.body.classList.toggle('light', state.settings.theme === 'light');
  const surfaceSettings=runtimeSurfaceSettings(state.settings,state.runtimeTransparent);
  const surface = terminalSurface(surfaceSettings), theme = surface.theme;
  document.body.style.setProperty('--terminal-surface', surface.background);
  for (const connection of state.connections.values()) {
    const saved = !connection.profile.temporary && sessionById(connection.sessionId);
    const profile = saved ? { ...connection.profile, ...Object.fromEntries(SESSION_APPEARANCE_KEYS.map(key => [key, saved[key]])) } : connection.profile;
    connection.terminal.options = { ...terminalAppearance(state.settings, profile), ...(connection.fontZoomSize?{fontSize:connection.fontZoomSize}:{}), theme, minimumContrastRatio: terminalContrast(state.settings) };
    connection.compatibility?.update({sessionKeymap:saved?saved.keymap:connection.profile.keymap,globalKeymap:state.settings.keymap||[],protocol:connection.protocol||'ssh',ctrlArrowMode:(saved||connection.profile).ctrlArrowMode});
    connection.semantic.configure(state.settings); connection.gutter.configure({...state.settings,...connection.gutterOverrides});
  }
  state.terminalTheme = theme; scheduleFit();
}
// Keep the stored preference separate from the native surface. The preview and
// settings form still show the saved percentage, while an opaque launch paints
// alpha 0 until the next native window creation.
function runtimeSurfaceSettings(settings, runtimeTransparent) {
  return runtimeTransparent ? settings : { ...settings, terminalTransparency: 0 };
}
function applyRuntimeTransparency(runtimeTransparent) {
  if(typeof runtimeTransparent!=='boolean' || state.runtimeTransparent===runtimeTransparent) return false;
  state.runtimeTransparent=runtimeTransparent;
  return true;
}
function transparencyRestartPending(transparency, runtimeTransparent) {
  return (Number(transparency) > 0) !== runtimeTransparent;
}
function focusConnectionBar() { $('connection-address').focus(); $('connection-address').select(); }
function updateConnectionBar() {
  const choice=$('connection-protocol').value,telnet=choice==='telnet';
  $('connection-protocol').title=choice==='auto'?'자동: 포트/스킴 감지 · SSH 포트 닫힘 시 Telnet 자동 전환':`${telnet?'Telnet':'SSH'} 세션 검색 및 빠른 연결`;
  $('connection-address').placeholder=telnet?'장비 이름 또는 IP 주소 검색 · 호스트:포트':choice==='auto'?'장비 이름 또는 IP 주소 검색 · 새 주소는 자동 연결':'장비 이름 또는 IP 주소 검색 · 사용자@호스트:포트';
}
let addressMatches={items:[],total:0,exactIds:[]},addressMatchIndex=-1,addressConnecting=false;
function hideAddressSuggestions(){ $('address-suggestions').classList.add('hidden');$('connection-address').setAttribute('aria-expanded','false');$('connection-address').removeAttribute('aria-activedescendant');addressMatchIndex=-1; }
function addressStatus(){
  const status=$('address-match-status'),{items,total}=addressMatches,selected=items[addressMatchIndex];
  const summary=`등록된 세션 ${total}개${total>items.length?` · 상위 ${items.length}개 표시`:''} · `;
  if(selected)status.replaceChildren(summary+'Enter: ',el('strong','',selected.name),' 연결');
  else status.textContent=`${summary}↑↓ 선택 / Enter 연결`;
}
function selectAddressSuggestion(index){addressMatchIndex=index;const rows=$('address-options').children;[...rows].forEach((node,i)=>{node.classList.toggle('selected',i===index);node.setAttribute('aria-selected',String(i===index));});if(index>=0){$('connection-address').setAttribute('aria-activedescendant',rows[index].id);rows[index].scrollIntoView({block:'nearest'});}else $('connection-address').removeAttribute('aria-activedescendant');addressStatus();}
function updateAddressSuggestions(){
  const input=$('connection-address'),box=$('address-suggestions'),options=$('address-options');hideAddressSuggestions();options.replaceChildren();
  addressMatches=sessionFinder.search(input.value,12,quickConnectionProtocol(input.value,$('connection-protocol').value));
  for(const [index,profile]of addressMatches.items.entries()){
    const row=el('button','address-suggestion');row.type='button';row.tabIndex=-1;row.id=`address-match-${index}`;row.dataset.sessionId=profile.id;row.setAttribute('role','option');row.setAttribute('aria-selected','false');
    const source=state.sharedSources.find(source=>source.id===profile.sharedSourceId),unavailable=!!source?.error;
    row.setAttribute('aria-disabled',String(unavailable));row.append(el('span','address-match-name',profile.name),el('span',`address-match-target${profile.protocol==='telnet'?' telnet':''}`,`${profile.protocol==='telnet'?'TELNET':'SSH'} · ${profile.username?`${profile.username}@`:''}${profile.host}:${profile.port}`));
    row.append(el('span','address-match-folder',`${source?`공유 · ${source.name} / `:''}${profile.folder||'미분류'}${unavailable?' · 원본 갱신 필요':''}`));row.title=unavailable?source.error:`${profile.name}\n${profile.folder||'미분류'}`;
    // Hover is only a light highlight: what Enter opens changes by arrow keys or click.
    row.addEventListener('mousedown',event=>event.preventDefault());row.addEventListener('click',()=>{if(!unavailable)connectSavedAddress(profile.id).catch(showError);});options.append(row);
  }
  if(addressMatches.total){
    // Show the row Enter will open: a unique exact match or a single result.
    // Several non-exact results stay unselected so Enter asks for a choice.
    const {items,total,exactIds}=addressMatches,exact=exactIds.length===1?items.findIndex(profile=>profile.id===exactIds[0]):-1;
    box.classList.remove('hidden');input.setAttribute('aria-expanded','true');
    selectAddressSuggestion(exact>=0?exact:total===1?0:-1);
  }
}
async function connectSavedAddress(id){
  // Address-bar connections preserve the session tree's selection and folders.
  if(addressConnecting)return;const profile=sessionById(id);if(!profile)throw new Error('목록이 변경되었습니다. 세션을 다시 선택해 주세요.');
  const protocol=quickConnectionProtocol($('connection-address').value,$('connection-protocol').value);if(protocol&&protocol!==(profile.protocol||'ssh')){updateAddressSuggestions();throw new Error('연결 방식이 변경되었습니다. 세션을 다시 선택해 주세요.');}
  addressConnecting=true;$('address-connect').disabled=true;hideAddressSuggestions();
  try{await connectSession(id);$('connection-address').value=profile.name;}
  finally{addressConnecting=false;$('address-connect').disabled=false;}
}
async function connectAddress(event,{direct=false}={}) {
  event.preventDefault(); const address=$('connection-address').value.trim(); if(!address){focusConnectionBar();return;}
  if(addressConnecting)return;
  const protocol=quickConnectionProtocol(address,$('connection-protocol').value);
  if(!direct){
    const matches=sessionFinder.search(address,12,protocol),candidate=addressMatchIndex>=0&&!$('address-suggestions').classList.contains('hidden')?addressMatches.items[addressMatchIndex]:null,selected=candidate&&matches.items.some(item=>item.id===candidate.id)?candidate:null;
    if(selected)return connectSavedAddress(selected.id);
    if(matches.exactIds.length===1)return connectSavedAddress(matches.exactIds[0]);
    if(matches.total===1)return connectSavedAddress(matches.items[0].id);
    if(matches.total){updateAddressSuggestions();selectAddressSuggestion(0);$('address-match-status').textContent='일치하는 세션이 여러 개입니다. ↑↓로 선택 후 Enter를 누르세요.';return;}
  }
  hideAddressSuggestions();addressConnecting=true;
  $('address-connect').disabled=true;
  try {
    const result=await api.connectAddress(address,protocol||'auto');
    if(!result)return;
    attachConnection(result,result.session);
    // The main process probes the SSH port first and can already return the
    // Telnet session; mark that tab so the switch is visible, not silent.
    if(result.autoFallback){
      const next=state.connections.get(result.id);
      if(next){next.autoFallbackFrom={protocol:'ssh',port:result.autoFallback.from};next.pane.dataset.autoFallback=`ssh:${result.autoFallback.from}>telnet:${result.autoFallback.to}`;next.terminal.writeln(`\r\n\x1b[33m${result.autoFallback.reason==='telnet'?`SSH(${result.autoFallback.from}) 포트가 Telnet 장비입니다`:`SSH(${result.autoFallback.from}) 포트 연결 거부`} · Telnet(${result.autoFallback.to})으로 자동 전환합니다...\x1b[0m`);}
      toast(result.autoFallback.from===22&&result.autoFallback.to===23?'SSH 포트 닫힘 · Telnet으로 자동 전환합니다.':`SSH(${result.autoFallback.from}) 포트 닫힘 · 같은 포트에서 Telnet으로 자동 전환합니다.`);
    }
  }
  catch(error){showError(error);focusConnectionBar();}
  finally{addressConnecting=false;$('address-connect').disabled=false;}
}
function showSettingsPage(page) {
  document.querySelectorAll('[data-settings-page]').forEach(node=>{const selected=node.dataset.settingsPage===page;node.classList.toggle('selected',selected);node.setAttribute('aria-current',selected?'page':'false');});
  document.querySelectorAll('[data-settings-panel]').forEach(node=>node.classList.toggle('hidden',node.dataset.settingsPanel!==page));
  $('settings-dialog').querySelector('.session-options-body').scrollTop = 0;
  if (page === 'shared') renderSharedSources();
  updateSettingsFooter();
}
// Import/export and shared-list actions run immediately, so the footer says so.
// Edits made on other pages remain a visible draft: Apply/Cancel stay available.
let settingsBaseline = '';
function settingsSnapshot() { return JSON.stringify([...$('settings-form').elements].filter(field => field.name).map(field => field.type === 'checkbox' ? field.checked : field.value)); }
function updateSettingsFooter() {
  if (!settingsBaseline) return;
  const dirty = settingsSnapshot() !== settingsBaseline || !!shortcutSettings?.isDirty(), page = document.querySelector('[data-settings-page].selected')?.dataset.settingsPage, immediate = page === 'sessions' || page === 'shared', note = $('settings-footer-note');
  note.classList.toggle('dirty', dirty);
  note.textContent = dirty ? (immediate ? '다른 페이지에 적용하지 않은 변경이 있습니다' : '적용하지 않은 변경이 있습니다') : page === 'sessions' ? 'CSV는 확인 후 추가 · 설정 적용은 다른 설정을 저장합니다' : immediate ? '이 페이지의 항목은 누르면 바로 실행됩니다' : '';
  note.title = note.textContent;
  $('settings-apply').textContent = page === 'sessions' ? '설정 적용' : '적용';
  $('settings-apply').classList.toggle('primary-button',page !== 'sessions');
  $('settings-apply').classList.toggle('secondary-button',page === 'sessions');
  $('settings-cancel').textContent = dirty || !immediate ? '취소' : '닫기';
}
let logPreviewGeneration=0,logPreviewTimer;
async function updateLogPreview() {
  const form=$('settings-form');form.elements.logTimestamps.disabled=form.elements.logFormat.value!=='text';
  const generation=++logPreviewGeneration;
  try{const preview=await api.logPreview({logDirectory:form.elements.logDirectory.value.trim(),logFilenameTemplate:form.elements.logFilenameTemplate.value});if(generation!==logPreviewGeneration)return;$('log-filename-preview').textContent=preview;$('log-filename-preview').style.color='';}
  catch(error){if(generation!==logPreviewGeneration)return;$('log-filename-preview').textContent=error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');$('log-filename-preview').style.color='var(--danger)';}
}
function openSettings() {
  shortcutResolver.reset();
  const form=$('settings-form');form.reset();for(const key of [...APPEARANCE_KEYS,'fontSize','scrollback','theme','terminalColorScheme','semanticColoring','terminalLineNumbers','terminalTimestamps','logEnabled','logDirectory','logFilenameTemplate','logFormat','logTimestamps','logRotateDaily','updateDirectory','updateFromLocalFolder','updateCheckOnStartup','quickUsername','rightClickAction',...BOOLEAN_INTERACTION_KEYS])formValue(form,key,state.settings[key]);
  syncUpdateSourceFields();
  form.elements.logDirectory.placeholder=state.defaultLogDirectory;
  $('log-template-preset').value=[...$('log-template-preset').options].some(option=>option.value===state.settings.logFilenameTemplate)?state.settings.logFilenameTemplate:'';
  getShortcutSettings().open(state.settings.shortcuts, { sendTextKeys: collectSendTextKeys(state.settings.keymap, state.sessions) });
  $('settings-form-error').textContent='';settingsBaseline=settingsSnapshot();showSettingsPage('general');$('settings-dialog').showModal();updateLogPreview();updateColorPreview();loadFontChoices();
  refreshUpdateStatus().catch(showError);
}
let fontChoices,installedFontFamilies=[...FONT_SUGGESTIONS];
const fontPickers=[...document.querySelectorAll('input[name="fontFamily"]')].map(input=>installFontPicker(input,{getFamilies:()=>installedFontFamilies}));
function loadFontChoices() {
  if (!fontChoices) {
    $('terminal-font-families').replaceChildren(...FONT_SUGGESTIONS.map(name => { const option=el('option');option.value=name;return option; }));
    fontChoices=api.systemFonts().then(result=>{
      installedFontFamilies=result.families;for(const picker of fontPickers)picker.refresh();
      $('terminal-font-families').replaceChildren(...result.families.map(name=>{const option=el('option');option.value=name;return option;}));
      return result.available ? `설치된 글꼴 ${result.families.length}개 · 고정폭 글꼴을 권장합니다.` : '글꼴 목록을 불러오지 못했습니다. 이름을 직접 입력하세요.';
    }).catch(()=> '글꼴 이름을 직접 입력하세요. 고정폭 글꼴을 권장합니다.');
  }
  fontChoices.then(text=>document.querySelectorAll('.system-font-status').forEach(node=>{node.textContent=text;}));
}
function previewTypography(node, form, session=false) {
  const values=Object.fromEntries(['fontFamily','fontWeight','fontSize','lineHeight','letterSpacing'].map(key=>[key,form.elements[key].type==='number'?Number(form.elements[key].value):form.elements[key].value]));
  const options=terminalAppearance(session?state.settings:{...state.settings,...values},session?values:{});
  Object.assign(node.style,{fontFamily:options.fontFamily,fontSize:`${Math.max(10,Math.min(48,options.fontSize||14))}px`,fontWeight:options.fontWeight,lineHeight:String(Math.max(1,Math.min(2,options.lineHeight||1))),letterSpacing:`${Math.max(0,Math.min(5,options.letterSpacing||0))}px`});
}
function updateColorPreview() {
  const form=$('settings-form'),settings={theme:form.elements.theme.value,terminalColorScheme:form.elements.terminalColorScheme.value,terminalTransparency:Number(form.elements.terminalTransparency.value)},surface=terminalSurface(settings),theme=surface.theme,palette=semanticPalette(settings),preview=$('terminal-color-preview');
  $('terminal-transparency-value').textContent=`${settings.terminalTransparency}%`;
  preview.style.background=surface.background;preview.style.color=theme.foreground;
  previewTypography(preview,form);
  $('terminal-color-mode-hint').textContent=colorMode(settings)==='wind'?'명령, 경로, IP, 숫자, 상태 단어를 색상으로 구분합니다.':'표준 ANSI 색상을 쓰며 네트워크 상태와 IP만 강조합니다.';
  preview.querySelectorAll('[data-color]').forEach(node=>{node.style.color=form.elements.semanticColoring.checked?palette[node.dataset.color]:theme.foreground;});
}
function renderSessions() {
  const online = onlineIds(), list = $('session-list');
  $('session-count').textContent = state.sessions.length; $('online-count').textContent = [...state.connections.values()].filter(c => c.status === 'connected').length;
  $('connection-counter').textContent = `${$('online-count').textContent}개 연결`;
  for (const name of ['all', 'favorite', 'online']) $(`filter-${name}`).classList.toggle('selected', state.filter === name);
  const next = sessionTree.view({filter:state.filter,search:state.search,online,collapsed:state.collapsed});
  const query = JSON.stringify([state.filter,state.search.toLowerCase()]);
  if (list.dataset.query !== query) list.scrollTop = 0;
  list.dataset.query = query;
  if (treeView !== next) { treeRows.clear(); treeView = next; }
  list.dataset.visibleSessionCount = treeView.sessionIds.length;
  list.dataset.matchedSessionCount = treeView.matchedCount;
  renderTreeViewport(); syncTreeSelection(); persistLayout();
}
function createTreeRow(item) {
  if (item.kind === 'folder') {
      const {node:child,depth,count,collapsed}=item, heading=el('button','folder-heading');heading.type='button';heading.tabIndex=-1;heading.dataset.folderPath=child.path;heading.style.setProperty('--depth',depth);heading.setAttribute('aria-expanded',String(!collapsed));
      const symbol=el('span','folder-icon');symbol.innerHTML=icon('folder');const toggle=el('span','folder-toggle');toggle.innerHTML=icon('folderChevron');toggle.setAttribute('aria-hidden','true');heading.append(toggle,symbol,el('span','folder-label',child.name),el('span','folder-count',count));
      if(child.sharedSourceId){heading.dataset.sharedSourceId=child.sharedSourceId;heading.classList.add('shared-folder');}
      heading.title = child.source?.error ? child.source.error : child.sharedSourceId ? '읽기 전용 공유 세션' : child.path || '미분류'; heading.classList.toggle('selected', !state.selected && state.selectedFolder === child.path);
      const toggleFolder = () => { if (state.collapsed.has(child.path)) state.collapsed.delete(child.path); else state.collapsed.add(child.path); renderSessions(); focusTreeItem(`folder:${child.path}`); };
      heading.addEventListener('click',event=>{selectFolder(child.path);if(event.target.closest('.folder-toggle'))toggleFolder();});
      heading.addEventListener('dblclick',event=>{if(!event.target.closest('.folder-toggle'))toggleFolder();});
      heading.draggable = !child.virtual && !child.sharedSourceId; heading.setAttribute('role', 'treeitem'); heading.setAttribute('aria-level', String(depth + 1));
      heading.addEventListener('dragstart', event => { if (child.virtual || child.sharedSourceId) {event.preventDefault();return;} selectFolder(child.path); startTreeDrag(event, { kind: 'folder', path: child.path }); });
      heading.addEventListener('dragend', endTreeDrag);
      heading.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); selectFolder(child.path); if(child.sharedSourceId){showContextMenu(event,sharedSourceActions(child.sharedSourceId));return;} showContextMenu(event, [
        ...newTreeActions(child.path), ...(child.virtual ? [] : [null, ['공유 세션 게시…', () => openFolderPublish(child.path)], null, ['폴더 이름 / 위치 변경…', () => openFolder(child.path, true)], ['폴더 삭제…', () => deleteFolder(child.path)]])
      ]); });

    return heading;
  }
  const s=item.session,depth=item.depth,online=onlineIds();
      const telnet=s.protocol==='telnet';
      const row = el('div', `session-row${telnet ? ' telnet' : ''}${online.has(s.id) ? ' online' : ''}${state.selection.has(s.id) ? ' selected' : ''}`); row.tabIndex = -1; row.dataset.sessionId = s.id; row.dataset.parentFolder = s.sharedSourceId ? `@shared/${s.sharedSourceId}/${s.folder}` : s.folder;
      // Same depth unit as folders: the icon lines up with sibling folder icons.
      row.style.setProperty('--depth',depth);row.setAttribute('role','treeitem');row.setAttribute('aria-selected',String(state.selection.has(s.id)));row.setAttribute('aria-level',String(depth+1));row.title=`${s.name?`${s.name}\n`:''}${s.folder?`${s.folder}\n`:''}${telnet?'Telnet · 암호화 없음':'SSH2'} · ${s.username?`${s.username}@`:''}${s.host}:${s.port}`;
      const symbol = el('span', 'session-symbol'); symbol.innerHTML = icon(telnet ? 'telnet' : 'server');
      const text = el('div', 'session-text'); text.append(el('div', 'session-name', s.name), el('div', 'session-host', `${s.username}@${s.host}:${s.port}`));
      row.append(symbol, text); if (s.favorite) row.append(el('span', 'session-favorite', '☆'));
      // Row buttons are pointer shortcuts; keyboard uses Enter and the context menu.
      const actions = el('div', 'row-actions');if(!s.sharedSourceId)actions.append(button('세션 수정', 'edit', 'icon-button', () => openSession(s)));actions.append(button('연결', 'play', 'icon-button', () => connectSession(s.id)));for(const action of actions.children)action.tabIndex=-1;row.append(actions);
      if(s.sharedSourceId){row.dataset.sharedSourceId=s.sharedSourceId;row.title+=' · 읽기 전용 공유 세션';}
      row.addEventListener('click', event => selectSession(s.id, event)); row.addEventListener('dblclick', () => connectSession(s.id).catch(showError));
      row.draggable = true; row.addEventListener('dragstart', event => {
        if(event.target.closest('.row-actions')){event.preventDefault();return;}
        if(!state.selection.has(s.id))selectSession(s.id);
        if(!s.sharedSourceId&&!state.treeMoveBusy&&![...state.selection].some(id=>sessionById(id)?.sharedSourceId))startTreeDrag(event,{kind:'sessions',ids:[...state.selection]});
        else{state.treeDrag=null;event.stopPropagation();row.classList.add('dragging');}
        state.treeConnectionDrag=s.id;event.dataTransfer.effectAllowed='copyMove';event.dataTransfer.setData('application/x-sessiondock-session','open');
      }); row.addEventListener('dragend', endTreeDrag);
      row.addEventListener('contextmenu', event => showSessionMenu(event,s));

  return row;
}
function renderTreeViewport() {
  if (!treeView) return;
  const list=$('session-list'), virtual=treeView.items.length>200;
  list.classList.toggle('virtual-tree',virtual);
  if (!treeCanvas) { treeCanvas=el('div','tree-content'); list.replaceChildren(treeCanvas); }
  treeCanvas.style.height=virtual?`${treeView.height}px`:'';
  // Clamp before finding the range when filtering/collapsing shortens the tree.
  if (virtual) list.scrollTop=Math.min(list.scrollTop,Math.max(0,treeView.height+14-list.clientHeight));
  const range=virtual?viewportRange(treeView.items,Math.max(0,list.scrollTop-7),list.clientHeight):{start:0,end:treeView.items.length};
  const wanted=treeView.items.slice(range.start,range.end), focused=document.activeElement?.closest('[data-tree-key]'),focusKey=focused?.dataset.treeKey;
  // Retain at most one focused row during wheel scrolling so keyboard focus survives.
  const focusIndex=treeView.index.get(focusKey);
  if(virtual&&focusIndex!==undefined&&(focusIndex<range.start||focusIndex>=range.end))wanted.push(treeView.items[focusIndex]);
  const keep=new Set(wanted.map(item=>item.key));
  for(const [key,node] of treeRows)if(!keep.has(key)){node.remove();treeRows.delete(key);}
  if(!treeView.items.length){
    treeRows.clear();const empty=el('div','sidebar-empty');empty.innerHTML=icon('server');empty.append(el('div','',state.sessions.length?'조건에 맞는 세션이 없습니다.':'우클릭으로 새 세션이나 폴더를 만드세요.'));treeCanvas.replaceChildren(empty);return;
  }
  const nodes=wanted.map(item=>{
    let node=treeRows.get(item.key);if(!node){node=createTreeRow(item);node.dataset.treeKey=item.key;treeRows.set(item.key,node);}
    node.style.top=virtual?`${item.offset}px`:'';return node;
  });
  // Avoid detaching unchanged nodes: full refresh/selection should preserve focus and drag.
  if(nodes.length!==treeCanvas.children.length||nodes.some((node,index)=>treeCanvas.children[index]!==node)){
    treeCanvas.replaceChildren(...nodes);if(focusKey)treeRows.get(focusKey)?.focus({preventScroll:true});
  }
  const online=onlineIds();for(const node of nodes)if(node.dataset.sessionId)node.classList.toggle('online',online.has(node.dataset.sessionId));
  syncTreeSelection(false);syncTreeTabStops();
}
// Roving tabindex: the tree is one Tab stop (last focused row, else the
// selection, else the first rendered row); arrows move within it.
function syncTreeTabStops() {
  const selected=state.selected?`session:${state.selected}`:`folder:${state.selectedFolder}`;
  const key=[state.treeFocusKey,selected].find(candidate=>candidate&&treeRows.has(candidate))??treeCanvas?.firstElementChild?.dataset?.treeKey;
  for(const [rowKey,node] of treeRows){const index=rowKey===key?0:-1;if(node.tabIndex!==index)node.tabIndex=index;}
}
function scheduleTreeViewport() { if(!treeFrame)treeFrame=requestAnimationFrame(()=>{treeFrame=null;renderTreeViewport();}); }
function focusTreeItem(key) {
  const item=treeView?.items[treeView.index.get(key)];if(!item)return;
  const list=$('session-list'),top=item.offset+7,bottom=top+item.height;
  if(top<list.scrollTop)list.scrollTop=top;else if(bottom>list.scrollTop+list.clientHeight)list.scrollTop=bottom-list.clientHeight;
  renderTreeViewport();treeRows.get(key)?.focus({preventScroll:true});
}
// Plain arrows move and select; Ctrl+arrows only move focus (Space toggles).
function moveTreeFocus(item, event = {}) {
  focusTreeItem(item.key); if (event.ctrlKey || event.metaKey) return;
  if (item.kind === 'session') selectSession(item.session.id, event); else selectFolder(item.node.path);
}
function switchView(view) {
  if(view==='snippets')state.snippetsVisible=!state.snippetsVisible;state.view='sessions';
  state.emptyWorkspace = !state.connections.has(state.active);
  if (state.emptyWorkspace) { state.split=false; hideCommandSuggestions(); commandHistoryIndex=-1; }
  $('snippet-page').classList.toggle('hidden',!state.snippetsVisible);$('nav-snippets').classList.toggle('active',state.snippetsVisible);
  $('empty-workspace').classList.toggle('hidden',!state.emptyWorkspace);$('terminal-workspace').classList.toggle('hidden',state.emptyWorkspace);$('command-bar').classList.toggle('hidden',!state.commandVisible);
  $('workspace-name').textContent=state.emptyWorkspace?'터미널':state.connections.get(state.active)?.name||'터미널';renderTabs();updateStatus();scheduleFit();
  persistLayout();
}
function folderHeading(path) { return [...$('session-list').querySelectorAll('.folder-heading')].find(node => node.dataset.folderPath === path); }
function syncTreeSelection(details = true) {
  $('session-list').dataset.selectedCount = state.selection.size;
  document.querySelectorAll('.folder-heading').forEach(node => node.classList.toggle('selected', !state.selected && node.dataset.folderPath === state.selectedFolder));
  document.querySelectorAll('.session-row').forEach(row => { const selected = state.selection.has(row.dataset.sessionId); row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected)); });
  if (details) { updateSessionProperties(); updateStatus(); }
}
function selectSession(id, event = {}) {
  const extend = event.ctrlKey || event.metaKey;
  const visible = treeView?.sessionIds || [];
  const anchor = visible.indexOf(state.selectionAnchor), target = visible.indexOf(id);
  if (event.shiftKey && anchor >= 0 && target >= 0) {
    if (!extend) state.selection.clear();
    visible.slice(Math.min(anchor, target), Math.max(anchor, target) + 1).forEach(item => state.selection.add(item));
  } else {
    if (!extend) state.selection.clear();
    if (extend && state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
    state.selectionAnchor = id;
  }
  state.selected = state.selection.has(id) ? id : [...state.selection].at(-1) || null;
  state.selectedFolder = sessionById(state.selected)?.folder || ''; syncTreeSelection();
}
function selectFolder(path) { state.selected = null; state.selection.clear(); state.selectionAnchor = null; state.selectedFolder = path; syncTreeSelection(); }
async function connectSelected() {
  const ids = [...state.selection]; if (!ids.length && state.selected) ids.push(state.selected);
  const results = await Promise.allSettled(ids.map(id => connectSession(id)));
  results.forEach(result => { if (result.status === 'rejected') showError(result.reason); });
}
async function deleteSelectedSessions() {
  const ids = [...state.selection]; if (!ids.length) return;
  if(ids.some(id=>sessionById(id)?.sharedSourceId))throw new Error('공유 목록은 읽기 전용입니다. 변경은 관리자가 게시해야 합니다.');
  const names = ids.slice(0, 20).map(id => sessionById(id)?.name).join('\n');
  if (!(await message('세션 삭제', `${ids.length}개 세션을 삭제하시겠습니까?\n${names}${ids.length > 20 ? '\n…' : ''}`, { confirm: true, danger: true, action: '삭제' }))) return;
  await api.deleteSessions(ids); state.selected = null; state.selection.clear(); await refreshData(); toast('선택한 세션을 삭제했습니다.');
}
function openSessionRename(session) {
  if (!session) return;if(session.sharedSourceId){showSharedProfile(session);return;} state.renameSessionId = session.id;
  const form = $('rename-session-form'); form.reset(); form.elements.name.value = session.name;
  $('rename-session-error').textContent = ''; $('rename-session-dialog').showModal(); form.elements.name.focus(); form.elements.name.select();
}
async function renameSession(event) {
  event.preventDefault(); const form = event.target; if (!form.reportValidity()) return;
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { await api.saveSession({ id: state.renameSessionId, name: form.elements.name.value }); $('rename-session-dialog').close(); await refreshData(); }
  catch (error) { $('rename-session-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  finally { submit.disabled = false; }
}
function startTreeDrag(event, source) {
  if (state.treeMoveBusy || source.ids?.some(id=>sessionById(id)?.sharedSourceId)) { event.preventDefault(); return; }
  state.treeDrag = source; event.stopPropagation(); event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-sessiondock-tree', 'move'); event.currentTarget.classList.add('dragging');
}
function endTreeDrag() { state.treeDrag = null;state.treeConnectionDrag=null;dockUI?.clearPreview();$('empty-workspace').classList.remove('session-drop-target'); document.querySelectorAll('.dragging,.tree-drop-target').forEach(node => node.classList.remove('dragging', 'tree-drop-target')); }
function treeDropFolder(event) { return event.target.closest('.folder-heading')?.dataset.folderPath ?? event.target.closest('.session-row')?.dataset.parentFolder ?? ''; }
function canTreeDrop(path) { return !path.startsWith('@shared/') && state.treeDrag && !state.treeMoveBusy && (state.treeDrag.kind !== 'folder' || (path !== state.treeDrag.path && !path.startsWith(`${state.treeDrag.path}/`))); }
async function moveTree(source, folder) {
  if (state.treeMoveBusy) return; state.treeMoveBusy = true;
  try {
    if (source.kind === 'sessions') { await api.moveSessions({ ids: source.ids, folder }); state.selection = new Set(source.ids); state.selected = source.ids[0]; revealFolder(folder); }
    else { const path = await api.saveFolder({ path: source.path, parent: folder, name: source.path.split('/').at(-1) }); state.collapsed = new Set([...state.collapsed].map(item => item === source.path || item.startsWith(`${source.path}/`) ? path + item.slice(source.path.length) : item)); state.selection.clear(); state.selected = null; revealFolder(path); }
    await refreshData(); toast(source.kind === 'sessions' ? `${source.ids.length}개 세션을 이동했습니다.` : '폴더를 이동했습니다.');
  } finally { state.treeMoveBusy = false; }
}
function newTreeActions(path = '') { return [['새 세션…', () => openSession({ folder: path })], ['새 폴더…', () => openFolder(path)]]; }
function fillFolderChoices(select, selected = '', excluded = '') {
  select.replaceChildren(el('option', '', '최상위 (미분류)')); select.firstChild.value = '';
  for (const path of state.folders) {
    if (excluded && (path === excluded || path.startsWith(`${excluded}/`))) continue;
    const option = el('option', '', path); option.value = path; select.append(option);
  }
  select.value = selected;
}
function revealFolder(path) {
  let parent = '';
  for (const part of path.split('/')) { parent = parent ? `${parent}/${part}` : part; state.collapsed.delete(parent); }
  state.filter = 'all'; state.search = ''; $('session-search').value = ''; state.selectedFolder = path;
}
function openFolder(path = '', edit = false) {
  if(path.startsWith('@shared/')){openSharedSettings();return;}
  state.folderEdit = edit ? path : ''; const form = $('folder-form'); form.reset();
  const parts = path.split('/'); const name = parts.pop();
  $('folder-dialog-title').textContent = edit ? '폴더 이름 / 위치 변경' : '새 폴더';
  fillFolderChoices(form.elements.parent, edit ? parts.join('/') : path, state.folderEdit);
  form.elements.name.value = edit ? name : ''; $('folder-form-error').textContent = '';
  $('folder-dialog').showModal(); form.elements.name.focus(); form.elements.name.select();
}
async function saveFolder(event) {
  event.preventDefault(); const form = $('folder-form'); if (!form.reportValidity()) return;
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const previous = state.folderEdit;
    const path = await api.saveFolder({ path: previous, name: form.elements.name.value, parent: form.elements.parent.value });
    if (previous) state.collapsed = new Set([...state.collapsed].map(item => item === previous || item.startsWith(`${previous}/`) ? path + item.slice(previous.length) : item));
    state.selected = null; state.selection.clear(); revealFolder(path); $('folder-dialog').close(); await refreshData(); toast('폴더를 저장했습니다.');
  } catch (error) { $('folder-form-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  finally { submit.disabled = false; }
}
async function deleteFolder(path) {
  if(path.startsWith('@shared/'))throw new Error('공유 폴더는 읽기 전용입니다.');
  const plan = await api.planFolderDeletion(path);
  if (!plan) { await refreshData(); return; }
  const ids = new Set(plan.sessionIds);
  if ([...state.connections.values()].some(c => ids.has(c.sessionId) && ['connecting', 'connected'].includes(c.status))) throw new Error('폴더 안의 세션을 삭제하기 전에 연결을 종료해 주세요.');
  const details = `${plan.path} 폴더와 하위 폴더 ${plan.folderCount}개, 세션 ${plan.sessionCount}개를 영구 삭제합니다.`;
  if (!(await message('폴더 삭제', details, { confirm: true, danger: true, action: '삭제' }))) return;
  await api.deleteFolder(plan.path, plan.revision);
  state.collapsed = new Set([...state.collapsed].filter(item => item !== plan.path && !item.startsWith(`${plan.path}/`)));
  state.selectedFolder = ''; await refreshData(); toast('폴더와 포함된 항목을 삭제했습니다.');
}
let folderPublishPlan = null, folderPublishBusy = false;
function renderFolderPublishPreview(plan) {
  $('folder-publish-summary').textContent = `${plan.folder} · 세션 ${plan.sessionCount}개${plan.folderCount ? ` · 하위 폴더 ${plan.folderCount}개` : ''}`;
  const tbody = $('folder-publish-rows');
  tbody.replaceChildren();
  for (const item of plan.previewSessions || []) {
    const tr = document.createElement('tr');
    for (const value of [item.folder, item.name, item.host, item.protocol === 'telnet' ? 'Telnet' : 'SSH2', String(item.port)]) {
      const td = document.createElement('td');
      td.textContent = String(value ?? '');
      tr.append(td);
    }
    tbody.append(tr);
  }
  const more = $('folder-publish-more');
  const truncated = Number(plan.truncatedCount) || 0;
  more.textContent = truncated > 0 ? `처음 100개만 표시 · 외 ${truncated}개 포함 전체 ${plan.sessionCount}개 저장` : '';
  more.classList.toggle('hidden', truncated <= 0);
  $('folder-publish-error').textContent = '';
}
async function openFolderPublish(path) {
  if (folderPublishBusy) return;
  if (!path || path.startsWith('@shared/')) throw new Error('로컬 폴더만 게시할 수 있습니다.');
  const plan = await api.previewFolderSharedExport(path);
  if (!plan) return;
  folderPublishPlan = plan;
  renderFolderPublishPreview(plan);
  $('folder-publish-confirm').disabled = false;
  $('folder-publish-cancel').disabled = false;
  $('folder-publish-close').disabled = false;
  $('folder-publish-dialog').showModal();
  $('folder-publish-cancel').focus();
}
function cancelFolderPublish({ close = true } = {}) {
  if (folderPublishBusy) return;
  const token = folderPublishPlan?.token;
  folderPublishPlan = null;
  $('folder-publish-rows').replaceChildren();
  $('folder-publish-error').textContent = '';
  if (close && $('folder-publish-dialog').open) $('folder-publish-dialog').close();
  if (token) void api.cancelFolderSharedExport({ token }).catch(() => {});
}
async function confirmFolderPublish() {
  if (folderPublishBusy || !folderPublishPlan?.token) return;
  folderPublishBusy = true;
  $('folder-publish-confirm').disabled = true;
  $('folder-publish-cancel').disabled = true;
  $('folder-publish-close').disabled = true;
  $('folder-publish-error').textContent = '';
  try {
    const result = await api.saveFolderSharedExport({ token: folderPublishPlan.token, confirm: true });
    if (!result) {
      toast('공유 세션 저장을 취소했습니다.');
      return;
    }
    folderPublishPlan = null;
    $('folder-publish-rows').replaceChildren();
    if ($('folder-publish-dialog').open) $('folder-publish-dialog').close();
    toast(`${result.folder} 폴더의 세션 ${result.sessionCount}개를 공유 JSON으로 저장했습니다.`);
  } catch (error) {
    const msg = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    $('folder-publish-error').textContent = msg;
    if (/변경되었|만료|다시 확인/.test(msg)) folderPublishPlan = null;
  } finally {
    folderPublishBusy = false;
    $('folder-publish-confirm').disabled = !folderPublishPlan;
    $('folder-publish-cancel').disabled = false;
    $('folder-publish-close').disabled = false;
  }
}
function openSessionMove(session) {
  if(session?.sharedSourceId||[...state.selection].some(id=>sessionById(id)?.sharedSourceId))throw new Error('공유 세션은 이동할 수 없습니다.');
  state.moveIds = state.selection.has(session.id) ? [...state.selection] : [session.id]; $('move-session-name').textContent = state.moveIds.length > 1 ? `${state.moveIds.length}개 세션` : session.name;
  fillFolderChoices($('move-session-form').elements.folder, session.folder); $('move-session-error').textContent = '';
  $('move-session-dialog').showModal(); $('move-session-form').elements.folder.focus();
}
async function moveSession(event) {
  event.preventDefault(); const form = $('move-session-form'), submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const folder = form.elements.folder.value; await api.moveSessions({ ids: state.moveIds, folder }); state.selected = state.moveIds[0]; state.selection = new Set(state.moveIds);
    revealFolder(folder); $('move-session-dialog').close(); await refreshData(); toast('세션을 이동했습니다.');
  } catch (error) { $('move-session-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  finally { submit.disabled = false; }
}
function updateSessionProperties(){const s=sessionById(state.selected),properties=$('session-properties');properties.replaceChildren();const details=state.selection.size>1?[['선택',`${state.selection.size}개 세션`],['연결','Enter'],['이동','폴더에 드래그'],['삭제','Delete']]:!s&&state.selectedFolder?[['폴더',state.selectedFolder],['세션',String(sessionTree.folders.get(state.selectedFolder)?.total||0)],['이름 변경','F2']]:[...(s?[['이름',s.name]]:[]),['프로토콜',s?(s.protocol==='telnet'?'Telnet':'SSH2'):'—'],['호스트',s?`${s.host}:${s.port}`:'세션을 선택하세요'],['사용자',s?.username||'—'],['폴더',s?.folder||'—']];for(const [name,value]of details){const detail=el('dd','',value);detail.title=value;properties.append(el('dt','',name),detail);}}
function formValue(form, name, value) { const field = form.elements.namedItem(name); if (field?.type === 'checkbox') field.checked = !!value; else if (field) field.value = value ?? ''; }
function showSessionPage(page) {
  document.querySelectorAll('[data-session-page]').forEach(node => { const selected = node.dataset.sessionPage === page; node.classList.toggle('selected', selected); node.setAttribute('aria-current', selected ? 'page' : 'false'); });
  document.querySelectorAll('[data-session-panel]').forEach(node => node.classList.toggle('hidden', node.dataset.sessionPanel !== page));
  $('session-dialog').querySelector('.session-options-body').scrollTop = 0;
}
function updateQuickSave() {
  const form = $('session-form'), temporary = state.quick && !form.elements.saveQuickSession.checked;
  form.elements.name.required = !temporary;
  $('session-identity').classList.toggle('hidden', temporary); $('favorite-field').classList.toggle('hidden', temporary);
  const key = form.elements.protocol.value === 'ssh' && form.elements.authType.value === 'key' && !form.elements.credentialId.value;
  const remember = form.elements.rememberPassphrase;
  $('remember-credentials').classList.toggle('hidden', !key || temporary);
  remember.disabled = !key || temporary || !state.encryptionAvailable;
  if (state.quick) $('save-session').textContent = temporary ? '연결' : '저장 후 연결';
  $('ssh-jump-fields').querySelector('select').disabled = temporary;
}
function updateTerminalPreview() {
  const form = $('session-form'); previewTypography(document.querySelector('.terminal-preview'),form,true);
  $('cursor-preview').textContent = { bar: '▏', block: '█', underline: '_' }[form.elements.cursorStyle.value];
}
// A saved profile may omit its login. SSH asks for it when connecting.
function updateAuthFields() { const form=$('session-form'),credential=(state.credentials||[]).find(c=>c.id===form.elements.credentialId.value);for(const key of ['username','authType','passphrase','privateKeyPath','agentPath'])form.elements[key].disabled=!!credential;if(credential){form.elements.username.value=credential.username||'';form.elements.authType.value=credential.authType||'password';}const type = form.elements.authType.value, key = type === 'key' && form.elements.protocol.value === 'ssh' && !credential; if(!key)form.elements.passphrase.value='';$('password-fields').classList.toggle('hidden', type !== 'password'); $('key-fields').classList.toggle('hidden', !key); $('agent-fields').classList.toggle('hidden', type !== 'agent'||!!credential); syncPasswordToggles(form); updateQuickSave(); }
function updateProtocolFields(changePort=false){const form=$('session-form'),telnet=form.elements.protocol.value==='telnet';if(telnet&&sessionPortChoice.protocol==='ssh')form.elements.telnetEnter.value='cr';sessionPortChoice.protocol=form.elements.protocol.value;if(changePort&&[22,23].includes(Number(form.elements.port.value)))form.elements.port.value=telnet?23:22;for(const id of ['ssh-auth-fields','remember-credentials','ssh-jump-fields','ssh-forward-fields','ssh-timeout-field','ssh-timeout-hint','ssh-ctrl-arrow-field'])$(id).classList.toggle('hidden',telnet);$('telnet-fields').classList.toggle('hidden',!telnet);$('forward-list').querySelectorAll('input').forEach(field=>field.disabled=telnet);updateAuthFields();updateQuickSave();}
let sessionPortChoice={protocol:'ssh',previousPort:'22',explicitProtocol:false,undoProtocol:null,undoTelnetEnter:null};
function updateProtocolFromPort(){
  const form=$('session-form'),port=form.elements.port.value,previous=sessionPortChoice.previousPort;
  if(port===previous)return;
  const protocol=protocolForEditedPort(port,previous,sessionPortChoice.explicitProtocol);sessionPortChoice.previousPort=port;sessionPortChoice.undoProtocol=null;$('session-port-hint').classList.add('hidden');
  if(!protocol||protocol===form.elements.protocol.value)return;
  sessionPortChoice.undoProtocol=form.elements.protocol.value;sessionPortChoice.undoTelnetEnter=form.elements.telnetEnter.value;form.elements.protocol.value=protocol;updateProtocolFields();
  $('session-port-hint').firstElementChild.textContent=`${Number(port)}번 포트에 맞춰 ${protocol==='telnet'?'Telnet':'SSH2'}로 변경했습니다.`;
  $('session-port-undo').textContent=`${sessionPortChoice.undoProtocol==='ssh'?'SSH2':'Telnet'} 유지`;$('session-port-hint').classList.remove('hidden');
}
function addForward(forward = {}) {
  const row = el('div', 'forward-row');
  for (const [name, placeholder, value, number] of [['bindHost','로컬 주소',forward.bindHost || '127.0.0.1',false],['bindPort','포트',forward.bindPort || '',true],['destHost','대상 호스트',forward.destHost || '127.0.0.1',false],['destPort','포트',forward.destPort || '',true]]) { const input = el('input'); input.dataset.field = name; input.placeholder = placeholder; input.value = value; input.type = number ? 'number' : 'text'; input.required = true; input.setAttribute('aria-label', placeholder); if(number) { input.min = 1; input.max = 65535; } row.append(input); }
  row.append(button('포워딩 삭제', 'close', 'icon-button', () => row.remove())); $('forward-list').append(row);
}
function openSession(s = null, quick = false) {
  if(s?.sharedSourceId){showSharedProfile(s);return;}
  state.editId = s?.id || null; state.quick = quick; const form = $('session-form'); form.reset(); form.querySelector('details').open = false; showSessionPage('connection');
  $('session-dialog-title').textContent = quick ? '빠른 연결' : s?.id ? '세션 속성' : '새 세션'; $('save-session').textContent = quick ? '연결' : '세션 저장'; form.dataset.connectAfter = quick ? 'yes' : '';
  const defaults = { folder: quick || state.selectedFolder.startsWith('@shared/') ? '' : state.selectedFolder, protocol:'ssh', encoding:'utf-8', telnetEnter:'cr', localEcho:false, port: 22, authType:'password', terminalType:'xterm-256color', ctrlArrowMode:'word', keepaliveInterval:30, handshakeTimeout:30, fontFamily:'',fontWeight:'',lineHeight:0,letterSpacing:-1,fontSize:0, scrollback:0, cursorStyle:'bar', cursorBlink:true, backspace:'del', autoReconnect:false, reconnectDelay:5, ...s };
  $('session-folder-options').replaceChildren(...state.folders.map(path => { const option = el('option'); option.value = path; return option; }));
  const typeField = form.elements.terminalType; typeField.querySelectorAll('[data-custom]').forEach(node => node.remove());
  if (![...typeField.options].some(option => option.value === defaults.terminalType)) { const option = el('option', '', defaults.terminalType); option.value = defaults.terminalType; option.dataset.custom = 'true'; typeField.append(option); }
  for (const field of ['fontFamily','fontWeight','lineHeight','letterSpacing','protocol','encoding','telnetEnter','localEcho','name','folder','host','port','username','authType','privateKeyPath','agentPath','rememberPassphrase','favorite','logEnabled','keepaliveInterval','handshakeTimeout','terminalType','ctrlArrowMode','notes','fontSize','scrollback','cursorStyle','cursorBlink','backspace','autoReconnect','reconnectDelay','reconnectAttempts']) formValue(form, field, defaults[field] ?? (field === 'reconnectAttempts' ? 1 : undefined));
  formValue(form, 'tags', (s?.tags || []).join(', ')); formValue(form, 'passphrase', ''); concealPasswordFields(form);
  form.elements.passphrase.placeholder = s?.hasPassphrase ? '저장된 개인키 암호 유지' : '암호화된 개인키일 때만 입력';
  const jump = $('jump-session'); jump.replaceChildren(el('option', '', '직접 연결')); jump.firstChild.value = ''; for (const candidate of state.sessions.filter(item => item.id !== s?.id && item.protocol!=='telnet' && !item.jumpSessionId)) { const option = el('option', '', candidate.name); option.value = candidate.id; jump.append(option); } jump.value = s?.jumpSessionId || '';
  const credentialSelect=$('session-credential');credentialSelect.replaceChildren(new Option('이 세션에 입력한 계정 사용',''),...(state.credentials||[]).map(c=>new Option(c.name,c.id)));credentialSelect.value=s?.credentialId||'';
  $('forward-list').replaceChildren(); (s?.forwards || []).forEach(addForward); $('delete-session').classList.toggle('hidden', !s?.id); $('clear-secrets-label').classList.toggle('hidden', !s?.hasPassphrase); $('session-form-error').textContent = '';
  $('quick-save-field').classList.toggle('hidden', !quick); updateQuickSave(); updateTerminalPreview();loadFontChoices();
  sessionPortChoice={protocol:form.elements.protocol.value,previousPort:form.elements.port.value,explicitProtocol:false,undoProtocol:null,undoTelnetEnter:null};$('session-port-hint').classList.add('hidden');
  $('import-warnings').textContent = (s?.importWarnings || []).join('\n'); $('import-warnings').classList.toggle('hidden', !s?.importWarnings?.length); updateProtocolFields(); $('session-dialog').showModal(); form.elements.name.focus();
}
async function saveSession(event) {
  event.preventDefault(); const form = $('session-form'); updateProtocolFromPort(); if(!form.reportValidity()) return;
  const input = Object.fromEntries(new FormData(form)); for (const key of ['port','keepaliveInterval','handshakeTimeout','fontSize','lineHeight','letterSpacing','scrollback','reconnectDelay','reconnectAttempts']) input[key] = Number(input[key]); input.tags = input.tags.split(',').map(t => t.trim()).filter(Boolean);
  for(const name of ['favorite','logEnabled','clearPassphrase','localEcho','cursorBlink','autoReconnect']) input[name] = form.elements[name].checked;
  const temporary = state.quick && !form.elements.saveQuickSession.checked; delete input.saveQuickSession;
  if (!input.name) input.name = `${input.username ? `${input.username}@` : ''}${input.host}`;
  input.forwards = [...$('forward-list').children].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(field => [field.dataset.field, field.type === 'number' ? Number(field.value) : field.value.trim()]))); input.importWarnings = []; if(state.editId) input.id = state.editId;
  if (!form.elements.rememberPassphrase.disabled) input.rememberPassphrase = form.elements.rememberPassphrase.checked;
  if(input.protocol==='telnet')Object.assign(input,{username:'',rememberPassphrase:false,passphrase:'',privateKeyPath:'',agentPath:'',authType:'password',credentialId:'',jumpSessionId:'',forwards:[],clearPassphrase:true});
  const connectAfter = form.dataset.connectAfter === 'yes';
  $('save-session').disabled = true;
  try {
    if (temporary) {
      const passphrase = input.passphrase || undefined; delete input.passphrase;
      const result = await api.quickConnect(input, { cols: 110, rows: 30, passphrase });
      $('session-dialog').close(); form.elements.passphrase.value = ''; attachConnection(result, result.session);
    } else {
      if (!input.rememberPassphrase) delete input.passphrase;
      const saved = await api.saveSession(input); $('session-dialog').close(); form.elements.passphrase.value = ''; state.selected = saved.id; state.selection = new Set([saved.id]); state.selectionAnchor = saved.id; revealFolder(saved.folder); await refreshData(); toast('세션이 저장되었습니다.'); if(connectAfter) await connectSession(saved.id);
    }
  }
  catch(error) { $('session-form-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  finally { $('save-session').disabled = false; }
}
async function connectSession(sessionId) {
  const s = sessionById(sessionId); if(!s) return;
  if(s.sharedSourceId && state.sharedSources.find(source=>source.id===s.sharedSourceId)?.error)throw new Error('공유 목록을 새로고침한 뒤 연결해 주세요.');
  if (s.importWarnings?.some(w => /firewall|proxy|방화벽|점프/i.test(w))) { await message('연결 경로를 확인해 주세요', '가져온 세션에 프록시나 점프 서버 설정이 있습니다. 고급 설정에서 점프 서버를 지정하고 저장한 뒤 연결해 주세요.'); openSession(s); return; }
  const result = await api.connect(sessionId, { cols: 110, rows: 30 }); attachConnection(result, s);return result.id;
}
function attachConnection(result, profile) {
  const foreground = state.settings.focusNewTab || !state.connections.has(state.active);
  // Ordinary connections open as tabs. Workspace restore reapplies its saved
  // split after opening the requested connections.
  endTabDrag();
  state.split = false;
  state.dockLayout = null;
  createTerminal(result.id, profile, result.logLoss);
  if (foreground) activateTerminal(result.id); else layoutTerminals();
  switchView('sessions');
  const buffered = drainUnknownEvents(result.id); buffered.forEach(handleEvent); renderSessions();
}
function createTerminal(id, session, logLoss) {
  const pane = el('div', 'terminal-pane'); pane.dataset.connectionId = id; const heading = el('div', 'pane-heading');
  const leaveSplit=button('분할 해제 · 일반 탭으로 보기','close','pane-unsplit icon-button',()=>{if(!state.connections.has(pane.dataset.connectionId))return;activateTerminal(pane.dataset.connectionId,false);setSplit('off');state.connections.get(pane.dataset.connectionId)?.terminal.focus();});
  leaveSplit.addEventListener('mousedown',event=>event.stopPropagation());leaveSplit.addEventListener('dragstart',event=>event.preventDefault());
  heading.append(el('span', 'tiny-dot'), el('span', 'pane-title', session.name),leaveSplit); const mount = el('div', 'terminal-mount'),body=el('div','terminal-body'),gutter=el('div','terminal-gutter hidden');gutter.setAttribute('aria-hidden','true');body.append(gutter,mount);pane.append(heading,body);
  const terminal = new Terminal({ ...terminalAppearance(state.settings,session), theme: state.terminalTheme, allowTransparency: true, allowProposedApi: true, convertEol: false, minimumContrastRatio: terminalContrast(state.settings), screenReaderMode: false });
  const fit = new FitAddon(), search = new SearchAddon(); terminal.loadAddon(fit); terminal.loadAddon(search); $('terminal-panes').append(pane); terminal.open(mount);
  const record = { id, sessionId: session.id, profile: { ...session }, protocol:session.protocol||'ssh', name: session.name, host: session.host, port:session.port, username:session.username, status: 'connecting', terminal, fit, search, pane, mount, logging: false, overlay: null, reconnectTimer: null, manualDisconnect: false, reconnecting: false, everConnected: false, telnetFallback: false };
  applyLogLoss(record, logLoss);
  record.authenticationPrompt = createAuthenticationPromptTracker();
  // Tracks whole-screen repaints (device pagers such as ExtremeXOS `show ports`)
  // so the viewport can follow the live screen without ordinary output stealing
  // a scroll position.
  record.repaint = createScreenRepaintDetector();
  // Track IME composition on xterm's hidden textarea. Ctrl+C/Ctrl+Z bypass
  // xterm's composition helper, so the helper still commits the half-typed
  // hangul afterwards. Ownership is tracked per composition session (an id
  // handed out by `compositionstart`) instead of by a time window or by
  // "the first non-ASCII event": a late commit is swallowed only when it
  // belongs to the exact session that was cancelled, so a composition that
  // starts right after the cancel is delivered normally.
  record.composition=createCompositionOwnership();
  const compositionTextarea=terminal.textarea;
  if(compositionTextarea){
    compositionTextarea.addEventListener('compositionstart',()=>record.composition.start());
    compositionTextarea.addEventListener('compositionupdate',event=>record.composition.update(event.data));
    compositionTextarea.addEventListener('compositionend',()=>record.composition.end());
  }
  pane.dataset.renderer='dom';
  record.semantic = new SemanticColorAddon(state.settings); terminal.loadAddon(record.semantic);
  record.gutterOverrides={};record.gutter=new TerminalGutterAddon(gutter,state.settings,{onModeChange:()=>{if(state.connections.get(state.active)===record)updateStatus();}});terminal.loadAddon(record.gutter);
  // One controller per terminal owns the write pump, the burst state machine and
  // the ACK for each IPC event. It is created after the addons so the state
  // machine can quiet them directly.
  record.stream = new TerminalStreamController({
    terminal, semantic: record.semantic, gutter: record.gutter,
    acknowledge: sequence => api.acknowledgeOutput(record.id, sequence),
    isCurrent: () => state.connections.get(record.id) === record,
    observe: bytes => observeOutput(record, bytes),
    connectionId: id,
    onStateChange: state => record.pane?.classList.toggle('output-burst', state === 'burst'),
    // A parser that throws never consumed the bytes, so they are never ACKed. Tell
    // the operator the tab cannot display output any more instead of silently
    // freezing the backlog until the main-side watchdog kills the session.
    onConsumerError: () => {
      record.streamFailed = true;
      if (state.connections.get(record.id) !== record) return;
      record.terminal.writeln('\r\n\x1b[31m터미널 화면 처리가 중단되었습니다. 재접속해 주세요.\x1b[0m');
      showError(new Error('터미널 화면 처리가 중단되었습니다. 재접속해 주세요.'));
    },
  });
  state.connections.set(id, record);
  heading.draggable = true;
  heading.addEventListener('dragstart', event => {if(event.target.closest('.pane-unsplit')){event.preventDefault();return;}dockUI.startDrag(event, record.id);});
  heading.addEventListener('dragend', endTabDrag);
  const compatibilityType=['vt100','vt220','ansi','linux'].includes(session.terminalType)?session.terminalType:'xterm';
  record.compatibility=installTerminalCompatibility(terminal,compatibilityType,text=>record.status==='connected'?api.input(record.id,text):undefined,{sessionKeymap:session.keymap,globalKeymap:state.settings.keymap||[],protocol:session.protocol||'ssh',ctrlArrowMode:session.ctrlArrowMode,onError:showError});
  terminal.onWriteParsed(()=>{if(state.settings.scrollOnOutput&&terminal.buffer.active.type==='normal')terminal.scrollToBottom();});
  terminal.onBell(()=>{if(state.settings.visualBell){pane.classList.add('visual-bell');clearTimeout(record.bellTimer);record.bellTimer=setTimeout(()=>pane.classList.remove('visual-bell'),600);}});
  search.onDidChangeResults(result => {
    record.searchResult = result;
    if (state.active === record.id && !$('terminal-search-box').classList.contains('hidden')) updateSearchResult(record);
  });
  terminal.onData(data => {
    // Ctrl+C/Ctrl+Z bypass xterm's composition helper, so a cancelled hangul
    // composition is still committed afterwards — sometimes hundreds of
    // milliseconds later. `intercept` consumes exactly the claimed session's
    // commit (and only once), so a slow commit is still dropped while the next
    // legitimate syllable and plain ASCII typing reach the device.
    if(record.composition.intercept(data)) return;
    if(record.status === 'connected') { if(/[\r\n\x03]/.test(data)&&!record.authenticationPrompt.sensitive){record.authenticationPrompt.reset();syncCommandPrivacy();} api.input(record.id, record.profile.backspace === 'bs' ? data.replace(/\x7f/g, '\x08') : data).catch(showError); } });
  terminal.onResize(size => resizeTerminal(record, size.cols, size.rows));
  terminal.onSelectionChange(() => {
    if (state.settings.copyOnSelect && state.connections.get(record.id) === record && terminal.hasSelection()) api.writeClipboard(terminal.getSelection()).catch(showError);
  });
  terminal.attachCustomKeyEventHandler(event => {
    if(event.type !== 'keydown') return true;
    if(document.querySelector('dialog[open]')) { shortcutResolver.reset(); return false; }
    if(shouldReconnectOnEnter(record,event)){shortcutResolver.reset();event.preventDefault();reconnectTerminal(record).catch(showError);return false;}
    const mapped = record.compatibility.hasKeyMapping(event), result = shortcutResolver.resolve(event, { terminal: true, editable: true, sendTextMapped: mapped });
    if(result.consume) { event.preventDefault(); if(result.action)executeAppShortcut(result.action,record); return false; }
    if(!mapped && !event.altKey && !event.shiftKey && !event.metaKey && event.ctrlKey) {
      if(event.code === 'KeyC' || event.key === 'c' || event.key === 'C' || event.key === 'ㅊ') {
        event.preventDefault();
        if(record.status === 'connected') {
          if(!record.authenticationPrompt.sensitive) {
            record.authenticationPrompt.reset();
            syncCommandPrivacy();
          }
          // Claim the in-flight IME composition: sending the half-typed hangul
          // after ETX types it into the new prompt on the device. Only this
          // specific composition's commit is dropped.
          record.composition.cancel();
          api.input(record.id, '\x03').catch(showError);
        }
        return false;
      }
      if(event.code === 'KeyZ' || event.key === 'z' || event.key === 'Z' || event.key === 'ㅋ') {
        event.preventDefault();
        if(record.status === 'connected') {
          record.composition.cancel();
          api.input(record.id, '\x1a').catch(showError);
        }
        return false;
      }
    }
    const stroke = strokeFromEvent(event)?.stroke;
    // Cancel browser clipboard defaults for displaced app aliases, then let
    // xterm translate the key (plain Ctrl+V becomes remote 0x16, for example).
    if(!mapped && legacyClipboardKeys.has(stroke)) { event.preventDefault(); return true; }
    const mnemonic=['KeyF','KeyE','KeyV','KeyC','KeyT','KeyH'].indexOf(event.code);
    if(stroke&&event.altKey&&!event.ctrlKey&&!event.shiftKey&&mnemonic>=0){event.preventDefault();if(!event.repeat)document.querySelectorAll('.menu-trigger')[mnemonic]?.click();return false;}
    return record.compatibility.handleKeyEvent(event);
  });
  pane.addEventListener('mousedown', () => { if(state.active !== record.id) activateTerminal(record.id, false); });
  mount.addEventListener('paste', event => {
    event.preventDefault(); event.stopPropagation();
    pasteTerminal(record, event.clipboardData?.getData('text/plain') || '').catch(showError);
  }, true);
  mount.addEventListener('mousedown', event => { if (event.button === 1 && state.settings.middleClickPaste) event.preventDefault(); }, true);
  mount.addEventListener('auxclick', event => {
    if (event.button !== 1 || !state.settings.middleClickPaste) return;
    event.preventDefault(); event.stopPropagation(); pasteClipboard(record).catch(showError);
  });
  body.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (state.settings.rightClickAction === 'paste' && !event.shiftKey) { pasteClipboard(record).catch(showError); return; }
    showTerminalMenu(event, record);
  });
  terminal.writeln(`\x1b[90m${session.protocol==='telnet'?'Telnet':'SSH2'} · ${session.username?`${session.username}@`:''}${session.host}:${session.port} 연결 시작\x1b[0m\r\n`);
  record.observer = new ResizeObserver(() => scheduleFit()); record.observer.observe(mount);
}
async function pasteTerminal(record, text, isCurrent = () => true) {
  const id = record.id;
  const current = () => record.id === id && state.connections.get(id) === record && record.status === 'connected' && !record.closing && !record.manualDisconnect && !record.reconnecting && !record.reconnectOperation && isCurrent();
  if(!text || !current()) return;
  try {
    if(state.settings.confirmMultilinePaste && /[\r\n]/.test(text) && !(await message('여러 줄 붙여넣기', `${record.name}에 아래 내용을 붙여넣습니다. 줄마다 명령어로 실행될 수 있습니다.`, {confirm:true, command:text}))) return;
    if(!current()) return;
    const normalized = text.replace(/\r?\n/g, '\r'), bracketed = record.terminal.modes.bracketedPasteMode;
    record.terminal.clearSelection();
    await api.input(id, bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized);
  } finally { if(current()) record.terminal.focus(); }
}
async function pasteClipboard(record, id = record.id) {
  const current = () => record.id === id && state.connections.get(id) === record && record.status === 'connected' && !record.closing && !record.manualDisconnect && !record.reconnecting && !record.reconnectOperation;
  if(!current()) return;
  const text = await api.readClipboard();
  if(current()) await pasteTerminal(record, text, current);
}
let fitFrame;
function scheduleFit() { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(() => { for(const c of state.connections.values()) if(!c.pane.classList.contains('hidden') && c.mount.clientWidth > 0 && c.mount.clientHeight > 0) { try { c.fit.fit(); } catch {} } updateStatus(); }); }
// Fit a pane that just became visible and push the resulting size to the device.
// A pane shown after being `display:none` has no measurable cell size until the
// browser lays it out, so the fit must run after a frame — and only a real
// dimension change is sent (the services drop no-op resizes).
function fitVisibleTerminal(c) {
  if (!c || c.pane.classList.contains('hidden')) return;
  requestAnimationFrame(() => {
    if (state.connections.get(c.id) !== c || c.closing || c.pane.classList.contains('hidden')) return;
    if (!c.mount.clientWidth || !c.mount.clientHeight) return;
    try { c.fit.fit(); } catch { return; }
    if (['connecting', 'connected'].includes(c.status)) resizeTerminal(c, c.terminal.cols, c.terminal.rows);
    c.semantic.schedule(); c.gutter.schedule();
  });
}
async function resizeTerminal(c, cols, rows) {
  const id = c.id;
  if (state.connections.get(id) !== c || c.closing || c.manualDisconnect || !['connecting', 'connected'].includes(c.status)) return;
  try { await api.resize(id, cols, rows); }
  catch (error) {
    const stillActive=state.connections.get(id)===c && c.id===id && !c.closing && !c.manualDisconnect && ['connecting', 'connected'].includes(c.status);
    const expectedClose=error?.code==='NOT_CONNECTED' || /(?:^|\s)NOT_CONNECTED(?:\s|$)/.test(String(error?.message||''));
    // Do not hide a real resize failure merely because a status/close event won
    // the race. Only a proven closed-attempt NOT_CONNECTED is benign.
    if (stillActive || !expectedClose) showError(error);
  }
}
function activateTerminal(id, focus = true) { shortcutResolver.reset(); if(!state.connections.has(id)) return; if(document.activeElement!==$('connection-address')){const c=state.connections.get(id);if(c){$('connection-address').value=c.name;hideAddressSuggestions();}} if(state.dockLayout&&!dockIds(state.dockLayout).includes(id)){const target=dockIds(state.dockLayout).includes(state.active)?state.active:dockIds(state.dockLayout)[0];state.dockLayout=replaceDock(state.dockLayout,target,{id});} for(const c of state.connections.values())if(c.id!==id)c.search.clearDecorations();hideCommandSuggestions();commandHistoryIndex=-1;state.active = id;state.emptyWorkspace=false;switchView('sessions');layoutTerminals();updateStatus();syncActiveTab();fitVisibleTerminal(state.connections.get(id));if(focus)state.connections.get(id).terminal.focus();if(!$('terminal-search-box').classList.contains('hidden'))findTerminal(false,true);if(state.files)loadFiles().catch(showError); }
// Reflect the active tab immediately. `switchView()` rebuilds the tab strip, but
// a rebuild can be skipped while a drag is in flight, and the click that started
// the switch must still land on a selected, announced tab.
function syncActiveTab() {
  for (const tab of $('tabs').querySelectorAll('.terminal-tab')) {
    const active = tab.dataset.connectionId === state.active && !state.emptyWorkspace;
    tab.classList.toggle('active', active);
    tab.tabIndex=active?0:-1;
    tab.setAttribute('aria-selected', String(active));
  }
  const current = $('tabs').querySelector('.terminal-tab.active');
  if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function applyAuthState(c, event) {
  const phases=['transport-ready','host-key','credential-await','authenticating','ready'];
  if (!c || c.closing || c.manualDisconnect || c.status !== 'connecting' || event.id !== c.id || event.generation !== c.id ||
      !Number.isSafeInteger(event.sequence) || event.sequence <= (c.authSequence || 0) || !phases.includes(event.phase)) return false;
  c.authSequence=event.sequence; c.authState=event.phase;
  return true;
}
function tabVisualState(c) {
  const names={connected:'연결됨',connecting:'연결 중',disconnected:'연결 종료',error:c.authCancelled?'연결 취소':'연결 실패'};
  const phases={'transport-ready':'서버 연결됨','host-key':'서버 키 확인','credential-await':'인증 대기',authenticating:'인증 중',ready:'연결 준비 중'};
  const label=c.status==='connecting'&&Object.hasOwn(phases,c.authState)?phases[c.authState]:null;
  const key=c.status==='connecting'&&c.authState==='credential-await'?'auth-waiting':Object.hasOwn(names,c.status)?c.status:'connecting';
  return {key,label:label||names[key]};
}
function renderTabs() {
  $('tabbar').classList.toggle('hidden', state.connections.size === 0);
  // Preserve the native drag source while status events continue to arrive.
  if (state.tabDrag && state.connections.has(state.tabDrag)) return;
  if (state.tabDrag) { state.tabDrag = null; dockUI?.clearPreview(); }
  const tabs = $('tabs'), focused=tabs.contains(document.activeElement)?document.activeElement?.dataset.connectionId:null, scrollLeft=tabs.scrollLeft;
  tabs.replaceChildren();
  for(const c of state.connections.values()) {
    const visual=tabVisualState(c);
    const tab = el('button', `terminal-tab ${visual.key}${state.active === c.id && !state.emptyWorkspace ? ' active' : ''}`);
    tab.dataset.connectionId=c.id; tab.type='button'; tab.draggable = true; tab.tabIndex=c.id === state.active && !state.emptyWorkspace ? 0 : -1; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(c.id === state.active && !state.emptyWorkspace)); tab.setAttribute('aria-label',`${c.name} · ${visual.label}`);
    const tabTitle=()=>`${c.name} · ${visual.label}\n${c.username?`${c.username}@`:''}${c.host}:${c.port}${c.profile.temporary?' · 임시 연결':''}${c.protocol==='telnet'?'\nTelnet · 암호화 없음':''}${c.autoFallbackFrom?`\nSSH(${c.autoFallbackFrom.port}) 닫힘 · Telnet 자동 전환`:''}${c.commandSelected?'\n선택한 탭 그룹 (Ctrl+클릭으로 해제)':''}`;tab.title=tabTitle();
    const groupMark=el('span','tab-group-mark','✓');groupMark.setAttribute('aria-hidden','true');
    const dot=el('span','tiny-dot');dot.setAttribute('aria-hidden','true');
    tab.append(dot,groupMark,el('span','tab-label',c.name));
    if (!['connected','disconnected'].includes(c.status) && !(c.status==='error' && !c.authCancelled)) { const stateLabel=el('span','tab-state-label',visual.label);stateLabel.setAttribute('aria-hidden','true');tab.append(stateLabel); }
    const close = el('span','tab-close'); close.innerHTML=icon('close'); close.setAttribute('aria-label',`${c.name} 탭 닫기`);
    close.addEventListener('click',event=>{event.stopPropagation();closeTerminal(c.id).catch(showError);}); tab.append(close);
    tab.classList.toggle('automation-running',!!c.automationRunning);tab.classList.toggle('command-selected',!!c.commandSelected);
    tab.addEventListener('click',event=>{if(event.ctrlKey||event.metaKey){c.commandSelected=!c.commandSelected;tab.classList.toggle('command-selected',c.commandSelected);tab.title=tabTitle();updateCommandTargetLabel();return;}activateTerminal(c.id);}); tab.addEventListener('contextmenu', event => { event.preventDefault(); showTabMenu(event, c); });
    tab.addEventListener('dragstart', event => dockUI.startDrag(event, c.id));
    tab.addEventListener('dragover', event => { if (!state.tabDrag || state.tabDrag === c.id) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const after = event.clientX > tab.getBoundingClientRect().left + tab.clientWidth / 2; tab.dataset.dropSide = after ? 'after' : 'before'; });
    tab.addEventListener('dragleave', () => delete tab.dataset.dropSide);
    tab.addEventListener('drop', event => { if (!state.tabDrag) return; event.preventDefault(); const from = state.tabDrag, after = event.clientX > tab.getBoundingClientRect().left + tab.clientWidth / 2; endTabDrag(); reorderTab(from, c.id, after); });
    tab.addEventListener('dragend', endTabDrag); tabs.append(tab);
  }
  if(focused){const replacement=[...tabs.children].find(tab=>tab.dataset.connectionId===focused);replacement?.focus({preventScroll:true});}
  tabs.scrollLeft=scrollLeft;
  requestAnimationFrame(updateTabControls);
}
function handleTabKey(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs=[...$('tabs').querySelectorAll('.terminal-tab')], index=tabs.findIndex(tab=>tab.dataset.connectionId===event.target.dataset.connectionId);
  if (index<0 || !tabs.length) return;
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  event.preventDefault(); activateTerminal(tabs[next].dataset.connectionId,false); $('tabs').querySelector('.terminal-tab.active')?.focus({preventScroll:true});
}
function endTabDrag() { const dragging = state.tabDrag; state.tabDrag = null; dockUI?.clearPreview(); document.querySelectorAll('.terminal-tab, .pane-heading').forEach(node => { node.classList.remove('dragging'); delete node.dataset.dropSide; }); if (dragging) renderTabs(); }
function reorderTab(from, to, after) {
  if (from === to || !state.connections.has(from) || !state.connections.has(to)) return;
  const ids = [...state.connections.keys()].filter(id => id !== from), target = ids.indexOf(to); ids.splice(target + (after ? 1 : 0), 0, from);
  state.connections = new Map(ids.map(id => [id, state.connections.get(id)])); renderTabs(); layoutTerminals();
}
function updateTabControls() {
  const tabs = $('tabs'); $('tab-scroll-left').disabled = tabs.scrollLeft <= 1; $('tab-scroll-right').disabled = tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 1;
  const overflow=tabs.scrollWidth>tabs.clientWidth+1;$('tab-scroll-left').classList.toggle('hidden',!overflow);$('tab-scroll-right').classList.toggle('hidden',!overflow);
  $('tab-list').disabled = state.connections.size === 0; $('tab-list').title = `열린 세션 ${state.connections.size}개`;
}
function layoutTerminals() {
  dockUI?.clearPreview();
  if (state.dockLayout) state.dockLayout = mapDock(state.dockLayout, id => state.connections.has(id) ? id : null);
  const docked = state.split && dockIds(state.dockLayout).length > 1;
  if (!docked) state.dockLayout = null;
  const visible = docked ? new Set(dockIds(state.dockLayout)) : null;
  $('terminal-panes').classList.toggle('docked', docked);
  if (!docked) dockUI?.reset();
  $('toggle-split').querySelector('[data-icon]').innerHTML=icon(state.split&&state.splitDirection==='rows'?'splitRows':'split');
  const sshActive=state.connections.get(state.active)?.protocol!=='telnet';$('terminal-panes').classList.toggle('split',state.split && state.connections.size>1); $('toggle-split').classList.toggle('active',state.split); $('toggle-files').classList.toggle('active',state.files&&sshActive); $('file-panel').classList.toggle('hidden',!state.files||!sshActive);
  $('terminal-panes').classList.toggle('split-rows', state.splitDirection === 'rows'); $('terminal-panes').style.setProperty('--pane-count', state.connections.size);
  for(const c of state.connections.values()) { c.pane.classList.toggle('hidden',docked ? !visible.has(c.id) : !state.split && c.id !== state.active); c.pane.classList.toggle('active',c.id===state.active); c.pane.classList.toggle('in-split',state.split && state.connections.size>1); }
  // Re-appending every pane on every tab switch re-ran the container's mutation
  // observers and detached/reattached live canvases, which is what made a switch
  // under load stall. The DOM order must still follow tab order (split layout and
  // the pane tests depend on it), so only a changed order re-appends.
  const container = $('terminal-panes'), desired = [...state.connections.values()].map(c => c.pane);
  const current = [...container.children].filter(node => node.classList.contains('terminal-pane'));
  if (current.length !== desired.length || current.some((node, index) => node !== desired[index])) {
    for (const pane of desired) container.append(pane);
  }
  if (docked) { $('terminal-panes').style.removeProperty('grid-template-columns'); $('terminal-panes').style.removeProperty('grid-template-rows'); dockUI.renderLayout(); }
  else renderSplitters();
  for(const c of state.connections.values())c.stream?.setVisible(!c.pane.classList.contains('hidden'));
  terminalResources.syncVisible(state.connections.values());
  for(const c of state.connections.values())if(!c.pane.classList.contains('hidden')){c.semantic.schedule();c.gutter.schedule();}
  scheduleFit();
  persistLayout();
}
function applySplitTracks() {
  const grid = $('terminal-panes'), columns = state.splitTracks.columns, rows = state.splitTracks.rows;
  grid.style.gridTemplateColumns = columns.map(weight => `${weight}fr`).join(' '); grid.style.gridTemplateRows = rows.map(weight => `${weight}fr`).join(' ');
  for (const divider of grid.querySelectorAll('.split-divider')) {
    const axis = divider.dataset.axis, index = Number(divider.dataset.index), tracks = state.splitTracks[axis], total = tracks.reduce((sum, value) => sum + value, 0), ratio = tracks.slice(0, index + 1).reduce((sum, value) => sum + value, 0) / total;
    divider.style[axis === 'columns' ? 'left' : 'top'] = `calc(${ratio * 100}% + ${(index + .5 - ratio * (tracks.length - 1)) * 4 - 2}px)`; divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }
  scheduleFit();
  persistLayout();
}
function resizeSplit(axis, index, tracks, delta, extent) {
  const total = tracks.reduce((sum, value) => sum + value, 0), pair = tracks[index] + tracks[index + 1];
  const available = Math.max(1, extent - (tracks.length - 1) * 4), minimum = Math.min(pair * .4, (axis === 'columns' ? 96 : 64) / available * total);
  const first = Math.max(minimum, Math.min(pair - minimum, tracks[index] + delta / available * total));
  state.splitTracks[axis] = [...tracks]; state.splitTracks[axis][index] = first; state.splitTracks[axis][index + 1] = pair - first; applySplitTracks();
}
function renderSplitters() {
  const grid = $('terminal-panes'); grid.querySelectorAll('.split-divider').forEach(node => node.remove());
  if (!state.split || state.connections.size < 2) { grid.style.removeProperty('grid-template-columns'); grid.style.removeProperty('grid-template-rows'); return; }
  const count = state.connections.size, columns = state.splitDirection === 'rows' ? 1 : Math.min(2, count), rows = Math.ceil(count / columns);
  if (state.splitTracks.columns.length !== columns) state.splitTracks.columns = Array(columns).fill(1);
  if (state.splitTracks.rows.length !== rows) state.splitTracks.rows = Array(rows).fill(1);
  for (const axis of ['columns', 'rows']) for (let index = 0; index < state.splitTracks[axis].length - 1; index++) {
    const divider = el('div', 'split-divider'); divider.tabIndex = 0; divider.dataset.axis = axis; divider.dataset.index = String(index); divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', axis === 'columns' ? 'vertical' : 'horizontal'); divider.setAttribute('aria-label', axis === 'columns' ? '좌우 분할 크기' : '상하 분할 크기'); divider.setAttribute('aria-valuemin', '0'); divider.setAttribute('aria-valuemax', '100'); divider.title = '드래그해 크기 조절 · 두 번 클릭하면 같은 크기로';
    let drag;
    divider.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); const rect = grid.getBoundingClientRect(); drag = { start: axis === 'columns' ? event.clientX : event.clientY, extent: axis === 'columns' ? rect.width : rect.height, tracks: [...state.splitTracks[axis]] }; divider.setPointerCapture(event.pointerId); });
    divider.addEventListener('pointermove', event => { if (drag) resizeSplit(axis, index, drag.tracks, (axis === 'columns' ? event.clientX : event.clientY) - drag.start, drag.extent); });
    divider.addEventListener('pointerup', () => { drag = null; }); divider.addEventListener('lostpointercapture', () => { drag = null; });
    divider.addEventListener('keydown', event => { const keys = axis === 'columns' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']; if (!keys.includes(event.key)) return; event.preventDefault(); resizeSplit(axis, index, [...state.splitTracks[axis]], event.key === keys[0] ? -12 : 12, axis === 'columns' ? grid.clientWidth : grid.clientHeight); });
    divider.addEventListener('dblclick', () => { state.splitTracks[axis].fill(1); applySplitTracks(); }); grid.append(divider);
  }
  applySplitTracks();
}
async function closeTerminal(id, { confirm = true } = {}) {
  shortcutResolver.reset();
  const c=state.connections.get(id); if(!c || c.closePending)return; c.closePending = true;
  try {
    if(confirm && state.settings.confirmTabClose && ['connected','connecting'].includes(c.status) && !(await message('탭 닫기',`${c.name} 탭을 닫고 연결을 종료할까요?`,{confirm:true,action:'탭 닫기'})))return;
    if(state.connections.get(c.id)!==c)return;
    c.closing = true; id = c.id; await disconnectTerminal(c); if(c.reconnectDone)await c.reconnectDone; retireConnection(id); c.stream?.dispose(); c.observer.disconnect(); terminalResources.release(c); c.compatibility?.dispose(); c.terminal.dispose(); c.pane.remove(); state.connections.delete(id); if (c.profile.temporary) await api.releaseTemporary(c.sessionId); if(state.dockLayout){state.dockLayout=mapDock(state.dockLayout,key=>key===id?null:key);if(state.active===id)state.active=dockIds(state.dockLayout)[0]||[...state.connections.keys()].at(-1)||null;if(dockIds(state.dockLayout).length<2){state.dockLayout=null;state.split=false;}}else if(state.active===id)state.active=[...state.connections.keys()].at(-1)||null; if(!state.connections.size){state.files=false;state.split=false;$('connection-address').value='';hideAddressSuggestions();}
    renderTabs(); if(state.active)activateTerminal(state.active);else layoutTerminals(); switchView(state.view); renderSessions(); updateStatus();
  } finally { c.closePending = false; c.closing = false; }
}
async function closeTerminals(ids) {
  const records = ids.map(id => state.connections.get(id)).filter(Boolean); if (!records.length) return;
  if (state.settings.confirmTabClose && records.some(c => ['connected', 'connecting'].includes(c.status)) && !(await message('탭 닫기', `${records.length}개 탭을 닫습니다.\n${records.map(c => c.name).join('\n')}`, { confirm: true,action:'탭 닫기' }))) return;
  for (const c of records) await closeTerminal(c.id, { confirm: false });
}
function applyLogLoss(c, loss) {
  if (!loss) return;
  if (loss.lossCount > 0) {
    c.logIncomplete = true;
    c.logLossCount = Math.max(c.logLossCount || 0, loss.lossCount);
    c.logDroppedBytes = Math.max(c.logDroppedBytes || 0, loss.droppedLogBytes || 0);
    c.logUnconfirmedBytes = Math.max(c.logUnconfirmedBytes || 0, loss.unconfirmedLogBytes || 0);
    c.logLossAt = Math.max(c.logLossAt || 0, loss.lastAt || 0);
  }
  c.logJournalFailed = !!loss.persistenceFailed;
}
function updateStatus() {
  $('toggle-log').classList.toggle('active',!!state.connections.get(state.active)?.logging);$('toggle-log').title=state.connections.get(state.active)?.logPath||'현재 세션 로그 저장';
  const c=state.emptyWorkspace?null:state.connections.get(state.active); const logNote=[c?.logIncomplete?`로그 불완전 · 손실/미확인 최대 ${c.logDroppedBytes||0} 바이트 · 미확인 ${c.logUnconfirmedBytes||0} 바이트${c.logLossCount?` · ${c.logLossCount}회`:''}${c.logLossAt?` · ${new Date(c.logLossAt).toLocaleString()}`:''}${c.logError?` · ${c.logError}`:''}`:'',c?.logJournalFailed?'로그 손실 기록 저장/불러오기 실패 · 재시작 후 경고를 복원하지 못할 수 있습니다.':''].filter(Boolean).join(' · '); $('toggle-log').title=logNote || c?.logPath || '현재 세션 로그 저장';
  const names={connected:'연결됨',connecting:'연결 중',disconnected:'연결 종료',error:c?.authCancelled?'연결 취소':'연결 실패'};
  const healthy=!c||(c.status==='connected'&&!c.receivePaused&&!c.reconnecting&&!c.reconnectOperation&&!c.reconnectTimer);
  let status=c?`${names[c.status]||'연결 중'} · ${c.username?`${c.username}@`:''}${c.host}`:'';
  if(c?.status==='connecting'&&c.authState){const phases={'transport-ready':'서버 연결됨','host-key':'서버 키 확인','credential-await':'인증 대기',authenticating:'인증 중',ready:'연결 준비 중'};if(Object.hasOwn(phases,c.authState))status=`${phases[c.authState]} · ${c.host}`;}
  if(c?.receivePaused&&c.status==='connected')status='출력 처리 대기 · 연결 유지';
  if(c?.reconnectTimer)status='재접속 대기';else if((c?.reconnecting||c?.reconnectOperation)&&!(c.status==='connecting'&&c.authState&&['transport-ready','host-key','credential-await','authenticating','ready'].includes(c.authState)))status='재접속 중';
  if(c?.disconnectReason&&(!healthy))status+=` · ${c.disconnectReason}`;
  $('status-text').textContent=status;$('status-text').title=status;
  $('status-text').classList.toggle('hidden',healthy);$('status-dot').classList.toggle('hidden',healthy);$('status-detail').classList.toggle('hidden',healthy);$('status-dot').dataset.status=c?.status||'';
  $('status-terminal').textContent=c?`${(c.profile.encoding||'utf-8').toUpperCase()} · ${c.terminal.cols} × ${c.terminal.rows}${c.logging?' · LOG':''}${c.logIncomplete?' · ⚠ 로그 불완전':''}${c.logJournalFailed?' · ⚠ 손실 기록 오류':''}`:'UTF-8';$('status-terminal').title=logNote;$('status-protocol').textContent=c?(c.protocol==='telnet'?'TELNET · 암호화 없음':'SSH2'):'';$('status-protocol').classList.toggle('telnet',c?.protocol==='telnet');$('status-protocol').classList.toggle('hidden',!c);$('status-protocol-divider').classList.toggle('hidden',!c||healthy);
  // A narrow pane may shorten or hide the time column; say so instead of silently dropping it.
  const timeMode=c?.gutter?.timeMode,gutterNote={compact:'시간 시:분 표시 · 좁은 창',hidden:'시간 숨김 · 좁은 창'}[timeMode]||'';$('status-gutter').textContent=gutterNote;$('status-gutter').title=gutterNote?'터미널 영역이 넓어지면 시간 열을 원래대로 표시합니다.':'';$('status-gutter').classList.toggle('hidden',!gutterNote);
  const connected=c?.status==='connected';for(const id of ['toggle-log','send-command','command-input'])$(id).disabled=!connected;$('disconnect-active').disabled=!c||(!['connected','connecting'].includes(c.status)&&!c.reconnectTimer&&!c.reconnectOperation);$('reconnect-active').disabled=!c||c.reconnecting||c.reconnectOperation;$('toggle-files').disabled=!connected||c.protocol==='telnet';$('terminal-search').disabled=!c;$('toggle-split').disabled=state.connections.size<2;
  $('send-command').disabled = !connected || !!state.commandSending;
  $('command-input').disabled = !connected || !!state.commandSending;
  syncCommandPrivacy();
  for(const id of ['connect-selected','tree-connect'])$(id).disabled=!state.selection.size&&!sessionById(state.selected);
  for(const id of ['edit-selected','tree-edit'])$(id).disabled=state.selection.size>1||!!sessionById(state.selected)?.sharedSourceId||state.selectedFolder.startsWith('@shared/')||(!sessionById(state.selected)&&!state.selectedFolder);
  document.querySelectorAll('.snippet-card').forEach(node => node.setAttribute('aria-disabled', String(!connected))); syncMenuStates();
}
const prompts=[]; let activePrompt=null;
function nextPrompt() {
  if(activePrompt || !prompts.length)return; activePrompt=prompts.shift(); const p=activePrompt; const body=$('prompt-body'); body.replaceChildren(); $('prompt-form').reset(); $('prompt-submit').textContent='확인';
  const field=(label,name,type='password')=>{const wrapper=el('label','',label), input=el('input'); input.name=name;input.type=type;input.autocomplete='off';input.required=true;
    if(type==='password'){const box=el('div','input-password-wrapper'),toggle=el('button','password-toggle-button');toggle.type='button';toggle.setAttribute('aria-label',passwordToggleLabel(label,false));box.append(input,toggle);wrapper.append(box);bindPasswordToggle(box);}
    else wrapper.append(input);
    body.append(wrapper);return input;};
  if(p.kind==='host-key' || p.kind==='host-key-changed') {
    const changed=p.kind==='host-key-changed';
    $('prompt-eyebrow').textContent='SSH 호스트 키';
    $('prompt-title').textContent=changed?'저장된 호스트 키가 다릅니다':'처음 연결하는 서버입니다';
    body.append(el('p','',`${p.host}:${p.port}`));
    if(changed){
      body.append(el('p','','서버 키가 변경되었습니다. 확인된 장비만 새 키로 덮어쓰세요.'),el('span','field-hint','저장된 키'),el('div','fingerprint previous-fingerprint',p.previousFingerprint),el('span','field-hint','새 키'));
    } else body.append(el('p','','이 서버의 키를 저장하고 연결할까요?'));
    body.append(el('div','fingerprint new-fingerprint',p.fingerprint));
    $('prompt-submit').textContent=changed?'덮어쓰고 연결':'저장하고 연결';
  }
  else if(p.kind==='keyboard-interactive') { $('prompt-eyebrow').textContent='서버 인증';$('prompt-title').textContent=p.name||'서버 인증';if(p.session?.host)body.append(el('p','',sessionAddress(p.session)));if(p.instructions)body.append(el('p','',p.instructions));(p.prompts||[]).forEach((item,index)=>field(item.prompt,`answer-${index}`,item.echo?'text':'password')); }
  else {
    $('prompt-eyebrow').textContent=p.batch?'일괄 실행 인증':'SSH 인증';
    $('prompt-title').textContent=p.purpose==='enable'?'관리자 모드 인증':p.purpose==='telnet-login'?'Telnet 로그인':p.session?.needsUsername?'SSH 로그인':`${p.session?.name||p.name||'SSH'} 인증`;
    if (p.session?.host) body.append(el('p','',sessionAddress({ ...p.session, username: '' })));
    if (p.session?.username) body.append(el('p','',p.session.username));
    const explicit = Array.isArray(p.fields);
    const requested = explicit ? [...new Set(p.fields.filter(name=>['username','password','passphrase'].includes(name)))]
      : [...(p.session?.needsUsername?['username']:[]), ...(p.session?.authType==='agent'?[]:[['key','publickey'].includes(p.session?.authType)?'passphrase':'password'])];
    for (const name of requested) {
      const input = field(name==='username'?'사용자 이름':name==='passphrase'?'개인키 암호':'비밀번호',name,name==='username'?'text':'password');
      input.maxLength=name==='username'?256:16384;
      if(!explicit && name==='passphrase' && p.session?.needsUsername)input.required=false;
    }
  }
  $('prompt-dialog').showModal();
  if(p.kind==='host-key-changed')$('prompt-cancel').focus();
  else if(p.kind==='host-key')$('prompt-submit').focus();
  else (body.querySelector('input:not([type=checkbox])')||$('prompt-submit')).focus();
}
$('prompt-dialog').addEventListener('keydown',event=>{
  if(!['host-key','host-key-changed'].includes(activePrompt?.kind)||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();
  const buttons=[$('prompt-cancel'),$('prompt-submit')],index=buttons.indexOf(document.activeElement);
  const next=event.key==='Home'?0:event.key==='End'?1:(Math.max(0,index)+(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length;
  buttons[next].focus();
});
async function answerPrompt(cancel=false) {
  if(!activePrompt)return;const p=activePrompt;let answer={accept:false,cancelled:true};
  if(cancel && !p.batch && p.connectionId){const c=state.connections.get(p.connectionId);if(c?.id===p.connectionId&&c.status==='connecting')c.authCancelRequested=true;}
  if(!cancel){const values=Object.fromEntries(new FormData($('prompt-form')));if(p.kind==='host-key' || p.kind==='host-key-changed')answer={accept:true,remember:true,replace:p.kind==='host-key-changed'};else if(p.kind==='keyboard-interactive')answer={answers:(p.prompts||[]).map((_,index)=>values[`answer-${index}`]||'')};else answer=Object.fromEntries(['username','password','passphrase'].filter(name=>Object.hasOwn(values,name)&&(!Array.isArray(p.fields)||p.fields.includes(name))).map(name=>[name,values[name]]));}
  $('prompt-dialog').close();$('prompt-form').reset();$('prompt-body').replaceChildren();activePrompt=null;
  try { await api.reply(p.requestId,answer); } finally { nextPrompt(); }
}
function applyWindowState({ maximized, focused, runtimeTransparent }) {
  document.body.classList.toggle('window-maximized', maximized);
  document.body.classList.toggle('window-inactive', !focused);
  const button = document.querySelector('[data-window="maximize"]');
  button.title = maximized ? '이전 크기로 복원' : '최대화';
  button.setAttribute('aria-label', button.title);
  if(applyRuntimeTransparency(runtimeTransparent)&&state.settingsLoaded)applySettings();
}
// Preload hands over a byte view when possible. Never copy unconditionally: a
// `new Uint8Array(typedArray)` would duplicate every burst slice.
function decodeOutputBytes(data){
  if(typeof data==='string'){const raw=atob(data),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}
  if(data instanceof Uint8Array)return data;
  if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
  if(data instanceof ArrayBuffer)return new Uint8Array(data);
  return new Uint8Array(0);
}
// Per-slice observation, called by the stream controller once for each submitted
// xterm slice. It must stay O(slice): the privacy tracker and the repaint detector
// only look at the bytes in front of them, never at the transcript.
function observeOutput(record,bytes){
  const wasSensitive=record.authenticationPrompt.sensitive;
  record.authenticationPrompt.write(bytes);
  if(wasSensitive!==record.authenticationPrompt.sensitive)syncCommandPrivacy();
  // A device pager repaints the whole screen in place. If the user has scrolled
  // back, that repaint lands on the live screen the viewport is not showing, so
  // `u`/`d` looks like it does nothing. Follow the live screen for a repaint
  // only; ordinary output must never steal a scroll position.
  const repaint=record.repaint?.observe(bytes);
  if(repaint&&record.terminal.buffer.active.type==='normal')record.terminal.scrollToBottom();
}
function bufferUnknownEvent(id,event){
  // Bounded early-event retention while a record is still being created. The old
  // code kept up to 256 events per id with no byte cap and no expiry, so a very
  // fast connect could hold megabytes of terminal output forever.
  const now=Date.now();
  // A bounded sweep at most once a second: TTL used to be checked only when the
  // same id produced another event, so an abandoned connection's bytes stayed in
  // the global counter indefinitely.
  if(now-(state.earlyBufferSweptAt||0)>=1000){state.earlyBufferSweptAt=now;expireEarlyBuffers(now);}
  let entry=state.eventBuffer.get(id);
  if(entry&&now-entry.at>EARLY_BUFFER_TTL_MS){
    // An expired entry's bytes are being discarded: they must leave the global
    // counter, or the process budget shrinks on every reconnect forever.
    state.earlyBufferBytes=Math.max(0,(state.earlyBufferBytes||0)-entry.bytes);
    state.eventBuffer.delete(id);
    entry=null;
  }
  if(!entry){entry={events:[],bytes:0,at:now};state.eventBuffer.set(id,entry);}
  const size=eventSize(event);
  if(entry.events.length>=EARLY_BUFFER_MAX_EVENTS||entry.bytes+size>EARLY_BUFFER_MAX_BYTES||state.earlyBufferBytes+size>EARLY_BUFFER_GLOBAL_BYTES){
    // Never ACK a dropped event: the bounded backlog policy is reported instead of
    // pretending the parser consumed it. The main connection has to be torn down
    // too — retiring the id only stops the renderer from displaying output, while
    // the transport would keep producing events nothing consumes.
    retireConnection(id);
    api.disconnect(id).catch(()=>{});
    showError(new Error('연결 초기 출력이 너무 많아 연결을 종료했습니다. 재접속해 주세요.'));
    return;
  }
  entry.events.push(event);entry.bytes+=size;state.earlyBufferBytes+=size;
}
// Bounded sweep so a connection that never completes does not hold its early
// events until some other event for the same id arrives.
function expireEarlyBuffers(now=Date.now()){
  for(const [id,entry] of state.eventBuffer){
    if(now-entry.at<=EARLY_BUFFER_TTL_MS)continue;
    state.eventBuffer.delete(id);
    state.earlyBufferBytes=Math.max(0,(state.earlyBufferBytes||0)-entry.bytes);
  }
}
function eventSize(event){const data=event?.data;if(typeof data==='string')return data.length;if(data&&typeof data.byteLength==='number')return data.byteLength;return 64;}
function drainUnknownEvents(id){
  const entry=state.eventBuffer.get(id);state.eventBuffer.delete(id);
  if(!entry)return [];
  state.earlyBufferBytes-=entry.bytes;if(state.earlyBufferBytes<0)state.earlyBufferBytes=0;
  return entry.events;
}
function handleEvent(event) {
  if(event.type==='update-notice'){queueUpdateNotice();return;}
  if(event.type==='stage-progress'){showUpdateProgress(event);return;}
  if(event.type==='batch'){getBatchUI().onEvent(event);return;}
  if(event.type==='automation-screen'){
    const c=state.connections.get(event.connectionId),r=event.rectangle;let text=null;
    if(c?.status==='connected'&&r&&Object.values(r).every(Number.isInteger)){
      const b=c.terminal.buffer.active,lines=[];
      for(let row=r.row1;row<=Math.min(r.row2,c.terminal.rows);row++){const start=row===r.row1?r.col1-1:0,end=row===r.row2?r.col2:c.terminal.cols;lines.push(b.getLine(b.baseY+row-1)?.translateToString(false,start,end)||'');}
      text=lines.join('\r\n');
    }
    api.automationScreenReply(event.requestId,text).catch(showError);return;
  }
  if(event.type==='automation'){advanced.onEvent(event);return;}
  if(event.type==='window-state'){applyWindowState(event);return;}
  if(event.type==='shared-sessions-changed'){refreshData().catch(showError);return;}
  if(event.type==='shared-startup-notice'){showSharedStartupNotice().catch(showError);return;}
  if(event.type==='shared-config-error'){showError(new Error(event.message));return;}
  if(event.type==='log-loss'){for(const c of state.connections.values())if(c.sessionId===event.profileId)applyLogLoss(c,event.logLoss);updateStatus();return;}
  if(event.type==='prompt'){if(retiredConnectionIds.has(event.connectionId))return;prompts.push(event);nextPrompt();renderTabs();return;}
  if(event.type==='prompt-expired'){const index=prompts.findIndex(p=>p.requestId===event.requestId);if(index>=0)prompts.splice(index,1);if(activePrompt?.requestId===event.requestId){$('prompt-dialog').close();$('prompt-form').reset();$('prompt-body').replaceChildren();activePrompt=null;nextPrompt();}renderTabs();return;}
  const id=event.id||event.connectionId;if(retiredConnectionIds.has(id))return;const c=state.connections.get(id);
  if(!c){if(id)bufferUnknownEvent(id,event);return;}
  if(event.type==='auth-state'){if(applyAuthState(c,event)){renderTabs();updateStatus();}return;}
  if(event.logLoss)applyLogLoss(c,event.logLoss);
  if(event.logIncomplete){c.logIncomplete=true;c.logDroppedBytes=Math.max(c.logDroppedBytes||0,event.droppedLogBytes||0);c.logUnconfirmedBytes=Math.max(c.logUnconfirmedBytes||0,event.unconfirmedLogBytes||0);}
  if(event.type==='data') { c.outputMetrics ||= {bytes:0,events:0};c.outputMetrics.bytes+=event.data?.length||event.data?.byteLength||0;c.outputMetrics.events++;
    // The controller owns slicing, the single outstanding xterm.write and the
    // ACK. Nothing here may build a full transcript or call terminal.write
    // directly: that is what made a 50,000-line burst unresponsive.
    c.stream.enqueue({bytes:decodeOutputBytes(event.data),sequence:event.sequence});
  }
  else if(event.type==='output-pressure'){c.stream.setPressure({burst:event.burst});}
  else if(event.type==='receive-pressure'){c.receivePaused=event.paused===true;updateStatus();}
  else if(event.type==='overflow'){c.outputOverflow=event;toast(event.message||'출력 처리 한도를 초과했습니다.',true);}
  else if(event.type==='status'){
    c.authCancelled=event.status==='error'&&(['AUTH_CANCELLED','HOST_KEY_REJECTED'].includes(event.code)||(event.code==='HOST_KEY_CHANGED'&&c.authCancelRequested===true));
    if(event.status!=='connecting')c.authCancelRequested=false;
    if(event.status!=='connected')c.authenticationPrompt.reset();
    else {c.disconnectReason='';c.outputOverflow=null;}
    if(event.outputIncomplete||event.logIncomplete)c.terminal.writeln(`\r\n\x1b[33m${event.outputIncomplete?(event.pendingReceiveBytes>0?'수신 데이터 처리가 완료되지 않아 일부 내용을 화면에 표시하지 못했습니다.':'화면 출력 처리가 응답하지 않아 남은 화면 출력 대기를 종료했습니다.'):''}${event.logIncomplete?' 수신 데이터 일부가 로그에 기록되지 않았습니다.':''}\x1b[0m`);
    c.status=event.status; if(event.status==='connected'){if(typeof event.username==='string')c.username=event.username;c.everConnected=true;c.retryCycle=false;c.retryAttempts=0;c.reconnecting=false;c.manualDisconnect=false;resizeTerminal(c,c.terminal.cols,c.terminal.rows);if(c.resumeLogging&&!c.logging)api.setLogging(c.id,true).catch(showError);c.resumeLogging=false;if(c.id===state.active)c.terminal.focus();scheduleFit();}
    else if(event.status==='error'){
      c.disconnectReason=c.authCancelled?'사용자가 인증 또는 서버 키 확인을 취소했습니다.':disconnectLabel(event)||disconnectLabel(c.outputOverflow)||'연결에 실패했습니다.';
      // A refused port on an automatic attempt is not a credential problem: try
      // the same device over Telnet instead of showing the usual failure toast.
      if(canFallbackToTelnet(c)&&isPortRefusedError(event))switchConnectionToTelnet(c,'refused').catch(showError);
      else { c.terminal.writeln(`\r\n\x1b[31m${c.authCancelled?'연결 취소':'연결 실패'}: ${c.authCancelled?c.disconnectReason:disconnectLabel(event)||event.message||c.disconnectReason}\x1b[0m`);if(!mayRetry(c,event))toast(c.authCancelled?'연결을 취소했습니다.':event.message||'연결에 실패했습니다.',!c.authCancelled); }}
    else if(event.status==='disconnected'){c.disconnectReason=disconnectLabel(event)||disconnectLabel(c.outputOverflow)||'연결이 종료되었습니다.';c.terminal.writeln(`\r\n\x1b[90m${c.disconnectReason}\x1b[0m`);}
    if(['disconnected','error'].includes(event.status)){c.reconnecting=false;c.logging=false;if(!c.overlay){const overlay=el('div','connection-overlay');overlay.title='터미널에서 Enter를 누르면 재접속합니다.';overlay.append(el('span'),button('재접속','refresh','text-button',()=>reconnectTerminal(c)));c.pane.append(overlay);c.overlay=overlay;}
      c.receivePaused=false;
      c.overlay.firstChild.textContent = (event.status === 'error' ? (c.authCancelled?'연결 취소':'연결 실패') : c.disconnectReason||'연결 종료') + ' · Enter로 재접속';
      if (mayRetry(c, event) && !c.reconnectTimer) {
        c.retryCycle = true; c.retryAttempts ||= 0;
        c.overlay.firstChild.textContent=`${c.profile.reconnectDelay}초 후 재접속 (${c.retryAttempts + 1}/${c.profile.reconnectAttempts || 1})`;
        const cancel = button('자동 재접속 중지', 'stop', 'text-button retry-cancel', () => disconnectTerminal(c)); c.overlay.querySelector('.retry-cancel')?.remove(); c.overlay.append(cancel);
        c.reconnectTimer=setTimeout(()=>{c.reconnectTimer=null;if(state.connections.get(c.id)===c&&!c.manualDisconnect)reconnectTerminal(c,{automatic:true}).catch(showError);},c.profile.reconnectDelay*1000);
      } else { c.retryCycle = false; c.overlay.querySelector('.retry-cancel')?.remove(); }
      // The timeout case keeps the SSH tab and offers a one-click Telnet retry.
      syncTelnetFallbackButton(c,event);
    }
    if(['disconnected','error'].includes(event.status)&&state.files&&state.active===c.id){fileActions(false);$('remote-files').replaceChildren(el('div','busy-indicator','연결이 종료되었습니다. 재접속해 주세요.'));}
    if(event.status==='connected'&&state.files&&state.active===c.id)loadFiles().catch(showError);
    renderTabs();renderSessions();updateStatus();
  }else if(event.type==='log'){c.logging=event.enabled;c.logPath=event.path;if(event.incomplete){c.logIncomplete=true;c.logDroppedBytes=Math.max(c.logDroppedBytes||0,event.droppedLogBytes||0);c.logUnconfirmedBytes=Math.max(c.logUnconfirmedBytes||0,event.unconfirmedLogBytes||0);}if(event.source==='manual'&&!event.interrupted)c.manualLogWanted=event.enabled;updateStatus();}
  else if(event.type==='log-error'){c.logIncomplete=true;c.logError=event.message;updateStatus();toast(`로그 저장 오류: ${event.message}`,true);}
  else if(event.type==='transfer'){const percent=event.total?Math.min(100,Math.round((event.transferred||event.bytes||0)/event.total*100)):null;c.transfers??=new Map();if(['started','progress'].includes(event.status))c.transfers.set(event.transferId,event);else c.transfers.delete(event.transferId);c.transferStatus=event.status==='cancelled'?'전송을 취소했습니다.':event.message||`${event.direction==='upload'?'업로드':'다운로드'} ${event.status==='completed'?'완료':percent===null?'진행 중':`${percent}%`}`;if(state.active===id){$('transfer-status').textContent=c.transferStatus;renderTransfers();}}
  else if(event.type==='sftp-closed') { c.filesGeneration=(c.filesGeneration||0)+1;c.filesLoading=false;c.filesReady=false;if(state.active===id&&state.files){fileActions(false);$('remote-refresh').disabled=false;$('remote-files').replaceChildren(el('div','busy-indicator','SFTP 채널이 닫혔습니다. 새로고침하면 다시 엽니다.'));} }
}
function fileActions(enabled){for(const id of ['remote-upload','remote-parent','remote-refresh','remote-mkdir'])if($(id))$(id).disabled=!enabled;const form=$('remote-path-form');form.querySelector('input').disabled=!enabled;form.querySelector('button').disabled=!enabled;updateFileSelection();renderTransfers();}
async function loadFiles(remotePath) {
  const id=state.active,c=state.connections.get(id);if(!c||c.status!=='connected'||c.protocol==='telnet'){ fileActions(false);$('remote-files').replaceChildren(el('div','busy-indicator','SFTP는 SSH 세션에서 사용할 수 있습니다.'));return; }
  const generation=(c.filesGeneration||0)+1;c.filesGeneration=generation;c.filesLoading=true;c.filesReady=false;fileActions(false);remotePath=remotePath??c.remotePath??'.';
  $('remote-path').value = remotePath; $('transfer-status').textContent = c.transferStatus || '파일을 두 번 클릭하면 다운로드합니다.';
  $('remote-files').replaceChildren(el('div','busy-indicator','파일 목록을 읽고 있습니다…'));
  let result;try{result=await api.listDirectory(id,remotePath);}catch(error){if(state.active!==id||c.filesGeneration!==generation)return;c.filesLoading=false;$('remote-files').replaceChildren(el('div','busy-indicator','파일 목록을 읽을 수 없습니다. 연결과 경로를 확인해 주세요.'));$('remote-refresh').disabled=false;$('remote-path-form').querySelector('input').disabled=false;$('remote-path-form').querySelector('button').disabled=false;throw error;}
  if(state.active!==id||c.filesGeneration!==generation)return;c.remotePath=result.path;c.filesLoading=false;c.filesReady=true;c.remoteEntries=result.entries.filter(e=>!['.','..'].includes(e.name));c.fileSelected=null;fileActions(true);$('remote-path').value=result.path;renderRemoteFiles(c);
}
function remoteEntryPath(c,entry){return `${c.remotePath.replace(/\/$/,'')}/${entry.name}`;}
function readyFiles(c=state.connections.get(state.active)){if(!c||state.active!==c.id||state.connections.get(c.id)!==c||c.status!=='connected'||c.protocol==='telnet'||!c.filesReady||c.filesLoading)throw new Error('현재 세션의 파일 목록을 먼저 읽어 주세요.');return c;}
function captureFileView(c=state.connections.get(state.active)){return {c,id:c.id,directory:c.remotePath,generation:c.filesGeneration};}
function currentFileView(view){const c=view.c;return !!(state.files&&state.active===view.id&&state.connections.get(view.id)===c&&c.id===view.id&&c.status==='connected'&&c.filesReady&&!c.filesLoading&&c.remotePath===view.directory&&c.filesGeneration===view.generation);}
function updateFileSelection(){const c=state.connections.get(state.active),ready=c?.status==='connected'&&c.filesReady&&!c.filesLoading;for(const id of ['remote-rename','remote-remove','remote-properties'])if($(id))$(id).disabled=!ready||!c.fileSelected;}
function renderRemoteFiles(c){
  const files=$('remote-files');files.replaceChildren();const query=$('remote-filter')?.value.toLocaleLowerCase()||'';
  const entries=[...(c.remoteEntries||[])].filter(e=>(state.showHiddenFiles||!e.name.startsWith('.'))&&e.name.toLocaleLowerCase().includes(query)).sort((a,b)=>Number(b.type==='directory')-Number(a.type==='directory')||a.name.localeCompare(b.name));
  if(c.fileSelected&&!entries.some(entry=>entry.name===c.fileSelected.name))c.fileSelected=null;
  for(const entry of entries){const row=el('button',`remote-file ${entry.type}`);row.type='button';row.dataset.name=entry.name;row.setAttribute('aria-selected',String(c.fileSelected?.name===entry.name));row.classList.toggle('selected',c.fileSelected?.name===entry.name);row.innerHTML=icon(entry.type==='directory'?'folder':'file');row.append(el('span','remote-file-name',entry.name),el('span','remote-file-size',entry.type==='directory'?'':formatBytes(entry.size)));row.title=entry.name;
    const select=()=>{c.fileSelected=entry;files.querySelectorAll('.remote-file').forEach(node=>{const selected=node.dataset.name===entry.name;node.classList.toggle('selected',selected);node.setAttribute('aria-selected',String(selected));});updateFileSelection();};
    row.addEventListener('click',select);row.addEventListener('dblclick',()=>openRemoteEntry(c,entry).catch(showError));
    row.addEventListener('contextmenu',event=>{event.preventDefault();select();showContextMenu(event,[['열기 / 다운로드',()=>openRemoteEntry(c,entry)],['이름 변경…',()=>openRemoteName('rename',c,entry)],['속성…',()=>showRemoteProperties(c,entry)],null,['파일 이름 복사',()=>api.writeClipboard(entry.name),false,{icon:'copy'}],['경로 복사',()=>api.writeClipboard(remoteEntryPath(c,entry)),false,{icon:'copy'}],['현재 폴더 경로 복사',()=>api.writeClipboard(c.remotePath),false,{icon:'copy'}],null,['삭제…',()=>removeRemoteEntry(c,entry),false,{icon:'close',danger:true}],null,['새 폴더…',()=>openRemoteName('mkdir',c)],['새로고침',()=>loadFiles(c.remotePath)]]);});files.append(row);
  }
  if(!entries.length)files.append(el('div','busy-indicator',c.remoteEntries?.length?'조건에 맞는 파일이 없습니다.':'비어 있는 폴더입니다.'));
  updateFileSelection();
}
async function openRemoteEntry(c,entry){readyFiles(c);const id=c.id,remote=remoteEntryPath(c,entry);if(entry.type==='directory'){await loadFiles(remote);return;}const result=await api.download(id,remote);if(result)toast('다운로드가 완료되었습니다.');}
let remoteEdit;
function openRemoteName(kind,c=state.connections.get(state.active),entry=c?.fileSelected){readyFiles(c);if(kind==='rename'&&!entry)return;remoteEdit={kind,c,id:c.id,directory:c.remotePath,generation:c.filesGeneration,entry,pending:false};$('remote-name-title').textContent=kind==='mkdir'?'새 원격 폴더':'원격 이름 변경';$('remote-name-input').value=kind==='rename'?entry.name:'';$('remote-name-error').textContent='';$('remote-name-form').querySelector('button[type=submit]').disabled=false;$('remote-name-dialog').showModal();$('remote-name-input').focus();$('remote-name-input').select();}
function checkRemoteEdit(edit){readyFiles(edit.c);if(edit.c.id!==edit.id||edit.c.remotePath!==edit.directory||edit.c.filesGeneration!==edit.generation)throw new Error('확인 중 연결 또는 폴더가 변경되었습니다. 다시 선택해 주세요.');}
async function removeRemoteEntry(c=state.connections.get(state.active),entry=c?.fileSelected){readyFiles(c);if(!entry)return;const edit=captureFileView(c);if(!await message('원격 항목 삭제',`${remoteEntryPath(c,entry)}\n\n${entry.type==='directory'?'비어 있는 폴더만 삭제합니다.':'이 항목을 삭제합니다.'}`,{confirm:true,danger:true,action:'삭제'}))return;checkRemoteEdit(edit);await api.removeRemote(c.id,remoteEntryPath(c,entry),entry);if(currentFileView(edit)&&!$('remote-name-dialog').open)await loadFiles(edit.directory);toast('삭제했습니다.');}
async function showRemoteProperties(c=state.connections.get(state.active),entry=c?.fileSelected){readyFiles(c);if(!entry)return;const view=captureFileView(c),remote=remoteEntryPath(c,entry);let info;try{info=await api.remoteProperties(view.id,remote);}catch(error){if(currentFileView(view)&&!document.querySelector('dialog[open]'))throw error;return;}if(!currentFileView(view)||document.querySelector('dialog[open]'))return;await message('원격 항목 속성',`${remote}\n유형: ${info.type}\n크기: ${formatBytes(info.size)}\n권한: ${typeof info.mode==='number'?(info.mode&0o7777).toString(8):'—'}\n수정: ${info.mtime?new Date(info.mtime*1000).toLocaleString():'—'}`);}
function renderTransfers(){const holder=$('transfer-jobs');if(!holder)return;holder.replaceChildren();const c=state.connections.get(state.active);for(const job of c?.transfers?.values()||[]){if(!['started','progress'].includes(job.status))continue;const row=el('div','transfer-job');row.append(el('span','',`${job.direction==='upload'?'↑':'↓'} ${job.remotePath.split('/').at(-1)} · ${job.total?Math.min(100,Math.round(job.transferred/job.total*100))+'%':'진행 중'}`));row.append(button('전송 취소','close','icon-button',()=>api.cancelTransfer(c.id,job.transferId)));holder.append(row);}}
function initializeFileTools(){
  const tools=el('div','file-management-tools');for(const [id,label,iconName,action] of [['remote-mkdir','새 폴더','folder',()=>openRemoteName('mkdir')],['remote-rename','이름 변경','edit',()=>openRemoteName('rename')],['remote-remove','삭제','close',()=>removeRemoteEntry()],['remote-properties','속성','file',()=>showRemoteProperties()]]){const node=button(label,iconName,'icon-button',action);node.id=id;node.disabled=true;tools.append(node);}
  const hidden=button('숨김 파일 표시',null,'text-button',()=>{state.showHiddenFiles=!state.showHiddenFiles;hidden.setAttribute('aria-pressed',String(state.showHiddenFiles));const c=state.connections.get(state.active);if(c?.filesReady)renderRemoteFiles(c);});hidden.textContent='숨김';hidden.id='remote-hidden';hidden.setAttribute('aria-pressed','false');tools.append(hidden);$('remote-files').before(tools);
  const filter=el('input','remote-filter');filter.id='remote-filter';filter.placeholder='파일 이름 필터';filter.setAttribute('aria-label','원격 파일 이름 필터');filter.addEventListener('input',()=>{const c=state.connections.get(state.active);if(c?.filesReady)renderRemoteFiles(c);});tools.after(filter);
  const jobs=el('div','transfer-jobs');jobs.id='transfer-jobs';$('transfer-status').before(jobs);
  $('remote-files').addEventListener('contextmenu',event=>{if(event.target.closest('.remote-file'))return;event.preventDefault();const c=state.connections.get(state.active);showContextMenu(event,[['새 폴더…',()=>openRemoteName('mkdir',c),!c?.filesReady],['새로고침',()=>loadFiles(),c?.status!=='connected'],null,['현재 폴더 경로 복사',()=>api.writeClipboard(c.remotePath),!c?.remotePath,{icon:'copy'}]]);});
  $('remote-files').addEventListener('keydown',event=>{const c=state.connections.get(state.active);if(!c?.fileSelected)return;if(event.key==='F2'){event.preventDefault();openRemoteName('rename',c);}else if(event.key==='Delete'){event.preventDefault();removeRemoteEntry(c).catch(showError);}else if(event.key==='Enter'){event.preventDefault();openRemoteEntry(c,c.fileSelected).catch(showError);}});
  $('remote-name-form').addEventListener('submit',async event=>{event.preventDefault();const edit=remoteEdit,submit=event.target.querySelector('button[type=submit]');if(!edit||edit.pending)return;edit.pending=true;submit.disabled=true;try{checkRemoteEdit(edit);const name=$('remote-name-input').value;if(edit.kind==='mkdir')await api.createDirectory(edit.id,edit.directory,name);else await api.renameRemote(edit.id,remoteEntryPath(edit.c,edit.entry),name,edit.entry);if(remoteEdit===edit&&$('remote-name-dialog').open&&currentFileView(edit)){$('remote-name-dialog').close();await loadFiles(edit.directory);}}catch(error){if(remoteEdit===edit&&$('remote-name-dialog').open&&currentFileView(edit))$('remote-name-error').textContent=error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');}finally{edit.pending=false;if(remoteEdit===edit)submit.disabled=false;}});
}
function formatBytes(bytes=0){if(bytes<1024)return `${bytes} B`;if(bytes<1048576)return `${(bytes/1024).toFixed(1)} KB`;return `${(bytes/1048576).toFixed(1)} MB`;}
async function toggleFiles(){state.files=!state.files;layoutTerminals();if(state.files)await loadFiles();}
function openTerminalSearch(focus = true) {
  if(state.emptyWorkspace || !state.connections.has(state.active))return;
  $('terminal-search-box').classList.remove('hidden'); if(focus || !$('terminal-search-input').value)$('terminal-search-input').focus();
}
function updateSearchResult(c) {
  const result = c.searchResult;
  $('search-result').textContent = result?.resultCount ? `${result.resultIndex >= 0 ? result.resultIndex + 1 : '—'} / ${result.resultCount}${result.resultCount >= 1000 ? '+' : ''}` : '결과 없음';
}
function findTerminal(previous = false, incremental = false) {
  const c = state.emptyWorkspace ? null : state.connections.get(state.active); if(!c)return;
  const input = $('terminal-search-input'), text = input.value;
  if(!text){ c.search.clearDecorations();c.searchResult=null;$('search-result').textContent='';input.style.borderColor='';return; }
  const options = { regex: $('search-regex').getAttribute('aria-pressed') === 'true', caseSensitive: $('search-case').getAttribute('aria-pressed') === 'true', wholeWord: $('search-word').getAttribute('aria-pressed') === 'true', incremental, decorations: { matchBackground: '#72592a', matchOverviewRuler: '#aa8844', activeMatchBackground: '#3c6b91', activeMatchColorOverviewRuler: '#64a8db' } };
  if(options.regex)try{new RegExp(text);}catch{c.search.clearDecorations();$('search-result').textContent='잘못된 정규식';input.style.borderColor='var(--danger)';return;}
  let term=text;
  // SearchAddon's wholeWord path can stop at a non-word match on the same line.
  // Use zero-width boundaries so next/previous keep examining all candidates.
  if(options.wholeWord){
    const body=options.regex?text:text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const word='[\\w\\u00C0-\\u02FF\\u0370-\\u052F\\u1100-\\u11FF\\u3040-\\u30FF\\u3130-\\u318F\\u3400-\\u9FFF\\uAC00-\\uD7AF]';
    term=`(?<!${word})(?:${body})(?!${word})`;options.regex=true;options.wholeWord=false;
  }
  const found = previous ? c.search.findPrevious(term,options) : c.search.findNext(term,options); input.style.borderColor = found ? '' : 'var(--danger)'; updateSearchResult(c);
}
function commandTargets(scope){return [...state.connections.values()].filter(c=>c.status==='connected'&&(scope==='all'||scope==='selected'&&c.commandSelected||scope==='active'&&c.id===state.active));}
let commandInputSensitive=false, commandInputOwner=null, commandConfirmationTargets=null;
function clearCommandInput(){ $('command-input').value='';commandInputSensitive=false;commandDraft='';commandHistoryIndex=-1;hideCommandSuggestions(); }
function syncCommandPrivacy(){
  const input=$('command-input'),control=$('command-sensitive');if(!input||!control)return false;
  const c=state.emptyWorkspace?null:state.connections.get(state.active);
  // Never carry a private draft to another tab, a replacement connection or a
  // disconnected session. Keep a draft masked if a prompt changes mid-entry.
  if(commandInputSensitive&&(commandInputOwner?.record!==c||commandInputOwner?.id!==c?.id||c?.status!=='connected'))clearCommandInput();
  commandInputOwner={record:c,id:c?.id};
  if(isSensitiveConnection(c)&&input.value)commandInputSensitive=true;
  const sensitive=isSensitiveConnection(c)||commandInputSensitive;
  input.type=sensitive?'password':'text';input.setAttribute('aria-autocomplete',sensitive?'none':'list');
  input.placeholder=sensitive?'민감 입력 · 이력 제외 · 현재 세션만':'명령 입력';
  control.checked=!!c?.commandPrivate;control.disabled=c?.status!=='connected'||!!state.commandSending;
  $('command-target').disabled=sensitive||!!state.commandSending;
  if(sensitive){$('command-target').value='active';commandDraft='';commandHistoryIndex=-1;hideCommandSuggestions();}
  updateCommandTargetLabel();
  // A prompt can arrive while a normal broadcast confirmation is open. Remove
  // its preview and cancel it before any input is dispatched.
  if(commandConfirmationTargets?.some(({record})=>isSensitiveConnection(record))){
    $('message-body').replaceChildren();resolveMessage(false);
  }
  return sensitive;
}
// The pill appears only when input goes somewhere other than the focused tab
// (amber, with the live target count) or is protected (sensitive input).
function updateCommandTargetLabel(){
  const scope=$('command-target').value,c=state.emptyWorkspace?null:state.connections.get(state.active),label=$('command-target-label');
  const sensitive=isSensitiveConnection(c)||commandInputSensitive,broadcast=!sensitive&&scope!=='active',count=broadcast?commandTargets(scope).length:0;
  label.textContent=sensitive?`${c?.authenticationPrompt?.sensitive?'인증 입력 감지':'민감 입력'} · 이력 제외 · 현재 세션만`:scope==='all'?`모든 연결 ${count}개 · 전송 전 확인`:scope==='selected'?(count?`선택한 탭 ${count}개 · 전송 전 확인`:'연결된 선택 탭 없음 · 탭을 Ctrl+클릭'):'현재 세션으로 전송';
  label.title=sensitive?'':'여러 세션 전송은 실행 전에 대상 목록과 명령을 다시 확인합니다.';
  label.classList.toggle('hidden',!sensitive&&!broadcast);
  $('command-bar').classList.toggle('broadcast',broadcast);$('command-bar').classList.toggle('sensitive',sensitive);
  $('tabbar')?.setAttribute('data-broadcast',broadcast?scope:'');
}
async function sendCommand(command,forceAll=false,targetOverride=null,title='명령어 전송 확인',forceConfirm=false){
  if(state.commandSending)return;
  const sensitive=syncCommandPrivacy();command??=$('command-input').value;
  if(!sensitive&&!command.trim())return;
  if(state.emptyWorkspace)throw new Error('명령어를 보낼 탭을 선택해 주세요.');
  const scope=forceAll?'all':targetOverride||$('command-target').value, targets=commandTargets(scope);
  if(!targets.length)throw new Error('명령어를 보낼 연결된 세션이 없습니다.');
  if((sensitive||targets.some(isSensitiveConnection))&&scope!=='active')throw new Error('민감 입력이나 인증을 기다리는 세션에는 일괄 전송할 수 없습니다. 해당 탭을 선택해 현재 세션으로 전송하세요.');
  if(sensitive&&/[\r\n]/.test(command))throw new Error('민감 입력은 줄바꿈 없이 한 번에 한 줄씩 전송하세요.');
  // Capture IDs before confirmation; a reconnect must not redirect an approved command.
  const tabIds = new Map([...state.connections.keys()].map((id, index) => [id, index + 1]));
  const approved = targets.map(c => ({ record:c, id:c.id, label:`${tabIds.get(c.id)}번 탭 · ${c.name} (${c.host}:${c.port})` }));
  state.commandSending=true;updateStatus();
  try {
    if(sensitive)clearCommandInput();
    if(forceConfirm||targets.length>1||scope!=='active'||/[\r\n]/.test(command)){
      if(!sensitive)commandConfirmationTargets=approved;
      const accepted=await message(title,`대상: ${approved.map(target=>target.label).join('\n')}\n\n${sensitive?'민감 입력을 전송합니다. 내용은 표시하거나 이력에 남기지 않습니다.':'아래 명령어를 전송합니다.'}`,{confirm:true,...(sensitive?{}:{command})});
      commandConfirmationTargets=null;if(!accepted)return;
    }
    if(approved.some(({record,id})=>state.connections.get(id)!==record||record.status!=='connected'))throw new Error('확인 중 연결 대상이 변경되었습니다. 다시 확인해서 전송해 주세요.');
    if(!sensitive&&approved.some(({record})=>isSensitiveConnection(record)))throw new Error('확인 중 인증 입력이 감지되어 전송을 취소했습니다. 현재 세션에서 민감 입력으로 전송하세요.');
    const payload=(sensitive?command:command.replace(/\r\n|\n/g,'\r').replace(/\r+$/,''))+'\r';
    // Keep a detected prompt protected through failure or a server that has
    // not replied yet. Fresh output releases it when a normal prompt returns.
    if(!sensitive)for(const {record} of approved)record.authenticationPrompt.reset();
    // Consume the draft before writes begin. Even an IPC error could arrive
    // after input was queued, so never leave a submitted broadcast ready to resend.
    if(!sensitive)clearCommandInput();
    const results=await dispatchTerminalCommand(approved,payload,(id,data)=>api.input(id,data));
    const unknown=results.some(result=>result.status==='unknown');
    if(!sensitive)for(const {target:{record,id},status} of results){
      if(status!=='accepted'||state.connections.get(id)!==record||record.id!==id)continue;
      record.commandHistory??=[];record.commandHistory=record.commandHistory.filter(item=>item!==command);record.commandHistory.unshift(command);record.commandHistory.length=Math.min(record.commandHistory.length,100);
    }
    if(unknown){
      $('command-target').value='active';
      updateCommandTargetLabel();
      if(sensitive)throw new Error('민감 입력의 전달 여부를 확인하지 못했습니다. 장비 화면을 확인한 뒤 다시 입력하세요.');
      await message('명령어 전송 결과',`${formatDispatchResults(results)}\n\n접수는 장비에서의 실행 성공을 의미하지 않습니다. 다시 보내기 전에 장비 화면을 확인하고 대상을 다시 선택하세요.`);
    }else if(!sensitive&&scope!=='active'){
      toast(`${results.length}개 탭 입력 전달 요청 접수 · 실행 여부는 장비 화면에서 확인하세요.`);
    }
    if(!state.emptyWorkspace)state.connections.get(state.active)?.terminal.focus();
  } finally { commandConfirmationTargets=null;state.commandSending=false;updateStatus(); }
}
let commandSuggestions=[],commandSuggestionIndex=-1,commandHistoryIndex=-1,commandDraft='';
// IME composition state for the command bar. Enter that confirms a hangul
// syllable must never be treated as "run this command", and the same key must
// not be double-handled when the browser fires compositionend first.
let commandComposing=false,commandCompositionEndedAt=0;
function commandCompositionGuard(event){
  if(event.isComposing||event.keyCode===229||event.which===229||commandComposing)return true;
  // Chromium on Windows commits the syllable, fires keydown(229), then
  // compositionend; a second keydown for the same physical Enter follows.
  return event.key==='Enter'&&performance.now()-commandCompositionEndedAt<50;
}
function hideCommandSuggestions(){const box=$('command-suggestions');if(box){box.classList.add('hidden');box.replaceChildren();}commandSuggestions=[];$('command-input').setAttribute('aria-expanded','false');$('command-input').removeAttribute('aria-activedescendant');commandSuggestionIndex=-1;}
function updateCommandSuggestions(force=false){
  const box=$('command-suggestions'),input=$('command-input'),c=state.emptyWorkspace?null:state.connections.get(state.active);hideCommandSuggestions();box.replaceChildren();
  if(!c||c.status!=='connected'||syncCommandPrivacy())return;const prefix=input.value; if(!prefix&&!force)return;
  const candidates=[...(c.commandHistory||[]).map(command=>({command,label:'이전 명령'})),...state.snippets.map(s=>({command:s.command,label:s.name}))],seen=new Set();
  commandSuggestions=candidates.filter(item=>!/[\r\n]/.test(item.command)&&item.command.startsWith(prefix)&&item.command!==prefix&&!seen.has(item.command)&&seen.add(item.command)).slice(0,7);
  for(const [index,item] of commandSuggestions.entries()){const row=button(item.command,null,'command-suggestion',()=>acceptCommandSuggestion(index));row.id=`command-suggestion-${index}`;row.setAttribute('role','option');row.append(el('span','suggestion-source',item.label));row.addEventListener('mousedown',event=>event.preventDefault());box.append(row);}
  if(commandSuggestions.length){box.classList.remove('hidden');input.setAttribute('aria-expanded','true');}
}
function selectCommandSuggestion(index){commandSuggestionIndex=index;const box=$('command-suggestions');[...box.children].forEach((node,i)=>{node.classList.toggle('selected',i===index);node.setAttribute('aria-selected',String(i===index));});if(index>=0)$('command-input').setAttribute('aria-activedescendant',`command-suggestion-${index}`);else $('command-input').removeAttribute('aria-activedescendant');}
function acceptCommandSuggestion(index=commandSuggestionIndex){if(syncCommandPrivacy())return;const item=commandSuggestions[index];if(!item)return;$('command-input').value=item.command;commandHistoryIndex=-1;hideCommandSuggestions();$('command-input').focus();}
function initializeCommandHistory(){const input=$('command-input'),box=el('div','command-suggestions hidden');box.id='command-suggestions';box.setAttribute('role','listbox');box.setAttribute('aria-label','명령 추천');$('command-bar').append(box);input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',box.id);input.setAttribute('aria-expanded','false');input.autocomplete='off';input.placeholder='명령 입력';input.title='명령 입력 · ↑↓ 이력 · Ctrl+Space 추천';
  input.spellcheck=false;input.setAttribute('autocapitalize','off');input.setAttribute('autocorrect','off');
  $('command-sensitive').addEventListener('change',()=>{const c=state.connections.get(state.active);if(!c)return;c.commandPrivate=$('command-sensitive').checked;if(!c.commandPrivate)clearCommandInput();syncCommandPrivacy();input.focus();});
  input.addEventListener('input',()=>{commandHistoryIndex=-1;if(!input.value)commandInputSensitive=false;syncCommandPrivacy();updateCommandSuggestions();});
  input.addEventListener('compositionstart',()=>{commandComposing=true;});
  input.addEventListener('compositionend',()=>{commandComposing=false;commandCompositionEndedAt=performance.now();});
  input.addEventListener('blur',()=>setTimeout(()=>{
    // A queued blur can run after typing has already returned to this input.
    const focused=document.activeElement;
    if(focused!==input&&!box.contains(focused))hideCommandSuggestions();
  },0));
  input.addEventListener('keydown',event=>{if(commandCompositionGuard(event))return;if(syncCommandPrivacy()){if(['ArrowUp','ArrowDown','Escape'].includes(event.key)||event.ctrlKey&&event.code==='Space'){event.preventDefault();if(event.key==='Escape'){clearCommandInput();syncCommandPrivacy();}}return;}if(event.ctrlKey&&event.code==='Space'){event.preventDefault();updateCommandSuggestions(true);return;}if(event.key==='Escape'){event.preventDefault();hideCommandSuggestions();return;}
    if(!box.classList.contains('hidden')&&['ArrowUp','ArrowDown','Tab','Enter'].includes(event.key)){if(event.key==='Tab'||event.key==='Enter'){if(commandSuggestionIndex<0&&event.key==='Enter')return;event.preventDefault();acceptCommandSuggestion(commandSuggestionIndex<0?0:commandSuggestionIndex);return;}event.preventDefault();const count=commandSuggestions.length;selectCommandSuggestion(commandSuggestionIndex<0?(event.key==='ArrowDown'?0:count-1):(commandSuggestionIndex+(event.key==='ArrowDown'?1:-1)+count)%count);return;}
    if(['ArrowUp','ArrowDown'].includes(event.key)){const c=state.connections.get(state.active),history=c?.commandHistory||[];if(!history.length)return;event.preventDefault();if(commandHistoryIndex<0)commandDraft=input.value;commandHistoryIndex=Math.max(-1,Math.min(history.length-1,commandHistoryIndex+(event.key==='ArrowUp'?1:-1)));input.value=commandHistoryIndex<0?commandDraft:history[commandHistoryIndex];hideCommandSuggestions();}
  });
}
function renderSnippets() {
  const list = $('snippet-list'); list.replaceChildren();
  if (!state.snippets.length) list.append(el('span', 'button-bar-empty', '＋로 자주 쓰는 명령어를 추가하세요.'));
  const query=$('snippet-search').value.trim().toLocaleLowerCase(), folder=$('snippet-folder-filter').value;
  const folders=[...new Set(state.snippets.map(s=>s.folder||'').filter(Boolean))].sort();const selector=$('snippet-folder-filter');selector.replaceChildren(new Option('모든 폴더',''),...folders.map(folder=>new Option(folder,folder)));selector.value=folders.includes(folder)?folder:'';
  for (const snippet of state.snippets.filter(s=>(!folder||s.folder===folder||s.folder?.startsWith(folder+'/'))&&(!query||`${s.name} ${s.command} ${s.folder||''}`.toLocaleLowerCase().includes(query)))) {
    const card = button(snippet.name, null, 'snippet-card', () => sendSnippet(snippet)); card.title = `${snippet.folder?snippet.folder+' / ':''}${snippet.name}\n${snippet.command}`; card.dataset.snippetId = snippet.id;
    card.setAttribute('aria-label', `현재 세션에 전송: ${snippet.name}`); card.setAttribute('aria-disabled', String(state.emptyWorkspace || state.connections.get(state.active)?.status !== 'connected'));
    list.append(card);
  }
}
async function sendSnippet(snippet) { await sendCommand(snippet.command,false,snippet.target||'active','명령어 실행',true); }
function showSnippetMenu(event, snippet) {
  showContextMenu(event, [['현재 세션에 전송', () => sendSnippet(snippet), state.emptyWorkspace || state.connections.get(state.active)?.status !== 'connected'], ['수정…', () => openSnippet(snippet)], ['명령어 복사', async () => { await api.writeClipboard(snippet.command); toast('명령어가 복사되었습니다.'); }], null, ['삭제…', async () => { if (await message('명령어 삭제', `${snippet.name} 명령을 삭제하시겠습니까?`, { confirm: true, danger: true, action: '삭제' })) { await api.deleteSnippet(snippet.id); await refreshData(); } }]]);
}
function openSnippet(snippet=null){state.snippetsVisible=true;switchView('sessions');state.snippetId=snippet?.id||null;$('snippet-form').reset();formValue($('snippet-form'),'name',snippet?.name||'');formValue($('snippet-form'),'command',snippet?.command||'');formValue($('snippet-form'),'folder',snippet?.folder||'');formValue($('snippet-form'),'target',snippet?.target||'active');$('snippet-dialog').showModal();}
let sessionDataBusy = false;
function setSessionDataBusy(busy) { sessionDataBusy = busy; document.querySelectorAll('.session-data-actions button').forEach(button => button.disabled = busy); }
async function importSessions(kind) {
  if (sessionDataBusy) return; setSessionDataBusy(true);
  try {
    const result = await api.importSessions(kind); if (!result) return; await refreshData();
    const count = result.added ?? result.sessions?.length ?? 0, skipped = result.skipped || [], warnings = result.warnings || [];
    setFeedback($('session-data-result'),`${count}개 세션을 가져왔습니다${skipped.length ? ` · ${skipped.length}개 건너뜀` : ''}`,'success');
    await message('세션 가져오기 결과', `${count}개의 세션을 가져왔습니다.${skipped.length ? `\n${skipped.length}개 항목을 건너뛰었습니다.\n${skipped.slice(0,12).map((item, index) => `${item.name?.trim() || `항목 ${index + 1}`}: ${item.reason || item.protocol || '가져올 수 없습니다.'}`).join('\n')}` : ''}${warnings.length ? `\n\n${warnings.join('\n')}` : ''}`);
  } finally { setSessionDataBusy(false); }
}
async function exportSessions() {
  if (sessionDataBusy) return; setSessionDataBusy(true);
  try { if (await api.exportSessions()) { setFeedback($('session-data-result'),'세션 설정을 내보냈습니다.','success'); toast('세션 설정을 내보냈습니다.'); } }
  finally { setSessionDataBusy(false); }
}
function csvFeedback(text,state='info'){setFeedback($('csv-result'),text,state);}
function csvError(error){const result=errorFeedback(error);console.error(result.diagnostic);csvFeedback(result.message,'error');}
let csvPlan = null;
function clearCsvPreview(){csvPlan=null;$('csv-preview').classList.add('hidden');$('csv-preview-rows').replaceChildren();}
listen('save-sample-csv',async()=>{
  if(sessionDataBusy)return;setSessionDataBusy(true);
  try{if(await api.saveSampleCsv())csvFeedback('예시 CSV를 저장했습니다.','success');else csvFeedback('저장을 취소했습니다.');}
  catch(e){csvError(e);}
  finally{setSessionDataBusy(false);}
});
listen('import-csv',async()=>{
  if(sessionDataBusy)return;setSessionDataBusy(true);clearCsvPreview();
  try{
    const value=$('csv-folder-count').value;
    const plan=await api.previewCsv({folderCount:value==='auto'?'auto':Number(value),header:$('csv-header').checked,hasId:$('csv-has-id').checked});
    if(!plan){csvFeedback('가져오기를 취소했습니다.');return;}csvPlan=plan;
    $('csv-preview-summary').textContent=`${plan.mapping} · ${plan.sessions.length}개 추가 예정(최대 100개 표시, 기존 세션 유지·새로 추가)`;
    for(const s of plan.sessions.slice(0,100)){const tr=document.createElement('tr');for(const key of ['folder','name','host','protocol','port']){const td=document.createElement('td');td.textContent=String(s[key]);tr.append(td);}$('csv-preview-rows').append(tr);}
    $('csv-preview').classList.remove('hidden');csvFeedback('미리보기를 확인한 뒤 추가하세요.');
  }catch(e){csvError(e);}
  finally{setSessionDataBusy(false);}
});
listen('csv-cancel',async()=>{if(!csvPlan||sessionDataBusy)return;setSessionDataBusy(true);const token=csvPlan.token;clearCsvPreview();try{await api.applyCsv({token,confirm:false});csvFeedback('가져오기를 취소했습니다.');}catch(e){csvError(e);}finally{setSessionDataBusy(false);}});
listen('csv-apply',async()=>{
  if(!csvPlan||sessionDataBusy)return;setSessionDataBusy(true);const token=csvPlan.token;
  try{const result=await api.applyCsv({token,confirm:true});clearCsvPreview();await refreshData();csvFeedback(`${result.added}개 세션을 가져왔습니다.`,'success');}
  catch(e){clearCsvPreview();csvError(e);}
  finally{setSessionDataBusy(false);}
});
let sharedBusy = false;
function openSharedSettings(){openSettings();showSettingsPage('shared');}
async function sharedOperation(action){
  if(sharedBusy)return;sharedBusy=true;document.querySelectorAll('.shared-operation').forEach(node=>node.disabled=true);
  $('shared-result').textContent='처리 중…';
  try { return await action(); }
  catch(error){$('shared-result').textContent=error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');throw error;}
  finally{sharedBusy=false;document.querySelectorAll('.shared-operation').forEach(node=>node.disabled=false);}
}
function renderSharedSources(){
  const list=$('shared-source-list');if(!list)return;list.replaceChildren();
  for(const source of state.sharedSources){
    const row=el('div',`shared-source-row${source.error?' has-error':''}`);row.dataset.sourceId=source.id;
    const details=el('div','shared-source-details');details.append(el('strong','',source.name),el('code','',source.path),el('small','',source.error?`읽기 실패 · ${source.error}`:`${source.count||0}개 세션 · 읽기 전용`));
    const refresh=button('새로고침','refresh','icon-button shared-operation',()=>refreshSharedSource(source.id));
    const remove=button('등록 해제','close','icon-button shared-operation',async()=>{if(await message('공유 목록 등록 해제',`${source.name} 등록을 해제합니다. 원본 파일과 현재 연결은 유지됩니다.`,{confirm:true,action:'등록 해제'}))await sharedOperation(async()=>{await api.removeSharedSource(source.id);await refreshData();$('shared-result').textContent='공유 목록 등록을 해제했습니다.';});});
    const credential=button('이 PC의 공통 계정','lock','icon-button shared-operation',()=>advanced.openSharedCredential(source));
    refresh.disabled=remove.disabled=credential.disabled=sharedBusy;row.append(details,credential,refresh,remove);list.append(row);
  }
  if(!state.sharedSources.length)list.append(el('p','field-hint','등록한 공유 목록이 없습니다.'));
}
async function refreshSharedSource(id){return sharedOperation(async()=>{await api.refreshSharedSource(id);await refreshData();$('shared-result').textContent='공유 목록을 새로 읽었습니다.';});}
function sharedSourceActions(id){return [['공유 목록 새로고침',()=>refreshSharedSource(id),sharedBusy,{icon:'refresh'}],['공유 세션 관리…',openSharedSettings,false,{icon:'settings'}]];}
function showSharedProfile(s){return message('공유 세션 정보',`${s.name}\n${sessionAddress(s)}\n목록: ${s.sharedSourceName||'공유 세션'}\n폴더: ${s.folder||'—'}\n\n읽기 전용입니다. 목록 변경은 관리자가 게시합니다.`);}

applyIcons();
// Static dialogs (session properties) ship their wrappers in index.html.
bindPasswordToggles($('session-form'));
function closeMenus(){document.querySelectorAll('.menu-trigger').forEach(node=>node.setAttribute('aria-expanded','false'));document.querySelectorAll('.menu-popup').forEach(node=>node.classList.add('hidden'));}
function captureWorkspace() {
  const records=[...state.connections.values()].filter(c=>!c.profile.temporary&&sessionById(c.sessionId));
  if(!records.length)throw new Error('저장된 세션을 먼저 탭으로 열어 주세요.');if(records.length>64)throw new Error('작업공간에는 최대 64개 탭을 저장할 수 있습니다.');
  const workspace={sessionIds:records.map(c=>c.sessionId),activeIndex:Math.max(0,records.findIndex(c=>c.id===state.active)),split:state.split,splitDirection:state.splitDirection,splitColumns:[...state.splitTracks.columns],splitRows:[...state.splitTracks.rows]};
  // `dockLayout` only means something for a split workspace. `layoutTerminals()`
  // clears the tree when the panes are not docked, but a capture that runs
  // between those two steps would pair `split:false` with a live tree, which the
  // layout validator used to reject as a whole — the workspace save then failed
  // with "화면 배치 설정이 올바르지 않습니다." instead of saving the tabs.
  const snapshot=state.split?dockSnapshot(state.dockLayout,records.map(c=>c.id)):null;
  if(snapshot){workspace.dockLayout=snapshot;const visible=dockIds(state.dockLayout).map(id=>records.findIndex(c=>c.id===id)).filter(i=>i>=0);if(!visible.includes(workspace.activeIndex))workspace.activeIndex=visible[0];}return workspace;
}
async function saveWorkspace(){const workspace=captureWorkspace();clearTimeout(layoutTimer);await layoutPersistence.save({workspace,splitDirection:state.splitDirection,splitColumns:[...state.splitTracks.columns],splitRows:[...state.splitTracks.rows]});state.savedWorkspace=workspace;lastSaved='';lastAttempt=null;persistLayout();toast('탭 순서와 분할 배치를 작업공간에 저장했습니다.');}
async function restoreWorkspace(){if(state.restoringWorkspace)return;const workspace=state.savedWorkspace;if(!workspace?.sessionIds?.length)throw new Error('저장한 작업공간이 없습니다.');const sessions=workspace.sessionIds.map((id,index)=>({profile:sessionById(id),index})).filter(item=>item.profile);if(!sessions.length)throw new Error('작업공간에 저장한 세션이 삭제되었습니다.');state.restoringWorkspace=true;try{const opened=[];for(const {profile:session,index} of sessions){const before=new Set(state.connections.keys());await connectSession(session.id);const record=[...state.connections.values()].at(-1);if(record?.sessionId===session.id&&!before.has(record.id))opened.push({id:record.id,index});}state.dockLayout=restoreDock(workspace.dockLayout,Object.fromEntries(opened.map(item=>[item.index,item.id])));state.split=workspace.dockLayout?dockIds(state.dockLayout).length>1:workspace.split;state.splitDirection=workspace.splitDirection;state.splitTracks={columns:[...workspace.splitColumns],rows:[...workspace.splitRows]};if(opened.length)activateTerminal((opened.find(item=>item.index===workspace.activeIndex)||opened[Math.min(workspace.activeIndex,opened.length-1)]).id);if(sessions.length!==workspace.sessionIds.length)toast('삭제된 세션을 제외하고 작업공간을 열었습니다.');}finally{state.restoringWorkspace=false;}}
function toggleSidebar(){document.body.classList.toggle('sidebar-hidden');scheduleFit();persistLayout();}
const retiredConnectionIds = new Set();
function retireConnection(id) { retiredConnectionIds.add(id); const early=state.eventBuffer.get(id); if(early){state.earlyBufferBytes=Math.max(0,(state.earlyBufferBytes||0)-early.bytes);} state.eventBuffer.delete(id); if (retiredConnectionIds.size > 2048) retiredConnectionIds.delete(retiredConnectionIds.values().next().value); }
async function disconnectTerminal(c) {
  if (!c) return; c.manualDisconnect = true; c.cancelReconnect = true; clearTimeout(c.reconnectTimer); c.reconnectTimer = null;
  c.retryCycle=false;c.overlay?.querySelector('.retry-cancel')?.remove();
  if(c.overlay)c.overlay.firstChild.textContent='연결 종료 · Enter로 재접속'; await api.disconnect(c.id); updateStatus();
}
// ---------- hybrid quick connect: SSH first, Telnet when the SSH port is closed ----------
// Only an unedited automatic first attempt may switch protocols on its own: a
// saved profile, a typed scheme, a manual choice or a connection that once worked
// stays as chosen.
function canFallbackToTelnet(c) {
  return !!c && !c.closing && c.status==='error' && !c.everConnected && !c.telnetFallback
    && !!c.profile?.temporary && !!c.profile?.autoProtocol && !c.profile?.explicitScheme
    && (c.protocol||'ssh')==='ssh';
}
// Replace the failed SSH tab with a Telnet tab on the same host. The new
// connection is attached first so the tab order and address bar stay populated.
async function switchConnectionToTelnet(c, reason = 'refused') {
  if(!canFallbackToTelnet(c)) return false;
  const address=telnetFallbackAddress(c.profile?.host,c.profile?.port);
  if(!address) return false;
  const { from, to }=telnetFallbackPorts(c.profile?.port), timeout=reason==='timeout';
  if(c.fallbackConfirming)return false;
  const id=c.id, host=c.profile.host, port=c.profile.port;
  c.fallbackConfirming=true;
  let confirmed;
  try { confirmed=await message('Telnet 연결 확인', `${host}:${to}에 Telnet으로 연결할까요?\n암호화되지 않아 로그인 정보가 노출될 수 있습니다.`, {confirm:true}); }
  finally { c.fallbackConfirming=false; }
  if(!confirmed || state.connections.get(id)!==c || c.id!==id || c.closePending || c.reconnecting || c.reconnectOperation || c.manualDisconnect || !canFallbackToTelnet(c) || c.profile.host!==host || c.profile.port!==port)return false;
  const notice=`\r\n\x1b[33mSSH(${from}) 포트 ${timeout?'응답 시간 초과':'연결 거부'} · Telnet(${to})으로 ${timeout?'전환합니다...':'자동 전환합니다...'}\x1b[0m`;
  c.telnetFallback=true;
  // A pending automatic SSH retry would race the Telnet tab.
  clearTimeout(c.reconnectTimer);c.reconnectTimer=null;c.retryCycle=false;c.overlay?.querySelector('.retry-cancel')?.remove();
  c.terminal.writeln(notice);
  toast(timeout?`SSH(${from}) 응답 없음 · Telnet(${to})으로 연결합니다.`:from===22&&to===23?'SSH 포트 닫힘 · Telnet으로 자동 전환합니다.':`SSH(${from}) 포트 닫힘 · 같은 포트에서 Telnet으로 자동 전환합니다.`);
  try {
    const result=await api.connectAddress(address,'telnet');
    // The tab may have been closed while the Telnet connection was being set up.
    // The new connection has no tab to own it, so it must be released explicitly:
    // returning here used to leave a live TCP session behind forever.
    if(state.connections.get(id)!==c||c.id!==id||c.closing||c.closePending||c.reconnecting||c.reconnectOperation||c.manualDisconnect||c.status!=='error'||c.profile.host!==host||c.profile.port!==port){retireConnection(result.id);await api.disconnect(result.id).catch(()=>{});return false;}
    attachConnection(result,result.session);
    // The failed tab is about to be closed with its scrollback, so the switch
    // notice is repeated on the tab the user keeps, next to the tab title marker.
    const next=state.connections.get(result.id);
    if(next){next.autoFallbackFrom={protocol:'ssh',port:from};next.pane.dataset.autoFallback=`ssh:${from}>telnet:${to}`;next.terminal.writeln(notice);}
    await closeTerminal(c.id,{confirm:false}).catch(showError);
    return true;
  } catch(error) {
    // Stay on the failed tab instead of looping between two dead ports.
    c.terminal.writeln(`\r\n\x1b[31mTelnet(${to}) 연결도 실패했습니다: ${String(error?.message||error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')}\x1b[0m`);
    renderTabs();renderSessions();updateStatus();
    return false;
  }
}
// A timeout is usually a firewall dropping the SYN, so the retry is offered
// instead of taken: the same device may still answer Telnet on that port.
function syncTelnetFallbackButton(c, event) {
  c.overlay?.querySelector('.telnet-fallback')?.remove();
  if(!c.overlay||!canFallbackToTelnet(c)||!isConnectionTimeout(event))return;
  const { from, to }=telnetFallbackPorts(c.profile?.port);
  const retry=button(`Telnet(${to})으로 연결`, null, 'text-button telnet-fallback', () => switchConnectionToTelnet(c, 'timeout'));
  retry.title=`SSH(${from}) 응답이 없습니다. 같은 장비를 Telnet(${to})으로 연결합니다.`;
  c.overlay.append(retry);
}
async function reconnectTerminal(c, { automatic = false } = {}) {
  if (!c || c.reconnecting || c.reconnectOperation || c.closing) return;
  c.reconnecting = true; clearTimeout(c.reconnectTimer); c.reconnectTimer = null; c.manualDisconnect = true;
  if (automatic) c.retryAttempts = (c.retryAttempts || 0) + 1;
  else { c.retryAttempts = 0; c.retryCycle = false; }
  const oldId = c.id, profile = c.profile.temporary ? c.profile : sessionById(c.sessionId);
  if (!profile) { c.reconnecting = false; throw new Error('저장된 세션을 찾을 수 없습니다.'); }
  c.reconnectOperation = true; c.cancelReconnect = false; let finishOperation; c.reconnectDone = new Promise(resolve => { finishOperation = resolve; }); updateStatus();
  try {
    c.resumeLogging = c.logging || c.manualLogWanted;
    const closed = await api.disconnectAndWaitClosed(oldId); if(c.closing||c.cancelReconnect)return;
    if (closed !== true) throw new Error('이전 연결의 종료를 확인하지 못해 재접속하지 않았습니다.');
    const result = await api.connect(c.sessionId, { cols: c.terminal.cols, rows: c.terminal.rows });
    if(c.closing||c.cancelReconnect){retireConnection(result.id);await api.disconnect(result.id);return;}
    retireConnection(oldId); c.id = result.id; c.profile = { ...profile }; c.status = 'connecting'; c.authState=null; c.authSequence=0; c.authCancelled=false; c.authCancelRequested=false; c.logging = false; c.manualDisconnect = false; c.everConnected = false; c.reconnecting = true;c.authenticationPrompt.reset();
    if(result.logLoss)applyLogLoss(c,result.logLoss);
    c.compatibility?.update({type:['vt100','vt220','ansi','linux'].includes(profile.terminalType)?profile.terminalType:'xterm',sessionKeymap:profile.keymap,globalKeymap:state.settings.keymap||[],protocol:profile.protocol||'ssh',ctrlArrowMode:profile.ctrlArrowMode});
    // The controller outlives the connection id. Retire its generation and abandon
    // the old connection's queue so a late parser callback from `oldId` cannot
    // acknowledge output belonging to `result.id`.
    try { c.stream?.reset(result.id); } catch {}
    c.name = profile.name; c.host = profile.host; c.port = profile.port; c.username = profile.username; c.protocol = profile.protocol || 'ssh';
    c.pane.dataset.connectionId = result.id; c.pane.querySelector('.pane-heading .pane-title').textContent = c.name;
    c.overlay?.remove(); c.overlay = null;
    c.terminal.options = terminalAppearance(state.settings,profile);
    c.terminal.writeln('\r\n\x1b[90m재접속 중…\x1b[0m');
    state.connections = new Map([...state.connections].map(([id, record]) => [id === oldId ? result.id : id, record]));
    state.dockLayout = mapDock(state.dockLayout, id => id === oldId ? result.id : id);
    if (state.active === oldId) state.active = result.id;
    const buffered = drainUnknownEvents(result.id); buffered.forEach(handleEvent);
    renderTabs(); renderSessions(); layoutTerminals(); updateStatus();
  } catch (error) { c.reconnecting = false; c.status = 'error'; renderTabs(); updateStatus(); throw error; }
  finally { c.reconnectOperation = false; if(c.cancelReconnect)c.reconnecting=false; finishOperation(); c.reconnectDone = null; updateStatus(); }
}
async function reconnectActive(){await reconnectTerminal(state.connections.get(state.active));}
async function cloneTerminal(c) {
  if (!c) return;
  if (c.profile.temporary) { const result = await api.quickConnect(c.profile, { cols: c.terminal.cols, rows: c.terminal.rows }); attachConnection(result, result.session); }
  else await connectSession(c.sessionId);
}
function setSplit(direction) {
  if (direction !== 'off' && state.connections.size < 2) return;
  endTabDrag(); state.dockLayout = null;
  state.split = direction !== 'off';
  if (direction !== 'off') state.splitDirection = direction;
  if (state.emptyWorkspace && state.connections.has(state.active)) activateTerminal(state.active, false);
  else layoutTerminals();
}
function splitActions(c) {
  return [['세로 탭 분할 (좌우)', 'columns'], ['가로 탭 분할 (위아래)', 'rows'], ['일반 탭 보기', 'off']].map(([label, direction]) => [
    label, () => { if (c) { checkTerminal(c); activateTerminal(c.id, false); } setSplit(direction); },
    direction !== 'off' && state.connections.size < 2,
    { icon: direction === 'off' ? 'terminal' : direction === 'rows' ? 'splitRows' : 'split', checked: direction === 'off' ? !state.split : state.split && !state.dockLayout && state.splitDirection === direction }
  ]);
}
function showSplitMenu() {
  const bounds = $('toggle-split').getBoundingClientRect();
  showContextMenu({ clientX: bounds.left, clientY: bounds.bottom + 4 }, splitActions());
}
function hideContextMenu() { $('context-menu').classList.add('hidden'); }
let contextMenuOpener = null;
function showContextMenu(event, actions) {
  closeMenus(); const menu = $('context-menu'); menu.replaceChildren();
  contextMenuOpener = event.target?.closest?.('[data-tree-key],.remote-file,.snippet-card') || null;
  for (const action of actions) {
    if (!action) { menu.append(el('hr')); continue; }
    const [label, callback, disabled, presentation = {}] = action, item = button(label, null, '', async () => { hideContextMenu(); await callback(); });
    item.replaceChildren();item.setAttribute('aria-label',label);
    const symbol=el('span','context-icon');symbol.setAttribute('aria-hidden','true');if(presentation.icon)symbol.innerHTML=icon(presentation.icon);item.append(symbol,el('span','context-label',label));
    if(presentation.shortcut){const shortcut=el('span','context-shortcut',presentation.shortcut);shortcut.setAttribute('aria-hidden','true');item.append(shortcut);}
    if(presentation.checked){const marker=el('span','context-marker','✓');marker.setAttribute('aria-hidden','true');item.append(marker);}
    item.title=presentation.hint||label;item.classList.toggle('context-danger',!!presentation.danger);
    item.setAttribute('role', 'menuitem'); item.disabled = !!disabled; item.addEventListener('mousemove', () => { if (!item.disabled && document.activeElement !== item) item.focus({ preventScroll: true }); }); menu.append(item);
  }
  menu.classList.remove('hidden'); menu.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - menu.offsetWidth - 4))}px`; menu.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - menu.offsetHeight - 4))}px`; menu.querySelector('button:not(:disabled)')?.focus();
}
function checkTerminal(c){if(!c||c.closing||state.connections.get(c.id)!==c)throw new Error('이 터미널 탭은 닫혔습니다.');return c;}
function openConnectionSettings(c){checkTerminal(c);if(c.profile.sharedSourceId)return showSharedProfile(c.profile);if(c.profile.temporary)openSession({...c.profile,id:null,rememberPassphrase:false,hasPassphrase:false});else openSession(sessionById(c.sessionId));}
async function toggleConnectionLog(c){checkTerminal(c);if(c.status!=='connected')throw new Error('로그 저장은 연결된 세션에서 사용할 수 있습니다.');const result=await api.setLogging(c.id,!c.logging);c.logging=result.enabled;updateStatus();toast(result.enabled?'현재 세션의 로그 저장을 시작했습니다.':'로그 저장을 중지했습니다.');}
function toggleTerminalDisplay(c,key){checkTerminal(c);c.gutterOverrides[key]=!(key==='terminalTimestamps'?c.gutter.timestamps:c.gutter.lineNumbers);c.gutter.configure({...state.settings,...c.gutterOverrides});scheduleFit();c.terminal.focus();}
function showTerminalMenu(event,c){
  const t=c.terminal,selection=t.getSelection(),connected=c.status==='connected',busy=c.reconnecting||c.reconnectOperation;
  const connectionId=c.id;
  const canCopyAndPaste=()=>c.id===connectionId && state.connections.get(connectionId)===c && c.status==='connected' && !c.closing && !c.manualDisconnect && !c.reconnecting && !c.reconnectOperation;
  const withFocus=async action=>{checkTerminal(c);await action();t.focus();};
  showContextMenu(event,[
    ['복사',()=>withFocus(()=>api.writeClipboard(selection)),!selection,{icon:'copy',shortcut:shortcutHint('copy-terminal')}],
    ['화면 복사',()=>withFocus(()=>api.writeClipboard(visibleTerminalText(t))),false,{icon:'copy'}],
    ['붙여넣기',()=>pasteClipboard(c,connectionId),!connected,{icon:'copy',shortcut:shortcutHint('paste-terminal')}],
    ['복사 및 붙여넣기',async()=>{if(!selection||!canCopyAndPaste())return;await api.writeClipboard(selection);if(canCopyAndPaste())await pasteTerminal(c,selection,canCopyAndPaste);},!selection||!canCopyAndPaste(),{icon:'copy'}],
    ['전체 선택',()=>{t.selectAll();t.focus();},false],['선택 해제',()=>{t.clearSelection();t.focus();},!selection],null,
    ['선택 내용 찾기',()=>{checkTerminal(c);activateTerminal(c.id,false);for(const id of ['search-regex','search-word'])$(id).setAttribute('aria-pressed','false');$('terminal-search-input').value=selection;openTerminalSearch();findTerminal(false,true);},!commandSelection(selection,4096),{icon:'search'}],
    ['선택 내용을 명령 창에 넣기',()=>{checkTerminal(c);if(!commandSelection(selection))return;activateTerminal(c.id,false);state.commandVisible=true;switchView('sessions');$('command-input').value=selection;$('command-input').focus();},!connected||!commandSelection(selection),{icon:'terminal',hint:'한 줄 선택 내용을 입력창에 채웁니다. Enter를 누르기 전에는 전송하지 않습니다.'}],
    ['터미널 찾기…',()=>{checkTerminal(c);activateTerminal(c.id,false);openTerminalSearch();},false,{icon:'search',shortcut:shortcutHint('terminal-search')}],null,
    ['맨 위로',()=>{t.scrollToTop();t.focus();},false],['최신 출력으로',()=>{t.scrollToBottom();t.focus();},false],
    ['화면 지우기',()=>{c.semantic.clear();c.gutter.clear();t.write('\x1b[2J\x1b[H');c.semantic.schedule();t.focus();},false],
    ['모두 지우기',()=>{c.semantic.clear();c.gutter.clear();t.write('\x1b[2J\x1b[3J\x1b[H');t.clear();c.semantic.schedule();t.focus();},false],null,
    ['시간 표시',()=>toggleTerminalDisplay(c,'terminalTimestamps'),false,{checked:c.gutter.timestamps}],
    ['줄 번호 표시',()=>toggleTerminalDisplay(c,'terminalLineNumbers'),false,{checked:c.gutter.lineNumbers}],null,
    [c.logging?'로그 저장 중지':'로그 저장 시작',()=>toggleConnectionLog(c),!connected,{icon:'file'}],
    ['재접속',()=>reconnectTerminal(c),busy,{icon:'refresh'}],['연결 종료',()=>disconnectTerminal(c),!['connecting','connected'].includes(c.status)&&!c.reconnectTimer,{icon:'stop'}],
    ...(c.protocol==='telnet'?[]:[['SFTP 파일 탐색기',async()=>{checkTerminal(c);activateTerminal(c.id,false);state.files=true;layoutTerminals();await loadFiles();},!connected,{icon:'folder'}]]),
    [c.profile.temporary?'세션으로 저장…':'세션 속성…',()=>openConnectionSettings(c),false,{icon:'settings'}],
    ['터미널 설정…',()=>{openSettings();showSettingsPage('terminal');},false,{icon:'settings'}]
  ]);
}
function showSessionMenu(event,s){
  if(s.sharedSourceId){event.preventDefault();event.stopPropagation();selectSession(s.id);showContextMenu(event,[['연결',()=>connectSession(s.id),false,{icon:'play'}],['세션 정보…',()=>showSharedProfile(s),false,{icon:'file'}],['세션 이름 복사',()=>api.writeClipboard(s.name),false,{icon:'copy'}],['접속 주소 복사',()=>api.writeClipboard(sessionAddress(s)),false,{icon:'copy'}],null,...sharedSourceActions(s.sharedSourceId)]);return;}
  event.preventDefault();event.stopPropagation();if(!state.selection.has(s.id))selectSession(s.id);else{state.selected=s.id;updateSessionProperties();updateStatus();}
  const profiles=state.sessions.filter(item=>state.selection.has(item.id)),multiple=profiles.length>1;
  showContextMenu(event,[...newTreeActions(s.folder),null,
    [multiple?`선택한 ${profiles.length}개 세션 연결`:'연결',connectSelected],['세션 속성…',()=>openSession(s),multiple],['선택 세션 일괄 설정…',()=>operations.openBulk([...state.selection])],
    ['폴더로 이동…',()=>openSessionMove(s)],['이름 변경…',()=>openSessionRename(s),multiple],
    ['설정 복사…',()=>openSession({...s,id:null,name:`${s.name} 복사`,hasPassphrase:false,rememberPassphrase:false}),multiple],
    [s.favorite?'즐겨찾기 해제':'즐겨찾기 추가',async()=>{await api.saveSession({id:s.id,favorite:!s.favorite});await refreshData();},multiple],null,
    [multiple?'선택한 세션 이름 복사':'세션 이름 복사',()=>api.writeClipboard(profiles.map(item=>item.name).join('\n')),false,{icon:'copy'}],
    [multiple?'선택한 접속 주소 복사':'접속 주소 복사',()=>api.writeClipboard(profiles.map(sessionAddress).join('\n')),false,{icon:'copy'}],null,
    [multiple?`선택한 ${profiles.length}개 세션 삭제…`:'세션 삭제…',deleteSelectedSessions,false,{icon:'close',danger:true}]
  ]);
}
function showTabMenu(event, c) {
  showContextMenu(event, [
    ['재접속', () => reconnectTerminal(c), c.reconnecting], ['연결 종료', () => disconnectTerminal(c), !['connecting','connected'].includes(c.status) && !c.reconnectTimer],
    ['세션 복제', () => cloneTerminal(c),false,{icon:'copy'}], ['세션 속성…', () => c.profile.sharedSourceId ? showSharedProfile(c.profile) : c.profile.temporary ? openSession({ ...c.profile, id:null }, true) : openSession(sessionById(c.sessionId))],
    ...(c.profile.temporary?[['세션으로 저장…',()=>openConnectionSettings(c),false,{icon:'file'}]]:[]),
    null,['세션 이름 복사',()=>api.writeClipboard(c.name),false,{icon:'copy'}],['접속 주소 복사',()=>api.writeClipboard(sessionAddress(c)),false,{icon:'copy'}],
    [c.logging?'로그 저장 중지':'로그 저장 시작',()=>toggleConnectionLog(c),c.status!=='connected',{icon:'file'}],
    ...(c.protocol==='telnet'?[]:[['SFTP 파일 탐색기',async()=>{checkTerminal(c);activateTerminal(c.id,false);state.files=true;layoutTerminals();await loadFiles();},c.status!=='connected',{icon:'folder'}]]),
    null, ...splitActions(c),
    null, ['탭 닫기', () => closeTerminal(c.id)], ['다른 탭 닫기', () => closeTerminals([...state.connections.keys()].filter(id => id !== c.id)), state.connections.size < 2],
    ['오른쪽 탭 닫기', () => closeTerminals([...state.connections.keys()].slice([...state.connections.keys()].indexOf(c.id) + 1)), [...state.connections.keys()].at(-1) === c.id],
    ['모든 탭 닫기', () => closeTerminals([...state.connections.keys()])]
  ]);
}
const menuCommands={exit:()=>api.windowAction('close'),'toggle-sidebar':toggleSidebar,'toggle-command':()=>{state.commandVisible=!state.commandVisible;switchView('sessions');},'copy-terminal':()=>{const selection=state.connections.get(state.active)?.terminal.getSelection();if(selection)return api.writeClipboard(selection);},'paste-terminal':async()=>{const c=state.connections.get(state.active);if(c)await pasteClipboard(c);},shortcuts:openShortcutSettings,about:()=>message('SessionDock',`SessionDock ${$('app-version').textContent}\n독립형 SSH2 / Telnet 터미널\n\nSSH: 비밀번호 · 개인키 · 에이전트 · 점프 서버 · SFTP\nTelnet: 옵션 협상 · 터미널 크기 · 로컬 에코 · 세션 로그`)};
Object.assign(menuCommands, { 'new-folder': () => openFolder(state.selectedFolder) });
Object.assign(menuCommands,{'save-workspace':saveWorkspace,'restore-workspace':restoreWorkspace,'clear-command-history':()=>{const c=state.connections.get(state.active);if(c)c.commandHistory=[];commandHistoryIndex=-1;hideCommandSuggestions();toast('현재 탭의 명령 이력을 지웠습니다.');}});
function syncMenuStates() {
  const c = state.emptyWorkspace ? null : state.connections.get(state.active);
  const checks = { 'toggle-sidebar': !document.body.classList.contains('sidebar-hidden'), 'nav-snippets': state.snippetsVisible, 'toggle-command': state.commandVisible, 'split-columns': state.split && !state.dockLayout && state.splitDirection === 'columns', 'split-rows': state.split && !state.dockLayout && state.splitDirection === 'rows', 'split-off': !state.split, 'toggle-log':!!c?.logging };
  for (const node of document.querySelectorAll('.menu-popup [data-command]')) {
    const command = node.dataset.command, reference = $(command); node.disabled = !!reference?.disabled;
    if(command==='batch-run')node.disabled=false;
    if (['copy-terminal', 'select-all-terminal', 'clear-terminal', 'clone-active'].includes(command)) node.disabled = !c;
    if (command === 'paste-terminal') node.disabled = c?.status !== 'connected';
    if (command === 'disconnect-all') node.disabled = ![...state.connections.values()].some(record => ['connected', 'connecting'].includes(record.status) || record.reconnectTimer);
    if (command.startsWith('split-')) node.disabled = command !== 'split-off' && state.connections.size < 2;
    if(['automation','python-script'].includes(command))node.disabled=c?.status!=='connected';
    if(command==='cancel-automation')node.disabled=!c?.automationRunning;
    if(command==='bulk-settings')node.disabled=!state.selection.size||[...state.selection].some(id=>sessionById(id)?.sharedSourceId);
    if(command==='save-workspace')node.disabled=!state.connections.size||state.restoringWorkspace;
    if(command==='restore-workspace')node.disabled=!state.savedWorkspace?.sessionIds?.length||state.restoringWorkspace;
    if(command==='clear-command-history')node.disabled=!c?.commandHistory?.length;
    if (Object.hasOwn(checks, command)) { node.dataset.checked = String(checks[command]); node.setAttribute('role', 'menuitemcheckbox'); node.setAttribute('aria-checked', String(checks[command])); }
  }
}
Object.assign(menuCommands, { 'quick-connect':focusConnectionBar, 'split-columns':()=>setSplit('columns'), 'split-rows':()=>setSplit('rows'), 'split-off':()=>setSplit('off'), 'clone-active':()=>cloneTerminal(state.connections.get(state.active)), 'select-all-terminal':()=>state.connections.get(state.active)?.terminal.selectAll(), 'clear-terminal':()=>{const c=state.connections.get(state.active);if(!c)return;c.semantic.clear();c.gutter.clear();c.terminal.write('\x1b[2J\x1b[3J\x1b[H');c.terminal.clear();c.semantic.schedule();c.terminal.focus();}, 'disconnect-all':async()=>{const records=[...state.connections.values()].filter(c=>['connected','connecting'].includes(c.status)||c.reconnectTimer);if(records.length&&await message('모든 연결 종료',`${records.map(c=>c.name).join(', ')} 연결을 종료합니다.`,{confirm:true,danger:true,action:'모두 종료'}))await Promise.all(records.map(disconnectTerminal));} });
// Menu bar keyboard model (Windows): ←/→ move between menus, ↑/↓/Home/End move
// within one, Esc closes to its title and a second Esc returns to the work area.
let focusBeforeMenus=null;
document.addEventListener('focusin',event=>{if(!event.target.closest('.menubar,#context-menu'))focusBeforeMenus=event.target;});
function openMenu(trigger,focus='first'){closeMenus();syncMenuStates();trigger.setAttribute('aria-expanded','true');const popup=trigger.nextElementSibling;popup.classList.remove('hidden');const items=[...popup.querySelectorAll('button:not(:disabled)')];(focus==='last'?items.at(-1):items[0])?.focus();}
function returnFromMenus(){const target=focusBeforeMenus?.isConnected&&focusBeforeMenus.checkVisibility()&&!focusBeforeMenus.closest('[inert],dialog:not([open])')?focusBeforeMenus:state.connections.get(state.active)?.terminal;target?.focus();}
document.querySelectorAll('.menu-trigger').forEach(trigger=>{trigger.setAttribute('aria-haspopup','menu');trigger.nextElementSibling.setAttribute('role','menu');trigger.addEventListener('click',()=>{const opened=trigger.getAttribute('aria-expanded')==='true';closeMenus();if(!opened)openMenu(trigger);});trigger.addEventListener('mouseenter',()=>{if(document.querySelector('.menu-trigger[aria-expanded=true]')&&trigger.getAttribute('aria-expanded')!=='true'){openMenu(trigger,null);trigger.focus({preventScroll:true});}});});
document.querySelectorAll('.menu-popup button').forEach(item=>{if(!item.getAttribute('role'))item.setAttribute('role','menuitem');item.addEventListener('mousemove',()=>{if(!item.disabled&&document.activeElement!==item)item.focus({preventScroll:true});});});
document.querySelectorAll('[data-command]').forEach(node=>node.addEventListener('click',()=>{closeMenus();const command=node.dataset.command;if(node.id===command)return;Promise.resolve(menuCommands[command]?menuCommands[command]():$(command)?.click()).catch(showError);}));
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.menu'))closeMenus();});
function executeAppShortcut(actionId, record) {
  if(record && record.id!==state.active)activateTerminal(record.id,false);
  const c=state.emptyWorkspace?null:state.connections.get(state.active);
  const menu=document.querySelector('.menu-popup button[data-command="'+actionId+'"]');
  if(menu){syncMenuStates();if(!menu.disabled)menu.click();return;}
  const cycle=delta=>{const ids=[...state.connections.keys()];if(ids.length)activateTerminal(ids[(Math.max(0,ids.indexOf(state.active))+delta+ids.length)%ids.length]);};
  switch(actionId){
    case 'session-search':$('session-search').focus();$('session-search').select();break;
    case 'show-session-search':document.body.classList.remove('sidebar-hidden');scheduleFit();$('session-search').focus();break;
    case 'command-focus':state.commandVisible=true;switchView('sessions');$('command-input').focus();break;
    case 'terminal-focus':c?.terminal.focus();break;
    case 'previous-tab':cycle(-1);break;
    case 'next-tab':cycle(1);break;
    case 'close-tab':if(c)closeTerminal(c.id).catch(showError);break;
    case 'focus-mode':document.body.classList.toggle('terminal-focus-mode');scheduleFit();break;
    case 'zoom-in':case 'zoom-out':if(c){c.fontZoomSize=Math.max(10,Math.min(48,c.terminal.options.fontSize+(actionId==='zoom-in'?1:-1)));c.terminal.options.fontSize=c.fontZoomSize;scheduleFit();}break;
    case 'find-next':case 'find-previous':openTerminalSearch(false);findTerminal(actionId==='find-previous');break;
  }
}
document.addEventListener('focusin',()=>shortcutResolver.reset());
window.addEventListener('blur',()=>shortcutResolver.reset());
new MutationObserver(()=>{if(document.querySelector('dialog[open]'))shortcutResolver.reset();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});

document.addEventListener('keydown',event=>{
  const trigger=event.target.closest?.('.menu-trigger'),popup=event.target.closest?.('.menu-popup'),open=document.querySelector('.menu-trigger[aria-expanded=true]');
  if(event.key==='Escape'){if(open){event.preventDefault();closeMenus();open.focus();}else if(trigger){event.preventDefault();returnFromMenus();}return;}
  if(!trigger&&!popup)return;
  const triggers=[...document.querySelectorAll('.menu-trigger')],current=trigger||popup.previousElementSibling;
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const next=triggers[(triggers.indexOf(current)+(event.key==='ArrowRight'?1:-1)+triggers.length)%triggers.length];if(open)openMenu(next);else next.focus();return;}
  if(trigger&&(event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();openMenu(trigger,event.key==='ArrowUp'?'last':'first');return;}
  if(popup&&['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...popup.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
  else if(popup&&event.key==='Tab')closeMenus();
});
listen('connect-selected',connectSelected);listen('edit-selected',()=>{const s=sessionById(state.selected);if(s)openSession(s);else if(state.selectedFolder)openFolder(state.selectedFolder,true);});listen('tree-connect',()=>$('connect-selected').click());listen('tree-edit',()=>$('edit-selected').click());listen('disconnect-active',()=>disconnectTerminal(state.connections.get(state.active)));listen('reconnect-active',reconnectActive);listen('hide-sidebar',toggleSidebar);listen('tab-new',focusConnectionBar);listen('close-snippets',()=>{state.snippetsVisible=false;switchView('sessions');});listen('close-command',()=>{state.commandVisible=false;switchView('sessions');});
listen('collapse-folders',()=>{const folders=treeView.items.filter(item=>item.kind==='folder'),anyExpanded=folders.some(item=>!item.collapsed);if(anyExpanded)sessionTree.folders.forEach((node,path)=>state.collapsed.add(path));else state.collapsed.clear();renderSessions();});
$('session-list').addEventListener('contextmenu', event => { event.preventDefault(); selectFolder(''); showContextMenu(event, newTreeActions()); });
document.querySelector('.sidebar .dock-heading').addEventListener('contextmenu', event => { event.preventDefault(); selectFolder(''); showContextMenu(event, newTreeActions()); });
$('folder-form').addEventListener('submit', saveFolder);
$('move-session-form').addEventListener('submit', moveSession);
$('rename-session-form').addEventListener('submit', renameSession);
listen('folder-publish-confirm', confirmFolderPublish);
listen('folder-publish-cancel', () => cancelFolderPublish());
listen('folder-publish-close', () => cancelFolderPublish());
$('folder-publish-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelFolderPublish(); });
$('session-list').addEventListener('dragover', event => {
  const folder = treeDropFolder(event); if (!canTreeDrop(folder)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.tree-drop-target').forEach(node => node.classList.remove('tree-drop-target')); (folderHeading(folder) || $('session-list')).classList.add('tree-drop-target');
});
$('session-list').addEventListener('dragleave', event => { if (!$('session-list').contains(event.relatedTarget)) document.querySelectorAll('.tree-drop-target').forEach(node => node.classList.remove('tree-drop-target')); });
$('session-list').addEventListener('drop', event => { const folder = treeDropFolder(event); if (!canTreeDrop(folder)) return; event.preventDefault(); const source = state.treeDrag; endTreeDrag(); moveTree(source, folder).catch(showError); });
dockUI = installTerminalDockUI({
  sessionDragId:()=>state.treeConnectionDrag,sessionExists:id=>!!sessionById(id),endSessionDrag:endTreeDrag,openSession:connectSession,onError:showError,
  connections: () => state.connections, active: () => state.active, dragId: () => state.tabDrag, setDragId: id => { state.tabDrag = id; },
  split: () => state.split, tree: () => state.dockLayout, setTree: tree => { state.dockLayout = tree; },
  legacyTree: () => state.split ? gridDock([...state.connections.keys()], state.splitDirection, state.splitTracks.columns, state.splitTracks.rows) : { id: state.active },
  commit(tree, id) { state.dockLayout = tree; state.split = true; state.splitDirection = tree.axis; activateTerminal(id); },
  endDrag: endTabDrag, fit: () => { scheduleFit(); persistLayout(); }
});
const canDropSession=event=>state.treeConnectionDrag&&sessionById(state.treeConnectionDrag)&&!document.querySelector('dialog[open]')&&[...event.dataTransfer.types].includes('application/x-sessiondock-session');
$('empty-workspace').addEventListener('dragover',event=>{if(!canDropSession(event))return;event.preventDefault();event.dataTransfer.dropEffect='copy';$('empty-workspace').classList.add('session-drop-target');});
$('empty-workspace').addEventListener('dragleave',event=>{if(!$('empty-workspace').contains(event.relatedTarget))$('empty-workspace').classList.remove('session-drop-target');});
$('empty-workspace').addEventListener('drop',event=>{if(!canDropSession(event))return;event.preventDefault();const id=state.treeConnectionDrag;endTreeDrag();connectSession(id).catch(showError);});
$('tabs').addEventListener('scroll', updateTabControls);
listen('status-detail',()=>message('연결 상태',$('status-text').textContent));
$('tabs').addEventListener('keydown', handleTabKey);
let tabRevealRaf = 0;
new ResizeObserver(() => {
  updateTabControls();
  if (tabRevealRaf) return;
  tabRevealRaf = requestAnimationFrame(() => {
    tabRevealRaf = 0;
    if (state.tabDrag) return;
    $('tabs').querySelector('.terminal-tab.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
  });
}).observe($('tabs'));
new MutationObserver(persistLayout).observe(document.documentElement,{attributes:true,attributeFilter:['style']});
$('session-list').addEventListener('scroll',scheduleTreeViewport,{passive:true});
$('session-list').addEventListener('focusin',event=>{const key=event.target.closest('[data-tree-key]')?.dataset.treeKey;if(key&&key!==state.treeFocusKey){state.treeFocusKey=key;syncTreeTabStops();}});
new ResizeObserver(scheduleTreeViewport).observe($('session-list'));
$('tabs').addEventListener('wheel', event => { if (!event.ctrlKey && $('tabs').scrollWidth > $('tabs').clientWidth) { event.preventDefault(); $('tabs').scrollLeft += event.deltaY || event.deltaX; } }, { passive: false });
listen('tab-scroll-left', () => $('tabs').scrollBy({ left: -240, behavior: 'smooth' })); listen('tab-scroll-right', () => $('tabs').scrollBy({ left: 240, behavior: 'smooth' }));
listen('tab-list', event => showContextMenu(event, [...state.connections.values()].map(c => [`${c.status === 'connected' ? '●' : '○'} ${c.name}`, () => activateTerminal(c.id)])));
$('snippet-list').addEventListener('contextmenu', event => { const snippet = state.snippets.find(item => item.id === event.target.closest('.snippet-card')?.dataset.snippetId); if (!snippet) return; event.preventDefault(); showSnippetMenu(event, snippet); });
$('tabs').addEventListener('mousedown', event => { if (event.button === 1 && event.target.closest('.terminal-tab')) event.preventDefault(); });
$('tabs').addEventListener('auxclick', event => {
  if (event.button !== 1) return;
  const tab = event.target.closest('.terminal-tab'); if (!tab || !state.settings.middleClickClosesTab) return;
  event.preventDefault(); event.stopPropagation(); closeTerminal(tab.dataset.connectionId).catch(showError);
});
$('session-list').addEventListener('keydown', event => {
  const items = treeView?.items || [], key = document.activeElement?.closest('[data-tree-key]')?.dataset.treeKey, index = treeView?.index.get(key) ?? -1;
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyA') { event.preventDefault(); state.selection = new Set(treeView.sessionIds); state.selected = event.target.dataset.sessionId || [...state.selection][0] || null; state.selectionAnchor = state.selected; syncTreeSelection(); }
  else if (['ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) { event.preventDefault(); const page=Math.max(1,Math.floor($('session-list').clientHeight/27)-1),step={ArrowDown:1,ArrowUp:-1,PageDown:page,PageUp:-page}[event.key];const nextIndex=event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,index+step));const next=items[nextIndex]; if(next)moveTreeFocus(next,event); }
  else if (['ArrowLeft','ArrowRight'].includes(event.key) && index >= 0) {
    // Tree pattern: Right expands, then enters the first child; Left collapses,
    // then moves to the parent folder. Search results are always expanded.
    event.preventDefault(); const item=items[index],expanded=item.kind==='folder'&&!item.collapsed;
    if(event.key==='ArrowRight'){ if(item.kind!=='folder')return; if(!expanded){state.collapsed.delete(item.node.path);renderSessions();focusTreeItem(item.key);} else if(items[index+1]?.depth>item.depth)moveTreeFocus(items[index+1],event); }
    else if(expanded&&!state.search){state.collapsed.add(item.node.path);renderSessions();focusTreeItem(item.key);}
    else { for(let parent=index-1;parent>=0;parent--)if(items[parent].kind==='folder'&&items[parent].depth<item.depth){moveTreeFocus(items[parent],event);break;} }
  }
  else if (event.key === ' ' && index >= 0) { event.preventDefault(); const item=items[index]; if(item.kind==='session')selectSession(item.session.id,{ctrlKey:event.ctrlKey||event.metaKey,shiftKey:event.shiftKey}); else selectFolder(item.node.path); }
  else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') { const node=event.target.closest('[data-tree-key]'); if(!node)return; event.preventDefault(); const bounds=node.getBoundingClientRect(); node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:bounds.left+Math.min(48,bounds.width/2),clientY:bounds.bottom})); }
  else if (event.key === 'Enter') { event.preventDefault(); if (event.target.matches('.session-row')) { if (!state.selection.has(event.target.dataset.sessionId)) selectSession(event.target.dataset.sessionId); connectSelected().catch(showError); } else if(event.target.matches('.folder-heading')) { const path = event.target.dataset.folderPath; if(state.collapsed.has(path))state.collapsed.delete(path);else state.collapsed.add(path);renderSessions();focusTreeItem(`folder:${path}`); } }
  else if (event.key === 'F2') { event.preventDefault(); if (state.selection.size === 1) openSessionRename(sessionById(state.selected)); else if (!state.selection.size && state.selectedFolder) openFolder(state.selectedFolder, true); }
  else if (event.key === 'Delete') { event.preventDefault(); if(state.selection.size)deleteSelectedSessions().catch(showError);else if(state.selectedFolder)deleteFolder(state.selectedFolder).catch(showError); }
});
let sidebarDrag;const resizer=$('sidebar-resizer');
// Integer pixels on purpose: a fractional custom property reaches the layout
// validator after DPI scaling and made an otherwise legal drag unsaveable.
const setSidebarWidth=width=>{const next=Math.max(190,Math.min(430,Math.round(Number(width)||258)));document.documentElement.style.setProperty('--sidebar-width',`${next}px`);scheduleFit();};
resizer.addEventListener('pointerdown',event=>{sidebarDrag={x:event.clientX,width:document.querySelector('.sidebar').clientWidth};resizer.setPointerCapture(event.pointerId);event.preventDefault();});
resizer.addEventListener('pointermove',event=>{if(sidebarDrag)setSidebarWidth(sidebarDrag.width+event.clientX-sidebarDrag.x);});
// Commit once the drag ends instead of relying on the next unrelated render:
// the MutationObserver on the root style fires per pointermove, so the debounced
// autosave could otherwise be cancelled repeatedly while the pointer is down.
const endSidebarDrag=()=>{const wasDragging=!!sidebarDrag;sidebarDrag=null;if(wasDragging)persistLayout();};
resizer.addEventListener('pointerup',endSidebarDrag);resizer.addEventListener('lostpointercapture',endSidebarDrag);resizer.addEventListener('pointercancel',endSidebarDrag);
resizer.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setSidebarWidth(document.querySelector('.sidebar').clientWidth+(event.key==='ArrowRight'?10:-10));persistLayout();}});
$('session-protocol').addEventListener('change',()=>{sessionPortChoice.explicitProtocol=true;sessionPortChoice.undoProtocol=null;$('session-port-hint').classList.add('hidden');updateProtocolFields(true);sessionPortChoice.previousPort=$('session-form').elements.port.value;});$('session-form').elements.port.addEventListener('change',updateProtocolFromPort);
listen('session-port-undo',()=>{if(!sessionPortChoice.undoProtocol)return;const form=$('session-form');form.elements.protocol.value=sessionPortChoice.undoProtocol;sessionPortChoice.explicitProtocol=true;sessionPortChoice.undoProtocol=null;updateProtocolFields();form.elements.telnetEnter.value=sessionPortChoice.undoTelnetEnter;sessionPortChoice.undoTelnetEnter=null;$('session-port-hint').classList.add('hidden');});$('command-target').addEventListener('change',updateCommandTargetLabel);
for(const id of ['new-session','toolbar-new'])listen(id,()=>openSession());listen('quick-options',()=>openSession(null,true));listen('import-securecrt',()=>importSessions('securecrt'));listen('import-windterm',()=>importSessions('windterm'));listen('import-putty',()=>importSessions('putty'));listen('import-putty-file',()=>importSessions('putty-file'));listen('import-file',()=>importSessions('file'));listen('export-sessions',exportSessions);
listen('nav-sessions',()=>switchView('sessions'));listen('nav-snippets',()=>switchView('snippets'));listen('open-logs',()=>api.showLogs());listen('open-data-folder',()=>api.showData());listen('open-settings',openSettings);
listen('create-desktop-shortcut', async () => {
  const button = $('create-desktop-shortcut');
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const res = await api.createShortcut();
    if (!res?.success) throw new Error(res?.error || '바로가기 생성에 실패했습니다.');
    // The desktop link cannot repair a pin Explorer already owns, so this
    // guides the user to unpin instead of implying the number is fixed.
    toast('바탕화면 바로가기를 만들었습니다. 작업 표시줄 아이콘은 제거 후 다시 고정하세요.');
  } catch (err) {
    showError(err);
  } finally {
    if (button) button.disabled = false;
  }
});
listen('shared-browse',async()=>{const path=await api.chooseSharedFile();if(path){$('shared-source-path').value=path;if(!$('shared-source-name').value)$('shared-source-name').value=path.split(/[\\/]/).at(-1).replace(/\.json$/i,'');}});
listen('shared-add',()=>sharedOperation(async()=>{const path=$('shared-source-path').value.trim(),name=$('shared-source-name').value.trim();await api.addSharedSource({name,path});await refreshData();$('shared-source-name').value='';$('shared-source-path').value='';$('shared-result').textContent='공유 목록을 등록했습니다.';}));
for(const id of ['shared-source-name','shared-source-path'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('shared-add').click();}});
$('connection-bar').addEventListener('submit',event=>connectAddress(event).catch(showError));$('connection-protocol').addEventListener('change',()=>{updateConnectionBar();updateAddressSuggestions();});
$('connection-address').addEventListener('input',updateAddressSuggestions);$('connection-address').addEventListener('focus',updateAddressSuggestions);
$('connection-address').addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement!==$('connection-address')&&document.activeElement!==$('address-connect')&&!$('address-suggestions').contains(document.activeElement))hideAddressSuggestions();},100));
$('connection-address').addEventListener('keydown',event=>{if(event.key==='Enter'&&event.shiftKey){event.preventDefault();event.stopPropagation();if(event.repeat||event.isComposing||event.keyCode===229)return;connectAddress(event,{direct:true}).catch(showError);return;}if(event.isComposing||event.keyCode===229){if(event.key==='Enter')event.preventDefault();return;}if(event.key==='Escape'){event.preventDefault();hideAddressSuggestions();}else if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if($('address-suggestions').classList.contains('hidden'))updateAddressSuggestions();const count=addressMatches.items.length;if(count)selectAddressSuggestion(addressMatchIndex<0?(event.key==='ArrowDown'?0:count-1):(addressMatchIndex+(event.key==='ArrowDown'?1:-1)+count)%count);}});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.connection-address-wrap')&&!event.target.closest('#address-connect'))hideAddressSuggestions();});
document.querySelectorAll('[data-settings-page]').forEach(node=>node.addEventListener('click',()=>showSettingsPage(node.dataset.settingsPage)));
$('settings-form').addEventListener('invalid', event => { const panel = event.target.closest('[data-settings-panel]'); if (panel) showSettingsPage(panel.dataset.settingsPanel); }, true);
$('settings-form').addEventListener('input',()=>{$('settings-form-error').textContent='';updateColorPreview();updateSettingsFooter();});
$('settings-form').addEventListener('change',updateSettingsFooter);
$('settings-dialog').addEventListener('close',()=>{settingsBaseline='';shortcutSettings?.cancel();shortcutResolver.reset();});
for(const id of ['log-directory','log-format'])$(id).addEventListener('input',()=>{clearTimeout(logPreviewTimer);logPreviewTimer=setTimeout(updateLogPreview,150);});
$('settings-form').elements.logFilenameTemplate.addEventListener('input',()=>{$('log-template-preset').value='';clearTimeout(logPreviewTimer);logPreviewTimer=setTimeout(updateLogPreview,150);});
$('log-template-preset').addEventListener('change',()=>{if($('log-template-preset').value){formValue($('settings-form'),'logFilenameTemplate',$('log-template-preset').value);updateLogPreview();updateSettingsFooter();}});
listen('global-font-defaults',()=>{for(const [key,value] of Object.entries({fontFamily:APPEARANCE_DEFAULTS.fontFamily,fontWeight:'normal',fontSize:14,lineHeight:1,letterSpacing:0}))formValue($('settings-form'),key,value);updateColorPreview();updateSettingsFooter();});
listen('session-font-defaults',()=>{for(const [key,value] of Object.entries({fontFamily:'',fontWeight:'',fontSize:0,lineHeight:0,letterSpacing:-1}))formValue($('session-form'),key,value);updateTerminalPreview();});
listen('browse-log-directory',async()=>{const directory=await api.chooseLogDirectory();if(directory){formValue($('settings-form'),'logDirectory',directory);updateLogPreview();updateSettingsFooter();}});listen('settings-open-logs',()=>api.showLogs());
let settingsUpdateOffer = null;
async function refreshUpdateStatus(){showSettingsUpdateOffer(await api.updateStatus(),'현재 버전 '+$('app-version').textContent);}
function syncUpdateSourceFields() {
  const local = $('update-local-folder').checked;
  $('update-directory').disabled = $('browse-update-directory').disabled = !local;
  const settings = state.settings;
  const source = settings.updateFromLocalFolder ? settings.updateDirectory || '업데이트 폴더를 선택해 주세요.' : '(sessiondock.norahc.com)';
  $('update-open-website').hidden = settings.updateFromLocalFolder;
  $('update-source').textContent = $('update-source').title = source;
}
function requireAppliedUpdateSettings() {
  const local = $('update-local-folder').checked;
  if (local !== state.settings.updateFromLocalFolder || (local && $('update-directory').value.trim() !== state.settings.updateDirectory)) {
    throw new Error('변경한 업데이트 설정을 먼저 적용해 주세요.');
  }
}
function showSettingsUpdateOffer({candidate, generation}, emptyMessage) {
  settingsUpdateOffer = candidate ? {name:candidate.name,version:candidate.version,generation} : null;
  $('update-install').hidden = !candidate;
  $('update-result').textContent = candidate ? '새 버전 '+candidate.version+' 설치 가능' : emptyMessage;
}
$('update-local-folder').addEventListener('change',syncUpdateSourceFields);
listen('update-open-website',()=>api.openUpdateWebsite());
listen('browse-update-directory',async()=>{if(!$('update-local-folder').checked)return;const directory=await api.chooseUpdateDirectory();if(directory && $('update-local-folder').checked){formValue($('settings-form'),'updateDirectory',directory);updateSettingsFooter();}});
listen('update-check',async()=>{if($('update-check').disabled)return;try{requireAppliedUpdateSettings();$('update-check').disabled=true;showSettingsUpdateOffer({},'확인 중…');showSettingsUpdateOffer(await api.checkUpdate(),'새 업데이트가 없습니다.');}catch(error){$('update-result').textContent=updateErrorText(error);}finally{$('update-check').disabled=false;}});
listen('update-install',async()=>{if($('update-install').disabled)return;let started=false;try{requireAppliedUpdateSettings();if(!settingsUpdateOffer)return;$('update-install').disabled=true;$('update-check').disabled=true;$('update-result').textContent='업데이트 파일 준비 중…';started=await prepareAndInstallUpdate(settingsUpdateOffer);if(!started)$('update-result').textContent='업데이트 설치를 취소했습니다.';}catch(error){$('update-result').textContent=updateErrorText(error);}finally{if(!started){$('update-install').disabled=false;$('update-check').disabled=false;}}});
function updateErrorText(error) { return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''); }
$('session-search').addEventListener('input',e=>{state.search=e.target.value;renderSessions();});
// ↓ from the search box enters the result tree at the first match.
$('session-search').addEventListener('keydown',event=>{if(event.key!=='ArrowDown'||event.isComposing)return;const items=treeView?.items||[],first=items.find(item=>item.kind==='session')||items[0];if(!first)return;event.preventDefault();moveTreeFocus(first);});for(const filter of ['all','favorite','online'])listen(`filter-${filter}`,()=>{state.filter=filter;renderSessions();});
$('session-form').addEventListener('submit',saveSession);$('session-form').elements.authType.addEventListener('change',updateAuthFields);listen('browse-key',async()=>{const selected=await api.chooseKey();if(selected)formValue($('session-form'),'privateKeyPath',selected);});listen('add-forward',()=>addForward());listen('delete-session',async()=>{const s=sessionById(state.editId);if(s&&await message('세션 삭제',`${s.name} 세션을 삭제하시겠습니까?`,{confirm:true,danger:true,action:'삭제'})){await api.deleteSession(s.id);$('session-dialog').close();await refreshData();toast('세션을 삭제했습니다.');}});
document.querySelectorAll('[data-session-page]').forEach(node => node.addEventListener('click', () => showSessionPage(node.dataset.sessionPage)));
$('session-form').addEventListener('invalid', event => { const page = event.target.closest('[data-session-panel]'); if(page)showSessionPage(page.dataset.sessionPanel); }, true);
$('session-form').elements.saveQuickSession.addEventListener('change',updateQuickSave);
for(const key of ['fontFamily','fontWeight','fontSize','lineHeight','letterSpacing','cursorStyle'])$('session-form').elements[key].addEventListener('input',updateTerminalPreview);
$('session-dialog').addEventListener('close',()=>{$('session-form').elements.passphrase.value='';concealPasswordFields($('session-form'));});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('#context-menu'))hideContextMenu();});
window.addEventListener('resize',()=>{hideContextMenu();if($('toasts').children.length)placeToasts();});
$('empty-workspace').addEventListener('contextmenu',event=>{event.preventDefault();showContextMenu(event,[...newTreeActions(state.selectedFolder),null,['빠른 연결',()=>focusConnectionBar(),false,{icon:'zap',shortcut:shortcutHint('quick-connect')}],['전체 설정…',()=>openSettings(),false,{icon:'settings'}]]);});
// Esc returns to the tree/file/button row that opened the menu; menus opened
// from the terminal or toolbar return to the active terminal as before.
function leaveContextMenu(){hideContextMenu();const opener=contextMenuOpener;contextMenuOpener=null;if(opener?.isConnected)opener.focus({preventScroll:true});else state.connections.get(state.active)?.terminal.focus();}
document.addEventListener('keydown',event=>{const menu=$('context-menu');if(menu.classList.contains('hidden'))return;if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();leaveContextMenu();}else if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}});
$('settings-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.target,submit=form.querySelector('button[type=submit]');submit.disabled=true;$('settings-form-error').textContent='';try{const values=Object.fromEntries(new FormData(form));for(const key of ['fontSize','lineHeight','letterSpacing','scrollback','terminalTransparency'])values[key]=Number(values[key]);for(const key of ['scrollOnOutput','scrollOnKeypress','visualBell','logEnabled','logTimestamps','logRotateDaily','updateCheckOnStartup','updateFromLocalFolder','semanticColoring','terminalLineNumbers','terminalTimestamps',...BOOLEAN_INTERACTION_KEYS])values[key]=form.elements[key].checked;values.shortcuts=getShortcutSettings().getValue();state.settings=await layoutPersistence.saveSettings(values);applySettings();updateConnectionBar();$('settings-dialog').close();toast(transparencyRestartPending(state.settings.terminalTransparency,state.runtimeTransparent)?'창 투명도 모드는 다음 실행에 적용됩니다.':'설정이 적용되었습니다.');}catch(error){const notice=$('settings-form-error');notice.textContent=error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');if(error.code==='ERR_SHORTCUTS'||/단축키|키 조합|키 매핑|예약키|접두사/.test(error.message)){showSettingsPage('shortcuts');getShortcutSettings().showError({message:notice.textContent,actionIds:error.actionIds});getShortcutSettings().focusError();}else{notice.scrollIntoView({block:'nearest'});notice.focus({preventScroll:true});}}finally{submit.disabled=false;}});
listen('toggle-split',showSplitMenu);listen('toggle-files',toggleFiles);listen('close-files',()=>{state.files=false;layoutTerminals();});listen('remote-refresh',()=>loadFiles());listen('remote-parent',()=>loadFiles((state.connections.get(state.active)?.remotePath||'/').replace(/\/?[^/]+\/?$/,'')||'/'));listen('remote-upload',async()=>{const c=state.connections.get(state.active);if(!c||c.filesLoading||!c.filesReady)throw new Error('현재 세션의 파일 목록을 읽은 뒤 업로드해 주세요.');const view=captureFileView(c);let result;try{result=await api.upload(view.id,view.directory);}catch(error){if(!currentFileView(view))return;throw error;}if(result){toast(result.cancelled?`전송 취소 · ${result.count}개 파일 완료`:`${result.count}개 파일 업로드 완료`);if(currentFileView(view)&&!$('remote-name-dialog').open){$('transfer-status').textContent=result.cancelled?'전송을 취소했습니다.':'업로드 완료';await loadFiles(view.directory);}}});$('remote-path-form').addEventListener('submit',event=>{event.preventDefault();loadFiles($('remote-path').value).catch(showError);});
listen('terminal-search',()=>openTerminalSearch());listen('close-terminal-search',()=>{$('terminal-search-box').classList.add('hidden');for(const c of state.connections.values()){c.search.clearDecorations();if(c.searchResult)c.terminal.clearSelection();c.searchResult=null;}$('search-result').textContent='';if(!state.emptyWorkspace)state.connections.get(state.active)?.terminal.focus();});listen('find-previous',()=>findTerminal(true));listen('find-next',()=>findTerminal());$('terminal-search-input').addEventListener('input',()=>findTerminal(false,true));$('terminal-search-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();findTerminal(event.shiftKey);}else if(event.key==='Escape')$('close-terminal-search').click();});
for(const id of ['search-case','search-word','search-regex'])listen(id,()=>{const node=$(id);node.setAttribute('aria-pressed',String(node.getAttribute('aria-pressed')!=='true'));state.connections.get(state.active)?.search.clearDecorations();findTerminal(false,true);});
listen('toggle-log',()=>toggleConnectionLog(state.connections.get(state.active)));
initializeCommandHistory();listen('send-command',()=>sendCommand());$('command-input').addEventListener('keydown',event=>{
  if(event.key!=='Enter')return;
  // An Enter that confirms an IME composition must not run the command; the
  // operator is only committing hangul. Block the default action so the key
  // cannot fall through to the send button either.
  if(commandCompositionGuard(event)){event.preventDefault();return;}
  if(event.defaultPrevented)return;event.preventDefault();sendCommand().catch(showError);});listen('new-snippet',()=>openSnippet());$('snippet-form').addEventListener('submit',async event=>{event.preventDefault();try{const values=Object.fromEntries(new FormData(event.target));if(state.snippetId)values.id=state.snippetId;await api.saveSnippet(values);$('snippet-dialog').close();await refreshData();toast('명령어가 저장되었습니다.');}catch(error){showError(error);}});
listen('message-ok',()=>resolveMessage(true));listen('message-cancel',()=>resolveMessage(false));$('message-dialog').addEventListener('cancel',()=>{messageResolve?.(false);messageResolve=null;});$('prompt-form').addEventListener('submit',event=>{event.preventDefault();answerPrompt().catch(showError);});listen('prompt-cancel',()=>answerPrompt(true));$('prompt-dialog').addEventListener('cancel',event=>{event.preventDefault();answerPrompt(true).catch(showError);});
function installPromptStateUpdates(){
  const refresh=()=>renderTabs();
  $('prompt-form').addEventListener('submit',()=>queueMicrotask(refresh));
  $('prompt-cancel').addEventListener('click',()=>queueMicrotask(refresh));
  $('prompt-dialog').addEventListener('cancel',()=>queueMicrotask(refresh));
}
installPromptStateUpdates();
document.querySelector('.titlebar').addEventListener('dblclick',event=>{if(event.button===0&&!event.target.closest('.window-controls'))api.windowAction('maximize').catch(showError);});
document.querySelectorAll('.modal-close').forEach(node=>node.addEventListener('click',()=>node.closest('dialog').close()));document.querySelectorAll('[data-window]').forEach(node=>node.addEventListener('click',()=>api.windowAction(node.dataset.window).catch(showError)));
document.addEventListener('keydown',event=>{
  // xterm's custom key handler is the sole owner of terminal keydowns.
  if(event.target.closest?.('.xterm'))return;
  const result=shortcutResolver.resolve(event,{terminal:false,editable:!!event.target.closest?.('input,textarea,[contenteditable="true"]'),dialog:!!document.querySelector('dialog[open]')});
  if(result.consume){event.preventDefault();if(result.action)executeAppShortcut(result.action);return;}
  if(!strokeFromEvent(event)||document.querySelector('dialog[open]'))return;
  const mnemonic=['KeyF','KeyE','KeyV','KeyC','KeyT','KeyH'].indexOf(event.code);
  if(event.altKey&&!event.ctrlKey&&!event.shiftKey&&mnemonic>=0){event.preventDefault();if(!event.repeat)document.querySelectorAll('.menu-trigger')[mnemonic]?.click();}
});let operationsUI,advancedUI,batchUI;
function getBatchUI(){return batchUI??=installBatchUI({api,toast,showError});}
function getOperationsUI(){if(!operationsUI){operationsUI=installOperationsUI({api,state,layoutPersistence,refreshData,message,toast,showError,captureWorkspace,restoreWorkspace:async workspace=>{state.savedWorkspace=workspace;await restoreWorkspace();}});document.getElementById('credentials-dialog').addEventListener('close',()=>refreshData().catch(showError));}return operationsUI;}
function getAdvancedUI(){return advancedUI??=installAdvancedTerminalUI({api,state,refreshData,message,toast,showError});}
const operations={openCredentials:(...a)=>getOperationsUI().openCredentials(...a),openBulk:(...a)=>getOperationsUI().openBulk(...a),openWorkspaces:(...a)=>getOperationsUI().openWorkspaces(...a)};
const advanced={openKeymap:(...a)=>getAdvancedUI().openKeymap(...a),openAutomation:(...a)=>getAdvancedUI().openAutomation(...a),openPython:(...a)=>getAdvancedUI().openPython(...a),cancelActive:(...a)=>getAdvancedUI().cancelActive(...a),openSharedCredential:(...a)=>getAdvancedUI().openSharedCredential(...a),onEvent:event=>getAdvancedUI().onEvent(event)};
Object.assign(menuCommands,{'batch-run':()=>getBatchUI().open(),'credentials':()=>operations.openCredentials(),'bulk-settings':()=>operations.openBulk([...state.selection]),'named-workspaces':()=>operations.openWorkspaces(),'keymap':()=>advanced.openKeymap(),'automation':()=>advanced.openAutomation(),'python-script':()=>advanced.openPython(),'cancel-automation':()=>advanced.cancelActive()});
$('session-credential').addEventListener('change',()=>{if(!$('session-credential').value){const saved=sessionById(state.editId),form=$('session-form');for(const key of ['username','authType','privateKeyPath','agentPath'])formValue(form,key,saved?.[key]||(key==='authType'?'password':''));}updateAuthFields();updateQuickSave();});
listen('manage-session-credentials',()=>operations.openCredentials());
$('snippet-search').addEventListener('input',renderSnippets);$('snippet-folder-filter').addEventListener('change',renderSnippets);
initializeFileTools();
async function showUpdateResult() {
  const restartPending = await api.updateRestartPending();
  const deadline = Date.now() + (restartPending ? 70000 : 0);
  do {
    const result = await api.updateResult();
    if (result) {
      toast(result.ok ? '버전 ' + result.version + ' 업데이트가 완료되었습니다.' + (result.cleanupError ? ' 임시 파일 정리를 다시 시도합니다.' : '') : '업데이트 실패: ' + String(result.error || '다시 확인해 주세요.'), !result.ok);
      await api.acknowledgeUpdateResult(result.resultId);
      return;
    }
    if (!restartPending || Date.now() >= deadline) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
}
api.onEvent(handleEvent);api.windowState().then(applyWindowState).catch(showError);refreshData().then(()=>{
  if(state.testMode)window.sessionDockTest=Object.freeze({
    text:(id=state.active,tail=100)=>{const buffer=state.connections.get(id)?.terminal.buffer.active;if(!buffer)return '';const lines=[];for(let row=Math.max(0,buffer.length-tail);row<buffer.length;row++)lines.push(buffer.getLine(row)?.translateToString(true)||'');return lines.join('\n');},
    activeId:()=>state.active,metrics:()=>({...state.connections.get(state.active)?.outputMetrics}),options:()=>{const t=state.connections.get(state.active)?.terminal;return t?Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','scrollback','cursorStyle','cursorBlink','scrollOnUserInput','minimumContrastRatio'].map(key=>[key,t.options[key]])):null;},
    colors:()=>{const c=state.connections.get(state.active);if(!c)return null;const t=c.terminal,b=t.buffer.active,lines=[];for(let row=b.viewportY;row<Math.min(b.length,b.viewportY+t.rows);row++){const line=b.getLine(row),cells=[];for(let x=0;x<t.cols;x++){const cell=line.getCell(x);cells.push({chars:cell.getChars(),width:cell.getWidth(),fg:cell.getFgColor(),fgDefault:cell.isFgDefault(),bgDefault:cell.isBgDefault(),italic:!!cell.isItalic(),inverse:!!cell.isInverse()});}lines.push({row,text:line.translateToString(true),cells});}return{buffer:b.type,rows:t.rows,cols:t.cols,lines,decorations:c.semantic.snapshot(),theme:t.options.theme};},
    scroll:(amount)=>state.connections.get(state.active)?.terminal.scrollLines(amount),
    select:(column,row,length)=>state.connections.get(state.active)?.terminal.select(column,row,length),
    viewport:()=>{const t=state.connections.get(state.active)?.terminal,b=t?.buffer.active;return b?{top:b.viewportY,bottom:b.baseY,rows:t.rows}:null;},
    logging:(id=state.active)=>!!state.connections.get(id)?.logging,
    stream:(id=state.active)=>state.connections.get(id)?.stream?.snapshot()||null,
    semanticStats:(id=state.active)=>state.connections.get(id)?.semantic?.stats()||null,
    gutterStats:(id=state.active)=>{const g=state.connections.get(id)?.gutter;return g?{ranges:g.ranges.size,rows:g.rows.length,burst:g.burst,revision:g.revision}:null;},
    // Deterministic transport-free status injection for the timeout branch: a
    // real 10–30s handshake wait would make the UI suite unusably slow.
    simulateStatus:(id,status,extra={})=>{if(!state.connections.has(id))return false;handleEvent({type:'status',id,status,...extra});return true;}
  });
  switchView('sessions');document.body.dataset.ready='true';
  api.rendererReady().then(()=>showUpdateResult()).catch(()=>{});
  showSharedStartupNotice().catch(showError);
  queueUpdateNotice();
}).catch(showError);
