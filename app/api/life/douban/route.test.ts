import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import * as store from '../../../../db/douban-store.ts';
import * as library from '../../../../db/douban-library-store.ts';
import * as libraryModel from '../../../../lib/douban-library.ts';
import * as resetStore from '../../../../db/douban-reset-store.ts';
import * as model from '../../../../lib/douban.ts';
import * as sync from '../../../../lib/douban-sync.ts';
import { DoubanSourceError } from '../../../../lib/douban-source.ts';

const ORIGIN = 'https://synthetic-douban.example';
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings)) as Record<string, Handler>;
}
function record(domain: model.DoubanDomain = 'screen', subjectId = '12345', source: model.DoubanRecordInput['source'] = 'collection'): model.DoubanRecordInput {
  return { domain, subjectId, kind: domain, title: '合成条目 ' + subjectId, url: model.doubanSubjectUrl(domain, subjectId), coverUrl: null,
    rating: 4, markedDate: source === 'rss' ? null : '2026-11-01', comment: null, publishedAt: source === 'rss' ? '2026-11-02T00:00:00.000Z' : null, source };
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../../../drizzle/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL('../../../../drizzle/' + name, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql); const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound = {
        bind(...input: unknown[]) { values = input as SQLInputValue[]; return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        execute() { const before = Number(sqlite.prepare('SELECT total_changes() n').get()?.n); const results = statement.columns().length ? statement.all(...values) : (statement.run(...values), []); return { results, meta: { changes: Number(sqlite.prepare('SELECT total_changes() n').get()?.n) - before } }; },
      }; return bound;
    },
    async batch(commands: Array<{ execute(): unknown }>) { sqlite.exec('BEGIN'); try { const results = commands.map(command => command.execute()); sqlite.exec('COMMIT'); return results; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  } as unknown as D1Database;
  const env: { DB?: D1Database } = { DB: db };
  let user: string | null = 'alice', clock = Date.now();
  const collections = new Map<string, { items: model.DoubanRecordInput[]; nextStart: number | null; total: number | null } | Error>();
  let rss: model.DoubanRecordInput[] | Error = [], classification: 'movie' | 'series' | null | Error = 'series';
  let beforeCollection: (() => Promise<void>) | null = null;
  const outgoing: string[] = [];
  class ClockDate extends Date { constructor(value: number | string = clock) { super(value); } static now() { return clock; } }
  const shared = load(new URL('../../_shared.ts', import.meta.url), { getChatGPTUser: async () => user ? { userId: user } : null }, ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const helpers = load(new URL('./_shared.ts', import.meta.url), { env, ...shared, ...store, ...model, ...sync }, ['doubanDatabase', 'presentDoubanConnection', 'doubanGuard', 'doubanBody', 'doubanError']);
  const get = load(new URL('./route.ts', import.meta.url), { ...shared, ...helpers, ...store, ...sync, ...library, ...libraryModel }, ['GET']).GET;
  const libraryHandlers = load(new URL('./library/route.ts', import.meta.url), { ...shared, ...helpers, ...sync, ...library }, ['PUT', 'POST']);
  const put = load(new URL('./connection/route.ts', import.meta.url), { ...shared, ...helpers, ...store, ...model, ...sync }, ['PUT']).PUT;
  const importPost = load(new URL('./import/route.ts', import.meta.url), { ...shared, ...helpers, ...store, ...model, ...sync }, ['POST']).POST;
  const resetPost = load(new URL('./reset/route.ts', import.meta.url), { ...shared, ...helpers, ...resetStore, ...sync }, ['POST']).POST;
  const post = load(new URL('./sync/route.ts', import.meta.url), { ...shared, ...helpers, ...store, ...sync, Date: ClockDate,
    advanceDoubanSyncStep: async (run: sync.DoubanRunForSync, dependencies: sync.DoubanSyncDependencies) => sync.advanceDoubanSyncStep(run, { ...dependencies,
      collection: async (profile, domain, start) => { outgoing.push(profile + ':' + domain + ':' + start); await beforeCollection?.(); const answer = collections.get(profile + ':' + domain + ':' + start); if (answer instanceof Error) throw answer; return answer ?? { items: [], nextStart: null, total: 0 }; },
      rss: async profile => { outgoing.push(profile + ':rss'); if (rss instanceof Error) throw rss; return rss; },
      classify: async subject => { outgoing.push('subject:' + subject); if (classification instanceof Error) throw classification; return classification; },
    }),
  }, ['POST']).POST;
  function request(handler: Handler, path: string, method: string, body?: unknown, options: { origin?: string | null; type?: string; raw?: boolean; length?: string } = {}) {
    const headers = new Headers();
    if (method !== 'GET') { headers.set('Content-Type', options.type ?? 'application/json'); if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN); }
    if (options.length) headers.set('Content-Length', options.length);
    return handler(new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: options.raw ? String(body) : JSON.stringify(body) }) }));
  }
  return { db, env, sqlite, queries, outgoing, collections,
    signIn(value: string | null) { user = value; }, tick(milliseconds = 2000) { clock += milliseconds; },
    setRSS(value: typeof rss) { rss = value; }, setClassification(value: typeof classification) { classification = value; },
    beforeCollection(value: () => Promise<void>) { beforeCollection = value; },
    get(query = '') { return request(get, '/api/life/douban' + (query ? '?' + query : ''), 'GET'); },
    local(body: unknown, options?: Parameters<typeof request>[4]) { return request(libraryHandlers.PUT, '/api/life/douban/library', 'PUT', body, options); },
    classify(body: unknown, options?: Parameters<typeof request>[4]) { return request(libraryHandlers.POST, '/api/life/douban/library', 'POST', body, options); },
    put(body: unknown = { profile: 'synthetic-owner', expectedRevision: 0 }, options?: Parameters<typeof request>[4]) { return request(put, '/api/life/douban/connection', 'PUT', body, options); },
    post(body: unknown, options?: Parameters<typeof request>[4]) { return request(post, '/api/life/douban/sync', 'POST', body, options); },
    import(body: unknown, options?: Parameters<typeof request>[4]) { return request(importPost, '/api/life/douban/import', 'POST', body, options); },
    reset(body: unknown, options?: Parameters<typeof request>[4]) { return request(resetPost, '/api/life/douban/reset', 'POST', body, options); },
  };
}
async function body(response: Response) { return await response.json() as Record<string, any>; }
async function finish(f: ReturnType<typeof fixture>, initial: Record<string, any>) {
  let response = initial;
  for (let steps = 0; response.more && steps < 30; steps++) {
    f.tick(); const next = await f.post({ expectedConnectionRevision: response.connection.revision, runId: response.run.id, expectedRunRevision: response.run.revision });
    assert.equal(next.status, 200); response = await body(next);
  }
  assert.equal(response.more, false, 'the finite synthetic collection must finish'); return response;
}

