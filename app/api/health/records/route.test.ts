import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import * as health from '../../../../lib/health.ts';
import * as composition from '../../../../lib/body-composition.ts';
import * as recordRules from '../../../../lib/health-records.ts';
import * as recordStore from '../../../../db/health-records-store.ts';

const ORIGIN = 'https://synthetic-health-records.example';
const CAPTURED = new Date().toISOString();
const TODAY = health.shanghaiDay(CAPTURED);
const YESTERDAY = new Date(Date.parse(TODAY + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const FIRST_EXPORT = new Date(Date.parse(CAPTURED) - 10000).toISOString();
const NEW_EXPORT = new Date(Date.parse(CAPTURED) - 5000).toISOString();
type RecordView = NonNullable<Awaited<ReturnType<typeof recordStore.readHealthRecord>>>;
interface MutationResponse { record: RecordView; replayed: boolean; changeId: string }
interface RecordResponse { record: RecordView }
interface ListResponse { records: RecordView[]; hasMore: boolean; nextCursor: string | null; today: string }
interface HistoryResponse { history: Awaited<ReturnType<typeof recordStore.readHealthRecordHistory>> }
interface ApiError { code: string; error: string }
async function readMutation(response: Response): Promise<MutationResponse> { return await response.json() as MutationResponse; }
async function readRecord(response: Response): Promise<RecordView> { return (await response.json() as RecordResponse).record; }
async function readList(response: Response): Promise<ListResponse> { return await response.json() as ListResponse; }
async function readHistory(response: Response): Promise<HistoryResponse> { return await response.json() as HistoryResponse; }
async function readError(response: Response): Promise<ApiError> { return await response.json() as ApiError; }
function value(record: RecordView): number { assert.ok(record.effective); return record.effective.value; }
function cas(record: RecordView) { return { expectedRevision: record.revision, expectedBaseExportedAt: record.base?.exportedAt ?? null }; }

function loadExports(path: URL, bindings: Record<string, unknown>, names?: string[]): Record<string, unknown> {
  const original = readFileSync(path, 'utf8');
  const exported = names ?? [...original.matchAll(/^export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/gm)].map((match) => match[1]);
  const source = stripTypeScriptTypes(original, { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + exported.join(',') + '};')(...Object.values(bindings));
}
interface LocalStatement {
  bind(...values: unknown[]): LocalStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: unknown[]; meta: { changes: number } }>;
  execute(): { results: unknown[]; meta: { changes: number } };
}
async function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../../../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  t.after(() => sqlite.close());
  const queries: string[] = [];
  const adapter = {
    prepare(sql: string) {
      queries.push(sql); const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
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
    async batch(statements: LocalStatement[]) {
      sqlite.exec('BEGIN');
      try { const results = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const db = adapter as unknown as D1Database;
  const env: { DB?: D1Database } = { DB: db }; let owner: string | null = 'alice';
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), { getChatGPTUser: async () => owner ? { userId: owner } : null });
  const repository = loadExports(new URL('../../../../db/health-repository.ts', import.meta.url), { env, ...health, ...composition, ...recordStore }, ['importHealth', 'readHealth', 'readHealthRange']);
  let bindings = { ...shared, ...repository, ...health, ...recordRules, ...recordStore, env };
  const recordsSharedPath = new URL('./_shared.ts', import.meta.url);
  if (existsSync(recordsSharedPath)) bindings = { ...bindings, ...loadExports(recordsSharedPath, bindings) };
  const route = loadExports(new URL('./route.ts', import.meta.url), bindings) as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> };
  const itemRoute = loadExports(new URL('./[key]/route.ts', import.meta.url), bindings) as {
    GET(request: Request, context: { params: Promise<{ key: string }> }): Promise<Response>;
    PATCH(request: Request, context: { params: Promise<{ key: string }> }): Promise<Response>;
  };
  const historyRoute = loadExports(new URL('./[key]/history/route.ts', import.meta.url), bindings) as { GET(request: Request, context: { params: Promise<{ key: string }> }): Promise<Response> };
  function request(method: string, path: string, body?: unknown, options: { key?: string | null; origin?: string | null; contentType?: string; raw?: boolean } = {}) {
    const headers = new Headers({ 'Content-Type': options.contentType ?? 'application/json' });
    if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
    if (method !== 'GET' && options.key !== null) headers.set('Idempotency-Key', options.key ?? crypto.randomUUID());
    return new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: options.raw ? String(body) : JSON.stringify(body) }) });
  }
  async function sync(userId: string, measurements: health.HealthMeasurement[], exportedAt = FIRST_EXPORT) {
    const payload = health.parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt, measurements });
    return (repository.importHealth as (userId: string, payload: health.HealthSyncPayload) => Promise<unknown>)(userId, payload);
  }
  return {
    db, env, queries, sync,
    signIn(userId: string | null) { owner = userId; },
    list(query = '') { return route.GET(request('GET', '/api/health/records?from=' + YESTERDAY + '&to=' + TODAY + (query ? '&' + query : ''))); },
    get(key: string) { return itemRoute.GET(request('GET', '/api/health/records/' + encodeURIComponent(key)), { params: Promise.resolve({ key }) }); },
    history(key: string) { return historyRoute.GET(request('GET', '/api/health/records/' + encodeURIComponent(key) + '/history'), { params: Promise.resolve({ key }) }); },
    create(body: unknown, options: Parameters<typeof request>[3] = {}) { return route.POST(request('POST', '/api/health/records', body, options)); },
    patch(key: string, body: unknown, options: Parameters<typeof request>[3] = {}) { return itemRoute.PATCH(request('PATCH', '/api/health/records/' + encodeURIComponent(key), body, options), { params: Promise.resolve({ key }) }); },
  };
}
const manual = (patch: Record<string, unknown> = {}) => ({ metric: 'steps', value: 0, date: TODAY, capturedAt: CAPTURED, reason: 'synthetic manual record', ...patch });
function steps(value: number): health.HealthMeasurement {
  return { id: 'synthetic-synced-steps', metric: 'steps', value, unit: 'count', source: 'synthetic-phone', aggregation: 'daily', startDate: YESTERDAY + 'T00:00:00+08:00', endDate: YESTERDAY + 'T23:59:00+08:00' };
}

