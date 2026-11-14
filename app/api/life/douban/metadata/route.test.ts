import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { compileFunction } from 'node:vm';
import * as store from '../../../../../db/douban-store.ts';
import * as metadataStore from '../../../../../db/douban-metadata-store.ts';
import * as model from '../../../../../lib/douban.ts';
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
  const bindings = { ...shared, ...helpers, ...store, ...model, ...sync, ...metadataStore, DoubanSourceError,
    fetchDoubanSubjectMetadata: async (domain: string, subjectId: string) => { outgoing.push({ domain, subjectId }); beforeFetch?.(); if (answer instanceof Error) throw answer; return answer; } };
  const post = load(new URL('./route.ts', import.meta.url), bindings, ['POST']).POST;
  const put = load(new URL('../classification/route.ts', import.meta.url), bindings, ['PUT']).PUT;
  function seed(owner = 'alice', patch: Partial<store.DoubanRecord> = {}) {
    const item: store.DoubanRecord = { profileId: KEY.profileId, domain: 'screen', subjectId: KEY.subjectId, kind: 'screen', title: owner + '-private-title',
      url: 'https://movie.douban.com/subject/' + KEY.subjectId + '/', coverUrl: null, rating: 5, markedDate: '2026-11-01', comment: owner + '-private-comment',
      publishedAt: null, source: 'import', observedAt: T1, createdAt: T1, updatedAt: T1, metadataCheckedRunId: null, ...patch };
    sqlite.prepare(`INSERT INTO douban_items (user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,observed_at,created_at,updated_at,metadata_checked_run_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner, item.profileId, item.domain, item.subjectId, item.kind, item.title, item.url,
      item.coverUrl, item.rating, item.markedDate, item.comment, item.publishedAt, item.source, item.observedAt, item.createdAt, item.updatedAt, item.metadataCheckedRunId);
    return item;
  }
  function request(handler: Handler, method: string, body: unknown, options: { origin?: string | null; type?: string; raw?: boolean; length?: string } = {}) {
    const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' });
    if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
    if (options.length) headers.set('Content-Length', options.length);
    return handler(new Request(ORIGIN + '/api/life/douban/' + (method === 'POST' ? 'metadata' : 'classification'), { method, headers,
      body: options.raw ? String(body) : JSON.stringify(body) }));
  }
  return { db, env, sqlite, queries, outgoing, seed,
    signIn(value: string | null) { user = value; }, metadata(value: typeof answer) { answer = value; }, beforeFetch(callback: () => void) { beforeFetch = callback; },
    post(body: unknown = { ...KEY, confirmed: true }, options?: Parameters<typeof request>[3]) { return request(post, 'POST', body, options); },
    put(body: unknown = { ...KEY, kind: 'series' }, options?: Parameters<typeof request>[3]) { return request(put, 'PUT', body, options); },
  };
}
interface ApiResponse {
  item: store.DoubanRecord; changed: boolean; metadata: { status: 'complete' | 'unavailable'; message?: string }; code?: string;
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
    assert.deepEqual(result.item, old); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM_BODY/);
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
