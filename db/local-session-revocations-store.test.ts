import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { SQLiteD1Database } from '../selfhost/database.ts';
import { BACKUP_TABLE_NAMES } from '../lib/data-backup.ts';
import { isLocalSessionRevoked, revokeLocalSession } from './local-session-revocations-store.ts';
import type { LocalSessionRevocationsDatabase } from './local-session-revocations-store.ts';

const NOW = Date.parse('2026-11-16T02:30:00Z'), EXPIRY = NOW + 30 * 86400000;
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
function fixture(t: TestContext) {
  const db = new SQLiteD1Database(':memory:');
  db.transaction(() => db.executeMigrationSQL(readFileSync(new URL('../drizzle/0035_local_session_revocations.sql', import.meta.url), 'utf8')));
  t.after(() => db.close());
  return db;
}

void test('revocation is durable by opaque family digest and expires precisely at its retention boundary', async t => {
  const db = fixture(t);
  assert.equal(await isLocalSessionRevoked(db, A, NOW), false);
  await revokeLocalSession(db, A, EXPIRY, NOW);
  assert.equal(await isLocalSessionRevoked(db, A, NOW), true);
  assert.equal(await isLocalSessionRevoked(db, A, EXPIRY - 1), true);
  assert.equal(await isLocalSessionRevoked(db, A, EXPIRY), false);
  assert.equal(await isLocalSessionRevoked(db, B, NOW), false);
  assert.deepEqual(db.sqlite.prepare('PRAGMA table_info(local_session_revocations)').all().map(row => row.name), ['family_hash', 'expires_at']);
  assert.equal(new Set<string>(BACKUP_TABLE_NAMES).has('local_session_revocations'), false);
});

void test('concurrent or repeated logout writes only extend a family lifetime and never shorten it', async t => {
  const db = fixture(t);
  await Promise.all([revokeLocalSession(db, A, EXPIRY, NOW), revokeLocalSession(db, A, EXPIRY + 1000, NOW)]);
  await revokeLocalSession(db, A, NOW + 1000, NOW);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM local_session_revocations WHERE family_hash=?').get(A)!.expires_at, EXPIRY + 1000);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM local_session_revocations').get()!.n, 1);
});

void test('expired logout input is a no-op, including for a family with a later existing revocation', async t => {
  const db = fixture(t);
  await revokeLocalSession(db, A, EXPIRY, NOW);
  const before = db.sqlite.prepare('SELECT * FROM local_session_revocations').all();
  await revokeLocalSession(db, A, NOW, NOW);
  await revokeLocalSession(db, B, NOW - 1, NOW);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM local_session_revocations').all(), before);
});

void test('cleanup removes at most 1000 expired families and preserves all active and newly revoked families', async t => {
  const db = fixture(t);
  db.transaction(() => {
    const insert = db.sqlite.prepare('INSERT INTO local_session_revocations VALUES(?,?)');
    for (let index = 0; index < 1005; index++) insert.run(index.toString(16).padStart(64, '0'), NOW - 1);
    insert.run(A, EXPIRY); insert.run(B, EXPIRY + 1);
  });
  await revokeLocalSession(db, C, EXPIRY, NOW);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM local_session_revocations WHERE expires_at<=?').get(NOW)!.n, 5);
  for (const hash of [A, B, C]) assert.equal(await isLocalSessionRevoked(db, hash, NOW), true);
});

void test('malformed digests and unsafe times fail before issuing any database statement', async () => {
  const db = { prepare() { assert.fail('Invalid input must never reach SQL'); }, batch() { assert.fail('Invalid input must never reach SQL'); } } as unknown as LocalSessionRevocationsDatabase;
  for (const hash of ['', A.toUpperCase(), A.slice(1), A + '0', 'eyJ.JWT.token', A + '\0', [A], null]) {
    await assert.rejects(isLocalSessionRevoked(db, hash as string, NOW), /Invalid session revocation/);
    await assert.rejects(revokeLocalSession(db, hash as string, EXPIRY, NOW), /Invalid session revocation/);
  }
  for (const time of [-1, NaN, Infinity, NOW + .5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(isLocalSessionRevoked(db, A, time), /Invalid session revocation/);
    await assert.rejects(revokeLocalSession(db, A, EXPIRY, time), /Invalid session revocation/);
    await assert.rejects(revokeLocalSession(db, A, time, NOW), /Invalid session revocation/);
  }
});

void test('storage failures propagate and cleanup failure rolls back the revocation atomically', async t => {
  const db = fixture(t);
  db.sqlite.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON local_session_revocations BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure'); END;");
  db.sqlite.prepare('INSERT INTO local_session_revocations VALUES(?,?)').run(A, NOW - 1);
  await assert.rejects(revokeLocalSession(db, B, EXPIRY, NOW), /synthetic cleanup failure/);
  assert.equal(await isLocalSessionRevoked(db, B, NOW), false);
  const failing = { prepare() { throw new Error('synthetic storage unavailable'); } } as unknown as LocalSessionRevocationsDatabase;
  await assert.rejects(isLocalSessionRevoked(failing, A, NOW), /synthetic storage unavailable/);
});

void test('SQLite independently rejects noncanonical digests and unsafe expiry values', async t => {
  const db = fixture(t);
  for (const hash of [A.toUpperCase(), A + '\0secret', 'x'.repeat(64), A.slice(1)]) {
    await assert.rejects(db.prepare('INSERT INTO local_session_revocations VALUES(?,?)').bind(hash, EXPIRY).run(), /CHECK constraint/);
  }
  for (const expiry of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(db.prepare('INSERT INTO local_session_revocations VALUES(?,?)').bind(A, expiry).run(), /CHECK constraint/);
  }
});
