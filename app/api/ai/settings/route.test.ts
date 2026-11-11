import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { runInThisContext } from 'node:vm';
import test, { type TestContext } from 'node:test';
import * as settingsRules from '../../../../lib/ai-settings.ts';
import * as settingsCrypto from '../../../../lib/ai-settings-crypto.ts';
import * as settingsStore from '../../../../db/ai-settings-store.ts';
import * as usageStore from '../../../../db/ai-usage-store.ts';
import * as provider from '../../../../lib/ai-provider.ts';

const ORIGIN = 'https://synthetic-ai-settings.example';
const KEY_A = 'synthetic-minimax-key-alice';
const KEY_B = 'synthetic-minimax-key-bob';
const MASTER = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64');
const PROVIDER_TEXT = 'synthetic-private-provider-text';

function loadExports(path: URL, bindings: Record<string, unknown>): Record<string, unknown> {
  const original = readFileSync(path, 'utf8');
  const exported = [...original.matchAll(/^export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/gm)].map((match) => match[1]);
  const source = stripTypeScriptTypes(original, { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  const factory = runInThisContext('(function(' + Object.keys(bindings).join(',') + '){' + source + '\nreturn {' + exported.join(',') + '};})') as (...values: unknown[]) => Record<string, unknown>;
  return factory(...Object.values(bindings));
}

interface LocalStatement {
  bind(...values: unknown[]): LocalStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: unknown[]; meta: { changes: number } }>;
  execute(): { results: unknown[]; meta: { changes: number } };
}
interface SettingsResponse {
  settings: settingsStore.AISettingsMetadata;
  storageReady: boolean;
  message: string;
}
interface ErrorResponse { error: string; code: string }
const data = async (response: Response) => await response.json() as SettingsResponse;
const failure = async (response: Response) => await response.json() as ErrorResponse;

async function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../../../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  t.after(() => sqlite.close());
  const queries: string[] = [];
  let storageError: Error | null = null;
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      if (storageError) throw storageError;
      const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound: LocalStatement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (bound.execute().results[0] as T | undefined) ?? null; },
        async all<T>() { return { results: bound.execute().results as T[] }; },
        async run() { return bound.execute(); },
        execute() {
          const before = Number(sqlite.prepare('SELECT total_changes() AS total').get()?.total);
          const results = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
          return { results, meta: { changes: Number(sqlite.prepare('SELECT total_changes() AS total').get()?.total) - before } };
        },
      };
      return bound;
    },
  } as unknown as D1Database;
  const env: { DB?: D1Database; AI_SETTINGS_ENCRYPTION_KEY?: string; MINIMAX_API_KEY?: string } = {
    DB: db, AI_SETTINGS_ENCRYPTION_KEY: MASTER, MINIMAX_API_KEY: 'synthetic-global-key-must-not-be-used',
  };
  let owner: string | null = 'alice';
  let providerStatus = 200;
  let providerError: Error | null = null;
  let providerHook: (() => Promise<void>) | null = null;
  let quotaHook: (() => Promise<void>) | null = null;
  const quotaNow = Math.floor(Date.now() / 60000) * 60000 + 1000;
  class RequestDate extends Date { static now() { return quotaNow; } }
  const calls: Array<{ configuration: provider.AIConfiguration; input: { question: string; context: unknown } }> = [];
  const outgoing: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const callHealthAssistant = async (configuration: provider.AIConfiguration, input: { question: string; context: unknown }) => {
    calls.push({ configuration, input: structuredClone(input) });
    await providerHook?.();
    if (providerError) throw providerError;
    return provider.callHealthAssistant(configuration, input, { fetch: async (url, options) => {
      outgoing.push({ url: String(url), authorization: new Headers(options?.headers).get('Authorization'), body: JSON.parse(String(options?.body)) as Record<string, unknown> });
      return Response.json(providerStatus === 200
        ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: PROVIDER_TEXT } }] }
        : { error: { message: KEY_A + ':' + PROVIDER_TEXT } }, { status: providerStatus });
    } });
  };
  const consumeAIQuota = async (database: D1Database, userId: string, now: number) => {
    const result = await usageStore.consumeAIQuota(database, userId, now);
    await quotaHook?.();
    return result;
  };
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), { getChatGPTUser: async () => owner ? { userId: owner } : null });
  const bindings = { ...shared, ...settingsRules, ...settingsCrypto, ...settingsStore, ...usageStore, ...provider, callHealthAssistant, consumeAIQuota, env, Date: RequestDate };
  const settingsShared = loadExports(new URL('./_shared.ts', import.meta.url), bindings);
  const route = loadExports(new URL('./route.ts', import.meta.url), { ...bindings, ...settingsShared }) as {
    GET(): Promise<Response>; PUT(request: Request): Promise<Response>; DELETE(request: Request): Promise<Response>;
  };
  const testRoute = loadExports(new URL('./test/route.ts', import.meta.url), { ...bindings, ...settingsShared }) as { POST(request: Request): Promise<Response> };
  function request(method: string, body?: unknown, options: { origin?: string | null; contentType?: string | null; raw?: boolean } = {}) {
    const headers = new Headers();
    if (options.contentType !== null) headers.set('Content-Type', options.contentType ?? 'application/json');
    if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
    return new Request(ORIGIN + '/api/ai/settings' + (method === 'POST' ? '/test' : ''), {
      method, headers, ...(body === undefined ? {} : { body: options.raw ? String(body) : JSON.stringify(body) }),
    });
  }
  return {
    sqlite, db, env, queries, calls, outgoing,
    signIn(userId: string | null) { owner = userId; },
    read() { return route.GET(); },
    save(body: unknown, options: Parameters<typeof request>[2] = {}) { return route.PUT(request('PUT', body, options)); },
    clear(body: unknown, options: Parameters<typeof request>[2] = {}) { return route.DELETE(request('DELETE', body, options)); },
    testConnection(body: unknown, options: Parameters<typeof request>[2] = {}) { return testRoute.POST(request('POST', body, options)); },
    failProvider(error: Error | null) { providerError = error; },
    providerResponse(status: number) { providerStatus = status; },
    beforeProvider(action: () => Promise<void>) { providerHook = action; },
    afterQuota(action: () => Promise<void>) { quotaHook = action; },
    failStorage(error: Error | null) { storageError = error; },
    async resolve(userId = owner!) { return settingsStore.resolveUserAIConfiguration(db, userId, env.AI_SETTINGS_ENCRYPTION_KEY); },
  };
}

