'use strict';

/**
 * Detects a full-screen repaint in terminal output.
 *
 * A network device pager (ExtremeXOS `show ports`, Cisco `show ... | page`) is
 * not line output: it repaints the whole screen with absolute cursor addressing
 * and, on most platforms, a screen erase. xterm.js stores that in the live
 * screen at the bottom of the buffer while a scrolled-back viewport keeps
 * showing older rows, so the device appears to ignore `u`/`d` even though the
 * new page parsed correctly. Callers use this detector to bring the viewport
 * back to the live screen for a repaint, without disturbing ordinary output
 * (which must never steal a scroll position).
 *
 * Detection is deliberately conservative — only sequences that genuinely erase
 * or replace the whole screen count:
 *   ESC [ 2 J / ESC [ 3 J       erase display / erase saved lines
 *   ESC c                       hard reset
 *   ESC [ ? 1049 h/l (47, 1047) alternate screen enter or exit
 *   ESC [ H (or 1;1H) followed by ESC [ J in the same chunk: home + erase below
 *
 * Ordinary output, carriage-return progress lines, ESC [ K and scrolling
 * regions never match. A sequence may span two chunks: a bounded tail is
 * carried forward, and a trigger that ends inside the carried overlap is
 * ignored so one repaint is reported once.
 *
 * The scan is one forward pass over a single token alternation, so it costs
 * O(scanned bytes). The first version searched the whole remaining suffix for an
 * erase at every home it found, which made a legal `ESC[H`-heavy stream
 * quadratic: 21,845 homes in 65,535 bytes took 358ms (V9-M-10). A home never
 * followed by an erase is ordinary status-line addressing, so only the presence
 * of an unmatched home is remembered instead of a list of positions to re-search.
 */

// 16 bytes covers the longest prefix of any pattern below, so a split sequence
// is still recognised on the next chunk.
const CARRY_LIMIT = 16;
// A device page repaint always starts its response. Scanning unbounded output on
// every keystroke would cost more than the repaint it detects.
const SCAN_LIMIT = 64 * 1024;

// Every token that can start or complete a repaint, in one alternation: one
// `exec` loop classifies the stream in order, and `2J`/`3J` are tried before the
// bare `J` so an erase-display is never mistaken for an erase-below.
const TOKEN = /\x1b\[(?:2J|3J|1;1H|H|0J|J)|\x1bc|\x1b\[\?(?:1049|1047|47)[hl]/g;
// Erase-below only repaints when a cursor home preceded it.
const ERASE_BELOW = new Set(['\x1b[J', '\x1b[0J']);
// A home without an erase is a status-line redraw, not a page repaint.
const CURSOR_HOME = new Set(['\x1b[H', '\x1b[1;1H']);

// True when the sample holds a trigger that ends after `after` code units. A
// trigger that ends inside the carried overlap was already reported for the
// previous chunk, so it does not count twice.
function hasRepaint(text, after = 0) {
  if (typeof text !== 'string' || !text) return false;
  const sample = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  let pendingHome = false;
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(sample)) !== null) {
    const token = match[0];
    const end = match.index + token.length;
    if (ERASE_BELOW.has(token)) {
      // Home + erase below is the repaint. One home pairs with the first erase
      // after it, and only the nearest home can pair, so a single flag is enough
      // — the previous code re-searched the whole remaining suffix here.
      if (pendingHome) {
        if (end > after) return true;
        pendingHome = false;
      }
      continue;
    }
    if (CURSOR_HOME.has(token)) { pendingHome = true; continue; }
    // Erase display / hard reset / alternate screen: a repaint on its own.
    if (end > after) return true;
  }
  return false;
}

// Latin-1 (byte-per-code-unit) decoding of one byte range, without Node's
// Buffer: this module runs in the sandboxed renderer, where Buffer does not
// exist. Control sequences are ASCII, so no multi-byte decoding is needed.
function latin1(bytes, from, to) {
  let text = '';
  for (let index = from; index < to; index += 4096) {
    text += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(to, index + 4096)));
  }
  return text;
}

// Splits a chunk into the bounded head that is scanned and the chunk's *actual*
// tail, which is what the next chunk has to be joined with.
//
// Carrying `window.slice(-carryLimit)` out of the decoded prefix was wrong for an
// oversized chunk: the decoded prefix ends at the scan limit, not at the chunk,
// so the real last bytes — the only place a split sequence can be — were dropped
// and bytes from the middle of the chunk were carried instead, so a sequence that
// began at the scan boundary was never completed by the next chunk (V9-M-10).
function decodeChunk(chunk, carryLimit) {
  if (typeof chunk === 'string') {
    if (!chunk) return null;
    const head = chunk.length > SCAN_LIMIT ? chunk.slice(0, SCAN_LIMIT) : chunk;
    const tailStart = chunk.length - carryLimit;
    return { head, tail: tailStart <= 0 ? chunk : chunk.slice(tailStart) };
  }
  if (chunk instanceof ArrayBuffer) chunk = new Uint8Array(chunk);
  if (!ArrayBuffer.isView(chunk)) return null;
  const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const length = bytes.length;
  if (!length) return null;
  // Only the scanned head and the carried tail are decoded; a huge chunk must not
  // pay for a string conversion it will not inspect.
  const headLength = Math.min(length, SCAN_LIMIT);
  const tailStart = Math.max(0, length - carryLimit);
  const head = latin1(bytes, 0, headLength);
  return { head, tail: tailStart >= headLength ? latin1(bytes, tailStart, length) : head.slice(tailStart) };
}

/** True when this chunk contains a whole-screen repaint. */
function isScreenRepaint(text) {
  return hasRepaint(text, 0);
}

/**
 * Stateful wrapper for chunked output. `observe(chunk)` returns true when this
 * chunk completed a screen repaint. `reset()` forgets the carried bytes.
 */
class ScreenRepaintDetector {
  constructor({ carryLimit = CARRY_LIMIT } = {}) {
    if (!Number.isInteger(carryLimit) || carryLimit < 4 || carryLimit > 64) {
      const error = new TypeError('Invalid screen repaint detector: carryLimit must be 4..64.');
      error.code = 'ERR_VALIDATION';
      throw error;
    }
    this.carryLimit = carryLimit;
    this.carry = '';
  }

  observe(chunk) {
    if (!chunk) return false;
    const decoded = decodeChunk(chunk, this.carryLimit);
    if (!decoded) return false;
    const carryLength = this.carry.length;
    // Only the carried bytes plus the bounded head are scanned, so a giant chunk
    // costs O(SCAN_LIMIT) instead of O(chunk.length).
    const window = carryLength ? this.carry + decoded.head : decoded.head;
    const repaint = hasRepaint(window, carryLength);
    // Keep the real end of this chunk. Joining the previous carry keeps a sequence
    // split across several short chunks completing, and the final slice bounds
    // what the next observation has to look at.
    const tail = carryLength ? this.carry + decoded.tail : decoded.tail;
    this.carry = tail.slice(-this.carryLimit);
    return repaint;
  }

  reset() { this.carry = ''; }
}

function createScreenRepaintDetector(options) { return new ScreenRepaintDetector(options); }

module.exports = { isScreenRepaint, createScreenRepaintDetector, ScreenRepaintDetector, CARRY_LIMIT };
