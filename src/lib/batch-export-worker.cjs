'use strict';
// Builds an export document off the main thread. `xlsx()` is pure CPU work
// (worksheet/cell assembly + deflate) and takes ~0.8s for a 5,000-device
// workbook, which would otherwise stall IPC, auth and cancel timers while a
// batch is still connected.
const { parentPort, workerData } = require('node:worker_threads');
const { xlsx, txt } = require('./batch-export.cjs');

try {
  const { format, rows } = workerData;
  const bytes = format === 'xlsx' ? xlsx(rows) : Buffer.from(txt(rows));
  // Copy into an exactly-sized ArrayBuffer so the buffer can be transferred
  // instead of cloned (Buffer.concat may return a pooled slice).
  const out = Uint8Array.prototype.slice.call(bytes);
  parentPort.postMessage({ type: 'result', bytes: out }, [out.buffer]);
} catch (error) {
  parentPort.postMessage({ type: 'error', message: String(error?.message || error), code: error?.code || '' });
}