test('Douban endpoints require authentication and strict same-origin JSON before persistence or public requests', async t => {
  const f = fixture(t); f.signIn(null);
  assert.equal((await f.get()).status, 401); assert.equal((await f.put()).status, 401); assert.equal((await f.post({ expectedConnectionRevision: 0 })).status, 401);
  f.signIn('alice');
  for (const options of [{ origin: null }, { origin: 'https://elsewhere.example' }, { type: 'text/plain' }, { type: 'application/json-other' }]) {
    const expected = options.type ? 415 : 403;
    assert.equal((await f.put(undefined, options)).status, expected); assert.equal((await f.post({}, options)).status, expected);
  }
  assert.deepEqual(f.queries, []); assert.deepEqual(f.outgoing, []);
});

test('invalid binding URLs, injected ownership/cursors, malformed JSON and oversized requests cannot write or fetch', async t => {
  const f = fixture(t);
  for (const value of [null, {}, { profile: 'https://evil.example/people/a/', expectedRevision: 0 }, { profile: 'user-a', expectedRevision: '0' },
    { profile: 'user-a', expectedRevision: 0, userId: 'bob' }, { profile: 'user-a', expectedRevision: 0, cookie: 'PRIVATE-COOKIE' }]) assert.equal((await f.put(value)).status, 400);
  for (const value of [null, {}, { expectedConnectionRevision: 0, cursor: 0 }, { expectedConnectionRevision: 0, expectedRunRevision: 1 },
    { expectedConnectionRevision: 0, runId: 'not-a-run', expectedRunRevision: 0 }]) assert.equal((await f.post(value)).status, 400);
  assert.equal((await f.put('{broken', { raw: true })).status, 400);
  assert.equal((await f.put(' '.repeat(4097), { raw: true })).status, 413);
  assert.equal((await f.post({}, { length: '4097' })).status, 413);
  assert.deepEqual(f.queries, []); assert.deepEqual(f.outgoing, []);
});

test('saving/reading per-user profiles is local, returns canonical links and preserves old records when disconnected', async t => {
  const f = fixture(t), response = await f.put({ profile: 'https://www.douban.com/people/user-a/', expectedRevision: 0 });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const saved = await body(response); assert.equal(saved.connection.profileId, 'user-a'); assert.equal(saved.connection.profileUrl, 'https://www.douban.com/people/user-a/');
  assert.deepEqual(f.outgoing, []);
  f.signIn('bob'); const other = await body(await f.get()); assert.equal(other.connection.profileId, null); assert.equal(other.lastRun, null); assert.deepEqual(other.items, []);
  f.signIn('alice'); assert.equal((await f.put({ profile: null, expectedRevision: 1 })).status, 200);
  assert.deepEqual(f.outgoing, []); assert.equal((await body(await f.get('profile=current'))).total, 0);
});