const input = (patch: Record<string, unknown> = {}) => ({ apiKey: KEY_A, model: 'MiniMax-M3', region: 'cn', expectedRevision: 0, ...patch });
const consent = (expectedRevision: number) => ({ expectedRevision, consent: true });

void test('settings endpoints require authentication and same-origin JSON before reading or mutating storage', async (t) => {
  const f = await fixture(t); f.signIn(null);
  for (const response of [await f.read(), await f.save(input()), await f.clear({ expectedRevision: 0 }), await f.testConnection(consent(0))]) {
    assert.equal(response.status, 401); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(f.queries, []); assert.deepEqual(f.calls, []); f.signIn('alice');
  for (const mutate of [f.save, f.clear, f.testConnection]) {
    assert.equal((await mutate(input(), { origin: 'https://foreign.example' })).status, 403);
    assert.equal((await mutate(input(), { origin: null })).status, 403);
    assert.equal((await mutate(input(), { contentType: 'text/plain' })).status, 415);
    assert.equal((await mutate(input(), { contentType: null })).status, 415);
  }
  assert.deepEqual(f.queries, []); assert.deepEqual(f.calls, []);
});

void test('strict settings bodies and explicit test consent fail before any SQL or provider work', async (t) => {
  const f = await fixture(t);
  for (const body of [null, [], {}, input({ model: '' }), input({ region: 'other' }), input({ apiKey: 42 }), input({ apiKey: 'embedded\nkey' }), input({ expectedRevision: -1 }), input({ expectedRevision: '0' }), input({ consent: true }), input({ ownerId: 'bob' })]) {
    assert.equal((await f.save(body)).status, 400);
  }
  assert.equal((await f.save('{', { raw: true })).status, 400);
  assert.equal((await f.save(' '.repeat(8193), { raw: true })).status, 413);
  for (const body of [{ expectedRevision: 0 }, { expectedRevision: 0, consent: false }, { expectedRevision: 0, consent: 'true' }, { expectedRevision: 0, consent: true, question: 'private question' }, { consent: true }]) {
    assert.equal((await f.testConnection(body)).status, 400);
  }
  assert.equal((await f.clear({ expectedRevision: 0, apiKey: KEY_A })).status, 400);
  assert.deepEqual(f.queries, []); assert.deepEqual(f.calls, []);
});

void test('saving and GET expose metadata only while the real database contains encrypted credentials', async (t) => {
  const f = await fixture(t); const empty = await data(await f.read());
  assert.equal(empty.settings.configured, false); assert.equal(empty.settings.revision, 0); assert.equal(empty.storageReady, true);
  const savedResponse = await f.save(input()); assert.equal(savedResponse.status, 200);
  const saved = await data(savedResponse); assert.equal(saved.settings.configured, true); assert.equal(saved.settings.revision, 1); assert.equal(saved.settings.lastTestStatus, null);
  const row = f.sqlite.prepare('SELECT * FROM ai_user_settings WHERE user_id=?').get('alice')!;
  assert.equal(typeof row.key_ciphertext, 'string'); assert.equal(typeof row.key_iv, 'string'); assert.notEqual(row.key_ciphertext, KEY_A);
  assert.equal(JSON.stringify(row).includes(KEY_A), false); assert.equal(JSON.stringify(row).includes(MASTER), false);
  const readResponse = await f.read(); assert.equal(readResponse.headers.get('Cache-Control'), 'no-store');
  const read = await data(readResponse); assert.deepEqual(read.settings, saved.settings);
  assert.deepEqual(Object.keys(read.settings).sort(), ['configured', 'model', 'region', 'revision', 'updatedAt', 'lastTestStatus', 'lastTestAt'].sort());
  const publicText = JSON.stringify([saved, read]);
  for (const hidden of [KEY_A, MASTER, String(row.key_ciphertext), String(row.key_iv), 'key_ciphertext', 'keyCiphertext', 'keyIv', 'apiKey']) assert.equal(publicText.includes(hidden), false);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.outgoing, []);
  assert.equal((await f.resolve()).ready, true);
});

