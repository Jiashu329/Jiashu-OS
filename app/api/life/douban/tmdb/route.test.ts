import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import * as model from '../../../../../lib/douban.ts';
import * as sourceStore from '../../../../../db/douban-store.ts';
import * as sync from '../../../../../lib/douban-sync.ts';
import * as provider from '../../../../../lib/tmdb-provider.ts';
import * as coverModel from '../../../../../lib/tmdb-cover.ts';
const ORIGIN = 'https://synthetic-tmdb.example', NOW = '2026-11-15T08:00:00.000Z';
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn{' + names.join(',') + '};', Object.keys(bindings))(...Object.values(bindings)) as Record<string, Handler>;
}
const body = { profileId: 'profile', domain: 'screen', subjectId: '1', expectedUpdatedAt: NOW, expectedDataEpoch: 0, confirmed: true };
const cover = { imdbId: 'tt1234567', mediaType: 'movie' as const, tmdbId: 42, posterPath: '/synthetic.jpg', language: 'zh' as const, matchedAt: NOW };
function fixture() {
  let user: string | null = 'alice', configured = true, status = 'matched', providerError: unknown, settingsError: unknown, readError: unknown;
  const calls: Array<{ operation: string; owner?: string; command?: unknown }> = [], db = {} as D1Database;
  const item = { ...body, kind: 'movie', details: { imdbId: cover.imdbId }, local: { note: '保留备注', revision: 2 }, cover: { mode: 'url', url: 'https://images.example.com/manual.jpg', revision: 2 }, tmdb: null as typeof cover | null, tmdbCoverUrl: null as string | null };
  const shared = load(new URL('../../../_shared.ts', import.meta.url), { getChatGPTUser: async () => user ? { userId: user } : null }, ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const helpers = load(new URL('../_shared.ts', import.meta.url), { env: { DB: db }, ...shared, ...sourceStore, ...model, ...sync }, ['doubanDatabase', 'doubanGuard', 'doubanBody', 'doubanError']);
  const handler = load(new URL('./route.ts', import.meta.url), { env: {}, ...shared, ...helpers, ...sourceStore, ...provider, ...coverModel,
    readDoubanTMDBItem: async (_db: unknown, owner: string, command: unknown) => { calls.push({ operation: 'read', owner, command }); if (readError) throw readError; return item; },
    confirmDoubanTMDBItem: async () => { calls.push({ operation: 'confirm' }); return item; },
    resolveTMDBConfiguration: async () => { calls.push({ operation: 'configuration' }); if (settingsError) throw settingsError; return configured ? { configured: true, token: 'SYNTHETIC_PRIVATE_TOKEN', revision: 1 } : { configured: false, revision: 0 }; },
    findTMDBCover: async (imdbId: string, kind: string, token: string) => { calls.push({ operation: 'lookup' }); assert.equal(imdbId, cover.imdbId); assert.equal(kind, 'movie'); assert.equal(token, 'SYNTHETIC_PRIVATE_TOKEN'); if (providerError) throw providerError; return status === 'matched' ? { status, cover } : { status }; },
    saveDoubanTMDBCover: async (_db: unknown, owner: string) => { calls.push({ operation: 'save', owner }); return { item: { ...item, tmdb: cover, tmdbCoverUrl: coverModel.tmdbCoverUrl(cover) }, changed: true }; },
  }, ['POST']).POST;
  return { calls, item, signIn(value: string | null) { user = value; }, configure(value: boolean) { configured = value; }, status(value: string) { status = value; },
    providerError(value: unknown) { providerError = value; }, settingsError(value: unknown) { settingsError = value; }, readError(value: unknown) { readError = value; },
    post(value: unknown = body, options: { origin?: string | null; type?: string; raw?: boolean; length?: string } = {}) {
      const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' }); if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN); if (options.length) headers.set('Content-Length', options.length);
      return handler(new Request(ORIGIN + '/api/life/douban/tmdb', { method: 'POST', headers, body: options.raw ? String(value) : JSON.stringify(value) }));
    } };
}
test('TMDB lookup requires login, same origin, explicit confirmation and bounded JSON', async () => {
  const f = fixture(); f.signIn(null); assert.equal((await f.post()).status, 401); f.signIn('alice');
  for (const origin of [null, 'null', 'https://other.example']) assert.equal((await f.post(body, { origin })).status, 403);
  assert.equal((await f.post(body, { type: 'text/plain' })).status, 415);
  for (const value of [null, [], {}, { ...body, confirmed: false }, { ...body, imdbId: cover.imdbId }, { ...body, userId: 'bob' }, { ...body, token: 'PRIVATE' }]) assert.equal((await f.post(value)).status, 400);
  assert.equal((await f.post('{', { raw: true })).status, 400); assert.equal((await f.post(body, { length: '4097' })).status, 413); assert.deepEqual(f.calls, []);
});
test('a matched response returns full local and manual cover fields without credentials', async () => {
  const f = fixture(), response = await f.post(); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json() as { item: typeof f.item; changed: boolean; dataEpoch: number; tmdb: { status: string } };
  assert.equal(result.tmdb.status, 'matched'); assert.equal(result.changed, true); assert.equal(result.dataEpoch, 0); assert.deepEqual(result.item.tmdb, cover);
  assert.deepEqual(result.item.local, f.item.local); assert.deepEqual(result.item.cover, f.item.cover); assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_TOKEN'), false);
  assert.deepEqual(f.calls.filter(call => call.owner).map(call => call.owner), ['alice', 'alice']);
  assert.deepEqual(f.calls[0].command, { profileId: 'profile', domain: 'screen', subjectId: '1', expectedUpdatedAt: NOW, expectedDataEpoch: 0 });
});
test('saved matches, missing IMDb and unconfigured lookup report distinct states without unnecessary remote reads', async () => {
  const cached = fixture(); cached.item.tmdb = cover; cached.item.tmdbCoverUrl = coverModel.tmdbCoverUrl(cover); assert.equal((await (await cached.post()).json() as { tmdb: { status: string } }).tmdb.status, 'matched'); assert.deepEqual(cached.calls.map(call => call.operation), ['read']);
  const missing = fixture(); missing.item.details.imdbId = ''; assert.equal((await (await missing.post()).json() as { tmdb: { status: string } }).tmdb.status, 'missing_imdb'); assert.deepEqual(missing.calls.map(call => call.operation), ['read']);
  const absent = fixture(); absent.configure(false); const result = await (await absent.post()).json() as { tmdb: { status: string }; changed: boolean };
  assert.equal(result.tmdb.status, 'not_configured'); assert.equal(result.changed, false); assert.equal(absent.calls.some(call => call.operation === 'lookup' || call.operation === 'save'), false);
});
test('no match, ambiguity, episodes and absent posters retain prior data and never claim a successful match', async () => {
  for (const status of ['no_match', 'ambiguous', 'episode_only', 'no_poster']) {
    const f = fixture(); f.status(status); const response = await f.post(), result = await response.json() as { tmdb: { status: string }; item: typeof f.item; changed: boolean };
    assert.equal(response.status, 200); assert.equal(result.tmdb.status, status); assert.equal(result.changed, false); assert.deepEqual(result.item.cover, f.item.cover); assert.equal(f.calls.some(call => call.operation === 'save'), false);
  }
});
test('rate limits, credential failures and storage conflicts expose safe actionable status', async () => {
  const limited = fixture(); limited.providerError(new provider.TMDBProviderError('TMDB_RATE_LIMITED', 120)); const response = await limited.post();
  assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '120'); const result = await response.json() as { error: string; code: string; tmdb: { status: string; retryAfter: number } };
  assert.equal(result.tmdb.status, 'rate_limited'); assert.equal(result.tmdb.retryAfter, 120); assert.equal(result.code, 'TMDB_RATE_LIMITED'); assert.ok(result.error);
  const unauthorized = fixture(); unauthorized.providerError(new provider.TMDBProviderError('TMDB_UNAUTHORIZED')); const failed = await unauthorized.post(); assert.equal(failed.status, 503); assert.equal((await failed.json() as { tmdb: { status: string } }).tmdb.status, 'unavailable');
  const config = fixture(); config.settingsError(new Error('SYNTHETIC_PRIVATE_TOKEN')); const bad = await config.post(); assert.equal(bad.status, 503); assert.equal((await bad.text()).includes('SYNTHETIC_PRIVATE_TOKEN'), false);
  const conflict = fixture(); conflict.readError(new sourceStore.DoubanStoreError('记录已更新', 'DOUBAN_RECORD_CONFLICT')); const stale = await conflict.post(); assert.equal(stale.status, 409); assert.equal((await stale.json() as { code: string }).code, 'DOUBAN_RECORD_CONFLICT'); assert.equal(conflict.calls.some(call => call.operation === 'configuration'), false);
});

test('an existing legacy match fills its persisted canonical URL without another provider call', async () => { const f=fixture(); f.item.tmdb=cover; const response=await f.post(); const result=await response.json() as {item:{tmdbCoverUrl:string};changed:boolean}; assert.equal(response.status,200); assert.equal(result.item.tmdbCoverUrl,coverModel.tmdbCoverUrl(cover)); assert.equal(result.changed,true); assert.deepEqual(f.calls.map(call=>call.operation),['read','save']); });
