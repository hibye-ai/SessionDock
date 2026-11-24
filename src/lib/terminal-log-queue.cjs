'use strict';

// A slow log file must never stop an interactive session.
//
// Before this module, `RotatingLog.writeAt()` returning false caused
// `shell.pause()`, and opening a log file paused the shell for up to ten
// seconds. On a UNC path or a busy disk that stalls the SSH channel window the
// same way a slow screen did, so logging-on output could drop the session.
//
// The transport callback now only enqueues immutable byte pairs. A pump drains
// that queue inside the writer's own remaining budget. When the pump cannot make
// progress it reports a one-shot, explicit log failure and the session stays
// connected: the log is marked incomplete instead of the session being killed.

const { dateParts } = require('./logging-settings.cjs');

const DEFAULTS = {
  sessionBytes: 16 * 1024 * 1024,
  globalBytes: 64 * 1024 * 1024,
  maxStallMs: 2000,
  turnBytes: 256 * 1024,
  turnChunks: 1024,
  // Coalescing must bound the *size* of what it builds, not only the number of
  // objects. Eight-at-a-time merging with no byte ceiling kept re-merging already
  // merged runs: 50,000 admitted 100-byte chunks became one 3,635,200-byte entry,
  // which the real writer refuses on its own 1 MiB buffered-chunk limit
  // (LOG_BACKPRESSURE), so a stalled-then-recovered disk lost 4,983,600 bytes of a
  // 5,000,000-byte recording that the queue had accepted (V8-H-01).
  coalesceBytes: 64 * 1024,
  // The pump never hands the writer more than this in one call. A single admitted
  // entry can legitimately be larger (the transport delivers up to 1 MiB per read),
  // so an oversized entry is written as ordered slices of at most this size and
  // the unwritten remainder stays queued (V8-H-01).
  maxWriteBytes: 64 * 1024,
  // Fragment count is its own bound. 200,000 one-byte fragments used to be
  // admitted as long as their *sum* stayed under the byte cap, which meant the
  // byte counter described almost none of the real memory: each retained entry is
  // an object with three buffer references. Above this many live entries the queue
  // coalesces the oldest small runs into one buffer, so the count stays bounded
  // without ever dropping a byte.
  maxFragments: 4096,
};

const TERMINAL = new Set(['failed', 'closed']);

// A byte reservation shared by every log queue in one process. `sessionBytes`
// bounds one session and `globalBytes` bounds one queue, so before this an SSH log
// and a Telnet log each held their own 64 MiB "global" budget and the real ceiling
// was twice what the name claimed. The owner that creates the queues passes one
// instance; a queue without one keeps a private counter.
class LogBudget {
  constructor(bytes = DEFAULTS.globalBytes) {
    this.capacity = bytes;
    this.used = 0;
  }
  has(extra) { return this.used + extra <= this.capacity; }
  reserve(bytes) { this.used += bytes; }
  release(bytes) { this.used = Math.max(0, this.used - bytes); }
}

class TerminalLogQueue {
  constructor(options = {}) {
    Object.assign(this, DEFAULTS, options);
    this.channels = new Map();
    this.totalQueued = 0;
    // A shared reservation makes `globalBytes` mean "the process", not "this
    // queue": SSH and Telnet each own a queue, and two independent 64 MiB budgets
    // are a 128 MiB ceiling wearing a 64 MiB name.
    this.budget = options.budget instanceof LogBudget ? options.budget : null;
    this.onFailure = typeof options.onFailure === 'function' ? options.onFailure : null;
    this.closed = false;
  }
  get globalUsed() { return this.budget ? this.budget.used : this.totalQueued; }

  // `write(entry)` must return 'ok' (accepted, room left), 'accepted-drain'
  // (accepted, but the writer wants a drain first) or 'failed' (a hard,
  // already-sanitized failure). 'accepted-drain' is what `Writable.write()`
  // returning false means: the bytes ARE buffered, so they must never be
  // written a second time. It is supplied by the transport owner so this module
  // never depends on RotatingLog internals.
  attach(id, write) {
    const state = this.channel(id);
    state.write = write;
    state.generation++;
    state.failure = null;
    state.notified = false;
    return state.generation;
  }

