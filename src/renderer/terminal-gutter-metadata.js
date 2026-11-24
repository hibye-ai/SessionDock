// xterm 6 buffer adapter for the terminal gutter.
//
// All access to xterm's private buffer internals lives in this file so a library
// upgrade only has to satisfy `tests/terminal-gutter-metadata.test.cjs`. The
// gutter itself never walks rows or builds strings on the parser path.
export function createGutterAdapter(terminal) {
  const core = terminal?._core;
  const buffers = core?._bufferService?.buffers;
  const normal = buffers?.normal;
  const lines = normal?.lines;
  return {
    ok: !!(lines && typeof lines.get === 'function' && lines.onTrim),
    // Re-read on every access. xterm replaces the buffer object itself when it
    // resizes/reflows or round-trips through the alternate buffer, so a captured
    // reference silently pointed at the retired buffer while `normalLines()`'s
    // rebind comment claimed otherwise (V6-M-06).
    get lines() { return core?._bufferService?.buffers?.normal?.lines ?? lines; },
    // Absolute origin: how many rows have been trimmed away since creation.
    // `lines.length` is the retained window, so absolute position = trimmed + i.
    get length() { return this.lines?.length ?? 0; },
    get isFull() { return !!this.lines?.isFull; },
    line(row) { return this.lines?.get(row); },
    // Bounded cell probe: never builds a string and never scans the scrollback.
    isPopulated(line) {
      if (!line) return false;
      if (typeof line.getTrimmedLength === 'function') return line.getTrimmedLength() > 0;
      return !!line.translateToString(true);
    },
    isWrapped(line) { return !!line?.isWrapped; },
    cursorRow() { const buffer = terminal?.buffer?.active; return buffer ? buffer.baseY + buffer.cursorY : 0; },
    baseY() { return terminal?.buffer?.active?.baseY ?? 0; },
    viewportY() { return terminal?.buffer?.active?.viewportY ?? 0; },
    bufferType() { return terminal?.buffer?.active?.type ?? 'normal'; },
    onTrim(listener) { return this.lines?.onTrim(listener); },
    onInsert(listener) { return this.lines?.onInsert?.(listener); },
    onDelete(listener) { return this.lines?.onDelete?.(listener); },
    onBufferChange(listener) { return terminal?.buffer?.onBufferChange?.(listener); },
  };
}

// Ordered, append-only ranges of "rows that appeared between two timestamps".
// Lookup is a binary search, so a viewport render costs O(rows + log ranges)
// instead of a scrollback scan. Rows keep their first-seen timestamp: a later
// batch never rewrites a row that was already covered.
export class TimestampRanges {
  // `maxRetainedRows` is the real bound and is expressed in *rows*: the product
  // supports 100,000 lines of scrollback, so every readable row's time must fit.
  // `maxRetainedRanges` is a secondary object bound, and it must never be the
  // binding one below that row budget: at 65,536 ranges against a 69,633-row
  // history the oldest visible row still resolved to `null` (V7-M-05). It is set
  // to the supported scrollback so only a history *larger* than the product
  // supports can evict a readable row.
  constructor({ maxRanges = 4096, maxRetainedRanges = 100000, maxRetainedRows = 262144 } = {}) {
    this.ranges = [];
    // Retired prefix length. `ranges[0 .. head)` are tombstones (`null`); the live
    // ranges are `ranges[head ..)`. Retiring the oldest range is the single hottest
    // operation of a streaming session (one per trimmed line), so it must be an
    // index advance, never a copy of the survivors.
    this.head = 0;
    // Exact sum of live span lengths, maintained incrementally. `coveredRows` used
    // to add up every range, and the gutter reads it on every render to build its
    // cache key, so a full list was rescanned per frame for a value that only
    // changes on a mutation.
    this.covered = 0;
    this.maxRanges = maxRanges;
    // Ranges dropped by the cap keep their first-seen time here instead of
    // disappearing: without this, a long session silently lost the timestamps of
    // scrollback that is still readable, so a scrolled-back row rendered with no
    // time even though one had been recorded when it arrived. Bounded and
    // ascending, so a lookup is still a binary search.
    this.retained = [];
    this.retainedHead = 0;
    // The retention bound is expressed in *rows*, not in ranges. A count cap turned
    // a session of many distinct timestamps into data loss: 6145 one-row ranges
    // pushed 4096 into the active list and then evicted the oldest of the 2049
    // retained ones, so a row that was still on screen resolved to no time
    // (V6-M-06). A row budget keeps every readable row's time and still bounds the
    // structure, because xterm's own scrollback is bounded too.
    this.maxRetainedRows = maxRetainedRows;
    this.maxRetainedRanges = maxRetainedRanges;
    this.retainedRows = 0;
    this.epoch = 0;
  }

