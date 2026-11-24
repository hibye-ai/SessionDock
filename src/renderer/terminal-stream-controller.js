// Renderer-side throughput control for one terminal.
//
// Before this module every IPC event was handed to `terminal.write()` in the
// same task that received it, so a 50,000-line burst produced hundreds of
// concurrent parser writes plus a full-screen gutter/semantic pass per write.
// The main thread then stopped responding (Ctrl+C, tab switch) while xterm's
// own queue grew without bound.
//
// This controller owns exactly one outstanding `terminal.write()` per terminal,
// splits each IPC event into adaptive 4-32 KiB slices, yields to a macrotask
// between slices, acknowledges only after the last slice of that event has been
// parsed, and drives a shared burst/settling state machine that quiets the
// decorations while output is still arriving.

const MIN_SLICE = 4 * 1024;
const MAX_SLICE = 32 * 1024;
const START_SLICE = 16 * 1024;
const IDLE_ECHO_BYTES = 1024;

// Rolling byte window. The buckets exist only to spread the measurement over
// time; `BURST_WINDOW_MS` is the window that is actually compared, so the
// documented "128 KiB per 100 ms" is what the state machine uses instead of the
// full ring (which used to compare up to 800 ms of history).
const BUCKET_MS = 50;
const BUCKET_COUNT = 8;
const BURST_WINDOW_MS = 100;
const BUCKET_LOOKBACK = Math.min(BUCKET_COUNT, Math.max(1, Math.ceil(BURST_WINDOW_MS / BUCKET_MS)));
const BURST_BYTES_PER_100MS = 128 * 1024;
const BURST_QUEUED_BYTES = 128 * 1024;
const SETTLE_QUIET_MS = 200;
// How often the burst state re-checks itself while no output arrives. The byte
// window empties with time, so a timer must re-evaluate even when nothing is
// enqueued or acknowledged; without it a terminal stayed in `burst` (and its
// semantic/gutter addons stayed suppressed) until unrelated output arrived.
const SETTLE_POLL_MS = 100;
const SLOW_SLICE_MS = 12;
const FAST_SLICE_MS = 3;
const FAST_STREAK = 8;

// One scheduler per renderer keeps every terminal honest: a foreground tab gets
// the first turn, but rotation guarantees the background tabs are not starved.
function createStreamScheduler({ preferMessageChannel = typeof window !== 'undefined' } = {}) {
  let channel = null;
  let usingMessageChannel = false;
  if (preferMessageChannel) {
    try {
      channel = new MessageChannel();
      usingMessageChannel = true;
    } catch { channel = null; }
  }
  const controllers = [];
  let cursor = 0;
  let pending = false;
  let timer = null;
  let disposed = false;

  const hasRunnable = () => {
    for (const controller of controllers) if (controller.runnable()) return true;
    return false;
  };

  const schedule = () => {
    if (pending || disposed) return;
    pending = true;
    if (usingMessageChannel) { channel.port2.postMessage(0); return; }
    timer = setTimeout(run, 0);
    timer.unref?.();
  };

  function run() {
    pending = false;
    timer = null;
    if (disposed) return;
    const count = controllers.length;
    if (!count) return;
    // One terminal, one slice per turn: a terminal whose previous write has not
    // returned yet is skipped instead of queued twice.
    //
    // The turn keeps its own start cursor. The previous loop mutated `cursor`
    // inside the scan, so with three terminals where only the middle one was
    // runnable the visit order became 0 → 2 → 2 and the runnable one was never
    // reached: `hasRunnable()` stayed true (so an endless MessageChannel task
    // spin) while no terminal ever stepped. Advance the cursor only past the
    // terminal that was actually served.
    const start = ((cursor % count) + count) % count;
    for (let step = 0; step < count; step++) {
      const index = (start + step) % count;
      const controller = controllers[index];
      if (!controller || controller.disposed || !controller.runnable()) continue;
      cursor = (index + 1) % count;
      controller.step();
      break;
    }
    if (hasRunnable()) schedule();
  }

  if (usingMessageChannel) {
    channel.port1.onmessage = run;
    channel.port1.start?.();
  }

  return {
    add(controller) { if (!controllers.includes(controller)) { controllers.push(controller); schedule(); } },
    remove(controller) {
      const index = controllers.indexOf(controller);
      if (index >= 0) { controllers.splice(index, 1); if (cursor > index) cursor--; }
    },
    // A terminal whose write callback just returned asks for the next turn.
    wake() { schedule(); },
    dispose() {
      disposed = true;
      controllers.length = 0;
      if (usingMessageChannel) { channel.port1.onmessage = null; try { channel.port1.close(); channel.port2.close(); } catch {} }
      else if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
    },
    get size() { return controllers.length; },
  };
}

