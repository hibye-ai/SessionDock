'use strict';
const MAX_COPY_TEXT = 1000000;
function sessionAddress(profile) {
  const protocol = profile.protocol === 'telnet' ? 'telnet' : 'ssh';
  const hostname = profile.host.includes(':') && !profile.host.startsWith('[') ? `[${profile.host}]` : profile.host;
  const username = protocol === 'ssh' && profile.username ? `${encodeURIComponent(profile.username)}@` : '';
  return `${protocol}://${username}${hostname}:${profile.port || (protocol === 'ssh' ? 22 : 23)}`;
}
function visibleTerminalText(terminal) {
  const buffer = terminal.buffer.active, end = Math.min(buffer.length, buffer.viewportY + terminal.rows);
  let text = '';
  for (let row = buffer.viewportY; row < end; row++) {
    const line = buffer.getLine(row); if (!line) continue;
    const wraps = row + 1 < end && buffer.getLine(row + 1)?.isWrapped;
    text += line.translateToString(!wraps, 0, terminal.cols) + (wraps ? '' : '\n');
    if (text.length > MAX_COPY_TEXT) throw new Error('화면 내용이 너무 큽니다. 필요한 부분을 선택해 복사해 주세요.');
  }
  return text.replace(/\n+$/, '');
}
function commandSelection(text, limit = 32768) {
  return typeof text === 'string' && !!text.trim() && text.length <= limit && !/[\r\n\x00]/.test(text);
}
module.exports = { sessionAddress, visibleTerminalText, commandSelection };