  channel(id) {
    let state = this.channels.get(id);
    if (state) return state;
    state = {
      id, queue: [], head: 0, queuedBytes: 0, queuedLogBytes: 0, droppedBytes: 0, generation: 0,
      write: null, pumping: false, waitingDrain: false, stallTimer: null,
      failure: null, notified: false,
      // Retained *objects*, not only bytes. Each entry holds up to three buffers
      // plus its own header, so a handful of one-byte chunks costs far more than
      // their length suggests.
      fragments: 0, entryOverhead: 0,
    };
    this.channels.set(id, state);
    return state;
  }

  // The real retained cost of one entry: the sum of its *distinct* buffer
  // allocations, and nothing else. The old formula branched on "are all three
  // different?" and fell back to `max(raw+text, formatted)`, which is not a set
  // sum: the common text-log shape `raw === text` (400 B) plus a separate
  // formatted 900 B retained 1,300 bytes but was charged 900 and admitted under a
  // 1,000-byte cap. Identity is tracked per allocation, so an aliased buffer is
  // charged once and a distinct one is charged in full, whatever the combination
  // (V8-M-01).
  //
  // A missing display is NOT an exception. `max(raw, bytes)` charged 400 for an
  // entry whose `raw` and `bytes` were two separate 400-byte allocations — the
  // exact "distinct buffers are retained" contract this method exists to keep
  // (V9-M-02). Only an actual identity is charged once.
  static entryCost(entry) {
    const seen = new Set();
    let cost = 0;
    for (const value of [entry?.raw, entry?.text, entry?.bytes]) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      cost += typeof value.length === 'number' ? value.length : 0;
    }
    return cost;
  }

  // Enqueue only: never touches flow control. Returns true when accepted.
  enqueue(id, entry) {
    if (this.closed) return false;
    const state = this.channel(id);
    // `queuedBytes` is the memory budget: every retained allocation counts, because
    // raw wire bytes and decoded text are both held until the pump retires the
    // entry. `queuedLogBytes` is only what will be written to the file, so an
    // incomplete recording can report a log-byte loss instead of a memory number.
    const logSize = entry.bytes?.length || 0;
    if (!logSize && !entry.raw?.length && !entry.text?.length) return true;
    if (TERMINAL.has(state.failure)) { state.droppedBytes += logSize; return false; }
    // Every *distinct* allocation the entry retains is charged, so a text-log entry
    // whose formatted form is a separate buffer pays for both it and the wire/display
    // copies. Aliased buffers (`raw === bytes` on the raw path) are charged once
    // (V6-H-02, V8-M-01).
    const cost = TerminalLogQueue.entryCost(entry);
    if (state.queuedBytes + cost > this.sessionBytes || this._globalExceeded(cost)) {
      // _fail() accounts for everything still queued; only the rejected chunk is
      // added here, so the reported loss is never counted twice.
      state.droppedBytes += logSize;
      this._fail(state, 'LOG_QUEUE_LIMIT', '세션 로그 저장이 터미널 출력 속도를 따라가지 못했습니다.');
      return false;
    }
    entry.sliceAt = 0;
    state.queue.push(entry);
    // Store the charged cost on the entry so the pump retires exactly what was
    // admitted (the same buffers, the same formatted length).
    entry.cost = cost;
    state.queuedBytes += cost;
    state.queuedLogBytes += logSize;
    this.totalQueued += cost;
    this._reserveGlobal(cost);
    state.fragments++;
    // A one-byte storm must not become one retained object per byte. Coalescing
    // merges the oldest small entries in place, so the count is bounded while the
    // bytes, their order and the totals stay identical.
    if (state.fragments > this.maxFragments) {
      this._coalesce(state);
      // A refused merge is a hard logging failure for this session; the bytes it
      // could not retain (this chunk included) are already counted by `_fail`, so
      // the caller must not believe they were accepted.
      if (TERMINAL.has(state.failure)) return false;
    }
    this.pump(state);
    return true;
  }

  // The process-wide reservation, when the owner supplied one, is authoritative;
  // otherwise this queue's own counter is (a standalone queue in a test).
  _globalExceeded(extra) {
    if (this.budget) return !this.budget.has(extra);
    return this.totalQueued + extra > this.globalBytes;
  }

  _reserveGlobal(cost) {
    if (this.budget) this.budget.reserve(cost);
  }

  _releaseGlobal(cost) {
    if (this.budget) this.budget.release(cost);
  }

  // Concatenates the parts of a merged run that are actually present. A run may
  // mix raw-only, text-only and formatted entries, so each field is joined from
  // the entries that carry it: taking "the last entry's buffer" for a mixed run
  // dropped every earlier byte (V7-H-01).
  static _joinField(items, field) {
    const present = [];
    for (const item of items) if (item && item[field]) present.push(item[field]);
    if (!present.length) return undefined;
    if (present.length === 1) return present[0];
    const buffered = present.every(value => Buffer.isBuffer(value));
    if (buffered) return Buffer.concat(present);
    if (present.every(value => typeof value === 'string')) return present.join('');
    // Mixed/opaque payloads cannot be concatenated safely: keep them as a list so
    // no byte is discarded and the writer still sees every part in order.
    return present;
  }

  // Merges the oldest live entries into larger ones until the fragment count is
  // back inside its bound. Every byte is kept, in order: this only changes how many
  // objects describe the same byte sequence.
  //
  // Only the LIVE suffix is merged. `pump()` retires a consumed entry by writing
  // `null` into its slot and advancing `head`, so every slot before `head` is a
  // dead tombstone. Merging `state.queue` from index 0 included those nulls, which
  // made every `every(item => item?.text)` gate false: the merged run then took the
  // last entry's buffers only and silently discarded the live entries beside it —
  // 20,495 intended bytes became 20,465 written with `dropped=0` (V7-H-01).
  //
  // A run is also bounded in BYTES, not only in member count: eight-at-a-time
  // merging with no ceiling re-merged already merged runs until one entry reached
  // 3.6 MiB, which the real writer refuses outright (V8-H-01).
  _coalesce(state) {
    // Slice the live suffix first, so `head` is 0 and no tombstone can be merged.
    if (state.head > 0) {
      state.queue = state.queue.slice(state.head);
      state.head = 0;
      state.fragments = state.queue.length;
    }
    const live = state.queue.length;
    if (live <= this.maxFragments) return;
    // What the live entries were already charged. Merging reallocates the buffers
    // it joins, so the charge is re-derived from the new shapes and the difference
    // applied: `raw`+`bytes` that were one allocation in every source entry stay one
    // joined allocation, and a run whose alias pattern really changed pays for the
    // additional buffer it now retains (V8-M-01).
    let previousCost = 0;
    for (let slot = 0; slot < live; slot++) {
      const item = state.queue[slot];
      if (item) previousCost += item.cost ?? TerminalLogQueue.entryCost(item);
    }
    const ceiling = this.coalesceBytes;
    // Plan first, allocate second. The merged cost is derived from the run shapes
    // before a single byte is joined, because a merge can legitimately *increase*
    // the charge: aliased sources that become distinct buffers, or a run whose
    // joined display exceeds what its members were charged. Reserving after the
    // fact put `queuedBytes` above `sessionBytes` — the cap the queue promised to
    // honour — without ever reporting a failure (V9-M-02).
    const RUN = 8;
    const plan = [];
    let predicted = 0;
    let index = 0;
    while (index < live) {
      const first = state.queue[index];
      // A partially written entry keeps its exact identity: merging it would hand
      // the writer bytes it already accepted a second time.
      if (!first || (first.sliceAt || 0) > 0) {
        plan.push({ single: first });
        predicted += first ? (first.cost ?? TerminalLogQueue.entryCost(first)) : 0;
        index++;
        continue;
      }
      const day = first.now ? dateParts(first.now).date : undefined;
      const run = [first];
      let size = first.bytes?.length || 0;
      let consumed = 1;
      while (index + consumed < live && run.length < RUN) {
        const next = state.queue[index + consumed];
        if (!next || (next.sliceAt || 0) > 0) break;
        // A merged entry carries one `now`, and `RotatingLog` uses it to choose the
        // daily file. A run that straddles local midnight is therefore split at the
        // day boundary: bytes received before and after midnight must not be written
        // into one day's file with a single timestamp (report §7).
        if (day !== undefined && next.now && dateParts(next.now).date !== day) break;
        // Stop before the ceiling: the next entry would make this run larger than a
        // writer-acceptable chunk, which is exactly what broke the recording.
        const nextSize = next.bytes?.length || 0;
        if (size + nextSize > ceiling) break;
        run.push(next); size += nextSize; consumed++;
      }
      index += consumed;
      // A single member (already at the ceiling, or a lone day/timestamp boundary)
      // stays as it is; the outer loop then starts the next run at the next entry.
      if (run.length < 2) {
        plan.push({ single: first });
        predicted += first.cost ?? TerminalLogQueue.entryCost(first);
      } else {
        plan.push({ run });
        predicted += TerminalLogQueue._mergedCost(run);
      }
    }
    // Only a positive delta needs permission; a merge that retains less frees room.
    // The process ceiling is whichever counter the owner configured — the shared
    // budget when there is one, this queue's own total otherwise.
    const delta = predicted - previousCost;
    if (delta > 0) {
      const roomy = state.queuedBytes + delta <= this.sessionBytes;
      if (!roomy || this._globalExceeded(delta)) {
        // Refuse the merge rather than run over the cap. The queue stays failed and
        // the exhausted run is reported as lost by `_fail`; the buffer plan is
        // thrown away unused, so no allocation was made for a rejected reservation.
        this._fail(state, 'LOG_QUEUE_LIMIT', '세션 로그 저장이 터미널 출력 속도를 따라가지 못했습니다.');
        return;
      }
      this._reserveGlobal(delta);
    }
    const merged = [];
    try {
      for (const step of plan) merged.push(step.single !== undefined ? step.single : TerminalLogQueue._mergeRun(step.run));
    } catch (error) {
      // A failed join leaves the original entries untouched, so release exactly the
      // reservation that was made for it.
      if (delta > 0) this._releaseGlobal(delta);
      this._fail(state, 'LOG_QUEUE_LIMIT', '세션 로그 저장이 터미널 출력 속도를 따라가지 못했습니다.');
      return;
    }
    state.queue = merged;
    state.head = 0;
    state.fragments = merged.length;
    let charged = 0;
    for (const item of merged) {
      const cost = TerminalLogQueue.entryCost(item ?? {});
      if (item) item.cost = cost;
      charged += cost;
    }
    // The estimate is derived from the same shapes the join produces, so this is a
    // reconciliation, not a second decision: whatever the merge really retained is
    // what the counters and the shared budget must hold. `reserved` was granted
    // before any allocation existed; only the difference is applied here.
    const actualDelta = charged - previousCost;
    const reserved = delta > 0 ? delta : 0;
    state.queuedBytes = Math.max(0, state.queuedBytes + actualDelta);
    this.totalQueued = Math.max(0, this.totalQueued + actualDelta);
    if (actualDelta > reserved) this._reserveGlobal(actualDelta - reserved);
    else if (actualDelta < reserved) this._releaseGlobal(reserved - actualDelta);
  }

  // Joins one run, re-aliasing the fields that were aliased in every member.
  // Concatenating each field independently turned a raw-log run — where every chunk
  // hands the same buffer as `raw`, `text` and `bytes` — into three separate
  // allocations, tripling the retained memory the queue must then charge.
  //
  // `text === bytes` is an alias too: a run whose members carry the same buffer as
  // display and payload must join it once, not twice (V9-M-02).
  static _mergeRun(run) {
    const aliasedInAll = (left, right) => run.every(item => item?.[left] && item?.[right] && item[left] === item[right]);
    const rawAliasesBytes = aliasedInAll('raw', 'bytes');
    const rawAliasesText = aliasedInAll('raw', 'text');
    const bytesAliasesText = aliasedInAll('bytes', 'text');
    const raw = TerminalLogQueue._joinField(run, 'raw');
    // Each field is joined at most once: a member-wise alias keeps pointing at the
    // one joined allocation instead of copying the same bytes a second time.
    let bytes;
    if (rawAliasesBytes && raw !== undefined) bytes = raw;
    else bytes = TerminalLogQueue._joinField(run, 'bytes');
    let text;
    if (rawAliasesText && raw !== undefined) text = raw;
    else if (bytesAliasesText && bytes !== undefined) text = bytes;
    else text = TerminalLogQueue._joinField(run, 'text');
    const entry = { bytes, raw, now: run[0]?.now, sliceAt: 0 };
    if (text !== undefined) entry.text = text;
    return entry;
  }

  // Total retained size of one field across a run, computed with the same shape
  // rules as `_joinField` so it predicts the joined allocation exactly without
  // building it.
  static _runFieldSize(run, field) {
    const present = [];
    for (const item of run) if (item && item[field]) present.push(item[field]);
    if (!present.length) return 0;
    const size = value => (typeof value?.length === 'number' ? value.length : 0);
    if (present.length === 1) return size(present[0]);
    const buffered = present.every(value => Buffer.isBuffer(value));
    if (buffered) return present.reduce((total, value) => total + size(value), 0);
    if (present.every(value => typeof value === 'string')) return present.reduce((total, value) => total + size(value), 0);
    // `_joinField` keeps an unconcatenatable mix as a list of parts.
    return present.length;
  }

  // Exactly what `entryCost(_mergeRun(run))` will charge, computed without
  // concatenating anything. `_coalesce` must know the merged cost BEFORE it
  // allocates, otherwise the reservation and the cap check happen after the memory
  // has already been taken and the merged total can exceed the cap the queue
  // promised to stay under (V9-M-02).
  static _mergedCost(run) {
    const aliasedInAll = (left, right) => run.every(item => item?.[left] && item?.[right] && item[left] === item[right]);
    // `_mergeRun` joins `raw` whenever any member carries one; the alias checks
    // require it to be present in *every* member, so a run without raw never aliases.
    const hasRaw = run.some(item => item?.raw);
    const rawAliasesBytes = aliasedInAll('raw', 'bytes');
    const rawAliasesText = aliasedInAll('raw', 'text');
    const bytesAliasesText = aliasedInAll('bytes', 'text');
    const rawSize = TerminalLogQueue._runFieldSize(run, 'raw');
    let cost = rawSize;
    const countsBytes = !(rawAliasesBytes && hasRaw);
    if (countsBytes) cost += TerminalLogQueue._runFieldSize(run, 'bytes');
    if (rawAliasesText && hasRaw) return cost;
    if (bytesAliasesText && countsBytes) return cost;
    return cost + TerminalLogQueue._runFieldSize(run, 'text');
  }

  // One writer-sized piece of an entry. `RotatingLog.writeAt()` refuses a single
  // write that would push its buffered bytes past 1 MiB, so an entry larger than
  // that could never be written at all: the pump reported LOG_BACKPRESSURE and
  // discarded a recording the queue had already accepted. Slicing keeps the order,
  // the per-piece `now` and the entry's own cost, and only advances the cursor after
  // the writer accepted the piece (V8-H-01).
  _piece(entry) {
    const bytes = entry.bytes;
    const total = typeof bytes?.length === 'number' ? bytes.length : 0;
    const at = entry.sliceAt || 0;
    if (at <= 0 && total <= this.maxWriteBytes) return { entry, bytes, end: total, total };
    const end = Math.min(total, at + this.maxWriteBytes);
    const slice = typeof bytes.subarray === 'function' ? bytes.subarray(at, end) : bytes;
    // A shallow copy keeps `now`, `cost` and the rest of the metadata the owner's
    // accounting and the daily-file choice depend on.
    return { entry: { ...entry, bytes: slice, sliceAt: at }, bytes: slice, end, total };
  }

  // Retires one fully written entry and returns exactly what was charged for it.
  // `queuedLogBytes` tracks only *unwritten* log bytes: a sliced entry already
  // released the pieces the writer accepted, so only its tail is subtracted here.
  _retire(state, entry) {
    const cost = entry.cost ?? TerminalLogQueue.entryCost(entry);
    const unwritten = (entry.bytes?.length || 0) - (entry.sliceAt || 0);
    state.queue[state.head] = null;
    state.head++;
    state.fragments = Math.max(0, state.fragments - 1);
    state.queuedBytes -= cost;
    state.queuedLogBytes -= Math.max(0, unwritten);
    this.totalQueued -= cost;
    this._releaseGlobal(cost);
    if (state.queuedBytes < 0) state.queuedBytes = 0;
    if (state.queuedLogBytes < 0) state.queuedLogBytes = 0;
    if (this.totalQueued < 0) this.totalQueued = 0;
  }

  pump(state) {
    if (this.closed || state.pumping || state.waitingDrain || !state.write) return;
    if (TERMINAL.has(state.failure)) return;
    state.pumping = true;
    let more = false;
    try {
      let spent = 0;
      let chunks = 0;
      while (state.head < state.queue.length && spent < this.turnBytes && chunks < this.turnChunks) {
        const entry = state.queue[state.head];
        if (!entry) { this._compact(state); break; }
        const piece = this._piece(entry);
        const result = state.write(piece.entry);
        // 'blocked' means the writer refused the bytes, so they must stay queued.
        if (result === 'blocked') { this._waitDrain(state); return; }
        if (result === 'failed') return; // state.failure is already set
        // Accepted: either fully ('ok') or buffered with a drain wanted
        // ('accepted-drain'). Both mean these bytes must never be sent again, so the
        // entry's cursor advances now and only an unwritten tail stays queued.
        const accepted = piece.bytes?.length || 0;
        if (piece.entry !== entry) {
          entry.sliceAt = piece.end;
          // The writer owns these log bytes now; only the tail is still pending.
          state.queuedLogBytes = Math.max(0, state.queuedLogBytes - accepted);
        }
        spent += accepted;
        chunks++;
        const complete = piece.end >= piece.total;
        // 'accepted-drain' means the writer DID buffer these bytes and only wants
        // a drain first. Retiring the entry is mandatory: re-writing it
        // duplicated output once the pump resumed after a stop.
        if (result === 'accepted-drain') {
          if (complete) this._retire(state, entry);
          this._compact(state);
          this._waitDrain(state);
          return;
        }
        if (!complete) continue;
        this._retire(state, entry);
      }
      this._compact(state);
      more = state.head < state.queue.length;
    } finally {
      state.pumping = false;
      this.onProgress?.(state.id, state.generation);
      if (more && !state.waitingDrain && !TERMINAL.has(state.failure)) {
        // More work than one turn: yield so timers, cancellation and the other
        // connections keep running.
        setImmediate(() => { if (this.channels.get(state.id) === state) this.pump(state); });
      }
    }
  }

  _waitDrain(state) {
    if (state.waitingDrain) return;
    state.waitingDrain = true;
    state.stallTimer = setTimeout(() => {
      state.stallTimer = null;
      if (!state.waitingDrain) return;
      this._fail(state, 'LOG_STALLED', '세션 로그 저장이 터미널 출력 속도를 따라가지 못했습니다.');
    }, this.maxStallMs);
    state.stallTimer.unref?.();
  }

  // Called by the transport owner when the writer emits 'drain'.
  drained(id, generation) {
    const state = this.channels.get(id);
    if (!state) return;
    // A late drain from a previous writer must not revive a new log attempt.
    if (generation !== undefined && generation !== state.generation) return;
    clearTimeout(state.stallTimer);
    state.stallTimer = null;
    state.waitingDrain = false;
    this.pump(state);
  }

  // The transport owner reports a hard writer failure (ENOSPC, closed stream,
  // LOG_BACKPRESSURE).
  fail(id, code, message) {
    const state = this.channels.get(id);
    if (!state) return;
    this._fail(state, code, message);
  }

  _fail(state, code, message) {
    if (TERMINAL.has(state.failure)) return;
    state.failure = 'failed';
    clearTimeout(state.stallTimer);
    state.stallTimer = null;
    state.waitingDrain = false;
    // Report the loss in log bytes, not retained memory: raw and text copies of
    // the same chunk are both buffered, but only one of them was to be written.
    state.droppedBytes += state.queuedLogBytes;
    this.totalQueued -= state.queuedBytes;
    if (this.totalQueued < 0) this.totalQueued = 0;
    this._releaseGlobal(state.queuedBytes);
    state.queuedBytes = 0;
    state.queuedLogBytes = 0;
    state.queue.length = 0;
    state.head = 0;
    state.fragments = 0;
    if (state.notified) return;
    state.notified = true;
    this.onProgress?.(state.id, state.generation);
    if (this.onFailure) {
      try { this.onFailure({ id: state.id, code, message, droppedLogBytes: state.droppedBytes, generation: state.generation }); }
      catch { /* the owner must not break the queue */ }
    }
  }

  _compact(state) {
    if (state.head > 1024 && state.head * 2 >= state.queue.length) {
      state.queue = state.queue.slice(state.head);
      state.head = 0;
    }
    if (state.head >= state.queue.length) { state.queue.length = 0; state.head = 0; }
  }

  pending(id) {
    const state = this.channels.get(id);
    return state ? state.queuedBytes : 0;
  }

  dropped(id) {
    return this.channels.get(id)?.droppedBytes || 0;
  }

  failed(id) {
    const state = this.channels.get(id);
    return !!state && state.failure === 'failed';
  }

  // Bounded wait used only when a session is ending; the display final status is
  // emitted independently of this.
  async flush(id, timeoutMs = 1000) {
    const state = this.channels.get(id);
    if (!state) return true;
    const deadline = Date.now() + timeoutMs;
    this.pump(state);
    while (state.queuedBytes > 0 && !TERMINAL.has(state.failure)) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 5));
      this.pump(state);
    }
    return state.queuedBytes === 0;
  }

  // Returns the bytes that were accepted for the log but can no longer be
  // written. The memory figure is larger when raw and text are both retained, and
  // the test contract checks the retained bytes, so that is what is returned; the
  // log-byte figure is exposed separately through logPending().
  release(id) {
    const state = this.channels.get(id);
    if (!state) return 0;
    clearTimeout(state.stallTimer);
    state.stallTimer = null;
    this.totalQueued -= state.queuedBytes;
    if (this.totalQueued < 0) this.totalQueued = 0;
    const lost = state.queuedBytes;
    state.droppedBytes += state.queuedLogBytes;
    this._releaseGlobal(state.queuedBytes);
    state.queue.length = 0;
    state.queuedBytes = 0;
    state.queuedLogBytes = 0;
    state.head = 0;
    state.fragments = 0;
    state.failure = 'closed';
    state.write = null;
    this.channels.delete(id);
    return lost;
  }

  // Bytes still awaiting the writer, counted as log bytes rather than retained
  // memory. Used by the incomplete-recording report.
  logPending(id) {
    const state = this.channels.get(id);
    return state ? state.queuedLogBytes : 0;
  }

  close() {
    for (const id of [...this.channels.keys()]) this.release(id);
    this.channels.clear();
    this.totalQueued = 0;
    this.closed = true;
  }
}

module.exports = { TerminalLogQueue, LogBudget, DEFAULTS: { ...DEFAULTS } };
