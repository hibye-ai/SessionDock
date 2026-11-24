const installedPickers = new WeakMap();
const ROW_HEIGHT = 30;
let nextPickerId = 0;

/** getFamilies returns the parent's current array (including its loading fallback). */
export function installFontPicker(input, { getFamilies }) {
  if (installedPickers.has(input)) return installedPickers.get(input);

  const doc = input.ownerDocument;
  const win = doc.defaultView;
  const id = `font-picker-${++nextPickerId}`;
  // Keep text added by the button/live status out of a wrapping label's name.
  if (!input.hasAttribute('aria-label') && !input.hasAttribute('aria-labelledby')) {
    const label = [...(input.labels || [])].map(node => node.textContent.trim()).join(' ');
    if (label) input.setAttribute('aria-label', label);
  }
  const wrapper = doc.createElement('span');
  wrapper.className = 'font-picker';
  // Geometry must also work while the optional stylesheet is unavailable or
  // still loading (the app serves assets through an explicit protocol allowlist).
  Object.assign(wrapper.style, { display: 'flex', position: 'relative', minWidth: '0', width: '100%', alignItems: 'stretch' });
  input.before(wrapper);
  wrapper.append(input);
  input.classList.add('font-picker-input');
  Object.assign(input.style, { flex: '1 1 0', width: '0', minWidth: '0' });
  input.removeAttribute('list');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  input.setAttribute('autocomplete', 'off');

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'font-picker-button';
  Object.assign(button.style, { flex: '0 0 30px', padding: '0', margin: '0' });
  button.tabIndex = -1; // The editable combobox provides the keyboard entry point.
  button.textContent = '▾';
  button.setAttribute('aria-label', '글꼴 목록 열기');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
  wrapper.append(button);

  const status = doc.createElement('span');
  status.className = 'font-picker-status';
  Object.assign(status.style, { position: 'absolute', width: '1px', height: '1px', padding: '0', margin: '-1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: '0' });
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  wrapper.append(status);

  const list = doc.createElement('div');
  list.id = id;
  list.className = 'font-picker-popup';
  Object.assign(list.style, {
    position: 'fixed', zIndex: '10000', boxSizing: 'border-box', margin: '0', padding: '0',
    overflowX: 'hidden', overflowY: 'auto', overscrollBehavior: 'contain', overflowAnchor: 'none',
    scrollBehavior: 'auto', scrollbarGutter: 'stable', border: '1px solid var(--control-line, #46494d)',
    background: 'var(--panel2, #2a2c2f)', color: 'var(--text, #e4e5e7)',
  });
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '글꼴 목록');
  list.hidden = true;

  let opened = false;
  let composing = false;
  let query = '';
  let families = [];
  let active = -1;
  let openEvents;
  let ancestorObserver;
  let sizeObserver;
  const fold = value => value.trim().toLocaleLowerCase();
  const unavailable = () => input.matches(':disabled') || input.readOnly;

  function close() {
    if (!opened) return;
    opened = false;
    active = -1;
    openEvents.abort();
    ancestorObserver.disconnect();
    sizeObserver.disconnect();
    list.hidden = true;
    list.remove();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', '글꼴 목록 열기');
    status.textContent = '';
  }

  function anchorVisible() {
    if (!input.isConnected || unavailable() || !input.getClientRects().length) return false;
    for (let node = input; node; node = node.parentElement) {
      if (node.hidden || node.inert || (node.tagName === 'DIALOG' && !node.open)) return false;
      const style = win.getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible') return false;
    }
    return true;
  }

  function position() {
    if (!anchorVisible()) { close(); return false; }
    const rect = wrapper.getBoundingClientRect();
    const viewport = win.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 8;
    const top = (viewport?.offsetTop || 0) + 8;
    const right = left + (viewport?.width || doc.documentElement.clientWidth) - 16;
    const bottom = top + (viewport?.height || win.innerHeight) - 16;
    const below = Math.max(0, bottom - rect.bottom - 4);
    const above = Math.max(0, rect.top - top - 4);
    const useAbove = below < Math.min(240, above);
    const height = Math.min(300, useAbove ? above : below);
    if (height < ROW_HEIGHT || rect.bottom < top || rect.top > bottom) { close(); return false; }
    const width = Math.min(Math.max(180, rect.width), right - left);
    Object.assign(list.style, {
      width: `${Math.max(0, width)}px`,
      left: `${Math.max(left, Math.min(rect.left, right - width))}px`,
      maxHeight: `${height}px`,
      top: useAbove ? 'auto' : `${rect.bottom + 4}px`,
      bottom: useAbove ? `${win.innerHeight - rect.top + 4}px` : 'auto',
    });
    return true;
  }

  function render() {
    const fragment = doc.createDocumentFragment();
    // Window long font collections rather than truncating: every name remains
    // reachable with the native scrollbar/wheel, with at most 1000 option nodes.
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - 8);
    const count = Math.min(1000, Math.ceil((list.clientHeight || 300) / ROW_HEIGHT) + 16);
    const end = Math.min(families.length, start + count);
    const spacer = height => {
      const node = doc.createElement('div');
      node.className = 'font-picker-spacer';
      node.setAttribute('aria-hidden', 'true');
      Object.assign(node.style, { margin: '0', padding: '0', border: '0' });
      node.style.height = `${height}px`;
      fragment.append(node);
    };
    spacer(start * ROW_HEIGHT);
    if (active < start || active >= end) active = -1;
    for (let index = start; index < end; index++) {
      const option = doc.createElement('div');
      option.className = 'font-picker-option';
      Object.assign(option.style, { boxSizing: 'border-box', height: `${ROW_HEIGHT}px`, minHeight: `${ROW_HEIGHT}px`, margin: '0', padding: '0 10px', border: '0', lineHeight: `${ROW_HEIGHT}px`, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
      option.id = `${id}-option-${index}`;
      option.dataset.index = String(index);
      option.dataset.active = String(index === active);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(fold(families[index]) === fold(input.value)));
      option.setAttribute('aria-posinset', String(index + 1));
      option.setAttribute('aria-setsize', String(families.length));
      option.textContent = families[index];
      option.title = families[index];
      fragment.append(option);
    }
    spacer((families.length - end) * ROW_HEIGHT);
    if (!families.length) {
      const empty = doc.createElement('div');
      empty.className = 'font-picker-empty';
      empty.textContent = '일치하는 글꼴이 없습니다. 이름을 직접 입력하세요.';
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-option-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function revealActive() {
    if (active < 0) return;
    const top = active * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
    }
  }

  function refresh() {
    button.disabled = unavailable();
    if (!opened) return;
    const previous = families[active];
    const values = getFamilies();
    families = [...new Set((Array.isArray(values) ? values : [])
      .filter(name => typeof name === 'string' && name.trim()))]
      .filter(name => fold(name).includes(fold(query)));
    let nextActive = families.findIndex(name => name === previous);
    if (nextActive < 0) nextActive = families.findIndex(name => fold(name) === fold(input.value));
    active = nextActive;
    list.scrollTop = 0;
    if (!position()) return;
    render();
    // The initial render establishes the full scroll range before revealing it.
    active = nextActive;
    revealActive();
    render();
    status.textContent = families.length ? `글꼴 ${families.length}개. 방향키로 이동하고 Enter로 선택하세요.` : '일치하는 글꼴이 없습니다. 이름을 직접 입력하세요.';
  }

  function open(filter = '') {
    if (!anchorVisible()) return;
    query = filter;
    if (!opened) {
      opened = true;
      (input.closest('dialog') || doc.body).append(list);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-label', '글꼴 목록 닫기');
      openEvents = new win.AbortController();
      const options = { capture: true, signal: openEvents.signal };
      doc.addEventListener('pointerdown', event => {
        if (!wrapper.contains(event.target) && !list.contains(event.target)) close();
      }, options);
      doc.addEventListener('focusin', event => {
        if (!wrapper.contains(event.target) && !list.contains(event.target)) close();
      }, options);
      doc.addEventListener('scroll', event => {
        if (event.target !== list && (event.target === doc || event.target.contains?.(input))) close();
      }, options);
      doc.addEventListener('visibilitychange', close, options);
      win.addEventListener('resize', close, options);
      win.addEventListener('blur', event => { if (event.target === win) close(); }, options);
      win.addEventListener('pagehide', close, options);
      win.addEventListener('popstate', close, options);
      win.addEventListener('hashchange', close, options);
      win.visualViewport?.addEventListener('resize', close, options);
      win.visualViewport?.addEventListener('scroll', close, options);
      const dialog = input.closest('dialog');
      dialog?.addEventListener('close', close, options);
      // Fallback for a platform-generated cancel; keyboard Escape is consumed below.
      dialog?.addEventListener('cancel', event => { event.preventDefault(); close(); }, options);
      input.form?.addEventListener('submit', close, options);
      input.form?.addEventListener('reset', close, options);
      ancestorObserver = new win.MutationObserver(() => {
        // Status messages, theme changes and unrelated sibling updates are not
        // dismissal. A page switch/removal still fails anchorVisible().
        if (!anchorVisible()) close();
        else position();
      });
      for (let node = wrapper.parentElement; node; node = node.parentElement) {
        ancestorObserver.observe(node, { attributes: true, childList: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'inert'] });
      }
      const sizes = new Map();
      sizeObserver = new win.ResizeObserver(entries => {
        const changed = entries.some(entry => {
          const rect = entry.target.getBoundingClientRect();
          const initial = sizes.get(entry.target);
          sizes.set(entry.target, rect);
          return Math.abs(rect.width - initial.width) > 1 || Math.abs(rect.height - initial.height) > 1;
        });
        // Reposition after genuine layout changes without interrupting a wheel
        // gesture or a late installed-font/status refresh. Window resize closes.
        if (changed) position();
      });
      for (let node = wrapper; node; node = node.parentElement) {
        sizes.set(node, node.getBoundingClientRect());
        sizeObserver.observe(node);
      }
    }
    refresh();
  }

  function choose(index) {
    const value = families[index];
    if (value === undefined || composing || unavailable()) return;
    input.value = value;
    close();
    input.focus({ preventScroll: true });
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', event => {
    event.preventDefault(); // Avoid implicit activation of a wrapping label.
    if (unavailable()) return;
    input.focus({ preventScroll: true });
    if (opened) close(); else open();
  });
  list.addEventListener('mousedown', event => {
    if (event.target.closest('[role="option"]')) event.preventDefault();
  });
  list.addEventListener('click', event => {
    const option = event.target.closest('[role="option"]');
    if (option && list.contains(option)) choose(Number(option.dataset.index));
  });
  list.addEventListener('scroll', render, { passive: true });
  // No wheel listener: native wheel scrolling and overscroll containment apply.
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    if (doc.activeElement === input) open(input.value);
  });
  input.addEventListener('input', event => {
    if (!composing && !event.isComposing && doc.activeElement === input && event.isTrusted) open(input.value);
  });
  input.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape' && opened) {
      event.preventDefault(); event.stopPropagation(); close(); return;
    }
    if (event.key === 'Enter' && opened) {
      event.preventDefault(); event.stopPropagation();
      if (active >= 0) choose(active); else close();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (!arrow && !(opened && ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key))) return;
    event.preventDefault(); event.stopPropagation();
    const wasOpen = opened;
    if (!opened) open();
    if (!opened || !families.length) return;
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT) - 1);
    if (event.key === 'Home') active = 0;
    else if (event.key === 'End') active = families.length - 1;
    else if (active < 0) active = event.key === 'ArrowUp' || event.key === 'PageUp' ? families.length - 1 : 0;
    else if (wasOpen) active = Math.max(0, Math.min(families.length - 1, active +
      ({ ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[event.key] || 0)));
    revealActive();
    render();
  }, true);

  const stateObserver = new win.MutationObserver(() => { button.disabled = unavailable(); if (button.disabled) close(); });
  stateObserver.observe(input, { attributes: true, attributeFilter: ['disabled', 'readonly'] });
  button.disabled = unavailable();
  const controller = { refresh, close };
  installedPickers.set(input, controller);
  return controller;
}
