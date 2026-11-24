'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../src/lib/session-store.cjs');

const encode = value => Buffer.from(value).toString('base64');
const profile = { name: 'Synthetic device', host: '127.0.0.1', username: 'fixture' };
const pwd = 'synthetic-password-do-not-use';
const pp = 'synthetic-private-key-passphrase';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessiondock-password-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { encrypt: [], decrypt: [] };
  const open = () => new SessionStore(root, {
    encrypt(value) { calls.encrypt.push(value); return encode(value); },
    decrypt(value) { calls.decrypt.push(value); return Buffer.from(value, 'base64').toString(); },
  });
  return { open, calls };
}

test('session only encrypts and retains a distinct key passphrase, regardless of a legacy device password payload', t => {
  const { open, calls } = fixture(t);
  const store = open();
  const saved = store.saveSession({ ...profile, authType: 'key', privateKeyPath: 'fixture-key', rememberPassphrase: true, rememberPassword: true, password: pwd, passphrase: pp });
  assert.equal(calls.encrypt.length, 1, 'the device password must never be passed to encryption');
  assert.equal(calls.encrypt[0] === pp, true);
  assert.equal(Object.hasOwn(saved, 'hasPassword'), false);
  assert.equal(saved.hasPassphrase, true);
  assert.equal(open().getSessionForConnection(saved.id).passphrase === pp, true);
  store.saveSession({ id: saved.id, clearPassphrase: true });
  assert.equal(open().getSessionForConnection(saved.id).hasPassphrase, false);
});

test('opening a legacy store purges local and common device passwords without decrypting them or changing bindings', t => {
  const { open, calls } = fixture(t);
  const original = open();
  const common = original.saveCredential({ name: 'Synthetic account', username: 'common' });
  const saved = original.saveSession(profile);
  const bound = original.saveSession({ ...profile, name: 'Bound', credentialId: common.id, jumpSessionId: saved.id });
  original.saveSettings({ sharedCredentialBindings: { '67b796ce-ab80-426f-8de1-a974cf0b25a2': common.id } });
  const disk = JSON.parse(fs.readFileSync(original.filePath, 'utf8'));
  delete disk.sessions[0].rememberPassphrase;
  Object.assign(disk.sessions[0], { rememberPassword: true, passwordEncrypted: encode(pwd), passphraseEncrypted: encode(pp), authType: 'key', privateKeyPath: 'fixture-key' });
  Object.assign(disk.credentials[0], { passwordEncrypted: 'not-even-ciphertext', password: pwd });
  fs.writeFileSync(original.filePath, JSON.stringify(disk));

  const migrated = open();
  const raw = fs.readFileSync(migrated.filePath, 'utf8');
  assert.equal(/passwordEncrypted|rememberPassword/.test(raw) || raw.includes(pwd), false, 'legacy device material must be removed from the active store on open');
  assert.equal(calls.decrypt.length, 0);
  assert.equal(migrated.getSettings().sharedCredentialBindings['67b796ce-ab80-426f-8de1-a974cf0b25a2'], common.id);
  const local = migrated.getSessionForConnection(saved.id);
  assert.equal(local.password, undefined);
  assert.equal(local.passphrase === pp, true);
  assert.equal(calls.decrypt.length, 1);
  assert.equal(calls.decrypt[0] === encode(pp), true);
  assert.equal(migrated.getSessionForConnection(bound.id).password, undefined);
  assert.equal(migrated.getSessionForConnection(bound.id).jumpSessionId, saved.id);
  assert.equal(migrated.resolveSessionWithCredential(profile, common.id).password, undefined);
  assert.equal(migrated.listCredentials()[0].username, 'common');
  assert.equal(Object.hasOwn(migrated.listCredentials()[0], 'hasPassword'), false);
  open();
  assert.equal(fs.readFileSync(migrated.filePath, 'utf8') === raw, true, 'migration is idempotent');
});