void test('blank keys preserve the saved secret while changed model and region are immediately effective', async (t) => {
  const f = await fixture(t); await f.save(input());
  const response = await f.save(input({ apiKey: '   ', model: 'MiniMax-M3.1-flash', region: 'global', expectedRevision: 1 }));
  assert.equal(response.status, 200); const updated = await data(response);
  assert.equal(updated.settings.revision, 2); assert.equal(updated.settings.model, 'MiniMax-M3.1-flash'); assert.equal(updated.settings.region, 'global');
  assert.equal(updated.settings.lastTestStatus, null); assert.equal((await f.resolve()).ready, true);
  assert.equal((await f.testConnection(consent(2))).status, 200);
  assert.equal(f.outgoing[0].url, 'https://api.minimax.io/v1/chat/completions');
  assert.equal(f.outgoing[0].authorization, 'Bearer ' + KEY_A); assert.equal(f.outgoing[0].body.model, 'MiniMax-M3.1-flash');
  const keep = input({ expectedRevision: 2, model: 'MiniMax-M3', region: 'cn' }); delete (keep as Partial<typeof keep>).apiKey;
  assert.equal((await f.save(keep)).status, 200); assert.equal((await data(await f.read())).settings.revision, 3);
  const fresh = await fixture(t); assert.equal((await fresh.save(input({ apiKey: '' }))).status, 400); assert.equal((await fresh.resolve()).ready, false);
});

void test('encrypted settings and test connections stay isolated to the authenticated user', async (t) => {
  const f = await fixture(t); await f.save(input()); f.signIn('bob');
  assert.equal((await data(await f.read())).settings.configured, false);
  assert.equal((await f.resolve()).ready, false);
  assert.equal((await f.testConnection(consent(0))).status, 400); assert.equal(f.calls.length, 0);
  assert.equal((await f.save(input({ apiKey: KEY_B, region: 'global' }))).status, 200);
  assert.equal((await f.testConnection(consent(1))).status, 200);
  assert.equal(f.outgoing[0].authorization, 'Bearer ' + KEY_B);
  f.signIn('alice'); assert.equal((await data(await f.read())).settings.region, 'cn');
  assert.equal((await f.testConnection(consent(1))).status, 200); assert.equal(f.outgoing[1].authorization, 'Bearer ' + KEY_A);
  assert.equal((await f.clear({ expectedRevision: 1 })).status, 200); assert.equal((await f.resolve()).ready, false);
  f.signIn('bob'); assert.equal((await f.resolve()).ready, true); assert.equal((await data(await f.read())).settings.configured, true);
});