test('list queries are bounded and cannot select another owner or inject a public source URL', async t => {
  const f = fixture(t);
  for (const query of ['userId=bob', 'kind=not-a-kind', 'kind=book&kind=music', 'offset=-1', 'limit=51', 'profile=evil', 'q=' + '字'.repeat(101), 'url=https://evil.example']) {
    assert.equal((await f.get(query)).status, 400, query);
  }
  const response = await f.get('kind=book&profile=all&limit=24'); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(f.outgoing, []);
});

test('a sync starts locally, advances one bounded source read per revision and classifies the same saved screen record', async t => {
  const f = fixture(t); await f.put(); f.collections.set('synthetic-owner:screen:0', { items: [record()], nextStart: null, total: 1 });
  const started = await body(await f.post({ expectedConnectionRevision: 1 }));
  assert.equal(started.run.revision, 0); assert.deepEqual(f.outgoing, []);
  const result = await finish(f, started); assert.equal(result.run.status, 'completed'); assert.equal(result.run.added, 1); assert.equal(result.run.updated, 1);
  const library = await body(await f.get()); assert.equal(library.total, 1); assert.equal(library.counts.series, 1); assert.equal(library.items[0].subjectId, '12345'); assert.equal(library.items[0].rating, 4);
  assert.deepEqual(f.outgoing, ['synthetic-owner:screen:0', 'synthetic-owner:book:0', 'synthetic-owner:music:0', 'subject:12345']);
  const replay = await f.post({ expectedConnectionRevision: 1, runId: result.run.id, expectedRunRevision: 0 }); assert.equal(replay.status, 200);
  assert.equal(f.outgoing.length, 4); assert.equal((await body(await f.get())).total, 1);
  await f.put({ profile: null, expectedRevision: 1 });
  assert.equal((await body(await f.get())).total, 1); assert.equal((await body(await f.get('profile=current'))).total, 0);
});

test('rate limits, stale run revisions and a changed binding stop before another public request', async t => {
  const f = fixture(t); await f.put(); const started = await body(await f.post({ expectedConnectionRevision: 1 }));
  const command = { expectedConnectionRevision: 1, runId: started.run.id, expectedRunRevision: 0 };
  const limited = await f.post(command); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '1'); assert.deepEqual(f.outgoing, []);
  f.tick(); assert.equal((await f.post(command)).status, 200); assert.equal(f.outgoing.length, 1);
  f.tick(); assert.equal((await f.post(command)).status, 409); assert.equal(f.outgoing.length, 1);
  await f.put({ profile: 'another-owner', expectedRevision: 1 });
  assert.equal((await f.post({ ...command, expectedRunRevision: 1 })).status, 409); assert.equal(f.outgoing.length, 1);
});

test('blocked collections can receive recent RSS without claiming history completeness or wiping richer existing observations', async t => {
  const f = fixture(t); await f.put();
  for (const domain of ['screen', 'book', 'music']) f.collections.set('synthetic-owner:' + domain + ':0', new DoubanSourceError('DOUBAN_SOURCE_CHALLENGE', 'PRIVATE-CONTENT'));
  f.setRSS([record('music', '33333', 'rss')]);
  const result = await finish(f, await body(await f.post({ expectedConnectionRevision: 1 })));
  assert.equal(result.run.status, 'partial'); assert.equal(result.run.rss.received, 1); assert.match(result.run.message, /近期动态.*历史全量/);
  assert.equal((await body(await f.get())).items[0].markedDate, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CONTENT/);
});

test('a completed music collection retains its fresh rating when RSS is needed only for a blocked book source', async t => {
  const f = fixture(t); await f.put();
  f.collections.set('synthetic-owner:music:0', { items: [{ ...record('music', '33333'), rating: 5 }], nextStart: null, total: 1 });
  f.collections.set('synthetic-owner:book:0', new DoubanSourceError('DOUBAN_SOURCE_BLOCKED'));
  f.setRSS([{ ...record('music', '33333', 'rss'), rating: 3 }, record('book', '22222', 'rss')]);
  const result = await finish(f, await body(await f.post({ expectedConnectionRevision: 1 })));
  assert.equal(result.run.status, 'partial'); assert.equal(result.run.rss.received, 1);
  const saved = await body(await f.get());
  assert.equal(saved.items.find((item: model.DoubanRecordInput) => item.domain === 'music').rating, 5);
  assert.equal(saved.items.find((item: model.DoubanRecordInput) => item.domain === 'music').source, 'collection');
  assert.equal(saved.items.find((item: model.DoubanRecordInput) => item.domain === 'book').source, 'rss');
});

