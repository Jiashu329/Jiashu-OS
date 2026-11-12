import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { AccessConfigurationError, AccessConflictError, AccessForbiddenError, AccessValidationError } from '../lib/access-control.ts';
import type { AccessGrant, AccessOwnerContext } from '../lib/access-control.ts';
import { changeAccessGrant, inviteAccessGrant, listAccessGrants, resolveAccess } from './access-grants-store.ts';

const NOW = '2026-11-12T04:00:00.000Z', NEXT = '2026-11-12T16:00:00.000Z';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const OWNER: AccessOwnerContext = { actorUserId: 'site-owner', ownerUserId: 'site-owner', ownerEmail: 'owner@example.com' };
interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; execute(): { results: unknown[]; meta: { changes: number } } }
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  let beforeBatch: (() => void) | null = null, beforeBind: (() => void) | null = null;
  const db = {
    prepare(sql: string) {
      const query = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const execute = () => query.columns().length ? { results: query.all(...values), meta: { changes: 0 } } : { results: [], meta: { changes: Number(query.run(...values).changes) } };
      const bound: Statement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { if (sql.startsWith('UPDATE app_access_grants')) { const callback = beforeBind; beforeBind = null; callback?.(); } return query.get(...values) as T ?? null; },
        async all<T>() { return { results: query.all(...values) as T[] }; }, execute,
      };
      return bound;
    },
    async batch(commands: Statement[]) {
      const callback = beforeBatch; beforeBatch = null; callback?.();
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = commands.map((command) => command.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { db, sqlite, race(action: () => void) { beforeBatch = action; }, bindRace(action: () => void) { beforeBind = action; }, changes() { return Number(sqlite.prepare('SELECT total_changes() n').get()!.n); } };
}
const invite = (db: D1Database, email = 'member@example.com', id = A) => inviteAccessGrant(db, OWNER, { email }, id, NOW);

void test('owner needs no database or invitation and a missing configured owner fails closed without writes', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await resolveAccess(null, { userId: 'site-owner', email: 'changed@example.com' }, 'site-owner', NOW), { allowed: true, isOwner: true });
  assert.deepEqual(await resolveAccess(f.db, { userId: 'first-visitor', email: 'member@example.com' }, undefined, NOW), { allowed: false, isOwner: false, reason: 'unconfigured' });
  assert.equal(f.changes(), 0);
  await assert.rejects(listAccessGrants(f.db, { ...OWNER, ownerUserId: undefined }), AccessConfigurationError);
});
void test('ordinary members cannot enumerate, invite, deactivate or restore anyone', async (t) => {
  const f = fixture(t), member = { ...OWNER, actorUserId: 'ordinary-member' };
  await assert.rejects(listAccessGrants(f.db, member), AccessForbiddenError);
  await assert.rejects(inviteAccessGrant(f.db, member, { email: 'third@example.com' }, A, NOW), AccessForbiddenError);
  await assert.rejects(changeAccessGrant(f.db, member, A, { status: 'active', expectedRevision: 1 }, B, NOW), AccessForbiddenError);
  assert.equal(f.changes(), 0);
});
void test('canonical duplicate emails are rejected and exact request retries acknowledge one persistent grant', async (t) => {
  const f = fixture(t), first = await invite(f.db, '  Member@Example.COM ');
  assert.equal(first.grant.email, 'member@example.com'); assert.equal(first.grant.revision, 1); assert.equal(first.grant.boundUserId, null);
  assert.deepEqual(await invite(f.db, 'member@example.com'), { grant: first.grant, replayed: true });
  await assert.rejects(invite(f.db, 'MEMBER@example.com', B), AccessConflictError);
  await assert.rejects(invite(f.db, 'different@example.com', A), AccessConflictError);
  assert.equal((await listAccessGrants(f.db, OWNER)).length, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_access_operations').get()!.n, 1);
});
void test('first successful login binds the stable identity and later same-day requests perform no writes', async (t) => {
  const f = fixture(t); await invite(f.db);
  const identity = { userId: 'member-stable-id', email: ' MEMBER@example.com ' };
  assert.deepEqual(await resolveAccess(f.db, identity, 'site-owner', NOW), { allowed: true, isOwner: false });
  const row = (await listAccessGrants(f.db, OWNER))[0]; assert.equal(row.boundUserId, identity.userId); assert.equal(row.lastLoginAt, NOW);
  const changes = f.changes();
  for (let index = 0; index < 5; index++) assert.deepEqual(await resolveAccess(f.db, identity, 'site-owner', '2026-11-12T15:59:59.000Z'), { allowed: true, isOwner: false });
  assert.equal(f.changes(), changes);
  await resolveAccess(f.db, identity, 'site-owner', NEXT); assert.equal(f.changes(), changes + 1);
  assert.equal((await listAccessGrants(f.db, OWNER))[0].lastLoginAt, NEXT);
  await resolveAccess(f.db, identity, 'site-owner', NEXT); assert.equal(f.changes(), changes + 1);
});
void test('a revoked member is denied on the next request and restoration keeps the original stable binding', async (t) => {
  const f = fixture(t); await invite(f.db); const member = { userId: 'member-one', email: 'member@example.com' };
  await resolveAccess(f.db, member, 'site-owner', NOW);
  const revoked = await changeAccessGrant(f.db, OWNER, A, { status: 'revoked', expectedRevision: 1 }, B, NOW);
  assert.equal(revoked.grant.revision, 2);
  assert.deepEqual(await resolveAccess(f.db, member, 'site-owner', NOW), { allowed: false, isOwner: false, reason: 'revoked' });
  const restored = await changeAccessGrant(f.db, OWNER, A, { status: 'active', expectedRevision: 2 }, C, NOW);
  assert.equal(restored.grant.boundUserId, 'member-one'); assert.equal(restored.grant.revision, 3);
  assert.deepEqual(await resolveAccess(f.db, member, 'site-owner', NOW), { allowed: true, isOwner: false });
  assert.deepEqual(await resolveAccess(f.db, { ...member, userId: 'recycled-email-user' }, 'site-owner', NOW), { allowed: false, isOwner: false, reason: 'identity_conflict' });
  const retry = await changeAccessGrant(f.db, OWNER, A, { status: 'revoked', expectedRevision: 1 }, B, NOW);
  assert.equal(retry.replayed, true); assert.equal(retry.grant.status, 'active'); assert.equal(retry.grant.revision, 3);
});
void test('a changed email keeps the original stable account grant and cannot transfer it to a different identity', async (t) => {
  const f = fixture(t); await invite(f.db); await invite(f.db, 'another@example.com', B);
  await resolveAccess(f.db, { userId: 'member-one', email: 'member@example.com' }, 'site-owner', NOW);
  assert.equal((await resolveAccess(f.db, { userId: 'member-two', email: 'member@example.com' }, 'site-owner', NOW)).allowed, false);
  assert.deepEqual(await resolveAccess(f.db, { userId: 'member-one', email: 'another@example.com' }, 'site-owner', NOW), { allowed: true, isOwner: false });
  assert.deepEqual(await resolveAccess(f.db, { userId: 'member-one', email: 'not-invited-new@example.com' }, 'site-owner', NOW), { allowed: true, isOwner: false });
  assert.equal((await listAccessGrants(f.db, OWNER)).find((row) => row.id === B)!.boundUserId, null);
});
void test('a revoked stable account cannot bypass revocation using a newly invited email', async (t) => {
  const f = fixture(t);await invite(f.db);await invite(f.db, 'changed@example.com', B);
  await resolveAccess(f.db, { userId: 'member-one', email: 'member@example.com' }, 'site-owner', NOW);
  await changeAccessGrant(f.db, OWNER, A, { status: 'revoked', expectedRevision: 1 }, C, NOW);
  assert.deepEqual(await resolveAccess(f.db, { userId: 'member-one', email: 'changed@example.com' }, 'site-owner', NOW), { allowed: false, isOwner: false, reason: 'revoked' });
  assert.equal((await listAccessGrants(f.db, OWNER)).find((row) => row.id === B)!.boundUserId, null);
  assert.deepEqual(await resolveAccess(f.db, { userId: 'recycled-email-account', email: 'member@example.com' }, 'site-owner', NOW), { allowed: false, isOwner: false, reason: 'revoked' });
});
void test('uninvited identities and SQL-shaped values never gain access or mutate another grant', async (t) => {
  const f = fixture(t); await invite(f.db);
  const before = f.changes();
  assert.equal((await resolveAccess(f.db, { userId: 'visitor', email: 'uninvited@example.com' }, 'site-owner', NOW)).allowed, false);
  assert.equal((await resolveAccess(f.db, { userId: "' OR 1=1 --", email: "' OR 1=1 --" }, 'site-owner', NOW)).allowed, false);
  assert.equal((await resolveAccess(f.db, { userId: ' site-owner ', email: 'owner@example.com' }, 'site-owner', NOW)).allowed, false);
  assert.equal(f.changes(), before);
});
void test('the owner is not an editable member and never loses access through a grant row', async (t) => {
  const f = fixture(t); await assert.rejects(invite(f.db, 'OWNER@example.com'), AccessValidationError);
  await invite(f.db);
  f.sqlite.prepare('UPDATE app_access_grants SET bound_user_id = ?, status = ? WHERE id = ?').run('site-owner', 'revoked', A);
  await assert.rejects(changeAccessGrant(f.db, OWNER, A, { status: 'active', expectedRevision: 1 }, B, NOW), AccessValidationError);
  assert.deepEqual(await resolveAccess(f.db, { userId: 'site-owner', email: 'owner@example.com' }, 'site-owner', NOW), { allowed: true, isOwner: true });
});
void test('stale tabs and operation ID reuse cannot override newer access decisions', async (t) => {
  const f = fixture(t); await invite(f.db);
  await changeAccessGrant(f.db, OWNER, A, { status: 'revoked', expectedRevision: 1 }, B, NOW);
  await assert.rejects(changeAccessGrant(f.db, OWNER, A, { status: 'active', expectedRevision: 1 }, C, NOW), AccessConflictError);
  await assert.rejects(changeAccessGrant(f.db, OWNER, A, { status: 'active', expectedRevision: 2 }, B, NOW), AccessConflictError);
  assert.equal((await listAccessGrants(f.db, OWNER))[0].status, 'revoked');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_access_operations').get()!.n, 2);
});
void test('a first-login race with revocation cannot bind or authenticate the member', async (t) => {
  const f = fixture(t); await invite(f.db);
  f.bindRace(() => f.sqlite.prepare("UPDATE app_access_grants SET status = 'revoked', revision = revision + 1 WHERE id = ?").run(A));
  const result = await resolveAccess(f.db, { userId: 'member-one', email: 'member@example.com' }, 'site-owner', NOW);
  assert.deepEqual(result, { allowed: false, isOwner: false, reason: 'revoked' });
  assert.equal((await listAccessGrants(f.db, OWNER))[0].boundUserId, null);
});
void test('a concurrent owner change invalidates the batch guard before a conflicting write or operation receipt', async (t) => {
  const f = fixture(t); await invite(f.db);
  f.race(() => f.sqlite.prepare("UPDATE app_access_grants SET status = 'revoked', revision = revision + 1 WHERE id = ?").run(A));
  await assert.rejects(changeAccessGrant(f.db, OWNER, A, { status: 'revoked', expectedRevision: 1 }, B, NOW), AccessConflictError);
  assert.equal((await listAccessGrants(f.db, OWNER))[0].revision, 2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_access_operations').get()!.n, 1);
});
void test('storage failures atomically roll back invites and status changes without orphan receipts', async (t) => {
  const f = fixture(t);
  f.sqlite.exec("CREATE TRIGGER reject_access_receipt BEFORE INSERT ON app_access_operations BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
  await assert.rejects(invite(f.db), /synthetic receipt failure/);
  assert.equal((await listAccessGrants(f.db, OWNER)).length, 0);
  f.sqlite.exec('DROP TRIGGER reject_access_receipt');await invite(f.db);
  f.sqlite.exec("CREATE TRIGGER reject_access_receipt BEFORE INSERT ON app_access_operations BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
  await assert.rejects(changeAccessGrant(f.db, OWNER, A, { status: 'revoked', expectedRevision: 1 }, B, NOW), /synthetic receipt failure/);
  assert.equal((await listAccessGrants(f.db, OWNER))[0].status, 'active');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_access_operations').get()!.n, 1);
});
void test('parallel duplicate invites leave one email configuration and different members remain independent', async (t) => {
  const f = fixture(t);
  const outcomes = await Promise.allSettled([invite(f.db, 'member@example.com', A), invite(f.db, 'MEMBER@example.com', B)]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
  await invite(f.db, 'second@example.com', C);
  const grants = await listAccessGrants(f.db, OWNER), second = grants.find((row) => row.email === 'second@example.com')!;
  await resolveAccess(f.db, { userId: 'second-user', email: second.email }, 'site-owner', NOW);
  await changeAccessGrant(f.db, OWNER, second.id, { status: 'revoked', expectedRevision: 1 }, D, NOW);
  const first = (await listAccessGrants(f.db, OWNER)).find((row) => row.email === 'member@example.com') as AccessGrant;
  assert.equal(first.status, 'active');assert.equal(first.boundUserId, null);
});
