/**
 * Visible-pane GPU ownership only. No terminal buffer, parser, input, transport,
 * timestamp capture, timers or animation frames are touched here.
 *
 * createTerminalResourceManager({
 *   createRenderer(record, { onContextLoss }) -> addon,
 *   disposeRenderer(addon, record)? -> void | Promise<void>,
 *   isPaneVisible(record)? -> boolean,
 *   onVisibilityChange(record, visible)?,
 *   resourcePolicy(record)? -> boolean, // false selects DOM, even when visible
 *   retainHidden(record)? -> boolean,   // keep a hidden renderer instead of disposing it
 *   maxRenderers? -> number,            // upper bound on live renderers (default 8)
 *   onError(sanitizedError)?
 * })
 *
 * Hidden panes are released by default. `retainHidden` opts into keeping the
 * renderer of a hidden pane while that terminal is alive, which is what stops a
 * tab switch from destroying and recreating a GPU context every time. Retained
 * renderers still get `onVisibilityChange(false)`, so visual addon work stops;
 * only the context stays allocated. `maxRenderers` bounds the total number of
 * live renderers: past it, the least recently visible hidden renderer is
 * released first, and a visible renderer is never evicted. Context loss always
 * retires a retained renderer.
 *
 * The synchronous factory creates/loads the addon and wires its loss event to
 * the supplied callback. It must clean up its own partial allocation if it
 * throws before returning. Do not install an additional loss callback which
 * disposes addons or writes record.webgl: this manager owns those operations.
 * Default disposal is addon.dispose(); a custom disposer must release the GPU
 * context as well. If disposal returns a Promise, further allocations wait for
 * it, and rejection is handled without an unhandled rejection or retry loop.
 *
 * syncVisible(records) / sync(records): reconcile a complete iterable of live
 * record objects (e.g. connections.values()), after toggling pane.hidden.
 * Hidden/missing panes release GPU resources before any new visible allocation.
 * Visible owned addons are retained. Same record object = same terminal; IDs
 * may be reused without allowing old callbacks to affect a replacement.
 * release(record): permanently retire that record, before terminal.dispose().
 * close() / dispose(): permanently close the manager. All methods are idempotent.
 * These methods act synchronously and return a resolving Promise to await any
 * custom async disposers. whenIdle() also provides that optional barrier.
 *
 * Context loss and factory failure select DOM until a later observed visibility
 * transition; repeated sync/layout does not recreate a failed visible context.
 * A lost renderer is retired BEFORE disposal, so synchronous loss reentry and
 * already-queued old callbacks cannot dispose or clear a newer renderer.
 *
 * Default visibility: !record.closing && !pane.classList.contains('hidden').
 * Default notification: semantic.setVisible(visible), gutter.setVisible(visible).
 * Only visual work is paused: those APIs must keep hidden timestamp capture and
 * terminal onData/onWriteParsed subscriptions alive. Optional notification
 * replaces the default; call both addons there if adding other visual work.
 */

function invalid(message) {
  const error = new TypeError(`Invalid terminal resource manager: ${message}.`);
  error.code = 'ERR_VALIDATION';
  throw error;
}

function defaultVisible(record) {
  return !record.closing && !!record.pane?.classList && !record.pane.classList.contains('hidden');
}

