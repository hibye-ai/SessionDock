'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { patterns, text, ends } = workerData;

// Scan arrival boundaries in order. Collapsing them into only the newest text
// would miss a transient delimiter such as /ready$/ followed by another chunk.
parentPort.postMessage({ type: 'started' });
try {
  let selected = null;
  for (const end of ends) {
    const unread = text.slice(0, end);
    for (let caseIndex = 0; caseIndex < patterns.length; caseIndex++) {
      const item = patterns[caseIndex];
      let match;
      if (item.literal !== undefined) {
        const index = unread.indexOf(item.literal);
        if (index !== -1) match = { index, text: item.literal, value: item.literal };
      } else {
        const found = item.regex.exec(unread);
        if (found) {
          if (!found[0].length) throw new Error('empty delimiter');
          match = { index: found.index, text: found[0], value: found[1] ?? found[0] };
        }
      }
      if (match && (!selected || match.index < selected.index)) selected = { ...match, caseIndex };
    }
    if (selected) break;
  }
  parentPort.postMessage({ type: 'result', match: selected });
} catch {
  // Do not propagate pattern text, received text or native exception messages.
  parentPort.postMessage({ type: 'result', invalid: true });
}
