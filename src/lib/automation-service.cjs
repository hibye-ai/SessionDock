'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { AutomationRegex, REGEX_LIMITS } = require('./automation-regex.cjs');
const { createTerminalDecoder, normalizeTerminalEncoding } = require('./terminal-encoding.cjs');

/* Independent, opt-in terminal automation. No store, UI, reconnect or credential access.
 * constructor({getConnectionInfo,input,emit?,logDirectory?,pythonExecutable?,bridgePath?,readScreen?})
 * input(id, text) sends to that exact live connection; input may return a Promise.
 * input(id, null, {disconnect:true}) is the explicit Python Session.Disconnect hook.
 * onData({id,data,encoding?}): exact decoded string, or streaming bytes (UTF-8 by default).
 * Transport data events ALREADY contain UTF-8 display bytes, including legacy base64.
 * Decode base64 at the caller; never use the original wire encoding a second time.
 * onStatus({id,status}) terminates on every status other than 'connected'.
 * start({connectionId,steps,name?,outputFile?}) / startPython({connectionId,scriptPath,outputFile?})
 * return a job ID synchronously; execution starts in a microtask. cancel(id): boolean.
 * listJobs(): active metadata only; close(): Promise (also reaps children/workers).
 * Output is the exact received transcript since start, saved ONLY on success. Relative
 * output paths require logDirectory; no outputFile means no disk transcript at all.
 *
 * JSON step schema (timeouts in ms, default 30000; sendLine appends CR):
 * send/sendLine {text,waitFor?,timeoutMs?}; waitFor {pattern,timeoutMs?,token?};
 * capture {pattern,timeoutMs?,token?,includeMatch?}; sleep {durationMs};
 * expectSend {pattern,text,timeoutMs?,sendLine?,waitFor?};
 * respond {cases:[{pattern,text,sendLine?,waitFor?}],timeoutMs?,token?};
 * if {token,pattern,then:[steps],else?:[steps]}.
 * Pattern: string, {literal:string}, {regex:string,flags?:string}, or RegExp (JS only).
 * token defaults to 'last'. wait/response stores group 1 or the whole match; capture
 * stores all unread text before its delimiter (optionally including it). Send text
 * interpolates {{token}}; unknown tokens fail. Waits consume through the delimiter;
 * unmatched suffixes remain available. Matching/transcripts preserve ANSI exactly.
 * Regex execution uses bounded, terminable workers (including `if` conditions).
 * Worker startup/queue time counts toward its 1s budget and the enclosing wait;
 * overload/time limits use ERR_AUTOMATION_LIMIT/ERR_AUTOMATION_TIMEOUT.
 *
 * Events: {type:'automation',jobId,connectionId,status,step,operation?,code?,
 * receivedBytes,sentBytes,saved?,channel?,bytes?}. No script paths, names, texts,
 * patterns, token values, stdout, stderr, exceptions or tracebacks are emitted.
 * readScreen(id,{row1,col1,row2,col2})?: async string snapshot of the exact connection's
 * actual screen, 1-based inclusive cells. The caller correlates renderer replies;
 * Get validates coordinates, bounds the response and times out after 5 seconds.
 * Without readScreen, Get uses a bounded, ANSI-stripped rolling line view starting
 * at job launch, not xterm's screen or a cursor-addressed/full-screen emulator.
 * CPython is caller-supplied, launched with -I -S -u; no discovery or installation.
 * Local selected Python scripts intentionally have normal user filesystem rights;
 * their directory is the working directory for relative file I/O, not an import path.
 */