const sharedScheduler = createStreamScheduler();

class TerminalStreamController {
  constructor({ terminal, semantic = null, gutter = null, acknowledge = null, isCurrent = null,
    observe = null, onStateChange = null, onConsumerError = null,
    now = () => performance.now(), scheduler = sharedScheduler, ackOnEverySlice = false,
    connectionId = null } = {}) {
    if (!terminal) throw new TypeError('TerminalStreamController requires a terminal.');
    this.terminal = terminal;
    this.semantic = semantic;
    this.gutter = gutter;
    this.acknowledge = acknowledge;
    this.isCurrent = isCurrent || (() => true);
    this.observe = observe;
    this.onStateChange = onStateChange;
    this.onConsumerError = onConsumerError;
    this.connectionId = connectionId;
    this.now = now;
    this.scheduler = scheduler;
    this.ackOnEverySlice = ackOnEverySlice;

    this.queue = [];
    this.head = 0;
    this.queuedBytes = 0;
    this.outstanding = null;
    // Bumped whenever the queue is abandoned for a new connection. A parser
    // callback from the previous generation must never acknowledge the new one.
    this.epoch = 0;
    this.failed = false;
    this.sliceBytes = START_SLICE;
    this.fastStreak = 0;
    this.slowStreak = 0;
    this.disposed = false;
    this.visible = true;
    // Establish explicit visibility even when the first layout also says true.
    // Standalone addons without a controller retain their DOM visibility fallback.
    try { this.semantic?.setVisible?.(true); } catch {}

    this.state = 'normal';
    this.backendBurst = false;
    this.lastDataAt = 0;
    this.lastQueueDrainAt = 0;
    this.lastSliceAt = 0;
    this.buckets = new Float64Array(BUCKET_COUNT);
    this.bucketIndex = 0;
    this.bucketStart = null;
    this.settleHandle = null;

    this.counters = {
      events: 0, slices: 0, bytes: 0, acked: 0, ackSequences: 0,
      stateTransitions: 0, burstEntries: 0, sliceMax: 0,
      latencySamples: 0, latencyTotal: 0, latencyMax: 0, slowSlices: 0,
      maxQueuedBytes: 0, droppedEvents: 0, consumerErrors: 0,
    };
    this.scheduler.add(this);
  }

  // ---- queue ---------------------------------------------------------------

  enqueue({ bytes, sequence }) {
    if (this.disposed) return;
    if (!bytes || !bytes.length) return;
    // After a consumer failure the parser refused bytes: retaining more would
    // only grow memory with data that can never be displayed or acknowledged.
    // The main side reports the unacknowledged backlog explicitly instead.
    if (this.failed) return;
    // The controller may outlive the connection it was built for (a reconnect
    // reuses the record and only swaps its id). A stale enqueue must not start
    // driving a terminal that no longer belongs to it.
    if (!this._current()) return;
    // Never copy a typed array the preload already handed over as a byte view.
    const view = bytes instanceof Uint8Array ? bytes
      : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
    this.queue.push({ view, sequence: Number.isSafeInteger(sequence) ? sequence : null, offset: 0 });
    this.queuedBytes += view.length;
    this.counters.events++;
    // Peak backlog is a watermark of the retained queue, not of the newest
    // event: comparing the event size under-reported a 50k-line burst.
    if (this.queuedBytes > this.counters.maxQueuedBytes) this.counters.maxQueuedBytes = this.queuedBytes;
    this._recordBytes(view.length);
    this._evaluateState();
    this.scheduler.wake();
  }

  _current() {
    if (this.disposed) return false;
    try { return this.isCurrent() !== false; } catch { return false; }
  }

  runnable() {
    if (this.disposed || this.outstanding || this.failed) return false;
    if (this.head >= this.queue.length) return false;
    return this._current();
  }

