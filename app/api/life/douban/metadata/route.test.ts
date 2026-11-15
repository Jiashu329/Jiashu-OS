import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { compileFunction } from 'node:vm';
import { readDoubanLibraryRecord } from '../../../../../db/douban-library-store.ts';
import * as store from '../../../../../db/douban-store.ts';
import * as metadataStore from '../../../../../db/douban-metadata-store.ts';
import * as model from '../../../../../lib/douban.ts';
import * as details from '../../../../../lib/douban-details.ts';
import * as sync from '../../../../../lib/douban-sync.ts';
import { DoubanSourceError } from '../../../../../lib/douban-source.ts';
import type { DoubanSubjectMetadata } from '../../../../../lib/douban-metadata.ts';

const ORIGIN = 'https://synthetic-douban.example', T1 = '2026-11-14T08:00:00.000Z', T2 = '2026-11-14T08:01:00.000Z';
const COVER = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg';
const KEY = { profileId: 'source-profile', domain: 'screen' as const, subjectId: '12345', expectedUpdatedAt: T1 };
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn {' + names.join(',') + '};', Object.keys(bindings))(...Object.values(bindings)) as Record<string, Handler>;
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../../../../../drizzle/0024_douban.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../../../../drizzle/0025_douban_data_resets.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../../../../drizzle/0027_douban_subject_details.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../../../../drizzle/0028_douban_browser_source.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../../../../drizzle/0029_douban_library.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../../../../drizzle/0030_douban_manual_cover.sql', import.meta.url), 'utf8'));
  for (const file of ['0031_tmdb_covers_and_settings.sql','0032_imdb_ratings.sql','0033_douban_sync_hints.sql']) sqlite.exec(readFileSync(new URL('../../../../../drizzle/' + file, import.meta.url), 'utf8'));
  const queries: string[] = [], outgoing: Array<{ domain: string; subjectId: string }> = [];
  const db = { prepare(sql: string) {
    queries.push(sql); const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const bound = { bind(...input: unknown[]) { values = input as SQLInputValue[]; return bound; },
      async first<T>() { const row = statement.get(...values); return row ? { ...row } as T : null; } };
    return bound;
  } } as unknown as D1Database;
  const env: { DB?: D1Database } = { DB: db };
  let user: string | null = 'alice', answer: DoubanSubjectMetadata | Error = { kind: 'series', coverUrl: COVER };
  let beforeFetch: (() => void) | undefined;
  const shared = load(new URL('../../../_shared.ts', import.meta.url), { getChatGPTUser: async () => user ? { userId: user } : null }, ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const helpers = load(new URL('../_shared.ts', import.meta.url), { env, ...shared, ...store, ...model, ...sync }, ['doubanDatabase', 'doubanGuard', 'doubanBody', 'doubanError']);
  const bindings = { ...shared, ...helpers, ...store, ...model, ...sync, ...details, ...metadataStore, DoubanSourceError,
    fetchDoubanSubjectMetadata: async (domain: string, subjectId: string) => { outgoing.push({ domain, subjectId }); beforeFetch?.(); if (answer instanceof Error) throw answer; return answer; } };
  const metadataRoutes = load(new URL('./route.ts', import.meta.url), bindings, ['POST', 'PUT']), post = metadataRoutes.POST, browserPut = metadataRoutes.PUT;
  const put = load(new URL('../classification/route.ts', import.meta.url), bindings, ['PUT']).PUT;
  function seed(owner = 'alice', patch: Partial<store.DoubanRecord> = {}) {
    const item: store.DoubanRecord = { profileId: KEY.profileId, domain: 'screen', subjectId: KEY.subjectId, kind: 'screen', title: owner + '-private-title',
      url: 'https://movie.douban.com/subject/' + KEY.subjectId + '/', coverUrl: null, rating: 5, markedDate: '2026-11-01', comment: owner + '-private-comment',
      publishedAt: null, source: 'import', observedAt: T1, createdAt: T1, updatedAt: T1, metadataCheckedRunId: null, ...patch };
    sqlite.prepare(`INSERT INTO douban_items (user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,observed_at,created_at,updated_at,metadata_checked_run_id,details_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner, item.profileId, item.domain, item.subjectId, item.kind, item.title, item.url,
      item.coverUrl, item.rating, item.markedDate, item.comment, item.publishedAt, item.source, item.observedAt, item.createdAt, item.updatedAt, item.metadataCheckedRunId, store.doubanDetailsJson(item.details));
    return { ...item, sync: { collectionHash: null, detailsCheckedAt: null } };
  }
  function request(handler: Handler, method: string, body: unknown, options: { origin?: string | null; type?: string; raw?: boolean; length?: string } = {}, target?: string) {
    const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' });
    if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
    if (options.length) headers.set('Content-Length', options.length);
    return handler(new Request(ORIGIN + '/api/life/douban/' + (target ?? (method === 'POST' ? 'metadata' : 'classification')), { method, headers,
      body: options.raw ? String(body) : JSON.stringify(body) }));
  }
  return { db, env, sqlite, queries, outgoing, seed,
    signIn(value: string | null) { user = value; }, metadata(value: typeof answer) { answer = value; }, beforeFetch(callback: () => void) { beforeFetch = callback; },
    post(body: unknown = { ...KEY, confirmed: true }, options?: Parameters<typeof request>[3]) { return request(post, 'POST', body, options); },
    put(body: unknown = { ...KEY, kind: 'series' }, options?: Parameters<typeof request>[3]) { return request(put, 'PUT', body, options); },
    browser(body: unknown = { ...KEY, expectedDataEpoch: 0, confirmed: true, metadata: { kind: 'series', coverUrl: COVER, details: {} } }, options?: Parameters<typeof request>[3]) { return request(browserPut, 'PUT', body, options, 'metadata'); },
  };
}
interface ApiResponse {
  item: store.DoubanRecord; changed: boolean; dataEpoch?: number; metadata: { status: 'complete' | 'unavailable'; message?: string }; code?: string;
}
async function body(response: Response): Promise<ApiResponse> { return await response.json() as ApiResponse; }

void test('metadata and manual classification require authentication and same-origin strict JSON before any DB or external read', async t => {
  const f = fixture(t); f.signIn(null);
  assert.equal((await f.post()).status, 401); assert.equal((await f.put()).status, 401);
  f.signIn('alice');
  for (const options of [{ origin: null }, { origin: 'https://elsewhere.example' }, { type: 'text/plain' }, { type: 'application/json-other' }]) {
    const status = options.type ? 415 : 403;
    assert.equal((await f.post(undefined, options)).status, status); assert.equal((await f.put(undefined, options)).status, status);
  }
  assert.deepEqual(f.queries, []); assert.deepEqual(f.outgoing, []);
});

void test('invalid source keys, ownership or URL injection, missing confirmation and oversized bodies fail before DB or network', async t => {
  const f = fixture(t);
  for (const input of [null, {}, { ...KEY }, { ...KEY, confirmed: false }, { ...KEY, confirmed: true, userId: 'bob' },
    { ...KEY, confirmed: true, url: 'https://evil.example/private' }, { ...KEY, confirmed: true, subjectId: '../12345' },
    { ...KEY, confirmed: true, profileId: 'https://www.douban.com/people/source-profile/' }, { ...KEY, confirmed: true, expectedUpdatedAt: 'invalid' }]) {
    assert.equal((await f.post(input)).status, 400);
  }
  for (const input of [null, {}, { ...KEY, kind: 'book' }, { ...KEY, domain: 'book', kind: 'series' },
    { ...KEY, kind: 'series', owner: 'bob' }, { ...KEY, kind: 'series', expectedUpdatedAt: 'invalid' }]) assert.equal((await f.put(input)).status, 400);
  assert.equal((await f.post('{broken', { raw: true })).status, 400);
  assert.equal((await f.put(' '.repeat(4097), { raw: true })).status, 413);
  assert.equal((await f.post({}, { length: '4097' })).status, 413);
  assert.deepEqual(f.queries, []); assert.deepEqual(f.outgoing, []);
});

void test('missing, stale, other-profile and other-owner records never cause an external metadata read', async t => {
  const f = fixture(t); f.seed('alice'); f.signIn('bob');
  assert.equal((await f.post()).status, 404); assert.equal((await f.put()).status, 404);
  f.signIn('alice');
  assert.equal((await f.post({ ...KEY, profileId: 'other-profile', confirmed: true })).status, 404);
  const stale = await f.post({ ...KEY, expectedUpdatedAt: T2, confirmed: true });
  assert.equal(stale.status, 409); assert.equal((await body(stale)).code, 'DOUBAN_RECORD_CONFLICT');
  assert.deepEqual(f.outgoing, []);
});

void test('a confirmed metadata request performs exactly one fixed subject read and merges only cover and type into its owner', async t => {
  const f = fixture(t), alice = f.seed('alice'), bob = f.seed('bob');
  const response = await f.post(); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const saved = await body(response); assert.equal(saved.changed, true); assert.equal(saved.metadata.status, 'complete');
  assert.equal(saved.item.kind, 'series'); assert.equal(saved.item.coverUrl, COVER);
  for (const field of ['title', 'rating', 'markedDate', 'comment', 'publishedAt', 'source', 'createdAt'] as const) assert.equal(saved.item[field], alice[field]);
  assert.deepEqual(f.outgoing, [{ domain: 'screen', subjectId: KEY.subjectId }]);
  assert.deepEqual(await store.readDoubanRecord(f.db, 'bob', KEY), bob);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_connections').get()?.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_sync_runs').get()?.n, 0);
});

void test('blocked, invalid and unavailable metadata leave saved fields untouched and return fixed safe messages', async t => {
  const f = fixture(t), old = f.seed('alice', { kind: 'movie', coverUrl: COVER });
  for (const failure of [new DoubanSourceError('DOUBAN_SOURCE_BLOCKED', 'PRIVATE_UPSTREAM_BODY'),
    new DoubanSourceError('DOUBAN_SOURCE_LOGIN_REQUIRED'), new DoubanSourceError('DOUBAN_SOURCE_INVALID'),
    new DoubanSourceError('DOUBAN_SOURCE_NETWORK'), { kind: null, coverUrl: null } satisfies DoubanSubjectMetadata]) {
    f.metadata(failure); const response = await f.post(); assert.equal(response.status, 200);
    const result = await body(response); assert.equal(result.metadata.status, 'unavailable'); assert.equal(result.changed, false);
    assert.deepEqual(result.item, await readDoubanLibraryRecord(f.db, 'alice', KEY)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM_BODY/);
  }
  assert.equal(f.queries.some(sql => sql.startsWith('UPDATE')), false);
  assert.deepEqual(await store.readDoubanRecord(f.db, 'alice', KEY), old);
  f.metadata(new Error('PRIVATE_UNEXPECTED_ERROR')); const response = await f.post(); assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await body(response)), /PRIVATE_UNEXPECTED_ERROR/);
});

void test('upstream rate limiting returns a stable retryable code without changing any record', async t => {
  const f = fixture(t), old = f.seed(); f.metadata(new DoubanSourceError('DOUBAN_SOURCE_RATE_LIMITED'));
  const response = await f.post(); assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal((await body(response)).code, 'DOUBAN_METADATA_RATE_LIMITED');
  assert.deepEqual(await store.readDoubanRecord(f.db, 'alice', KEY), old); assert.equal(f.queries.some(sql => sql.startsWith('UPDATE')), false);
});

void test('metadata CAS refuses a personal edit made while the external read is in flight', async t => {
  const f = fixture(t); f.seed(); f.beforeFetch(() => f.sqlite.prepare('UPDATE douban_items SET comment=? WHERE user_id=?').run('new-private-comment', 'alice'));
  const response = await f.post(); assert.equal(response.status, 409); assert.equal((await body(response)).code, 'DOUBAN_RECORD_CONFLICT');
  const saved = (await store.readDoubanRecord(f.db, 'alice', KEY))!;
  assert.equal(saved.comment, 'new-private-comment'); assert.equal(saved.coverUrl, null); assert.equal(saved.kind, 'screen');
});

void test('manual classification is local and its explicit choice survives subsequent metadata, including an already matching selection', async t => {
  const f = fixture(t), old = f.seed('alice', { source: 'collection', kind: 'movie' });
  const response = await f.put({ ...KEY, kind: 'movie' }); assert.equal(response.status, 200);
  const manual = (await body(response)).item; assert.equal(manual.updatedAt, old.updatedAt); assert.equal(manual.metadataCheckedRunId, 'manual-kind');
  assert.deepEqual(f.outgoing, []);
  const refreshed = await body(await f.post()); assert.equal(refreshed.item.kind, 'movie'); assert.equal(refreshed.item.coverUrl, COVER);
  const changed = await body(await f.put({ ...KEY, expectedUpdatedAt: refreshed.item.updatedAt, kind: 'series' }));
  assert.equal(changed.item.kind, 'series'); assert.equal(changed.item.rating, old.rating); assert.equal(changed.item.comment, old.comment);
  assert.equal(changed.item.source, old.source); assert.equal(f.outgoing.length, 1);
});

void test('browser-read metadata requires an authenticated same-origin actor, strict normalized fields and an explicit data epoch', async t => {
  const f = fixture(t); f.signIn(null); assert.equal((await f.browser()).status, 401); f.signIn('alice');
  for (const options of [{ origin: null }, { origin: 'https://elsewhere.example' }, { type: 'text/plain' }]) assert.equal((await f.browser(undefined, options)).status, options.type ? 415 : 403);
  const base = { ...KEY, expectedDataEpoch: 0, confirmed: true, metadata: { kind: 'series', coverUrl: COVER, details: {} } };
  const { expectedDataEpoch: _epoch, ...missingEpoch } = base;
  for (const value of [missingEpoch, { ...base, expectedDataEpoch: null }, { ...base, expectedDataEpoch: -1 }, { ...base, expectedDataEpoch: '0' },
    { ...base, confirmed: false }, { ...base, userId: 'bob' }, { ...base, metadata: { ...base.metadata, rating: 1 } },
    { ...base, metadata: { ...base.metadata, details: { cookie: 'PRIVATE' } } }, { ...base, metadata: { ...base.metadata, details: { summary: '<script>unsafe()</script>' } } },
    { ...base, metadata: { ...base.metadata, details: { summary: 'x'.repeat(12001) } } },
    { ...base, metadata: { ...base.metadata, kind: 'book' } }, { ...base, metadata: { ...base.metadata, coverUrl: 'https://evil.example/private' } }]) assert.equal((await f.browser(value)).status, 400);
  assert.equal((await f.browser(base, { length: String(4 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await f.post({ ...KEY, confirmed: true, metadata: base.metadata })).status, 400, 'server-fetch POST does not accept client metadata');
  assert.deepEqual(f.queries, []); assert.deepEqual(f.outgoing, []);
});

void test('browser metadata saves public work details locally while preserving all personal fields and manual classification', async t => {
  const f = fixture(t), old = f.seed('alice', { kind: 'movie', metadataCheckedRunId: 'manual-kind', details: { summary: '旧简介', directors: ['导演甲'] } }), bob = f.seed('bob');
  const metadata = { kind: 'series', coverUrl: COVER, details: { summary: '新作品简介', cast: ['演员甲'], doubanRating: 8.7, ratingCount: 12345, episodes: 12 } };
  const response = await f.browser({ ...KEY, expectedDataEpoch: 0, confirmed: true, metadata }); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await body(response); assert.equal(result.dataEpoch, 0); assert.equal(result.changed, true); assert.equal(result.item.kind, 'movie'); assert.equal(result.item.metadataCheckedRunId, 'manual-kind');
  assert.deepEqual(result.item.details, { ...metadata.details, directors: ['导演甲'] });
  for (const field of ['title', 'rating', 'markedDate', 'comment', 'publishedAt', 'source', 'createdAt'] as const) assert.equal(result.item[field], old[field]);
  assert.deepEqual(await store.readDoubanRecord(f.db, 'bob', KEY), bob); assert.deepEqual(f.outgoing, []);
  const unchanged = await body(await f.browser({ ...KEY, expectedUpdatedAt: result.item.updatedAt, expectedDataEpoch: 0, confirmed: true, metadata: { kind: null, coverUrl: null, details: {} } }));
  assert.equal(unchanged.changed, false); assert.deepEqual(unchanged.item.details, result.item.details);
});

void test('browser metadata cannot address another owner, source profile or stale content version', async t => {
  const f = fixture(t); f.seed('alice'); f.signIn('bob'); assert.equal((await f.browser()).status, 404); f.signIn('alice');
  const base = { ...KEY, expectedDataEpoch: 0, confirmed: true, metadata: { kind: 'series', coverUrl: COVER, details: { summary: '作品简介' } } };
  assert.equal((await f.browser({ ...base, profileId: 'other-profile' })).status, 404);
  const stale = await f.browser({ ...base, expectedUpdatedAt: T2 }); assert.equal(stale.status, 409); assert.equal((await body(stale)).code, 'DOUBAN_RECORD_CONFLICT');
  assert.deepEqual(f.outgoing, []); assert.equal(f.queries.some(sql => sql.startsWith('UPDATE')), false);
});

void test('a browser PUT whose committed reply was lost replays the original body as a read-only current receipt', async t => {
  const f = fixture(t); f.seed('alice', { source: 'collection' }); f.seed('bob');
  const original = { ...KEY, expectedDataEpoch: 0, confirmed: true, metadata: { kind: 'series', coverUrl: COVER, details: { summary: '已保存作品简介', episodes: 12 } } };
  await f.browser(original); // The write commits, but the caller never receives its response.
  const committed = (await readDoubanLibraryRecord(f.db, 'alice', KEY))!;
  assert.equal(committed.kind, 'series'); assert.notEqual(committed.updatedAt, original.expectedUpdatedAt);
  f.queries.length = 0;
  const replay = await f.browser(original); assert.equal(replay.status, 200);
  const result = await body(replay); assert.deepEqual(result.item, committed); assert.equal(result.changed, false); assert.equal(result.metadata.status, 'complete'); assert.equal(result.dataEpoch, 0);
  assert.equal(f.queries.some(sql => sql.startsWith('UPDATE')), false); assert.deepEqual(f.outgoing, []);
  assert.equal((await store.readDoubanRecord(f.db, 'bob', KEY))?.kind, 'screen');
});

void test('browser lost-reply recovery preserves later personal edits and manual type without refreshing or writing its stale version', async t => {
  const f = fixture(t); f.seed('alice', { source: 'collection' });
  const original = { ...KEY, expectedDataEpoch: 0, confirmed: true, metadata: { kind: 'series', coverUrl: COVER, details: { summary: '已保存作品简介' } } };
  await f.browser(original);
  const committed = (await readDoubanLibraryRecord(f.db, 'alice', KEY))!;
  assert.equal((await f.put({ ...KEY, expectedUpdatedAt: committed.updatedAt, kind: 'movie' })).status, 200);
  f.sqlite.prepare("UPDATE douban_items SET title=?,rating=?,marked_date=?,comment=? WHERE user_id='alice'").run('后来修改的名称', 2, '2026-11-13', '后来修改的私人短评');
  const current = (await readDoubanLibraryRecord(f.db, 'alice', KEY))!; f.queries.length = 0;
  const response = await f.browser(original); assert.equal(response.status, 200);
  const recovered = await body(response); assert.deepEqual(recovered.item, current); assert.equal(recovered.item.kind, 'movie'); assert.equal(recovered.item.metadataCheckedRunId, 'manual-kind'); assert.equal(recovered.changed, false);
  assert.equal(f.queries.some(sql => sql.startsWith('UPDATE')), false); assert.deepEqual(f.outgoing, []);
  const conflicting = await f.browser({ ...original, metadata: { ...original.metadata, details: { summary: '还未保存的旧简介' } } });
  assert.equal(conflicting.status, 409); assert.equal((await body(conflicting)).code, 'DOUBAN_RECORD_CONFLICT');
  assert.deepEqual(await readDoubanLibraryRecord(f.db, 'alice', KEY), current); assert.equal(f.queries.some(sql => sql.startsWith('UPDATE')), false);
});

void test('a browser replay cannot acknowledge matching metadata recreated after a reset', async t => {
  const f = fixture(t); f.seed('alice');
  const metadata = { kind: 'series' as const, coverUrl: COVER, details: { summary: '相同作品简介' } };
  const original = { ...KEY, expectedDataEpoch: 0, confirmed: true, metadata };
  await f.browser(original);
  f.sqlite.prepare("DELETE FROM douban_items WHERE user_id='alice'").run();
  const recreated = f.seed('alice', { ...metadata, updatedAt: T2, comment: '新世代私人记录' });
  f.sqlite.prepare('INSERT INTO douban_data_resets(user_id,data_epoch,last_request_id,last_request_hash,last_receipt_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('alice', 1, crypto.randomUUID(), 'a'.repeat(64), '{}', T2, T2);
  f.queries.length = 0;
  const response = await f.browser(original); assert.equal(response.status, 409); assert.equal((await body(response)).code, 'DOUBAN_DATA_EPOCH_CONFLICT');
  assert.deepEqual(await store.readDoubanRecord(f.db, 'alice', KEY), recreated); assert.equal(f.queries.some(sql => sql.startsWith('UPDATE')), false); assert.deepEqual(f.outgoing, []);
});

void test('details alone make a server metadata response useful, and the optional expected epoch stops old reads before fetch', async t => {
  const f = fixture(t); f.seed('alice'); f.metadata({ kind: null, coverUrl: null, details: { summary: '可靠的作品简介', writers: ['编剧甲'] } });
  const response = await f.post({ ...KEY, confirmed: true, expectedDataEpoch: 0 }); assert.equal(response.status, 200);
  const result = await body(response); assert.equal(result.dataEpoch, 0); assert.equal(result.changed, true); assert.equal(result.metadata.status, 'complete'); assert.equal(result.item.details?.summary, '可靠的作品简介'); assert.equal(result.item.kind, 'screen');
  f.sqlite.prepare('INSERT INTO douban_data_resets(user_id,data_epoch,last_request_id,last_request_hash,last_receipt_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('alice', 1, crypto.randomUUID(), 'a'.repeat(64), '{}', T2, T2);
  const before = f.outgoing.length;
  const stale = await f.post({ ...KEY, expectedUpdatedAt: result.item.updatedAt, confirmed: true, expectedDataEpoch: 0 }); assert.equal(stale.status, 409); assert.equal((await body(stale)).code, 'DOUBAN_DATA_EPOCH_CONFLICT'); assert.equal(f.outgoing.length, before);
  const staleBrowser = await f.browser({ ...KEY, expectedUpdatedAt: result.item.updatedAt, expectedDataEpoch: 0, confirmed: true, metadata: { kind: null, coverUrl: null, details: { summary: '旧世代简介' } } });
  assert.equal(staleBrowser.status, 409); assert.equal((await body(staleBrowser)).code, 'DOUBAN_DATA_EPOCH_CONFLICT'); assert.equal((await store.readDoubanRecord(f.db, 'alice', KEY))?.details?.summary, '可靠的作品简介');
});

void test('a reset during the external metadata read does not write to a newly imported same-key same-time row', async t => {
  const f = fixture(t); f.seed('alice');
  f.metadata({ kind: 'series', coverUrl: COVER, details: { summary: '迟到的旧请求详情' } });
  f.beforeFetch(() => {
    f.sqlite.prepare("DELETE FROM douban_items WHERE user_id='alice'").run(); f.seed('alice', { comment: '重建后的个人短评', details: { summary: '新世代已保存详情' } });
    f.sqlite.prepare('INSERT INTO douban_data_resets(user_id,data_epoch,last_request_id,last_request_hash,last_receipt_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('alice', 1, crypto.randomUUID(), 'a'.repeat(64), '{}', T2, T2);
  });
  const response = await f.post({ ...KEY, confirmed: true, expectedDataEpoch: 0 }); assert.equal(response.status, 409); assert.equal((await body(response)).code, 'DOUBAN_DATA_EPOCH_CONFLICT');
  const current = (await readDoubanLibraryRecord(f.db, 'alice', KEY))!; assert.equal(current.updatedAt, T1); assert.equal(current.details?.summary, '新世代已保存详情'); assert.equal(current.comment, '重建后的个人短评'); assert.equal(current.coverUrl, null); assert.equal(current.kind, 'screen');
});

void test('no-change POST inspections use a captured check fence and unknown replies never fetch or advance twice', async t => {
  const f=fixture(t); f.seed('alice',{kind:'series',coverUrl:COVER,source:'collection'});
  const command={...KEY,expectedDataEpoch:0,expectedDetailsCheckedAt:null,confirmed:true};
  const first=await body(await f.post(command)); assert.equal(first.changed,false); assert.equal(first.item.updatedAt,T1); assert.ok(first.item.sync?.detailsCheckedAt); assert.equal(f.outgoing.length,1);
  f.queries.length=0; const replay=await body(await f.post(command)); assert.equal(replay.item.sync?.detailsCheckedAt,first.item.sync?.detailsCheckedAt); assert.equal(f.outgoing.length,1); assert.equal(f.queries.some(sql=>sql.startsWith('UPDATE')),false);
  const explicit=await body(await f.post({...command,expectedDetailsCheckedAt:first.item.sync?.detailsCheckedAt})); assert.equal(explicit.changed,false); assert.equal(explicit.item.updatedAt,T1); assert.ok(explicit.item.sync!.detailsCheckedAt!>first.item.sync!.detailsCheckedAt!); assert.equal(f.outgoing.length,2);
});
void test('no-change browser saves return full hints and replay the previous successful check without a new timestamp', async t => {
  const f=fixture(t); f.seed('alice',{kind:'series',coverUrl:COVER,source:'collection'});
  const command={...KEY,expectedDataEpoch:0,expectedDetailsCheckedAt:null,confirmed:true,metadata:{kind:'series',coverUrl:COVER,details:{}}};
  const first=await body(await f.browser(command)); assert.equal(first.changed,false); assert.equal(first.item.updatedAt,T1); assert.ok(first.item.sync?.detailsCheckedAt); assert.ok(Object.hasOwn(first.item,'local'));
  f.queries.length=0; const replay=await body(await f.browser(command)); assert.equal(replay.item.sync?.detailsCheckedAt,first.item.sync?.detailsCheckedAt); assert.equal(f.queries.some(sql=>sql.startsWith('UPDATE')),false);
  const next=await body(await f.browser({...command,expectedDetailsCheckedAt:first.item.sync?.detailsCheckedAt})); assert.ok(next.item.sync!.detailsCheckedAt!>first.item.sync!.detailsCheckedAt!); assert.deepEqual(f.outgoing,[]);
});
void test('empty or unavailable source responses and stale collection hints cannot claim a fresh inspection', async t => {
  const f=fixture(t); f.seed(); const empty=await body(await f.browser({...KEY,expectedDataEpoch:0,expectedDetailsCheckedAt:null,confirmed:true,metadata:{kind:null,coverUrl:null,details:{}}})); assert.equal(empty.metadata.status,'unavailable'); assert.equal(empty.item.sync?.detailsCheckedAt,null);
  for(const patch of[{detailsCheckedAt:T2},{collectionHash:'a'.repeat(64)},{expectedDetailsCheckedAt:'not-a-time'}]) assert.equal((await f.post({...KEY,expectedDataEpoch:0,expectedDetailsCheckedAt:null,confirmed:true,...patch})).status,400);
  f.sqlite.prepare('UPDATE douban_items SET collection_hash=?').run('a'.repeat(64));
  f.beforeFetch(()=>f.sqlite.prepare('UPDATE douban_items SET collection_hash=?,details_checked_at=NULL').run('b'.repeat(64)));
  const stale=await f.post({...KEY,expectedDataEpoch:0,expectedDetailsCheckedAt:null,confirmed:true}); assert.equal(stale.status,409); assert.equal((await body(stale)).code,'DOUBAN_RECORD_CONFLICT'); assert.equal((await readDoubanLibraryRecord(f.db,'alice',KEY))?.sync.detailsCheckedAt,null);
});