test('record endpoints require sign-in, same-origin JSON and a valid mutation identifier', async (t) => {
  const f = await fixture(t); f.signIn(null);
  for (const response of [await f.list(), await f.create(manual()), await f.get('steps:' + TODAY), await f.history('steps:' + TODAY)]) { assert.equal(response.status, 401); assert.equal(response.headers.get('Cache-Control'), 'no-store'); }
  assert.deepEqual(f.queries, []); f.signIn('alice');
  assert.equal((await f.create(manual(), { origin: 'https://other.example' })).status, 403);
  assert.equal((await f.create(manual(), { origin: null })).status, 403);
  assert.equal((await f.create(manual(), { contentType: 'text/plain' })).status, 415);
  assert.equal((await f.create(manual(), { key: null })).status, 400);
  assert.equal((await f.create('{', { raw: true })).status, 400);
  assert.equal((await f.create(' '.repeat(1024 * 1024), { raw: true })).status, 413);
});

test('zero manual daily records remain zero, and even a hidden daily record prevents duplicate creation', async (t) => {
  const f = await fixture(t); const createdResponse = await f.create(manual()); assert.equal(createdResponse.status, 201); const created = (await readMutation(createdResponse)).record; assert.equal(value(created), 0);
  const duplicate = await f.create(manual({ value: 1000 })); assert.equal(duplicate.status, 409); assert.equal((await readError(duplicate)).code, 'HEALTH_RECORD_CONFLICT');
  const hidden = (await readMutation(await f.patch(created.recordKey, { action: 'hide', ...cas(created), reason: 'synthetic hide' }))).record; assert.equal(hidden.deleted, true); assert.equal((await readList(await f.list())).records.length, 0);
  assert.equal((await f.create(manual())).status, 409); const included = await readList(await f.list('includeDeleted=1')); assert.equal(included.records.length, 1); assert.equal(included.records[0].deleted, true);
  const restored = (await readMutation(await f.patch(hidden.recordKey, { action: 'restore', ...cas(hidden) }))).record; assert.equal(restored.deleted, false); assert.equal(value(restored), 0);
  assert.equal((await f.patch(restored.recordKey, { action: 'reset', ...cas(restored) })).status, 409);
  assert.equal((await readHistory(await f.history(restored.recordKey))).history.length, 3);
});

