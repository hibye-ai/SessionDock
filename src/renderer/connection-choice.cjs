'use strict';
// A qualified address is explicit; automatic lookup otherwise keeps saved profiles.
function qualifiedScheme(address) {
  const qualified = typeof address === 'string' && address.trim().match(/^(ssh|telnet):\/\//i);
  return qualified ? qualified[1].toLowerCase() : null;
}
// The port typed into the bar, ignoring any scheme, credentials and IPv6 brackets.
function explicitPort(address) {
  if (typeof address !== 'string') return null;
  let value = address.trim();
  if (!value) return null;
  const scheme = value.match(/^(?:ssh|telnet):\/\//i);
  if (scheme) value = value.slice(scheme[0].length);
  const at = value.lastIndexOf('@');
  if (at >= 0) value = value.slice(at + 1);
  const bracketed = /^\[[^\]]*\](?::(\d{1,5}))?$/.exec(value);
  if (bracketed) return bracketed[1] === undefined ? null : Number(bracketed[1]);
  // A bare IPv6 literal carries several colons and no port separator.
  const plain = /^[^:]+:(\d{1,5})$/.exec(value);
  return plain ? Number(plain[1]) : null;
}
// Hybrid quick connect: an explicit scheme wins, then a chosen SSH/Telnet, then an
// explicit 22/23 in the address. Any other port (2001, 2222, none at all) stays
// undecided so hidden autoProtocol metadata keeps the SSH-then-Telnet fallback.
function quickConnectionProtocol(address, selection = 'auto') {
  const scheme = qualifiedScheme(address);
  if (scheme) return scheme;
  if (['ssh', 'telnet'].includes(selection)) return selection;
  if (selection !== 'auto') return null;
  const port = explicitPort(address);
  return port === 23 ? 'telnet' : port === 22 ? 'ssh' : null;
}
// A closed port answers immediately, so retrying the same device over Telnet is a
// safe guess. A timeout usually means a firewall dropped the SYN: the user decides.
function isPortRefusedError(event) {
  if (event?.code === 'ECONNREFUSED') return true;
  return /ECONNREFUSED|connect ECONNREFUSED|거부/.test(String(event?.message ?? ''));
}
function isConnectionTimeout(event) {
  if (isPortRefusedError(event)) return false;
  if (['ETIMEDOUT', 'HANDSHAKE_TIMEOUT'].includes(event?.code)) return true;
  return /ETIMEDOUT|시간이 초과|타임아웃/.test(String(event?.message ?? ''));
}
// Infer only a committed edit in the form. Never migrate stored metadata by port.
function protocolForEditedPort(port, previousPort, explicitProtocol) {
  if (explicitProtocol || Number(port) === Number(previousPort)) return null;
  return Number(port) === 23 ? 'telnet' : Number(port) === 22 ? 'ssh' : null;
}
// A port that was never typed (or was 22) is retried on the classic Telnet port;
// a device given an explicit non-standard port keeps it, because that same port
// may serve Telnet on 2001/2222-style equipment.
function telnetFallbackPorts(port) {
  const from = Number(port) || 22;
  return { from, to: from === 22 ? 23 : from };
}
function telnetFallbackAddress(host, port) {
  const name = String(host ?? '').trim();
  if (!name) return null;
  return `telnet://${name.includes(':') ? `[${name}]` : name}:${telnetFallbackPorts(port).to}`;
}
module.exports = {
  quickConnectionProtocol, protocolForEditedPort, isPortRefusedError, isConnectionTimeout,
  telnetFallbackPorts, telnetFallbackAddress
};
