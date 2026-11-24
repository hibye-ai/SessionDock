'use strict';
// Closed vocabulary only. Never render remote error text, arbitrary codes,
// endpoints, credentials, CSV content or exception properties as a close reason.
const LABELS = Object.freeze({
  OUTPUT_BACKLOG_LIMIT: '출력 대기 한도 초과로 앱이 연결을 종료했습니다.',
  CONSUMER_GONE: '화면 프로세스가 출력을 받을 수 없어 연결을 종료했습니다.',
  RECEIVE_CAPACITY: '수신 대기 예산이 부족하여 연결을 시작하지 못했습니다.',
  KEEPALIVE_TIMEOUT: '서버의 연결 유지 응답이 없어 연결을 종료했습니다.',
  ECONNRESET: '원격 연결이 초기화되었습니다.',
  EPIPE: '원격 연결이 끊어졌습니다.',
  ETIMEDOUT: '연결 응답 시간이 초과되었습니다.',
  USER_DISCONNECT: '사용자가 연결을 종료했습니다.',
  REMOTE_CLOSE: '원격 터미널 연결이 종료되었습니다.',
});
function disconnectLabel(event) {
  const code = event?.disconnectCause?.code || event?.code;
  return typeof code === 'string' && Object.hasOwn(LABELS, code) ? `${LABELS[code]} [${code}]` : '';
}
function outputDisconnectCause(input) {
  if (!input || !['OUTPUT_BACKLOG_LIMIT', 'CONSUMER_GONE'].includes(input.code)) return null;
  const cause = { code: input.code, origin: 'application', reason: ['backlog','global-backlog','consumer-gone'].includes(input.reason) ? input.reason : 'consumer-gone' };
  for (const key of ['limit','queuedBytes','inFlightBytes','rejectedBytes']) {
    if (Number.isSafeInteger(input[key]) && input[key] >= 0) cause[key] = input[key];
  }
  return Object.freeze(cause);
}
module.exports = { disconnectLabel, outputDisconnectCause };
