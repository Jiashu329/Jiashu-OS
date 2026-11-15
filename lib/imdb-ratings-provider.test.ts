import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { IMDB_DATASET_URL, IMDB_RATING_SOURCE } from './imdb-rating.ts';
import { findIMDbRatings, IMDbRatingsProviderError } from './imdb-ratings-provider.ts';

const NOW = '2026-11-15T12:00:00.000Z', DAY = '2026-11-13', ID = 'tt0111161', OTHER = 'tt0068646', ABSENT = 'tt9999999999';
const HEADER = 'tconst\taverageRating\tnumVotes\n';
const SAFE = HEADER + ID + '\t9.3\t3000000\n';
const BINARY = { 'Content-Type': 'binary/octet-stream', 'X-Amz-Meta-Run-Date': DAY };
function response(text = SAFE, headers: Record<string, string> = {}, chunkBytes?: number) {
  const compressed = gzipSync(text);
  const body = chunkBytes === undefined ? compressed : new ReadableStream<Uint8Array>({
    start(sink) { for (let offset = 0; offset < compressed.length; offset += chunkBytes) sink.enqueue(compressed.subarray(offset, offset + chunkBytes)); sink.close(); },
  });
  return new Response(body, { headers: { ...BINARY, 'Content-Length': String(compressed.length), ...headers } });
}
function fixture(value: Response) {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  return { calls, fetcher: (async (input: string | URL | Request, options?: RequestInit) => { calls.push({ url: String(input), options }); return value; }) as typeof fetch };
}
const unavailable = (error: unknown) => error instanceof IMDbRatingsProviderError && error.code === 'IMDB_UNAVAILABLE' && error.status === 503 && !error.message.includes('PRIVATE_UPSTREAM');

test('a single fixed-host gzip scan returns only requested IDs in input order with source provenance and no credentials', async () => {
  const f = fixture(response(HEADER + ID + '\t9.3\t3000000\n' + OTHER + '\t9.2\t2000000\n' + 'tt0000001\t5.7\t2240\n', {}, 3));
  const result = await findIMDbRatings([OTHER, ID, ABSENT, ID], { ...f, now: NOW });
  assert.deepEqual(result, { ratings: [
    { imdbId: OTHER, rating: 9.2, ratingCount: 2000000, source: IMDB_RATING_SOURCE, checkedAt: NOW, datasetDate: DAY },
    { imdbId: ID, rating: 9.3, ratingCount: 3000000, source: IMDB_RATING_SOURCE, checkedAt: NOW, datasetDate: DAY },
  ], missingIds: [ABSENT], checkedAt: NOW, datasetDate: DAY });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, IMDB_DATASET_URL);
  const options = f.calls[0].options!, headers = new Headers(options.headers);
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
  assert.equal(headers.has('Cookie'), false); assert.equal(headers.has('Authorization'), false); assert.equal(headers.get('Accept-Encoding'), 'identity');
});

test('empty batches do not read the dataset and invalid IDs, oversized batches and noncanonical clocks fail before fetch', async () => {
  const f = fixture(response());
  assert.deepEqual(await findIMDbRatings([], { ...f, now: NOW }), { ratings: [], missingIds: [], checkedAt: NOW, datasetDate: null });
  for (const ids of [['tt12'], ['https://private.example/title'], [ID, 'tt1234567?x=PRIVATE_UPSTREAM'], new Array<string>(2), Array.from({ length: 5001 }, () => ID)]) {
    await assert.rejects(findIMDbRatings(ids, { ...f, now: NOW }), unavailable);
  }
  for (const now of ['2026-11-15', '2026-02-30T12:00:00.000Z', '2026-11-15T12:00:00Z']) await assert.rejects(findIMDbRatings([ID], { ...f, now }), unavailable);
  for (const timeoutMs of [0, NaN, Infinity, 45001]) await assert.rejects(findIMDbRatings([ID], { ...f, now: NOW, timeoutMs }), unavailable);
  assert.equal(f.calls.length, 0);
});

