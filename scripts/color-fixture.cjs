'use strict';
// Shared output for real loopback SSH/Telnet UI tests. No commands run on the host.
function colorFixture(command, send) {
  if(command==='color-attrs'){send('\r\nERROR ATTR_REWRITE');setTimeout(()=>send('\r\x1b[32mERROR ATTR_REWRITE\x1b[0m\r\n'),150);return true;}
  if(command==='gutter-redraw'){send('\x1b7\x1b[2J\x1b[3;1HERROR CURSOR_REDRAW\x1b8');return true;}
  if(command==='color-neutral'){send('\r\n\x1b[30mERROR NEUTRAL_BLACK\x1b[0m\r\n\x1b[37mERROR NEUTRAL_WHITE\x1b[0m\r\n\x1b[90mWARNING NEUTRAL_GRAY\x1b[0m\r\n\x1b[97mSUCCESS NEUTRAL_BRIGHT_WHITE\x1b[0m\r\nNEUTRAL_DONE\r\n');return true;}
  if (command === 'display-bell') { send('\x07\r\nBELL_DONE\r\n'); return true; }
  if (command === 'color-sample') {
    send('\r\nuser@server:~/logs$ tail -f /var/log/app.log\r\n한글 경로 /home/사용자/logs · IP 192.0.2.109 · port 22\r\nSUCCESS connected · WARNING timeout · ERROR denied\r\ntrue false 4096 12.5% 2001:db8::1\r\n\x1b[32mERROR SERVER_GREEN\x1b[0m\r\n\x1b[38;2;18;52;86mERROR SERVER_RGB\x1b[0m\r\n\x1b[44mERROR SERVER_BG\x1b[0m\r\n\x1b[3mERROR SERVER_ITALIC\x1b[0m\r\n\x1b[7mERROR SERVER_INVERSE\x1b[0m\r\nCOLOR_SAMPLE_DONE\r\n');return true;
  }
  if (command === 'color-fragment') {
    // Deliberately split a Korean UTF-8 codepoint and a keyword across transport writes.
    const bytes=Buffer.from('\r\n조각 ERROR FRAGMENT_DONE\r\n');
    send(bytes.subarray(0,3));setTimeout(()=>send(bytes.subarray(3,12)),15);setTimeout(()=>send(bytes.subarray(12)),35);return true;
  }
  if (command === 'color-rewrite') {send('\r\nERROR REWRITE_TARGET');setTimeout(()=>send('\r\x1b[2KOK REWRITE_TARGET\r\n'),150);return true;}
  if (command === 'color-alt') {send('\x1b[?1049h\x1b[2J\x1b[HERROR ALT_SCREEN\r\n\x1b[32mERROR ALT_GREEN\x1b[0m');return true;}
  if (command === 'color-normal') {send('\x1b[?1049l\r\nSUCCESS NORMAL_SCREEN\r\n');return true;}
  if (command === 'color-scroll') {send(Array.from({length:2500},(_,i)=>`ERROR SCROLL_${i} 192.168.1.1 /var/log/app.log\r\n`).join(''));return true;}
  if (command === 'color-wrap') {send('\r\n'+ '한글 '.repeat(14) + '/var/log/very-long-directory/ERROR-file.log WRAPPED_DONE\r\n');return true;}
  return false;
}
module.exports={colorFixture};
