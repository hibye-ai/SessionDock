'use strict';
const net = require('node:net');

const MAX_PROBE_MS = 2000;
const DEFAULT_BUDGET_MS = 900;
// RFC 4253 lets the server send arbitrary text before its identification string,
// and that text arrives in whatever segments TCP chooses. Only a consumed,
// line-bounded parse reads that correctly: a fixed prefix window both cuts off
// long pre-banners and lets an unterminated line decide the verdict (V9-M-01).
// A line longer than this cannot become a prompt, so it is discarded through its
// newline and the parser keeps looking at the lines that follow.
const LINE_BYTES = 16 * 1024;
// The identification string only needs its first bytes to be recognisable; keeping
// them separately means an overlong line that *starts* with a valid identification
// string still confirms SSH without retaining the whole banner.
const HEAD_BYTES = 32;
// A per-probe ceiling on parsed bytes, independent of the time budget: a peer that
// streams short lines forever must not turn the probe into unbounded work.
const TOTAL_BYTES = 1024 * 1024;
// Fewer bytes than this is not evidence of a service.
const MIN_TEXT_BYTES = 8;
// How long plain, prompt-free text has to prove itself unrelated before the probe
// answers early. Prompt-shaped text never uses this window; it waits for the whole
// budget (V9-M-01).
const GRACE_MS = 250;

// Plain text that looks like a login prompt. Deliberately *not* 'telnet': an RFC
// 4253 pre-banner may say `Login:`, and a TCP segment end is not a logical prompt
// end, so text alone can never authorise a downgrade to an unencrypted transport
// (V9-M-01). The caller keeps SSH and may offer Telnet explicitly instead.
const PLAINTEXT_PROMPT = 'plaintext-prompt';

// RFC 4253 §4.2 identification string, anchored at byte 0 of its line:
// `SSH-protoversion-softwareversion SP comments CR LF`. Only the protoversions this
// client speaks confirm SSH — 2.0, or 1.99 (a server announcing 2.0 support while
// running the 1.x exchange). Leading whitespace, prose
// (`Documentation: SSH-2.0 is supported`) and other versions are neither trimmed
// nor widened into confirmations: the grammar is the evidence, not a substring.
const SSH_IDENT = /^SSH-(?:2\.0|1\.99)-/;
const SSH_IDENT_PREFIXES = Object.freeze(['SSH-2.0-', 'SSH-1.99-']);
// An explicit credential prompt: a line that *asks* for credentials. It names the
// plaintext-prompt verdict, and never decides a protocol switch on its own.
const CREDENTIAL_BANNER = /^(?:username|user ?name|login|password|passcode|press any key|사용자|로그인|암호)/i;
const CREDENTIAL_PROMPT = /^(?:username|user ?name|login|password|passcode|press any key|사용자\s*이름|사용자|로그인|암호)[\s:>]{0,3}$/i;
// A colon/prompt-shaped ending: `Authorized use only:`, `lab-switch# `.
const PROMPT_ENDING = /[:#>$%]\s*$/;
// Telnet command bytes that follow IAC (RFC 854: NOP..GA and the option verbs).
const IAC_COMMAND = value => value >= 240 && value <= 254;

// `S`, `SS`, `SSH`, `SSH-2.` — a partial identification string whose next segment
// may still complete it, so no verdict may be given yet. An empty or unrelated
// start is not a prefix: it can never grow into an identification string.
function isIdentPrefix(partial) {
  if (!partial.length) return false;
  return SSH_IDENT_PREFIXES.some(prefix => partial.length < prefix.length && prefix.startsWith(partial));
}

// Strip NVT/terminal control bytes, then trim. Only prompt *classification* works
// on this text; identification matching uses the raw line bytes.
function cleanLine(value) {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
}

function looksLikePrompt(text) {
  return Boolean(text) && (CREDENTIAL_PROMPT.test(text) || CREDENTIAL_BANNER.test(text) || PROMPT_ENDING.test(text));
}

// A consumed pre-banner parser: complete lines are judged once and dropped, and
// only the line that has not ended yet is retained. Nothing already judged is
// re-scanned, so a long pre-banner costs one pass instead of a Buffer.concat of the
// whole prefix on every segment (V9-M-01).
function createPreambleParser() {
  const line = Buffer.allocUnsafe(LINE_BYTES);
  const head = Buffer.allocUnsafe(HEAD_BYTES);
  let lineLength = 0, headLength = 0, overlong = false, lastWasCr = false;
  let completeTextBytes = 0, promptEvidence = false, sawIdent = false;
  let sawIac = false, iacPending = false;
  let consumedBytes = 0, limited = false;

  // IAC evidence has to survive a segment boundary: a lone 0xff at the end of a
  // segment is only the first half of a negotiation command.
  const scanIac = bytes => {
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (!iacPending) { if (byte === 0xff) iacPending = true; continue; }
      iacPending = false;
      // IAC IAC is a literal 0xff in the data stream, not negotiation.
      if (byte !== 0xff && IAC_COMMAND(byte)) return true;
    }
    return false;
  };

  const headText = () => head.toString('latin1', 0, headLength);
  const resetLine = () => { lineLength = 0; headLength = 0; overlong = false; };

  const endLine = () => {
    if (SSH_IDENT.test(headText())) sawIdent = true;
    // An overlong line is dropped whole: it cannot be a credential prompt, and its
    // tail must never be mistaken for an identification string.
    const text = overlong ? '' : cleanLine(line.toString('latin1', 0, lineLength));
    resetLine();
    if (!text) return;
    completeTextBytes += text.length;
    if (looksLikePrompt(text)) promptEvidence = true;
  };

  const feed = chunk => {
    if (limited || !chunk.length) return;
    let bytes = chunk;
    if (consumedBytes + bytes.length > TOTAL_BYTES) {
      bytes = bytes.subarray(0, Math.max(0, TOTAL_BYTES - consumedBytes));
      limited = true;
    }
    consumedBytes += bytes.length;
    if (!sawIac && scanIac(bytes)) sawIac = true;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (lastWasCr) {
        lastWasCr = false;
        if (byte === 10) continue;
      }
      if (byte === 13 || byte === 10) {
        endLine();
        if (byte === 13) lastWasCr = true;
        continue;
      }
      if (headLength < HEAD_BYTES) head[headLength++] = byte;
      if (overlong) continue;
      if (lineLength >= LINE_BYTES) { overlong = true; lineLength = 0; continue; }
      line[lineLength++] = byte;
    }
  };

  // 'early' while data is flowing, 'grace' when plain text has had its window,
  // 'final' at the deadline or on close.
  const verdict = stage => {
    // IAC is the device speaking Telnet on the wire: the only explicit, text-free
    // evidence, so it decides at every stage.
    if (sawIac) return 'telnet';
    const currentHead = headText();
    if (SSH_IDENT.test(currentHead)) return 'ssh';
    if (sawIdent) return 'ssh';
    // A partial identification string may still complete in the next segment.
    if (isIdentPrefix(currentHead)) return undefined;
    const partial = overlong ? '' : cleanLine(line.toString('latin1', 0, lineLength));
    const prompt = promptEvidence || looksLikePrompt(partial);
    const textBytes = completeTextBytes + (partial ? partial.length : 0);
    if (stage !== 'final') {
      // Only an unrelated service answers before the budget ends, and only with a
      // verdict that keeps the caller's protocol.
      if (stage === 'grace' && !prompt && textBytes >= MIN_TEXT_BYTES) return 'other';
      return undefined;
    }
    // Text that merely looks like a prompt is a candidate for an explicit Telnet
    // offer, never a switch.
    if (prompt) return PLAINTEXT_PROMPT;
    if (textBytes >= MIN_TEXT_BYTES) return 'other';
    return undefined;
  };

  return { feed, verdict };
}