test('missing values remain missing and canonical LF or CRLF final rows need no fabricated zero rating', async () => {
  const f = fixture(response((HEADER + ID + '\t\\N\t500\n' + OTHER + '\t9.2\t\\N').replaceAll('\n', '\r\n'), {}, 1));
  const result = await findIMDbRatings([ID, OTHER, ABSENT], { ...f, now: NOW });
  assert.deepEqual(result.ratings, []); assert.deepEqual(result.missingIds, [ID, OTHER, ABSENT]);
  const noFinalNewline = fixture(response(SAFE.trimEnd()));
  assert.equal((await findIMDbRatings([ID], { ...noFinalNewline, now: NOW })).ratings[0].rating, 9.3);
});

test('dataset dates use the declared run date, safely fall back to modification time, or stay unknown', async () => {
  for (const [headers, expected] of [[{ 'Last-Modified': 'Sat, 14 Nov 2026 00:43:20 GMT' }, '2026-11-14'], [{}, null]] as const) {
    const value = response(); value.headers.delete('X-Amz-Meta-Run-Date');
    for (const [key, content] of Object.entries(headers)) value.headers.set(key, content);
    assert.equal((await findIMDbRatings([ID], { ...fixture(value), now: NOW })).datasetDate, expected);
  }
  for (const date of ['2026-02-30', '2026-11-16', 'PRIVATE_UPSTREAM']) await assert.rejects(findIMDbRatings([ID], { ...fixture(response(SAFE, { 'X-Amz-Meta-Run-Date': date })), now: NOW }), unavailable);
});

test('malformed TSV, duplicate target rows, invalid UTF-8 and overlong byte lines never return an earlier successful match', async () => {
  const failures = [HEADER, SAFE + 'malformed\n', SAFE + ID + '\t8.0\t100\n', HEADER.replace('averageRating', 'TMDB_rating') + ID + '\t9.3\t100\n',
    HEADER + ID + '\t0\t10\n', HEADER + ID + '\t10.1\t10\n', HEADER + ID + '\t9.3\t0\n', HEADER + ID + '\t9.3\t9007199254740992\n',
    SAFE + 't'.repeat(257) + '\n', '\ufeff' + SAFE];
  for (const text of failures) await assert.rejects(findIMDbRatings([ID], { ...fixture(response(text)), now: NOW }), unavailable);
  const invalidUTF8 = gzipSync(Buffer.concat([Buffer.from(SAFE), Uint8Array.from([0xc3, 0x28])]));
  await assert.rejects(findIMDbRatings([ID], { ...fixture(new Response(invalidUTF8, { headers: BINARY })), now: NOW }), unavailable);
});

test('gzip CRC, complete EOF and declared compressed length are verified after targets have already matched', async () => {
  const valid = gzipSync(SAFE), corruptCRC = Buffer.from(valid); corruptCRC[corruptCRC.length - 8] ^= 1;
  for (const bytes of [valid.subarray(0, valid.length - 4), corruptCRC, Buffer.concat([valid, Buffer.from('PRIVATE_UPSTREAM')])]) {
    await assert.rejects(findIMDbRatings([ID], { ...fixture(new Response(bytes, { headers: BINARY })), now: NOW }), unavailable);
  }
  await assert.rejects(findIMDbRatings([ID], { ...fixture(response(SAFE, { 'Content-Length': '1' })), now: NOW }), unavailable);
});

test('redirects, HTTP errors, unexpected content types and compressed size metadata stay inside the fixed source boundary', async () => {
  const failures = [new Response('PRIVATE_UPSTREAM', { status: 302, headers: { Location: 'https://private.example/ratings' } }),
    new Response('PRIVATE_UPSTREAM', { status: 403 }), new Response('PRIVATE_UPSTREAM', { status: 503 }),
    response(SAFE, { 'Content-Type': 'text/html' }), response(SAFE, { 'Content-Encoding': 'gzip' }),
    response(SAFE, { 'Content-Length': String(16 * 1024 * 1024 + 1) }), response(SAFE, { 'Content-Length': 'unknown' })];
  for (const value of failures) { const f = fixture(value); await assert.rejects(findIMDbRatings([ID], { ...f, now: NOW }), unavailable); assert.equal(f.calls.length, 1); }
});

