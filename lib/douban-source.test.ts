import assert from 'node:assert/strict';
import test from 'node:test';
import { DoubanSourceError, fetchDoubanCollection, parseDoubanCollectionHtml, fetchDoubanRSS, fetchDoubanSubjectKind } from './douban-source.ts';
import type { DoubanDomain } from './douban.ts';
const htmlResponse = (body: string, init?: ResponseInit) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, ...init });
const xmlResponse = (body: string) => new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
const sourceError = (code: string) => (error: unknown) => error instanceof DoubanSourceError && error.code === code && !/PRIVATE|SECRET/.test(JSON.stringify(error));
const host = { screen: 'movie', book: 'book', music: 'music' };
function row(domain: DoubanDomain, id = '1234567', mode = 'list', extras = '') {
  const title = '<a href="https://' + host[domain] + '.douban.com/subject/' + id + '/"><em>合成 &amp; 条目</em></a>';
  return mode === 'list' ? '<div class="item-show"><div class="title">' + title + '</div><div class="date">2026-11-14</div><span class="rating4-t"></span><span class="comment">个人 &lt;短评&gt;</span>' + extras + '</div>'
    : '<div class="item comment-item"><div class="info"><ul><li class="title">' + title + '</li><li><span class="rating4-t"></span><span class="date">2026-11-14</span></li><li><span class="comment">个人 &lt;短评&gt;</span></li></ul></div>' + extras + '</div>';
}
function page(domain: DoubanDomain, rows: string, total = 1, next: number | null = null, mode = 'list') {
  const title = ({ screen: '看过的电影', book: '读过的书', music: '听过的音乐' })[domain];
  return '<!DOCTYPE html><html><head><title>合成用户' + title + '(' + total + ')</title></head><body><h1>合成用户' + title + '(' + total + ')</h1><span class="subject-num">1-1 / ' + total + '</span><div class="' + (mode === 'grid' ? 'grid-view' : 'list-view') + '">' + rows + '</div><div class="paginator">' + (next === null ? '' : '<span class="next"><a href="https://' + host[domain] + '.douban.com/people/synthetic_alias/collect?start=' + next + '">后页&gt;</a></span>') + '</div></body></html>';
}
function feed(items = '') { return '<?xml version="1.0"?><rss><channel><title>合成用户 的收藏</title><link>https://www.douban.com/people/synthetic_alias/</link>' + items + '</channel></rss>'; }
function interest(state: string, domain: DoubanDomain, id: string, detail = '<p>推荐: 力荐</p><p>备注: 自己的短评</p>') {
  return '<item><title>' + state + '合成条目</title><link>https://' + host[domain] + '.douban.com/subject/' + id + '/</link><description><![CDATA[' + detail + ']]></description><pubDate>Sat, 14 Nov 2026 08:00:00 GMT</pubDate><guid>https://www.douban.com/people/synthetic_alias/interests/' + id + '</guid></item>';
}

test('each completed collection page is one anonymous fixed-host request, with personal fields distinct from metadata', async () => {
  for (const domain of ['screen', 'book', 'music'] as const) for (const mode of ['list', 'grid']) {
    let calls = 0;
    const result = await fetchDoubanCollection('synthetic_user', domain, 0, { fetch: async (url, init) => {
      calls++; const parsed = new URL(String(url));
      assert.equal(parsed.hostname, host[domain] + '.douban.com'); assert.equal(parsed.pathname, '/people/synthetic_user/collect');
      assert.equal(parsed.searchParams.get('mode'), 'grid'); assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit');
      assert.equal(new Headers(init?.headers).get('Cookie'), null); assert.equal(new Headers(init?.headers).get('Authorization'), null);
      const extras = '<img src="https://img3.doubanio.com/view/subject/s/public/s123.jpg"><span class="rating5-t aggregate-score">大众5星</span>';
      return htmlResponse(page(domain, row(domain, '1234567', mode, extras), 1, null, mode));
    } });
    assert.equal(calls, 1); assert.equal(result.items.length, 1); assert.equal(result.nextStart, null); assert.equal(result.total, 1);
    assert.equal(result.items[0].title, '合成 & 条目'); assert.equal(result.items[0].kind, domain);
    assert.equal(result.items[0].rating, 4); assert.equal(result.items[0].comment, '个人 <短评>'); assert.equal(result.items[0].markedDate, '2026-11-14');
    assert.equal(result.items[0].publishedAt, null); assert.equal(result.items[0].source, 'collection');
  }
});

