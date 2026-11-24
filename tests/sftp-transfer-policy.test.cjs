'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SshService } = require('../src/lib/ssh-service.cjs');

async function fixture(t, configure) {
  const events = [], calls = [];
  const sftp = Object.assign(new EventEmitter(), {
    open(_name, _mode, _permissions, done) { done(null, Buffer.from('handle')); },
    createWriteStream() { return new Writable({ write(_chunk, _encoding, done) { done(); } }); },
    rename(_staged, _target, done) { calls.push('standard'); done(); },
    ext_openssh_rename(_staged, _target, done) { calls.push('posix'); done(); },
    unlink(_path, done) { calls.push('cleanup'); done(); },
    readdir(_path, done) { done(null, []); },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  const client = { sftp(done) { done(null, sftp); } };
  configure?.(sftp, client, calls);
  const service = new SshService({
    lookupSession: () => null, emit: event => events.push(event), ask: async () => null,
    knownHosts: { get() {}, set() {} },
  });
  service.sftpOperationTimeoutMs = 120;
  service._start = async connection => {
    connection.status = 'connected';
    connection.client = client;
  };
  const dia = await fs.mkdtemp(path.join(os.tmpdir(), 'sessiondock-sftp-policy-'));
  t.after(() => fs.rm(dia, { recursive: true, force: true }));
  t.after(() => service.close());
  const local = path.join(dia, 'selected.txt');
  await fs.writeFile(local, 'sample');
  const { id } = service.connect('test');
  await nextTurn();
  return { service, id, events, calls, sftp, local };
}

test('successful uploads use explicit overwrite intent at the transport boundary', async t => {
  const { service, id, local, calls } = await fixture(t);
  await service.upload(id, local, '/first.txt');
  await service.upload(id, local, '/second.txt', { overwrite: true });
  assert.deepEqual(calls, ['standard', 'posix']);
});

test('a timed-out directory request releases local listeners and later reads work', async t => {
  const { service, id, sftp } = await fixture(t, sftp => {
    const original = sftp.readdir;
    sftp.readdir = function (value, done) {
      this.readdir = original;
    };
  });
  await assert.rejects(service.listDirectory(id, '/'), { code: 'SFTP_TIMEOUT' });
  assert.equal(sftp.listenerCount('end'), 1);
  assert.deepEqual(await service.listDirectory(id, '/'), { path: '/', entries: [] });
});

test('late subsystem open cannot replace a newly opened channel', async t => {
  let lateOpen;
  const { service, id, sftp } = await fixture(t, (_, client) => {
    const original = client.sftp;
    client.sftp = function (done) { lateOpen = done; this.sftp = original; };
  });
  await assert.rejects(service.listDirectory(id, '/'), { code: 'SFTP_TIMEOUT' });
  assert.deepEqual(await service.listDirectory(id, '/'), { path: '/', entries: [] });
  const late = Object.assign(new EventEmitter(), {
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  lateOpen(null, late);
  assert.equal(late.destroyed, true);
  assert.equal(sftp.destroyed, undefined);
  assert.deepEqual(await service.listDirectory(id, '/'), { path: '/', entries: [] });
});

test('missing commit acknowledgement reports an unknown outcome without retrying', async t => {
  let acknowledge;
  const { service, id, local, calls, events } = await fixture(t, (sftp, _, calls) => {
    sftp.ext_openssh_rename = (_, _target, done) => { calls.push('posix'); acknowledge = done; };
  });
  await assert.rejects(service.upload(id, local, '/file', { overwrite: true }), { code: 'TRANSFER_COMMIT_UNKNOWN' });
  acknowledge(Object.assign(new Error('unsupported'), { code: 8 }));
  assert.deepEqual(calls, ['posix']);
  assert.deepEqual(events.filter(event => event.code === 'TRANSFER_COMMIT_UNKNOWN').map(event => event.status), ['error']);
});

test('disconnect during commit does not report a cancelled transfer', async t => {
  let started;
  const enteredCommit = new Promise(resolve => { started = resolve; });
  const { service, id, local, events } = await fixture(t, sftp => {
    sftp.rename = () => { started(); };
  });
  const upload = service.upload(id, local, '/file');
  const check = assert.rejects(upload, { code: 'TRANSFER_COMMIT_UNKNOWN' });
  await enteredCommit;
  await service.disconnect(id);
  await check;
  assert.deepEqual(events.filter(event => event.type === 'transfer' && ['completed', 'cancelled', 'error'].includes(event.status))
    .map(({ status, code }) => ({ status, code })), [{ status: 'error', code: 'TRANSFER_COMMIT_UNKNOWN' }]);
});
