// Timestamp gutter for xterm.
//
// The previous implementation walked every newly retained row on each
// `onWriteParsed` and called `translateToString` on populated rows, so a
// 50,000-line burst did 50,000 JS iterations plus metadata allocation inside the
// parser callback — on the same thread that must acknowledge IPC batches.
//
// Now the parser callback records at most ONE span per batch (previous cursor →
// current cursor) in an ordered range list: O(1) work, one `Date.now()` per
// callback, no string conversion. Timestamps are resolved lazily during the
// viewport render with a binary search, which is O(rows + log ranges) and never
// touches the scrollback. All xterm internals live in terminal-gutter-metadata.js.
import { createGutterAdapter, TimestampRanges } from './terminal-gutter-metadata.js';

const TIME_CHARS = { full: 9, compact: 6, hidden: 0, off: 0 };
const BURST_FRAME_MS = 100; // 10Hz DOM ceiling while output is streaming
// Distinct `clock()` results kept per render. A burst writes thousands of rows that
// share a handful of seconds, so the formatter runs a handful of times instead of
// once per row. The timestamp itself is never cached away — only its rendering.
const CLOCK_CACHE_LIMIT = 64;

const clock = (timestamp, seconds) => {
  const date = new Date(timestamp);
  const parts = [date.getHours(), date.getMinutes()];
  if (seconds) parts.push(date.getSeconds());
  return parts.map(value => String(value).padStart(2, '0')).join(':');
};

// Destination row of a relative/column-only cursor movement, in screen rows.
//
// A `registerCsiHandler` callback runs *before* xterm applies the sequence, so the
// buffer still reports the pre-movement cursor. The destination is therefore computed
// from it and clamped to the screen, which is what "the row this movement lands on"
// means for the redraw snapshot. `null` means the sequence did not name a row that can
// be resolved here (a column-only move still lands on the current row, so it is never
// `null`).
function GutterMovementRow(final, params, buffer, terminal) {
  const count = Math.max(1, Number(params?.[0]) || 1);
  const rows = Math.max(1, terminal.rows || 1);
  const cursorY = Number.isFinite(buffer.cursorY) ? buffer.cursorY : 0;
  let row;
  if (final === 'A' || final === 'F') row = cursorY - count;        // up / previous line
  else if (final === 'B' || final === 'E') row = cursorY + count;   // down / next line
  else row = cursorY;                                              // C, D, G, u: same row
  // `u` restores a saved cursor this addon cannot observe; clamping is the honest
  // bound, and the change-snapshot still decides whether the row is re-stamped.
  if (!Number.isFinite(row)) return null;
  return Math.max(0, Math.min(rows - 1, row));
}

// Destination row of a row-addressed sequence, in screen rows (0-based).
//
// xterm normalizes CUP/HVP/VPA as `(params[0] || 1) - 1`, so an omitted *or* zero
// row means row 1. Ignoring the default (`Number(params[0]) >= 1`) left `ESC[H` —
// the most common pager repaint opener — unmarked, and the commit then fell back
// to an unconditional repaint that rewrote the receive time of unchanged content
// (V9-M-04).
function GutterAddressedRow(params, terminal) {
  const rows = Math.max(1, terminal.rows || 1);
  const row = Number(params?.[0]);
  return Number.isFinite(row) && row >= 1 ? Math.min(row, rows) - 1 : 0;
}

export class TerminalGutterAddon {
  constructor(element, settings, { onModeChange } = {}) {
    this.element = element;
    this.ranges = new TimestampRanges({ maxRanges: 4096 });
    this.listeners = [];
    this.rows = [];
    this.revision = 0;
    this.onModeChange = onModeChange;
    this.burst = false;
    this.lastFrameAt = 0;
    this.trimmedRows = 0;
    this.lastAbsolute = null;
    this.configure(settings);
  }

