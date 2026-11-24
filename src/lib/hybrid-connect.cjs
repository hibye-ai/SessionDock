'use strict';
// Pure hybrid-connect policy shared by the main process and the renderer.
// No node:net here: the renderer bundle must stay DOM-only, and the TCP probe
// lives in port-probe.cjs, which only the main process loads.
function telnetFallbackPorts(port) {
  // A port that was never typed (or was 22) is retried on the classic Telnet
  // port; an explicit non-standard port (2001, 2222, …) is kept, because that
  // same port is exactly where such equipment serves Telnet.
  const from = Number(port) || 22;
  return { from, to: from === 22 ? 23 : from };
}
function telnetFallbackAddress(host, port) {
  const name = String(host ?? '').trim();
  if (!name) return null;
  return `telnet://${name.includes(':') ? `[${name}]` : name}:${telnetFallbackPorts(port).to}`;
}
// A closed port answers immediately, so retrying the same device over Telnet is
// a safe guess. A timeout usually means a firewall dropped the SYN: the user asks.
function isPortRefusedError(event) {
  if (event?.code === 'ECONNREFUSED') return true;
  return /ECONNREFUSED|connect ECONNREFUSED|거부/.test(String(event?.message ?? ''));
}
function isConnectionTimeout(event) {
  if (isPortRefusedError(event)) return false;
  if (['ETIMEDOUT', 'HANDSHAKE_TIMEOUT'].includes(event?.code)) return true;
  return /ETIMEDOUT|시간이 초과|타임아웃/.test(String(event?.message ?? ''));
}
module.exports = { telnetFallbackPorts, telnetFallbackAddress, isPortRefusedError, isConnectionTimeout };
