import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFixture, RedirectSignal } from '../tests/fixtures/account-access.ts';
import { inviteAccessGrant, changeAccessGrant } from '../db/access-grants-store.ts';

void test('signed-out pages go to sign-in while authenticated denied pages go to access-denied without a sign-in loop', async (t) => {
  const f = authorizationFixture(t);
  f.signIn(null); assert.equal(await f.auth.getChatGPTUser(), null);
  await assert.rejects(f.auth.requireChatGPTUser('/health?days=30'), (error) => error instanceof RedirectSignal && error.destination === '/signin-with-chatgpt?return_to=%2Fhealth%3Fdays%3D30');
  f.signIn('uninvited-visitor', 'visitor@example.test');
  await assert.rejects(f.auth.requireChatGPTUser('/finance'), (error) => error instanceof RedirectSignal && error.destination === '/access-denied');
  assert.equal(await f.auth.getChatGPTUser(), null);
  assert.equal((await f.auth.getChatGPTIdentity())!.email, 'visitor@example.test');
});

void test('owner and member roles come from real server authorization and a revoked member cannot render a business page', async (t) => {
  const f = authorizationFixture(t); f.signIn('actual-site-owner', 'owner@example.test');
  assert.equal((await f.auth.requireChatGPTUser('/settings/access')).isOwner, true);
  const owner = { actorUserId: 'actual-site-owner', ownerUserId: 'actual-site-owner', ownerEmail: 'owner@example.test' };
  const grantId = '10000000-0000-4000-8000-000000000001';
  await inviteAccessGrant(f.db, owner, { email: 'member@example.test' }, grantId);
  f.signIn('member-site-id', 'member@example.test');
  const member = await f.auth.requireChatGPTUser('/health'); assert.equal(member.isOwner, false); assert.equal(member.userId, 'member-site-id');
  await changeAccessGrant(f.db, owner, grantId, { status: 'revoked', expectedRevision: 1 }, '10000000-0000-4000-8000-000000000002');
  await assert.rejects(f.auth.requireChatGPTUser('/health'), (error) => error instanceof RedirectSignal && error.destination === '/access-denied');
  assert.equal(await f.auth.getChatGPTUser(), null);
});

void test('missing owner configuration and broken access storage never produce an authenticated application user', async (t) => {
  const f = authorizationFixture(t, {}); f.signIn('any-first-user', 'owner@example.test');
  assert.equal(await f.auth.getChatGPTUser(), null);
  await assert.rejects(f.auth.requireChatGPTUser('/'), (error) => error instanceof RedirectSignal && error.destination === '/access-denied');
  f.env.APP_OWNER_EMAIL = 'owner@example.test'; f.env.DB = undefined;
  assert.equal(await f.auth.getChatGPTUser(), null);
});

void test('sign-in and sign-out return paths cannot redirect to another origin or reserved authentication routes', (t) => {
  const f = authorizationFixture(t);
  for (const unsafe of ['https://evil.example', '//evil.example/path', '/\\evil.example/path', '/signin-with-chatgpt', '/signout-with-chatgpt', '/callback']) {
    assert.equal(f.auth.chatGPTSignInPath(unsafe), '/signin-with-chatgpt?return_to=%2F');
    assert.equal(f.auth.chatGPTSignOutPath(unsafe), '/signout-with-chatgpt?return_to=%2F');
  }
  assert.equal(f.auth.chatGPTSignOutPath('/account?signedOut=1'), '/signout-with-chatgpt?return_to=%2Faccount%3FsignedOut%3D1');
});
