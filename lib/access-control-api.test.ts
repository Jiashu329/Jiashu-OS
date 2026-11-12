import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessHandlers } from './access-control-api.ts';
import type { AccessDatabase } from '../db/access-grants-store.ts';

const OP = '11111111-1111-4111-8111-111111111111';
function fixture(user: { userId: string; email: string; isOwner: boolean } | null = { userId: 'owner-runtime-id', email: 'owner@example.com', isOwner: true }) {
  let calls = 0, configured = true, broken = false;
  const db = { prepare() { if (broken) throw new Error('private SQL details'); return { async all() { return { results: [{ id: OP, email: 'member@example.com', boundUserId: 'private-member-stable-id', status: 'active', revision: 1, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', lastLoginAt: null }] }; } }; } } as unknown as AccessDatabase;
  const handlers = createAccessHandlers({ async user() { return user; }, ownerId(identity) { return configured && identity.isOwner ? identity.userId : undefined; }, database() { calls++; return db; }, json(value, status = 200) { return Response.json(value, { status }); } });
  return { handlers, calls: () => calls, unconfigure() { configured = false; }, breakStorage() { broken = true; } };
}
function request(body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') {
  return new Request('https://jiashu.example/api/access', { method, headers: { Origin: 'https://jiashu.example', 'Content-Type': 'application/json', 'Idempotency-Key': OP, 'X-Page-Owner': 'owner-runtime-id', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
void test('anonymous and ordinary members cannot enumerate or mutate a list before any database call', async () => {
  for (const identity of [null, { userId: 'member-runtime-id', email: 'member@example.com', isOwner: false }]) {
    const f = fixture(identity), expected = identity ? 403 : 401;
    assert.equal((await f.handlers.GET(request())).status, expected);
    assert.equal((await f.handlers.POST(request({ email: 'another@example.com', isOwner: true }))).status, expected);
    assert.equal((await f.handlers.PATCH(request({ status: 'active', expectedRevision: 1 }), OP)).status, expected);
    assert.equal(f.calls(), 0);
  }
});
void test('only a verified owner receives a member list and member stable IDs are never returned', async () => {
  const f = fixture(), response = await f.handlers.GET(request());
  assert.equal(response.status, 200);
  const data = await response.json() as { grants: Array<{ bound: boolean }>; owner: { email: string } };
  assert.equal(data.owner.email, 'owner@example.com');assert.equal(data.grants[0].bound, true);
  assert.equal(JSON.stringify(data).includes('private-member-stable-id'), false);
});
void test('a stale page owner is an ACCOUNT_CHANGED response and cannot access a new account list', async () => {
  const f = fixture(), response = await f.handlers.GET(request(undefined, { 'X-Page-Owner': 'different-owner' }));
  assert.equal(response.status, 401);assert.equal((await response.json() as { code: string }).code, 'ACCOUNT_CHANGED');assert.equal(f.calls(), 0);
});
void test('cross-origin writes, unsupported role fields and missing operation IDs stop before storage', async () => {
  const f = fixture();
  assert.equal((await f.handlers.POST(request({ email: 'member@example.com' }, { Origin: 'https://other.example' }))).status, 403);
  assert.equal((await f.handlers.POST(request({ email: 'member@example.com' }, { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await f.handlers.POST(request({ email: 'member@example.com' }, { 'Idempotency-Key': '' }))).status, 400);
  assert.equal((await f.handlers.POST(request({ email: 'member@example.com', ownerUserId: 'attacker' }))).status, 400);
  assert.equal((await f.handlers.PATCH(request({ status: 'active', expectedRevision: 1, role: 'owner' }), OP)).status, 400);
  assert.equal(f.calls(), 0);
});
void test('configuration and storage errors fail closed without disclosing internal data', async () => {
  const f = fixture();f.unconfigure();assert.equal((await f.handlers.GET(request())).status, 503);assert.equal(f.calls(), 0);
  const broken = fixture();broken.breakStorage();const response = await broken.handlers.GET(request());
  assert.equal(response.status, 503);assert.equal((await response.text()).includes('private SQL details'), false);
});
void test('bounded streaming rejects large or malformed bodies before database access', async () => {
  const f = fixture();
  assert.equal((await f.handlers.POST(request({ email: 'x'.repeat(9000) }))).status, 413);
  const malformed = new Request('https://jiashu.example/api/access', { method: 'POST', headers: { Origin: 'https://jiashu.example', 'Content-Type': 'application/json', 'Idempotency-Key': OP }, body: '{invalid' });
  assert.equal((await f.handlers.POST(malformed)).status, 400);assert.equal(f.calls(), 0);
});
