'use strict';

const { normalizeKeymap, createKeymapResolver, keyCombinationFromEvent, isReservedKeyEvent } = require('./terminal-keymap.cjs');

/**
 * Limited identity/PC-keyboard compatibility on top of xterm's renderer.
 * `type` is a renderer policy, NOT the SSH PTY TERM / Telnet TTYPE sent by the
 * transport. This module never changes either field or terminal.options.
 * Unknown renderer types are rejected; arbitrary server TERM names should be
 * configured independently and use type:'xterm' unless explicitly supported.
 *
 * installTerminalCompatibility(terminal, type, send, options?) returns:
 *   handleKeyEvent(event) -> true: continue existing listener/xterm processing;
 *                            false: consumed (send at most once, keydown only).
 *   update({type?, sessionKeymap?, globalKeymap?, protocol?, ctrlArrowMode?}) -> atomic settings change.
 *   dispose() -> remove all parser hooks, release mapping text; idempotent.
 * options: {sessionKeymap:null, globalKeymap:[], protocol?, ctrlArrowMode:word|native, onError?}.
 * Explicit SSH protocol enables word mode by default; unscoped/Telnet stay native.
 * Only Ctrl+Left/Right in normal/non-application/non-mouse mode use ESC b/f.
 * Remote readline bindings vary; native is the per-session compatibility escape hatch.
 * send receives a Unicode string, without CRLF/bracketed-paste/byte conversion.
 * Use the same connected-session input callback as terminal.onData, including
 * the app's Backspace policy and transport encoding. Promise rejections and
 * throws are reported via onError without forwarding potentially secret text.
 *
 * The coordinator must call handleKeyEvent at the end of its EXISTING
 * attachCustomKeyEventHandler callback, after app shortcuts, and return the
 * result. We do not attach/replace that listener or an onData listener. Dispose
 * before the terminal; dispose/reinstall on replacement, update on preferences.
 * Repeats of mapped/profile keys are consumed without sending; ordinary xterm
 * key repeat is untouched; word navigation repeats. IME/dead/AltGraph/key-up pass through.
 *
 * Scope: VT100 PF1-4 + cursor keys (unsupported PC editing/F5-20 keys consumed),
 * PC VT220 PF1-4 + F5-20/editing keys, Linux console PC keys, and an explicitly
 * chosen SCO-style ANSI PC keyboard. Modified keys not defined by those tables
 * pass through to xterm; explicit user mappings can override them. All xterm
 * standard application modes remain native unless explicitly mapped.
 * No VT52, 8-bit C1, hardware UDK/printer/ReGIS/Sixel or full DEC/SecureCRT parity.
 * DA2 version 0 is an emulator placeholder, not a DEC firmware version claim.
 *
 * Primary references (sequence fixtures in tests are literal independent data):
 * https://xtermjs.org/docs/api/terminal/interfaces/iparser/
 * https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
 * https://man7.org/linux/man-pages/man4/console_codes.4.html
 * https://github.com/ThomasDickey/ncurses-snapshots/blob/master/misc/terminfo.src
 * (vt100, vt220+pcedit, linux+lockeys, scoansi-old). ANSI is not a universal
 * keyboard standard: this chosen variant is explicit, rather than guessed.
 */