  // Live range count. The tombstone prefix is not part of the structure.
  get size() { return this.ranges.length - this.head; }
  // O(1): maintained incrementally by every mutation, never rescanned. The gutter
  // reads this on every render to build its cache key, so a scan here was a
  // per-frame cost proportional to the whole range list.
  get coveredRows() { return this.covered; }

  reset() {
    this.ranges.length = 0; this.head = 0; this.covered = 0;
    this.retained.length = 0; this.retainedHead = 0; this.retainedRows = 0;
    this.epoch++;
  }
  // `clear()` drops the recorded coverage (clear-screen / buffer switch) but is
  // also used by callers that only want the range list emptied, so the retained
  // history is preserved and reset() is the invalidation path.
  clear() { this.ranges.length = 0; this.head = 0; this.covered = 0; }

  // Amortized O(1) maintenance: the tombstone prefix is dropped only once it is at
  // least as large as the live part, so the copy is paid for by the retirements
  // that created it rather than by the next trim.
  _compactHead() {
    if (this.head > 1024 && this.head * 2 >= this.ranges.length) {
      this.ranges = this.ranges.slice(this.head);
      this.head = 0;
    } else if (this.head >= this.ranges.length) {
      this.ranges.length = 0;
      this.head = 0;
    }
  }

  _compactRetainedHead() {
    if (this.retainedHead > 1024 && this.retainedHead * 2 >= this.retained.length) {
      this.retained = this.retained.slice(this.retainedHead);
      this.retainedHead = 0;
    } else if (this.retainedHead >= this.retained.length) {
      this.retained.length = 0;
      this.retainedHead = 0;
    }
  }

  // Recomputes `covered` from the live ranges. Only whole-list rebuilds
  // (repaint/shift) and the differential verifier need it; the hot paths maintain
  // the counter incrementally.
  _recount() {
    let total = 0;
    for (let index = this.head; index < this.ranges.length; index++) {
      const range = this.ranges[index];
      total += range.end - range.start;
    }
    this.covered = total;
    return total;
  }

  // `start`/`end` are absolute rows, [start, end). Returns the rows that were
  // actually added (a range that overlaps existing coverage only appends its new
  // suffix).
  add(start, end, timestamp, { firstWrappedTimestamp } = {}) {
    if (!(end > start) || !(timestamp > 0)) return 0;
    const last = this.ranges[this.ranges.length - 1];
    if (last && start < last.end) {
      // First-seen wins: keep the covered prefix, record the uncovered suffix.
      if (end <= last.end) return 0;
      start = last.end;
    }
    if (last && start === last.end && this._mergeable(last, timestamp)) {
      this.covered += end - last.end;
      last.end = end;
      if (firstWrappedTimestamp !== undefined && last.firstWrappedTimestamp === undefined) last.firstWrappedTimestamp = firstWrappedTimestamp;
      return end - start;
    }
    this.ranges.push({ start, end, timestamp, firstWrappedTimestamp, epoch: this.epoch });
    this.covered += end - start;
    if (this.ranges.length - this.head > this.maxRanges) this._compact();
    return end - start;
  }

  _mergeable(range, timestamp) {
    return range.timestamp === timestamp;
  }

  // Records that rows [start, end) were *repainted* by received output, so their
  // time is this batch's, not the time of the text they replaced. `add()` keeps
  // first-seen-wins semantics for append-only output, which is correct there but
  // wrong for a cursor-addressed redraw: the new text really did arrive now
  // (V7-M-05). Retained history is left alone — it was not on screen.
  repaint(start, end, timestamp) {
    if (!(end > start) || !(timestamp > 0)) return 0;
    // Rebuild in sorted order and insert the new span at its position. Calling
    // `add()` here would be wrong: it only appends and treats any span that starts
    // before the last range's end as already-covered, so a repaint in the middle of
    // the screen would be dropped.
    const next = [];
    let inserted = false;
    const insert = () => {
      if (inserted) return;
      inserted = true;
      const previous = next[next.length - 1];
      // Keep the timestamp equal ⇒ mergeable rule `add()` uses for contiguous spans.
      if (previous && previous.end === start && previous.timestamp === timestamp) previous.end = end;
      else next.push({ start, end, timestamp, epoch: this.epoch });
    };
    for (let index = this.head; index < this.ranges.length; index++) {
      const range = this.ranges[index];
      if (range.end <= start) { next.push(range); continue; }
      if (range.start >= end) { insert(); next.push(range); continue; }
      // Overlaps the repaint: keep only the parts outside it, in order.
      if (range.start < start) next.push({ ...range, end: start });
      insert();
      if (range.end > end) next.push({ ...range, start: end });
    }
    insert();
    this.ranges = next.filter(range => range.end > range.start);
    this.head = 0;
    this._recount();
    if (this.ranges.length > this.maxRanges) this._compact();
    return end - start;
  }

