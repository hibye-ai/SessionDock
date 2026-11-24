'use strict';

// Electron reports display bounds, work areas, cursor coordinates and window
// bounds in DIP. Keep that coordinate space intact across mixed-DPI displays.
const PREFERRED_SIZE = Object.freeze({ width: 1440, height: 920 });
const USABLE_MINIMUM = Object.freeze({ width: 640, height: 360 });

function validRectangle(rectangle) {
  return rectangle && Number.isFinite(rectangle.x) && Number.isFinite(rectangle.y) &&
    Number.isFinite(rectangle.width) && Number.isFinite(rectangle.height) &&
    rectangle.width > 0 && rectangle.height > 0;
}

function displayWorkArea(display) {
  if (validRectangle(display?.workArea)) return display.workArea;
  if (validRectangle(display?.bounds)) return display.bounds;
  throw new Error('디스플레이 작업영역을 확인할 수 없습니다.');
}

// The platform applies minWidth/minHeight to snapped and manually resized
// windows alike. A fixed 980x650 floor made a half-screen Snap impossible on
// common 1920-wide and 1366-wide displays. Keep a usable floor when it fits,
// but never let it exceed half of the active work area.
function minimumSizeForWorkArea(workArea) {
  if (!validRectangle(workArea)) throw new Error('디스플레이 작업영역을 확인할 수 없습니다.');
  return {
    width: Math.min(USABLE_MINIMUM.width, Math.max(1, Math.floor(workArea.width / 2))),
    height: Math.min(USABLE_MINIMUM.height, Math.max(1, Math.floor(workArea.height / 2)))
  };
}

function geometryForDisplay(display) {
  const workArea = displayWorkArea(display);
  const minimum = minimumSizeForWorkArea(workArea);
  const width = Math.min(PREFERRED_SIZE.width, workArea.width);
  const height = Math.min(PREFERRED_SIZE.height, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
    minWidth: minimum.width,
    minHeight: minimum.height
  };
}

function displayAtCursor(screen) {
  try {
    const point = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(point);
  } catch {
    return screen.getPrimaryDisplay();
  }
}

function displayForWindow(window, screen) {
  try {
    return screen.getDisplayMatching(window.getBounds());
  } catch {
    return displayAtCursor(screen);
  }
}

function installWindowGeometry(window, screen) {
  let disposed = false, lastMinimum = null;
  const sameSize = (left, right) => left && right && left.width === right.width && left.height === right.height;
  const sync = () => {
    if (disposed || window.isDestroyed()) return;
    try {
      const minimum = minimumSizeForWorkArea(displayWorkArea(displayForWindow(window, screen)));
      // `moved` and the display metrics events can arrive together. Reapplying a
      // native minimum is unnecessary and can disturb a Windows Snap transition.
      if (sameSize(lastMinimum, minimum)) return;
      window.setMinimumSize(minimum.width, minimum.height);
      lastMinimum = minimum;
    } catch (error) {
      // A display can disappear while its metrics event is being delivered. The
      // next event will retry; window creation must not be undone by that race.
      console.warn('Failed to update window minimum size:', error);
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // Remove only our subscription. A screen object is shared by other window
    // services, so removeAllListeners would silently disable their display updates.
    if (typeof screen.removeListener === 'function') {
      screen.removeListener('display-added', sync);
      screen.removeListener('display-removed', sync);
      screen.removeListener('display-metrics-changed', sync);
    } else if (typeof screen.off === 'function') {
      screen.off('display-added', sync);
      screen.off('display-removed', sync);
      screen.off('display-metrics-changed', sync);
    }
    window.removeListener('moved', sync);
    window.removeListener('closed', dispose);
  };
  screen.on('display-added', sync);
  screen.on('display-removed', sync);
  screen.on('display-metrics-changed', sync);
  // Electron reports this window's bounds in DIP, and a Snap or drag can put it
  // on a display with an entirely different work-area floor.
  window.on('moved', sync);
  window.once('closed', dispose);
  return dispose;
}

module.exports = {
  PREFERRED_SIZE,
  USABLE_MINIMUM,
  displayAtCursor,
  geometryForDisplay,
  installWindowGeometry,
  minimumSizeForWorkArea
};
