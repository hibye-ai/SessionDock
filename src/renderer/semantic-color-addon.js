import { MAX_TEXT, semanticTokens, semanticRuns, semanticPalette } from './terminal-colors.cjs';

// Decorations are a visual extra: they must never delay the parser or an ACK.
//
// The old refresh built the full viewport text and ran token/regex work on every
// animation frame during a burst, then compared the result to decide whether
// anything was dirty. Now:
//
//   * an unchanged logical line reuses its text tokens, but cell attributes are
//     always checked again because xterm can mutate them without changing text;
//   * while the stream controller reports `burst`, no string conversion, token
//     scan or decoration is created — the addon only raises a flag;
//   * after the stream settles, the viewport is rebuilt progressively inside a
//     2ms / 8-row budget per frame, newest viewport first.
//
// The 2,048 decoration cap, 16-row wrap groups, 8-row lookbehind, 48 runs per row
// and MAX_TEXT are unchanged from the previous implementation.
const FRAME_BUDGET_MS = 2;
const ROWS_PER_FRAME = 8;
const MAX_DECORATIONS = 2048;
const MAX_RUNS = 48;
const MAX_GROUP_ROWS = 16;
const LOOKBEHIND_ROWS = 8;
// `requestAnimationFrame`/`cancelAnimationFrame` are host globals an embedder (or a
// test harness) may remove between a pass and its disposal; a missing cancel must
// not turn teardown into a TypeError.
const cancelFrame = id => { if (id != null && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id); };

export class SemanticColorAddon {
  constructor(settings) {
    this.entries = [];
    this.listeners = [];
    this.dirtyRows = new Set();
    this.rowCache = new Map();
    this.tokenCache = this.rowCache;
    // Generation counter for "something changed since the last committed
    // viewport pass". Unlike `dirtyRows.size` it survives a progressive scan that
    // spans several frames, so a mid-scan change restarts the pass instead of
    // restarting it on every frame.
    this.dirtyGeneration = 0;
    this.scannedGeneration = 0;
    // When each row was last marked dirty. `dirtyRows` alone cannot answer that:
    // a row that was already in the start set and got dirtied again mid-pass looked
    // identical to one that was never touched, so its new content was dropped
    // (V7-M-04).
    this.rowDirtyGeneration = new Map();
    this.cursorRow = -1;
    this.lastViewportEnd = -1;
    this.configure(settings);
  }

  // Marks rows as needing a refresh and invalidates the progressive cursor.
  markDirty() {
    this.dirtyGeneration++;
  }

  // Records a row as dirty together with the generation that dirtied it, so a
  // mid-pass re-dirty is distinguishable from a row that was already pending.
  _markRowDirty(row) {
    this.dirtyRows.add(row);
    if (!this.rowDirtyGeneration) this.rowDirtyGeneration = new Map();
    this.rowDirtyGeneration.set(row, this.dirtyGeneration);
    if (this.dirtyRows.size > (this.terminal?.rows || 40) * 2) {
      this.dirtyRows.clear();
      this.rowDirtyGeneration.clear();
      this.scanAll = true;
    }
  }

  activate(terminal) {
    this.terminal = terminal;
    this.listeners.push(
      terminal.onWriteParsed(() => {
        if (!this.enabled || this.suspended || !this.needed()) return;
        this.markDirty();
        if (this.mode === 'burst') { this.needsViewportRefresh = true; return; }
        const buffer = terminal.buffer.active;
        this._markRowDirty(buffer.baseY + buffer.cursorY);
        this.schedule();
      }),
      terminal.onScroll(() => {
        if (!this.enabled || this.suspended || !this.needed()) return;
        this.markDirty();
        if (this.mode === 'burst') { this.needsViewportRefresh = true; return; }
        this.scanAll = true;
        this.schedule();
      }),
      terminal.onResize(() => {
        this.clear();
        if (this.mode !== 'burst') this.schedule();
      }),
      terminal.buffer.onBufferChange(() => {
        this.clear();
        if (this.mode !== 'burst') this.schedule();
      })
    );
    this.listeners.push(terminal.onRender(({ start, end }) => {
      if (!this.enabled || this.suspended || !this.needed()) return;
      if (this.mode === 'burst') { this.needsViewportRefresh = true; return; }
      // A render caused by our own decoration commit must not be treated as new
      // content: dirtying those rows re-scans them, which commits again and
      // schedules another render — an endless frame loop. Terminal content changes
      // are reported by onWriteParsed/onScroll/onResize and the buffer-change
      // event; here only a real geometry/scroll movement is treated as new rows.
      if (this.committing) return;
      const buffer = terminal.buffer.active;
      const signature = `${buffer.type}:${buffer.baseY}:${buffer.cursorY}:${buffer.length}:${terminal.cols}:${terminal.rows}`;
      if (signature === this.renderSignature) return;
      this.renderSignature = signature;
      this.markDirty();
      for (let row = start; row <= end; row++) this._markRowDirty(buffer.viewportY + row);
      this.awaitRender = false;
      this.schedule();
    }));
    this.schedule();
  }

