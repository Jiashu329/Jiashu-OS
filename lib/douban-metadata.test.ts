import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDoubanSubjectMetadata, fetchDoubanSubjectMetadata } from './douban-metadata.ts';
import { DoubanSourceError, fetchDoubanSubjectKind } from './douban-source.ts';
import { doubanSubjectUrl, type DoubanDomain } from './douban.ts';

const id = '1234567';
const image = 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p1234567.jpg';
const htmlResponse = (body: string, init?: ResponseInit) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, ...init });
const sourceError = (code: string) => (error: unknown) => error instanceof DoubanSourceError && error.code === code && !/PRIVATE|SECRET/.test(JSON.stringify(error));
function schema(value: unknown) { return '<script type="application/ld+json">' + JSON.stringify(value) + '</script>'; }
function subject(domain: DoubanDomain = 'screen', body = '', head = '') {
  return '<!DOCTYPE html><html><head><title>合成条目</title><link rel="canonical" href="' + doubanSubjectUrl(domain, id) + '">' + head + '</head><body><h1>合成条目</h1>' + body + '</body></html>';
}
function info(label: string, value: string) { return '<div id="info"><span class="pl">' + label + ':</span> ' + value + '<br></div>'; }
function movie() { return schema({ '@type': 'Movie', url: '/subject/' + id + '/' }); }

void test('generic Movie JSON-LD yields to actual television metadata, including real-world episode info', () => {
  const realInfo = '<div id="info"><span class="pl">导演:</span><a rel="v:directedBy">合成导演</a><br>'
    + '<span class="pl">首播:</span><span property="v:initialReleaseDate">2026-11-01(中国大陆)</span><br>'
    + '<span class="pl">集数:</span> 12<br><span class="pl">单集片长:</span> 45分钟<br></div>';
  assert.equal(parseDoubanSubjectMetadata(subject('screen', realInfo, movie()), 'screen', id).kind, 'series');
  for (const [label, value] of [['单集片长', '45分钟'], ['集数', '1'], ['季数', '2']]) {
    assert.equal(parseDoubanSubjectMetadata(subject('screen', info(label, value) + info('片长', '120分钟'), movie()), 'screen', id).kind, 'series');
  }
  for (const type of ['TVSeries', 'TVSeason', 'TVEpisode', 'https://schema.org/TVSeries']) {
    assert.equal(parseDoubanSubjectMetadata(subject('screen', '', schema({ '@type': ['Movie', type], url: '/subject/' + id + '/' })), 'screen', id).kind, 'series');
  }
  assert.equal(parseDoubanSubjectMetadata(subject('screen', info('片长', '120分钟'), movie() + '<meta property="og:type" content="video.tv_show">'), 'screen', id).kind, 'series');
});

void test('movie classification requires corroborating film details and never guesses from a title or partial TV info', () => {
  for (const filmInfo of [info('片长', '<span property="v:runtime">112分钟</span>'), info('上映日期', '2026-11-14(中国大陆)')]) {
    assert.equal(parseDoubanSubjectMetadata(subject('screen', filmInfo, movie()), 'screen', id).kind, 'movie');
    assert.equal(parseDoubanSubjectMetadata(subject('screen', filmInfo, '<meta property="og:type" content="video.movie">'), 'screen', id).kind, 'movie');
  }
  assert.equal(parseDoubanSubjectMetadata(subject('screen', '', movie()), 'screen', id).kind, null);
  assert.equal(parseDoubanSubjectMetadata(subject('screen').replace('合成条目</h1>', '电视剧 第一季</h1>'), 'screen', id).kind, null);
  for (const [label, value] of [['首播', '2026-11-14'], ['集数', '未知'], ['单集片长', '待定']]) {
    assert.equal(parseDoubanSubjectMetadata(subject('screen', info(label, value) + info('片长', '120分钟'), movie()), 'screen', id).kind, null);
  }
  assert.equal(parseDoubanSubjectMetadata(subject('screen', info('片长', '120分钟')), 'screen', id).kind, null);
});

