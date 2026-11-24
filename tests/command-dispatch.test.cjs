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

function harness({ sensitive = false, write, confirm = () => true } = {}) {
  const record = (id) => ({ id, name: '장비', host: 'router.test', port: 22, status: 'connected',
    authenticationPrompt: { reset() {} }, terminal: { focus() {} } });
  const first = record('one'), second = record('two');
  const state = { connections: new Map([[first.id, first], [second.id, second]]), active: first.id };
  const input = { value: 'show clock' }, target = { value: sensitive ? 'active' : 'all' };
  const calls = [], dialogs = [], toasts = [];
  const sendCommand = runInNewContext(`${renderer.slice(start, end)}\nsendCommand`, {
    ...dispatch, state,
    $: (id) => id === 'command-input' ? input : target,
    commandTargets: (scope) => scope === 'active' ? [first] : [first, second],
    commandConfirmationTargets: null,
    syncCommandPrivacy: () => sensitive, isSensitiveConnection: () => sensitive,
    updateStatus() {}, updateCommandTargetLabel() {},
    clearCommandInput() { input.value = ''; },
    api: { input(id, payload) {
      assert.equal(input.value, '', 'submitted input has been cleared before IPC');
      calls.push([id, payload]);
      return write?.(id);
    } },
    async message(title, text, options) {
      dialogs.push({ title, text, options });
      return options?.confirm ? confirm(state, first) : true;
    },
    toast: (text) => toasts.push(text)
  });
  return { sendCommand, state, first, second, input, target, calls, dialogs, toasts };
}

test('mixed IPC results show per-tab acceptance or uncertainty and disarm repeat send', async () => {
  const h = harness({ write: (id) => id === 'one' ? false : Promise.reject(new Error('IPC detail')) });
  await h.sendCommand();
  assert.deepEqual(h.calls, [['one', 'show clock\r'], ['two', 'show clock\r']]);
  assert.match(h.dialogs[1].text, /1번 탭 .*입력 전달 요청 접수/);
  assert.match(h.dialogs[1].text, /2번 탭 .*전달 여부 미확인/);
  assert.match(h.dialogs[1].text, /장비에서의 실행 성공을 의미하지 않습니다/);
  assert.doesNotMatch(h.dialogs[1].text, /IPC detail|show clock/);
  assert.equal(h.target.value, 'active');
  assert.equal(h.first.commandHistory[0], 'show clock'); // false is backpressure, not rejection.
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