  needed() { return this.enabled && this.settings.semanticColoring !== false; }

  configure(settings) {
    this.enabled = settings.semanticColoring !== false;
    this.settings = { semanticColoring: settings.semanticColoring !== false, terminalColorScheme: settings.terminalColorScheme };
    this.palette = semanticPalette(settings);
    this.paletteGeneration = (this.paletteGeneration || 0) + 1;
    this.clear();
    this.schedule();
  }

  // A single state machine in the stream controller owns this; the addon never
  // starts its own timer for it.
  setStreamingMode(mode) {
    const next = mode === 'burst' ? 'burst' : mode === 'settling' ? 'settling' : 'normal';
    if (this.mode === next) return;
    const previous = this.mode;
    this.mode = next;
    if (next === 'burst') {
      // Drop the visible decorations once so normal ANSI shows through; new
      // semantic work is forbidden until the stream settles.
      this.needsViewportRefresh = true;
      cancelFrame(this.frame);
      this.frame = null;
      this.clearDecorations();
    } else if (previous === 'burst') {
      // Progressive rebuild from the current viewport, within the frame budget.
      this.clear();
      this.needsViewportRefresh = false;
      this.schedule();
    }
  }

  schedule() {
    if (!this.terminal || this.disposed || this.frame || !this.needed() || this.suspended) return;
    if (this.mode === 'burst') return; // burst never schedules a refresh
    this.frame = globalThis.requestAnimationFrame(() => {
      this.frame = null;
      this.refreshBudgeted();
    });
  }

  setVisible(visible) {
    // The stream controller owns visibility once it explicitly supplies it.
    this.visibilityManaged = true;
    if (this.suspended === !visible) return;
    this.suspended = !visible;
    if (!visible) {
      cancelFrame(this.frame);
      this.frame = null;
      this.awaitRender = false;
      // Visual work stops, but the decoration cache is dropped so a later show
      // rebuilds from the real buffer instead of a stale one.
      this.clear();
    } else {
      this.scanAll = true;
      this.schedule();
    }
  }

  remove(entry) {
    for (const decoration of entry.decorations) decoration.dispose();
    entry.marker.dispose();
  }

  clearDecorations() {
    for (const entry of this.entries) this.remove(entry);
    this.entries = [];
  }

  clear() {
    this.clearDecorations();
    this.dirtyRows.clear();
    this.rowDirtyGeneration?.clear();
    this.scanAll = true;
    // A cleared cache invalidates the progressive cursor too. Without this the
    // next pass started at `cursorRow >= last` and finalized nothing, so a
    // cleared/configured addon never rebuilt its decorations.
    this.cursorRow = -1;
    this.viewportKey = null;
    this.pending = [];
    // A cleared viewport invalidates any in-flight pass snapshot as well.
    this._passGeneration = null;
    this._passDirty = null;
    this.markDirty();
  }

  touchContent() { this.contentGeneration = (this.contentGeneration || 0) + 1; }

