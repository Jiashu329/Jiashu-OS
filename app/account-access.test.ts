import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFixture } from '../tests/fixtures/account-access.ts';
import { inviteAccessGrant, changeAccessGrant } from '../db/access-grants-store.ts';
import { createAccessHandlers } from '../lib/access-control-api.ts';
import { BACKUP_TABLE_NAMES } from '../lib/data-backup.ts';
import { bootstrapLocalOwner, createLocalUser, updateLocalUser } from '../db/local-users-store.ts';

const OWNER = 'actual-site-owner';
const INVITE = '10000000-0000-4000-8000-000000000001';
const REVOKE = '10000000-0000-4000-8000-000000000002';
const owner = { actorUserId: OWNER, ownerUserId: OWNER, ownerEmail: 'owner@example.test' };
const LOCAL_HASH = `scrypt-v1$32768$8$1$${Buffer.alloc(16, 1).toString('base64url')}$${Buffer.alloc(64, 2).toString('base64url')}`;

void test('anonymous, uninvited and unconfigured identities fail closed without claiming the owner slot', async (t) => {
  const f = authorizationFixture(t, {});
  assert.deepEqual(await f.accountAccess(new Headers()), { identity: null, allowed: false, isOwner: false, reason: 'signed_out' });
  const denied = await f.accountAccess(f.identity('first-visitor', 'visitor@example.test'));
  assert.equal(denied.allowed, false); assert.equal(denied.reason, 'unconfigured');
  const blocked = await f.middleware(new Request('https://site.example/api/data/backup', { headers: f.identity('first-visitor', 'visitor@example.test') }));
  assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('x-middleware-next'), null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_owner_identity').get()!.n, 0);
  f.env.APP_OWNER_EMAIL = 'owner@example.test';
  assert.equal((await f.accountAccess(f.identity('first-visitor', 'visitor@example.test'))).allowed, false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_owner_identity').get()!.n, 0);
});

void test('verified configured owner email binds the actual Site identity once, never a global ID or later recycled email', async (t) => {
  const f = authorizationFixture(t);
  const initial = await f.accountAccess(f.identity(OWNER, 'Owner@Example.test'));
  assert.equal(initial.allowed, true); assert.equal(initial.isOwner, true);
  assert.equal(f.sqlite.prepare("SELECT user_id FROM app_owner_identity WHERE id='owner'").get()!.user_id, OWNER);
  const duplicateEmail = await f.accountAccess(f.identity('different-site-id', 'owner@example.test'));
  assert.equal(duplicateEmail.allowed, false); assert.equal(duplicateEmail.isOwner, false);
  const changedEmail = await f.accountAccess(f.identity(OWNER, 'new-owner-email@example.test'));
  assert.equal(changedEmail.allowed, true); assert.equal(changedEmail.isOwner, true);
  f.env.APP_OWNER_USER_ID = 'wrong-global-account-uuid';
  assert.equal((await f.accountAccess(f.identity(OWNER, 'owner@example.test'))).allowed, false);
  f.env.APP_OWNER_USER_ID = OWNER; f.env.DB = undefined;
  assert.equal((await f.accountAccess(f.identity(OWNER, 'any-owner-email@example.test'))).isOwner, true);
});

void test('two configured-email identities racing bootstrap authorize only the winning stable ID', async (t) => {
  const f = authorizationFixture(t);
  const results = await Promise.all(['first-site-id', 'second-site-id'].map((id) => f.accountAccess(f.identity(id, 'owner@example.test'))));
  assert.equal(results.filter((result) => result.allowed && result.isOwner).length, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_owner_identity').get()!.n, 1);
  const stored = String(f.sqlite.prepare('SELECT user_id FROM app_owner_identity').get()!.user_id);
  assert.equal(results.find((result) => result.allowed)!.identity!.userId, stored);
});

void test('invited members are bound independently, cannot enumerate grants, and revocation is checked on the next request', async (t) => {
  const f = authorizationFixture(t); await f.accountAccess(f.identity(OWNER, 'owner@example.test'));
  await inviteAccessGrant(f.db, owner, { email: 'member@example.test' }, INVITE);
  f.signIn('member-site-id', 'member@example.test', 1);
  assert.equal((await f.auth.getChatGPTUser())!.isOwner, false);
  assert.equal((await f.auth.getChatGPTUser())!.localAccountRevision, undefined, 'Sites does not use a local revision header');
  const handlers = createAccessHandlers({ user: () => f.auth.getChatGPTUser(), ownerId(user) { return user.isOwner ? user.userId : undefined; },
    database() { assert.fail('ordinary member must not read the member directory'); }, json: (value, status = 200) => Response.json(value, { status }) });
  assert.equal((await handlers.GET(new Request('https://site.example/api/access'))).status, 403);
  await changeAccessGrant(f.db, owner, INVITE, { status: 'revoked', expectedRevision: 1 }, REVOKE);
  const revoked = await f.accountAccess(f.headers()); assert.equal(revoked.allowed, false); assert.equal(revoked.reason, 'revoked');
  assert.equal(await f.auth.getChatGPTUser(), null);
  assert.equal((await f.middleware(new Request('https://site.example/api/health', { headers: f.headers() }))).status, 403);
});

void test('real access evaluation plus middleware rejects missing/stale page owners before an allowed API mutation', async (t) => {
  const f = authorizationFixture(t); f.signIn(OWNER, 'owner@example.test');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const expected of [null, 'previous-account']) {
    const headers = f.headers(); if (expected) headers.set('X-Page-Owner', expected);
    const denied = await f.middleware(new Request('https://site.example/api/future-route', { method, headers }));
    assert.equal(denied.status, 401); assert.equal(denied.headers.get('x-middleware-next'), null);
    assert.equal((await denied.json() as { code: string }).code, 'ACCOUNT_CHANGED');
  }
  const headers = f.headers(); headers.set('X-Page-Owner', OWNER);
  const accepted = await f.middleware(new Request('https://site.example/api/future-route', { method: 'POST', headers }));
  assert.equal(accepted.headers.get('x-middleware-next'), '1'); assert.equal(accepted.headers.get('X-Account-Owner'), OWNER);
  headers.set('X-Page-Owner', 'previous-account');
  assert.equal((await f.middleware(new Request('https://site.example/api/session', { headers }))).headers.get('x-middleware-next'), '1');
});

void test('stable member identity survives an email change but cannot escape revocation through a second invitation', async (t) => {
  const f = authorizationFixture(t); await f.accountAccess(f.identity(OWNER, 'owner@example.test'));
  await inviteAccessGrant(f.db, owner, { email: 'old-member@example.test' }, INVITE);
  f.signIn('stable-member', 'old-member@example.test'); assert.equal((await f.auth.getChatGPTUser())!.isOwner, false);
  f.signIn('stable-member', 'new-member@example.test'); assert.equal((await f.auth.getChatGPTUser())!.userId, 'stable-member');
  assert.equal((await f.accountAccess(f.identity('recycled-email-new-user', 'old-member@example.test'))).allowed, false);
  await changeAccessGrant(f.db, owner, INVITE, { status: 'revoked', expectedRevision: 1 }, REVOKE);
  await inviteAccessGrant(f.db, owner, { email: 'new-member@example.test' }, '10000000-0000-4000-8000-000000000003');
  assert.equal(await f.auth.getChatGPTUser(), null);
  assert.equal((await f.accountAccess(f.headers())).reason, 'revoked');
});

void test('storage loss stays closed, safe diagnostics contain no identities and authorization tables never enter business backups', async (t) => {
  const f = authorizationFixture(t); await f.accountAccess(f.identity(OWNER, 'owner@example.test'));
  f.env.DB = { prepare() { throw new Error('synthetic storage private detail'); } } as unknown as D1Database;
  const result = await f.accountAccess(f.identity('member-site-id', 'member-private@example.test'));
  assert.equal(result.allowed, false); assert.equal(result.reason, 'unavailable');
  const blocked = await f.middleware(new Request('https://site.example/api/health', { headers: f.identity('member-site-id', 'member-private@example.test') }));
  assert.equal(blocked.status, 503); assert.equal(blocked.headers.get('x-middleware-next'), null);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /member-site-id|member-private|synthetic storage private/);
  assert.equal(BACKUP_TABLE_NAMES.length, 34);
  assert.equal(BACKUP_TABLE_NAMES.some((name: string) => name === 'douban_items'), true);
  for (const excluded of ['douban_connections', 'douban_sync_runs', 'douban_import_receipts']) {
    assert.equal(BACKUP_TABLE_NAMES.some((name: string) => name === excluded), false);
  }
  assert.equal(BACKUP_TABLE_NAMES.some((name: string) => name.startsWith('app_access_') || name === 'app_owner_identity'), false);
  assert.equal(BACKUP_TABLE_NAMES.includes('local_users' as never), false);
});

