'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const dispatch = require('../src/renderer/command-dispatch.cjs');

const renderer = readFileSync(join(__dirname, '../src/renderer/app.js'), 'utf8');
const start = renderer.indexOf('async function sendCommand(');
const end = renderer.indexOf('\nlet commandSuggestions=', start);
assert(start >= 0 && end > start);

function harness({ sensitive = false, write, confirm = () => true, extra = [] } = {}) {
  const record = (id) => ({ id, name: '장비', host: 'router.test', port: 22, status: 'connected',
    authenticationPrompt: { reset() {} }, terminal: { focus() {} } });
  const first = record('one'), second = record('two');
  const records = [first, second, ...extra.map(record)];
  const state = { connections: new Map(records.map(item => [item.id, item])), active: first.id };
  const input = { value: 'show clock' }, target = { value: sensitive ? 'active' : 'all' };
  const calls = [], dialogs = [], toasts = [];
  const sendCommand = runInNewContext(`${renderer.slice(start, end)}\nsendCommand`, {
    ...dispatch, state,
    $: (id) => id === 'command-input' ? input : target,
    commandTargets: (scope) => scope === 'active' ? [first] : records,
    commandConfirmationTargets: null,
    syncCommandPrivacy: () => sensitive, isSensitiveConnection: record => sensitive || record?.sensitive,
    updateStatus() {}, updateCommandTargetLabel() {},
    clearCommandInput() { input.value = ''; },
    api: { commandInput(id, payload) {
      assert.equal(input.value, '', 'submitted input has been cleared before IPC');
      calls.push([id, payload]);
      return write ? write(id) : { status: 'accepted' };
    } },
    async message(title, text, options) {
      dialogs.push({ title, text, options });
      return options?.confirm ? confirm(state, first, options) : true;
    },
    toast: (text) => toasts.push(text)
  });
  return { sendCommand, state, first, second, input, target, calls, dialogs, toasts };
}

test('mixed IPC results show per-tab acceptance or uncertainty and disarm repeat send', async () => {
  const h = harness({ write: (id) => id === 'one' ? { status: 'accepted' } : Promise.reject(new Error('IPC detail')) });
  await h.sendCommand();
  assert.deepEqual(h.calls, [['one', 'show clock\r'], ['two', 'show clock\r']]);
  assert.match(h.dialogs[1].text, /1번 탭 .*입력 전달 요청 접수/);
  assert.match(h.dialogs[1].text, /2번 탭 .*전달 여부 미확인/);
  assert.match(h.dialogs[1].text, /장비에서의 실행 성공을 의미하지 않습니다/);
  assert.doesNotMatch(h.dialogs[1].text, /IPC detail|show clock/);
  assert.equal(h.target.value, 'active');
  assert.equal(h.first.commandHistory[0], 'show clock');
  assert.equal(h.second.commandHistory, undefined);
  await h.sendCommand();
  assert.equal(h.calls.length, 2);
});

test('all accepted broadcast says queued, never executed', async () => {
  const h = harness();
  await h.sendCommand();
  assert.equal(h.calls.length, 2);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.toasts[0], /2개 탭 입력 전달 요청 접수/);
  assert.match(h.toasts[0], /실행 여부는 장비 화면에서 확인/);
});

test('replaced connection after confirmation receives no writes', async () => {
  const h = harness({ confirm(state, first) {
    state.connections.set(first.id, { ...first });
    return true;
  } });
  await assert.rejects(h.sendCommand(), /연결 대상이 변경/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.input.value, 'show clock');
});

test('sensitive input rejection clears the draft without revealing it or writing history', async () => {
  const h = harness({ sensitive: true, write() { throw new Error('private transport detail'); } });
  h.input.value = 'sensitive example';
  await assert.rejects(h.sendCommand(), /민감 입력의 전달 여부/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.input.value, '');
  assert.equal(h.first.commandHistory, undefined);
  assert.equal(h.dialogs.length, 0);
});