  // Progressive viewport refresh inside a 2ms / 8-row budget. One logical group
  // (up to 16 wrapped rows) is built per step, so a huge wrapped line cannot blow
  // the frame and the next frame continues where this one stopped.
  refreshBudgeted() {
    const terminal = this.terminal;
    if (!terminal || this.disposed || !this.needed() || this.suspended) return;
    if (this.mode === 'burst') return;
    const buffer = terminal.buffer.active;
    // Full-screen editors own their styling and cursor layout.
    if (buffer.type !== 'normal') { this.clearDecorations(); return; }
    // Standalone embedders may not provide visibility notifications. The app's
    // controller does, avoiding a synchronous layout query on every refresh.
    if (!this.visibilityManaged && !terminal.element?.offsetParent) { this.dirtyRows.clear(); this.scanAll = true; this.cursorRow = -1; return; }

    const first = buffer.viewportY;
    const last = Math.min(buffer.length, first + terminal.rows);
    this.lastViewportEnd = last;
    const viewportKey = `${first}:${last}:${terminal.cols}:${this.paletteGeneration}`;
    if (this.viewportKey !== viewportKey) {
      // A new viewport invalidates the progressive cursor and the per-row cache.
      this.viewportKey = viewportKey;
      this.rowCache = new Map();
      this.scanAll = true;
      this.cursorRow = first;
      this.pending = [];
      this._passGeneration = null;
    }
    if (this.cursorRow < first) { this.cursorRow = first; this.pending = []; this._passGeneration = null; }
    // Only restart between passes, never during one: a progressive scan spans
    // several frames, and restarting mid-scan meant the pass never reached the end
    // of the viewport and committed nothing. A change that lands mid-scan is
    // picked up by the next pass, exactly like the audit's forged mid-pass update.
    if (this.cursorRow >= last) {
      const settled = !this.scanAll && this.scannedGeneration === this.dirtyGeneration && !this.dirtyRows.size;
      // A clean pass must do nothing at all. The previous code re-committed an
      // empty `pending`, which threw away a complete row cache and made a no-op
      // refresh report work (V6-M-05).
      if (settled) return;
      this.cursorRow = first;
      this.pending = [];
      this._passGeneration = null;
    }

    // Snapshot the generation and the dirty-row set exactly ONCE, at the start of
    // the pass, and consume only that snapshot when it commits. Re-reading
    // `this.dirtyGeneration` on every frame meant the value stored at the end of an
    // intermediate frame was never consumed: the final frame took its own, newer
    // generation, cleared every dirty row (including rows it never read) and
    // declared the viewport clean with a stale display (V7-M-04).
    const passGeneration = this._passGeneration ?? this.dirtyGeneration;
    this._passGeneration = passGeneration;
    // Rows dirtied during the pass are not dropped: they belong to the next pass,
    // which is exactly what a generation ahead of this snapshot guarantees. Only
    // rows this pass actually re-read may be cleared on commit.
    const dirtyAtStart = this._passDirty ?? new Set(this.dirtyRows);
    this._passDirty = dirtyAtStart;
    const deadline = performance.now() + FRAME_BUDGET_MS;
    // A normal-sized viewport is committed in one pass. Splitting a 40-row screen
    // over several frames meant a single missed animation frame left the rest of
    // the viewport undecorated indefinitely.
    const rowBudget = Math.max(ROWS_PER_FRAME, Math.min(terminal.rows || ROWS_PER_FRAME, ROWS_PER_FRAME * 8));
    let processed = 0;
    while (this.cursorRow < last && processed < rowBudget) {
      // Lookbehind for a wrapped logical line, bounded to 8 rows.
      let start = this.cursorRow;
      let lookbehind = 0;
      while (start > 0 && first - start < LOOKBEHIND_ROWS - 1 && lookbehind < LOOKBEHIND_ROWS
        && buffer.getLine(start)?.isWrapped) { start--; lookbehind++; }
      const group = this._buildGroup(start, last);
      this._applyGroup(group, first, last);
      this.cursorRow = group.end;
      processed += group.end - start;
      if (performance.now() > deadline) break;
    }
    // Mid-pass: keep both snapshots so every later frame of THIS pass reads them.
    if (this.cursorRow < last) { this.schedule(); return; }
    this._finishViewport(first, last, passGeneration, dirtyAtStart);
  }