  // Time-based rolling window. Buckets age on every read as well as on every
  // write, so bytes stop counting once they are older than the window even when
  // no new output arrives.
  _ageBuckets(at) {
    // `null`, not 0: a controller under test (or a monotonic clock) may legitimately
    // report 0 as its first timestamp, and treating that as "unset" made the window
    // never age.
    if (this.bucketStart === null) { this.bucketStart = at; return; }
    const elapsed = at - this.bucketStart;
    if (elapsed < BUCKET_MS) return;
    const advance = Math.floor(elapsed / BUCKET_MS);
    const steps = Math.min(advance, BUCKET_COUNT);
    for (let index = 0; index < steps; index++) {
      this.bucketIndex = (this.bucketIndex + 1) % BUCKET_COUNT;
      this.buckets[this.bucketIndex] = 0;
    }
    this.bucketStart += advance * BUCKET_MS;
    return;
  }

  _recordBytes(length) {
    const at = this.now();
    this._ageBuckets(at);
    this.buckets[this.bucketIndex] += length;
    this.lastDataAt = at;
  }

  // Only the buckets inside BURST_WINDOW_MS are summed. The previous version
  // added the whole ring (up to 800 ms) while documenting a 100 ms threshold,
  // which both overstated pressure and kept a terminal in burst long after the
  // burst had ended.
  _recentBytes() {
    this._ageBuckets(this.now());
    let total = 0;
    for (let step = 0; step < BUCKET_LOOKBACK; step++) {
      const index = (this.bucketIndex - step + BUCKET_COUNT) % BUCKET_COUNT;
      total += this.buckets[index];
    }
    return total;
  }

  // ---- state machine -------------------------------------------------------

  _evaluateState() {
    if (this.disposed) return;
    const at = this.now();
    const recent = this._recentBytes();
    const pressure = this.backendBurst
      || recent >= BURST_BYTES_PER_100MS
      || this.queuedBytes >= BURST_QUEUED_BYTES
      // A slow-parser streak only means pressure while writes are still being
      // parsed. Without this expiry a terminal that ended in a slow streak could
      // never leave burst, because no further callback would reset the streak.
      || (this.slowStreak >= 2 && at - this.lastSliceAt < SETTLE_QUIET_MS);
    if (pressure) {
      this._cancelSettle();
      if (this.state !== 'burst') this._setState('burst');
      this._armSettlePoll();
    } else if (this.state === 'burst') {
      this._armSettle();
    }
  }

  // Re-evaluates the byte window on a timer while the terminal is in burst, so
  // the quiet period is measured in real time instead of waiting for the next
  // enqueue that may never come.
  _armSettlePoll() {
    if (this.settlePoll || this.disposed) return;
    this.settlePoll = setTimeout(() => {
      this.settlePoll = null;
      if (this.disposed) return;
      if (this.state !== 'burst') return;
      this._evaluateState();
    }, SETTLE_POLL_MS);
    this.settlePoll.unref?.();
  }

  _cancelSettle() {
    if (this.settleHandle) { clearTimeout(this.settleHandle); this.settleHandle = null; }
  }

  _setState(next) {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.counters.stateTransitions++;
    if (next === 'burst') this.counters.burstEntries++;
    this._cancelSettle();
    try { this.semantic?.setStreamingMode?.(next); } catch {}
    try { this.gutter?.setStreamingMode?.(next); } catch {}
    this.onStateChange?.(next, previous);
  }

  // Settling starts only when the queue is empty, no write is outstanding, the
  // backend hint is off and no data arrived for SETTLE_QUIET_MS. A visible rAF
  // loop alone never keeps a terminal in burst.
  _armSettle() {
    if (this.settleHandle || this.disposed) return;
    const quietFor = this.now() - Math.max(this.lastDataAt, this.lastQueueDrainAt);
    const wait = Math.max(0, SETTLE_QUIET_MS - quietFor);
    this.settleHandle = setTimeout(() => {
      this.settleHandle = null;
      if (this.disposed) return;
      if (this.backendBurst || this.head < this.queue.length || this.queuedBytes > 0 || this.outstanding) {
        this._evaluateState();
        return;
      }
      if (this.now() - this.lastDataAt < SETTLE_QUIET_MS) { this._armSettle(); return; }
      // Bytes still inside the rolling window are not pressure by themselves (the
      // quiet period already elapsed), so settling is allowed to proceed.
      this._setState('settling');
      // Settling repaints the viewport with a 2ms/frame budget; when that work
      // reports completion (or after the bounded window) the terminal is normal.
      this._finishSettling();
    }, wait + 1);
    this.settleHandle.unref?.();
  }