const LIMITS = Object.freeze({
  jobs: 32, steps: 1000, depth: 8, input: 64 * 1024, sent: 1024 * 1024,
  transcript: 4 * 1024 * 1024, pattern: 2048, tokens: 1024 * 1024,
  timeoutMs: 300000, runtimeMs: 1800000, rpc: 256 * 1024, requests: 10000,
  stderr: 64 * 1024, screenRows: 200, screenColumns: 500, screenTimeoutMs: 5000
});
const CODES = new Set(['ERR_AUTOMATION_CANCELLED', 'ERR_AUTOMATION_DISCONNECTED',
  'ERR_AUTOMATION_TIMEOUT', 'ERR_AUTOMATION_LIMIT', 'ERR_AUTOMATION_VALIDATION',
  'ERR_AUTOMATION_INPUT', 'ERR_AUTOMATION_OUTPUT', 'ERR_AUTOMATION_PYTHON',
  'ERR_AUTOMATION_PROTOCOL', 'ERR_AUTOMATION_TOKEN']);
function fault(code) { const error = new Error(code); error.code = code; return error; }
function check(value, code = 'ERR_AUTOMATION_VALIDATION') { if (!value) throw fault(code); }
function boundedText(value, limit, empty = true) {
  check(typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value) <= limit);
  return value;
}
function duration(value, fallback = 30000) {
  value ??= fallback;
  check(Number.isInteger(value) && value >= 0 && value <= LIMITS.timeoutMs);
  return value;
}
function pattern(value) {
  if (typeof value === 'string') return { literal: boundedText(value, LIMITS.pattern, false) };
  check(value && typeof value === 'object');
  if (typeof value.literal === 'string') return { literal: boundedText(value.literal, LIMITS.pattern, false) };
  const source = value instanceof RegExp ? value.source : value.regex;
  const flags = value instanceof RegExp ? value.flags : value.flags || '';
  boundedText(source, LIMITS.pattern, false);
  check(typeof flags === 'string' && /^[imsu]*$/.test(flags));
  try { return { regex: new RegExp(source, flags) }; } catch { throw fault('ERR_AUTOMATION_VALIDATION'); }
}
function findLiteral(compiled, text) {
  const index = text.indexOf(compiled.literal);
  return index < 0 ? null : { index, text: compiled.literal, value: compiled.literal };
}
function tokenName(value = 'last') {
  check(typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)); return value;
}
function compileSteps(steps, budget = { count: 0 }, depth = 0) {
  check(Array.isArray(steps) && steps.length <= LIMITS.steps && depth <= LIMITS.depth);
  return steps.map(step => {
    check(step && typeof step === 'object' && ++budget.count <= LIMITS.steps);
    const out = { type: step.type };
    switch (step.type) {
      case 'send': case 'sendLine':
        out.text = boundedText(step.text, LIMITS.input);
        if (step.waitFor !== undefined) out.waitFor = pattern(step.waitFor);
        out.timeoutMs = duration(step.timeoutMs); break;
      case 'waitFor': case 'capture': case 'expectSend':
        out.pattern = pattern(step.pattern); out.timeoutMs = duration(step.timeoutMs);
        out.token = tokenName(step.token); out.includeMatch = step.includeMatch === true;
        if (step.type === 'expectSend') {
          out.text = boundedText(step.text, LIMITS.input); out.sendLine = step.sendLine === true;
          if (step.waitFor !== undefined) out.waitFor = pattern(step.waitFor);
        }
        break;
      case 'respond':
        check(Array.isArray(step.cases) && step.cases.length > 0 && step.cases.length <= 32);
        out.cases = step.cases.map(item => {
          check(item && typeof item === 'object');
          return { pattern: pattern(item.pattern), text: boundedText(item.text, LIMITS.input),
            sendLine: item.sendLine === true,
            waitFor: item.waitFor === undefined ? undefined : pattern(item.waitFor) };
        });
        out.timeoutMs = duration(step.timeoutMs); out.token = tokenName(step.token); break;
      case 'sleep': out.durationMs = duration(step.durationMs, 0); break;
      case 'if':
        out.token = tokenName(step.token); out.pattern = pattern(step.pattern);
        out.then = compileSteps(step.then, budget, depth + 1);
        out.else = compileSteps(step.else ?? [], budget, depth + 1); break;
      default: throw fault('ERR_AUTOMATION_VALIDATION');
    }
    return out;
  });
}