void test('revision conflicts and clear tombstones prevent stale saves from resurrecting a removed secret', async (t) => {
  const f = await fixture(t); await f.save(input());
  assert.equal((await f.save(input())).status, 409);
  assert.equal((await f.clear({ expectedRevision: 0 })).status, 409);
  const staleSave = f.save(input({ apiKey: KEY_B, expectedRevision: 1 }));
  const clearedResponse = await f.clear({ expectedRevision: 1 }); assert.equal(clearedResponse.status, 200);
  assert.equal((await staleSave).status, 409);
  const cleared = await data(await f.read()); assert.equal(cleared.settings.configured, false); assert.equal(cleared.settings.revision, 2);
  const row = f.sqlite.prepare('SELECT key_ciphertext, key_iv FROM ai_user_settings WHERE user_id=?').get('alice')!;
  assert.equal(row.key_ciphertext, null); assert.equal(row.key_iv, null);
  assert.equal((await f.save(input())).status, 409); assert.equal((await f.resolve()).ready, false);
  assert.equal((await f.testConnection(consent(1))).status, 409); assert.equal((await f.testConnection(consent(2))).status, 400); assert.equal(f.calls.length, 0);
  f.signIn('bob'); assert.equal((await f.clear({ expectedRevision: 0 })).status, 200);
  assert.equal((await f.save(input({ apiKey: KEY_B }))).status, 409);
});

void test('a missing or invalid encryption master disables saving and testing but still permits deletion', async (t) => {
  const f = await fixture(t); await f.save(input()); delete f.env.AI_SETTINGS_ENCRYPTION_KEY;
  const initialQueries = f.queries.length;
  assert.equal((await f.save(input({ expectedRevision: 1 }))).status, 503);
  assert.equal((await f.testConnection(consent(1))).status, 503);
  assert.equal(f.queries.length, initialQueries); assert.equal(f.calls.length, 0);
  const publicState = await data(await f.read()); assert.equal(publicState.storageReady, false); assert.equal(publicState.settings.configured, true);
  assert.equal((await f.clear({ expectedRevision: 1 })).status, 200);
  const cleared = await data(await f.read()); assert.equal(cleared.settings.configured, false); assert.equal(cleared.settings.revision, 2); assert.equal(cleared.storageReady, false);
  f.env.AI_SETTINGS_ENCRYPTION_KEY = 'not-a-valid-master';
  assert.equal((await f.save(input({ expectedRevision: 2 }))).status, 503); assert.equal((await f.testConnection(consent(2))).status, 503);
});

void test('connection tests send only fixed synthetic input and bind success or failure to the requested revision', async (t) => {
  const f = await fixture(t); await f.save(input());
  const stale = await f.testConnection(consent(0)); assert.equal(stale.status, 409); assert.equal(f.calls.length, 0);
  const testedResponse = await f.testConnection(consent(1)); assert.equal(testedResponse.status, 200);
  const tested = await data(testedResponse); assert.equal(tested.settings.revision, 1); assert.equal(tested.settings.lastTestStatus, 'success'); assert.ok(tested.settings.lastTestAt);
  assert.deepEqual(f.calls[0].input, { question: '这是不含个人信息的连接测试。请只回复：连接正常。', context: { purpose: 'connection-test', data: 'synthetic', health: [], nutrition: [] } });
  assert.equal(JSON.stringify(tested).includes(PROVIDER_TEXT), false);
  assert.ok(f.queries.every((query) => !/\b(?:health_measurements|nutrition_entries|finance_accounts)\b/.test(query)));
  f.providerResponse(401); const rejectedResponse = await f.testConnection(consent(1)); assert.equal(rejectedResponse.status, 503);
  const rejected = await failure(rejectedResponse); assert.equal(rejected.code, 'AI_AUTH_FAILED');
  assert.equal(JSON.stringify(rejected).includes(KEY_A), false); assert.equal(JSON.stringify(rejected).includes(PROVIDER_TEXT), false);
  assert.equal((await data(await f.read())).settings.lastTestStatus, 'failed');
});

