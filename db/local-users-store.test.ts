import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { SQLiteD1Database } from '../selfhost/database.ts';
import { LocalUserError, normalizeLocalEmail, publicLocalUser, validLocalPasswordHash } from '../lib/local-users.ts';
import { BACKUP_TABLE_NAMES } from '../lib/data-backup.ts';
import { bootstrapLocalOwner, createLocalUser, getLocalUserByEmail, getLocalUserById, listLocalUsers, touchLocalUserLogin, updateLocalUser } from './local-users-store.ts';

const OWNER = 'treefund-test-owner', MEMBER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-15T00:00:00.000Z', NEXT = '2026-11-16T00:00:00.000Z';
const HASH = `scrypt-v1$32768$8$1$${Buffer.alloc(16, 1).toString('base64url')}$${Buffer.alloc(64, 2).toString('base64url')}`;
const NEW_HASH = `scrypt-v1$32768$8$1$${Buffer.alloc(16, 3).toString('base64url')}$${Buffer.alloc(64, 4).toString('base64url')}`;
function fixture(t: TestContext) {
  const db = new SQLiteD1Database(':memory:');
  db.transaction(() => db.executeMigrationSQL(readFileSync(new URL('../drizzle/0034_local_users.sql', import.meta.url), 'utf8')));
  t.after(() => db.close());
  return db;
}
const seed = (db: SQLiteD1Database) => bootstrapLocalOwner(db, { id: OWNER, email: 'Admin@Treefund.Asia', passwordHash: HASH }, NOW);
const member = (db: SQLiteD1Database) => createLocalUser(db, { id: MEMBER, email: 'Member@example.com', passwordHash: HASH }, NOW);
const errorCode = (expected: string) => (error: unknown) => error instanceof LocalUserError && error.code === expected;

void test('bootstrap seeds the configured stable owner once and preserves edited credentials on restart', async t => {
  const db = fixture(t);
  const original = await seed(db);
  assert.equal(original.id, OWNER); assert.equal(original.email, 'admin@treefund.asia'); assert.equal(original.passwordHash, HASH);
  await updateLocalUser(db, OWNER, OWNER, { expectedRevision: 1, email: 'new-admin@example.com', passwordHash: NEW_HASH }, NEXT);
  const restarted = await seed(db);
  assert.equal(restarted.id, OWNER); assert.equal(restarted.email, 'new-admin@example.com'); assert.equal(restarted.passwordHash, NEW_HASH); assert.equal(restarted.revision, 2);
  assert.equal((await listLocalUsers(db, OWNER)).length, 1);
  await assert.rejects(bootstrapLocalOwner(db, { id: 'another-owner', email: 'other@example.com', passwordHash: HASH }), errorCode('LOCAL_USER_BOOTSTRAP_CONFLICT'));
});

void test('canonical unique emails and public DTOs never disclose password hashes', async t => {
  const db = fixture(t); await seed(db);
  const created = await member(db);
  assert.equal(created.isAdmin, false); assert.equal(created.email, 'member@example.com'); assert.equal(created.revision, 1);
  assert.equal(Object.hasOwn(created, 'passwordHash'), false);
  assert.equal((await getLocalUserByEmail(db, '  MEMBER@EXAMPLE.COM '))?.id, MEMBER);
  await assert.rejects(createLocalUser(db, { id: OTHER, email: ' Member@Example.Com ', passwordHash: HASH }), errorCode('LOCAL_USER_DUPLICATE'));
  const users = await listLocalUsers(db, OWNER);
  assert.deepEqual(users.map(row => row.isAdmin), [true, false]);
  assert.equal(JSON.stringify(users).includes('scrypt'), false);
  assert.equal(Object.hasOwn(publicLocalUser((await getLocalUserById(db, MEMBER))!, OWNER), 'passwordHash'), false);
  assert.equal(new Set<string>(BACKUP_TABLE_NAMES).has('local_users'), false);
});