// Bounded line view for Python Screen.Get, not a replacement terminal emulator.
// State survives fragmented CSI/OSC/DCS.
class RollingScreen {
  constructor(rows, cols) {
    this.rows = Math.min(LIMITS.screenRows, Math.max(1, rows || 24));
    this.cols = Math.min(LIMITS.screenColumns, Math.max(1, cols || 80));
    this.lines = ['']; this.state = 'text'; this.column = 0;
  }
  write(text) {
    for (const char of text) {
      if (this.state === 'esc') {
        this.state = char === '[' ? 'csi' : [']', 'P', '^', '_'].includes(char) ? 'string' : 'text'; continue;
      }
      if (this.state === 'csi') { if (/[@-~]/.test(char)) this.state = 'text'; continue; }
      if (this.state === 'string') { if (char === '\x07') this.state = 'text'; else if (char === '\x1b') this.state = 'st'; continue; }
      if (this.state === 'st') { this.state = char === '\\' ? 'text' : 'string'; continue; }
      if (char === '\x1b') { this.state = 'esc'; continue; }
      if (char === '\r') { this.column = 0; continue; }
      if (char === '\n') { this.lines.push(''); if (this.lines.length > this.rows) this.lines.shift(); this.column = 0; continue; }
      if (char === '\b') { this.column = Math.max(0, this.column - 1); continue; }
      if (char < ' ') continue;
      if (this.column >= this.cols) { this.lines.push(''); if (this.lines.length > this.rows) this.lines.shift(); this.column = 0; }
      const chars = Array.from(this.lines.at(-1));
      while (chars.length < this.column) chars.push(' ');
      chars[this.column++] = char; this.lines[this.lines.length - 1] = chars.join('');
    }
  }
  get(r1, c1, r2, c2) {
    check([r1, c1, r2, c2].every(Number.isInteger) && r1 >= 1 && r2 >= r1 && r2 <= this.rows &&
      c1 >= 1 && c2 >= 1 && c1 <= this.cols && c2 <= this.cols && (r1 !== r2 || c2 >= c1));
    const lines = [];
    for (let row = r1; row <= r2; row++) {
      const chars = Array.from(this.lines[row - 1] || '');
      const start = row === r1 ? c1 - 1 : 0, end = row === r2 ? c2 : this.cols;
      const segment = chars.slice(start, end);
      lines.push(segment.join('') + ' '.repeat(Math.max(0, end - start - segment.length)));
    }
    return lines.join('\r\n');
  }
}

