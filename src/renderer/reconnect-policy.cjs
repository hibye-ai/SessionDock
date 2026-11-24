'use strict';
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'HANDSHAKE_TIMEOUT']);
const NEVER_AUTO_RETRY = new Set(['AUTH_CANCELLED', 'AUTH_RESPONSE_TIMEOUT', 'AUTH_FAILED', 'AUTH_REQUIRED',
  'AUTH_CONNECTION_CLOSED', 'AUTH_RETRY_NEW_CONNECTION_REQUIRED', 'AUTH_PASSWORD_CHANGE_REQUIRED',
  'HOST_KEY_REJECTED', 'HOST_KEY_CHANGED', 'INVALID_KEY']);
function mayRetry(record, event) {
  if (NEVER_AUTO_RETRY.has(event.code) || NEVER_AUTO_RETRY.has(event.disconnectCause?.code)) return false;
  if (['OUTPUT_BACKLOG_LIMIT', 'CONSUMER_GONE'].includes(event.disconnectCause?.code || event.code)) return false;
  return !!record.profile.autoReconnect && !record.manualDisconnect && !record.closing
    && (record.everConnected || record.retryCycle)
    && (record.retryAttempts || 0) < (record.profile.reconnectAttempts || 1)
    && (event.status === 'disconnected' || (event.status === 'error' && RETRYABLE.has(event.code)));
}
function shouldReconnectOnEnter(record, event) {
  return !!record && ['error', 'disconnected'].includes(record.status)
    && !record.reconnecting && !record.reconnectOperation && !record.closing
    && event?.type === 'keydown' && !event.defaultPrevented && !event.repeat
    && !event.isComposing && event.keyCode !== 229 && event.which !== 229
    && event.key === 'Enter' && (!event.code || ['Enter', 'NumpadEnter'].includes(event.code))
    && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    && !event.getModifierState?.('AltGraph');
}
module.exports = { mayRetry, shouldReconnectOnEnter };