void test('connection tests share the atomic quota and never send a fourth request in one minute', async (t) => {
  const f = await fixture(t); await f.save(input());
  // Freeze only the route's request clock to avoid a wall-clock minute rollover;
  // the quota still executes its real SQL against the same SQLite database.
  for (let index = 0; index < 3; index++) assert.equal((await f.testConnection(consent(1))).status, 200);
  const response = await f.testConnection(consent(1)); assert.equal(response.status, 429);
  const retryAfter = Number(response.headers.get('Retry-After')); assert.ok(retryAfter >= 1 && retryAfter <= 60);
  assert.equal((await failure(response)).code, 'AI_RATE_LIMITED'); assert.equal(f.calls.length, 3); assert.equal(f.outgoing.length, 3);
  assert.equal(f.sqlite.prepare('SELECT day_count FROM ai_usage_limits WHERE user_id=?').get('alice')?.day_count, 3);
});

void test('an in-flight provider result cannot mark a newer saved configuration as tested', async (t) => {
  for (const failed of [false, true]) {
    const f = await fixture(t); await f.save(input());
    f.beforeProvider(async () => {
      const changed = await f.save(input({ apiKey: KEY_B, model: 'MiniMax-M3.1-flash', expectedRevision: 1 })); assert.equal(changed.status, 200);
    });
    if (failed) f.failProvider(new Error(PROVIDER_TEXT));
    assert.equal((await f.testConnection(consent(1))).status, 409);
    const settings = (await data(await f.read())).settings;
    assert.equal(settings.revision, 2); assert.equal(settings.model, 'MiniMax-M3.1-flash'); assert.equal(settings.lastTestStatus, null); assert.equal(settings.lastTestAt, null);
  }
});

void test('clearing or replacing a key while quota is pending prevents any provider request with the captured configuration', async (t) => {
  for (const change of ['clear', 'save']) {
    const f = await fixture(t); await f.save(input());
    f.afterQuota(async () => {
      const changed = change === 'clear'
        ? await f.clear({ expectedRevision: 1 })
        : await f.save(input({ apiKey: KEY_B, model: 'MiniMax-M3.1-flash', expectedRevision: 1 }));
      assert.equal(changed.status, 200);
    });
    const response = await f.testConnection(consent(1));
    assert.equal(response.status, 409); assert.equal((await failure(response)).code, 'AI_SETTINGS_CONFLICT');
    assert.equal(f.calls.length, 0); assert.equal(f.outgoing.length, 0);
    const settings = (await data(await f.read())).settings;
    assert.equal(settings.revision, 2); assert.equal(settings.configured, change === 'save');
    assert.equal(settings.lastTestStatus, null); assert.equal(settings.lastTestAt, null);
    assert.equal(f.sqlite.prepare('SELECT day_count FROM ai_usage_limits WHERE user_id=?').get('alice')?.day_count, 1);
  }
});

void test('unknown provider and storage failures never reflect input, credentials or underlying error text', async (t) => {
  const f = await fixture(t); await f.save(input()); f.failProvider(new Error(KEY_A + ':' + PROVIDER_TEXT));
  const result = await f.testConnection(consent(1)); assert.equal(result.status, 503);
  const providerFailure = await failure(result); assert.equal(providerFailure.code, 'AI_SETTINGS_UNAVAILABLE');
  assert.equal(JSON.stringify(providerFailure).includes(KEY_A), false); assert.equal(JSON.stringify(providerFailure).includes(PROVIDER_TEXT), false);
  assert.equal((await data(await f.read())).settings.lastTestStatus, 'failed');
  f.failStorage(new Error(KEY_B + ':' + PROVIDER_TEXT));
  for (const response of [await f.read(), await f.save(input({ apiKey: KEY_B, expectedRevision: 1 })), await f.clear({ expectedRevision: 1 })]) {
    assert.equal(response.status, 503); const body = await failure(response); assert.equal(body.code, 'AI_SETTINGS_UNAVAILABLE');
    for (const secret of [KEY_A, KEY_B, PROVIDER_TEXT]) assert.equal(JSON.stringify(body).includes(secret), false);
  }
});
