import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import * as model from '../../../../../lib/douban.ts';
import { DoubanCoverError } from '../../../../../lib/douban-cover.ts';
import { DoubanStoreError, type DoubanRecordKey } from '../../../../../db/douban-store.ts';
import { DoubanSyncError } from '../../../../../lib/douban-sync.ts';

const ORIGIN = 'https://synthetic-cover.example';
const CDN = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn {' + names.join(',') + '};', Object.keys(bindings))(...Object.values(bindings)) as Record<string, Handler>;
}
function fixture() {
  let user: string | null = 'alice', storageFailure = false, coverFailure: unknown;
  const records = new Map<string, { coverUrl: string | null; source: string }>();
  const lookups: Array<{ owner: string; key: DoubanRecordKey }> = [], requests: string[] = [];
  const warnings: unknown[][] = [];
  const db = {} as D1Database;
  const shared = load(new URL('../../../_shared.ts', import.meta.url), { getChatGPTUser: async () => user ? { userId: user } : null },
    ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const helpers = load(new URL('../_shared.ts', import.meta.url), { env: { DB: db }, ...shared, ...model, DoubanStoreError, DoubanSyncError }, ['doubanDatabase', 'doubanError']);
  const handler = load(new URL('./route.ts', import.meta.url), { ...shared, ...helpers, ...model, DoubanCoverError,
    console: { warn(...values: unknown[]) { warnings.push(values); } },
    readDoubanRecord: async (database: D1Database, owner: string, key: DoubanRecordKey) => {
      assert.equal(database, db); lookups.push({ owner, key }); if (storageFailure) throw new Error('PRIVATE_STORAGE_CONTENT');
      return records.get([owner, key.profileId, key.domain, key.subjectId].join(':')) ?? null;
    },
    fetchDoubanCover: async (url: string, options: { signal: AbortSignal }) => {
      requests.push(url); assert.ok(options.signal instanceof AbortSignal); if (coverFailure) throw coverFailure;
      return { bytes: PNG.buffer, contentType: 'image/png' };
    },
  }, ['GET']).GET;
  return { lookups, requests, warnings,
    signIn(value: string | null) { user = value; },
    add(owner = 'alice', coverUrl: string | null = CDN, source = 'collection', key = { profileId: 'profile', domain: 'screen', subjectId: '1' }) {
      records.set([owner, key.profileId, key.domain, key.subjectId].join(':'), { coverUrl, source });
    },
    failStorage() { storageFailure = true; }, failCover(error: unknown) { coverFailure = error; },
    get(query = 'profileId=profile&domain=screen&subjectId=1', headers: Record<string, string> = {}) {
      return handler(new Request(ORIGIN + '/api/life/douban/cover?' + query, { headers }));
    },
  };
}

void test('covers require login and reject explicit cross-origin requests before reading records or contacting the provider', async () => {
  const f = fixture(); f.add(); f.signIn(null);
  assert.equal((await f.get()).status, 401); f.signIn('alice');
  const crossOrigins: Array<Record<string, string>> = [{ Origin: 'https://other.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }];
  for (const headers of crossOrigins) {
    assert.equal((await f.get(undefined, headers)).status, 403);
  }
  assert.deepEqual(f.lookups, []); assert.deepEqual(f.requests, []);
});

void test('cover parameters identify a canonical saved record and cannot supply arbitrary URLs, users or ambiguous duplicate keys', async () => {
  const f = fixture(); f.add();
  for (const query of ['', 'domain=screen&subjectId=1', 'profileId=profile&domain=movie&subjectId=1',
    'profileId=profile&domain=screen&subjectId=../1', 'profileId=profile&domain=screen&subjectId=1&subjectId=2',
    'profileId=profile&domain=screen&subjectId=1&url=http%3A%2F%2Flocalhost%2F',
    'profileId=profile&domain=screen&subjectId=1&userId=bob']) {
    assert.equal((await f.get(query)).status, 400, query);
  }
  assert.deepEqual(f.lookups, []); assert.deepEqual(f.requests, []);
});

void test('foreign owner, profile or domain keys are indistinguishable from missing images and never fetch a cover', async () => {
  const f = fixture(); f.add('bob');
  assert.equal((await f.get()).status, 404);
  f.add('alice', CDN, 'collection', { profileId: 'other', domain: 'book', subjectId: '1' });
  assert.equal((await f.get()).status, 404);
  f.add('alice', null);
  assert.equal((await f.get()).status, 404);
  assert.deepEqual(f.requests, []);
  assert.ok(f.lookups.every(lookup => lookup.owner === 'alice'));
});

void test('owned collection, RSS and imported covers are served as private same-origin image bytes without any metadata lookup', async () => {
  for (const source of ['collection', 'rss', 'import']) {
    const f = fixture(); f.add('alice', CDN, source);
    const response = await f.get(undefined, { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(response.headers.get('Content-Length'), String(PNG.byteLength));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
    assert.deepEqual(f.requests, [CDN]); assert.deepEqual(f.lookups, [{ owner: 'alice', key: { profileId: 'profile', domain: 'screen', subjectId: '1' } }]);
  }
});

void test('provider format failures, timeouts and storage errors use safe local responses for image fallback', async () => {
  const f = fixture(); f.add();
  f.failCover(new DoubanCoverError('封面读取超时。', 'DOUBAN_COVER_TIMEOUT', 504));
  let response = await f.get(); assert.equal(response.status, 504); assert.equal((await response.json() as { code: string }).code, 'DOUBAN_COVER_TIMEOUT');
  f.failCover(new DoubanCoverError('封面暂时无法读取。', 'DOUBAN_COVER_INVALID_IMAGE', 502));
  response = await f.get(); assert.equal(response.status, 502);
  f.failStorage(); response = await f.get(); assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /PRIVATE_STORAGE_CONTENT|img1\.doubanio\.com/);
});

void test('rate-limited covers return the fixed safe diagnostic and retry delay while every image response remains owner-checked and uncached', async () => {
  const f = fixture(); f.add();
  f.failCover(new DoubanCoverError('豆瓣图片暂时限制读取频率。', 'DOUBAN_COVER_RATE_LIMITED', 429, 17));
  const response = await f.get(); assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '17'); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await response.json() as { code: string }).code, 'DOUBAN_COVER_RATE_LIMITED'); assert.equal(f.lookups.length, 1); assert.equal(f.requests.length, 1);
  f.signIn('bob'); assert.equal((await f.get()).status, 404); assert.equal(f.requests.length, 1, 'a different actor cannot use the first actor’s saved cover');
});

void test('upstream cover diagnostics log only a fixed event, allowlisted code and internal response status', async () => {
  const f = fixture(), profileId = 'PRIVATE_PROFILE', owner = 'PRIVATE_OWNER';
  f.signIn(owner); f.add(owner, CDN, 'import', { profileId, domain: 'screen', subjectId: '1' });
  const failures = [
    ['DOUBAN_COVER_NETWORK', 502], ['DOUBAN_COVER_BLOCKED', 502], ['DOUBAN_COVER_REDIRECT', 502],
    ['DOUBAN_COVER_UPSTREAM_ERROR', 502], ['DOUBAN_COVER_INVALID_IMAGE', 502], ['DOUBAN_COVER_TOO_LARGE', 502],
    ['DOUBAN_COVER_UPSTREAM_NOT_FOUND', 404], ['DOUBAN_COVER_RATE_LIMITED', 429], ['DOUBAN_COVER_TIMEOUT', 504],
  ] as const;
  for (const [code, status] of failures) {
    f.failCover(Object.assign(new DoubanCoverError('PRIVATE_UPSTREAM_TEXT ' + CDN, code, status), { url: CDN, profileId, userId: owner, body: 'PRIVATE_RAW_BODY' }));
    assert.equal((await f.get('profileId=' + profileId + '&domain=screen&subjectId=1')).status, status);
  }
  assert.deepEqual(f.warnings, failures.map(([code, status]) => [JSON.stringify({ event: 'douban_cover_failed', code, status })]));
  assert.doesNotMatch(JSON.stringify(f.warnings), /PRIVATE_|img1|doubanio|https:|subjectId|profileId|userId|stack|message|body/);
});

void test('cover diagnostics omit success, access checks, local validation, cancellation and unrecognized errors', async () => {
  const f = fixture(); f.add();
  assert.equal((await f.get()).status, 200);
  f.signIn(null); assert.equal((await f.get()).status, 401); f.signIn('alice');
  assert.equal((await f.get(undefined, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await f.get('profileId=profile&domain=screen&subjectId=1&userId=bob')).status, 400);
  f.signIn('bob'); assert.equal((await f.get()).status, 404); f.signIn('alice');
  f.add('alice', null); assert.equal((await f.get()).status, 404); f.add();
  for (const [code, status] of [['DOUBAN_COVER_URL_REJECTED', 502], ['DOUBAN_COVER_MISSING', 404], ['DOUBAN_COVER_ABORTED', 499], ['PRIVATE_UNKNOWN_CODE', 502]] as const) {
    f.failCover(new DoubanCoverError('PRIVATE_UPSTREAM_TEXT', code, status)); assert.equal((await f.get()).status, status);
  }
  f.failCover(new Error('PRIVATE_UNEXPECTED_ERROR')); assert.equal((await f.get()).status, 503);
  f.failStorage(); assert.equal((await f.get()).status, 503);
  assert.deepEqual(f.warnings, []);
});