  // Builds one logical (wrapped) group of at most MAX_GROUP_ROWS rows.
  _buildGroup(row, last) {
    const terminal = this.terminal;
    const buffer = terminal.buffer.active;
    const lines = [];
    let text = '';
    let end = row;
    do {
      const line = buffer.getLine(end);
      if (!line) break;
      const wraps = buffer.getLine(end + 1)?.isWrapped;
      const value = line.translateToString(!wraps, 0, terminal.cols);
      // Count the real conversions, here, where they happen. Counting them only on
      // the dirty path made a clean pass that still converted rows report 0
      // (V6-M-05).
      this.textConversions = (this.textConversions || 0) + 1;
      lines.push({ row: end, line, offset: text.length });
      text += value;
      end++;
    } while (end < last && end - row < MAX_GROUP_ROWS && text.length < MAX_TEXT && buffer.getLine(end)?.isWrapped);
    return { row, end: Math.max(end, row + 1), lines, text };
  }

  _applyGroup(group, first, last) {
    const terminal = this.terminal;
    if (!group.lines.length) return;
    // Public getLine wrappers are new on each call, while their underlying cells
    // can change in place. Reuse only text-derived tokens, never cell-derived runs.
    // A group's text is the complete token input, including its wrapped rows.
    const cached = group.lines.map(item => this.rowCache.get(item.row)).find(item =>
      item && item.text === group.text && item.palette === this.paletteGeneration && Array.isArray(item.tokens));
    let tokens = cached?.tokens;
    if (!tokens) {
      this.tokenScans = (this.tokenScans || 0) + 1;
      tokens = semanticTokens(group.text, this.settings);
    }
    for (const item of group.lines) {
      if (item.row < first || item.row >= last) continue;
      const previous = this.rowCache.get(item.row);
      const runs = tokens.length ? semanticRuns(item.line, tokens, item.offset, terminal.cols).slice(0, MAX_RUNS)
        : [];
      this.pending.push({ row: item.row, line: item.line, text: group.text, offset: item.offset, tokens, runs, previous });
    }
  }

  // Applies the queued rows: reuse, replace or create row by row. Surviving old
  // entries are never disposed at frame end, only per row.
  _finishViewport(first, last, passGeneration = this.dirtyGeneration, dirtyAtStart = null) {
    const terminal = this.terminal;
    // Decorations are registered/disposed in one batch here, so the render each of
    // them schedules is not evidence of new terminal content.
    this.committing = true;
    try {
      this._commitViewport(terminal, first, last, passGeneration, dirtyAtStart);
    } finally {
      this.committing = false;
    }
    // The pass is complete: the next one starts a fresh snapshot.
    this._passGeneration = null;
    this._passDirty = null;
    // Converge on our own: a pass that started before a change landed, or that
    // left a row dirty, must not idle until the next keystroke. Without this the
    // decoration stayed stale until unrelated input arrived (V7-M-04).
    if (this.dirtyGeneration > passGeneration || this.dirtyRows.size > 0 || this.scanAll) {
      this.schedule();
    }
  }

  _commitViewport(terminal, first, last, passGeneration = this.dirtyGeneration, dirtyAtStart = null) {
    const previousByRow = new Map();
    for (const entry of this.entries) if (!entry.marker.isDisposed) previousByRow.set(entry.marker.line, entry);
    const next = [];
    const rowCache = new Map();
    let count = 0;
    const readRows = new Set();
    for (const item of this.pending) {
      readRows.add(item.row);
      if (!item.runs.length || count + item.runs.length > MAX_DECORATIONS) {
        rowCache.set(item.row, { line: item.line, text: item.text, offset: item.offset, tokens: item.tokens, gen: this.contentGeneration, cols: terminal.cols, palette: this.paletteGeneration, runs: item.runs });
        continue;
      }
      const key = item.runs.map(run => `${run.x}:${run.width}:${run.kind}`).join(',');
      const old = previousByRow.get(item.row);
      rowCache.set(item.row, { line: item.line, text: item.text, offset: item.offset, tokens: item.tokens, gen: this.contentGeneration, cols: terminal.cols, palette: this.paletteGeneration, runs: item.runs });
      if (old && old.key === key && old.decorations.every(decoration => !decoration.isDisposed)) {
        old.text = item.text; old.offset = item.offset;
        next.push(old);
        previousByRow.delete(item.row);
        count += old.decorations.length;
        continue;
      }
      if (old) {
        for (const decoration of old.decorations) decoration.dispose();
        previousByRow.delete(item.row);
      }
      const buffer = terminal.buffer.active;
      const marker = old && !old.marker.isDisposed ? old.marker
        : terminal.registerMarker(item.row - buffer.baseY - buffer.cursorY);
      if (!marker || marker.isDisposed) continue;
      const decorations = item.runs
        .map(run => terminal.registerDecoration({ marker, x: run.x, width: run.width, foregroundColor: this.palette[run.kind], layer: 'bottom' }))
        .filter(Boolean);
      if (!decorations.length) { marker.dispose(); continue; }
      next.push({ marker, decorations, key, runs: item.runs, text: item.text, offset: item.offset });
      count += decorations.length;
    }
    for (const entry of previousByRow.values()) this.remove(entry);
    this.entries = next;
    this.rowCache = rowCache;
    this.pending = [];
    // Clear only the rows this pass actually re-read. A row dirtied *during* the
    // pass was never scanned with its new content, so dropping its dirty mark here
    // made the addon display stale text and still report the viewport clean — the
    // audit's mid-pass mutation (V7-M-04).
    if (dirtyAtStart) {
      for (const row of readRows) {
        if (!this._dirtiedSince(row, dirtyAtStart, passGeneration)) {
          this.dirtyRows.delete(row);
          this.rowDirtyGeneration?.delete(row);
        }
      }
    } else { this.dirtyRows.clear(); this.rowDirtyGeneration?.clear(); }
    this.scanAll = false;
    // Consume exactly the generation this pass started from. A change that landed
    // while the pass was running has already advanced `dirtyGeneration` past this
    // value, so the next pass still runs instead of assuming the viewport is clean.
    this.scannedGeneration = passGeneration;
    this.contentGeneration = this.contentGeneration || 0;
  }

