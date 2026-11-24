'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');

const REGEX_LIMITS = Object.freeze({ workers: 2, queue: 32, timeoutMs: 1000, snapshots: 4096 });
function fault(code) { return Object.assign(new Error(code), { code }); }

// One request per waiter, including while queued. A slot is held until the worker
// has actually exited, not merely until its promise has been rejected. Workers
// are disposable so even a V8 regexp stuck in backtracking can be interrupted.
class AutomationRegex {
  constructor() { this.active = new Set(); this.queue = []; this.closed = false; }

  match(patterns, text, { signal, ends = [text.length] } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(fault('ERR_AUTOMATION_CANCELLED'));
    if (this.queue.length >= REGEX_LIMITS.queue) return Promise.reject(fault('ERR_AUTOMATION_LIMIT'));
    return new Promise((resolve, reject) => {
      const request = { patterns, text, ends, signal, resolve, reject, settled: false,
        expires: performance.now() + REGEX_LIMITS.timeoutMs };
      request.abort = () => this._settle(request, fault('ERR_AUTOMATION_CANCELLED'));
      signal?.addEventListener('abort', request.abort, { once: true });
      // Includes time in the queue and worker startup. A stream of new output
      // cannot extend either this budget or the enclosing automation wait.
      request.timer = setTimeout(() => this._settle(request, fault('ERR_AUTOMATION_TIMEOUT')), REGEX_LIMITS.timeoutMs);
      this.queue.push(request); this._drain();
    });
  }

  _settle(request, error, value) {
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    const index = this.queue.indexOf(request);
    if (index !== -1) this.queue.splice(index, 1);
    request.patterns = request.text = request.ends = null;
    if (error) request.reject(error); else request.resolve(value);
    // Keep the error listener until exit: cancellation can race a worker error.
    if (request.worker) void request.worker.terminate().catch(() => {});
  }

  _drain() {
    while (!this.closed && this.active.size < REGEX_LIMITS.workers && this.queue.length) {
      const request = this.queue.shift();
      if (performance.now() >= request.expires) { this._settle(request, fault('ERR_AUTOMATION_TIMEOUT')); continue; }
      let worker;
      try {
        worker = new Worker(path.join(__dirname, 'automation-regex-worker.cjs'), {
          workerData: { patterns: request.patterns, text: request.text, ends: request.ends },
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 }
        });
      } catch { this._settle(request, fault('ERR_AUTOMATION_INPUT')); continue; }
      request.worker = worker;
      request.patterns = request.text = request.ends = null;
      this.active.add(request);
      const message = result => {
        if (request.settled) return;
        if (performance.now() >= request.expires) { this._settle(request, fault('ERR_AUTOMATION_TIMEOUT')); return; }
        if (result?.type === 'started') { request.started = true; return; }
        if (result?.type !== 'result') { this._settle(request, fault('ERR_AUTOMATION_INPUT')); return; }
        this._settle(request, result.invalid ? fault('ERR_AUTOMATION_VALIDATION') : null, result.match);
      };
      const error = err => this._settle(request, fault(err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ?
        'ERR_AUTOMATION_LIMIT' : 'ERR_AUTOMATION_INPUT'));
      request.exited = new Promise(resolve => {
        const exit = () => {
          request.worker = null;
          this._settle(request, fault('ERR_AUTOMATION_INPUT'));
          worker.removeListener('message', message); worker.removeListener('error', error);
          worker.removeListener('exit', exit);
          this.active.delete(request); resolve(); this._drain();
        };
        worker.on('message', message); worker.on('error', error); worker.once('exit', exit);
      });
    }
  }

  async close() {
    this.closed = true;
    for (const request of [...this.queue, ...this.active]) this._settle(request, fault('ERR_AUTOMATION_CANCELLED'));
    await Promise.all([...this.active].map(request => request.exited));
  }
}

module.exports = { AutomationRegex, REGEX_LIMITS };