const ESC = '\x1b';
const FUNCTION_CODES = [null, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24, 25, 26, 28, 29, 31, 32, 33, 34];
const CURSORS = Object.freeze({ ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' });
const EDITING = Object.freeze({ Home: 1, Insert: 2, Delete: 3, End: 4, PageUp: 5, PageDown: 6 });
const ANSI_EDITING = Object.freeze({ Home: 'H', End: 'F', Insert: 'L', PageUp: 'I', PageDown: 'G' });
const PROFILES = Object.freeze({
  xterm: Object.freeze({ type: 'xterm', keyboard: 'native xterm', primaryDA: null, secondaryDA: null }),
  vt100: Object.freeze({ type: 'vt100', keyboard: 'VT100 PF/cursor subset', primaryDA: `${ESC}[?1;2c`, secondaryDA: '' }),
  // xterm supports selective erase; do not advertise 132 columns, UDK or graphics.
  vt220: Object.freeze({ type: 'vt220', keyboard: 'PC VT220', primaryDA: `${ESC}[?62;6c`, secondaryDA: `${ESC}[>1;0;0c` }),
  ansi: Object.freeze({ type: 'ansi', keyboard: 'PC ANSI (SCO-style)', primaryDA: '', secondaryDA: '' }),
  linux: Object.freeze({ type: 'linux', keyboard: 'Linux console PC', primaryDA: `${ESC}[?6c`, secondaryDA: '' })
});
const installed = new WeakMap();

function invalid(reason) {
  const error = new TypeError(`Invalid terminal compatibility: ${reason}.`);
  error.code = 'ERR_VALIDATION';
  throw error;
}

function getCompatibilityProfile(type = 'xterm') {
  if (typeof type !== 'string' || type.length > 64) invalid('unsupported renderer type');
  let normalized = type.trim().toLowerCase();
  if (['xterm-256color', 'xterm-color'].includes(normalized)) normalized = 'xterm';
  if (!Object.hasOwn(PROFILES, normalized)) invalid('unsupported renderer type');
  return PROFILES[normalized];
}

/**
 * Pure reference translation; null means delegate, '' means consume silently.
 * Installer intentionally never uses this table for type xterm: its parser's
 * live keyboard modes/extensions are more complete than a static table.
 * modes is the public terminal.modes object (not a snapshot taken at install).
 */
function translateTerminalKey(event, type = 'xterm', modes = {}) {
  const profile = getCompatibilityProfile(type), combination = keyCombinationFromEvent(event);
  if (combination === null || isReservedKeyEvent(event) || event.repeat) return null;
  const key = combination.split('+').pop();
  if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null;
  const application = modes.applicationCursorKeysMode === true;
  if (Object.hasOwn(CURSORS, key)) return `${ESC}${profile.type !== 'ansi' && application ? 'O' : '['}${CURSORS[key]}`;
  if (/^F(?:[1-9]|1[0-9]|20)$/.test(key)) {
    const number = Number(key.slice(1));
    if (profile.type === 'vt100') return number <= 4 ? `${ESC}O${'PQRS'[number - 1]}` : '';
    if (profile.type === 'ansi') return `${ESC}[${'MNOPQRSTUVWXYZabcdef'[number - 1]}`;
    if (profile.type === 'linux' && number <= 5) return `${ESC}[[${'ABCDE'[number - 1]}`;
    if (number <= 4) return `${ESC}O${'PQRS'[number - 1]}`;
    return `${ESC}[${FUNCTION_CODES[number]}~`;
  }
  if (Object.hasOwn(EDITING, key)) {
    if (profile.type === 'vt100') return '';
    if (profile.type === 'ansi') return key === 'Delete' ? '\x7f' : `${ESC}[${ANSI_EDITING[key]}`;
    if (profile.type === 'xterm' && ['Home', 'End'].includes(key)) return `${ESC}${application ? 'O' : '['}${key === 'Home' ? 'H' : 'F'}`;
    return `${ESC}[${EDITING[key]}~`;
  }
  return null;
}

function installTerminalCompatibility(terminal, type = 'xterm', send, options = {}) {
  if (!terminal || !terminal.parser || typeof terminal.parser.registerCsiHandler !== 'function' ||
      typeof terminal.parser.registerEscHandler !== 'function') invalid('public xterm parser API required');
  if (typeof send !== 'function') invalid('send callback required');
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('options object required');
  if (options.onError !== undefined && typeof options.onError !== 'function') invalid('onError must be a function');
  if (installed.has(terminal)) invalid('already installed on this terminal');
  let profile = getCompatibilityProfile(type);
  let sessionKeymap = options.sessionKeymap ?? null, globalKeymap = options.globalKeymap ?? [];
  // Keep normalized snapshots in state, never caller-owned arrays.
  sessionKeymap = normalizeKeymap(sessionKeymap);
  globalKeymap = normalizeKeymap(globalKeymap);
  const validateWordPolicy = (protocol, mode) => {
    if (protocol !== undefined && !['ssh', 'telnet'].includes(protocol)) invalid('unsupported protocol');
    if (!['word', 'native'].includes(mode)) invalid('unsupported Ctrl arrow mode');
  };
  let protocol = options.protocol, ctrlArrowMode = options.ctrlArrowMode ?? 'word';
  validateWordPolicy(protocol, ctrlArrowMode);
  let explicitKeys = new Set([...globalKeymap, ...sessionKeymap].map(row => row.key));
  let resolver = createKeymapResolver(sessionKeymap, globalKeymap), disposed = false;
  let errorHandler = options.onError, sender = send;
  const hooks = [];

  function reportSendError() {
    if (disposed || !errorHandler) return;
    const error = new Error('Terminal input could not be sent.');
    error.code = 'ERR_TERMINAL_SEND';
    try { errorHandler(error); } catch { /* A reporter must not break the parser. */ }
  }

  function transmit(text) {
    if (!text || disposed) return;
    try {
      const result = sender(text);
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(reportSendError);
    } catch { reportSendError(); }
  }

  function identity(params, secondary = false) {
    if (disposed || profile.type === 'xterm') return false;
    // Only an omitted/zero single parameter is a query. Never answer an echoed
    // response, malformed subparameters or arbitrary parameter lists.
    if (params.length === 0 || (params.length === 1 && params[0] === 0)) transmit(secondary ? profile.secondaryDA : profile.primaryDA);
    return true;
  }

  const controller = Object.freeze({
    hasKeyMapping(event) { return !disposed && resolver.matches(event); },
    handleKeyEvent(event) {
      if (disposed || keyCombinationFromEvent(event) === null || isReservedKeyEvent(event)) return true;
      let text;
      const combination = keyCombinationFromEvent(event), modes = terminal.modes;
      // Explicit rows (including disabled rows restoring native handling) win.
      // No stream rewriting: only this exact SSH keydown in a normal screen.
      const wordArrow = protocol === 'ssh' && ctrlArrowMode === 'word' &&
        !explicitKeys.has(combination) && ['Ctrl+ArrowLeft', 'Ctrl+ArrowRight'].includes(combination) &&
        terminal.buffer.active.type === 'normal' && !modes.applicationCursorKeysMode &&
        !modes.applicationKeypadMode && modes.mouseTrackingMode === 'none';
      const suppressShiftNavigation = protocol === 'ssh' && !explicitKeys.has(combination) &&
        ['Shift+Home', 'Shift+End'].includes(combination) &&
        terminal.buffer.active.type === 'normal' && !modes.applicationCursorKeysMode &&
        !modes.applicationKeypadMode && modes.mouseTrackingMode === 'none';
      if (suppressShiftNavigation) {
        // Normal SSH command lines need neither modified CSI nor a local action.
        // Consume holds too; explicit mappings and application modes stay native.
        text = '';
      } else if (wordArrow) {
        // Unlike send-text macros, navigation intentionally repeats on hold.
        text = combination === 'Ctrl+ArrowLeft' ? `${ESC}b` : `${ESC}f`;
      } else if (event.repeat) {
        // Only consume repeats belonging to this controller. Do not disable
        // native character/keypad/navigation repeat on an xterm session.
        if (!resolver.matches(event) && (profile.type === 'xterm' ||
            translateTerminalKey({ type: 'keydown', code: event.code, key: event.key,
              ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey }, profile.type, terminal.modes) === null)) return true;
        text = '';
      } else {
        text = resolver.resolve(event);
        if (text === null && profile.type !== 'xterm') text = translateTerminalKey(event, profile.type, terminal.modes);
        if (text === null) return true;
      }
      if (typeof event.preventDefault === 'function') event.preventDefault();
      // Do not stop propagation: the app owns its shortcuts and focus logic.
      transmit(text);
      return false;
    },
    update(changes = {}) {
      if (disposed) invalid('controller is disposed');
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
          Object.keys(changes).some(key => !['type', 'sessionKeymap', 'globalKeymap', 'protocol', 'ctrlArrowMode'].includes(key))) invalid('unsupported update');
      const nextProfile = Object.hasOwn(changes, 'type') ? getCompatibilityProfile(changes.type) : profile;
      const nextSession = Object.hasOwn(changes, 'sessionKeymap') ? normalizeKeymap(changes.sessionKeymap) : sessionKeymap;
      const nextGlobal = Object.hasOwn(changes, 'globalKeymap') ? normalizeKeymap(changes.globalKeymap) : globalKeymap;
      const nextProtocol = Object.hasOwn(changes, 'protocol') ? changes.protocol : protocol;
      const nextMode = Object.hasOwn(changes, 'ctrlArrowMode') ? changes.ctrlArrowMode ?? 'word' : ctrlArrowMode;
      validateWordPolicy(nextProtocol, nextMode);
      const nextResolver = createKeymapResolver(nextSession, nextGlobal);
      profile = nextProfile; sessionKeymap = nextSession; globalKeymap = nextGlobal; resolver = nextResolver;
      protocol = nextProtocol; ctrlArrowMode = nextMode;
      explicitKeys = new Set([...nextGlobal, ...nextSession].map(row => row.key));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      installed.delete(terminal);
      sessionKeymap = globalKeymap = resolver = sender = errorHandler = explicitKeys = null;
      // Try every disposer even if an already-destroyed terminal rejects one.
      for (const hook of hooks.splice(0).reverse()) { try { hook.dispose(); } catch { /* Best effort after terminal disposal. */ } }
    }
  });

  try {
    hooks.push(terminal.parser.registerCsiHandler({ final: 'c' }, params => identity(params)));
    hooks.push(terminal.parser.registerCsiHandler({ prefix: '>', final: 'c' }, params => identity(params, true)));
    hooks.push(terminal.parser.registerEscHandler({ final: 'Z' }, () => identity([])));
  } catch {
    controller.dispose();
    invalid('parser hook registration failed');
  }
  installed.set(terminal, controller);
  return controller;
}

module.exports = { getCompatibilityProfile, translateTerminalKey, installTerminalCompatibility };