test('manual corrections take precedence over later sync, stale revisions/base tokens conflict, and reset restores the latest sync', async (t) => {
  const f = await fixture(t); await f.sync('alice', [steps(1000)]); const key = 'steps:' + YESTERDAY; const original = await readRecord(await f.get(key));
  const patchBody = { action: 'correct', value: 0, ...cas(original), reason: 'synthetic correction' }; const requestId = crypto.randomUUID(); const corrected = (await readMutation(await f.patch(key, patchBody, { key: requestId }))).record; assert.equal(value(corrected), 0);
  await f.sync('alice', [steps(3000)], NEW_EXPORT); const afterSync = await readRecord(await f.get(key)); assert.equal(value(afterSync), 0); assert.equal(afterSync.base?.measurement.value, 3000);
  assert.equal((await f.patch(key, { action: 'correct', value: 500, expectedRevision: afterSync.revision, expectedBaseExportedAt: FIRST_EXPORT })).status, 409);
  const later = (await readMutation(await f.patch(key, { action: 'correct', value: 500, ...cas(afterSync) }))).record; assert.equal(value(later), 500);
  assert.equal((await f.patch(key, { action: 'hide', ...cas(afterSync) })).status, 409);
  const replay = await readMutation(await f.patch(key, patchBody, { key: requestId })); assert.equal(replay.replayed, true); assert.equal(value(replay.record), 500);
  assert.equal((await f.patch(key, { ...patchBody, value: 1 }, { key: requestId })).status, 409);
  const reset = (await readMutation(await f.patch(key, { action: 'reset', ...cas(later) }))).record; assert.equal(value(reset), 3000); assert.equal(reset.deleted, false); assert.equal((await readHistory(await f.history(key))).history.length, 3);
});

test('creation receipts replay after later edits without reverting the effective measurement', async (t) => {
  const f = await fixture(t); const requestId = crypto.randomUUID(); const body = manual({ metric: 'weight', value: 70, date: YESTERDAY, time: '07:30' });
  const created = (await readMutation(await f.create(body, { key: requestId }))).record;
  const edited = (await readMutation(await f.patch(created.recordKey, { action: 'correct', value: 71, ...cas(created) }))).record; assert.equal(value(edited), 71);
  const response = await f.create(body, { key: requestId }); assert.equal(response.status, 201); const replay = await readMutation(response); assert.equal(replay.replayed, true); assert.equal(value(replay.record), 71);
  assert.equal((await f.create({ ...body, value: 72 }, { key: requestId })).status, 409); assert.equal((await readHistory(await f.history(created.recordKey))).history.length, 2);
});

test('record data, mutations and history remain isolated to the signed-in owner', async (t) => {
  const f = await fixture(t); const alice = (await readMutation(await f.create(manual({ metric: 'weight', value: 70, date: YESTERDAY, time: '07:30' })))).record;
  f.signIn('bob'); assert.equal((await f.get(alice.recordKey)).status, 404); assert.equal((await f.history(alice.recordKey)).status, 404); assert.equal((await f.patch(alice.recordKey, { action: 'correct', value: 72, ...cas(alice) })).status, 404); assert.equal((await readList(await f.list())).records.length, 0);
  const bob = (await readMutation(await f.create(manual({ metric: 'weight', value: 60, date: YESTERDAY, time: '07:30' })))).record; assert.equal(value(bob), 60); f.signIn('alice'); assert.equal(value(await readRecord(await f.get(alice.recordKey))), 70); assert.equal((await readHistory(await f.history(alice.recordKey))).history.length, 1);
});

test('invalid values, missing sample times and forged concurrency tokens never change a record', async (t) => {
  const f = await fixture(t);
  for (const body of [manual({ value: -1 }), manual({ value: 0.5 }), manual({ value: '1000' }), manual({ date: '2026-02-30' }), manual({ metric: 'weight', value: 70, date: YESTERDAY }), manual({ metric: 'lean_body_mass', value: 0, date: YESTERDAY, time: '07:30' }), manual({ capturedAt: 'invalid' })]) assert.equal((await f.create(body)).status, 400, JSON.stringify(body));
  const created = (await readMutation(await f.create(manual()))).record;
  for (const patch of [{ action: 'correct', value: -1, ...cas(created) }, { action: 'correct', value: 1000 }, { action: 'hide', ...cas(created), metric: 'weight' }]) assert.equal((await f.patch(created.recordKey, patch)).status, 400, JSON.stringify(patch));
  assert.equal(value(await readRecord(await f.get(created.recordKey))), 0); assert.equal((await readHistory(await f.history(created.recordKey))).history.length, 1);
});
