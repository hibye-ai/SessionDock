'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { dateParts } = require('./logging-settings.cjs');

const MAX_LOG_BUFFER = 1024 * 1024;
const MAX_LOG_CHUNKS = 4096;

function logError(message, code) { return Object.assign(new Error(message), { code }); }

// Reserve a new name atomically; never rename, truncate or append to an existing
// file (including when another connection/process wins the same candidate).
async function openLogFile(filename, cancelled = () => false) {
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  const parsed = path.parse(filename);
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (cancelled()) throw logError('Log opening cancelled.', 'NOT_CONNECTED');
    const candidate = attempt ? path.join(parsed.dir, `${parsed.name}-${String(attempt).padStart(3, '0')}${parsed.ext}`) : filename;
    let handle;
    try { handle = await fs.promises.open(candidate, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    if (cancelled()) {
      await handle.close();
      throw logError('Log opening cancelled.', 'NOT_CONNECTED');
    }
    let stream;
    try { stream = handle.createWriteStream(); }
    catch (error) { await handle.close(); throw error; }
    // A stream can fail before its caller has installed its owner listener.
    stream.on('error', () => {});
    return { stream, path: candidate };
  }
  throw logError('로그 파일 이름이 너무 많이 중복됩니다. 파일명 양식에 {time} 또는 {id}를 추가해 주세요.', 'LOG_NAME_COLLISION');
}

function endLogStream(stream) {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let error = stream.errored;
    const failed = value => { error = value; };
    stream.on('error', failed);
    stream.once('close', () => {
      stream.removeListener('error', failed);
      if (error) reject(error); else resolve();
    });
    if (!stream.destroyed && !stream.writableEnded) stream.end();
  });
}

// Writable provides one ordered, byte-counted queue across both the open and
// write phases. The public connection.logStream remains the actual file stream.
// Timestamps belong to accepted chunks, not to asynchronous filesystem callbacks.
//
// Two byte counters answer two different questions (V9-M-03):
//   acceptedBytes  — bytes handed to the file for writing (`writeAt`).
//   completedBytes — bytes the underlying stream's write callback confirmed.
// Only the second one means "stored". Reporting acceptance as storage made a
// completely failed recording (accepted 65,536, file size 0) claim that nothing
// was lost, because a hard error never reached the byte ledger.
class RotatingLog extends Writable {
  constructor({ opened, now, filenameFor, rotateDaily = false, clock = () => new Date(),
    openFile = openLogFile, onRotate = () => {}, onRotationError = () => {}, trackCleanup = promise => promise,
    onWriteComplete = () => {}, onWriteFailed = null, openTimeoutMs = 10000 }) {
    super();
    this.active = opened;
    this.day = dateParts(now).date;
    this.attemptedDay = this.day;
    if (!Number.isInteger(openTimeoutMs) || openTimeoutMs < 10 || openTimeoutMs > 300000) throw new TypeError('Invalid log opening deadline.');
    Object.assign(this, { filenameFor, rotateDaily, clock, openFile, onRotate, onRotationError, trackCleanup, onWriteComplete, onWriteFailed, openTimeoutMs });
    this.times = [];
    this.streams = new Set();
    this.stopping = false;
    this.cancelRotation = null;
    this.operation = Promise.resolve();
    this.acceptedBytes = 0;
    this.completedBytes = 0;
    this._own(opened.stream);
  }

  _own(stream) {
    this.streams.add(stream);
    const failed = error => this.destroy(error);
    stream.on('error', failed);
    stream.once('close', () => {
      stream.removeListener('error', failed);
      this.streams.delete(stream);
    });
  }

  writeAt(bytes, now) {
    if (!bytes.length) return !this.writableNeedDrain;
    if (this.times.length >= MAX_LOG_CHUNKS || bytes.length + this.writableLength > MAX_LOG_BUFFER) {
      throw logError('Session log cannot keep up with terminal output.', 'LOG_BACKPRESSURE');
    }
    this.times.push(new Date(now));
    // Acceptance is not storage: this only says the bytes are this writer's
    // responsibility now. `completedBytes` is the storage figure.
    this.acceptedBytes += bytes.length;
    return this.write(bytes);
  }

  // Accepted but not yet confirmed by the file: the bytes a failure can still
  // destroy. Derived, so it can never drift from the two counters it comes from.
  get unconfirmedBytes() { return Math.max(0, this.acceptedBytes - this.completedBytes); }

  // Reports a write that the file never confirmed, so the owner's loss ledger can
  // count it. Without this the owner only heard about *successful* completions: a
  // recording whose very first write failed with EIO reported `written = 65536,
  // dropped = 0` against a 0-byte file, because `armedLoss` (acceptance) was used
  // as the "stored" figure and no failure ever reached the ledger (V9-M-03).
  //
  // `unconfirmed` is not the same thing as "lost": a write that fails may still
  // have reached the disk, so the caller records it as unconfirmed rather than
  // forcing it into an exact loss figure.
  _reportIncomplete(bytes, error) {
    try {
      this.onWriteFailed?.({ bytes, error, unconfirmedBytes: this.unconfirmedBytes });
    } catch { /* the owner must never break the writer */ }
  }

  stopRotation() { this.stopping = true; this.cancelRotation?.(); }

