import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTMDBCover, serializeTMDBCover, tmdbCoverUrl } from './tmdb-cover.ts';
import { checkTMDBToken, findTMDBCover, TMDBProviderError } from './tmdb-provider.ts';

const TOKEN = 'synthetic-read-access-token', NOW = '2026-11-15T12:00:00.000Z', IMDb = 'tt1234567';
const cover = { imdbId: IMDb, mediaType: 'movie' as const, tmdbId: 42, posterPath: '/syntheticPoster.jpg', language: 'zh' as const, matchedAt: NOW };
const found = (movies: number[] = [42], series: number[] = [], episodes: number[] = []) => ({ movie_results: movies.map(id => ({ id })), tv_results: series.map(id => ({ id })), tv_episode_results: episodes.map(id => ({ id })) });
const image = (file_path = '/syntheticPoster.jpg', iso_639_1: string | null = 'zh', width = 1000, height = 1500) => ({ file_path, iso_639_1, width, height, vote_count: 4, vote_average: 8 });
function fixture(payloads: unknown[]) {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  return { calls, fetcher: (async (input: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(input), options }); const payload = payloads.shift();
    return payload instanceof Response ? payload : Response.json(payload);
  }) as typeof fetch };
}
test('portable matches reject arbitrary URLs, traversal, untrusted fields and invalid identifiers', () => {
  assert.deepEqual(parseTMDBCover({}), null); assert.deepEqual(parseTMDBCover(cover), cover);
  assert.equal(serializeTMDBCover({ ...cover }), JSON.stringify(cover));
  assert.equal(tmdbCoverUrl(cover), 'https://image.tmdb.org/t/p/w500/syntheticPoster.jpg');
  for (const value of [null, [], { ...cover, url: 'https://other.example/a.jpg' }, { ...cover, posterPath: '//host/a.jpg' }, { ...cover, posterPath: '/../a.jpg' },
    { ...cover, posterPath: '/a.jpg?token=secret' }, { ...cover, tmdbId: 0 }, { ...cover, tmdbId: '42' }, { ...cover, imdbId: 'tt123' }, { ...cover, language: 'fr' }, { ...cover, matchedAt: '2026-11-15' }]) {
    assert.throws(() => parseTMDBCover(value), TypeError);
  }
});
test('a unique IMDb match uses fixed authenticated HTTPS requests and prefers suitable Chinese posters', async () => {
  const f = fixture([found(), { posters: [image('/english.jpg', 'en'), image('/tiny.jpg', 'zh', 100, 150), image('/chinese.jpg', 'zh', 600, 900), image('/neutral.jpg', null)] }]);
  const result = await findTMDBCover(IMDb, 'movie', TOKEN, { ...f, now: NOW });
  assert.deepEqual(result, { status: 'matched', cover: { ...cover, posterPath: '/chinese.jpg' } });
  assert.deepEqual(f.calls.map(call => call.url), ['https://api.themoviedb.org/3/find/tt1234567?external_source=imdb_id&language=zh-CN', 'https://api.themoviedb.org/3/movie/42/images?include_image_language=zh,en,null']);
  for (const call of f.calls) {
    const headers = new Headers(call.options?.headers); assert.equal(headers.get('Authorization'), 'Bearer ' + TOKEN); assert.equal(headers.has('Cookie'), false);
    assert.equal(call.options?.redirect, 'manual'); assert.equal(call.options?.credentials, 'omit'); assert.equal(call.url.includes(TOKEN), false);
  }
});
test('TV lookup, English and neutral fallbacks work without accepting paths or unsupported languages', async () => {
  for (const language of ['en', null] as const) {
    const f = fixture([found([], [17]), { posters: [image('https://attacker.example/poster.jpg', 'zh'), image('/french.jpg', 'fr'), image('/chosen.png', language)] }]);
    const result = await findTMDBCover(IMDb, 'series', TOKEN, { ...f, now: NOW });
    assert.equal(result.status, 'matched'); if (result.status === 'matched') { assert.equal(result.cover.mediaType, 'tv'); assert.equal(result.cover.language, language); }
    assert.match(f.calls[1].url, /\/tv\/17\/images/);
  }
});
test('absent, ambiguous, episode-only and wrong-kind results never trigger poster lookup', async () => {
  for (const [payload, kind, status] of [[found([], [], []), 'screen', 'no_match'], [found([42, 43]), 'movie', 'ambiguous'], [found([42], [17]), 'screen', 'ambiguous'],
    [found([], [], [9]), 'series', 'episode_only'], [found([42], [], [9]), 'movie', 'ambiguous'], [found([], [17]), 'movie', 'no_match']] as const) {
    const f = fixture([payload]); assert.deepEqual(await findTMDBCover(IMDb, kind, TOKEN, f), { status }); assert.equal(f.calls.length, 1);
  }
  const f = fixture([found(), { posters: [image('/too-small.jpg', 'zh', 200, 300)] }]);
  assert.deepEqual(await findTMDBCover(IMDb, 'movie', TOKEN, f), { status: 'no_poster' });
});
test('rate limits preserve bounded retry instructions without exposing upstream text or credentials', async () => {
  for (const [header, delay] of [['120', 120], ['999999999', 3600], ['invalid', 60]] as const) {
    const f = fixture([new Response(TOKEN + ' PRIVATE_UPSTREAM', { status: 429, headers: { 'Retry-After': header } })]);
    await assert.rejects(findTMDBCover(IMDb, 'movie', TOKEN, f), (error: unknown) => error instanceof TMDBProviderError && error.code === 'TMDB_RATE_LIMITED' && error.retryAfter === delay && !error.message.includes(TOKEN));
  }
});
test('redirects, non-JSON, oversized and malformed responses stay inside the fixed boundary', async () => {
  const failures = [new Response('', { status: 302, headers: { Location: 'https://attacker.example/token' } }), new Response('<html>PRIVATE</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024 + 1) } }), new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{PRIVATE', { headers: { 'Content-Type': 'application/json' } }), Response.json({ movie_results: [{ id: '42' }], tv_results: [] })];
  for (const response of failures) {
    const f = fixture([response]); await assert.rejects(findTMDBCover(IMDb, 'movie', TOKEN, f), { code: 'TMDB_UNAVAILABLE' }); assert.equal(f.calls.length, 1);
  }
  const f = fixture([new Response('PRIVATE', { status: 401 })]); await assert.rejects(findTMDBCover(IMDb, 'movie', TOKEN, f), { code: 'TMDB_UNAUTHORIZED' });
});
test('connection checks only public configuration and timeout errors are sanitized', async () => {
  const f = fixture([{ images: { secure_base_url: 'https://image.tmdb.org/t/p/', poster_sizes: ['w500', 'original'] } }]);
  await checkTMDBToken(TOKEN, f); assert.equal(f.calls[0].url, 'https://api.themoviedb.org/3/configuration');
  const bad = fixture([{ images: { secure_base_url: 'https://attacker.example/', poster_sizes: ['w500'] } }]);
  await assert.rejects(checkTMDBToken(TOKEN, bad), { code: 'TMDB_UNAVAILABLE' });
  const fetcher = (async (_input: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error(TOKEN))))) as typeof fetch;
  await assert.rejects(checkTMDBToken(TOKEN, { fetcher, timeoutMs: 2 }), (error: unknown) => error instanceof TMDBProviderError && error.code === 'TMDB_UNAVAILABLE' && !error.message.includes(TOKEN));
});