test('rate limits expose only bounded safe retry instructions and never reflect upstream text', async () => {
  for (const [header, seconds] of [['120', 120], ['9999999999', 3600], ['Sun, 15 Nov 2026 12:02:00 GMT', 120], ['PRIVATE_UPSTREAM', 60]] as const) {
    const f = fixture(new Response('PRIVATE_UPSTREAM', { status: 429, headers: { 'Retry-After': header } }));
    await assert.rejects(findIMDbRatings([ID], { ...f, now: NOW }), (error: unknown) => error instanceof IMDbRatingsProviderError && error.status === 429
      && error.code === 'IMDB_RATE_LIMITED' && error.retryAfter === seconds && !error.message.includes('PRIVATE_UPSTREAM'));
  }
});

test('the total deadline bounds an uncooperative fetch and cancellation releases a stalled body without partial results', async () => {
  let fetchSignal: AbortSignal | null | undefined;
  const ignoreAbort = (async (_url: unknown, options?: RequestInit) => { fetchSignal = options?.signal; return new Promise<Response>(() => {}); }) as typeof fetch;
  await assert.rejects(findIMDbRatings([ID], { fetcher: ignoreAbort, now: NOW, timeoutMs: 5 }), unavailable);
  assert.equal(fetchSignal?.aborted, true);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(sink) { sink.enqueue(gzipSync(SAFE).subarray(0, 12)); }, cancel() { cancelled = true; } });
  await assert.rejects(findIMDbRatings([ID], { ...fixture(new Response(body, { headers: BINARY })), now: NOW, timeoutMs: 10 }), unavailable);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(cancelled, true);
  const signal = new AbortController(); signal.abort(); const f = fixture(response());
  await assert.rejects(findIMDbRatings([ID], { ...f, now: NOW, signal: signal.signal }), unavailable); assert.equal(f.calls.length, 0);
});

test('an external cancellation also releases an active dataset stream without returning the matches seen so far', async () => {
  const signal = new AbortController(); let cancelled = false, ready!: () => void;
  const pulling = new Promise<void>(resolve => { ready = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { ready(); return new Promise<void>(() => {}); }, cancel() { cancelled = true; } });
  const pending = findIMDbRatings([ID], { ...fixture(new Response(body, { headers: BINARY })), now: NOW, signal: signal.signal });
  await pulling; await Promise.resolve(); signal.abort(); await assert.rejects(pending, unavailable);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(cancelled, true);
});

test('an undeclared compressed stream is cancelled at its byte cap before an unbounded gzip header can consume it', async () => {
  let sent = 0, cancelled = false;
  // Gzip's optional filename can have arbitrary length; no decompressed line exists to trigger the later limits.
  const body = new ReadableStream<Uint8Array>({
    start(sink) { sink.enqueue(Uint8Array.from([31, 139, 8, 8, 0, 0, 0, 0, 0, 3])); },
    pull(sink) { const bytes = new Uint8Array(65536).fill(120); sent += bytes.byteLength; sink.enqueue(bytes); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(findIMDbRatings([ID], { ...fixture(new Response(body, { headers: BINARY })), now: NOW }), unavailable);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(sent >= 16 * 1024 * 1024); assert.ok(sent <= 16 * 1024 * 1024 + 3 * 65536); assert.equal(cancelled, true);
});

test('the decoded-size cap rejects a streaming gzip bomb without retaining the full table', async () => {
  const line = 'tt0000001\t5.7\t2240\n', chunk = new TextEncoder().encode(line.repeat(4096));
  let sent = 0;
  const body = new ReadableStream<BufferSource>({
    start(sink) { sink.enqueue(new TextEncoder().encode(HEADER)); },
    pull(sink) { if (sent >= 64 * 1024 * 1024) { sink.close(); return; } sent += chunk.byteLength; sink.enqueue(chunk); },
  }).pipeThrough(new CompressionStream('gzip'));
  await assert.rejects(findIMDbRatings([ID], { ...fixture(new Response(body, { headers: BINARY })), now: NOW }), unavailable);
  assert.ok(sent <= 64 * 1024 * 1024 + chunk.byteLength);
});