export class TerminalResourceManager {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || typeof options.createRenderer !== 'function') invalid('createRenderer callback required');
    for (const name of ['disposeRenderer', 'isPaneVisible', 'onVisibilityChange', 'resourcePolicy', 'retainHidden', 'onError']) {
      if (options[name] !== undefined && typeof options[name] !== 'function') invalid('optional callbacks must be functions');
    }
    const limit = options.maxRenderers;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) invalid('maxRenderers must be a positive integer');
    this._create = options.createRenderer;
    this._disposeRenderer = options.disposeRenderer || (renderer => renderer.dispose());
    this._visible = options.isPaneVisible || defaultVisible;
    this._notify = options.onVisibilityChange;
    this._policy = options.resourcePolicy || (() => true);
    this._retain = options.retainHidden || (() => false);
    this._limit = limit ?? 8;
    this._onError = options.onError;
    this._states = new Map();
    this._released = new WeakSet();
    this._targets = new Set();
    this._pending = new Set();
    this._disposing = 0;
    this._syncing = false;
    this._again = false;
    this._closed = false;
    this._clock = 0;
  }

  syncVisible(records = []) {
    if (this._closed) return this.whenIdle();
    if (!records || typeof records[Symbol.iterator] !== 'function') invalid('complete record iterable required');
    const targets = new Set();
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) invalid('records must be objects');
      if (!this._released.has(record)) targets.add(record);
    }
    this._targets = targets;
    this._reconcile();
    return this.whenIdle();
  }

  sync(records) { return this.syncVisible(records); }

  release(record) {
    if (record && typeof record === 'object') {
      this._released.add(record);
      this._targets.delete(record);
      const state = this._states.get(record);
      if (state) this._forget(state);
      this._reconcile();
    }
    return this.whenIdle();
  }

  close() {
    if (!this._closed) {
      this._closed = true;
      this._targets.clear();
      for (const state of [...this._states.values()]) this._forget(state);
    }
    return this.whenIdle();
  }

  dispose() { return this.close(); }

  async whenIdle() {
    while (this._pending.size) await Promise.all([...this._pending]);
  }

  _report(operation) {
    if (!this._onError) return;
    // No original exception/record is forwarded; either can contain session
    // metadata. A faulty asynchronous error observer must not reject unhandled.
    const error = new Error(`Terminal renderer ${operation} failed.`);
    error.code = 'ERR_TERMINAL_RESOURCE';
    try {
      const result = this._onError(error);
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch { /* Error reporting must not interrupt cleanup of other terminals. */ }
  }

  _isVisible(record) {
    try { return !record.closing && !!this._visible(record); }
    catch { this._report('visibility check'); return false; }
  }

  _allowed(record) {
    try { return this._policy(record) !== false; }
    catch { this._report('resource policy'); return false; }
  }

  // Retention applies only to a live, hidden terminal. A closing record always
  // releases, so a disposed terminal can never keep a GPU context alive.
  _isRetained(record) {
    if (record.closing) return false;
    try { return this._retain(record) === true; }
    catch { this._report('retention policy'); return false; }
  }

  // Bound total live renderers. Hidden retained renderers are evicted oldest
  // first; a wanted (visible) renderer is never evicted, even when that leaves
  // the bound exceeded, because dropping it would break the pane the user sees.
  // Wanted states that have not allocated yet reserve a slot here, so the bound
  // holds after allocation instead of being exceeded for one frame.
  _enforceLimit(states) {
    const live = states.filter(state => this._isCurrent(state) && state.token?.renderer);
    const pending = states.filter(state => this._isCurrent(state) && state.wanted && !state.token?.renderer).length;
    let excess = live.length + pending - this._limit;
    if (excess <= 0) return;
    const evictable = live
      .filter(state => !state.wanted && !state.token.retired && !state.token.disposalStarted)
      .sort((first, second) => (first.seen ?? 0) - (second.seen ?? 0));
    for (const state of evictable) {
      if (excess <= 0) break;
      state.keep = false;
      this._retire(state.token);
      excess--;
    }
  }

  _notifyVisible(state, visible) {
    if (state.visible === visible) return;
    state.visible = visible;
    state.blocked = false;
    const record = state.record;
    if (this._notify) {
      try { this._notify(record, visible); } catch { this._report('visibility notification'); }
    } else {
      for (const addon of [record.semantic, record.gutter]) {
        try { addon?.setVisible?.(visible); } catch { this._report('visual suspension'); }
      }
    }
  }

  _isCurrent(state) {
    return !this._closed && this._states.get(state.record) === state && this._targets.has(state.record);
  }

  _reconcile() {
    if (this._closed) return;
    if (this._syncing) { this._again = true; return; }
    this._syncing = true;
    try {
      do {
        this._again = false;
        for (const state of [...this._states.values()]) {
          if (!this._targets.has(state.record)) this._forget(state);
        }
        for (const record of this._targets) {
          if (!this._states.has(record)) {
            const state = { record, visible: undefined, wanted: false, blocked: false, token: null };
            this._states.set(record, state);
            this._notifyVisible(state, this._isVisible(record));
            if (!this._isCurrent(state)) continue;
            // A pre-existing addon can be adopted during migration if the
            // caller has removed its old field-mutating loss listener.
            if (record.webgl) this._adopt(state, record.webgl);
            else { record.webgl = null; this._setRendererLabel(record, 'dom'); }
          }
        }
        const states = [...this._states.values()];
        for (const state of states) {
          if (!this._isCurrent(state)) continue;
          this._notifyVisible(state, this._isVisible(state.record));
          const visible = this._isCurrent(state) && state.visible;
          state.wanted = visible && this._allowed(state.record);
          // A retained hidden renderer is not wanted for painting but must not be
          // retired; retire() below only acts on states whose want is false AND
          // which are not retained, so retention never resurrects a visible pane.
          if (visible) { state.seen = ++this._clock; state.keep = false; }
          else state.keep = this._isRetained(state.record);
        }
        // Release EVERY hidden context before allocating the newly shown one,
        // except contexts a retention policy keeps alive.
        for (const state of states) {
          if (!this._isCurrent(state) || state.wanted || state.keep) continue;
          this._retire(state.token);
        }
        this._enforceLimit(states);
        if (!this._disposing) {
          for (const state of states) {
            if (this._closed || this._disposing) break;
            if (this._isCurrent(state) && state.wanted && !state.blocked && !state.token) this._start(state);
          }
        }
      } while (this._again && !this._closed);
    } finally { this._syncing = false; }
  }

  _setRendererLabel(record, value) {
    if (record.pane?.dataset) record.pane.dataset.renderer = value;
  }

  _token(state) {
    const token = { state, renderer: null, listener: null, retired: false, disposalStarted: false };
    state.token = token;
    return token;
  }

  _onLoss(token) {
    const state = token.state;
    if (token.retired || !this._isCurrent(state) || state.token !== token) return;
    state.blocked = true;
    this._retire(token);
    this._reconcile();
  }

  _adopt(state, renderer) {
    const token = this._token(state);
    token.renderer = renderer;
    if (typeof renderer.onContextLoss === 'function') {
      try {
        const listener = renderer.onContextLoss(() => this._onLoss(token));
        if (token.retired) this._detach(listener);
        else token.listener = listener;
      } catch { state.blocked = true; this._retire(token); this._report('loss subscription'); }
    }
    if (!token.retired) this._setRendererLabel(state.record, 'webgl');
  }

  _start(state) {
    // Recheck after reentrant disposers/visibility notifications changed layout.
    if (!this._isCurrent(state) || !this._isVisible(state.record) || !this._allowed(state.record)) return;
    const token = this._token(state);
    let renderer;
    try {
      renderer = this._create(state.record, { onContextLoss: () => this._onLoss(token) });
      if (!renderer || typeof renderer.dispose !== 'function' || typeof renderer.then === 'function') invalid('factory must return a synchronous disposable renderer');
    } catch {
      state.blocked = true;
      this._retire(token);
      this._report('creation');
      return;
    }
    token.renderer = renderer;
    if (token.retired || !this._isCurrent(state) || !this._isVisible(state.record) || !this._allowed(state.record)) {
      this._retire(token);
      this._disposeToken(token);
      return;
    }
    // A callback must never replace an addon's newer owner. No late disposal
    // continuation below writes this field or the pane label.
    if (state.record.webgl && state.record.webgl !== renderer) {
      state.blocked = true;
      this._retire(token);
      this._report('ownership conflict');
      return;
    }
    state.record.webgl = renderer;
    this._setRendererLabel(state.record, 'webgl');
  }

  _detach(listener) {
    try { listener?.dispose?.(); } catch { this._report('loss unsubscription'); }
  }

  _retire(token) {
    if (!token || token.retired) return;
    token.retired = true;
    const { state, renderer } = token;
    if (state.token === token) state.token = null;
    // Invalidate before detaching or disposing: either operation may reenter.
    if (renderer && state.record.webgl === renderer) {
      state.record.webgl = null;
      this._setRendererLabel(state.record, 'dom');
    }
    const listener = token.listener;
    token.listener = null;
    this._detach(listener);
    this._disposeToken(token);
  }

  _disposeToken(token) {
    if (!token.renderer || token.disposalStarted) return;
    token.disposalStarted = true;
    this._disposing++;
    const finish = () => { this._disposing--; this._reconcile(); };
    let result;
    try { result = this._disposeRenderer(token.renderer, token.state.record); }
    catch { this._report('disposal'); finish(); return; }
    if (result && typeof result.then === 'function') {
      const pending = Promise.resolve(result).then(
        () => finish(),
        () => { this._report('disposal'); finish(); }
      );
      this._pending.add(pending);
      pending.then(() => this._pending.delete(pending));
    } else finish();
  }

  _forget(state) {
    // Remove identity before invoking callbacks: a callback can sync a new
    // record with the same connection ID while this one's disposal is pending.
    if (this._states.get(state.record) === state) this._states.delete(state.record);
    this._notifyVisible(state, false);
    this._retire(state.token);
  }
}

export function createTerminalResourceManager(options) {
  return new TerminalResourceManager(options);
}