test('pagination proves continuity, is independent of canonical profile aliases, and never follows an arbitrary link', async () => {
  const first = await fetchDoubanCollection('1234567', 'book', 0, { fetch: async () => htmlResponse(page('book', row('book'), 2, 1)) });
  assert.equal(first.nextStart, 1);
  const last = await fetchDoubanCollection('1234567', 'book', 1, { fetch: async url => { assert.equal(new URL(String(url)).searchParams.get('start'), '1'); return htmlResponse(page('book', row('book', '1234568'), 2)); } });
  assert.equal(last.nextStart, null);
  for (const raw of [page('book', row('book'), 2), page('book', row('book'), 1, 1), page('book', row('book'), 3, 2),
    page('book', row('book'), 2, 1).replace('https://book.douban.com/people/', 'https://evil.invalid/people/')]) {
    await assert.rejects(fetchDoubanCollection('synthetic', 'book', 0, { fetch: async () => htmlResponse(raw) }), sourceError('DOUBAN_SOURCE_INVALID'));
  }
});

test('an empty result needs a proven completed-collection zero count; login, truncated, noncollection and duplicate rows are not empty success', async () => {
  assert.deepEqual(await fetchDoubanCollection('synthetic', 'music', 0, { fetch: async () => htmlResponse(page('music', '', 0)) }), { items: [], nextStart: null, total: 0 });
  for (const raw of ['<html><title>普通页面</title></html>', page('music', '', 1), page('music', row('music') + row('music'), 2),
    page('music', row('book')), page('music', row('music')).replace('听过的音乐', '想听的音乐').replace('听过的音乐', '想听的音乐')]) {
    await assert.rejects(fetchDoubanCollection('synthetic', 'music', 0, { fetch: async () => htmlResponse(raw) }), sourceError('DOUBAN_SOURCE_INVALID'));
  }
});

test('HTTP and HTTP-200 login, challenge and blocked pages stay explicit failures without exposing page text', async () => {
  for (const [status, code] of [[403, 'DOUBAN_SOURCE_BLOCKED'], [418, 'DOUBAN_SOURCE_BLOCKED'], [429, 'DOUBAN_SOURCE_RATE_LIMITED'], [500, 'DOUBAN_SOURCE_HTTP_ERROR']] as const) {
    await assert.rejects(fetchDoubanCollection('synthetic', 'book', 0, { fetch: async () => htmlResponse('PRIVATE PAGE SECRET', { status }) }), sourceError(code));
  }
  for (const [body, code] of [['<title>禁止访问</title>PRIVATE', 'DOUBAN_SOURCE_BLOCKED'], ['<title>豆瓣 - 登录跳转页</title>PRIVATE', 'DOUBAN_SOURCE_LOGIN_REQUIRED'],
    ['<title>豆瓣</title><form action="https://sec.douban.com/c">验证码 PRIVATE</form>', 'DOUBAN_SOURCE_CHALLENGE']] as const) {
    await assert.rejects(fetchDoubanCollection('synthetic', 'book', 0, { fetch: async () => htmlResponse(body) }), sourceError(code));
  }
  for (const [location, code] of [['https://accounts.douban.com/passport/login', 'DOUBAN_SOURCE_LOGIN_REQUIRED'], ['https://sec.douban.com/c', 'DOUBAN_SOURCE_CHALLENGE'], ['https://book.douban.com/people/synthetic/collect', 'DOUBAN_SOURCE_REDIRECT'], ['http://127.0.0.1/private', 'DOUBAN_SOURCE_REDIRECT']] as const) {
    let requests = 0;
    await assert.rejects(fetchDoubanCollection('synthetic', 'book', 0, { fetch: async () => { requests++; return htmlResponse('', { status: 302, headers: { Location: location } }); } }), sourceError(code));
    assert.equal(requests, 1, 'redirects cannot consume hidden requests or forward credentials');
  }
});

test('RSS imports only explicit completed states and never invents a completion date from publication time', async () => {
  let calls = 0;
  const result = await fetchDoubanRSS('synthetic', { fetch: async (url, init) => {
    calls++; assert.equal(String(url), 'https://www.douban.com/feed/people/synthetic/interests'); assert.equal(init?.redirect, 'manual');
    return xmlResponse(feed(interest('看过', 'screen', '1234567') + interest('读过', 'book', '1234568') + interest('听过', 'music', '1234569')
      + interest('在看', 'screen', '1234570') + interest('最近在读', 'book', '1234571') + interest('想听', 'music', '1234572')));
  } });
  assert.equal(calls, 1); assert.equal(result.length, 3); assert.deepEqual(result.map(item => item.kind), ['screen', 'book', 'music']);
  for (const item of result) { assert.equal(item.rating, 5); assert.equal(item.markedDate, null); assert.equal(item.publishedAt, '2026-11-14T08:00:00.000Z'); assert.equal(item.comment, '自己的短评'); assert.equal(item.source, 'rss'); }
  assert.deepEqual(await fetchDoubanRSS('synthetic', { fetch: async () => xmlResponse(feed(interest('想看', 'screen', '1234567'))) }), []);
});