void test('JSON-LD types and images must belong to the requested subject, not a recommendation', () => {
  const unrelated = { '@type': 'TVSeries', url: 'https://movie.douban.com/subject/9999999/', image };
  const actual = { '@type': 'Movie', '@id': doubanSubjectUrl('screen', id) + '#movie', image: { '@type': 'ImageObject', contentUrl: image } };
  const parsed = parseDoubanSubjectMetadata(subject('screen', info('片长', '112分钟'), schema({ '@graph': [unrelated, actual] })), 'screen', id);
  assert.deepEqual(parsed, { kind: 'movie', coverUrl: image });
  assert.deepEqual(parseDoubanSubjectMetadata(subject('screen', '', schema(unrelated)), 'screen', id), { kind: null, coverUrl: null });
  const noReference = { '@type': 'TVSeries', image };
  assert.equal(parseDoubanSubjectMetadata(subject('screen', '', schema({ '@graph': [noReference] })), 'screen', id).kind, null);
  assert.equal(parseDoubanSubjectMetadata(subject('screen', '', schema(noReference)), 'screen', id).kind, 'series', 'a root subject may use a matching canonical');
});

void test('cover extraction supports official Open Graph, JSON-LD, lazy main images and known book/music kinds', () => {
  const variants = [
    ['screen', '', '<meta property="og:image" content="' + image + '">'],
    ['book', '', schema({ '@type': 'Book', image: { url: image } })],
    ['music', '<div id="mainpic"><img src="data:image/png;base64,AA" data-original="' + image + '"></div>', ''],
    ['screen', '<div id="mainpic"><img data-src="//img3.doubanio.com/view/photo/s_ratio_poster/public/p1234567.jpg"></div>', ''],
    ['book', '<div id="mainpic"><img src="/local-cache.jpg" srcset="' + image + ' 1x, https://evil.invalid/private.jpg 2x"></div>', ''],
    ['book', '<div id="mainpic"><img src="https://img1.doubanio.com/view/subject/s/public/placeholder.jpg" data-srcset="' + image + ' 1x"></div>', ''],
    ['music', '<div id="mainpic"><a class="nbg" href="http://img3.doubanio.com/lpic/s1234567.jpg"></a></div>', ''],
  ] as const;
  for (const [domain, body, head] of variants) {
    assert.deepEqual(parseDoubanSubjectMetadata(subject(domain, body, head), domain, id), { kind: domain === 'screen' ? null : domain, coverUrl: body.includes('/lpic/') ? 'https://img3.doubanio.com/lpic/s1234567.jpg' : image });
  }
  assert.equal(parseDoubanSubjectMetadata(subject('book', '<img src="' + image + '">'), 'book', id).coverUrl, null, 'unrelated page images are not subject covers');
});

void test('unsafe cover addresses cannot escape the official image allowlist or inject scripts', () => {
  for (const candidate of ['https://private.invalid/image.jpg', 'https://img3.doubanio.com.evil.invalid/view/photo/public/x.jpg',
    'javascript:alert(1)', 'data:image/svg+xml,PRIVATE', 'https://user:SECRET@img3.doubanio.com/view/photo/public/x.jpg',
    'https://img3.doubanio.com/view/photo/public/x.svg', 'https://img3.doubanio.com/view/photo/public/x.jpg?token=SECRET',
    'https://img3.doubanio.com:444/view/photo/public/x.jpg', 'https://img3.doubanio.com/view/photo/public/x.jpg#PRIVATE']) {
    assert.equal(parseDoubanSubjectMetadata(subject('book', '', schema({ '@type': 'Book', image: candidate })), 'book', id).coverUrl, null);
  }
});

void test('wrong or absent subject identity is an explicit failure rather than metadata from a different page', () => {
  for (const raw of [subject().replace('/subject/' + id + '/', '/subject/9999999/'),
    subject().replace('movie.douban.com', 'book.douban.com'), '<h1>无来源页</h1>' + movie().replace(id, '9999999'),
    '<link rel="canonical" href="https://movie.douban.com/subject/' + id + '/">',
    subject().replace('/subject/' + id + '/', '/subject/' + id + '/?private=SECRET')]) {
    assert.throws(() => parseDoubanSubjectMetadata(raw, 'screen', id), sourceError('DOUBAN_SOURCE_INVALID'));
  }
  assert.deepEqual(parseDoubanSubjectMetadata(schema({ '@type': 'Movie', url: '/subject/' + id + '/' }), 'screen', id), { kind: null, coverUrl: null });
});

