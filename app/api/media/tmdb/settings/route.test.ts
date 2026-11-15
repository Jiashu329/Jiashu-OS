import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { runInThisContext } from 'node:vm';
import test, { type TestContext } from 'node:test';
import * as rules from '../../../../../lib/tmdb-settings.ts';
import * as cryptoRules from '../../../../../lib/tmdb-settings-crypto.ts';
import * as store from '../../../../../db/tmdb-settings-store.ts';
import * as provider from '../../../../../lib/tmdb-provider.ts';
const ORIGIN = 'https://synthetic-tmdb-settings.example', TOKEN = 'synthetic-private-tmdb-token';
const MASTER = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
function load(path: URL, bindings: Record<string, unknown>): Record<string, unknown> {
  const original = readFileSync(path, 'utf8'), exported = [...original.matchAll(/^export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/gm)].map(m => m[1]);
  const source = stripTypeScriptTypes(original, { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const factory = runInThisContext('(function(' + Object.keys(bindings).join(',') + '){' + source + '\nreturn {' + exported.join(',') + '};})') as (...values: unknown[]) => Record<string, unknown>;
  return factory(...Object.values(bindings));
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'), migrations = new URL('../../../../../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  t.after(() => sqlite.close());
  const queries: string[] = [], calls: string[] = [];
  let storageError = false, providerError: Error | null = null, hook: (() => Promise<void>) | null = null;
  const db = { prepare(sql: string) { queries.push(sql); if (storageError) throw new Error(TOKEN); const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const bound = { bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; }, async first<T>() { return (statement.get(...values) as T | undefined) ?? null; } }; return bound;
  } } as unknown as D1Database;
  const env: { DB?: D1Database; APP_OWNER_USER_ID?: string; AI_SETTINGS_ENCRYPTION_KEY?: string } = { DB: db, APP_OWNER_USER_ID: 'owner', AI_SETTINGS_ENCRYPTION_KEY: MASTER };
  let actor: string | null = 'owner', isOwner = true;
  const shared = load(new URL('../../../_shared.ts', import.meta.url), { getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => actor ? { userId: actor, isOwner } : null });
  const bindings = { ...shared, ...rules, ...cryptoRules, ...store, ...provider, env, checkTMDBToken: async (token: string) => { calls.push(token); await hook?.(); if (providerError) throw providerError; } };
  const settingsShared = load(new URL('./_shared.ts', import.meta.url), bindings);
  const route = load(new URL('./route.ts', import.meta.url), { ...bindings, ...settingsShared }) as { GET(): Promise<Response>; PUT(r: Request): Promise<Response>; DELETE(r: Request): Promise<Response> };
  const testRoute = load(new URL('./test/route.ts', import.meta.url), { ...bindings, ...settingsShared }) as { POST(r: Request): Promise<Response> };
  function request(method: string, body: unknown, options: { origin?: string; owner?: string; type?: string; raw?: boolean } = {}) {
    return new Request(ORIGIN + '/api/media/tmdb/settings', { method, headers: { Origin: options.origin ?? ORIGIN, 'Content-Type': options.type ?? 'application/json', 'X-Page-Owner': options.owner ?? actor ?? '' }, body: options.raw ? String(body) : JSON.stringify(body) });
  }
  return { env, db, sqlite, queries, calls, read: () => route.GET(), save: (body: unknown, options?: Parameters<typeof request>[2]) => route.PUT(request('PUT', body, options)),
    clear: (revision: number) => route.DELETE(request('DELETE', { expectedRevision: revision })), test: (revision: number) => testRoute.POST(request('POST', { expectedRevision: revision })),
    actor(id: string | null, role = id === 'owner') { actor = id; isOwner = role; }, failStorage() { storageError = true; }, failProvider(error: Error) { providerError = error; }, providerHook(next: () => Promise<void>) { hook = next; } };
}
test('only the established owner can mutate; members read shared state and cannot trigger provider calls', async t => {
  const f = fixture(t); f.actor(null); assert.equal((await f.read()).status, 401);
  f.actor('member'); assert.equal((await f.save({ token: TOKEN, expectedRevision: 0 })).status, 403); assert.equal(f.queries.length, 0);
  f.actor('owner', false); assert.equal((await f.save({ token: TOKEN, expectedRevision: 0 })).status, 403);
  f.actor('owner'); assert.equal((await f.save({ token: TOKEN, expectedRevision: 0 })).status, 200);
  f.actor('member'); const response = await f.read(), data = await response.json() as { settings: { configured: boolean }; canManage: boolean };
  assert.equal(data.settings.configured, true); assert.equal(data.canManage, false); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await f.test(1)).status, 403); assert.equal(f.calls.length, 0); assert.ok(!JSON.stringify(data).includes(TOKEN));
  f.actor('owner'); f.env.APP_OWNER_USER_ID = 'different-owner'; assert.equal((await f.save({ token: TOKEN, expectedRevision: 1 })).status, 403);
});
test('same origin, account pin, JSON, body bounds and encryption guards reject before saving', async t => {
  const f = fixture(t), body = { token: TOKEN, expectedRevision: 0 };
  for (const [options, status] of [[{ origin: 'https://attacker.example' }, 403], [{ owner: 'other-account' }, 401], [{ type: 'text/plain' }, 415]] as const) assert.equal((await f.save(body, options)).status, status);
  assert.equal(f.queries.length, 0);
  assert.equal((await f.save('x'.repeat(9000), { raw: true })).status, 413);
  assert.equal((await f.save(TOKEN, { raw: true })).status, 400);
  f.env.AI_SETTINGS_ENCRYPTION_KEY = undefined; assert.equal((await f.save(body)).status, 503); assert.equal((await f.test(0)).status, 503);
  assert.equal((await f.clear(0)).status, 200);
});
test('CAS and explicit tests use the saved secret without returning it; deletion works when encryption is unavailable', async t => {
  const f = fixture(t); assert.equal((await f.test(0)).status, 400);
  const saved = await f.save({ token: TOKEN, expectedRevision: 0 }); assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(TOKEN));
  assert.equal((await f.save({ token: 'replacement', expectedRevision: 0 })).status, 409);
  assert.equal((await f.test(1)).status, 200); assert.deepEqual(f.calls, [TOKEN]);
  const metadata = await (await f.read()).json() as { settings: { lastTestStatus: string } }; assert.equal(metadata.settings.lastTestStatus, 'success');
  f.env.AI_SETTINGS_ENCRYPTION_KEY = undefined; assert.equal((await f.clear(1)).status, 200);
  assert.equal((await f.save({ token: TOKEN, expectedRevision: 1 })).status, 503);
});
test('raw storage/upstream errors are sanitized and stale test cannot mark a replaced Token successful', async t => {
  const f = fixture(t); await f.save({ token: TOKEN, expectedRevision: 0 });
  f.providerHook(async () => { await store.saveTMDBSettings(f.db, 'owner', { token: 'synthetic-new-token', expectedRevision: 1 }, MASTER); });
  assert.equal((await f.test(1)).status, 409);
  const metadata = await (await f.read()).json() as { settings: { lastTestStatus: string | null } }; assert.equal(metadata.settings.lastTestStatus, null);
  f.failStorage(); const failed = await f.read(); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes(TOKEN));
  const g = fixture(t); await g.save({ token: TOKEN, expectedRevision: 0 }); g.failProvider(new Error(TOKEN));
  const upstream = await g.test(1); assert.equal(upstream.status, 503); assert.ok(!(await upstream.text()).includes(TOKEN));
});
