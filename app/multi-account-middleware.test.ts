import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { pageAccountFailure } from '../lib/account-identity.ts';

function fixture(access: { identity: { userId: string } | null; allowed: boolean; isOwner: boolean; reason?: string }) {
  const source = stripTypeScriptTypes(readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const NextResponse = { json: (data: unknown, options: ResponseInit) => Response.json(data, options), next: () => new Response(null, { headers: { 'x-middleware-next': '1' } }) };
  return runInNewContext('(function(){' + source + '\nreturn {middleware,config};})()', {
    accountAccess: async () => access, NextResponse, pageAccountFailure, URL,
  }) as { middleware(request: Request): Promise<Response>; config: { matcher: string } };
}

void test('every API is gated before routing, including an otherwise unprotected future handler', async () => {
  const anonymous = fixture({ identity: null, allowed: false, isOwner: false });
  assert.equal(anonymous.config.matcher, '/api/:path*');
  assert.equal((await anonymous.middleware(new Request('https://site.example/api/future'))).status, 401);
  for (const reason of ['not_invited', 'revoked', 'unconfigured', 'identity_conflict']) {
    const denied = fixture({ identity: { userId: 'visitor' }, allowed: false, isOwner: false, reason });
    const response = await denied.middleware(new Request('https://site.example/api/data/backup'));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('x-middleware-next'), null);
    assert.equal((await response.json() as { code: string }).code, 'ACCOUNT_NOT_ALLOWED');
  }
});

void test('authorized session reads permit identity verification while stale writes and reads are blocked', async () => {
  const app = fixture({ identity: { userId: 'bob' }, allowed: true, isOwner: false });
  const write = (owner?: string) => new Request('https://site.example/api/finance/accounts', { method: 'POST', headers: owner ? { 'X-Page-Owner': owner } : {} });
  assert.equal((await app.middleware(write())).status, 401);
  assert.equal((await app.middleware(write('alice'))).status, 401);
  const accepted = await app.middleware(write('bob'));
  assert.equal(accepted.headers.get('x-middleware-next'), '1');
  assert.equal(accepted.headers.get('X-Account-Owner'), 'bob');
  assert.equal((await app.middleware(new Request('https://site.example/api/health', { headers: { 'X-Page-Owner': 'alice' } }))).status, 401);
  assert.equal((await app.middleware(new Request('https://site.example/api/session', { headers: { 'X-Page-Owner': 'alice' } }))).headers.get('x-middleware-next'), '1');
  assert.equal((await app.middleware(new Request('https://site.example/api/session', { method: 'POST' }))).status, 401);
});
