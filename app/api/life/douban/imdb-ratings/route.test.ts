import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import * as model from '../../../../../lib/douban.ts';
import * as sourceStore from '../../../../../db/douban-store.ts';
import * as sync from '../../../../../lib/douban-sync.ts';
import * as ratingsStore from '../../../../../db/douban-imdb-ratings-store.ts';
import * as provider from '../../../../../lib/imdb-ratings-provider.ts';

const ORIGIN = 'https://synthetic-imdb-ratings.example', NOW = '2026-11-15T08:00:00.000Z';
const REQUEST_ID = 'bbaaaaaa-bbbb-4ccc-8ddd-111111111111';
const entry = { profileId: 'profile', domain: 'screen' as const, subjectId: '1', expectedUpdatedAt: NOW, expectedImdbId: 'tt1234567' };
const body = { requestId: REQUEST_ID, expectedDataEpoch: 0, confirmed: true, items: [entry] };
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn{' + names.join(',') + '};', Object.keys(bindings))(...Object.values(bindings)) as Record<string, Handler>;
}
function fixture() {
  let user: string | null = 'alice', failure: unknown;
  const calls: Array<{ owner: string; command: Record<string, unknown> }> = [], db = {} as D1Database;
  const item = { profileId: entry.profileId, domain: entry.domain, subjectId: entry.subjectId, kind: 'movie', title: '合成电影',
    coverUrl: 'https://img1.doubanio.com/view/photo/public/p1.jpg', rating: 4, updatedAt: NOW,
    details: { imdbId: entry.expectedImdbId, doubanRating: 9.2, ratingCount: 7654 },
    local: { note: '保留个人备注', tags: ['保留标签'], hidden: false, revision: 3 },
    cover: { mode: 'url', url: 'https://images.example.com/fallback.jpg', revision: 3 },
    tmdbCoverUrl: 'https://image.tmdb.org/t/p/w500/synthetic.jpg',
    imdb: { imdbId: entry.expectedImdbId, rating: 8.1, ratingCount: 12345, source: 'imdb-datasets', checkedAt: NOW, datasetDate: '2026-11-14' } };
  const result = { items: [item], dataEpoch: 0,
    receipt: { requestId: REQUEST_ID, requested: 1, updated: 1, missing: 0, checkedAt: NOW },
    ratings: { status: 'complete', source: 'imdb-datasets' } };
  const shared = load(new URL('../../../_shared.ts', import.meta.url), { getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => user ? { userId: user } : null }, ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const helpers = load(new URL('../_shared.ts', import.meta.url), { env: { DB: db }, ...shared, ...sourceStore, ...model, ...sync }, ['doubanDatabase', 'doubanGuard', 'doubanBody', 'doubanError']);
  const handler = load(new URL('./route.ts', import.meta.url), { env: {}, ...shared, ...helpers, ...sourceStore, ...ratingsStore, ...provider,
    syncDoubanIMDbRatings: async (database: unknown, owner: string, command: Record<string, unknown>) => {
      assert.equal(database, db); calls.push({ owner, command }); if (failure) throw failure; return result;
    },
  }, ['POST']).POST;
  return { calls, item, result, signIn(value: string | null) { user = value; }, fail(value: unknown) { failure = value; },
    post(value: unknown = body, options: { origin?: string | null; type?: string; raw?: boolean; length?: string; bytes?: Uint8Array } = {}) {
      const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' });
      if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
      if (options.length) headers.set('Content-Length', options.length);
      return handler(new Request(ORIGIN + '/api/life/douban/imdb-ratings', { method: 'POST', headers,
        body: options.bytes ? new Uint8Array(options.bytes) : options.raw ? String(value) : JSON.stringify(value) }));
    } };
}

test('IMDb ratings require login, same origin and JSON before any batch storage work', async () => {
  const f = fixture(); f.signIn(null); assert.equal((await f.post()).status, 401); f.signIn('alice');
  for (const origin of [null, 'null', 'https://other.example']) assert.equal((await f.post(body, { origin })).status, 403);
  assert.equal((await f.post(body, { type: 'text/plain' })).status, 415);
  assert.deepEqual(f.calls, []);
});

test('rating requests identify saved works and reject browser supplied ratings, providers and credentials', async () => {
  const f = fixture();
  const invalid = [null, [], {}, { ...body, confirmed: false }, { ...body, userId: 'bob' }, { ...body, token: 'NEVER-READ-A-TOKEN' },
    { ...body, rating: 10 }, { ...body, source: 'tmdb' }, { ...body, items: [] },
    { ...body, requestId: 'not-a-request-id' }, { ...body, expectedDataEpoch: -1 },
    { ...body, items: [entry, entry] },
    { ...body, items: Array.from({ length: 51 }, (_, i) => ({ ...entry, subjectId: String(i + 1) })) },
    ...[{ expectedImdbId: 'tt1' }, { domain: 'book' }, { expectedUpdatedAt: '2026-11-15' }, { rating: 9.9 }, { providerUrl: 'https://other.example/' }, { expectedImdbId: null }]
      .map(change => ({ ...body, items: [{ ...entry, ...change }] })),
  ];
  for (const value of invalid) assert.equal((await f.post(value)).status, 400, JSON.stringify(value));
  assert.deepEqual(f.calls, []);
});

test('the rating body limit counts actual bytes and rejects malformed UTF-8 or JSON before writes', async () => {
  const f = fixture();
  assert.equal((await f.post('{', { raw: true })).status, 400);
  assert.equal((await f.post('', { bytes: new Uint8Array([0xff, 0xfe]) })).status, 400);
  assert.equal((await f.post(body, { length: '32769' })).status, 413);
  assert.equal((await f.post(' '.repeat(32769), { raw: true })).status, 413);
  assert.equal((await f.post('界'.repeat(11000), { raw: true, length: '1' })).status, 413);
  assert.deepEqual(f.calls, []);
});

test('the authenticated owner scopes the batch and receives separate source ratings and full personal fields', async () => {
  const f = fixture(), response = await f.post(); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  const result = await response.json() as typeof f.result;
  assert.deepEqual(result, f.result);
  assert.equal(result.items[0].rating, 4); assert.equal(result.items[0].details.doubanRating, 9.2); assert.equal(result.items[0].imdb.rating, 8.1);
  assert.equal(result.items[0].imdb.source, 'imdb-datasets'); assert.equal(result.items[0].tmdbCoverUrl, f.item.tmdbCoverUrl);
  assert.deepEqual(result.items[0].local, f.item.local); assert.deepEqual(result.items[0].cover, f.item.cover);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].owner, 'alice');
  assert.equal(f.calls[0].command.requestId, REQUEST_ID); assert.equal(f.calls[0].command.expectedDataEpoch, 0);
  assert.deepEqual(f.calls[0].command.items, [entry]);
  const other = fixture(); other.signIn('bob'); assert.equal((await other.post()).status, 200); assert.equal(other.calls[0].owner, 'bob');
});

