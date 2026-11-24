'use strict';

// Only the structured reply from the command-specific IPC certifies that no
// write was attempted. A rejection, absent/malformed reply, or write-side
// error is ambiguous; none of these outcomes establishes device execution.
async function dispatchTerminalCommand(targets, payload, writeInput) {
  return Promise.all(targets.map(async target => {
    try {
      const result = await writeInput(target.id, payload);
      if (result?.status === 'accepted') return { target, status: 'accepted' };
      if (result?.status === 'not-sent' && typeof result.retryable === 'boolean') {
        return { target, status: 'not-sent', retryable: result.retryable };
      }
    } catch { /* unknown, never eligible for retry */ }
    return { target, status: 'unknown' };
  }));
}

function formatDispatchResults(results) {
  const labels = { accepted: '입력 전달 요청 접수', 'not-sent': '미전송', unknown: '전달 여부 미확인' };
  return results.map(({ target, status }) => `${target.label} · ${labels[status]}`).join('\n');
}

module.exports = { dispatchTerminalCommand, formatDispatchResults };
