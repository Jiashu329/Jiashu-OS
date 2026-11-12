import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import test from 'node:test';

function route(userId: string | null, read: (userId: string) => Promise<unknown>) {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  const bindings = {
    apiUser: async () => userId === null ? null : { userId }, readSyncStatus: read, json,
    unauthenticated: () => json({ code: 'SIGN_IN_REQUIRED' }, 401),
    unavailable: () => json({ code: 'HEALTH_STORAGE_UNAVAILABLE' }, 503),
  };
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn GET;', Object.keys(bindings))(...Object.values(bindings)) as () => Promise<Response>;
}

void test('sync status rejects signed-out callers before touching private storage', async () => {
  const response = await route(null, async () => { assert.fail('private store must not be read'); })();
  assert.equal(response.status, 401);
});

void test('sync status is scoped to the authenticated owner and unavailable data is not presented as empty', async () => {
  const value = { today: '2026-11-12', metrics: [], lastImport: null };
  const response = await route('alice', async (userId) => { assert.equal(userId, 'alice'); return value; })();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), value);
  const failure = await route('alice', async () => { throw new Error('synthetic unavailable'); })();
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { code: 'HEALTH_STORAGE_UNAVAILABLE' });
});
