'use strict';

const fs = require('node:fs');
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Windows readers/virus scanners can briefly deny delete sharing on an existing
// destination. Retry the same atomic replacement, never unlink or copy over it.
// The store API is synchronous; cap total waiting at 200ms (8 x 25ms).
function atomicRenameSync(source, destination, { beforeRename } = {}) {
  for (let attempt = 0; ; attempt++) {
    // Revalidate ownership/revision on every attempt, outside the retry catch.
    beforeRename?.();
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !transient.has(error.code) || attempt === 8) throw error;
      Atomics.wait(waitCell, 0, 0, 25);
    }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Asynchronous twin of `atomicRenameSync` with the same contract: identical retry
// policy, identical revalidation hook, no copy-over and no unlink of the target.
// `Atomics.wait` is deliberately not used here — it blocks the event loop for up
// to 200ms, which on a UNC/locked target is exactly the stall this path must avoid
// (V7-M-07).
async function atomicRename(source, destination, { beforeRename } = {}) {
  for (let attempt = 0; ; attempt++) {
    beforeRename?.();
    try { await fs.promises.rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !transient.has(error.code) || attempt === 8) throw error;
      await sleep(25);
    }
  }
}

module.exports = { atomicRenameSync, atomicRename };