class AutomationService {
  constructor({ getConnectionInfo, input, emit = () => {}, logDirectory,
    pythonExecutable, bridgePath = path.resolve(__dirname, '../../assets/automation/python_bridge.py'), readScreen } = {}) {
    check(typeof getConnectionInfo === 'function' && typeof input === 'function' && typeof emit === 'function');
    check(readScreen === undefined || typeof readScreen === 'function');
    check(logDirectory === undefined || (typeof logDirectory === 'string' && path.isAbsolute(logDirectory)));
    this.getConnectionInfo = getConnectionInfo; this.input = input; this.emit = emit;
    this.logDirectory = logDirectory; this.pythonExecutable = pythonExecutable; this.bridgePath = bridgePath;
    this.readScreen = readScreen;
    this.regex = new AutomationRegex();
    this.jobs = new Map(); this.connections = new Map(); this.cleanups = new Set(); this.runs = new Set(); this.closed = false;
  }
  _info(id) {
    try {
      const info = this.getConnectionInfo(id);
      check(info?.status === 'connected' && (info.id === undefined || info.id === id), 'ERR_AUTOMATION_DISCONNECTED');
      return info;
    } catch { throw fault('ERR_AUTOMATION_DISCONNECTED'); }
  }
  _assert(job) {
    check(job.status === 'running', job.code || 'ERR_AUTOMATION_CANCELLED');
    const info = this._info(job.connectionId);
    check(info.sessionId === job.sessionId, 'ERR_AUTOMATION_DISCONNECTED');
  }
  _event(job, extra = {}) {
    const event = { type: 'automation', jobId: job.id, connectionId: job.connectionId,
      status: job.status, step: job.step, receivedBytes: job.receivedBytes, sentBytes: job.sentBytes, ...extra };
    try { this.emit(event); } catch { /* observers cannot break cleanup or a terminal input */ }
  }
  _path(outputFile) {
    if (outputFile === undefined) return undefined;
    boundedText(outputFile, 32768, false); check(!outputFile.includes('\0'));
    check(path.isAbsolute(outputFile) || this.logDirectory);
    return path.resolve(this.logDirectory || '.', outputFile);
  }
  _create(connectionId, outputFile, mode) {
    check(!this.closed && this.jobs.size < LIMITS.jobs);
    boundedText(connectionId, 256, false); check(!this.connections.has(connectionId));
    const info = this._info(connectionId), target = this._path(outputFile);
    const job = { id: randomUUID(), connectionId, sessionId: info.sessionId, mode,
      status: 'running', step: 0, transcript: '', cursor: 0, receivedBytes: 0, sentBytes: 0,
      tokens: new Map(), tokenBytes: 0, outputFile: target, screen: new RollingScreen(info.rows, info.cols),
      abort: new AbortController(), requests: 0, stderrBytes: 0 };
    job.deadline = setTimeout(() => this._finish(job, 'error', 'ERR_AUTOMATION_TIMEOUT'), LIMITS.runtimeMs);
    this.jobs.set(job.id, job); this.connections.set(connectionId, job);
    return job;
  }
  start({ connectionId, steps, name, outputFile } = {}) {
    if (name !== undefined) boundedText(name, 256);
    const compiled = compileSteps(steps);
    const job = this._create(connectionId, outputFile, 'flow');
    this._launch(job, async () => { await this._steps(job, compiled); await this._complete(job); });
    return job.id;
  }
  startPython({ connectionId, scriptPath, outputFile } = {}) {
    for (const file of [this.pythonExecutable, this.bridgePath, scriptPath]) {
      boundedText(file, 32768, false); check(path.isAbsolute(file) && !file.includes('\0'));
      try { check(fs.statSync(file).isFile()); } catch { throw fault('ERR_AUTOMATION_VALIDATION'); }
    }
    const job = this._create(connectionId, outputFile, 'python');
    this._launch(job, () => this._python(job, scriptPath));
    return job.id;
  }
  async _execute(job, run) {
    try { this._assert(job); this._event(job, { operation: job.mode }); this._assert(job); await run(); }
    catch (error) { this._finish(job, 'error', CODES.has(error?.code) ? error.code : 'ERR_AUTOMATION_INPUT'); }
  }
  _launch(job, run) {
    const execution = Promise.resolve().then(() => this._execute(job, run)).finally(() => this.runs.delete(execution));
    this.runs.add(execution);
  }
  listJobs() {
    return [...this.jobs.values()].map(job => ({ jobId: job.id, connectionId: job.connectionId,
      status: job.status, mode: job.mode, step: job.step, receivedBytes: job.receivedBytes, sentBytes: job.sentBytes }));
  }
  onData({ id, data, encoding = 'utf-8' } = {}) {
    const job = this.connections.get(id);
    if (!job || job.status !== 'running' || job.collecting === false) return;
    try {
      this._assert(job);
      let text;
      if (typeof data === 'string') {
        check(!job.decoder, 'ERR_AUTOMATION_PROTOCOL'); text = data;
      } else {
        check(Buffer.isBuffer(data) || data instanceof Uint8Array);
        const normalized = normalizeTerminalEncoding(encoding);
        if (!job.decoder) { job.encoding = normalized; job.decoder = createTerminalDecoder(normalized); }
        check(job.encoding === normalized, 'ERR_AUTOMATION_PROTOCOL');
        check(data.byteLength <= LIMITS.transcript, 'ERR_AUTOMATION_LIMIT');
        text = job.decoder.write(Buffer.from(data));
      }
      const bytes = Buffer.byteLength(text);
      check(job.receivedBytes + bytes <= LIMITS.transcript, 'ERR_AUTOMATION_LIMIT');
      job.receivedBytes += bytes; job.transcript += text; job.screen.write(text); this._poll(job);
    } catch (error) { this._finish(job, 'error', CODES.has(error?.code) ? error.code : 'ERR_AUTOMATION_PROTOCOL'); }
  }
  onStatus(event = {}) {
    const job = this.connections.get(event.id);
    if (job && event.status && event.status !== 'connected') this._finish(job, 'error', 'ERR_AUTOMATION_DISCONNECTED');
  }
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return false;
    this._finish(job, 'cancelled', 'ERR_AUTOMATION_CANCELLED'); return true;
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) this.cancel(job.id);
    const workers = this.regex.close();
    while (this.runs.size || this.cleanups.size) await Promise.allSettled([...this.runs, ...this.cleanups]);
    await workers;
  }
  _retire(job) {
    this.jobs.delete(job.id);
    if (this.connections.get(job.connectionId) === job) this.connections.delete(job.connectionId);
    job.transcript = ''; job.tokens.clear(); job.decoder = null; job.screen = null;
  }
  _finish(job, status, code, extra = {}) {
    if (job.status !== 'running') return;
    job.status = status; job.code = code; clearTimeout(job.deadline);
    if (job.waiter) job.waiter.reject(fault(code || 'ERR_AUTOMATION_CANCELLED'));
    job.abort.abort();
    if (job.child) {
      const cleanup = this._killTree(job).finally(() => { this._retire(job); this.cleanups.delete(cleanup); });
      this.cleanups.add(cleanup);
    } else this._retire(job);
    this._event(job, { ...(code ? { code } : {}), ...extra });
  }
  _arm(job, patterns, timeoutMs, softTimeout = false) {
    this._assert(job); check(!job.waiter, 'ERR_AUTOMATION_PROTOCOL');
    const promise = new Promise((resolve, reject) => {
      const waiter = { patterns, regex: patterns.some(item => item.regex), abort: new AbortController(),
        expires: performance.now() + timeoutMs, ends: [], lastEnd: -1, matching: false, settled: false };
      const settle = (error, value) => {
        if (waiter.settled) return;
        waiter.settled = true; clearTimeout(waiter.timer); waiter.ends.length = 0;
        if (job.waiter === waiter) job.waiter = null;
        waiter.abort.abort();
        if (error) reject(error); else resolve(value);
      };
      waiter.resolve = value => settle(null, value);
      waiter.reject = error => settle(error);
      waiter.fail = error => {
        if (waiter.settled) return;
        waiter.reject(error);
        if (!softTimeout) this._finish(job, 'error', CODES.has(error?.code) ? error.code : 'ERR_AUTOMATION_INPUT');
      };
      waiter.timer = setTimeout(() => waiter.fail(fault('ERR_AUTOMATION_TIMEOUT')), timeoutMs);
      job.waiter = waiter; this._poll(job);
    });
    // A synchronous input error or immediate cancellation can precede awaiting it.
    promise.catch(() => {}); return promise;
  }
  _poll(job) {
    const waiter = job.waiter; if (!waiter) return;
    try {
      if (waiter.regex) {
        const end = job.transcript.length;
        if (waiter.lastEnd !== end) {
          check(waiter.ends.length < REGEX_LIMITS.snapshots, 'ERR_AUTOMATION_LIMIT');
          waiter.ends.push(end); waiter.lastEnd = end;
        }
        if (waiter.matching || !waiter.ends.length) return;
        const cursor = job.cursor, ends = waiter.ends;
        const unread = job.transcript.slice(cursor, ends.at(-1));
        waiter.ends = []; waiter.matching = true;
        void this.regex.match(waiter.patterns, unread, {
          signal: waiter.abort.signal, ends: ends.map(value => value - cursor)
        }).then(selected => {
          // Old completions cannot consume data, replace a new waiter, or send.
          if (job.waiter !== waiter || waiter.settled) return;
          this._assert(job);
          if (performance.now() >= waiter.expires) { waiter.fail(fault('ERR_AUTOMATION_TIMEOUT')); return; }
          waiter.matching = false;
          if (selected) this._matched(job, waiter, selected, unread, cursor);
          else this._poll(job);
        }).catch(error => { if (job.waiter === waiter) waiter.fail(error); });
        return;
      }
      const unread = job.transcript.slice(job.cursor); let selected;
      waiter.patterns.forEach((item, caseIndex) => {
        const match = findLiteral(item, unread);
        if (match && (!selected || match.index < selected.index)) selected = { ...match, caseIndex };
      });
      if (selected) this._matched(job, waiter, selected, unread, job.cursor);
    } catch (error) { waiter.fail(error); }
  }
  _matched(job, waiter, selected, unread, cursor) {
    selected.before = unread.slice(0, selected.index);
    job.cursor = cursor + selected.index + selected.text.length; waiter.resolve(selected);
  }
  _remember(job, name, value) {
    const total = job.tokenBytes - Buffer.byteLength(job.tokens.get(name) || '') + Buffer.byteLength(value);
    check(total <= LIMITS.tokens, 'ERR_AUTOMATION_LIMIT');
    job.tokens.set(name, value); job.tokenBytes = total;
  }
  _expand(job, text) {
    const parts = []; let cursor = 0, bytes = 0;
    const append = part => {
      bytes += Buffer.byteLength(part); check(bytes <= LIMITS.input, 'ERR_AUTOMATION_LIMIT'); parts.push(part);
    };
    for (const match of text.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g)) {
      append(text.slice(cursor, match.index));
      check(job.tokens.has(match[1]), 'ERR_AUTOMATION_TOKEN'); append(job.tokens.get(match[1]));
      cursor = match.index + match[0].length;
    }
    append(text.slice(cursor)); return parts.join('');
  }
  _pending(job, operation, timeoutMs) {
    const pending = Promise.resolve(operation);
    pending.catch(() => {});
    this._assert(job);
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); job.abort.signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(fault(job.code || 'ERR_AUTOMATION_CANCELLED')); };
      job.abort.signal.addEventListener('abort', abort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => {
        cleanup(); reject(fault('ERR_AUTOMATION_TIMEOUT'));
      }, timeoutMs);
      pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  async _send(job, text, line = false, expand = true) {
    this._assert(job);
    text = (expand ? this._expand(job, text) : text) + (line ? '\r' : '');
    const bytes = Buffer.byteLength(text);
    check(bytes <= LIMITS.input && job.sentBytes + bytes <= LIMITS.sent, 'ERR_AUTOMATION_LIMIT');
    job.sentBytes += bytes;
    try { await this._pending(job, this.input(job.connectionId, text)); }
    catch (error) { throw fault(job.code || 'ERR_AUTOMATION_INPUT'); }
    this._assert(job);
  }
  _sleep(job, ms) {
    this._assert(job);
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); job.abort.signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); reject(fault(job.code || 'ERR_AUTOMATION_CANCELLED')); };
      const timer = setTimeout(done, ms); job.abort.signal.addEventListener('abort', abort, { once: true });
    });
  }
  _patterns(step) { return step.type === 'respond' ? step.cases.map(item => item.pattern) : [step.pattern]; }
  async _steps(job, steps) {
    let prepared;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]; this._assert(job); job.step++;
      this._event(job, { operation: step.type }); this._assert(job);
      switch (step.type) {
        case 'send': case 'sendLine': {
          let wait;
          if (step.waitFor) wait = this._arm(job, [step.waitFor], step.timeoutMs);
          else if (['waitFor', 'capture', 'expectSend', 'respond'].includes(steps[index + 1]?.type)) {
            const next = steps[index + 1]; prepared = this._arm(job, this._patterns(next), next.timeoutMs);
          }
          await this._send(job, step.text, step.type === 'sendLine'); if (wait) await wait; break;
        }
        case 'waitFor': case 'capture': case 'expectSend': case 'respond': {
          const match = await (prepared || this._arm(job, this._patterns(step), step.timeoutMs)); prepared = undefined;
          this._assert(job);
          this._remember(job, step.token, step.type === 'capture' ? match.before + (step.includeMatch ? match.text : '') : match.value);
          const reply = step.type === 'respond' ? step.cases[match.caseIndex] : step.type === 'expectSend' ? step : null;
          if (reply) {
            const wait = reply.waitFor ? this._arm(job, [reply.waitFor], step.timeoutMs) : null;
            if (!wait && ['waitFor', 'capture', 'expectSend', 'respond'].includes(steps[index + 1]?.type)) {
              const next = steps[index + 1]; prepared = this._arm(job, this._patterns(next), next.timeoutMs);
            }
            await this._send(job, reply.text, reply.sendLine); if (wait) await wait;
          }
          break;
        }
        case 'sleep': await this._sleep(job, step.durationMs); break;
        case 'if': {
          check(job.tokens.has(step.token), 'ERR_AUTOMATION_TOKEN');
          const value = job.tokens.get(step.token);
          const matched = step.pattern.regex ? await this.regex.match([step.pattern], value, { signal: job.abort.signal }) :
            findLiteral(step.pattern, value);
          this._assert(job);
          await this._steps(job, matched ? step.then : step.else); break;
        }
      }
    }
  }
  async _complete(job) {
    this._assert(job);
    job.collecting = false;
    if (!job.outputFile) { this._finish(job, 'completed', undefined, { saved: false }); return; }
    const temp = path.join(path.dirname(job.outputFile), `.sessiondock-automation-${job.id}.part`);
    let handle, ownsTemp = false;
    try {
      handle = await fs.promises.open(temp, 'wx', 0o600);
      ownsTemp = true;
      this._assert(job); await handle.writeFile(job.transcript, 'utf8'); await handle.sync();
      await handle.close(); handle = undefined; this._assert(job);
      // No asynchronous boundary between the cancellation check, atomic commit,
      // and completed state. A failed rename never deletes the original.
      fs.renameSync(temp, job.outputFile);
      this._finish(job, 'completed', undefined, { saved: true });
    } catch (error) {
      if (job.status === 'running') this._finish(job, 'error',
        error?.code === 'ERR_AUTOMATION_DISCONNECTED' ? error.code : 'ERR_AUTOMATION_OUTPUT');
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (ownsTemp) await fs.promises.unlink(temp).catch(() => {});
    }
  }
  _python(job, scriptPath) {
    this._assert(job);
    const child = spawn(this.pythonExecutable, ['-I', '-S', '-u', this.bridgePath, scriptPath], {
      shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(scriptPath)
    });
    job.child = child; job.rpcBuffer = Buffer.alloc(0); job.rpcBusy = false;
    job.childClosed = new Promise(resolve => child.once('close', resolve));
    child.on('error', () => this._finish(job, 'error', 'ERR_AUTOMATION_PYTHON'));
    child.stdin.on('error', () => { if (job.status === 'running') this._finish(job, 'error', 'ERR_AUTOMATION_PROTOCOL'); });
    child.stdout.on('data', chunk => {
      if (job.status !== 'running') return;
      try {
        check(job.rpcBuffer.length + chunk.length <= LIMITS.rpc, 'ERR_AUTOMATION_LIMIT');
        job.rpcBuffer = Buffer.concat([job.rpcBuffer, chunk]);
        let end;
        while ((end = job.rpcBuffer.indexOf(10)) !== -1) {
          const line = job.rpcBuffer.subarray(0, end); job.rpcBuffer = job.rpcBuffer.subarray(end + 1);
          check(!job.rpcBusy, 'ERR_AUTOMATION_PROTOCOL'); job.rpcBusy = true;
          let request; try { request = JSON.parse(line.toString('utf8')); } catch { throw fault('ERR_AUTOMATION_PROTOCOL'); }
          void this._rpc(job, request);
        }
      } catch (error) { this._finish(job, 'error', CODES.has(error?.code) ? error.code : 'ERR_AUTOMATION_PROTOCOL'); }
    });
    child.stderr.on('data', chunk => {
      // Drain everything, retain nothing, emit once. User print/tracebacks may
      // contain credentials; even fragments are never forwarded to observers.
      job.stderrBytes = Math.min(LIMITS.stderr, job.stderrBytes + chunk.length);
      if (!job.stderrReported && job.status === 'running') {
        job.stderrReported = true; this._event(job, { channel: 'stderr', bytes: job.stderrBytes });
      }
    });
    child.on('close', () => { if (job.status === 'running') this._finish(job, 'error', 'ERR_AUTOMATION_PYTHON'); });
  }
  async _rpc(job, request) {
    try {
      this._assert(job);
      check(request && request.id === ++job.requests && job.requests <= LIMITS.requests &&
        typeof request.method === 'string', 'ERR_AUTOMATION_PROTOCOL');
      const args = request.args; check(Array.isArray(args), 'ERR_AUTOMATION_PROTOCOL');
      job.step++; this._event(job, { operation: 'python' }); this._assert(job);
      let result = null;
      switch (request.method) {
        case 'send':
          boundedText(args[0], LIMITS.input); await this._send(job, args[0], false, false); break;
        case 'wait': case 'read': {
          check(Array.isArray(args[0]) && args[0].length > 0 && args[0].length <= 32);
          const patterns = args[0].map(value => pattern({ literal: boundedText(value, LIMITS.pattern, false) }));
          const timeout = duration(args[1]);
          try {
            const found = await this._arm(job, patterns, timeout, true);
            result = request.method === 'wait' ? found.caseIndex + 1 : { text: found.before, matchIndex: found.caseIndex + 1 };
          } catch (error) {
            if (error.code !== 'ERR_AUTOMATION_TIMEOUT') throw error;
            if (request.method === 'wait') result = 0;
            else { result = { text: job.transcript.slice(job.cursor), matchIndex: 0 }; job.cursor = job.transcript.length; }
          }
          break;
        }
        case 'get': {
          const [row1, col1, row2, col2] = args;
          check(args.length === 4 && args.every(value => Number.isInteger(value) && value >= 1 && value <= 4096) &&
            row2 >= row1 && (row1 !== row2 || col2 >= col1));
          if (this.readScreen) {
            result = await this._pending(job,
              this.readScreen(job.connectionId, { row1, col1, row2, col2 }, { signal: job.abort.signal }), LIMITS.screenTimeoutMs);
            this._assert(job); boundedText(result, LIMITS.rpc);
          } else result = job.screen.get(...args);
          break;
        }
        case 'connected': result = true; break;
        case 'sleep': await this._sleep(job, duration(args[0], 0)); break;
        case 'disconnect':
          // This reserved callback form must be routed explicitly by the caller.
          // Never send the word 'disconnect' or an empty command to the remote host.
          await this._pending(job, this.input(job.connectionId, null, { disconnect: true }));
          this._finish(job, 'error', 'ERR_AUTOMATION_DISCONNECTED'); return;
        case 'failed': this._finish(job, 'error', 'ERR_AUTOMATION_PYTHON'); return;
        case 'done': {
          const saving = this._complete(job).finally(() => this.runs.delete(saving));
          this.runs.add(saving); await saving; return;
        }
        default: throw fault('ERR_AUTOMATION_PROTOCOL');
      }
      this._assert(job);
      const response = Buffer.from(JSON.stringify({ id: request.id, result }) + '\n');
      check(response.length <= LIMITS.rpc && job.child.stdin.writableLength + response.length <= LIMITS.rpc, 'ERR_AUTOMATION_LIMIT');
      job.rpcBusy = false; job.child.stdin.write(response);
    } catch (error) { this._finish(job, 'error', CODES.has(error?.code) ? error.code : 'ERR_AUTOMATION_PROTOCOL'); }
  }
  async _killTree(job) {
    const child = job.child;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise(resolve => {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 5000);
          const done = code => { clearTimeout(timer); if (code) child.kill(); resolve(); };
          killer.once('error', () => { child.kill(); done(); }); killer.once('close', done);
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
      }
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await job.childClosed;
  }
}

module.exports = { AutomationService, LIMITS };
