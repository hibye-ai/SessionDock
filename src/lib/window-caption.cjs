'use strict';

const WM_NCLBUTTONDBLCLK = 0x00a3;
const WM_SYSCOMMAND = 0x0112;
const SC_MAXIMIZE = 0xf030;
const SC_RESTORE = 0xf120;
const HTCAPTION = 2;
const installations = new WeakMap();

const sameBounds = (left, right) => left && right &&
  left.x === right.x && left.y === right.y &&
  left.width === right.width && left.height === right.height;
const readBounds = (window, method) => {
  try { return typeof method === 'function' ? { ...method.call(window) } : null; }
  catch { return null; }
};

// Keep Windows hit testing, dragging and snapping intact. Transparent frameless
// windows can receive caption double-clicks without the usual native toggle.
function installWindowCaption(window, { platform = process.platform } = {}) {
  if (platform !== 'win32' || window.isDestroyed()) return () => {};
  if (installations.has(window)) return installations.get(window);

  let disposed = false, pending = null, stateRevision = 0;
  const changed = () => { stateRevision++; };
  const requestState = target => {
    if (disposed || window.isDestroyed()) return;
    if (pending || !window.isMaximizable()) return;
    const maximized = window.isMaximized(), revision = stateRevision;
    const bounds = readBounds(window, window.getBounds);
    const normalBounds = readBounds(window, window.getNormalBounds);
    if (maximized === target) return;
    // Let DefWindowProc/Electron finish first; never undo a native state change.
    pending = setImmediate(() => {
      pending = null;
      if (disposed || window.isDestroyed() || !window.isMaximizable()) return;
      if (revision !== stateRevision || window.isMaximized() !== maximized) return;
      // Win+Arrow can Snap or move the window without changing its maximized
      // flag. In that case a caption fallback queued a moment earlier must not
      // replace the native geometry with an app maximize/restore.
      if (bounds && !sameBounds(bounds, readBounds(window, window.getBounds))) return;
      if (normalBounds && !sameBounds(normalBounds, readBounds(window, window.getNormalBounds))) return;
      if (target) window.maximize();
      else window.unmaximize();
    });
  };
  const onDoubleClick = wParam => {
    if (disposed || window.isDestroyed() || !Buffer.isBuffer(wParam) || wParam.length < 4 || wParam.readUInt32LE(0) !== HTCAPTION) return;
    requestState(!window.isMaximized());
  };
  const onSystemCommand = wParam => {
    if (!Buffer.isBuffer(wParam) || wParam.length < 4) return;
    // Chromium's drag region can consume NC double-clicks and forward only a
    // system command (e.g. SC_MAXIMIZE | HTCAPTION). Transparent windows ignore
    // the native maximize action, so observe the real command as well.
    const value = wParam.readUInt32LE(0), command = value & 0xfff0;
    // A transparent frameless HWND also reports MAXIMIZE|HTCAPTION while the
    // Electron window is already maximized. Caption intent is a toggle; an
    // explicit menu/keyboard MAXIMIZE without that hit-test remains idempotent.
    if (command === SC_MAXIMIZE) {
      if (disposed || window.isDestroyed()) return;
      requestState((value & 0xf) === HTCAPTION ? !window.isMaximized() : true);
    }
    else if (command === SC_RESTORE) requestState(false);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (pending) clearImmediate(pending);
    pending = null;
    window.removeListener('maximize', changed);
    window.removeListener('unmaximize', changed);
    window.removeListener('closed', dispose);
    // Electron removes native hooks with the HWND; calling into a destroyed
    // BrowserWindow here would throw during normal application shutdown.
    if (!window.isDestroyed()) {
      window.unhookWindowMessage(WM_NCLBUTTONDBLCLK);
      window.unhookWindowMessage(WM_SYSCOMMAND);
    }
    installations.delete(window);
  };
  window.hookWindowMessage(WM_NCLBUTTONDBLCLK, onDoubleClick);
  window.hookWindowMessage(WM_SYSCOMMAND, onSystemCommand);
  window.on('maximize', changed);
  window.on('unmaximize', changed);
  window.once('closed', dispose);
  installations.set(window, dispose);
  return dispose;
}

module.exports = { installWindowCaption };