  activate(terminal) {
    this.terminal = terminal;
    this.adapter = createGutterAdapter(terminal);
    this.normalLines();
    this.listeners.push(terminal.onWriteParsed(() => {
      this.captureParsed();
      this.schedule();
    }), terminal.onScroll(() => this.schedule()), terminal.onResize(() => {
      this.structureDirty = true;
      this.schedule();
    }), terminal.onRender(() => this.schedule()), terminal.buffer.onBufferChange(() => {
      // An alternate-buffer round trip (a TUI editor) does not destroy the normal
      // buffer's scrollback, so its recorded times must survive. `reset()` here
      // erased the whole normal history every time a pager or editor opened, which
      // is why long sessions lost their gutter times (V6-M-06). Only the live screen
      // inference is dropped; the retained ranges stay valid.
      //
      // The pending repaint snapshot is dropped with it: it describes rows of the
      // buffer being left, and comparing it against the buffer that comes back would
      // re-stamp content the round trip did not touch (V9-M-04).
      if (this.redrawRows || this.redrawText) this.redrawDiscarded = true;
      this.redrawRows = null;
      this.redrawText = null;
      const type = terminal.buffer.active?.type;
      if (type === 'normal') {
        this.structureDirty = true;
        // Returning from the alternate buffer re-emits the normal screen, which is
        // *old* content: it must keep the receive times it already had. Anchoring
        // the append inference again re-stamped every historical row with the
        // moment the TUI closed, which is the audit's 1792671606410 → 1792671607901
        // rewrite (V7-M-05). `altEntryRow` remembers where the normal cursor stood
        // when the TUI opened, so the rows written *after* the return (which really
        // are new output) still get a time and the rest keep theirs.
        this.lastAbsolute = this.altEntryRow;
        this.altEntryRow = undefined;
      } else {
        // Full-screen buffer: it owns the screen and records nothing. Remember the
        // normal cursor so the return can continue from it instead of re-anchoring
        // at row 0 and re-stamping the whole history.
        this.structureDirty = true;
        if (this.lastAbsolute !== null && this.lastAbsolute !== undefined) this.altEntryRow = this.lastAbsolute;
        this.lastAbsolute = null;
      }
      this.schedule();
    }));

    // Screen-wide operations invalidate only what they actually rewrote. A partial
    // or full erase (CSI J) replaces the visible cells, so their recorded time is no
    // longer the new text's receive time: the live coverage from this origin down is
    // dropped instead of being reported for content that arrived later (V6-M-06).
    this.listeners.push(terminal.parser.registerCsiHandler({ final: 'J' }, params => {
      if (terminal.buffer.active.type !== 'normal') return false;
      const mode = params[0] || 0;
      if (mode === 3) this.clear();
      else if (mode === 2 || mode === 0) {
        const buffer = terminal.buffer.active;
        // An erase rewrites the *visible screen*, never the scrollback above it.
        // Invalidating from absolute row 0 erased the recorded times of rows the
        // operator can still scroll to (V7-M-05).
        //
        // The origin is the active screen's `baseY`, not the viewport: a scrolled-back
        // operator is looking at scrollback that this erase does not touch, and using
        // `viewportY` invalidated exactly those rows (V9-M-04).
        const from = this.trimmedRows + buffer.baseY;
        this.screenUnknown = true;
        this.ranges.invalidateFrom(mode === 2 ? from : this.trimmedRows + buffer.baseY + buffer.cursorY);
        // The repainted rows are known: this erase plus the writes that follow it
        // cover exactly these. The commit stamps this range with this batch's
        // receive time, so a cursor-addressed redraw keeps a timestamp instead of
        // resolving to `null` (V7-M-05).
        if (mode === 2) this.markRedraw(from, terminal.rows);
        else this.markRedraw(from + buffer.cursorY, Math.max(1, terminal.rows - buffer.cursorY));
      }
      return false;
    }), terminal.parser.registerEscHandler({ final: 'c' }, () => { this.clear(); return false; }));

    // Cursor addressing / scrolling: the append inference is no longer valid, so
    // nothing is inferred from it. A row-addressed repaint is still *known* output:
    // `CSI row;colH` / `CSI row d` name the row the batch rewrote, so it is recorded
    // in the redraw set and gets this batch's time when the parse completes
    // (V7-M-05).
    //
    // Relative and column-only movement (`A`, `B`, `C`, `D`, `E`, `F`, `G`, the
    // cursor restore) is snapshotted at its destination row instead of only marking
    // the screen unknown. Marking alone made `ESC[6;1H` followed by a bare `ESC[1A`
    // — a movement that writes nothing — fall through to an unconditional repaint,
    // so an unchanged `OLDROW-4` was re-stamped with the current time (V8-M-04).
    // Everything else (`S`, `T`, `L`, `M`, `P`, `@`, `X`) rewrites cells whose row is
    // not addressed, so it only marks the screen unknown.
    const rowAddressed = new Set(['H', 'f', 'd']);
    const rowMovement = new Set(['A', 'B', 'E', 'F', 'u']);
    const columnOnly = new Set(['C', 'D', 'G']);
    for (const final of ['H', 'f', 'A', 'B', 'C', 'D', 'E', 'F', 'd', 'u', 'S', 'T', 'L', 'M', 'P', '@', 'X'])
      this.listeners.push(terminal.parser.registerCsiHandler({ final }, params => {
        this.screenUnknown = true;
        const buffer = terminal.buffer.active;
        if (buffer.type === 'normal') {
          if (rowAddressed.has(final)) {
            const row = GutterAddressedRow(params, terminal);
            this.markRedraw(this.trimmedRows + buffer.baseY + row);
          } else if (rowMovement.has(final) || columnOnly.has(final)) {
            const row = GutterMovementRow(final, params, buffer, terminal);
            if (row !== null) this.markRedraw(this.trimmedRows + buffer.baseY + row);
          }
        }
        return false;
      }));
    this.listeners.push(terminal.parser.registerEscHandler({ final: '8' }, () => {
      // A restored cursor is exactly where a `save, redraw, restore` sequence ends.
      // The rows it restored over were repainted by the batch in between, so the
      // cursor row is stamped as redrawn rather than left resolving to `null`.
      this.screenUnknown = true;
      const buffer = terminal.buffer.active;
      if (buffer.type === 'normal') this.markRedraw(this.trimmedRows + buffer.baseY + buffer.cursorY);
      return false;
    }));

    this.wheel = event => {
      if (!event.deltaY) return;
      event.preventDefault();
      terminal.scrollLines(Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / (this.cellHeight || 18))));
    };
    this.element.addEventListener('wheel', this.wheel, { passive: false });
    this.schedule();
  }

  // Rebinds when xterm replaces the normal buffer (alt-screen round trip, resize
  // reflow that swaps the buffer object).
  normalLines() {
    const adapter = this.adapter;
    const lines = adapter?.lines;
    if (lines !== this.boundLines) {
      this.trimListener?.dispose();
      this.insertListener?.dispose();
      this.deleteListener?.dispose();
      this.boundLines = lines;
      // A replaced buffer object keeps its scrollback contents, so the absolute
      // origin does not restart: resetting `trimmedRows` to 0 shifted every
      // recorded range and made the history resolve to the wrong rows.
      this.lastAbsolute = null;
      this.trimListener = adapter?.onTrim(amount => {
        this.trimmedRows += amount;
        this.revision++;
        // Ranges are absolute, so a trim only retires rows that fell off the top
        // and renumbers nothing that is still displayed.
        this.ranges.trimStart(this.trimmedRows);
        if (!this.burst) this.schedule();
      });
      this.insertListener = adapter?.onInsert?.(({ index, amount }) => {
        this.structureDirty = true;
        this.ranges.shift(this.trimmedRows + index, amount);
        this.revision++;
        this.schedule();
      });
      this.deleteListener = adapter?.onDelete?.(({ index, amount }) => {
        this.structureDirty = true;
        this.ranges.shift(this.trimmedRows + index, -amount);
        this.revision++;
        this.schedule();
      });
    }
    return lines;
  }

  // Records rows that a redraw repainted, so their receive time is this batch's
  // instead of `null`. `end` is optional: without it only the addressed row is
  // known, which is all `CSI row;colH` and a restored cursor tell us.
  //
  // The cell text of every marked row is snapshotted here. A sequence that only
  // moves the cursor (`ESC[3;1H`, a restore) names a row but writes nothing to it,
  // so re-stamping on the address alone changed the receive time of content that
  // never arrived again (V7-M-05). At commit only rows whose text really changed
  // are re-stamped.
  markRedraw(start, rows = 1) {
    if (!(start >= 0) || !(rows > 0)) return;
    this._prepareRedraw();
    const current = this.redrawRows;
    this.redrawRows = current
      ? { start: Math.min(current.start, start), end: Math.max(current.end, start + rows) }
      : { start, end: start + rows };
    // Snapshot the whole marked range, not just the newly addressed row: a forward
    // repaint spans every row between its first and last address, and a row that was
    // never snapshotted is treated as changed — which would re-stamp content this
    // batch did not touch (V8-M-04).
    this._snapshotRedrawText(this.redrawRows.start, this.redrawRows.end);
  }

  // One pre-write snapshot per batch, taken when the batch's first marking is
  // handled.
  //
  // The rows a multiline repaint rewrites (`ESC[3;1H A CRLF B ESC[7;1H`) are only
  // still holding their previous text *before* the batch writes them. Snapshotting
  // each row lazily when it was addressed used the text as of the later address,
  // so a middle row that the same batch had already rewritten compared equal to
  // itself and kept the timestamp of the text it replaced (V9-M-04). The snapshot
  // is the live screen, i.e. bounded by the viewport, never the scrollback, and
  // `plain append` never reaches this path at all.
  _prepareRedraw() {
    if (this.redrawText) return;
    this.redrawText = new Map();
    const buffer = this.terminal?.buffer?.active;
    if (!buffer || buffer.type !== 'normal') return;
    const start = this.trimmedRows + buffer.baseY;
    this._snapshotRedrawText(start, start + Math.max(1, this.terminal.rows || 1));
  }

  // Bounded: at most one text conversion per viewport row, once per batch, and only
  // on a cursor-addressing/erase sequence. Clamped to the live screen so a marked
  // row outside the viewport can never turn this into a scrollback walk.
  _snapshotRedrawText(from, to) {
    const buffer = this.terminal?.buffer?.active;
    if (!buffer || buffer.type !== 'normal') return;
    if (!this.redrawText) this.redrawText = new Map();
    const origin = this.trimmedRows;
    const base = origin + (Number.isFinite(buffer.baseY) ? buffer.baseY : 0);
    const limit = base + Math.max(1, this.terminal.rows || 1);
    const start = Math.max(from, base);
    const end = Math.min(to, limit);
    for (let absolute = start; absolute < end; absolute++) {
      if (this.redrawText.has(absolute)) continue;
      const line = buffer.getLine(absolute - origin);
      this.redrawText.set(absolute, line && typeof line.translateToString === 'function'
        ? line.translateToString(true) : '');
    }
  }

  // Rows in [from, to) whose cells changed since the batch's pre-write snapshot.
  // An unrecorded row is treated as changed: the caller then keeps the previous
  // behaviour. Returns coalesced [start, end) spans, so a repaint of n adjacent
  // rows costs one range operation instead of n.
  _changedRedrawRows(from, to) {
    const snapshot = this.redrawText;
    const buffer = this.terminal?.buffer?.active;
    if (!snapshot || !buffer) return null;
    const origin = this.trimmedRows;
    const spans = [];
    let span = null;
    for (let absolute = from; absolute < to; absolute++) {
      if (snapshot.has(absolute)) {
        const line = buffer.getLine(absolute - origin);
        const text = line && typeof line.translateToString === 'function'
          ? line.translateToString(true) : '';
        if (text === snapshot.get(absolute)) { span = null; continue; }
      }
      if (span && span[1] === absolute) span[1] = absolute + 1;
      else { span = [absolute, absolute + 1]; spans.push(span); }
    }
    return spans;
  }

  // One span per parser batch: no row loop, no string conversion, one clock read.
  // Timestamps are always recorded, even while both display options are off. The
  // options only control rendering: stopping the capture meant that turning the
  // gutter on after output had arrived showed nothing, because the retained rows
  // had no recorded time.
  captureParsed() {
    this._recordSpan();
  }

  _recordSpan() {
    const terminal = this.terminal;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    if (buffer.type !== 'normal') return;
    const lines = this.normalLines();
    if (!lines || !this.adapter) return;
    const origin = this.trimmedRows;
    const cursor = buffer.baseY + buffer.cursorY;
    const absolute = origin + cursor;
    // A structural change (reflow / insert / delete) or a screen rewrite means the
    // append inference cannot be trusted for the screen that was there before. It
    // does NOT mean the rows the cursor just advanced over are unknown: those were
    // written by this batch. The flags only suppress a *backwards* inference
    // below, so a real append is still recorded — the previous code returned here,
    // which lost the timestamp of every row written after any resize/insert/CSI
    // and left the view stale because `revision` never changed.
    const unknownScreen = this.screenUnknown === true;
    const dirtyScreen = this.redrawRows;
    // A repaint whose snapshot was discarded by a buffer switch must not fall through
    // to the "no snapshot ⇒ stamp the addressed range" fallback: nothing about those
    // rows is known any more, and the buffer round trip did not write them (V9-M-04).
    const discarded = this.redrawDiscarded === true;
    if (this.structureDirty || this.screenUnknown) {
      this.structureDirty = false;
      this.screenUnknown = false;
    }
    this.redrawDiscarded = false;
    if (this.lastAbsolute === null || this.lastAbsolute === undefined) {
      // The first batch that populated the screen is real received output: anchor
      // at the row the screen started on and record it, instead of only setting
      // the cursor (the previous behaviour lost every row of the first batch).
      const first = Math.max(origin, 0);
      if (absolute > first) { this.ranges.add(first, absolute, Date.now()); this.revision++; }
      // The cursor's own line exists even when nothing advanced over it: a
      // clear-all followed by cursor-addressed output leaves it as the only row
      // that received anything, and the audit's `ERROR CURSOR_REDRAW` case lost
      // its time exactly here (V7-M-05).
      if (!(absolute > first)) { this.ranges.add(absolute, absolute + 1, Date.now()); this.revision++; }
      this.lastAbsolute = absolute;
      return;
    }
    // Only a forward-moving cursor is ordinary append output. Backwards or
    // stationary movement over a rewritten screen is a redraw: those rows were
    // repainted by this batch, so they get the receive time of *this* repaint
    // instead of keeping the time of the text they replaced.
    if (absolute <= this.lastAbsolute) {
      // A cursor-addressed repaint (CSI J, then a saved/restored or addressed
      // cursor) leaves `absolute` at or behind `lastAbsolute`, so the append
      // inference records nothing and the redrawn row kept `null`. The parser
      // handler marks the repaint explicitly; only then is the range re-stamped.
      // An ordinary backwards scroll keeps its first-seen times, because
      // `redrawRows` is unset.
      if (unknownScreen || dirtyScreen) {
        if (!discarded) this._stampRedraw(dirtyScreen, absolute);
      } else if (discarded) {
        // Nothing is re-stamped, but the view still has to refresh.
        this.revision++;
      }
      this.redrawRows = null;
      this.redrawText = null;
      this.lastAbsolute = absolute;
      return;
    }
    const previous = this.lastAbsolute;
    this.lastAbsolute = absolute;
    if (dirtyScreen) {
      // A repaint that ends *forward* of where it started (address a row, rewrite it,
      // then address a later row) used to be discarded here, so the rewritten row kept
      // the time of the text it replaced — the audit's `NEW_ROW_REPAINT` case. The
      // rows whose cells really changed are re-stamped first, then the ordinary append
      // span is recorded below.
      if (!discarded) this._stampRedraw(dirtyScreen, absolute);
      this.redrawRows = null;
      this.redrawText = null;
    }
    // The span covers [previousCursorRow, newCursorRow): the row we started on was
    // completed and every row between was created by this batch.
    this.ranges.add(previous, absolute, Date.now());
    this.revision++;
  }

  // Re-stamps the rows a redraw actually rewrote. `dirtyScreen` is the range the
  // parser handlers marked, `absolute` the cursor row at commit time.
  //
  // A snapshot that exists is authoritative: only rows whose cells changed are
  // re-stamped. Falling back to "every row in the marked range" whenever none
  // changed rewrote the times of untouched content — a bare relative cursor move
  // (`ESC[6;1H` then `ESC[1A`) holds no new bytes, so `OLDROW-4` kept its text but
  // got a new timestamp (V8-M-04).
  _stampRedraw(dirtyScreen, absolute) {
    const start = dirtyScreen ? Math.max(0, Math.min(dirtyScreen.start, absolute)) : absolute;
    const end = dirtyScreen
      ? Math.max(absolute + 1, Math.max(dirtyScreen.end, absolute + 1))
      : absolute + 1;
    const spans = this._changedRedrawRows(start, end);
    const now = Date.now();
    if (spans) {
      // A recorded snapshot: unchanged rows keep their first-seen time.
      if (!spans.length) return;
      for (const [from, to] of spans) this.ranges.repaint(from, to, now);
      this.revision++;
      return;
    }
    // No snapshot (the buffer was unavailable when the sequence ran): `repaint`, not
    // `add`, because first-seen-wins is right for appended rows and wrong here — the
    // text on those rows really did arrive now.
    this.ranges.repaint(start, end, now);
    this.revision++;
  }

  // Absolute row lookup used by the renderer.
  timestamp(row) {
    if (!this.adapter) return undefined;
    return this.ranges.timestampAt(this.trimmedRows + row);
  }

  configure(settings) {
    this.lineNumbers = !!settings.terminalLineNumbers;
    this.timestamps = !!settings.terminalTimestamps;
    this.renderKey = '';
    this.element.classList.toggle('hidden', !this.lineNumbers && !this.timestamps);
    this.setTimeMode(this.timestamps ? (this.timeMode && this.timeMode !== 'off' ? this.timeMode : 'full') : 'off');
    this.schedule();
  }

  setTimeMode(mode) {
    if (mode === this.timeMode) return;
    this.timeMode = mode;
    this.element.classList.toggle('time-compact', mode === 'compact');
    this.element.classList.toggle('time-hidden', mode === 'hidden');
    this.onModeChange?.(mode);
  }

  // Keep at least 100 output columns with seconds, 80 with minutes; otherwise hide.
  // Reserve the gutter margin/border (7px) and the fit addon's scrollbar (14px).
  fitTimeMode(width, cell, numberChars, ratio) {
    if (!width || !cell) return this.timeMode === 'off' ? 'full' : this.timeMode;
    const columns = chars => (width - 21 - chars * cell * ratio) / cell;
    return columns(numberChars + TIME_CHARS.full) >= 100 ? 'full'
      : columns(numberChars + TIME_CHARS.compact) >= 80 ? 'compact' : 'hidden';
  }

  // Visual work only: the adapter keeps recording while hidden, so a later
  // toggle still shows real receive times instead of fabricated ones.
  setVisible(visible) {
    if (this.suspended === !visible) return;
    this.suspended = !visible;
    if (!visible) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    } else {
      this.renderKey = '';
      this.schedule();
    }
  }

  // Driven by the stream controller's single state machine (never a second
  // timer of its own).
  setBurstMode(burst) {
    this.burst = !!burst;
    this.renderKey = '';
    this.schedule();
  }

  setStreamingMode(state) { this.setBurstMode(state === 'burst'); }

  schedule() {
    if (!this.terminal || this.disposed || this.frame || this.suspended) return;
    if (!this.lineNumbers && !this.timestamps) return;
    if (this.burst) {
      // A 10Hz ceiling keeps the DOM out of the parser's way while still showing
      // live line numbers and times.
      const wait = BURST_FRAME_MS - (Date.now() - this.lastFrameAt);
      if (wait > 0) {
        if (!this.burstTimer) {
          this.burstTimer = setTimeout(() => { this.burstTimer = null; this.schedule(); }, wait);
          this.burstTimer.unref?.();
        }
        return;
      }
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.lastFrameAt = Date.now();
      this.render();
    });
  }

  render() {
    const terminal = this.terminal;
    const root = this.element;
    if (!terminal || !root.offsetParent) return;
    const buffer = terminal.buffer.active;
    const adapter = this.adapter;
    const normal = terminal.buffer.normal;
    const cell = terminal._core?._renderService?.dimensions?.css?.cell;
    const paneWidth = root.parentElement?.clientWidth || 0;
    // `ranges.coveredRows` is part of the key: new output adds timestamp coverage
    // without necessarily scrolling or trimming, and without it a row that just
    // gained a time kept rendering its old (empty) value. It is O(1) now, so this
    // key costs one property read instead of a scan of every range.
    const coverage = this.ranges.coveredRows;
    const key = [buffer.type, buffer.viewportY, buffer.baseY, buffer.length, normal.length,
      terminal.rows, cell?.height, cell?.width, paneWidth, terminal.options.fontSize,
      terminal.options.fontFamily, terminal.options.fontWeight, terminal.options.lineHeight,
      this.lineNumbers, this.timestamps, this.revision, this.trimmedRows, coverage].join('|');
    if (key === this.renderKey) return;
    this.renderKey = key;

    // ---- phase 1: geometry reads ------------------------------------------
    //
    // Every read that can force layout is collected here, before the first style
    // write. Interleaving reads and writes is what makes a 40-row loop cost 40
    // layout passes; the previous code read `clientWidth`, then wrote styles inside
    // the row loop.
    const fontSize = terminal.options.fontSize;
    const gutterSize = Math.min(16, fontSize);
    const cellHeight = cell?.height || fontSize * 1.2 * terminal.options.lineHeight;
    this.cellHeight = cellHeight;
    const digits = Math.max(4, String(normal.length).length);
    const numberChars = this.lineNumbers ? digits + 1 : 0;
    const glyph = cell?.width ? Math.max(1, cell.width - (terminal.options.letterSpacing || 0)) : 0;
    const mode = this.timestamps
      ? this.fitTimeMode(paneWidth, cell?.width, numberChars, glyph ? glyph / cell.width * gutterSize / fontSize : 1)
      : 'off';
    // A geometry generation is everything the gutter's own box depends on. When it
    // is unchanged the root style writes are skipped entirely: they were being
    // rewritten on every rendered frame even though nothing about the box changed.
    const geometry = `${terminal.options.fontFamily}|${fontSize}|${terminal.options.fontWeight}|${gutterSize}|${numberChars}|${mode}`;

    // ---- phase 2: box writes (only on a generation change) -----------------
    if (this.geometry !== geometry) {
      this.geometry = geometry;
      root.style.fontFamily = terminal.options.fontFamily;
      root.style.fontSize = `${gutterSize}px`;
      root.style.fontWeight = terminal.options.fontWeight;
      root.style.width = `${numberChars + TIME_CHARS[mode]}ch`;
    }
    this.setTimeMode(mode);
    const hint = mode === 'compact' ? '창이 좁아 시간을 시:분으로 표시합니다. 넓히면 초까지 표시합니다.'
      : mode === 'hidden' ? '창이 좁아 시간 열을 숨겼습니다. 넓히면 다시 표시합니다.' : '';
    if (root.title !== hint) root.title = hint;

    const flags = `${this.lineNumbers}:${this.timestamps}`;
    if (this.rowFlags !== flags) { root.replaceChildren(); this.rows = []; this.rowFlags = flags; }
    let count = 0;
    let previousClock = '';
    // One cache per render: a burst's rows share a few distinct seconds, so this
    // turns thousands of `Date` + `padStart` calls into a handful, and it cannot go
    // stale because it never outlives the frame.
    const clockCache = this.clockCache && this.clockCacheMode === mode ? this.clockCache : new Map();
    this.clockCache = clockCache;
    this.clockCacheMode = mode;
    const renderClock = (timestamp, seconds) => {
      const key2 = seconds ? `s${timestamp}` : `m${timestamp}`;
      let value = clockCache.get(key2);
      if (value === undefined) {
        if (clockCache.size >= CLOCK_CACHE_LIMIT) clockCache.clear();
        value = clock(timestamp, seconds);
        clockCache.set(key2, value);
      }
      return value;
    };
    if (buffer.type === 'normal' && adapter) {
      const origin = this.trimmedRows;
      const last = Math.min(buffer.length, buffer.viewportY + terminal.rows);
      const numberWidth = `${digits + 1}ch`;
      const rowHeight = `${cellHeight}px`;
      for (let row = buffer.viewportY; row < last; row++) {
        const line = buffer.getLine(row);
        if (!line) continue;
        const absolute = origin + row;
        // Bounded lookup: one binary search over at most 4096 live ranges. Never a
        // scrollback scan, and no string conversion for a row with a timestamp.
        const timestamp = this.ranges.timestampAt(absolute);
        // The cursor's own line always exists, even when it holds no characters:
        // after a clear-all it is the next line to type on, so it keeps its number
        // instead of the whole gutter rendering blank until the first keystroke.
        const live = row === buffer.baseY + buffer.cursorY;
        const populated = timestamp !== undefined || live || adapter.isPopulated(line);
        let entry = this.rows[count];
        if (!entry) {
          const node = document.createElement('div');
          node.className = 'terminal-gutter-row';
          entry = { node, top: null, height: null, lineHeight: null, bufferRow: null };
          if (this.lineNumbers) { entry.number = document.createElement('span'); entry.number.className = 'gutter-number'; node.append(entry.number); }
          if (this.timestamps) { entry.time = document.createElement('span'); entry.time.className = 'gutter-time'; node.append(entry.time); }
          this.rows.push(entry);
          root.append(node);
        }
        const { node, number, time } = entry;
        // Differential writes. Assigning the same value to a style or dataset
        // property still goes through the CSSOM/dataset setter, and a burst repeats
        // every one of these for every visible row on every frame. Only a real
        // change is written; `count` moving by one changes `top`, nothing else here.
        const top = `${count * cellHeight}px`;
        if (entry.top !== top) { node.style.top = top; entry.top = top; }
        if (entry.height !== rowHeight) { node.style.height = rowHeight; entry.height = rowHeight; }
        if (entry.lineHeight !== rowHeight) { node.style.lineHeight = rowHeight; entry.lineHeight = rowHeight; }
        if (entry.bufferRow !== row) { node.dataset.bufferRow = row; entry.bufferRow = row; }
        if (number) {
          if (entry.numberWidth !== numberWidth) { number.style.width = numberWidth; entry.numberWidth = numberWidth; }
          const value = populated ? String(absolute + 1) : '';
          if (entry.numberText !== value) { number.textContent = value; entry.numberText = value; }
        }
        if (time) {
          const stamp = timestamp === undefined ? '' : String(timestamp);
          if (entry.stamp !== stamp || entry.populated !== populated || entry.mode !== mode) {
            const value = timestamp === undefined ? (populated ? '—' : '') : renderClock(timestamp, mode !== 'compact');
            const full = mode === 'compact' && timestamp !== undefined ? renderClock(timestamp, true) : '';
            if (time.textContent !== value) time.textContent = value;
            if (time.title !== full) time.title = full;
            if (stamp) time.dataset.timestamp = stamp; else delete time.dataset.timestamp;
            entry.stamp = stamp; entry.populated = populated; entry.mode = mode;
            entry.clock = timestamp === undefined ? '' : value;
          }
          // A run of identical times keeps only its first entry at full strength.
          // `classList.toggle` is a no-op when the class already matches, so this is
          // the cheap form of a differential write.
          time.classList.toggle('repeat', !!entry.clock && entry.clock === previousClock);
          previousClock = entry.clock;
        }
        count++;
      }
    }
    while (this.rows.length > count) {
      const entry = this.rows.pop();
      entry.node.remove();
    }
  }

  clear() {
    this.ranges.reset();
    this.lastAbsolute = null;
    this.redrawText = null;
    this.redrawRows = null;
    this.trimmedRows = 0;
    this.revision++;
    this.renderKey = '';
    this.schedule();
  }

  // Bounded metadata upkeep, invoked by the stream controller outside burst. Reads
  // are already O(log ranges), so nothing needs eager per-row materialization on
  // the parser path; this only retires history that scrolled out of retention.
  materialize(budget = 256) {
    if (!this.adapter || !this.ranges.size) return 0;
    return this.ranges.takeBefore(this.trimmedRows + this.adapter.length, budget).length;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.burstTimer);
    this.trimListener?.dispose();
    this.insertListener?.dispose();
    this.deleteListener?.dispose();
    for (const listener of this.listeners) listener.dispose();
    this.element.removeEventListener('wheel', this.wheel);
    this.element.replaceChildren();
  }
}
