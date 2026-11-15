import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import test, { type TestContext } from 'node:test';
import { authorizationFixture, RedirectSignal } from '../../tests/fixtures/account-access.ts';
import { inviteAccessGrant, changeAccessGrant } from '../../db/access-grants-store.ts';
import { createAccessHandlers } from '../../lib/access-control-api.ts';
import { createManagedFoodHandlers } from '../../lib/managed-food-api.ts';
import { createNotificationsHandlers } from '../../lib/notifications-api.ts';
import { createFinanceBookHandlers } from '../../lib/finance-books-api.ts';
import { createDataBackupHandlers } from '../../lib/data-backup-api.ts';

const GRANT = '10000000-0000-4000-8000-000000000099';
async function fixture(t: TestContext) {
  const f = authorizationFixture(t, { userId: 'site-owner' });
  await inviteAccessGrant(f.db, { actorUserId: 'site-owner', ownerUserId: 'site-owner' }, { email: 'member@example.test' }, GRANT);
  f.signIn('site-member', 'member@example.test');
  const source = stripTypeScriptTypes(readFileSync(new URL('./session/route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const session = compileFunction(source + '\nreturn GET;', Object.keys(f.api))(...Object.values(f.api)) as () => Promise<Response>;
  const unavailable = { prepare() { throw new Error('PRIVATE permission database exception'); } } as unknown as D1Database;
  return { ...f, session, fail() { f.env.DB = unavailable; }, recover() { f.env.DB = f.db; } };
}

void test('middleware may authorize before a handler auth read fails; session returns recoverable 503 then succeeds under the same owner', async t => {
  const f = await fixture(t);
  assert.equal((await f.middleware(new Request('https://site.example/api/session', { headers: f.headers() }))).status, 200);
  f.fail();
  const response = await f.session();
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { code: string }).code, 'ACCOUNT_ACCESS_UNAVAILABLE');
  assert.equal(response.headers.get('Retry-After'), '3');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  f.recover();
  assert.equal((await f.session()).status, 200);
  assert.equal((await (await f.session()).json() as { userId: string }).userId, 'site-member');
});

void test('failure-path reauthorization that already recovered still refuses the original unexecuted request with 503', async t => {
  const f = await fixture(t); f.fail();
  assert.equal(await f.api.apiUser(), null);
  f.recover();
  const response = await f.api.unauthenticated();
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { code: string }).code, 'ACCOUNT_ACCESS_UNAVAILABLE');
  assert.equal((await f.api.apiUser())?.userId, 'site-member');
});

void test('all injected factory null-user paths retain retryable authorization failures before business storage is touched', async t => {
  const f = await fixture(t); f.fail(); let businessReads = 0;
  const deps = { user: () => f.api.apiUser(), unauthenticated: (message?: string) => f.api.unauthenticated(message), json: (value: unknown, status?: number, headers?: Record<string, string>) => f.api.json(value, status, headers), database() { businessReads++; throw new Error('Business storage must not be read'); } };
  const request = new Request('https://site.example/api/fixture', { headers: f.headers() });
  const routes = [
    createAccessHandlers({ ...deps, ownerId: () => 'site-owner' }).GET(request),
    createManagedFoodHandlers({ ...deps, ownerId: async () => 'site-owner', builtin: () => [] }).GET(request),
    createNotificationsHandlers(deps).GET(request),
    createFinanceBookHandlers(deps).GET(request),
    createDataBackupHandlers({ ...deps, unavailable: () => new Response(null, { status: 503 }) }).GET(request),
    createDataBackupHandlers({ ...deps, unavailable: () => new Response(null, { status: 503 }) }).POST(request),
  ];
  for (const response of await Promise.all(routes)) {
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, 'ACCOUNT_ACCESS_UNAVAILABLE');
  }
  assert.equal(businessReads, 0);
});

void test('actual sign-out remains 401, actual revocation remains 403, and unavailable SSR uses a retry route instead of access-denied', async t => {
  const f = await fixture(t); f.fail();
  await assert.rejects(f.auth.requireChatGPTUser('/health?days=30'), error => error instanceof RedirectSignal && error.destination === '/service-unavailable?returnTo=%2Fhealth%3Fdays%3D30');
  await assert.rejects(f.auth.getChatGPTUser('/account?signedOut=1'), error => error instanceof RedirectSignal && error.destination === '/service-unavailable?returnTo=%2Faccount%3FsignedOut%3D1');
  f.recover();
  assert.equal((await f.auth.requireChatGPTUser('/health')).userId, 'site-member');
  await changeAccessGrant(f.db, { actorUserId: 'site-owner', ownerUserId: 'site-owner' }, GRANT, { status: 'revoked', expectedRevision: 1 }, '10000000-0000-4000-8000-000000000098');
  const revoked = await f.session(); assert.equal(revoked.status, 403);
  assert.equal((await revoked.json() as { code: string }).code, 'ACCOUNT_NOT_ALLOWED');
  await assert.rejects(f.auth.requireChatGPTUser('/health'), error => error instanceof RedirectSignal && error.destination === '/access-denied');
  f.signIn(null);
  const signedOut = await f.session(); assert.equal(signedOut.status, 401);
  assert.equal((await signedOut.json() as { code: string }).code, 'SIGN_IN_REQUIRED');
});
