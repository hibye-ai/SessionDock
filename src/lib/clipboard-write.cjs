'use strict';

const MAX_TEXT_LENGTH = 1024 * 1024;
const copyError = () => new Error('클립보드 복사에 실패했습니다. 다시 시도해 주세요.');

function validateClipboardOptions(options) {
  if (options === undefined) return;
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).length !== 1 || !Object.hasOwn(options, 'source') ||
      !['explicit', 'selection-auto'].includes(options.source)) throw copyError();
}

function createClipboardWriter({ clipboard }) {
  let active = false, pending = null, latest = 0;

  function valid(request) {
    try { return request.id === latest && request.isCurrent(); } catch { return false; }
  }

  async function run(request) {
    try {
      if (!valid(request)) throw copyError();
      await clipboard.writeText(request.text);
      if (!valid(request)) throw copyError();
      const actual = await clipboard.readText();
      if (!valid(request) || actual !== request.text) throw copyError();
      request.resolve();
    } catch {
      // Native errors may contain clipboard contents; never propagate them.
      request.reject(copyError());
    } finally {
      if (pending) {
        const next = pending;
        pending = null;
        void run(next);
      } else {
        active = false;
      }
    }
  }

  function write(text, { isCurrent = () => true } = {}) {
    if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return Promise.reject(new Error('클립보드 내용이 올바르지 않거나 너무 큽니다.'));
    if (!text) return Promise.reject(new Error('복사할 내용이 없습니다.'));
    if (typeof isCurrent !== 'function') return Promise.reject(copyError());
    try { if (!isCurrent()) return Promise.reject(copyError()); } catch { return Promise.reject(copyError()); }
    return new Promise((resolve, reject) => {
      const request = { text, isCurrent, resolve, reject, id: ++latest };
      if (active) {
        if (pending) pending.reject(copyError());
        pending = request;
      } else {
        active = true;
        void run(request);
      }
    });
  }
  return { write };
}

module.exports = { createClipboardWriter, validateClipboardOptions };
