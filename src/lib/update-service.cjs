'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { createHttpsUpdateSource } = require('./update-https.cjs');

// null selects official HTTPS; an empty string is an explicit local source without a folder.
function updateLocation(settings) { return settings.updateFromLocalFolder === true ? settings.updateDirectory ?? '' : null; }

function parseVersion(value) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error('업데이트 버전이 올바르지 않습니다.');
  return match.slice(1).map(BigInt);
}
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function runWorker(python, helper, command, input, timeoutMs = 30000, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('업데이트 작업이 취소되었습니다.'));
    const child = spawn(python, ['-I', '-S', helper, command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', settled = false, stoppedError = null, finalValue, finalSeen = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const stop = error => { if (!stoppedError) stoppedError = error; child.kill(); };
    const timer = setTimeout(() => stop(new Error('업데이트 작업 시간이 초과되었습니다.')), timeoutMs);
    const abort = () => stop(new Error('업데이트 작업이 취소되었습니다.'));
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => { if (!child.pid) finish(error); else if (!stoppedError) stoppedError = error; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const consume = line => {
      let value;
      try { value = JSON.parse(line); } catch { return stop(new Error('업데이트 응답을 읽지 못했습니다.')); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || finalSeen) return stop(new Error('업데이트 응답을 읽지 못했습니다.'));
      if (value.type === 'stage-progress') {
        if (typeof value.phase !== 'string' || !['copy','verify','extract'].includes(value.phase) || !['bytes','files'].includes(value.unit) || !Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total) || value.completed < 0 || value.total < 0 || value.completed > value.total) return stop(new Error('업데이트 응답을 읽지 못했습니다.'));
        try { onProgress?.(value); } catch {}
      } else if (typeof value.ok === 'boolean') { finalSeen = true; finalValue = value; }
      else stop(new Error('업데이트 응답을 읽지 못했습니다.'));
    };
    child.stdout.on('data', part => {
      if (stoppedError) return;
      output += part;
      let index;
      while ((index = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, index); output = output.slice(index + 1);
        if (line.length > 4 * 1024 * 1024) return stop(new Error('업데이트 응답이 너무 큽니다.'));
        consume(line); if (stoppedError) return;
      }
      if (output.length > 4 * 1024 * 1024) stop(new Error('업데이트 응답이 너무 큽니다.'));
    });
    child.stderr.on('data', part => { if (errors.length < 4096) errors += part.slice(0, 4096 - errors.length); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (settled) return;
      if (stoppedError) return finish(stoppedError);
      if (output.length) consume(output);
      if (stoppedError) return finish(stoppedError);
      if (!finalSeen) return finish(new Error('업데이트 응답을 읽지 못했습니다.'));
      if (code !== 0 || finalValue.ok !== true) return finish(new Error(finalValue.error || '업데이트 작업에 실패했습니다.'));
      finish(null, finalValue.result);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

class UpdateService {
  constructor({ pythonExecutable, helperPath, currentVersion, installDir, userDataDir, onNotice = () => {}, worker = runWorker, timeoutMs = 30000, httpsOptions }) {
    parseVersion(currentVersion);
    Object.assign(this, { pythonExecutable, helperPath, currentVersion, installDir, userDataDir, onNotice, worker, timeoutMs });
    this.internet = createHttpsUpdateSource(httpsOptions);
    this.generation = 0; this.folder = null; this.candidate = null; this.prepared = null; this.busy = false;
    this.preparedRoot = null; this.ownedRoots = new Set(); this.heldRoots = new Set(); this.discardRoots = new Set(); this.cleanups = new Set();
    this.operations = new Set(); this.closing = false; this.handoffRoot = null;
  }
  track(operation) {
    this.operations.add(operation);
    operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  ensureOpen() { if (this.closing) throw new Error('앱 종료 중에는 업데이트할 수 없습니다.'); }
  close() {
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    if (!this.handoffRoot) { this.generation++; this.candidate = null; this.controller?.abort(); }
    this.startingChild?.kill();
    const cancel = this.cancelPending?.();
    this.closeOperation = (async () => {
      await Promise.allSettled([...this.operations, ...(cancel ? [cancel] : [])]);
      if (this.cancelPending && !this.handoffRoot) await this.cancelPending();
      for (const root of [...this.ownedRoots]) if (root !== this.handoffRoot) this.discardRoot(root);
      if (!this.handoffRoot) { this.prepared = null; this.preparedRoot = null; }
      await this.waitForCleanup();
    })();
    return this.closeOperation;
  }
  discardPrepared() {
    const root = this.preparedRoot;
    this.prepared = null; this.preparedRoot = null;
    if (root) this.discardRoot(root);
  }
  discardRoot(root) {
    if (!this.ownedRoots.has(root)) return;
    this.discardRoots.add(root);
    if (this.heldRoots.has(root)) return;
    this.discardRoots.delete(root); this.ownedRoots.delete(root);
    const cleanup = fs.rm(root, {recursive:true,force:true,maxRetries:3}).catch(() => {});
    this.cleanups.add(cleanup); cleanup.finally(() => this.cleanups.delete(cleanup));
  }
  releaseRoot(root) { this.heldRoots.delete(root); if (this.discardRoots.has(root)) this.discardRoot(root); }
  async waitForCleanup() { await Promise.all([...this.cleanups]); }
  setFolder(folder) {
    this.ensureOpen();
    if (folder !== null && (typeof folder !== 'string' || (folder && !path.isAbsolute(folder)))) throw new Error('업데이트 폴더는 절대 경로로 지정해 주세요.');
    if (folder !== this.folder) { this.folder = folder; this.invalidate(); }
  }
  invalidate() { if (this.closing) return; this.generation++; this.candidate = null; this.discardPrepared(); this.controller?.abort(); this.cancelPending?.(); }
  status() { return { folder: this.folder, candidate: this.candidate, generation: this.generation, prepared: !!this.prepared, busy: this.busy || !!this.installPending || !!this.confirming }; }
  async checkPending(signal, localTempDir) {
    const result = await this.worker(this.pythonExecutable, this.helperPath, 'pending', {installDir:this.installDir, localTempDir}, this.timeoutMs, signal);
    if (result?.pending !== false) throw new Error('업데이트 상태를 확인할 수 없습니다.');
  }
  check(folder = this.folder) { return this.track(this.checkWork(folder)); }
  async checkWork(folder) {
    this.ensureOpen();
    if (this.busy || this.installPending || this.confirming) throw new Error('업데이트 작업이 진행 중입니다.');
    this.setFolder(folder);
    if (folder === '') throw new Error('업데이트 폴더를 선택해 주세요.');
    this.busy = true; const generation = ++this.generation; this.candidate = null; this.discardPrepared(); this.controller = new AbortController();
    try {
      const { signal } = this.controller;
      let result;
      if (folder === null) {
        await this.checkPending(signal);
        const latest = await this.internet.latest(signal);
        result = {folder, candidate: compareVersions(latest.version, this.currentVersion) > 0 ? latest : null};
      } else {
        result = await this.worker(this.pythonExecutable, this.helperPath, 'scan', { folder, currentVersion: this.currentVersion, installDir: this.installDir }, this.timeoutMs, signal);
      }
      if (generation !== this.generation) throw new Error('업데이트 설정이 변경되었습니다.');
      if (result.candidate) {
        const match = /^SessionDock-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\.zip$/.exec(result.candidate.name);
        if ((result.candidate.name !== 'SessionDock.zip' && (!match || match[1] !== result.candidate.version)) || compareVersions(result.candidate.version, this.currentVersion) <= 0) throw new Error('업데이트 응답이 올바르지 않습니다.');
      }
      this.candidate = result.candidate && Object.freeze(result.candidate); return {...result, candidate:this.candidate, generation};
    } catch (error) {
      if (generation !== this.generation) throw new Error('업데이트 설정이 변경되었습니다.');
      throw error;
    } finally { this.busy = false; this.controller = null; }
  }
  prepare(onProgress) { return this.track(this.prepareWork(onProgress)); }
  async prepareWork(onProgress) {
    this.ensureOpen();
    if (this.busy || this.installPending || this.confirming) throw new Error('업데이트 작업이 진행 중입니다.');
    if (!this.candidate) throw new Error('업데이트를 먼저 확인해 주세요.');
    this.discardPrepared();
    this.busy = true; const generation = this.generation, candidate = this.candidate, folder = this.folder; this.controller = new AbortController();
    const {signal} = this.controller;
    let root, progressActive = true;
    const progress = event => {
      if (progressActive && generation === this.generation && !this.closing && this.busy) { try { onProgress?.(event); } catch {} }
    };
    try {
      const tempDir = path.resolve(os.tmpdir());
      if (folder === null) await this.checkPending(signal, tempDir);
      root = await fs.mkdtemp(path.join(tempDir, 'sessiondock-update-'));
      this.ownedRoots.add(root);
      const ownershipToken = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(path.join(root, '.sessiondock-update-owner.json'), JSON.stringify({ token: ownershipToken }), { flag: 'wx' });
      this.ownershipToken = ownershipToken;
      const stageDir = path.join(root, 'stage');
      let sourceFolder = folder;
      if (folder === null) {
        sourceFolder = path.join(root, 'download');
        await fs.mkdir(sourceFolder);
        await this.internet.download(candidate, path.join(sourceFolder, 'SessionDock.zip'), signal, progress);
      }
      let result;
      try {
        result = await this.worker(this.pythonExecutable, this.helperPath, 'stage', { folder: sourceFolder, name: candidate.name, expectedVersion: candidate.version, expectedBuildID: candidate.buildID, stageDir, installDir: this.installDir }, 180000, signal, progress);
      } catch (error) {
        if (folder === null && ['Release ZIP identity mismatch.', 'Release ZIP copy size/SHA256 mismatch.'].includes(error.message)) {
          throw new Error('다운로드한 업데이트 파일을 검증하지 못했습니다.');
        }
        throw error;
      } finally { progressActive = false; }
      if (folder === null) await fs.rm(sourceFolder, {recursive:true,force:true,maxRetries:3});
      if (result.version !== candidate.version || result.stageDir !== stageDir) throw new Error('업데이트 준비 결과가 올바르지 않습니다.');
      if (folder === null && (result.buildID !== candidate.buildID || result.archiveSha256 !== candidate.buildID.slice(7))) throw new Error('다운로드한 업데이트 파일을 검증하지 못했습니다.');
      if (generation !== this.generation) throw new Error('업데이트 설정이 변경되었습니다.');
      this.prepared = result; this.preparedRoot = root; return { version: result.version, archiveSha256: result.archiveSha256 };
    } catch (error) {
      if (root) { this.discardRoot(root); await this.waitForCleanup(); }
      if (generation !== this.generation) throw new Error('업데이트 설정이 변경되었습니다.');
      throw error;
    }
    finally { progressActive = false; this.busy = false; this.controller = null; }
  }
  install(options = {}) { return this.track(this.installWork(options)); }
  async installWork({ profileArg = '', theme = 'dark' } = {}) {
    this.ensureOpen();
    if (this.busy || this.installPending || this.confirming) throw new Error('업데이트 작업이 진행 중입니다.');
    if (!this.prepared) throw new Error('업데이트가 준비되지 않았습니다.');
    this.busy = true;
    const generation = this.generation;
    const root = this.preparedRoot, planData = this.prepared;
    if (!root || !this.ownedRoots.has(root)) { this.busy = false; throw new Error('업데이트 준비 폴더를 확인할 수 없습니다.'); }
    this.heldRoots.add(root);
    let child, exited = Promise.resolve(), approved = false;
    try {
      const helperRoot = await fs.mkdtemp(path.join(root, 'helper-'));
      const runtime = path.join(helperRoot, 'runtime');
      await fs.cp(path.dirname(this.pythonExecutable), runtime, { recursive: true, errorOnExist: true, force: false });
      const helper = path.join(helperRoot, 'update_helper.py');
      await fs.copyFile(this.helperPath, helper);
      if (generation !== this.generation) throw new Error('업데이트 설정이 변경되었습니다.');
      const token = crypto.randomBytes(32).toString('hex');
      const approvalPath = path.join(helperRoot, 'approval.json');
      const resultPath = path.join(this.userDataDir, 'update-result.json');
      const plan = { ...planData, installDir: this.installDir, userDataDir: this.userDataDir,
        parentPid: process.pid, approvalToken: token, approvalPath, resultPath, profileArg, theme: theme === 'light' ? 'light' : 'dark',
        restartReceipt: { root, token: this.ownershipToken } };
      child = spawn(path.join(runtime, process.platform === 'win32' ? 'pythonw.exe' : path.basename(this.pythonExecutable)), ['-I', '-S', helper, 'install'],
        { windowsHide: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      this.startingChild = child;
      exited = new Promise(resolve => child.once('close', resolve));
      let alive = true;
      child.on('exit', () => { alive = false; });
      await new Promise((resolve, reject) => {
        let output = '', done = false;
        const timer = setTimeout(() => finish(new Error('설치 도우미 준비 시간이 초과되었습니다.')), 30000);
        const finish = error => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(); };
        child.once('error', finish);
        child.once('exit', () => finish(new Error('설치 도우미가 종료되었습니다.')));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', part => {
          output += part;
          if (output.length > 4096) return finish(new Error('설치 도우미 응답이 너무 큽니다.'));
          if (output.includes(String.fromCharCode(10))) {
            try { if (JSON.parse(output.split(String.fromCharCode(10))[0]).ready === true) return finish(); } catch {}
            finish(new Error('설치 도우미가 준비되지 않았습니다.'));
          }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(plan));
      });
      if (!alive || generation !== this.generation) throw new Error('설치 준비가 취소되었습니다.');
      this.installPending = true;
      this.startingChild = null;
      child.stdout.destroy(); child.unref();
      let cancellation, approval;
      const cancel = () => {
        return cancellation ||= Promise.resolve().then(async () => {
        if (approval) await approval.catch(() => {});
        if (approved) return;
        this.discardPrepared(); this.discardRoot(root);
        child.kill(); await exited; this.releaseRoot(root); await this.waitForCleanup(); this.installPending = false; this.cancelPending = null;
        });
      };
      this.cancelPending = cancel;
      child.once('close', () => { if (!approved) void cancel(); });
      return {
        assertReady: () => {
          if (!alive || generation !== this.generation || cancellation) throw new Error('설치 도우미가 종료되었거나 설정이 변경되었습니다.');
        },
        approve: () => {
          if (approval) return approval;
          approval = (async () => {
            if (this.closing || cancellation || !alive || generation !== this.generation) throw new Error('설치 도우미가 종료되었거나 설정이 변경되었습니다.');
            // Commit approval and handoff ownership without yielding to an ordinary quit.
            fsSync.writeFileSync(approvalPath, JSON.stringify({ token, graceful: true }), { flag: 'wx' });
            approved = true;
            this.handoffRoot = root;
            this.cancelPending = null;
          })();
          return approval;
        },
        cancel
      };
    } catch (error) { this.discardPrepared(); this.discardRoot(root); child?.kill(); await exited; this.releaseRoot(root); await this.waitForCleanup(); throw error; }
    finally { if (this.startingChild === child) this.startingChild = null; this.busy = false; }
  }
}
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
// Optional display metadata only; malformed data never blocks an update.
function validUpdateNotes(value) {
  if(typeof value!=='string'||value.length>400||!value.isWellFormed()||/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value))return '';
  const lines=value.split('\n');
  return lines.length<=2&&lines.every(line=>line.trim().length>0)?value:'';
}
function createUpdateNotice({ getSettings, saveSettings, getStatus, getGeneration, now = Date.now, onNotice = () => {} }) {
  let notice = null, sequence = 0;
  function current() {
    if (!notice) return null;
    const settings = getSettings(), status = getStatus();
    if (updateLocation(settings) !== notice.folder || settings.updateSnoozeUntil > now() ||
        status.folder !== notice.folder || status.candidate?.name !== notice.name ||
        status.candidate?.version !== notice.version || getGeneration() !== notice.generation) notice = null;
    return notice;
  }
  return {
    publish(candidate, folder, generation) {
      const settings = getSettings(), status = getStatus();
      if (!candidate || folder === '' || updateLocation(settings) !== folder || settings.updateSnoozeUntil > now() ||
          status.folder !== folder || status.candidate?.name !== candidate.name ||
          status.candidate?.version !== candidate.version || getGeneration() !== generation) return false;
      notice = { id: String(++sequence), name: candidate.name, version: candidate.version, folder, generation, notes:validUpdateNotes(candidate.notes) };
      try { onNotice(); } catch {}
      return true;
    },
    peek() { const item = current(); return item ? { id:item.id, version:item.version, ...(item.notes?{notes:item.notes}:{}) } : null; },
    clear() { if (notice) { notice = null; try { onNotice(); } catch {} } },
    respond({ id, snooze } = {}) {
      if (typeof id !== 'string' || typeof snooze !== 'boolean') throw new Error('업데이트 알림 응답이 올바르지 않습니다.');
      const item = current();
      if (!item || item.id !== id) return null;
      if (snooze) saveSettings({ updateSnoozeUntil: now() + SNOOZE_MS });
      notice = null;
      return { name:item.name, version:item.version, generation:item.generation };
    }
  };
}
module.exports = { UpdateService, updateLocation, parseVersion, compareVersions, runWorker, createUpdateNotice, SNOOZE_MS };
