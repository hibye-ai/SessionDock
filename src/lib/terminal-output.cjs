'use strict';

// IPC credit and receive backpressure are separate budgets. Spending the 256 KiB
// IPC credit does not pause SSH. A much larger receive high/low-water budget does:
// only the terminal channel's stdout/stderr, never its shared TCP transport.
// The hard caps remain the last-resort guard for an uncooperative source.
// Managed SSH shells open with zero wire credit. Budget-owned grants reserve
// raw bytes and decoder expansion BEFORE WINDOW_ADJUST; idle shells cost no
// fixed HWM reservation and lack of capacity waits instead of rejecting opens.
//
// Bytes live in a head-index array of immutable buffers, so taking a batch is
// O(batch) and never re-indexes the queue. Small writes are coalesced into
// accumulators that grow up to 32 KiB, so a 200k single-byte burst cannot create
// 200k fragments while isolated output avoids allocating a full slab.
//
// Delivery is adaptively micro-batched. A coalescing timer alone was not enough:
// the receive path flushed synchronously whenever the backlog was small and an
// ACK flushed unconditionally, so an ACK-paced stream of 160-byte chunks still
// produced one IPC event per chunk (~17,000 events for one 50k-line stream) and
// the main thread spent its frame budget on message plumbing. The three instant
// paths below are the interactivity contract and are never delayed:
//
//   * a full batch (waiting cannot help),
//   * the first output after a quiet gap (prompt / banner / login question),
//   * one bounded key echo inside the window main opened with noteInput().
//
// Everything else waits for a 2–4ms deadline. Byte order, ACK sequencing and the
// final-status ordering are unchanged: coalescing only changes how many bytes
// travel per IPC event, never which bytes or in what order.

const DEFAULTS = {
  batchBytes: 32 * 1024,
  inFlightBytes: 256 * 1024,
  inFlightBatches: 16,
  globalInFlightBytes: 2 * 1024 * 1024,
  flushDelayMs: 4,
  interactiveBytes: 1024,
  burstBacklogBytes: 512 * 1024,
  receiveSoftBytes: 32 * 1024 * 1024,
  receiveResumeBytes: 16 * 1024 * 1024,
  receiveHardBytes: 64 * 1024 * 1024,
  globalReceiveHardBytes: 256 * 1024 * 1024,
  flushTurnBytes: 256 * 1024,
  flushTurnMs: 2,
  drainTimeoutMs: 5000,
  statsIntervalMs: 250,
  slabBytes: 32 * 1024,
  maxSourceFragments: 4096,
  ackSampleRing: 1024,
  // Adaptive micro-batching. Both windows are far below a 60Hz frame (16.67ms),
  // so a coalesced batch is always displayed on the next animation frame.
  coalesceDelayMs: 2,
  coalesceMaxDelayMs: 4,
  // Event-density detector with hysteresis: `sustainedArrivals` chunks inside
  // `sustainedArrivalWindowMs` mark the stream sustained for
  // `sustainedHysteresisMs`, so a short quiet gap mid-stream cannot flip the
  // policy back to per-chunk sends.
  sustainedArrivalWindowMs: 16,
  sustainedArrivals: 4,
  sustainedHysteresisMs: 120,
  // A gap at least this wide means the previous exchange finished: the next byte
  // is a prompt or a reply and is sent synchronously.
  idleGapMs: 40,
  // One bounded key-echo fast flush per input, sized by `interactiveBytes`.
  echoWindowMs: 16,
  echoBudgetBytes: 1024,
};

const LATENCY_EDGES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096];
// How many finished ids keep a tombstone. Large enough that a late push from the
// transport for a just-closed session is still recognised as a ghost.
const COMPLETED_RETENTION = 4096;

