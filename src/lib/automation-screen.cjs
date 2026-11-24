'use strict';
const { randomUUID } = require('node:crypto');

const failure = (message, code = 'ERR_AUTOMATION_DISCONNECTED') => Object.assign(new Error(message), { code });

// Own the complete screen-read lifetime, including the parser synchronization
// before a renderer request exists. Cancelling a job must cancel both waits.
class AutomationScreenReader {
  constructor({ synchronize, isConnected, send, timeoutMs = 5000, replyTimeoutMs = 2500 }) {
    Object.assign(this, { synchronize, isConnected, send, timeoutMs, replyTimeoutMs });
    this.requests = new Map(); this.closed = false;
  }
  read(connectionId, rectangle, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(failure('앱이 종료되었습니다.'));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID(), controller = new AbortController();
      let timer, replyTimer, settled = false;
      const settle = (success, value) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(replyTimer); signal?.removeEventListener('abort', abort);
        this.requests.delete(requestId);
        if (success) resolve(value); else { controller.abort(value); reject(value); }
      };
      const abort = () => settle(false, signal.reason);
      const timeout = () => settle(false, failure('화면 응답 시간이 초과되었습니다.', 'ERR_AUTOMATION_TIMEOUT'));
      this.requests.set(requestId, { connectionId, resolve: text => settle(true, text), reject: error => settle(false, error) });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(timeout, this.timeoutMs);
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return this.synchronize(connectionId, { signal: controller.signal });
      }).then(() => {
        controller.signal.throwIfAborted();
        if (!this.isConnected(connectionId)) throw failure('연결이 종료되었습니다.');
        replyTimer = setTimeout(timeout, this.replyTimeoutMs);
        this.send({ type: 'automation-screen', requestId, connectionId, rectangle });
      }).catch(error => settle(false, error));
    });
  }
  reply(requestId, text) {
    const request = this.requests.get(requestId); if (!request) return false;
    if (typeof text !== 'string' || text.length > 1024 * 1024) request.reject(failure('화면을 읽을 수 없습니다.', 'ERR_AUTOMATION_PROTOCOL'));
    else request.resolve(text);
    return true;
  }
  cancelConnection(connectionId) {
    for (const request of this.requests.values()) if (request.connectionId === connectionId) request.reject(failure('연결이 종료되었습니다.'));
  }
  close() {
    this.closed = true;
    for (const request of this.requests.values()) request.reject(failure('앱이 종료되었습니다.'));
  }
}
module.exports = { AutomationScreenReader };
