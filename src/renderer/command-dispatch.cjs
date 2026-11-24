'use strict';

// The transport can accept bytes without confirming that the remote device
// executed anything. A rejected IPC call cannot prove that nothing was sent.
async function dispatchTerminalCommand(targets, payload, writeInput) {
  return Promise.all(targets.map(async target => {
    try {
      await writeInput(target.id, payload);
      return { target, status: 'accepted' };
    } catch {
      return { target, status: 'unknown' };
    }
  }));
}

function formatDispatchResults(results) {
  return results.map(({ target, status }) =>
    `${target.label} · ${status === 'accepted' ? '입력 전달 요청 접수' : '전달 여부 미확인'}`).join('\n');
}

module.exports = { dispatchTerminalCommand, formatDispatchResults };