test('explicit retry reaches only originally approved retryable not-sent tabs', async () => {
  const counts = new Map(), seen = [];
  const h = harness({
    extra: ['three', 'four'],
    write(id) {
      counts.set(id, (counts.get(id) || 0) + 1);
      if (id === 'three' && counts.get(id) === 1) return { status: 'not-sent', retryable: true };
      if (id === 'four') return { status: 'not-sent', retryable: false };
      if (id === 'two') return { status: 'not-sent' }; // Incomplete replies are ambiguous.
      return { status: 'accepted' };
    },
    confirm(_state, _first, options) { seen.push(options); return true; }
  });
  await h.sendCommand();
  assert.deepEqual(h.calls.map(c => c[0]), ['one', 'two', 'three', 'four', 'three']);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].action, '미전송 탭에 재전송');
  assert.equal(seen[1].focusCancel, true);
  assert.match(h.dialogs[1].text, /재전송 대상 1개:\n3번 탭/);
  assert.match(h.dialogs[2].text, /3번 탭 .*입력 전달 요청 접수/);
  assert.equal(h.target.value, 'active');
});

test('retry rechecks the original tab and auth state after confirmation', async t => {
  for (const mutate of [
    record => ({ ...record, id: 'replacement' }),
    record => { record.sensitive = true; return record; }
  ]) await t.test('confirmation cannot authorize the changed target', async () => {
    const h = harness({
      write: id => id === 'one' ? { status: 'accepted' } : { status: 'not-sent', retryable: true },
      confirm(state, _first, options) {
        if (options.focusCancel) state.connections.set('two', mutate(state.connections.get('two')));
        return true;
      }
    });
    await assert.rejects(h.sendCommand(), /재전송하지 않았습니다/);
    assert.deepEqual(h.calls.map(c => c[0]), ['one', 'two']);
  });
});

test('declined retry and sensitive not-sent results never dispatch twice', async t => {
  const notSent = () => ({ status: 'not-sent', retryable: true });
  await t.test('declined retry', async () => {
    const h = harness({ write: notSent, confirm: (_state, _first, options) => !options.focusCancel });
    await h.sendCommand();
    assert.equal(h.calls.length, 2);
    assert.equal(h.dialogs.length, 2);
    assert.equal(h.input.value, '');
  });
  await t.test('sensitive pre-write refusal', async () => {
    const h = harness({ sensitive: true, write: notSent });
    await assert.rejects(h.sendCommand(), /민감 입력을 전송하지 않았습니다/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.first.commandHistory, undefined);
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.input.value, '');
  });
});

test('SSH and Telnet identify real queue refusal but not write-side uncertainty', () => {
  const { SshService } = require('../src/lib/ssh-service.cjs');
  const { TelnetService } = require('../src/lib/telnet-service.cjs');
  for (const Service of [SshService, TelnetService]) {
    const service = new Service({ lookupSession() {}, emit() {}, ask() {}, knownHosts: { get() {}, set() {} } });
    let writes = 0, hints = 0;
    const shell = { writableLength: 1024 * 1024, write() { writes++; return false; } };
    service.connections.set('local', { status: 'connected', shell, codec: { encode: Buffer.from } });
    const send = () => service.commandInput('local', 'show clock\r', () => hints++);
    assert.deepEqual(send(), { status: 'not-sent', retryable: true });
    assert.equal(writes, 0);
    assert.equal(hints, 0);

    shell.writableLength = 0;
    assert.deepEqual(send(), { status: 'accepted' });
    assert.equal(writes, 1);
    assert.equal(hints, 1);
    // The legacy raw method keeps its existing protocol-specific return value.
    assert.equal(service.input('local', 'show version\r'), Service === SshService ? false : undefined);

    shell.write = () => { throw new Error('write-side uncertainty'); };
    assert.throws(send);
    shell.writableEnded = true;
    assert.deepEqual(send(), { status: 'not-sent', retryable: false });
  }
});