test('RSS rejects malformed, external-entity and cross-domain-status feeds instead of accepting a false empty collection', async () => {
  for (const body of ['<html>not rss</html>', feed().replace('</rss>', ''), '<!DOCTYPE rss SYSTEM "https://evil.invalid/entity">' + feed(),
    '<!ENTITY private SYSTEM "file:///private">' + feed(), feed(interest('听过', 'book', '1234567')), feed(interest('读过', 'book', '1234567') + interest('读过', 'book', '1234567')),
    feed(interest('读过', 'book', '1234567').replace('Sat, 14 Nov 2026 08:00:00 GMT', 'invalid-date'))]) {
    await assert.rejects(fetchDoubanRSS('synthetic', { fetch: async () => xmlResponse(body) }), sourceError('DOUBAN_SOURCE_INVALID'));
  }
});

test('screen subtypes require explicit subject-bound metadata; a title or a book cannot stand in for a series', async () => {
  for (const [type, kind] of [['Movie', 'movie'], ['TVSeries', 'series']] as const) {
    let calls = 0;
    assert.equal(await fetchDoubanSubjectKind('1234567', { fetch: async () => { calls++; return htmlResponse('<script type="application/ld+json">' + JSON.stringify({ '@type': type, url: '/subject/1234567/' }) + '</script>' + (type === 'Movie' ? '<div id="info"><span class="pl">片长:</span>112分钟</div>' : '')); } }), kind);
    assert.equal(calls, 1);
  }
  const proof = '<meta property="og:url" content="https://movie.douban.com/subject/1234567/"><h1>名称里写第一季也不能猜</h1><div id="info">';
  assert.equal(await fetchDoubanSubjectKind('1234567', { fetch: async () => htmlResponse(proof + '</div>') }), null);
  assert.equal(await fetchDoubanSubjectKind('1234567', { fetch: async () => htmlResponse(proof + '<span class="pl">集数:</span>12</div>') }), 'series');
  await assert.rejects(fetchDoubanSubjectKind('1234567', { fetch: async () => htmlResponse(proof.replace('1234567/', '9999999/') + '<span class="pl">集数:</span>12</div>') }), sourceError('DOUBAN_SOURCE_INVALID'));
});

test('response size, encoding, content type and malformed caller offsets are bounded before parsing', async () => {
  await assert.rejects(fetchDoubanRSS('synthetic', { fetch: async () => new Response('data', { headers: { 'Content-Type': 'application/rss+xml', 'Content-Length': String(2 * 1024 * 1024 + 1) } }) }), sourceError('DOUBAN_SOURCE_TOO_LARGE'));
  await assert.rejects(fetchDoubanRSS('synthetic', { fetch: async () => xmlResponse('x'.repeat(2 * 1024 * 1024 + 1)) }), sourceError('DOUBAN_SOURCE_TOO_LARGE'));
  await assert.rejects(fetchDoubanCollection('synthetic', 'book', 0, { fetch: async () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'text/html' } }) }), sourceError('DOUBAN_SOURCE_INVALID'));
  await assert.rejects(fetchDoubanCollection('synthetic', 'book', 0, { fetch: async () => Response.json({ title: 'fake' }) }), sourceError('DOUBAN_SOURCE_INVALID'));
  let calls = 0;
  for (const start of [-1, NaN, 0.1, 100001]) await assert.rejects(fetchDoubanCollection('synthetic', 'book', start, { fetch: async () => { calls++; return htmlResponse('fake'); } }));
  assert.equal(calls, 0);
});

test('network and timeout errors remain local classifications; a hanging body is cancelled by the deadline', async context => {
  await assert.rejects(fetchDoubanRSS('synthetic', { fetch: async () => { throw new Error('PRIVATE KEY SECRET'); } }), sourceError('DOUBAN_SOURCE_NETWORK'));
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const request = fetchDoubanRSS('synthetic', { fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/rss+xml' } }) });
  await Promise.resolve(); await Promise.resolve();
  context.mock.timers.tick(12001);
  await assert.rejects(request, sourceError('DOUBAN_SOURCE_TIMEOUT'));
  assert.equal(cancelled, true);
});


test('saved-page collection parsing is pure, size-bounded and explicit about its source label', () => {
  const parsed = parseDoubanCollectionHtml(page('book', row('book')), 'synthetic', 'book');
  assert.equal(parsed.items[0].subjectId, '1234567');
  assert.equal(parsed.items[0].source, 'collection', 'importer must explicitly relabel local-file provenance');
  assert.throws(() => parseDoubanCollectionHtml('<div>'.repeat(30001), 'synthetic', 'book'), sourceError('DOUBAN_SOURCE_INVALID'));
});


test('an absent personal star does not adopt a site score or guess from the item title', async () => {
  const raw = row('screen').replace('<span class="rating4-t"></span>', '<span class="rating5-t aggregate-score">大众评分</span>');
  const result = await fetchDoubanCollection('synthetic', 'screen', 0, { fetch: async () => htmlResponse(page('screen', raw)) });
  assert.equal(result.items[0].rating, null);
  assert.equal(result.items[0].kind, 'screen');
});