  // True when `row` was marked dirty after the pass began. A row that was already
  // dirty at pass start and re-read by this pass is genuinely up to date; a row
  // dirtied mid-pass must stay dirty for the next pass.
  _dirtiedSince(row, dirtyAtStart, passGeneration) {
    // A row marked dirty *after* this pass snapshotted its generation must stay
    // dirty, even when it was already in the start set: the pass may have read the
    // older content before the change landed (V7-M-04).
    const markedAt = this.rowDirtyGeneration?.get(row);
    if (markedAt !== undefined && markedAt > passGeneration) return true;
    if (this.dirtyGeneration === passGeneration) return false;
    // Conservative: a generation that advanced while this pass ran may belong to
    // this row — the per-row mark is not always available (a dirty row added
    // directly, a producer that only bumps the generation). Re-scanning one extra
    // time is cheap and converges, whereas dropping the mark showed stale text and
    // reported the viewport clean.
    if (dirtyAtStart.has(row)) return true;
    return this.dirtyRows.has(row);
  }

  // Called by the stream controller when it leaves `settling`: the final viewport
  // must match the off/on baseline before the state becomes normal.
  completeSettling(done) {
    const terminal = this.terminal;
    if (!terminal || this.disposed || !this.needed()) { done?.(); return; }
    this.scanAll = true;
    this.viewportKey = null;
    this.cursorRow = 0;
    this.schedule();
    // Wait for the progressive pass to consume the viewport, bounded.
    const deadline = performance.now() + 500;
    const poll = () => {
      if (this.disposed) { done?.(); return; }
      const buffer = terminal.buffer.active;
      const last = Math.min(buffer.length, buffer.viewportY + terminal.rows);
      if (this.cursorRow >= last && !this.frame) { done?.(); return; }
      if (performance.now() >= deadline) { done?.(); return; }
      setTimeout(poll, 16);
    };
    setTimeout(poll, 0);
  }

  snapshot() {
    return this.entries.filter(entry => !entry.marker.isDisposed).map(entry => ({
      row: entry.marker.line,
      runs: entry.runs.map(run => ({ ...run, color: this.palette[run.kind] })),
    }));
  }

  // Instrumentation used by the streaming tests and the performance report.
  stats() {
    return {
      mode: this.mode || 'normal', decorations: this.entries.length,
      cachedRows: this.rowCache ? this.rowCache.size : 0,
      dirtyRows: this.dirtyRows.size, scanAll: !!this.scanAll,
      tokenScans: this.tokenScans || 0, textConversions: this.textConversions || 0,
    };
  }

  dispose() {
    this.disposed = true;
    cancelFrame(this.frame);
    this.clear();
    for (const listener of this.listeners) listener.dispose();
  }
}
