import assert from 'node:assert/strict';
import test from 'node:test';
import { DOUBAN_COVER_MAX_BYTES, DoubanCoverError, fetchDoubanCover } from './douban-cover.ts';
import { TINY_JPEG_DATA_URL } from '../tests/fixtures/nutrition-photo.ts';

const URL = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const jpeg = Uint8Array.from(Buffer.from(TINY_JPEG_DATA_URL.split(',')[1], 'base64'));
function imageResponse(bytes: Uint8Array, type = 'image/png', headers: Record<string, string> = {}) {
  return new Response(Uint8Array.from(bytes).buffer, { headers: { 'Content-Type': type, ...headers } });
}
const errorCode = (code: string) => (error: unknown) => error instanceof DoubanCoverError && error.code === code;

test('cover requests normalize an official stored CDN URL, send no account credentials, and accept matching supported image signatures', async () => {
  const images: Array<{ bytes: Uint8Array; type: string }> = [
    { bytes: png, type: 'image/png' }, { bytes: jpeg, type: 'image/jpeg' },
    { bytes: Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')), type: 'image/gif' },
    { bytes: Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]), type: 'image/webp' },
  ];
  for (const sample of images) {
    let requests = 0;
    const result = await fetchDoubanCover(URL.replace('https:', 'http:'), { fetch: async (url, options) => {
      requests++; assert.equal(url, URL); assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'manual');
      assert.equal(options?.credentials, 'omit'); assert.ok(options?.signal instanceof AbortSignal);
      const headers = new Headers(options?.headers);
      assert.equal(headers.has('cookie'), false); assert.equal(headers.has('authorization'), false);
      assert.equal(headers.get('referer'), 'https://www.douban.com/');
      assert.equal(JSON.stringify(options).includes('profileId'), false);
      return imageResponse(sample.bytes, sample.type + '; charset=binary');
    } });
    assert.equal(requests, 1); assert.equal(result.contentType, sample.type); assert.deepEqual(new Uint8Array(result.bytes), sample.bytes);
  }
});

test('arbitrary URLs, lookalike hosts, credentials, ports and queries never cause a network request', async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return imageResponse(png); };
  for (const url of ['http://127.0.0.1/private', 'https://img1.doubanio.com.evil.test/view/photo/x.jpg',
    'https://user:password@img1.doubanio.com/view/photo/x.jpg', 'https://img1.doubanio.com:8443/view/photo/x.jpg',
    'https://img1.doubanio.com/view/photo/x.jpg?token=private', 'https://movie.douban.com/subject/1/',
    'data:image/png;base64,AAAA', 'https://img1.doubanio.com/view/photo/x.svg']) {
    await assert.rejects(fetchDoubanCover(url, { fetch }), errorCode('DOUBAN_COVER_URL_REJECTED'));
  }
  assert.equal(requests, 0);
});

test('redirects and provider failures stop after one request and never expose upstream body contents', async () => {
  for (const response of [new Response('PRIVATE_UPSTREAM_BODY', { status: 302, headers: { Location: 'http://127.0.0.1/private' } }),
    new Response('PRIVATE_UPSTREAM_BODY', { status: 403 }), Object.defineProperty(imageResponse(png), 'redirected', { value: true })]) {
    let requests = 0;
    await assert.rejects(fetchDoubanCover(URL, { fetch: async () => { requests++; return response; } }), (error: unknown) => {
      assert.ok(error instanceof DoubanCoverError); assert.equal(error.status, 502);
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_UPSTREAM_BODY|127\.0\.0\.1|Location/); return true;
    });
    assert.equal(requests, 1);
  }
});

test('HTML, SVG, missing MIME and MIME/signature mismatches cannot be served as images', async () => {
  for (const response of [new Response('<html>blocked</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('<svg onload="bad()"/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response(png.buffer), imageResponse(png, 'image/jpeg'), imageResponse(new Uint8Array([137, 80]), 'image/png')]) {
    await assert.rejects(fetchDoubanCover(URL, { fetch: async () => response }), errorCode('DOUBAN_COVER_INVALID_IMAGE'));
  }
});

test('declared and streamed oversized images are bounded and their response bodies are cancelled', async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchDoubanCover(URL, { fetch: async () => new Response(oversized, { headers: { 'Content-Type': 'image/jpeg' } }) }), errorCode('DOUBAN_COVER_TOO_LARGE'));
  assert.equal(cancelled, true);
  let declaredCancelled = false;
  const declared = new ReadableStream<Uint8Array>({ cancel() { declaredCancelled = true; } });
  await assert.rejects(fetchDoubanCover(URL, { fetch: async () => new Response(declared, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(DOUBAN_COVER_MAX_BYTES + 1) } }) }), errorCode('DOUBAN_COVER_TOO_LARGE'));
  assert.equal(declaredCancelled, true);
});

test('a fetch that stalls and a body that stalls after headers both time out and abort retained work', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(fetchDoubanCover(URL, { timeoutMs: 10, fetch: async (_url, options) => {
    signal = options?.signal ?? undefined; return new Promise<Response>(() => {});
  } }), errorCode('DOUBAN_COVER_TIMEOUT'));
  assert.equal(signal?.aborted, true);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png.slice(0, 12)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchDoubanCover(URL, { timeoutMs: 10, fetch: async () => new Response(body, { headers: { 'Content-Type': 'image/png' } }) }), errorCode('DOUBAN_COVER_TIMEOUT'));
  assert.equal(cancelled, true);
});

test('client cancellation after headers cancels the body even when the fetch stub ignores its signal', async () => {
  const controller = new AbortController(); let cancelled = false, headersReceived!: () => void;
  const received = new Promise<void>(resolve => { headersReceived = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(png.slice(0, 12)); }, cancel() { cancelled = true; } });
  const request = fetchDoubanCover(URL, { signal: controller.signal, fetch: async () => { headersReceived(); return new Response(body, { headers: { 'Content-Type': 'image/png' } }); } });
  await received; await new Promise<void>(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(request, errorCode('DOUBAN_COVER_ABORTED')); assert.equal(cancelled, true);
  let calls = 0;
  await assert.rejects(fetchDoubanCover(URL, { signal: controller.signal, fetch: async () => { calls++; return imageResponse(png); } }), errorCode('DOUBAN_COVER_ABORTED'));
  assert.equal(calls, 0);
});

test('network exceptions use a local safe message rather than credentials or provider text', async () => {
  await assert.rejects(fetchDoubanCover(URL, { fetch: async () => { throw new Error('PRIVATE_COOKIE PRIVATE_PROVIDER_URL'); } }), (error: unknown) => {
    assert.ok(error instanceof DoubanCoverError); assert.equal(error.status, 502); assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_/); return true;
  });
});