// Classify a port before any credential prompt is opened:
//   'refused'           the peer's stack answered at once -> the Telnet retry is safe
//   'ssh'               a line-anchored SSH-2.0-/SSH-1.99- identification string
//   'telnet'            IAC option negotiation: the device speaks Telnet on the wire
//   'plaintext-prompt'  text that looks like a login prompt with no wire evidence.
//                       NOT a Telnet confirmation: the caller keeps SSH and may
//                       offer Telnet explicitly (V9-M-01)
//   'other'             a listener that is neither -> keep the caller's protocol
//   'timeout'           no answer inside the budget (filtered or silent) -> keep, then ask
//   'unknown'           an unusable host/port was supplied, or the probe failed
//
// Every limit is independent: one line may be at most LINE_BYTES, the whole probe
// parses at most TOTAL_BYTES, and the answer is given inside the time budget. When
// any of them is reached without evidence the probe stays non-committal, because a
// wrong automatic downgrade would move a real SSH session onto plaintext.
function probePort(host, port, timeoutMs = DEFAULT_BUDGET_MS) {
  if (typeof host !== 'string' || !host.trim() || /[\s\0]/.test(host)) return Promise.resolve('unknown');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve('unknown');
  const budget = Math.min(MAX_PROBE_MS, Math.max(50, Number(timeoutMs) || DEFAULT_BUDGET_MS));
  return new Promise(resolve => {
    const parser = createPreambleParser();
    const socket = new net.Socket();
    let settled = false, graceTimer = null;
    const finish = state => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      socket.destroy();
      resolve(state);
    };
    const settle = fallback => {
      const state = parser.verdict('final');
      if (state) finish(state);
      else if (fallback) finish(fallback);
    };
    // A failed or finished connection is not a protocol classification: only
    // evidence that stands on its own (an identification string, or IAC on the
    // wire) is kept. A partial text verdict here would otherwise turn a broken
    // peer into a downgrade decision.
    const settleDisconnected = fallback => {
      const state = parser.verdict('final');
      if (state === 'ssh' || state === 'telnet') finish(state);
      else finish(fallback);
    };
    const settleText = () => {
      const state = parser.verdict('early');
      if (state) { finish(state); return; }
      // Text without a verdict stays ambiguous until the whole budget is spent: the
      // peer may print a welcome line and identify itself as SSH in a later segment.
      // Only prompt-free text may shorten that wait, and only to a grace window
      // (V9-M-01).
      if (graceTimer || budget <= GRACE_MS) return;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        const decided = parser.verdict('grace');
        if (decided) finish(decided);
      }, GRACE_MS);
      graceTimer.unref?.();
    };
    const timer = setTimeout(() => settle('timeout'), budget);
    timer.unref?.();
    socket.setTimeout(budget);
    socket.once('timeout', () => settle('timeout'));
    socket.once('error', error => (error?.code === 'ECONNREFUSED' ? finish('refused') : settleDisconnected('unknown')));
    socket.once('close', () => settleDisconnected('unknown'));
    socket.on('data', chunk => {
      if (settled) return;
      parser.feed(chunk);
      settleText();
    });
    socket.connect(port, host);
  });
}
module.exports = { probePort, PLAINTEXT_PROMPT };
