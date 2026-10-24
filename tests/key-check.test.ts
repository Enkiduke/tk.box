import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { checkKey } from '../apps/server/src/security/key-check.js';
import { ServiceKeys } from '../apps/server/src/persistence/service-keys.js';
import { AppError } from '../apps/server/src/errors.js';

const code = (run: () => unknown) => { try { run(); return undefined; } catch (e) { return e instanceof AppError ? e.code : 'other'; } };

test('a named key path is never created, the default one is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-key-')), named = join(dir, 'typo', 'secret.key');
  assert.equal(code(() => Vault.fromFile(named, false)), 'SECRET_KEY_MISSING');
  assert.equal(existsSync(named), false);
  const fallback = join(dir, 'data', 'secret.key');
  Vault.fromFile(fallback); assert.ok(existsSync(fallback));
  // An existing named key opens normally.
  assert.equal(code(() => Vault.fromFile(fallback, false)), undefined);
});

test('the key check marks a database on first use and refuses any other key after', () => {
  const db = openDatabase(':memory:'), key = new Vault(randomBytes(32));
  checkKey(db, key); checkKey(db, key);
  assert.equal(code(() => checkKey(db, new Vault(randomBytes(32)))), 'SECRET_KEY_MISMATCH');
});

test('an install from before the marker is checked against a value it already holds', () => {
  const real = new Vault(randomBytes(32)), other = new Vault(randomBytes(32));
  const withKey = openDatabase(':memory:');
  new ServiceKeys(withKey, real).update('owner', { thesportsdb: 'abc123' });
  assert.equal(code(() => checkKey(withKey, other)), 'SECRET_KEY_MISMATCH');
  // Refused without marking, so the right key still passes afterwards.
  checkKey(withKey, real); assert.equal(code(() => checkKey(withKey, other)), 'SECRET_KEY_MISMATCH');
  const withSession = openDatabase(':memory:');
  withSession.prepare('INSERT INTO users(account_id) VALUES(?)').run('1');
  withSession.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('h', '1', real.seal('token', 'h'), Date.now() + 1000);
  assert.equal(code(() => checkKey(withSession, other)), 'SECRET_KEY_MISMATCH');
  checkKey(withSession, real);
});