  // Keeps the newest ranges (the live screen always has the highest positions).
  // Rows dropped by the cap are not forgotten: their first-seen time moves into
  // the bounded retained map so scrollback keeps real timestamps instead of
  // becoming unknown.
  _compact() {
    const drop = (this.ranges.length - this.head) - this.maxRanges;
    if (drop <= 0) return;
    for (let index = 0; index < drop; index++) {
      const range = this.ranges[this.head + index];
      this.covered -= range.end - range.start;
      this._retain(range);
      this.ranges[this.head + index] = null;
    }
    this.head += drop;
    if (this.covered < 0) this.covered = 0;
    this._compactHead();
  }

  _retain(range) {
    if (!(this.maxRetainedRanges > 0) || !(this.maxRetainedRows > 0)) return;
    const last = this.retained[this.retained.length - 1];
    if (last && last.timestamp === range.timestamp && last.end === range.start) {
      last.end = range.end;
      this.retainedRows += range.end - range.start;
    } else {
      this.retained.push({ start: range.start, end: range.end, timestamp: range.timestamp });
      this.retainedRows += range.end - range.start;
    }
    // Evict by rows, oldest first: the budget is what keeps the structure bounded,
    // so the newest readable rows always keep their real time. The head advances
    // instead of `shift()`ing the array, which was O(n) per evicted range.
    let live = this.retained.length - this.retainedHead;
    while (live > this.maxRetainedRanges || (this.retainedRows > this.maxRetainedRows && live > 1)) {
      const dropped = this.retained[this.retainedHead];
      this.retained[this.retainedHead] = null;
      this.retainedHead++;
      live--;
      if (!dropped) continue;
      this.retainedRows -= dropped.end - dropped.start;
    }
    if (this.retainedRows < 0) this.retainedRows = 0;
    this._compactRetainedHead();
  }