test('IMDb limits, unavailable sources and version conflicts return safe errors without claiming saved ratings', async () => {
  const limited = fixture(); limited.fail(new provider.IMDbRatingsProviderError('IMDB_RATE_LIMITED', 120));
  const response = await limited.post(); assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '120');
  const data = await response.json() as { error: string; code: string; items?: unknown; receipt?: unknown };
  assert.equal(data.code, 'IMDB_RATE_LIMITED'); assert.ok(data.error); assert.equal(data.items, undefined); assert.equal(data.receipt, undefined);
  const busy = fixture(); busy.fail(new ratingsStore.IMDbRatingsRefreshBusyError());
  const waiting = await busy.post(); assert.equal(waiting.status, 429); assert.equal(waiting.headers.get('Retry-After'), '10');
  assert.equal((await waiting.json() as { code: string }).code, 'IMDB_REFRESH_BUSY');
  const unavailable = fixture(); unavailable.fail(new provider.IMDbRatingsProviderError('IMDB_UNAVAILABLE'));
  const absent = await unavailable.post(); assert.equal(absent.status, 503); assert.equal((await absent.json() as { code: string }).code, 'IMDB_UNAVAILABLE');
  const privateFailure = fixture(); privateFailure.fail(new Error('SYNTHETIC_PRIVATE_INTERNAL_DATABASE_TEXT'));
  const failed = await privateFailure.post(); assert.equal(failed.status, 503); assert.equal((await failed.text()).includes('SYNTHETIC_PRIVATE_INTERNAL_DATABASE_TEXT'), false);
  for (const code of ['DOUBAN_DATA_EPOCH_CONFLICT', 'DOUBAN_RECORD_CONFLICT']) {
    const stale = fixture(); stale.fail(new sourceStore.DoubanStoreError('请重新读取后操作。', code));
    const result = await stale.post(); assert.equal(result.status, 409); assert.equal((await result.json() as { code: string }).code, code);
  }
});