  _finishSettling() {
    if (this.disposed) return;
    const done = () => {
      if (this.disposed) return;
      if (this.state !== 'settling') return;
      if (this.head < this.queue.length || this.backendBurst) { this._setState('burst'); return; }
      this._setState('normal');
    };
    try { this.semantic?.completeSettling?.(done); } catch { done(); }
    if (this.state === 'settling') setTimeout(done, 500);
  }

  setPressure({ burst }) {
    if (this.disposed) return;
    const next = !!burst;
    if (next === this.backendBurst) return;
    this.backendBurst = next;
    this._evaluateState();
  }

  // Visibility only affects visual work. Parsing, ACKs and timestamps continue,
  // so a hidden tab keeps draining and a minimized window never loses output.
  setVisible(visible) {
    if (this.visible === !!visible) return;
    this.visible = !!visible;
    try { this.semantic?.setVisible(this.visible); } catch {}
    try { this.gutter?.setVisible(this.visible); } catch {}
  }

  // ---- write pump ----------------------------------------------------------

  step() {
    if (!this.runnable()) return;
    const epoch = this.epoch;
    const entry = this.queue[this.head];
    const remaining = entry.view.length - entry.offset;
    const size = remaining <= IDLE_ECHO_BYTES ? remaining : Math.min(remaining, this.sliceBytes);
    const slice = entry.view.subarray(entry.offset, entry.offset + size);
    entry.offset += size;
    const isLast = entry.offset >= entry.view.length;
    const sequence = isLast ? entry.sequence : null;

    if (isLast) {
      this.queue[this.head] = null;
      this.head++;
      if (this.head >= this.queue.length) { this.queue.length = 0; this.head = 0; }
      else if (this.head > 256 && this.head * 2 >= this.queue.length) { this.queue = this.queue.slice(this.head); this.head = 0; }
      this.queuedBytes -= entry.view.length;
      if (this.queuedBytes < 0) this.queuedBytes = 0;
      this.lastQueueDrainAt = this.now();
    }

    this.counters.slices++;
    this.counters.bytes += size;
    if (size > this.counters.sliceMax) this.counters.sliceMax = size;
    this.lastSliceAt = this.now();
    this.outstanding = { startedAt: this.now(), size, sequence, epoch };

    // Feeds the existing privacy/repaint observers once per submitted slice
    // instead of once per IPC event, and never re-scans the transcript.
    try { this.observe?.(slice); } catch {}

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      // A callback from a previous connection generation must not touch this
      // one: it would clear the new outstanding write and ACK a sequence the new
      // parser never saw.
      if (epoch !== this.epoch) return;
      this._onSliceParsed(size, sequence);
    };
    try {
      // One outstanding write: the next slice is submitted from this callback
      // through the shared scheduler, never from the same call stack.
      this.terminal.write(slice, done);
    } catch (error) {
      // The parser refused the bytes: they were NOT consumed. Calling done() here
      // acknowledged an event the terminal never parsed, which is silent data
      // loss. Report a consumer failure instead and stop the pump; the queued
      // bytes stay unacknowledged so the main side reports them as pending.
      this._consumerFailed(error);
    }
    // xterm may invoke the callback synchronously for an empty/buffered write;
    // `settled` keeps the accounting single.
  }

  // A parser that throws is a consumer failure, not a parse. Never ACK: the
  // renderer (and the main-side watchdog) must see the bytes as unparsed.
  _consumerFailed(error) {
    this.failed = true;
    this.outstanding = null;
    this.counters.consumerErrors = (this.counters.consumerErrors || 0) + 1;
    this.error = error;
    if (this.settleHandle) { clearTimeout(this.settleHandle); this.settleHandle = null; }
    try { this.onConsumerError?.(error); } catch {}
  }

  _onSliceParsed(size, sequence) {
    const started = this.outstanding?.startedAt;
    this.outstanding = null;
    if (this.disposed) return;
    if (started !== undefined) {
      const latency = this.now() - started;
      this.counters.latencySamples++;
      this.counters.latencyTotal += latency;
      if (latency > this.counters.latencyMax) this.counters.latencyMax = latency;
      if (latency > SLOW_SLICE_MS) {
        this.slowStreak++;
        this.fastStreak = 0;
        this.counters.slowSlices++;
        if (size > MIN_SLICE) this.sliceBytes = Math.max(MIN_SLICE, Math.floor(size / 2));
      } else if (latency < FAST_SLICE_MS) {
        this.fastStreak++;
        this.slowStreak = 0;
        if (this.fastStreak >= FAST_STREAK && this.sliceBytes < MAX_SLICE) {
          this.sliceBytes = Math.min(MAX_SLICE, this.sliceBytes + MIN_SLICE);
          this.fastStreak = 0;
        }
      } else {
        this.slowStreak = 0;
        this.fastStreak = 0;
      }
    }
    // ACK only after the parser consumed the last slice of this IPC event.
    if (sequence !== null && sequence !== undefined) {
      this.counters.acked++;
      this.counters.ackSequences++;
      try { this.acknowledge?.(sequence); } catch {}
    }
    this._evaluateState();
    if (this.head < this.queue.length) this.scheduler.wake();
    else this._evaluateState();
  }

  // ---- introspection -------------------------------------------------------

  snapshot() {
    return {
      state: this.state, visible: this.visible, queuedBytes: this.queuedBytes,
      queuedEvents: this.queue.length - this.head, outstanding: !!this.outstanding,
      sliceBytes: this.sliceBytes, backendBurst: this.backendBurst,
      recentBytes: this._recentBytes(), failed: !!this.failed,
      connectionId: this.connectionId, epoch: this.epoch, ...this.counters,
      latencyMean: this.counters.latencySamples
        ? Number((this.counters.latencyTotal / this.counters.latencySamples).toFixed(3)) : 0,
    };
  }

  // Kept for callers that only want the pressure numbers.
  get pendingBytes() { return this.queuedBytes; }

  // A reconnect keeps the record (and therefore this controller) but changes the
  // connection id. Abandoning the old queue must also retire its generation, so a
  // late parser callback from the previous connection cannot acknowledge output
  // that now belongs to the new one.
  reset(connectionId = this.connectionId) {
    this.epoch++;
    this.connectionId = connectionId;
    if (this.settleHandle) { clearTimeout(this.settleHandle); this.settleHandle = null; }
    if (this.settlePoll) { clearTimeout(this.settlePoll); this.settlePoll = null; }
    for (let index = this.head; index < this.queue.length; index++) this.queue[index] = null;
    this.queue.length = 0;
    this.head = 0;
    this.queuedBytes = 0;
    this.outstanding = null;
    this.failed = false;
    this.error = null;
    this.buckets.fill(0);
    this.bucketIndex = 0;
    this.bucketStart = null;
    this.lastDataAt = 0;
    this.lastQueueDrainAt = 0;
    this.lastSliceAt = 0;
    this.slowStreak = 0;
    this.fastStreak = 0;
    // The backend burst hint belongs to the *previous* connection. A new connection
    // has not sent one yet, so keeping it left the terminal in `burst` with an empty
    // queue and no outstanding slice until (and unless) the new backend volunteered a
    // `false` hint (V8-L-01).
    this.backendBurst = false;
    // A fresh epoch must also start from the adaptive slice size, not inherit the
    // previous connection's ramp (a fast LAN session left a slow link at 64 KiB).
    this.sliceBytes = START_SLICE;
    if (this.state !== 'normal') this._setState('normal');
    else this._cancelSettle();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    if (this.settleHandle) { clearTimeout(this.settleHandle); this.settleHandle = null; }
    if (this.settlePoll) { clearTimeout(this.settlePoll); this.settlePoll = null; }
    this.scheduler.remove(this);
    // Old callbacks must never touch a new record: they only observe `disposed`
    // and the epoch they captured.
    for (let index = this.head; index < this.queue.length; index++) this.queue[index] = null;
    this.queue.length = 0;
    this.head = 0;
    this.queuedBytes = 0;
    this.outstanding = null;
  }
}

module.exports = { TerminalStreamController, createStreamScheduler, sharedScheduler, MIN_SLICE, MAX_SLICE, START_SLICE };