  async _rotate(now) {
    if (!this.rotateDaily || this.stopping) return;
    const day = dateParts(now).date;
    if (day === this.day || day === this.attemptedDay) return;
    this.attemptedDay = day;
    let next, timer, abandoned = false;
    try {
      // A template with only {year}, {month} or {time} can repeat on another
      // day too. Always identify the day unless a complete date is present.
      if (this.rotationOpening) throw logError('Previous log rotation is still opening.', 'LOG_OPEN_PENDING');
      const opening = this.openFile(this.filenameFor(now, true), () => this.destroyed || this.stopping || abandoned);
      this.rotationOpening = opening;
      const clear = () => { if (this.rotationOpening === opening) this.rotationOpening = null; };
      opening.then(clear, clear);
      // Stop need not wait for a slow/UNC open to drain the existing file. The
      // service still tracks the late descriptor until it has actually closed.
      this.trackCleanup(opening.then(async candidate => {
        if (this.destroyed || this.stopping || abandoned) await endLogStream(candidate.stream);
      }).catch(() => {}));
      const cancelled = new Promise(resolve => { this.cancelRotation = () => { abandoned = true; resolve(null); }; });
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
        abandoned = true; reject(logError('Log rotation opening timed out; continuing in the previous file.', 'LOG_OPEN_TIMEOUT'));
      }, this.openTimeoutMs); });
      try { next = await Promise.race([opening, cancelled, deadline]); }
      finally { clearTimeout(timer); this.cancelRotation = null; }
      if (!next) return;
      if (next.stream.destroyed) throw next.stream.errored || logError('New log stream is closed.', 'LOG_WRITE_FAILED');
    } catch (error) {
      if (next) await endLogStream(next.stream).catch(() => {});
      if (!this.destroyed && !this.stopping) this.onRotationError(error);
      return; // The old stream is still open; this chunk is written there once.
    }
    if (this.destroyed || this.stopping) {
      await endLogStream(next.stream);
      return;
    }
    this._own(next.stream);
    // Opening is the only recoverable rotation failure. Once retiring an old
    // file fails, report a fatal write error rather than silently losing bytes.
    await endLogStream(this.active.stream);
    this.active = next;
    this.day = day;
    if (!this.destroyed && !this.stopping) this.onRotate(next);
  }

  _write(bytes, _encoding, callback) {
    const now = this.times.shift() || this.clock();
    this.operation = this._output(bytes, now);
    this.operation.then(() => callback(), callback);
  }

  _writev(chunks, callback) {
    const times = this.times.splice(0, chunks.length);
    this.operation = (async () => {
      let buffers = [], now, day;
      for (let index = 0; index < chunks.length; index++) {
        const time = times[index] || this.clock();
        const nextDay = !this.rotateDaily || this.stopping ? ''
          : now?.getTime() === time.getTime() ? day : dateParts(time).date;
        if (buffers.length && nextDay !== day) {
          await this._output(Buffer.concat(buffers), now);
          buffers = [];
        }
        if (!buffers.length) now = time;
        day = nextDay;
        buffers.push(chunks[index].chunk);
      }
      if (buffers.length) await this._output(Buffer.concat(buffers), now);
    })();
    this.operation.then(() => callback(), callback);
  }

  async _output(bytes, now) {
    await this._rotate(now);
    if (this.destroyed) return;
    await new Promise((resolve, reject) => {
      const stream = this.active.stream;
      // One settlement per accepted chunk. `close`, `error` and the write
      // callback can all arrive for the same bytes, and counting storage twice
      // (or reporting one loss twice) is exactly what made the loss figure
      // unusable (V9-M-03).
      let settled = false;
      const done = error => {
        if (settled) return;
        settled = true;
        stream.removeListener('close', closed);
        stream.removeListener('error', done);
        if (error) {
          // The file never confirmed these bytes. Report them before rejecting, so
          // the owner's ledger records an unconfirmed write instead of a zero-loss
          // recording: a first-write EIO used to leave `written === accepted` and
          // `dropped === 0` against a 0-byte file (V9-M-03).
          this._reportIncomplete(bytes.length, error);
          reject(error);
          return;
        }
        // Storage, not acceptance: the file stream itself confirmed these bytes.
        this.completedBytes += bytes.length;
        try { this.onWriteComplete(bytes.length); }
        catch { /* the owner must never break the writer */ }
        resolve();
      };
      const closed = () => done(stream.errored || logError('Session log closed before writing completed.', 'LOG_WRITE_FAILED'));
      stream.once('close', closed);
      stream.once('error', done);
      if (stream.destroyed) { closed(); return; }
      try { stream.write(bytes, done); } catch (error) { done(error); }
    });
  }

  _final(callback) {
    this.stopRotation();
    this.operation = endLogStream(this.active.stream);
    this.operation.then(() => callback(), callback);
  }

  _destroy(error, callback) {
    this.stopRotation();
    this.times.length = 0;
    for (const stream of this.streams) stream.destroy();
    // Settle writes before close. Cancelled opens have a separate tracked owner
    // so the service cannot finish shutdown while a late descriptor is unowned.
    this.operation.catch(() => {}).then(async () => {
      await Promise.allSettled([...this.streams].map(endLogStream));
    }).then(() => callback(error), callback);
  }
}

module.exports = { RotatingLog, openLogFile, endLogStream, MAX_LOG_BUFFER };