function positiveInteger(name, value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}.`);
  }
  return value;
}

class TerminalOutput {
  constructor(options = {}) {
    const settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (options[key] === undefined) continue;
      // interactiveBytes/burstBacklogBytes may be 0; everything else needs a
      // positive value.
      const minimum = key === 'flushDelayMs' || key === 'interactiveBytes' || key === 'burstBacklogBytes'
        || key === 'coalesceDelayMs' || key === 'coalesceMaxDelayMs' ? 0 : 1;
      settings[key] = positiveInteger(key, options[key], minimum);
    }
    // Legacy names: `highWater` was the IPC credit, `delayMs` the coalescing
    // timer. Neither ever means "receive backlog".
    if (options.highWater !== undefined && options.inFlightBytes === undefined) {
      settings.inFlightBytes = positiveInteger('highWater', options.highWater);
    }
    if (options.delayMs !== undefined && options.flushDelayMs === undefined) {
      settings.flushDelayMs = positiveInteger('delayMs', options.delayMs, 0);
    }
    // `flushDelayMs`/`delayMs` still mean "the coalescing window", so an explicit
    // value keeps controlling batching instead of being silently ignored.
    if (options.coalesceDelayMs === undefined && (options.flushDelayMs !== undefined || options.delayMs !== undefined)) {
      settings.coalesceDelayMs = settings.flushDelayMs;
      if (options.coalesceMaxDelayMs === undefined) settings.coalesceMaxDelayMs = settings.flushDelayMs;
    }
    if (settings.coalesceMaxDelayMs < settings.coalesceDelayMs) settings.coalesceMaxDelayMs = settings.coalesceDelayMs;
    if (settings.batchBytes > settings.inFlightBytes) throw new TypeError('batchBytes must not exceed inFlightBytes.');
    if (settings.receiveResumeBytes >= settings.receiveSoftBytes) throw new TypeError('receiveResumeBytes must be below receiveSoftBytes.');
    if (settings.receiveSoftBytes >= settings.receiveHardBytes) throw new TypeError('receiveSoftBytes must be below receiveHardBytes.');
    if (settings.globalInFlightBytes < settings.inFlightBytes) throw new TypeError('globalInFlightBytes must not be below inFlightBytes.');
    if (settings.globalReceiveHardBytes < settings.receiveHardBytes) throw new TypeError('globalReceiveHardBytes must not be below receiveHardBytes.');
    if (typeof options.send !== 'function') throw new TypeError('TerminalOutput requires send().');

    Object.assign(this, settings);
    this.send = options.send;
    // Display pressure is a hint for the renderer's addons; it never pauses a
    // transport. `pause`/`resume` from the previous API are ignored on purpose.
    this.onPressure = typeof options.onPressure === 'function' ? options.onPressure : null;
    this.onOverflow = typeof options.onOverflow === 'function' ? options.onOverflow : null;
    this.onReceivePressure = typeof options.onReceivePressure === 'function' ? options.onReceivePressure : null;
    this.receiveSources = new Map();
    this.receiveRebalancing = false;
    this.receiveCursor = 0;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.schedule = typeof options.schedule === 'function' ? options.schedule : fn => setImmediate(fn);

    this.channels = new Map();
    this.readyQueue = [];
    // Channels that still hold bytes but could not be sent because the session or
    // global IPC credit was spent. They are not in `readyQueue` (that would spin),
    // so nothing used to wake them: an ACK only flushed its own channel, and a
    // quiet session whose credit had been taken by a burst never ran again until
    // fresh data arrived. Membership here is what an ACK drains.
    this.blocked = new Set();
    this.sequence = 0;
    this.generation = 0;
    this.totalQueued = 0;
    this.totalInFlight = 0;
    this.pumpHandle = null;
    this.disposed = false;
    this.overflowed = new Set();
    // Ids whose final event was already emitted. A push or a second finish for
    // such an id used to recreate the channel and emit a ghost `data` event after
    // the final status, or send a second status (V6-M-04).
    this.completed = new Map();
    this.latencyRing = new Float64Array(Math.min(this.ackSampleRing, 1024));
    this.latencyIndex = 0;
    this.latencyCount = 0;
    this.latencyTotal = 0;
    this.latencyMax = 0;
    this.stats = {
      bytes: 0, batches: 0, pauses: 0, maxBufferedBytes: 0, drainTimeouts: 0,
      discardedBytes: 0, overflowCount: 0, rejectedBytes: 0,
      peakQueuedBytes: 0, peakInFlightBytes: 0,
      // A push for an id whose final event was already emitted, and a push from a
      // transport whose renderer epoch was retired, are both dropped without
      // creating a channel (V9-M-05). They are counted separately from
      // `rejectedBytes`, which only ever means "accepted input the consumer could
      // not take".
      latePushes: 0, latePushBytes: 0, staleOwnerPushes: 0, staleOwnerBytes: 0,
    };
  }

  // ---- channel lifecycle ---------------------------------------------------

  channel(id) {
    let channel = this.channels.get(id);
    if (channel) return channel;
    channel = {
      id, generation: ++this.generation,
      chunks: [], head: 0, headOffset: 0, acc: null, accUsed: 0, queuedBytes: 0,
      pending: new Map(), inFlightBytes: 0,
      receivedPosition: 0, sentPosition: 0,
      barriers: [], drains: [], timer: null, finalTimer: null, final: null,
      softPressure: false, burstPressure: false, lastPressureAt: 0,
      ready: false, disposed: false, flushing: false, overflowed: false,
      rejectedBytes: 0, completed: false,
      // Adaptive micro-batching state. `dueAt` is the deadline of the *first*
      // queued byte, so a producer cannot postpone delivery by pushing again
      // (no debounce). `arrivals`/`sustainedUntil` are the event-density detector
      // with hysteresis; `echoBudget`/`echoUntil` are the one-shot input fast path.
      lastReceiveAt: -Infinity, arrivalWindowAt: -Infinity, arrivals: 0,
      sustainedUntil: -Infinity, dueAt: null, timerDueAt: undefined,
      echoBudget: 0, echoUntil: -Infinity,
      // Owner stamp of the renderer document that registered this channel. `null`
      // means an unowned (legacy) channel.
      ownerEpoch: null,
    };
    this.channels.set(id, channel);
    return channel;
  }

  // True once this id's final event has been emitted. Bounded, so a long-lived
  // process does not accumulate one entry per historic connection, but generous
  // enough that a late push/late finish for a just-finished session is recognised.
  _completed(id) {
    return this.completed.has(id);
  }

  _rememberCompleted(id, generation) {
    this.completed.set(id, generation);
    if (this.completed.size > COMPLETED_RETENTION) this.completed.delete(this.completed.keys().next().value);
  }

  // ---- explicit generation ownership (V9-M-05) -----------------------------

  // Registers a channel for a known owner. Only an explicit open()/register() may
  // start a new generation for an id whose final event was already emitted: the
  // implicit reuse contract let a late transport callback re-create the channel and
  // emit data after the final status, which is exactly the `[status, data]` ordering
  // the audit observed. With UUID connection ids there is no reason to infer a new
  // session from a stray push.
  open(id, ownerEpoch) {
    if (this.disposed) return null;
    this.completed.delete(id);
    const channel = this.channel(id);
    channel.ownerEpoch = Number.isSafeInteger(ownerEpoch) ? ownerEpoch : null;
    return channel;
  }

  register(id, ownerEpoch) {
    return this.open(id, ownerEpoch);
  }

  // The renderer page that owned this channel is gone. The channel is dropped and a
  // tombstone is left, so output the retiring transport still produces is discarded
  // instead of being replayed into the replacement document.
  retire(id) {
    this._rememberCompleted(id, this.channels.get(id)?.generation ?? this.generation);
    this.dispose(id);
  }

  // ---- receive side --------------------------------------------------------

  // Reserve before shell creation. The lease belongs to an object, not an id;
  // teardown/ACK from an older generation cannot unpause a reused id.
  attachReceiveSource(id, { reserveBytes, maxChunkBytes, setPaused, windowControl }) {
    positiveInteger('reserveBytes', reserveBytes, windowControl ? 0 : 1);
    positiveInteger('maxChunkBytes', maxChunkBytes);
    if (typeof setPaused !== 'function') throw new TypeError('Receive source requires setPaused().');
    if (this.disposed || this.receiveSources.has(id)) throw new Error('Receive source is unavailable.');
    const channel = this.channels.get(id) || this.open(id);
    const held = this.totalQueued + this.totalInFlight + this._receiveReserved();
    if (reserveBytes + maxChunkBytes + this.receiveSoftBytes > this.receiveHardBytes
      || (!windowControl && held + reserveBytes + maxChunkBytes > this.globalReceiveHardBytes)) {
      const error = new Error('수신 대기 예산이 부족합니다. 다른 세션의 출력 처리가 끝난 뒤 다시 연결해 주세요.');
      error.code = 'RECEIVE_CAPACITY'; throw error;
    }
    const source = { id, channel, reserveBytes, maxChunkBytes, setPaused, windowControl, nativeBytes: 0, tailReserved: false, converting: false, converted: 0, grant: 0, paused: true, sessionHeld: false, released: false };
    this.receiveSources.set(id, source);
    setPaused(true);
    this._rebalanceReceive();
    source.release = () => {
      if (source.released) return;
      source.released = true;
      if (this.receiveSources.get(id) === source) this.receiveSources.delete(id);
      source.setPaused(false);
      this._rebalanceReceive();
    };
    return { release: source.release, consume: (bytes, action) => {
      if (!windowControl) return action();
      source.converting = true; source.converted = 0;
      try { return action(); }
      finally {
        source.nativeBytes -= bytes;
        source.reserveBytes -= bytes * 4 - source.converted;
        source.converting = false; source.converted = 0;
        this._rebalanceReceive();
      }
    }, ready: () => this._rebalanceReceive(), closing: () => {
      source.closing = true; source.grant = 0;
      source.setPaused(false);
    } };
  }

  _receiveReserved() {
    let bytes = 0;
    for (const source of this.receiveSources.values()) bytes += source.reserveBytes + source.grant;
    return bytes;
  }

  _receivePause(source, paused, reason) {
    if (source.paused === paused || source.released) return;
    source.paused = paused;
    if (paused) this.stats.pauses++;
    source.setPaused(paused);
    try { this.onReceivePressure?.({ id: source.id, generation: source.channel.generation,
      ownerEpoch: source.channel.ownerEpoch, paused, reason,
      queuedBytes: source.channel.queuedBytes, inFlightBytes: source.channel.inFlightBytes }); } catch {}
  }

  _rebalanceReceive() {
    if (this.receiveRebalancing || this.disposed) return;
    this.receiveRebalancing = true;
    try {
      const sources = [...this.receiveSources.values()];
      // Unused growth grants can move; fixed reserves cannot. A paused shell
      // still holds native stdout/stderr buffers and an advertised SSH window.
      for (const source of sources) source.grant = 0;
      let free = this.globalReceiveHardBytes - this.totalQueued - this.totalInFlight - this._receiveReserved();
      for (let i = 0; i < sources.length; i++) {
        const source = sources[(this.receiveCursor + i) % sources.length], c = source.channel;
        const backlog = c.queuedBytes + c.inFlightBytes;
        source.sessionHeld = backlog >= this.receiveSoftBytes || (source.sessionHeld && backlog >= this.receiveResumeBytes);
        if (source.windowControl) {
          const tail = source.tailReserved ? 0 : 64;
          const held = source.released || source.closing || c.disposed || c.final || c.overflowed || source.sessionHeld
            || (source.nativeBytes === 0 && free < source.maxChunkBytes * 4 + tail);
          this._receivePause(source, !!held, source.sessionHeld ? 'session' : 'global');
          // Credit is a wire promise, not allocated memory. Never reclaim it
          // until the corresponding raw bytes have actually been consumed.
          if (!held && !source.converting && source.windowControl.ready() && source.nativeBytes === 0 && free >= source.maxChunkBytes * 4 + tail) {
            const bytes = source.maxChunkBytes;
            source.nativeBytes += bytes; source.reserveBytes += bytes * 4 + tail;
            source.tailReserved = true;
            free -= bytes * 4 + tail;
            source.windowControl.grant(bytes);
          }
          continue;
        }
        if (source.released || source.closing || c.disposed || c.final || c.overflowed || source.sessionHeld || free < source.maxChunkBytes) {
          this._receivePause(source, true, source.sessionHeld ? 'session' : 'global'); continue;
        }
        source.grant = Math.min(free, Math.max(source.maxChunkBytes, Math.min(1024 * 1024, this.receiveSoftBytes - backlog)));
        free -= source.grant;
        this._receivePause(source, false, 'drain');
      }
      if (sources.length) this.receiveCursor = (this.receiveCursor + 1) % sources.length;
    } finally { this.receiveRebalancing = false; }
  }

  push(id, data, options = {}) {
    if (this.disposed) return;
    // A push is never evidence that a new session started (V9-M-05). The previous
    // contract cleared the tombstone here, so a transport callback that arrived after
    // the final status re-created the channel and delivered `[status, data]` with an
    // in-flight batch nobody could ever see again. Only an explicit open()/register()
    // may start a new generation.
    if (this.completed.has(id)) {
      this.stats.latePushes++;
      const size = Buffer.isBuffer(data) ? data.length : (typeof data === 'string' ? data.length : 0);
      this.stats.latePushBytes += size;
      return;
    }
    const channel = this.channels.get(id);
    if (!channel) {
      // Legacy/plain push: an id that was never registered still gets a channel, so
      // a producer that does not participate in the ownership contract keeps working.
      // What a push may never do is *revive* a tombstoned id.
      const created = this.channel(id);
      return this._receive(created, data, options);
    }
    return this._receive(channel, data, options);
  }

  _receive(channel, data, options) {
    // A retired renderer page must not receive output, and must not be revived by a
    // late transport callback either.
    if (Number.isSafeInteger(options.ownerEpoch) && Number.isSafeInteger(channel.ownerEpoch)
      && options.ownerEpoch !== channel.ownerEpoch) {
      this.stats.staleOwnerPushes++;
      this.stats.staleOwnerBytes += Buffer.isBuffer(data) ? data.length : 0;
      return;
    }
    // A channel that already has a pending final must not accept more bytes: they
    // could never be delivered in order after the final status.
    if (channel.disposed || channel.final || channel.overflowed || channel.completed) return;
    // Ownership contract: the producer hands over bytes it will not mutate.
    // ssh2 allocates a fresh Buffer per CHANNEL_DATA, so copying here would only
    // add allocation on the hot path.
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!bytes.length) return;

    if (!this._admit(channel, bytes.length)) return;
    const source = this.receiveSources.get(channel.id);
    if (source?.channel === channel) source.grant = Math.max(0, source.grant - bytes.length);
    // Closing consumes only already-received bytes, converting the retained
    // native/decoded-tail reservation into display backlog, not new capacity.
    if (source?.windowControl && source.converting) {
      source.reserveBytes -= bytes.length; source.converted += bytes.length;
    } else if (source?.closing) source.reserveBytes = Math.max(0, source.reserveBytes - bytes.length);
    this._append(channel, bytes);
    channel.receivedPosition += bytes.length;
    this.stats.bytes += bytes.length;
    this._trackPeaks(channel);
    this._updatePressure(channel);

    this._rebalanceReceive();

    this._dispatch(channel);
  }

  // ---- adaptive coalescing policy -----------------------------------------
  //
  // Three shapes of output, three different behaviours:
  //
  //   prompt / banner / first byte after a quiet gap  → send now (0ms added)
  //   one bounded key echo after input                → send now (0ms added)
  //   sustained stream of small chunks                → coalesce 2–4ms
  //
  // A full batch is always sent immediately: waiting cannot make it larger, and
  // the renderer's credit is the real throughput limit.
  _dispatch(channel) {
    const now = this.now();
    // One call: it also advances the density window.
    const instant = this._noteArrival(channel, now);
    if (instant || channel.queuedBytes >= this.batchBytes) {
      channel.dueAt = null;
      this.flush(channel);
      return;
    }
    // Deadline of the FIRST queued byte. Re-arming only while the queue was
    // empty is what makes this a coalescer rather than a debounce: a producer
    // that keeps pushing cannot push delivery out past the first byte's window.
    if (channel.dueAt === null) channel.dueAt = now + this._coalesceDelay(channel);
    if (channel.final) return;
    this._armCoalesceTimer(channel);
  }

  // The adaptive window: 2ms normally, 4ms under sustained pressure. The larger
  // window is only used once the stream is provably continuous, so an interactive
  // session never pays for it.
  _coalesceDelay(channel) {
    const now = this.now();
    if (now < channel.sustainedUntil) return Math.max(this.coalesceDelayMs, this.coalesceMaxDelayMs);
    // A large backlog is dense even if the *events* were sparse: one 200 KiB chunk
    // is followed by a 200 KiB queue, and holding it for 2ms only delays display.
    if (channel.queuedBytes >= this.batchBytes * 4) return this.coalesceMaxDelayMs;
    return this.coalesceDelayMs;
  }

  // Records one arrival and answers "may this be sent with 0ms added delay?".
  // `true` means: a quiet gap ended (prompt / login question), or this is the one
  // bounded echo an input opened. Everything else is coalesced.
  _noteArrival(channel, now) {
    const gap = now - channel.lastReceiveAt;
    channel.lastReceiveAt = now;
    // Event-density detector with hysteresis. The window is tumbling, not
    // sliding, so the cost is one comparison per chunk.
    if (now - channel.arrivalWindowAt >= this.sustainedArrivalWindowMs) {
      channel.arrivalWindowAt = now;
      channel.arrivals = 0;
    }
    if (++channel.arrivals >= this.sustainedArrivals) channel.sustainedUntil = now + this.sustainedHysteresisMs;
    // A gap that wide means the previous exchange finished. This is the path that
    // keeps a prompt, a banner or a login question instant.
    if (gap >= this.idleGapMs) return true;
    // One bounded fast flush per input. `noteInput()` opens the window; a paste or
    // an automation burst spends the budget on its first chunk only, so it cannot
    // pin the whole stream into the instant path.
    if (now <= channel.echoUntil && channel.echoBudget > 0 && channel.queuedBytes <= channel.echoBudget) {
      channel.echoBudget = 0;
      return true;
    }
    return false;
  }

  // Called by main when it sends authorized input, so the echo of that input may
  // skip the coalescing window once. This is a *hint*, never a policy for shell
  // content: nothing here inspects the bytes.
  noteInput(id, options = {}) {
    const channel = this.channels.get(id);
    if (!channel || channel.disposed) return false;
    const budget = Number.isSafeInteger(options.bytes) && options.bytes > 0
      ? Math.min(options.bytes, this.echoBudgetBytes) : this.echoBudgetBytes;
    channel.echoBudget = Math.max(channel.echoBudget, Math.min(budget, this.interactiveBytes || this.echoBudgetBytes));
    channel.echoUntil = this.now() + this.echoWindowMs;
    return true;
  }

  // A coalescing deadline is the only thing that releases a parked queue, so the
  // timer calls the policy-gated flush. A final event or a full batch arrives
  // through `flush()`/`_dispatch()` instead.
  _armCoalesceTimer(channel) {
    const due = channel.dueAt;
    if (due === null) return;
    if (channel.timer && channel.timerDueAt !== undefined && channel.timerDueAt <= due) return;
    clearTimeout(channel.timer);
    channel.timerDueAt = due;
    const wait = Math.max(0, due - this.now());
    channel.timer = setTimeout(() => {
      channel.timer = null;
      channel.timerDueAt = undefined;
      if (this.channels.get(channel.id) !== channel) return;
      // A channel that somehow lost its deadline must not park bytes with no
      // timer: the deadline is the release condition, so restore it.
      if (channel.dueAt === null) channel.dueAt = this.now();
      this._flushDue(channel);
    }, wait);
    channel.timer.unref?.();
  }

  // True when this channel may send now: its deadline arrived, its backlog is a
  // full batch, or a barrier/screen-read target still lies ahead of the sent
  // prefix. The last case is §4.4's "synchronize forces eligibility up to the byte
  // target at call time" — it never drains unrelated later input without a bound,
  // because `target` is fixed when the barrier was created.
  _eligible(channel, now) {
    if (channel.queuedBytes <= 0) return false;
    if (channel.queuedBytes >= this.batchBytes) return true;
    if (channel.dueAt !== null && now >= channel.dueAt) return true;
    if (channel.barriers.length) {
      for (const barrier of channel.barriers) if (barrier.target > channel.sentPosition) return true;
    }
    return false;
  }

  // Both receive caps are checked before anything is retained, so one oversized
  // chunk can never allocate past the limit and only be noticed afterwards.
  _admit(channel, size) {
    const projected = channel.queuedBytes + channel.inFlightBytes + size;
    const sessionExceeded = projected > this.receiveHardBytes;
    const source = this.receiveSources.get(channel.id);
    // A managed callback consumes its grant (or its closing-tail reserve).
    // Unmanaged producers cannot spend capacity already promised to SSH.
    const converted = source?.converting || source?.closing ? Math.min(size, source.reserveBytes)
      : source?.channel === channel ? Math.min(size, source.grant) : 0;
    const globalExceeded = this.totalQueued + this.totalInFlight + this._receiveReserved() + size - converted > this.globalReceiveHardBytes;
    if (!sessionExceeded && !globalExceeded) return true;
    if (channel.overflowed) return false;
    channel.overflowed = true;
    this.overflowed.add(channel.id);
    if (this.overflowed.size > 256) this.overflowed.delete(this.overflowed.values().next().value);
    channel.rejectedBytes += size;
    this.stats.overflowCount++;
    this.stats.rejectedBytes += size;
    // The accepted-but-not-yet-parsed bytes are reported from the channel state
    // by finish(); the rejected chunk is a separate field so it is never added
    // twice to pendingOutputBytes.
    if (this.onOverflow) {
      try {
        this.onOverflow({
          id: channel.id, reason: globalExceeded ? 'global-backlog' : 'backlog',
          limit: globalExceeded ? this.globalReceiveHardBytes : this.receiveHardBytes,
          queuedBytes: channel.queuedBytes, inFlightBytes: channel.inFlightBytes,
          acceptedBytes: channel.receivedPosition, rejectedBytes: channel.rejectedBytes,
        });
      } catch { /* the owner must not be able to break the receive path */ }
    }
    return false;
  }

  _append(channel, bytes) {
    const slab = this.slabBytes;
    if (bytes.length >= slab) {
      this._sealAccumulator(channel);
      channel.chunks.push(bytes);
      channel.queuedBytes += bytes.length;
      this.totalQueued += bytes.length;
      this._coalesceFragments(channel);
      return;
    }
    if (!channel.acc) {
      channel.acc = Buffer.allocUnsafe(Math.min(slab, Math.max(1024, bytes.length)));
      channel.accUsed = 0;
      channel.accRead = 0;
    } else if (channel.accUsed + bytes.length > channel.acc.length) {
      // Reclaim the already-drained prefix in place; only a full accumulator is
      // sealed, so a 1-byte storm keeps exactly one slab in flight.
      if (channel.accRead > 0) {
        channel.acc.copy(channel.acc, 0, channel.accRead, channel.accUsed);
        channel.accUsed -= channel.accRead;
        channel.accRead = 0;
      }
      if (channel.accUsed + bytes.length > channel.acc.length && channel.acc.length < slab) {
        const size = Math.min(slab, Math.max(channel.acc.length * 2, channel.accUsed + bytes.length));
        const grown = Buffer.allocUnsafe(size);
        channel.acc.copy(grown, 0, 0, channel.accUsed);
        channel.acc = grown;
      }
      if (channel.accUsed + bytes.length > channel.acc.length) this._sealAccumulator(channel);
      if (!channel.acc) {
        channel.acc = Buffer.allocUnsafe(Math.min(slab, Math.max(1024, bytes.length)));
        channel.accUsed = 0;
        channel.accRead = 0;
      }
    }
    bytes.copy(channel.acc, channel.accUsed);
    channel.accUsed += bytes.length;
    channel.queuedBytes += bytes.length;
    this.totalQueued += bytes.length;
  }

  _sealAccumulator(channel) {
    if (!channel.acc || channel.accRead >= channel.accUsed) { channel.acc = null; channel.accUsed = 0; channel.accRead = 0; return; }
    // The accumulator can be partially drained; only its unread tail joins the
    // fragment queue.
    channel.chunks.push(channel.acc.subarray(channel.accRead, channel.accUsed));
    channel.acc = null;
    channel.accUsed = 0;
    channel.accRead = 0;
  }

  // Fragment count is bounded independently of byte count: a 1-byte storm costs
  // one accumulator slab, not one fragment per byte.
  _coalesceFragments(channel) {
    const live = channel.chunks.length - channel.head;
    if (live <= this.maxSourceFragments) return;
    let budget = this.flushTurnBytes;
    const merged = [];
    let parts = [];
    let size = 0;
    const flushParts = () => {
      if (!parts.length) return;
      merged.push(parts.length === 1 ? parts[0] : Buffer.concat(parts, size));
      parts = [];
      size = 0;
    };
    let index = channel.head;
    for (; index < channel.chunks.length && budget > 0; index++) {
      const chunk = channel.chunks[index];
      channel.chunks[index] = null;
      parts.push(chunk);
      size += chunk.length;
      budget -= chunk.length;
      if (size >= this.slabBytes) flushParts();
    }
    flushParts();
    for (; index < channel.chunks.length; index++) merged.push(channel.chunks[index]);
    channel.chunks = merged;
    channel.head = 0;
    channel.headOffset = 0;
  }

  _trackPeaks(channel) {
    const buffered = channel.queuedBytes + channel.inFlightBytes;
    if (buffered > this.stats.maxBufferedBytes) this.stats.maxBufferedBytes = buffered;
    if (channel.queuedBytes > this.stats.peakQueuedBytes) this.stats.peakQueuedBytes = channel.queuedBytes;
    if (channel.inFlightBytes > this.stats.peakInFlightBytes) this.stats.peakInFlightBytes = channel.inFlightBytes;
  }

  // A display hint only. State transitions are reported immediately, repeated
  // numbers are throttled, and nothing here touches the transport.
  _updatePressure(channel) {
    if (!this.onPressure) return;
    const buffered = channel.queuedBytes + channel.inFlightBytes;
    const burst = buffered >= this.burstBacklogBytes;
    const soft = buffered >= this.receiveSoftBytes
      || (channel.softPressure && buffered >= this.receiveResumeBytes);
    const transition = burst !== channel.burstPressure || soft !== channel.softPressure;
    const at = this.now();
    if (!transition && at - channel.lastPressureAt < this.statsIntervalMs) return;
    channel.lastPressureAt = at;
    channel.burstPressure = burst;
    channel.softPressure = soft;
    try {
      this.onPressure({ id: channel.id, burst, soft, queuedBytes: channel.queuedBytes, inFlightBytes: channel.inFlightBytes });
    } catch { /* a hint must not break receive */ }
  }

  // ---- send side -----------------------------------------------------------

  _credit(channel) {
    if (channel.pending.size >= this.inFlightBatches) return 0;
    return Math.min(this.inFlightBytes - channel.inFlightBytes, this.globalInFlightBytes - this.totalInFlight);
  }

  _take(channel, length) {
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    // Fragments are strictly older than the accumulator, so this preserves order.
    while (written < length && channel.head < channel.chunks.length) {
      const chunk = channel.chunks[channel.head];
      const available = chunk.length - channel.headOffset;
      const count = Math.min(available, length - written);
      chunk.copy(out, written, channel.headOffset, channel.headOffset + count);
      written += count;
      channel.headOffset += count;
      if (channel.headOffset === chunk.length) {
        channel.chunks[channel.head] = null;
        channel.head++;
        channel.headOffset = 0;
      }
    }
    if (written < length && channel.acc && channel.accRead < channel.accUsed) {
      const available = channel.accUsed - channel.accRead;
      const count = Math.min(available, length - written);
      channel.acc.copy(out, written, channel.accRead, channel.accRead + count);
      channel.accRead += count;
      written += count;
      if (channel.accRead === channel.accUsed) { channel.acc = null; channel.accUsed = 0; channel.accRead = 0; }
    }
    if (channel.head > 1024 && channel.head * 2 >= channel.chunks.length) {
      channel.chunks = channel.chunks.slice(channel.head);
      channel.head = 0;
    }
    return written === length ? out : out.subarray(0, written);
  }

  // Sends exactly one batch. Returns the byte count, or 0 when credit is spent.
  sendOne(channel) {
    if (channel.disposed || channel.overflowed || this.disposed) return 0;
    if (channel.queuedBytes <= 0) return 0;
    const credit = this._credit(channel);
    if (credit <= 0) return 0;
    const length = Math.min(channel.queuedBytes, this.batchBytes, credit, this.flushTurnBytes);
    if (length <= 0) return 0;
    const data = this._take(channel, length);
    const sequence = ++this.sequence;
    const start = channel.sentPosition;
    channel.queuedBytes -= length;
    this.totalQueued -= length;
    channel.inFlightBytes += length;
    this.totalInFlight += length;
    channel.sentPosition += length;
    channel.pending.set(sequence, { bytes: length, start, end: start + length, sentAt: this.now() });
    this.stats.batches++;
    let delivered;
    try {
      delivered = this.send({ type: 'data', id: channel.id, data, sequence });
    } catch {
      this._consumerGone(channel);
      return 0;
    }
    // An explicit `false` is the same failure as a throw: the consumer did not take
    // the batch, so the bytes are not silently counted as delivered (V9-M-05).
    if (delivered === false) {
      this._consumerGone(channel);
      return 0;
    }
    this._trackPeaks(channel);
    return length;
  }

  // A channel that could not be sent because of credit must be remembered, so a
  // credit return anywhere in the process can wake it.
  _markBlocked(channel) {
    if (channel.disposed || this.disposed) return;
    if (channel.queuedBytes > 0) this.blocked.add(channel);
  }

  // Called whenever credit is returned (ACK, dispose, overflow) and after a pump
  // turn that stopped on the global budget. Every blocked channel that can now
  // send is put back on the ready queue, so one session's ACK drains the others
  // it was starving.
  _wakeBlocked() {
    if (!this.blocked.size || this.disposed) return;
    for (const channel of this.blocked) {
      if (channel.disposed || this.channels.get(channel.id) !== channel) { this.blocked.delete(channel); continue; }
      if (channel.overflowed || channel.queuedBytes <= 0) { this.blocked.delete(channel); continue; }
      if (this._credit(channel) <= 0) continue;
      this.blocked.delete(channel);
      this._schedule(channel);
    }
  }

  // Sends at most one bounded turn for this channel.
  //
  // The public `flush()` means *now*: drains, barriers, tests and the final status
  // all call it to say "these bytes are due". The coalescing policy is applied by
  // `_flushDue()`, which the ACK path and the timer use. Keeping the two apart is
  // what stops an ACK from becoming an unconditional send: the renderer
  // acknowledges every event, so an unconditional flush on ACK re-enabled the
  // per-chunk IPC storm that batching exists to remove.
  flush(channel) {
    this._flush(channel, true);
  }

  // Policy-gated flush: sends only if this channel's first queued byte is due (or
  // the backlog is already a full batch). Otherwise the timer stays armed.
  _flushDue(channel) {
    this._flush(channel, false);
  }

  _flush(channel, force) {
    if (this.disposed || channel.disposed || channel.overflowed) return;
    clearTimeout(channel.timer);
    channel.timer = null;
    channel.timerDueAt = undefined;
    if (!channel.queuedBytes) {
      // Nothing left to send; delivery state still has to settle (barriers, final).
      channel.dueAt = null;
      this._afterFlush(channel);
      return;
    }
    if (!force && !this._eligible(channel, this.now())) {
      // Full-batch dispatch cleared dueAt before it hit exhausted IPC credit.
      // A later ACK can leave a partial tail: give it a deadline, not an eternal
      // parked queue with no timer and no future network input.
      if (channel.dueAt === null) channel.dueAt = this.now() + this._coalesceDelay(channel);
      this._armCoalesceTimer(channel);
      return;
    }
    if (channel.flushing) return;
    channel.flushing = true;
    try {
      const deadline = this.now() + this.flushTurnMs;
      let turnBytes = 0;
      while (channel.queuedBytes > 0 && turnBytes < this.flushTurnBytes) {
        const sent = this.sendOne(channel);
        if (!sent) break;
        turnBytes += sent;
        if (this.now() > deadline) break;
      }
    } finally {
      channel.flushing = false;
    }
    // The queue that existed when this turn started has been delivered (or
    // credit-blocked). A later push sets a fresh deadline instead of inheriting
    // this one.
    if (!channel.queuedBytes) {
      channel.dueAt = null;
    } else if (this._credit(channel) <= 0) {
      this._markBlocked(channel);
    } else {
      // A partial tail can be left by the turn budget, by `batchBytes`, or by an
      // entry that was not fully taken. It must get its own deadline, or nothing
      // would ever release it: `_armCoalesceTimer` has no due time to wait for.
      if (channel.dueAt === null) channel.dueAt = this.now() + this._coalesceDelay(channel);
      this._armCoalesceTimer(channel);
    }
    this._afterFlush(channel);
  }

  _afterFlush(channel) {
    this._updatePressure(channel);
    this._resolveBarriers(channel);
    if (!channel.final) return;
    if (!channel.queuedBytes && !channel.inFlightBytes) this.complete(channel);
    else if (!channel.finalTimer) this._armFinalDeadline(channel);
  }

  // ---- shared round-robin scheduler ---------------------------------------

  _schedule(channel) {
    if (channel.ready || channel.disposed || this.disposed) return;
    channel.ready = true;
    this.readyQueue.push(channel);
    if (this.pumpHandle) return;
    this.pumpHandle = this.schedule(() => {
      this.pumpHandle = null;
      this.pump();
    });
  }

  // One turn: every ready channel sends at most one batch per pass, so a session
  // with tens of MiB queued cannot starve the other tabs, and the whole turn
  // yields after flushTurnBytes / flushTurnMs.
  pump() {
    if (this.disposed) return;
    const queue = this.readyQueue;
    this.readyQueue = [];
    for (const channel of queue) channel.ready = false;
    let turnBytes = 0;
    const deadline = this.now() + this.flushTurnMs;
    let progressed = true;
    while (progressed && turnBytes < this.flushTurnBytes && this.now() <= deadline) {
      progressed = false;
      const now = this.now();
      for (const channel of queue) {
        if (channel.disposed || !channel.queuedBytes) continue;
        // The scheduler is a throughput path, not an escape from the coalescing
        // policy: a channel whose first byte is not due yet waits for its timer.
        if (!this._eligible(channel, now)) continue;
        const sent = this.sendOne(channel);
        if (!sent) continue;
        progressed = true;
        turnBytes += sent;
        if (turnBytes >= this.flushTurnBytes) break;
      }
    }
    const after = this.now();
    for (const channel of queue) {
      if (channel.disposed) continue;
      if (!channel.queuedBytes) { channel.dueAt = null; this._afterFlush(channel); continue; }
      if (!this._eligible(channel, after)) { this._armCoalesceTimer(channel); continue; }
      this._afterFlush(channel);
      // Only budget (not credit) exhaustion needs another turn; credit waits for
      // an ACK, which calls flush() again.
      if (!channel.queuedBytes) continue;
      if (this._credit(channel) > 0) this._schedule(channel);
      else this._markBlocked(channel);
    }
    // Another channel's ACK may have freed the global budget after this turn
    // started; anything still blocked and now sendable joins the next turn.
    this._wakeBlocked();
  }

  // ---- ACK / barrier -------------------------------------------------------

  acknowledge(id, sequence) {
    const channel = this.channels.get(id);
    if (!channel || channel.disposed || !Number.isSafeInteger(sequence)) return false;
    const entry = channel.pending.get(sequence);
    // Only the exact channel object and the exact pending entry may change
    // accounting: a late ACK from a previous generation is a no-op.
    if (!entry) return false;
    channel.pending.delete(sequence);
    channel.inFlightBytes -= entry.bytes;
    this.totalInFlight -= entry.bytes;
    if (channel.inFlightBytes < 0) channel.inFlightBytes = 0;
    if (this.totalInFlight < 0) this.totalInFlight = 0;
    this._recordLatency(this.now() - entry.sentAt);
    // Renew the final deadline only on a real ACK, and clear it before flushing
    // so _afterFlush re-arms it after the newly sent batches.
    if (channel.final) { clearTimeout(channel.finalTimer); channel.finalTimer = null; }
    // A real ACK releases backlog too, but resumption is governed by the
    // separate receive watermarks/reservations, never the small IPC credit.
    this._rebalanceReceive();
    //
    // An ACK is *not* a reason to send. It returns credit, so it re-checks
    // eligibility: a due queue goes out, a queue still inside its coalescing
    // window keeps waiting for the timer. The old unconditional flush here meant
    // every acknowledged batch pulled the next partial queue out immediately, so
    // an ACK-paced stream never coalesced anything.
    this._flushDue(channel);
    if (channel.queuedBytes && this._credit(channel) > 0 && this._eligible(channel, this.now())) this._schedule(channel);
    // This ACK returned global IPC credit. Every other channel that was parked on
    // that credit must be woken, not just the one that acknowledged: otherwise a
    // quiet session starved by another session's burst waits forever with an empty
    // ready queue and no new data of its own.
    this._wakeBlocked();
    return true;
  }

  _recordLatency(sample) {
    if (!(sample >= 0)) return;
    this.latencyCount++;
    this.latencyTotal += sample;
    if (sample > this.latencyMax) this.latencyMax = sample;
    this.latencyRing[this.latencyIndex++ % this.latencyRing.length] = sample;
  }

  // The parsed prefix is the earliest unacknowledged start; with nothing pending
  // it is the whole sent prefix. Queued bytes never count as parsed.
  parsedPosition(channel) {
    const first = channel.pending.values().next();
    return first.done ? channel.sentPosition : first.value.start;
  }

  _resolveBarriers(channel) {
    if (!channel.barriers.length) return;
    const parsed = this.parsedPosition(channel);
    for (const barrier of [...channel.barriers]) if (parsed >= barrier.target) barrier.resolve();
  }

  _armFinalDeadline(channel) {
    clearTimeout(channel.finalTimer);
    channel.finalTimer = setTimeout(() => {
      if (this.channels.get(channel.id) !== channel || !channel.final) return;
      const pendingDisplayBytes = channel.queuedBytes + channel.inFlightBytes;
      this.stats.drainTimeouts++;
      this.stats.discardedBytes += pendingDisplayBytes;
      this.complete(channel, {
        outputIncomplete: true,
        pendingDisplayBytes,
        pendingOutputBytes: (channel.final.pendingOutputBytes || 0) + pendingDisplayBytes,
      });
    }, this.drainTimeoutMs);
    channel.finalTimer.unref?.();
  }

  // ---- finish / dispose ----------------------------------------------------

  finish(event, options = {}) {
    const channel = this.channels.get(event.id);
    // A final event from a transport whose renderer page was retired belongs to that
    // page, not to the document that replaced it (V9-M-05).
    if (Number.isSafeInteger(options.ownerEpoch) && channel && Number.isSafeInteger(channel.ownerEpoch)
      && options.ownerEpoch !== channel.ownerEpoch) return;
    // A repeated finish for the same id is not a second final event. It used to
    // either re-arm the deadline or complete twice, sending two statuses for one
    // session (V6-M-04).
    if (!channel) {
      if (this.completed.has(event.id)) return;
      // No channel: nothing was ever pushed (or it was already disposed after a
      // status), so the status is forwarded exactly once and then remembered.
      this._rememberCompleted(event.id, this.generation);
      this._sendFinal(event);
      return;
    }
    if (channel.final || channel.completed) return;
    if (channel.overflowed) {
      // The receive-backlog decision already ended this session: report the exact
      // accounting instead of a display deadline.
      const pendingDisplayBytes = channel.queuedBytes + channel.inFlightBytes;
      this.overflowed.delete(channel.id);
      this.complete(channel, {
        outputIncomplete: true,
        pendingDisplayBytes,
        pendingOutputBytes: (event.pendingOutputBytes || 0) + pendingDisplayBytes,
        rejectedOutputBytes: channel.rejectedBytes,
      }, event);
      return;
    }
    channel.final = event;
    // A final event forces delivery: a status must never wait on a coalescing
    // window, and the tail bytes before it have to be on the wire in order.
    this.flush(channel);
    if (!channel.queuedBytes && !channel.inFlightBytes) this.complete(channel);
    else this._armFinalDeadline(channel);
  }

  complete(channel, extra, overrideEvent) {
    // Single-completion guard. Every path (drain timeout, ACK, overflow, finish)
    // funnels through here, and completing twice emitted two final statuses and
    // disposed an id that a later push then recreated (V6-M-04).
    if (channel.completed) return;
    channel.completed = true;
    // Read the pending final event before clearing it: every caller relies on it.
    const event = { ...(overrideEvent || channel.final || {}), ...extra };
    channel.final = null;
    clearTimeout(channel.timer);
    clearTimeout(channel.finalTimer);
    channel.timer = null;
    channel.finalTimer = null;
    this._rememberCompleted(channel.id, channel.generation);
    this._sendFinal(event);
    this.dispose(channel.id);
  }

  // One place where a final event leaves the module, so a failing send can never
  // skip the cleanup that must follow it.
  _sendFinal(event) {
    let delivered;
    try { delivered = this.send(event); } catch { return; /* the consumer is gone; dispose still runs */ }
    // The final event is the one message whose delivery must not be assumed: a
    // consumer that returns `false` never received it, so it is reported instead of
    // being counted as a completed drain (V9-M-05).
    if (delivered === false) {
      try { this.onOverflow?.({ id: event.id, reason: 'consumer-gone', droppedBytes: 0, final: true }); }
      catch { /* reporting must not throw out of the teardown path */ }
    }
  }

  // The renderer is gone (destroyed/reloaded). Keeping the transport open for an
  // absent consumer would only grow memory, so the owner is asked to end it
  // instead of silently dropping output.
  _consumerGone(channel) {
    if (channel.overflowed) return;
    channel.overflowed = true;
    this.overflowed.add(channel.id);
    this.stats.overflowCount++;
    const dropped = channel.queuedBytes + channel.inFlightBytes;
    this.stats.rejectedBytes += dropped;
    this.totalQueued -= channel.queuedBytes;
    this.totalInFlight -= channel.inFlightBytes;
    if (this.totalQueued < 0) this.totalQueued = 0;
    if (this.totalInFlight < 0) this.totalInFlight = 0;
    channel.queuedBytes = 0;
    channel.inFlightBytes = 0;
    channel.chunks.length = 0;
    channel.head = 0;
    channel.headOffset = 0;
    channel.acc = null;
    channel.accUsed = 0;
    channel.pending.clear();
    this.blocked.delete(channel);
    if (this.onOverflow) {
      try { this.onOverflow({ id: channel.id, reason: 'consumer-gone', droppedBytes: dropped }); }
      catch { /* re-entry must not throw out of the send path */ }
    }
    // Dropping this backlog returns its credit to the process.
    this._wakeBlocked();
  }

  drain(id) {
    const channel = this.channels.get(id);
    if (!channel) return Promise.resolve();
    return new Promise(resolve => { channel.drains.push(resolve); });
  }

  synchronize(id, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const channel = this.channels.get(id);
    if (!channel) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        const index = channel.barriers.indexOf(barrier);
        if (index >= 0) channel.barriers.splice(index, 1);
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      // The target includes bytes still queued for the renderer, so a barrier can
      // never complete on a prefix that has not even been sent.
      const barrier = { target: channel.receivedPosition, resolve: () => { cleanup(); resolve(); } };
      channel.barriers.push(barrier);
      signal?.addEventListener('abort', abort, { once: true });
      // A screen read must not wait on a coalescing window: this is exactly the
      // "force eligibility up to the target at call time" case. Only the bytes
      // that already exist are forced; input arriving later keeps its own window.
      this.flush(channel);
      if (this.parsedPosition(channel) >= barrier.target) barrier.resolve();
    });
  }

  dispose(id) {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.disposed = true;
    this.channels.delete(id);
    clearTimeout(channel.timer);
    clearTimeout(channel.finalTimer);
    channel.timer = null;
    channel.timerDueAt = undefined;
    channel.finalTimer = null;
    channel.dueAt = null;
    channel.echoBudget = 0;
    channel.echoUntil = -Infinity;
    this.blocked.delete(channel);
    this.totalQueued -= channel.queuedBytes;
    this.totalInFlight -= channel.inFlightBytes;
    if (this.totalQueued < 0) this.totalQueued = 0;
    if (this.totalInFlight < 0) this.totalInFlight = 0;
    channel.queuedBytes = 0;
    channel.inFlightBytes = 0;
    channel.pending.clear();
    channel.chunks.length = 0;
    channel.head = 0;
    channel.headOffset = 0;
    channel.acc = null;
    channel.accUsed = 0;
    const index = this.readyQueue.indexOf(channel);
    if (index >= 0) this.readyQueue.splice(index, 1);
    channel.ready = false;
    for (const resolve of channel.drains) resolve();
    channel.drains.length = 0;
    for (const barrier of [...channel.barriers]) barrier.resolve();
    channel.barriers.length = 0;
    // Disposing a backlogged channel returns credit to the process; the sessions
    // waiting on it must not stay parked.
    const source = this.receiveSources.get(id);
    if (source?.channel === channel) source.release();
    this._wakeBlocked();
    this._rebalanceReceive();
  }

  close() {
    // Clearing the parked set first keeps each dispose() from re-scheduling work
    // during shutdown.
    this.blocked.clear();
    for (const id of [...this.channels.keys()]) this.dispose(id);
    this.channels.clear();
    this.readyQueue.length = 0;
    this.totalQueued = 0;
    this.totalInFlight = 0;
    this.pumpHandle = null;
    this.disposed = true;
  }

  snapshot() {
    const histogram = {};
    for (const edge of LATENCY_EDGES) histogram[`le${edge}`] = 0;
    histogram.gt = 0;
    for (const sample of this.latencyRing) {
      if (!sample) continue;
      const edge = LATENCY_EDGES.find(value => sample <= value);
      if (edge === undefined) histogram.gt++;
      else histogram[`le${edge}`]++;
    }
    let pendingBatches = 0;
    const channelStats = [];
    for (const channel of this.channels.values()) {
      pendingBatches += channel.pending.size;
      channelStats.push({
        id: channel.id, queuedBytes: channel.queuedBytes, inFlightBytes: channel.inFlightBytes,
        pendingBatches: channel.pending.size, burst: channel.burstPressure,
        sustained: this.now() < channel.sustainedUntil,
      });
    }
    return {
      ...this.stats,
      mode: 'batched',
      // Coalescing policy visibility for diagnostics: the configured windows and
      // how many IPC events the policy actually produced versus bytes accepted.
      batching: {
        coalesceDelayMs: this.coalesceDelayMs,
        coalesceMaxDelayMs: this.coalesceMaxDelayMs,
        batchBytes: this.batchBytes,
        // Average bytes per IPC event. Rising this is the whole point of the
        // change; a value near the chunk size means the stream is still
        // one-event-per-chunk.
        bytesPerEvent: this.stats.batches ? Number((this.stats.bytes / this.stats.batches).toFixed(1)) : 0,
      },
      queuedBytes: this.totalQueued,
      inFlightBytes: this.totalInFlight,
      receiveReservedBytes: this._receiveReserved(),
      receiveSources: this.receiveSources.size,
      pendingBatches,
      parserAckLatency: {
        count: this.latencyCount,
        meanMs: this.latencyCount ? Number((this.latencyTotal / this.latencyCount).toFixed(3)) : 0,
        maxMs: Number(this.latencyMax.toFixed(3)),
        histogram,
      },
      channelStats,
    };
  }
}

module.exports = { TerminalOutput, DEFAULTS };