  // Binary search over the retired (older) ranges.
  _findRetained(row) {
    let low = this.retainedHead;
    let high = this.retained.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const range = this.retained[middle];
      if (!range) { low = middle + 1; continue; }
      if (row < range.start) high = middle - 1;
      else if (row >= range.end) low = middle + 1;
      else return range;
    }
    return null;
  }

  // Deletes/inserts shift positions. A structural change the adapter cannot model
  // exactly invalidates only the affected live screen, never the whole history.
  //
  // Everything strictly above the splice point is untouched, so only the live
  // suffix that actually moves is rebuilt: a binary search finds the first
  // affected range and the already-correct prefix is carried over by reference.
  shift(index, amount) {
    if (!amount) return;
    const ranges = this.ranges;
    let low = this.head;
    let high = ranges.length - 1;
    let at = ranges.length;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (ranges[middle].end > index) { at = middle; high = middle - 1; } else low = middle + 1;
    }
    if (at >= ranges.length) return; // nothing at or below the splice point moves
    const next = [];
    for (let slot = this.head; slot < at; slot++) next.push(ranges[slot]);
    for (let slot = at; slot < ranges.length; slot++) {
      const range = ranges[slot];
      if (range.end <= index) { next.push(range); continue; }
      if (range.start >= index) {
        range.start += amount; range.end += amount;
        if (range.end <= range.start) continue;
        next.push(range);
        continue;
      }
      // Overlapping the splice: keep the part before it and drop the ambiguous part.
      if (index > range.start) next.push({ ...range, end: index });
      const tailStart = index + amount;
      if (range.end + amount > tailStart) next.push({ ...range, start: tailStart, end: range.end + amount });
    }
    this.ranges = next;
    this.head = 0;
    this._recount();
    if (this.ranges.length > this.maxRanges) this._compact();
  }

  // Ranges are absolute (origin = total rows trimmed away), so a trim only
  // retires what fell off the top; it never renumbers the survivors.
  //
  // This is the hot path: it runs on every `onTrim`, i.e. once per line a flood
  // produces. It advances `head` and subtracts from `covered`; it never allocates
  // or copies a survivor array. When the oldest range already starts at or after
  // the new origin it is one comparison and a return.
  trimStart(absoluteOrigin) {
    if (!(absoluteOrigin > 0)) return;
    // Retained history is trimmed too: rows that fell off the top of the buffer can
    // never be read again, so keeping them only delays the eviction of rows that
    // still matter (V6-M-06).
    const retained = this.retained;
    const firstRetained = retained[this.retainedHead];
    if (firstRetained && firstRetained.start < absoluteOrigin) {
      let head = this.retainedHead;
      while (head < retained.length) {
        const range = retained[head];
        if (!range) { head++; continue; }
        if (range.end <= absoluteOrigin) {
          this.retainedRows -= range.end - range.start;
          retained[head] = null;
          head++;
          continue;
        }
        if (range.start < absoluteOrigin) {
          this.retainedRows -= absoluteOrigin - range.start;
          range.start = absoluteOrigin;
        }
        break;
      }
      this.retainedHead = head;
      if (this.retainedRows < 0) this.retainedRows = 0;
      this._compactRetainedHead();
    }
    const ranges = this.ranges;
    const first = ranges[this.head];
    if (!first) { this.ranges.length = 0; this.head = 0; this.covered = 0; return; }
    if (first.start >= absoluteOrigin) return; // O(1): nothing fell off the top
    while (this.head < ranges.length) {
      const range = ranges[this.head];
      if (range.end > absoluteOrigin) break;
      this.covered -= range.end - range.start;
      ranges[this.head] = null; // the retired object is released immediately
      this.head++;
    }
    const next = ranges[this.head];
    if (next && next.start < absoluteOrigin) {
      // A surviving range keeps its time; only its start moves up to the new origin.
      this.covered -= absoluteOrigin - next.start;
      next.start = absoluteOrigin;
    }
    if (this.covered < 0) this.covered = 0;
    this._compactHead();
  }

  // A screen rewrite (CSI J / RIS) replaced the visible cells: those rows no longer
  // describe the content their timestamp was recorded for, so the live coverage from
  // `absoluteRow` down is dropped instead of being reported as the new text's time.
  // Retained (scrolled-out) history is untouched because it was not rewritten.
  invalidateFrom(absoluteRow) {
    if (!(absoluteRow >= 0)) return;
    const ranges = this.ranges;
    const first = ranges[this.head];
    if (!first) return;
    // Nothing at or below the origin: no allocation at all.
    if (first.start >= absoluteRow) {
      this.ranges.length = 0;
      this.head = 0;
      this.covered = 0;
      return;
    }
    let next = null;
    let covered = 0;
    for (let index = this.head; index < ranges.length; index++) {
      const range = ranges[index];
      if (range.start >= absoluteRow) break;
      if (!next) next = ranges.slice(this.head, index);
      if (range.end > absoluteRow) range.end = absoluteRow;
      covered += range.end - range.start;
      next.push(range);
    }
    if (!next) return;
    this.ranges = next;
    this.head = 0;
    this.covered = covered;
  }

  // Binary search for the live range containing `row`.
  find(row) {
    const ranges = this.ranges;
    let low = this.head;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const range = ranges[middle];
      if (row < range.start) high = middle - 1;
      else if (row >= range.end) low = middle + 1;
      else return range;
    }
    return null;
  }

  timestampAt(row) {
    const range = this.find(row) || this._findRetained(row);
    if (!range) return undefined;
    if (range.firstWrappedTimestamp !== undefined) {
      // A wrapped suffix continues the logical line that began before the range.
      return row === range.start ? range.firstWrappedTimestamp : range.timestamp;
    }
    return range.timestamp;
  }

  // Ranges fully below `absoluteRow` can be materialized and retired. These rows
  // are outside the retained buffer window, so they are genuinely dropped rather
  // than moved to the retained map.
  takeBefore(absoluteRow, limit = 256) {
    const taken = [];
    const ranges = this.ranges;
    while (this.head < ranges.length && taken.length + (ranges[this.head].end - ranges[this.head].start) <= limit) {
      const range = ranges[this.head];
      if (range.start >= absoluteRow) break;
      const end = Math.min(range.end, absoluteRow);
      taken.push({ start: range.start, end, timestamp: range.timestamp, firstWrappedTimestamp: range.firstWrappedTimestamp });
      if (range.end <= absoluteRow) {
        this.covered -= range.end - range.start;
        ranges[this.head] = null;
        this.head++;
      } else {
        this.covered -= absoluteRow - range.start;
        range.start = absoluteRow;
        break;
      }
      if (taken.length >= 32) break;
    }
    if (this.covered < 0) this.covered = 0;
    this._compactHead();
    return taken;
  }

  // The incremental `covered` counter must always equal a full scan. Tests and
  // diagnostics only; no product path may call this.
  verifyCoverage() { return this._recount() === this.covered; }
}