void test('competing revision edits have exactly one winner; stale writes preserve all credentials', async t => {
  const db = fixture(t); await seed(db); await member(db);
  const results = await Promise.allSettled([
    updateLocalUser(db, OWNER, MEMBER, { expectedRevision: 1, email: 'winner-one@example.com', passwordHash: NEW_HASH }, NEXT),
    updateLocalUser(db, OWNER, MEMBER, { expectedRevision: 1, email: 'winner-two@example.com', status: 'disabled' }, NEXT),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && errorCode('LOCAL_USER_STALE')(rejected.reason));
  const current = (await getLocalUserById(db, MEMBER))!;
  assert.equal(current.revision, 2); assert.equal(current.email, 'winner-one@example.com'); assert.equal(current.status, 'active'); assert.equal(current.passwordHash, NEW_HASH);
  assert.equal(Object.hasOwn(results.find(result => result.status === 'fulfilled')?.value ?? {}, 'passwordHash'), false);
});

void test('duplicate updates roll back the entire change, including password, status and revision', async t => {
  const db = fixture(t); await seed(db); await member(db);
  const before = await getLocalUserById(db, MEMBER);
  await assert.rejects(updateLocalUser(db, OWNER, MEMBER, { expectedRevision: 1, email: 'ADMIN@TREEFUND.ASIA', passwordHash: NEW_HASH, status: 'disabled' }, NEXT), errorCode('LOCAL_USER_DUPLICATE'));
  assert.deepEqual(await getLocalUserById(db, MEMBER), before);
});

void test('owner cannot be disabled; members can be disabled and restored without changing stable IDs', async t => {
  const db = fixture(t); await seed(db); await member(db);
  await assert.rejects(updateLocalUser(db, OWNER, OWNER, { expectedRevision: 1, status: 'disabled' }), errorCode('LOCAL_USER_OWNER_PROTECTED'));
  assert.equal((await getLocalUserById(db, OWNER))?.revision, 1);
  const disabled = await updateLocalUser(db, OWNER, MEMBER, { expectedRevision: 1, status: 'disabled' }, NEXT);
  assert.equal(disabled.status, 'disabled'); assert.equal(disabled.revision, 2);
  const restored = await updateLocalUser(db, OWNER, MEMBER, { expectedRevision: 2, status: 'active' }, NEXT);
  assert.equal(restored.id, MEMBER); assert.equal(restored.revision, 3);
  await assert.rejects(updateLocalUser(db, OWNER, OTHER, { expectedRevision: 1, email: 'missing@example.com' }), errorCode('LOCAL_USER_NOT_FOUND'));
});

void test('login timestamps are monotonic and leave credential revision and edit timestamps unchanged', async t => {
  const db = fixture(t); await seed(db); await member(db);
  await touchLocalUserLogin(db, MEMBER, NEXT);
  await touchLocalUserLogin(db, MEMBER, NOW);
  const user = (await getLocalUserById(db, MEMBER))!;
  assert.equal(user.lastLoginAt, NEXT); assert.equal(user.revision, 1); assert.equal(user.updatedAt, NOW);
  await updateLocalUser(db, OWNER, MEMBER, { expectedRevision: 1, status: 'disabled' }, NEXT);
  await touchLocalUserLogin(db, MEMBER, '2026-11-17T00:00:00.000Z');
  assert.equal((await getLocalUserById(db, MEMBER))?.lastLoginAt, NEXT);
});

void test('malformed emails, hashes, revision numbers and unsupported fields fail before any write', async t => {
  const db = fixture(t); await seed(db); await member(db);
  assert.equal(validLocalPasswordHash(HASH), true);
  for (const value of ['', 'not a hash', HASH.replace('32768', '1'), `${HASH}=`, HASH.slice(0, -1) + 'B']) assert.equal(validLocalPasswordHash(value), false);
  for (const value of ['test', 'a@invalid', 'hello@example.com\n', 'a@@example.com']) assert.throws(() => normalizeLocalEmail(value), errorCode('LOCAL_USER_INVALID'));
  const before = await getLocalUserById(db, MEMBER);
  for (const input of [{ expectedRevision: 1 }, { expectedRevision: 0, email: 'ok@example.com' }, { expectedRevision: 1, passwordHash: 'plain password' }, { expectedRevision: 1, role: 'admin' }, { expectedRevision: 1, id: OWNER }, { expectedRevision: 1, status: 'admin' }]) {
    await assert.rejects(updateLocalUser(db, OWNER, MEMBER, input as never), errorCode('LOCAL_USER_INVALID'));
  }
  assert.deepEqual(await getLocalUserById(db, MEMBER), before);
  await assert.rejects(createLocalUser(db, { id: OWNER, email: 'new@example.com', passwordHash: HASH }), errorCode('LOCAL_USER_INVALID'));
});

void test('SQLite constraints independently reject noncanonical emails and invalid status or revision', async t => {
  const db = fixture(t); await seed(db);
  for (const [email, status, revision] of [['UPPER@example.com', 'active', 1], ['user@example.com', 'admin', 1], ['user@example.com', 'active', 0], ['user@example.com', 'active', 1.5]]) {
    await assert.rejects(db.prepare('INSERT INTO local_users(id,email,password_hash,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(MEMBER, email, HASH, status, revision, NOW, NOW).run(), /CHECK constraint/);
  }
  assert.equal((await listLocalUsers(db, OWNER)).length, 1);
});

void test('competing bootstrap calls create one owner and never claim a populated database', async t => {
  const db = fixture(t);
  const sameOwner = await Promise.all([seed(db), seed(db)]);
  assert.equal(sameOwner[0].id, OWNER); assert.equal(sameOwner[1].id, OWNER);
  assert.equal((await listLocalUsers(db, OWNER)).length, 1);
  const unclaimed = fixture(t);
  await member(unclaimed);
  await assert.rejects(seed(unclaimed), errorCode('LOCAL_USER_BOOTSTRAP_CONFLICT'));
  assert.equal((await listLocalUsers(unclaimed, OWNER)).length, 1);
  assert.equal(await getLocalUserById(unclaimed, OWNER), null);
});