void test('local members use active persisted accounts independently of Sites invitations and retain separate stable identities', async t => {
  const f = authorizationFixture(t, { userId: OWNER, email: 'owner@example.test' });
  f.env.SELFHOST_AUTH_PROVIDER = 'local';
  await bootstrapLocalOwner(f.db, { id: OWNER, email: 'owner@example.test', passwordHash: LOCAL_HASH });
  await createLocalUser(f.db, { id: INVITE, email: 'member@example.test', passwordHash: LOCAL_HASH });
  const administrator = await f.accountAccess(f.identity(OWNER, 'OWNER@example.test', 1));
  assert.equal(administrator.allowed, true); assert.equal(administrator.isOwner, true);
  assert.equal((await f.accountAccess(f.identity(INVITE, 'member@example.test'))).allowed, false, 'The gateway must attest the session revision');
  f.signIn(INVITE, 'member@example.test', 1);
  const member = await f.auth.getChatGPTUser();
  assert.equal(member?.userId, INVITE); assert.equal(member?.isOwner, false);
  assert.equal(member?.localAccountRevision, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_access_grants').get()!.n, 0);
  assert.equal((await f.accountAccess(f.identity('unknown-account', 'member@example.test'))).allowed, false);
  assert.equal((await f.accountAccess(f.identity(INVITE, 'different@example.test'))).reason, 'identity_conflict');
  await updateLocalUser(f.db, OWNER, INVITE, { expectedRevision: 1, email: 'new-member@example.test' });
  assert.equal((await f.accountAccess(f.headers())).allowed, false);
  assert.equal((await f.accountAccess(f.identity(INVITE, 'new-member@example.test', 1))).reason, 'revoked', 'A stale gateway session cannot adopt the newer account revision');
  f.signIn(INVITE, 'new-member@example.test', 2);
  assert.equal((await f.auth.getChatGPTUser())?.userId, INVITE);
  await updateLocalUser(f.db, OWNER, INVITE, { expectedRevision: 2, status: 'disabled' });
  assert.equal((await f.accountAccess(f.headers())).reason, 'revoked');
  assert.equal(await f.auth.getChatGPTUser(), null);
  assert.equal((await f.middleware(new Request('https://site.example/api/health', { headers: f.headers() }))).status, 403);
});

void test('local owner privileges also require a matching active stored account and available database', async t => {
  const f = authorizationFixture(t, { userId: OWNER, email: 'owner@example.test' });
  f.env.SELFHOST_AUTH_PROVIDER = 'local';
  assert.equal((await f.accountAccess(f.identity(OWNER, 'owner@example.test'))).allowed, false);
  await bootstrapLocalOwner(f.db, { id: OWNER, email: 'new-owner@example.test', passwordHash: LOCAL_HASH });
  assert.equal((await f.accountAccess(f.identity(OWNER, 'owner@example.test'))).allowed, false);
  assert.equal((await f.accountAccess(f.identity(OWNER, 'new-owner@example.test', 1))).isOwner, true);
  f.sqlite.prepare("UPDATE local_users SET status='disabled' WHERE id=?").run(OWNER);
  assert.equal((await f.accountAccess(f.identity(OWNER, 'new-owner@example.test'))).allowed, false);
  f.env.DB = undefined;
  const unavailable = await f.accountAccess(f.identity(OWNER, 'new-owner@example.test'));
  assert.equal(unavailable.reason, 'unavailable'); assert.equal(unavailable.isOwner, false);
});