void test('metadata fetch is exactly one anonymous fixed-host request with no image or arbitrary URL fetch', async () => {
  for (const domain of ['screen', 'book', 'music'] as const) {
    let calls = 0;
    const result = await fetchDoubanSubjectMetadata(domain, id, { fetch: async (url, init) => {
      calls++; assert.equal(url, doubanSubjectUrl(domain, id)); assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit');
      assert.equal(new Headers(init?.headers).get('Cookie'), null); assert.equal(new Headers(init?.headers).get('Authorization'), null);
      return htmlResponse(subject(domain, '<div id="mainpic"><img src="' + image + '"></div>'));
    } });
    assert.equal(calls, 1); assert.equal(result.coverUrl, image);
  }
  let calls = 0;
  for (const badId of ['https://private.invalid', '1?cookie=SECRET', '../1234567', '0', '12345678901234567']) {
    await assert.rejects(fetchDoubanSubjectMetadata('screen', badId, { fetch: async () => { calls++; return htmlResponse(''); } }));
  }
  assert.equal(calls, 0);
});

void test('metadata reads stop at redirects, HTTP or verification failures and preserve fixed source errors', async () => {
  for (const [target, code] of [['https://accounts.douban.com/passport/login', 'DOUBAN_SOURCE_LOGIN_REQUIRED'], ['https://sec.douban.com/c', 'DOUBAN_SOURCE_CHALLENGE'], ['http://127.0.0.1/PRIVATE', 'DOUBAN_SOURCE_REDIRECT']]) {
    let calls = 0;
    await assert.rejects(fetchDoubanSubjectMetadata('screen', id, { fetch: async () => { calls++; return htmlResponse('', { status: 302, headers: { location: target } }); } }), sourceError(code));
    assert.equal(calls, 1);
  }
  for (const [body, code] of [['<title>豆瓣 - 登录跳转页</title>PRIVATE', 'DOUBAN_SOURCE_LOGIN_REQUIRED'], ['<title>安全验证</title>PRIVATE', 'DOUBAN_SOURCE_CHALLENGE'], ['<title>禁止访问</title>SECRET', 'DOUBAN_SOURCE_BLOCKED']]) {
    await assert.rejects(fetchDoubanSubjectMetadata('book', id, { fetch: async () => htmlResponse(body) }), sourceError(code));
  }
  await assert.rejects(fetchDoubanSubjectMetadata('music', id, { fetch: async () => htmlResponse('PRIVATE', { status: 429 }) }), sourceError('DOUBAN_SOURCE_RATE_LIMITED'));
  await assert.rejects(fetchDoubanSubjectMetadata('music', id, { fetch: async () => { throw new Error('PRIVATE SECRET'); } }), sourceError('DOUBAN_SOURCE_NETWORK'));
});

void test('parsing is bounded, rejects entities, ignores bad JSON and does not execute document scripts', () => {
  assert.throws(() => parseDoubanSubjectMetadata('字'.repeat(1024 * 1024), 'screen', id), sourceError('DOUBAN_SOURCE_TOO_LARGE'));
  assert.throws(() => parseDoubanSubjectMetadata('<!ENTITY private SYSTEM "https://private.invalid">' + subject(), 'screen', id), sourceError('DOUBAN_SOURCE_INVALID'));
  assert.throws(() => parseDoubanSubjectMetadata('<div>'.repeat(30001), 'screen', id), sourceError('DOUBAN_SOURCE_INVALID'));
  const global = globalThis as typeof globalThis & { doubanMetadataExecuted?: boolean };
  delete global.doubanMetadataExecuted;
  const raw = subject('screen', '<script>globalThis.doubanMetadataExecuted=true;fetch("https://private.invalid")</script>', '<script type="application/ld+json">{broken</script>');
  assert.deepEqual(parseDoubanSubjectMetadata(raw, 'screen', id), { kind: null, coverUrl: null });
  assert.equal(global.doubanMetadataExecuted, undefined);
});

void test('the legacy sync classifier delegates to the corrected metadata parser', async () => {
  let calls = 0;
  assert.equal(await fetchDoubanSubjectKind(id, { fetch: async () => { calls++; return htmlResponse(subject('screen', info('集数', '24'), movie())); } }), 'series');
  assert.equal(calls, 1);
  assert.equal(await fetchDoubanSubjectKind(id, { fetch: async () => htmlResponse(subject('screen', '', movie())) }), null);
});