test('an atomic expiring claim prevents a second tab from reading the same public page concurrently', async t => {
  const f = fixture(t); await f.put(); const started = await body(await f.post({ expectedConnectionRevision: 1 }));
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.beforeCollection(async () => { entered(); await gate; }); f.tick();
  const command = { expectedConnectionRevision: 1, runId: started.run.id, expectedRunRevision: 0 };
  const original = f.post(command); await waiting;
  assert.equal((await f.post(command)).status, 409, 'the old revision loses before another source fetch');
  const active = (await body(await f.get())).lastRun; f.tick();
  assert.equal((await f.post({ ...command, expectedRunRevision: active.revision })).status, 429, 'the in-flight revision stays claimed until completion or bounded expiry');
  assert.equal(f.outgoing.length, 1); release();
  assert.equal((await original).status, 200); assert.equal(f.outgoing.length, 1);
});

test('changing the bound profile during an upstream read invalidates the final commit without mixing records', async t => {
  const f = fixture(t); await f.put(); f.collections.set('synthetic-owner:screen:0', { items: [record()], nextStart: null, total: 1 });
  const started = await body(await f.post({ expectedConnectionRevision: 1 }));
  f.beforeCollection(async () => { await store.writeDoubanConnection(f.db, 'alice', 'new-profile', 1); }); f.tick();
  const response = await f.post({ expectedConnectionRevision: 1, runId: started.run.id, expectedRunRevision: 0 });
  assert.equal(response.status, 409); assert.equal(f.outgoing.length, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_items').get()?.n, 0);
  assert.equal((await body(await f.get())).connection.profileId, 'new-profile');
});

test('an interrupted worker claim expires and the same untouched page cursor can be resumed', async t => {
  const f = fixture(t); await f.put(); const started = await body(await f.post({ expectedConnectionRevision: 1 }));
  const original = await store.readDoubanRun(f.db, 'alice', started.run.id); assert.ok(original);
  const cursor = sync.parseDoubanSyncState(original.state);
  const claimed = await store.commitDoubanStep(f.db, 'alice', { runId: original.id, expectedRevision: original.revision, connectionRevision: 1,
    items: [], state: { ...cursor, leaseUntil: new Date(Date.parse(original.createdAt) + 20000).toISOString() }, status: 'running', now: original.createdAt });
  f.tick(25000);
  assert.equal((await f.post({ expectedConnectionRevision: 1, runId: claimed.id, expectedRunRevision: claimed.revision })).status, 200);
  assert.deepEqual(f.outgoing, ['synthetic-owner:screen:0']);
});

test('a source 429 stops other endpoints and prevents immediately restarting around the cooldown', async t => {
  const f = fixture(t); await f.put(); f.collections.set('synthetic-owner:screen:0', new DoubanSourceError('DOUBAN_SOURCE_RATE_LIMITED'));
  const started = await body(await f.post({ expectedConnectionRevision: 1 })); f.tick();
  const result = await body(await f.post({ expectedConnectionRevision: 1, runId: started.run.id, expectedRunRevision: 0 }));
  assert.equal(result.more, false); assert.equal(result.run.status, 'failed'); assert.deepEqual(f.outgoing, ['synthetic-owner:screen:0']);
  const limited = await f.post({ expectedConnectionRevision: 1 }); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60');
  f.tick(61000); assert.equal((await f.post({ expectedConnectionRevision: 1 })).status, 200); assert.equal(f.outgoing.length, 1);
});

test('actors cannot resume another user’s run and shared public profile IDs still have isolated saved records', async t => {
  const f = fixture(t); await f.put(); f.collections.set('synthetic-owner:book:0', { items: [record('book')], nextStart: null, total: 1 });
  const aliceStart = await body(await f.post({ expectedConnectionRevision: 1 }));
  f.signIn('bob'); await f.put();
  assert.equal((await f.post({ expectedConnectionRevision: 1, runId: aliceStart.run.id, expectedRunRevision: 0 })).status, 404);
  assert.deepEqual(f.outgoing, []);
  const bobDone = await finish(f, await body(await f.post({ expectedConnectionRevision: 1 }))); assert.equal(bobDone.run.status, 'completed');
  assert.equal((await body(await f.get())).total, 1);
  f.signIn('alice'); assert.equal((await body(await f.get())).total, 0);
  await finish(f, aliceStart); assert.equal((await body(await f.get())).total, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_items').get()?.n, 2);
});

test('storage faults return a fixed classification and never expose user details or provider content', async t => {
  const f = fixture(t); delete f.env.DB;
  const response = await f.get(); assert.equal(response.status, 503); assert.equal((await body(response)).code, 'DOUBAN_STORAGE_UNAVAILABLE');
  assert.deepEqual(f.outgoing, []);
});

test('private-file import accepts only bounded normalized imported records and uses the same login/origin protections', async t => {
  const f = fixture(t), command = { action: 'preview', profile: 'private-source', items: [record('book', '12345', 'import')] };
  f.signIn(null); assert.equal((await f.import(command)).status, 401); f.signIn('alice');
  assert.equal((await f.import(command, { origin: null })).status, 403);
  assert.equal((await f.import(command, { type: 'text/plain' })).status, 415);
  for (const value of [{ ...command, rawFiles: ['PRIVATE-HTML'] }, { ...command, cookies: 'PRIVATE-COOKIE' }, { ...command, userId: 'bob' },
    { ...command, items: [record('book')] }, { ...command, items: [] }, { ...command, items: Array(501).fill(record('book', '12345', 'import')) },
    { ...command, items: [{ ...record('book', '12345', 'import'), status: 'doing' }] }]) assert.equal((await f.import(value)).status, 400);
  assert.equal((await f.import(command, { length: String(4 * 1024 * 1024 + 1) })).status, 413);
  assert.deepEqual(f.queries, []); assert.deepEqual(f.outgoing, []);
});

test('import preview is read-only and a confirmed receipt is idempotent without binding a profile or calling Douban', async t => {
  const f = fixture(t), items = [record('book', '12345', 'import')], profile = 'private-source';
  const response = await f.import({ action: 'preview', profile, items }); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { preview } = await body(response); assert.equal(preview.added, 1); assert.equal(preview.profileUrl, 'https://www.douban.com/people/private-source/');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_items').get()?.n, 0);
  const command = { action: 'commit', profile, items, expectedSnapshotHash: preview.snapshotHash, requestId: '22222222-2222-4222-8222-222222222222', confirmed: true };
  assert.equal((await f.import({ ...command, confirmed: false })).status, 400);
  const first = await body(await f.import(command)); assert.equal(first.receipt.total, 1); assert.equal(first.receipt.added, 1);
  assert.deepEqual(await body(await f.import(command)), first, 'a lost reply can retry the exact receipt operation');
  assert.equal((await f.import({ ...command, items: [{ ...items[0], title: 'changed request' }] })).status, 409);
  const library = await body(await f.get()); assert.equal(library.total, 1); assert.equal(library.connection.profileId, null); assert.equal(library.lastRun, null);
  assert.deepEqual(f.outgoing, []);
});

test('an affected-record change after import preview requires a new preview while other actors remain isolated', async t => {
  const f = fixture(t), profile = 'private-source', items = [record('music', '33333', 'import')];
  const initial = (await body(await f.import({ action: 'preview', profile, items }))).preview;
  const newerItems = [{ ...items[0], title: '另一个页面已确认的标题' }];
  const latest = (await body(await f.import({ action: 'preview', profile, items: newerItems }))).preview;
  const second = { action: 'commit', profile, items: newerItems, expectedSnapshotHash: latest.snapshotHash, requestId: '33333333-3333-4333-8333-333333333333', confirmed: true };
  assert.equal((await f.import(second)).status, 200);
  assert.equal((await f.import({ ...second, items, expectedSnapshotHash: initial.snapshotHash, requestId: '44444444-4444-4444-8444-444444444444' })).status, 409);
  assert.equal((await body(await f.get())).items[0].title, newerItems[0].title);
  f.signIn('bob'); assert.equal((await body(await f.get())).total, 0);
  const bobPreview = (await body(await f.import({ action: 'preview', profile, items }))).preview;
  assert.equal(bobPreview.added, 1); assert.equal((await f.import({ ...second, items, expectedSnapshotHash: bobPreview.snapshotHash })).status, 200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_items').get()?.n, 2);
  f.signIn('alice'); assert.equal((await body(await f.get())).items[0].title, newerItems[0].title); assert.deepEqual(f.outgoing, []);
});

test('private import remains independent of an active public run and does not overwrite its binding or progress', async t => {
  const f = fixture(t); await f.put();
  const started = await body(await f.post({ expectedConnectionRevision: 1 }));
  const profile = 'private-source', items = [record('book', '12345', 'import')];
  const { preview } = await body(await f.import({ action: 'preview', profile, items }));
  assert.equal((await f.import({ action: 'commit', profile, items, expectedSnapshotHash: preview.snapshotHash, requestId: '55555555-5555-4555-8555-555555555555', confirmed: true })).status, 200);
  const library = await body(await f.get()); assert.equal(library.connection.profileId, 'synthetic-owner'); assert.equal(library.connection.revision, 1);
  assert.equal(library.lastRun.id, started.run.id); assert.equal(library.lastRun.revision, started.run.revision); assert.equal(library.lastRun.status, 'running');
  assert.equal(library.total, 1); assert.equal((await body(await f.get('profile=current'))).total, 0); assert.deepEqual(f.outgoing, []);
});

test('a subsequent public sync never sends privately imported screen subject IDs to the metadata source', async t => {
  const f = fixture(t); await f.put();
  const profile = 'synthetic-owner', items = [record('screen', '98765', 'import')];
  const { preview } = await body(await f.import({ action: 'preview', profile, items }));
  assert.equal((await f.import({ action: 'commit', profile, items, expectedSnapshotHash: preview.snapshotHash, requestId: '66666666-6666-4666-8666-666666666666', confirmed: true })).status, 200);
  const result = await finish(f, await body(await f.post({ expectedConnectionRevision: 1 })));
  assert.equal(result.run.status, 'completed'); assert.equal(result.run.classification.checked, 0);
  assert.equal(f.outgoing.some(value => value.startsWith('subject:')), false);
  const library = await body(await f.get()); assert.equal(library.counts.screen, 1); assert.equal(library.items[0].source, 'import');
});

void test('reset endpoints require the actor, same-origin JSON, bounded input and an explicit reviewed commit', async t => {
  const f = fixture(t); f.signIn(null); assert.equal((await f.reset({ action: 'preview' })).status, 401); f.signIn('alice');
  for (const options of [{ origin: null }, { origin: 'https://elsewhere.example' }, { type: 'text/plain' }]) assert.equal((await f.reset({ action: 'preview' }, options)).status, options.type ? 415 : 403);
  for (const value of [null, {}, { action: 'delete' }, { action: 'preview', userId: 'bob' }, { action: 'preview', cookie: 'PRIVATE' },
    { action: 'commit', expectedEpoch: 0, expectedPreviewHash: 'a'.repeat(64), requestId: crypto.randomUUID(), confirmed: false },
    { action: 'commit', expectedEpoch: '0', expectedPreviewHash: 'a'.repeat(64), requestId: crypto.randomUUID(), confirmed: true },
    { action: 'commit', expectedEpoch: 0, expectedPreviewHash: 'bad', requestId: crypto.randomUUID(), confirmed: true }]) assert.equal((await f.reset(value)).status, 400);
  assert.equal((await f.reset('{broken', { raw: true })).status, 400); assert.equal((await f.reset({}, { length: '4097' })).status, 413);
  assert.deepEqual(f.queries, []); assert.deepEqual(f.outgoing, []);
});

async function importViaAPI(f: ReturnType<typeof fixture>, profile: string, items: model.DoubanRecordInput[], expectedDataEpoch = 0) {
  const previewResponse = await f.import({ action: 'preview', profile, items, expectedDataEpoch }); assert.equal(previewResponse.status, 200);
  const { preview } = await body(previewResponse); assert.equal(preview.dataEpoch, expectedDataEpoch);
  const command = { action: 'commit', profile, items, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), confirmed: true, expectedDataEpoch };
  const response = await f.import(command); assert.equal(response.status, 200); return { command, response: await body(response) };
}
async function resetViaAPI(f: ReturnType<typeof fixture>) {
  const previewResponse = await f.reset({ action: 'preview' }); assert.equal(previewResponse.status, 200);
  const { preview } = await body(previewResponse);
  const command = { action: 'commit', expectedEpoch: preview.epoch, expectedPreviewHash: preview.previewHash, requestId: crypto.randomUUID(), confirmed: true };
  const response = await f.reset(command); assert.equal(response.status, 200); return { preview, command, response: await body(response) };
}

void test('reset preview counts all own sources without deleting; commit clears own records, runs and receipts while retaining the binding', async t => {
  const f = fixture(t); await f.put();
  const started = await body(await f.post({ expectedConnectionRevision: 1 }));
  await importViaAPI(f, 'first-source', [record('book', '11111', 'import')]); await importViaAPI(f, 'second-source', [record('music', '22222', 'import')]);
  f.signIn('bob'); await f.put({ profile: 'bob-source', expectedRevision: 0 }); await importViaAPI(f, 'bob-source', [record('book', '33333', 'import')]);
  f.signIn('alice'); const previewResponse = await f.reset({ action: 'preview' }); assert.equal(previewResponse.headers.get('Cache-Control'), 'no-store');
  const { preview } = await body(previewResponse); assert.equal(preview.epoch, 0); assert.equal(preview.total, 2); assert.equal(preview.counts.book, 1); assert.equal(preview.counts.music, 1);
  assert.equal((await body(await f.get())).total, 2); assert.equal((await body(await f.get())).dataEpoch, 0);
  const cleared = await resetViaAPI(f); assert.equal(cleared.response.receipt.deleted, 2); assert.equal(cleared.response.receipt.epoch, 1);
  const library = await body(await f.get()); assert.equal(library.total, 0); assert.equal(library.dataEpoch, 1); assert.equal(library.connection.profileId, 'synthetic-owner'); assert.equal(library.connection.revision, 2); assert.equal(library.lastRun, null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_import_receipts WHERE user_id='alice'").get()?.n, 0);
  assert.equal((await f.post({ expectedConnectionRevision: 1, runId: started.run.id, expectedRunRevision: started.run.revision })).status, 409);
  f.signIn('bob'); const other = await body(await f.get()); assert.equal(other.total, 1); assert.equal(other.dataEpoch, 0); assert.equal(other.connection.profileId, 'bob-source');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_import_receipts WHERE user_id='bob'").get()?.n, 1); assert.deepEqual(f.outgoing, []);
});

void test('clear invalidates stale previews and receipts, requires a current epoch for new imports, and old clear retries retain newly resynced data', async t => {
  const f = fixture(t), profile = 'private-source', items = [record('book', '11111', 'import')];
  const original = await importViaAPI(f, profile, items);
  const oldPreview = (await body(await f.import({ action: 'preview', profile, items: [record('book', '22222', 'import')] }))).preview;
  const reset = await resetViaAPI(f);
  for (const command of [original.command, { action: 'preview', profile, items }, { action: 'preview', profile, items, expectedDataEpoch: 0 },
    { action: 'commit', profile, items: [record('book', '22222', 'import')], expectedSnapshotHash: oldPreview.snapshotHash, requestId: crypto.randomUUID(), confirmed: true }]) {
    const response = await f.import(command); assert.equal(response.status, 409); assert.equal((await body(response)).code, 'DOUBAN_DATA_EPOCH_CONFLICT');
  }
  for (const expectedDataEpoch of [null, '1', -1, 1.5]) assert.equal((await f.import({ action: 'preview', profile, items, expectedDataEpoch })).status, 400);
  const fresh = await importViaAPI(f, profile, items, 1); assert.equal(fresh.response.receipt.dataEpoch, 1);
  assert.deepEqual(await body(await f.import(fresh.command)), fresh.response);
  const replay = await body(await f.reset(reset.command)); assert.deepEqual(replay, reset.response);
  assert.equal((await body(await f.get())).total, 1); assert.equal((await body(await f.get())).dataEpoch, 1);
  assert.equal((await f.reset({ ...reset.command, expectedPreviewHash: 'b'.repeat(64) })).status, 409);
  assert.deepEqual(f.outgoing, []);
});

void test('a changed reset preview rejects without deleting and clear during a public read cannot restore any old page', async t => {
  const f = fixture(t); await f.put();
  await importViaAPI(f, 'private-source', [record('book', '11111', 'import')]);
  const { preview } = await body(await f.reset({ action: 'preview' })); await importViaAPI(f, 'private-source', [record('book', '22222', 'import')]);
  const stale = await f.reset({ action: 'commit', expectedEpoch: preview.epoch, expectedPreviewHash: preview.previewHash, requestId: crypto.randomUUID(), confirmed: true });
  assert.equal(stale.status, 409); assert.equal((await body(stale)).code, 'DOUBAN_RESET_CONFLICT'); assert.equal((await body(await f.get())).total, 2);
  const started = await body(await f.post({ expectedConnectionRevision: 1 })); f.collections.set('synthetic-owner:screen:0', { items: [record()], nextStart: null, total: 1 });
  f.beforeCollection(async () => { await resetViaAPI(f); });
  f.tick();
  const late = await f.post({ expectedConnectionRevision: 1, runId: started.run.id, expectedRunRevision: started.run.revision }); assert.equal(late.status, 409);
  const library = await body(await f.get()); assert.equal(library.total, 0); assert.equal(library.dataEpoch, 1); assert.equal(library.connection.revision, 2); assert.equal(library.lastRun, null);
});

void test('returnRecords is an explicit commit-only option for at most thirty normalized imports', async t => {
  const f = fixture(t), items = [record('screen', '11111', 'import')], profile = 'private-source';
  const base = { action: 'commit', profile, items, expectedSnapshotHash: 'a'.repeat(64), requestId: crypto.randomUUID(), confirmed: true };
  for (const input of [{ action: 'preview', profile, items, returnRecords: true }, { ...base, returnRecords: false },
    { ...base, returnRecords: 'true' }, { ...base, returnRecords: true, items: Array.from({ length: 31 }, (_, index) => record('screen', String(10000 + index), 'import')) }]) {
    assert.equal((await f.import(input)).status, 400);
  }
  assert.deepEqual(f.queries, []); assert.deepEqual(f.outgoing, []);
});

void test('small browser commits and receipt retries return current persisted records separately from the original receipt', async t => {
  const f = fixture(t), profile = 'private-source', items = [record('screen', '11111', 'import')];
  const { preview } = await body(await f.import({ action: 'preview', profile, items, expectedDataEpoch: 0 }));
  const command = { action: 'commit', profile, items, expectedDataEpoch: 0, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), confirmed: true, returnRecords: true };
  const firstResponse = await f.import(command); assert.equal(firstResponse.status, 200); const first = await body(firstResponse);
  assert.equal(first.records.length, 1); assert.equal(first.records[0].subjectId, '11111'); assert.equal(first.records[0].profileId, profile); assert.equal(typeof first.records[0].updatedAt, 'string'); assert.equal(first.receipt.records, undefined);
  f.sqlite.prepare("UPDATE douban_items SET kind='movie',updated_at=?,details_json=? WHERE user_id='alice'").run('2026-11-15T00:00:00.000Z', JSON.stringify({ summary: '随后已补全的作品资料' }));
  const replay = await body(await f.import(command)); assert.deepEqual(replay.receipt, first.receipt); assert.equal(replay.records[0].kind, 'movie'); assert.equal(replay.records[0].updatedAt, '2026-11-15T00:00:00.000Z'); assert.equal(replay.records[0].details.summary, '随后已补全的作品资料');
  const { returnRecords: _returnRecords, ...ordinary } = command;
  const fileCompatible = await body(await f.import(ordinary)); assert.equal(Object.hasOwn(fileCompatible, 'records'), false); assert.deepEqual(fileCompatible.receipt, first.receipt);
  await resetViaAPI(f); const stale = await f.import(command); assert.equal(stale.status, 409); assert.equal((await body(stale)).code, 'DOUBAN_DATA_EPOCH_CONFLICT');
  assert.deepEqual(f.outgoing, []);
});

void test('library endpoints require authentication, strict JSON origin and bounded known fields', async t => {
  const f = fixture(t), command = { profileId: 'profile', domain: 'screen', subjectId: '1', expectedDataEpoch: 0, expectedLocalRevision: 0, note: '', tags: [], hidden: false };
  f.signIn(null); assert.equal((await f.local(command)).status, 401); assert.equal((await f.classify({})).status, 401);
  f.signIn('alice');
  for (const options of [{ origin: null }, { origin: 'https://other.example' }, { type: 'text/plain' }]) assert.equal((await f.local(command, options)).status, options.type ? 415 : 403);
  for (const invalid of [null, {}, { ...command, userId: 'bob' }, { ...command, tags: ['x', 'x'] }, { ...command, hidden: 1 }, { ...command, expectedLocalRevision: -1 }]) assert.equal((await f.local(invalid)).status, 400);
  for (const query of ['rating=0', 'rating=6', 'rating=4&rating=5', 'year=20', 'year=0000', 'sort=arbitrary', 'hidden=no', 'missing=0', 'tag=', 'tag=' + 'x'.repeat(31)]) assert.equal((await f.get(query)).status, 400, query);
  assert.equal((await f.classify({ action: 'classify', kind: 'movie', expectedDataEpoch: 0, items: Array(25).fill({ profileId: 'profile', domain: 'screen', subjectId: '1', expectedUpdatedAt: new Date().toISOString() }) })).status, 400);
  assert.deepEqual(f.outgoing, []);
});

void test('library API saves independent local notes, restores hidden records and applies reviewed batch classification', async t => {
  const f = fixture(t), profile = 'library-profile', items = [record('screen', '77777', 'import')];
  const { preview } = await body(await f.import({ action: 'preview', profile, items, expectedDataEpoch: 0 }));
  assert.equal((await f.import({ action: 'commit', profile, items, expectedDataEpoch: 0, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), confirmed: true })).status, 200);
  const before = (await body(await f.get())).items[0];
  const command = { profileId: profile, domain: 'screen', subjectId: '77777', expectedDataEpoch: 0, expectedLocalRevision: 0, note: '本地备注', tags: ['重看'], hidden: true };
  const savedResponse = await f.local(command); assert.equal(savedResponse.status, 200);
  const saved = await body(savedResponse); assert.equal(saved.item.local.revision, 1); assert.equal(saved.item.updatedAt, before.updatedAt);
  assert.equal((await body(await f.get())).total, 0);
  assert.equal((await body(await f.get('hidden=hidden&tag=' + encodeURIComponent('重看')))).total, 1);
  assert.equal((await f.local({ ...command, note: 'stale' })).status, 409);
  f.signIn('bob'); assert.equal((await f.local({ ...command, expectedLocalRevision: 1 })).status, 409); assert.equal((await body(await f.get('hidden=all'))).total, 0);
  f.signIn('alice');
  const classify = { action: 'classify', kind: 'movie', expectedDataEpoch: 0, items: [{ profileId: profile, domain: 'screen', subjectId: '77777', expectedUpdatedAt: before.updatedAt }] };
  const classified = await f.classify(classify); assert.equal(classified.status, 200); assert.equal((await body(classified)).items[0].kind, 'movie');
  assert.equal((await f.local({ ...command, expectedLocalRevision: 1, hidden: false })).status, 200);
  const visible = await body(await f.get('rating=4&year=2026&sort=rating-desc'));
  assert.equal(visible.total, 1); assert.equal(visible.items[0].local.note, '本地备注'); assert.deepEqual(visible.tags, ['重看']);
  assert.deepEqual(f.outgoing, []);
});
