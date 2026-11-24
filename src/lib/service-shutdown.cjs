'use strict';

// One absolute grace period across every service. Late I/O keeps its original
// cleanup handlers, but an unresponsive network filesystem cannot prevent the
// application host from terminating after that period. No raw errors escape.
function createServiceShutdown(tasks, { timeoutMs = 15000 } = {}) {
  if (!Array.isArray(tasks) || tasks.some(task => typeof task !== 'function') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('Invalid shutdown tasks or deadline.');
  let operation;
  return () => operation ||= new Promise(resolve => {
    const pending = new Set(tasks.map((_, index) => index)); let failed = 0, settled = false;
    const finish = timedOut => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ timedOut, pending: pending.size, failed });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    Promise.all(tasks.map((task, index) => Promise.resolve().then(task).catch(() => { failed++; })
      .finally(() => { pending.delete(index); }))).then(() => finish(false));
  });
}

module.exports = { createServiceShutdown };
