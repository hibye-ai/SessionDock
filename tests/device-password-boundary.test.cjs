'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SshService } = require('../src/lib/ssh-service.cjs');
const { normalizePlan } = require('../src/lib/batch-plan.cjs');
const renderer = file => fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');
const stale = 'synthetic-stale-device-secret';
const fresh = 'synthetic-fresh-login';

test('SSH does not use a password carried by any lookup profile, including jump targets', async () => {
  const questions = [];
  const service = new SshService({ lookupSession: () => null, knownHosts: new Map(), emit: () => {}, ask: p => { questions.push(p); return { password: fresh }; } });
  const connection = { id: 'synthetic-attempt', closed: false, pending: new Set() };
  service.connections.set(connection.id, connection);
  const session = { name: 'jump', host: '127.0.0.1', port: 12345, username: 'user', authType: 'password', password: stale };
  const result = await service._authentication(connection, session);
  assert.equal(result.password === fresh, true);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].connectionId, connection.id);
  assert.equal(questions[0].session.port, session.port);
});

test('batch planning neither retains nor requires group-wide device credentials (direct or bound)', () => {
  const group = { name: 'synthetic', targets: '127.0.0.1\n127.0.0.2', username: 'user', password: stale, enablePassword: stale, useEnable: true, commands: 'show status' };
  const direct = normalizePlan({ groups: [group] });
  assert.equal(JSON.stringify(direct).includes(stale), false);
  const bound = normalizePlan({ groups: [{ ...group, password: '', credentialId: 'synthetic-account' }] }, () => ({ username: 'bound-user', authType: 'password', password: stale }));
  assert.equal(JSON.stringify(bound).includes(stale), false);
  assert.equal(bound.groups[0].profile.username, 'bound-user');
  assert.equal(normalizePlan({ groups: [{ ...group, protocol: 'telnet', password: '' }] }).devices.length, 2);
});

test('saved/quick, common and batch configuration do not offer device password input or saving', () => {
  assert.doesNotMatch(renderer('index.html'), /name="(?:password|rememberPassword)"/);
  assert.match(renderer('index.html'), /name="rememberPassphrase"/);
  assert.doesNotMatch(renderer('operations-ui.js'), /hasPassword|clearPasswordField\b/);
  assert.doesNotMatch(renderer('batch-ui.js'), /name="(?:password|enablePassword)"/);
});
