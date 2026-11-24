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

test('successful uploads use only the create-only commit operation', async t => {
  const { service, id, local, calls } = await fixture(t);
  await service.upload(id, local, '/first.txt');
  await service.upload(id, local, '/second.txt', { overwrite: true });
  assert.deepEqual(calls, ['standard', 'standard']);
});

test('a definite existing-destination rejection skips commit and cleans staging only', async t => {
  const { service, id, local, calls } = await fixture(t, (sftp, _, calls) => {
    sftp.rename = (_stage, _target, done) => { calls.push('standard'); done({ code: 11 }); };
  });
  await assert.rejects(service.upload(id, local, '/already-exists.txt'), { code: 'UPLOAD_DESTINATION_EXISTS' });
  assert.deepEqual(calls, ['standard', 'cleanup']);
});

test('a timed-out request fences the channel until real close before reopening', async t => {
  let opens = 0;
  let lateReply;
  const { service, id, sftp } = await fixture(t, (sftp, client) => {
    sftp.destroy = function () { this.destroyRequested = true; this.emit('end'); };
    sftp.readdir = function (_value, done) { lateReply = done; };
    const next = Object.assign(new EventEmitter(), {
      readdir(_value, done) { done(null, []); },
      destroy() { this.emit('close'); },
    });
    client.sftp = done => done(null, ++opens === 1 ? sftp : next);
  });
  const first = service.listDirectory(id, '/');
  await nextTurn();
  const second = service.listDirectory(id, '/');
  const timedOut = assert.rejects(first, { code: 'SFTP_TIMEOUT' });
  const cancelledPeer = assert.rejects(second, { code: 'SFTP_CLOSED' });
  await Promise.all([timedOut, cancelledPeer]);
  assert.equal(sftp.destroyRequested, true);
  const refresh = service.listDirectory(id, '/');
  await nextTurn();
  assert.equal(opens, 1);
  lateReply(null, []);
  sftp.emit('close');
  assert.deepEqual(await refresh, { path: '/', entries: [] });
  assert.equal(opens, 2);
});

test('without a close acknowledgement, the session is closed rather than reopening', async t => {
  let opens = 0;
  const { service, id, events } = await fixture(t, (sftp, client) => {
    sftp.readdir = () => {};
    sftp.destroy = () => {};
    client.sftp = done => { opens++; done(null, sftp); };
  });
  const hold = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(hold));
  await assert.rejects(service.listDirectory(id, '/'), { code: 'SFTP_TIMEOUT' });
  await assert.rejects(service.listDirectory(id, '/'), { code: 'NOT_CONNECTED' });
  assert.equal(opens, 1);
  assert.equal(events.filter(event => event.code === 'SFTP_CHANNEL_CLOSE_TIMEOUT').length, 1);
});

test('unacknowledged subsystem open closes SSH and discards a late channel', async t => {
  let lateOpen, opens = 0;
  const { service, id, sftp, events } = await fixture(t, (_, client) => {
    client.sftp = done => { lateOpen = done; opens++; };
  });
  await assert.rejects(service.listDirectory(id, '/'), { code: 'SFTP_OPEN_TIMEOUT' });
  await assert.rejects(service.listDirectory(id, '/'), { code: 'NOT_CONNECTED' });
  lateOpen(null, sftp);
  assert.equal(sftp.destroyed, true);
  assert.equal(opens, 1);
  assert.equal(events.filter(event => event.code === 'SFTP_OPEN_TIMEOUT').length, 1);
});

test('missing commit acknowledgement reports an unknown outcome without retrying or cleanup', async t => {
  let acknowledge;
  const { service, id, local, calls, events } = await fixture(t, (sftp, _, calls) => {
    sftp.rename = (_, _target, done) => { calls.push('standard'); acknowledge = done; };
  });
  await assert.rejects(service.upload(id, local, '/file'), { code: 'TRANSFER_COMMIT_UNKNOWN' });
  acknowledge();
  assert.deepEqual(calls, ['standard']);
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
