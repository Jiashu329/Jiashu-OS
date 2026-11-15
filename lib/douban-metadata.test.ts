import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDoubanSubjectMetadata, fetchDoubanSubjectMetadata } from './douban-metadata.ts';
import { DoubanSourceError, fetchDoubanSubjectKind } from './douban-source.ts';
import { doubanSubjectUrl, type DoubanDomain } from './douban.ts';
import { parseDoubanDetails } from './douban-details.ts';

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
  assert.deepEqual(parsed, { kind: 'movie', coverUrl: image, details: { duration: '112分钟' } });
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

function information(fields: Array<[string, string]>) {
  return '<div id="info">' + fields.map(([label, value]) => '<span class="pl">' + label + ':</span>' + value + '<br>').join('') + '</div>';
}
function scores(value = '8.7', count = '2,345') {
  return '<div id="interest_sectl"><div class="rating_self"><strong property="v:average">' + value + '</strong></div><div class="rating_sum"><span property="v:votes">' + count + '</span></div></div>';
}

void test('screen IMDb IDs come only from the current info label or official title link, without fetching IMDb ratings', () => {
  const variants = [
    info('IMDb', 'tt1234567'),
    info('IMDB', '<span>tt1234567</span>'),
    '<div id="info"><span class="pl">IMDb</span>: tt1234567<br></div>',
    info('IMDb', '<a href="https://www.imdb.com/title/tt1234567/?ref_=douban">IMDb</a>'),
    '<div id="info"><a href="http://imdb.com/title/tt1234567">tt1234567</a></div>',
    info('IMDb', 'tt1234567') + '<aside class="recommendations"><a href="https://www.imdb.com/title/tt9999999/">其他电影</a></aside>',
  ];
  for (const body of variants) {
    assert.deepEqual(parseDoubanSubjectMetadata(subject('screen', body), 'screen', id).details, { imdbId: 'tt1234567' });
  }
  for (const domain of ['book', 'music'] as const) assert.equal(parseDoubanSubjectMetadata(subject(domain, variants[0]), domain, id).details?.imdbId, undefined);
});

void test('IMDb IDs stay unknown for unrelated, malformed or conflicting evidence instead of guessing from names', () => {
  const link = (url = 'https://www.imdb.com/title/tt1234567/', label = 'IMDb') => '<a href="' + url + '">' + label + '</a>';
  const variants = [
    link(), '<h2>tt1234567</h2>', info('又名', 'tt1234567'),
    '<aside class="recommendations">' + info('IMDb', 'tt1234567') + '</aside>',
    '<div id="info"><div class="recommendations">' + link() + '<span class="pl">IMDb:</span>tt1234567</div></div>',
    info('IMDb', 'tt1234567') + info('IMDb', 'tt1234567'),
    information([['IMDb', 'tt1234567'], ['IMDb', 'tt9999999']]),
    info('IMDb', link('https://www.imdb.com/title/tt9999999/', 'tt1234567')),
    info('IMDb', 'tt1234567 / tt9999999'),
    ...['tt123456', 'tt12345678901', 'TT1234567', 'nm1234567', '电影名称',
      'https://imdb.com.evil.invalid/title/tt1234567/', 'javascript:tt1234567'].map(value => info('IMDb', value)),
    ...['https://www.imdb.com/name/nm1234567/', 'https://www.imdb.com/title/tt1234567/reference/',
      'https://user:SECRET@www.imdb.com/title/tt1234567/', 'https://www.imdb.com:444/title/tt1234567/',
      'https://imdb.com.evil.invalid/title/tt1234567/'].map(url => '<div id="info">' + link(url) + '</div>'),
  ];
  for (const body of variants) assert.equal(parseDoubanSubjectMetadata(subject('screen', body), 'screen', id).details?.imdbId, undefined, body);
  const tooManyLinks = '<div id="info"><a href="https://www.imdb.com/title/tt1234567/">IMDb</a>' + '<a href="#">更多</a>'.repeat(600) + '</div>';
  assert.equal(parseDoubanSubjectMetadata(subject('screen', tooManyLinks), 'screen', id).details?.imdbId, undefined);
  assert.deepEqual(parseDoubanSubjectMetadata(subject('screen', info('IMDb', 'tt1234567890')), 'screen', id).details, { imdbId: 'tt1234567890' });
});

void test('screen subject details retain common metadata, full summary, credits and television fields', () => {
  const body = '<h1><span class="year">(2026)</span></h1>' + information([
    ['导演', '<a>导演甲</a> / <a>导演乙</a>'], ['编剧', '编剧甲 / 编剧乙'], ['主演', '<a>演员甲</a> / <a>演员乙</a>'],
    ['类型', '剧情 / 犯罪'], ['制片国家/地区', '中国大陆 / 美国'], ['语言', '汉语普通话 / 英语'], ['又名', '别名甲 / 别名乙'],
    ['首播', '2026-11-01(中国大陆) / 2026-11-14(美国)'], ['片长', '120分钟'], ['集数', '24'], ['季数', '2'], ['单集片长', '45分钟'],
  ]) + '<div id="link-report"><span class="short"><div class="intro">节选简介</div></span><span class="all hidden"><div class="intro"><p>完整简介第一段。</p><p>完整简介第二段。</p></div></span></div>' + scores();
  const metadata = parseDoubanSubjectMetadata(subject('screen', body, movie()), 'screen', id);
  assert.equal(metadata.kind, 'series');
  assert.deepEqual(metadata.details, { summary: '完整简介第一段。\n完整简介第二段。', alternateTitles: ['别名甲', '别名乙'], year: 2026,
    genres: ['剧情', '犯罪'], countries: ['中国大陆', '美国'], languages: ['汉语普通话', '英语'], doubanRating: 8.7, ratingCount: 2345,
    directors: ['导演甲', '导演乙'], writers: ['编剧甲', '编剧乙'], cast: ['演员甲', '演员乙'],
    releaseDates: ['2026-11-01(中国大陆)', '2026-11-14(美国)'], duration: '120分钟', episodes: 24, seasons: 2, episodeDuration: '45分钟' });
  assert.deepEqual(parseDoubanDetails(metadata.details), metadata.details);
});

void test('book details parse labeled authors, translators and publication data without confusing personal stars', () => {
  const body = information([['作者', '<a>作者甲</a> / <a>作者乙</a>'], ['译者', '<a>译者甲</a>'], ['出版社', '合成出版社'],
    ['出版年', '2025-10'], ['页数', '320'], ['ISBN', '9781234567890'], ['装帧', '精装'], ['定价', '88.00元'], ['丛书', '<a>合成丛书</a>'], ['原作名', 'Original Title']])
    + '<div id="link-report"><div class="intro"><p>图书简介。</p></div></div>' + scores('9.1', '100');
  const details = parseDoubanSubjectMetadata(subject('book', body), 'book', id).details;
  assert.deepEqual(details, { summary: '图书简介。', alternateTitles: ['Original Title'], year: 2025, doubanRating: 9.1, ratingCount: 100,
    authors: ['作者甲', '作者乙'], translators: ['译者甲'], publisher: '合成出版社', publicationDate: '2025-10', pages: 320,
    isbn: '9781234567890', binding: '精装', price: '88.00元', seriesTitle: '合成丛书' });
  assert.deepEqual(parseDoubanDetails(details), details);
});

void test('music details include performers and ordered tracks alongside medium and release information', () => {
  const body = information([['表演者', '<a>AC/DC</a> / <a>合成乐队</a>'], ['流派', '摇滚 / 流行'], ['专辑类型', '专辑'], ['介质', 'CD'],
    ['出版者', '合成唱片'], ['发行时间', '2024-06-01']]) + '<div id="link-report"><span property="v:summary">专辑简介。</span></div>'
    + '<div id="track-list">01. 第一首<br>02. 第二首<br>03. 第三首</div>';
  const details = parseDoubanSubjectMetadata(subject('music', body), 'music', id).details;
  assert.deepEqual(details, { summary: '专辑简介。', year: 2024, genres: ['摇滚', '流行'], artists: ['AC/DC', '合成乐队'],
    albumType: '专辑', medium: 'CD', label: '合成唱片', releaseDate: '2024-06-01', tracks: ['01. 第一首', '02. 第二首', '03. 第三首'] });
  assert.deepEqual(parseDoubanDetails(details), details);
});

void test('only current subject JSON-LD contributes details and nested recommendations cannot pollute them', () => {
  const actual = { '@type': 'Movie', url: '/subject/' + id + '/', description: '本作品简介', alternateName: ['别名', '别名'], datePublished: '2020-10-01',
    genre: ['剧情', '悬疑'], countryOfOrigin: { name: '中国大陆' }, inLanguage: ['汉语普通话'], director: [{ name: '本片导演' }], actor: [{ name: '本片演员' }],
    duration: 'PT1H52M', aggregateRating: { ratingValue: '8.6', ratingCount: '1234', bestRating: 10 },
    subjectOf: { '@type': 'TVSeries', url: '/subject/9999999/', description: 'RELATED_PRIVATE', actor: [{ name: 'RELATED_ACTOR' }] } };
  const unrelated = { '@type': 'TVSeries', url: '/subject/9999999/', description: 'RELATED_PRIVATE', actor: [{ name: 'RELATED_ACTOR' }] };
  const body = '<aside class="recommendations"><span property="v:summary">RELATED_SUMMARY</span><strong class="rating_num">1.1</strong></aside>';
  const metadata = parseDoubanSubjectMetadata(subject('screen', body, schema({ '@graph': [unrelated, actual] })), 'screen', id);
  assert.equal(metadata.kind, null, 'duration in JSON-LD alone retains conservative classification');
  assert.deepEqual(metadata.details, { summary: '本作品简介', alternateTitles: ['别名'], year: 2020, genres: ['剧情', '悬疑'], countries: ['中国大陆'],
    languages: ['汉语普通话'], doubanRating: 8.6, ratingCount: 1234, directors: ['本片导演'], cast: ['本片演员'], releaseDates: ['2020-10-01'], duration: '112分钟' });
  assert.doesNotMatch(JSON.stringify(metadata), /RELATED_/);
  assert.deepEqual(parseDoubanSubjectMetadata(subject('screen', '', schema({ '@graph': [unrelated] })), 'screen', id), { kind: null, coverUrl: null });
  const foreignPage = { '@type': 'WebPage', url: '/subject/9999999/', mainEntity: { '@type': 'TVSeries', description: 'RELATED_PRIVATE', actor: [{ name: 'RELATED_ACTOR' }] } };
  assert.deepEqual(parseDoubanSubjectMetadata(subject('screen', '', schema(foreignPage)), 'screen', id), { kind: null, coverUrl: null });
});

void test('structured book and album fields provide sparse fallbacks and reject invalid or oversized candidates', () => {
  const book = { '@type': 'Book', url: '/subject/' + id + '/', author: [{ name: '作者甲' }], translator: { name: '译者乙' }, publisher: { name: '出版社' },
    datePublished: '2021-01', numberOfPages: 500, isbn: '9781234567890', bookFormat: '精装', offers: { price: '100.00', priceCurrency: 'CNY' }, isPartOf: { name: '丛书' } };
  assert.deepEqual(parseDoubanSubjectMetadata(subject('book', '', schema(book)), 'book', id).details, { year: 2021, authors: ['作者甲'], translators: ['译者乙'],
    publisher: '出版社', publicationDate: '2021-01', pages: 500, isbn: '9781234567890', binding: '精装', price: '100.00 CNY', seriesTitle: '丛书' });
  const album = { '@type': 'MusicAlbum', url: '/subject/' + id + '/', byArtist: [{ name: '合成乐队' }], albumProductionType: '录音室专辑', musicReleaseFormat: 'CD',
    recordLabel: { name: '合成唱片' }, datePublished: '2022-02-02', track: { '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { name: '第一首' } }, { name: '第二首' }] } };
  assert.deepEqual(parseDoubanSubjectMetadata(subject('music', '', schema(album)), 'music', id).details, { year: 2022, artists: ['合成乐队'], albumType: '录音室专辑',
    medium: 'CD', label: '合成唱片', releaseDate: '2022-02-02', tracks: ['第一首', '第二首'] });
  const bad = { ...book, description: '<img src="https://private.invalid">', author: [{ name: 'a'.repeat(201) }], numberOfPages: 1000001,
    alternateName: ['x'.repeat(501)], isbn: 'x'.repeat(65), aggregateRating: { ratingValue: 8.75, ratingCount: -1 } };
  const details = parseDoubanSubjectMetadata(subject('book', '', schema(bad)), 'book', id).details;
  assert.ok(details); assert.equal(details.summary, undefined); assert.equal(details.authors, undefined); assert.equal(details.pages, undefined);
  assert.equal(details.isbn, undefined); assert.equal(details.doubanRating, undefined); assert.equal(details.ratingCount, undefined);
  assert.deepEqual(parseDoubanDetails(details), details);
  const huge = parseDoubanSubjectMetadata(subject('book', '', schema({ ...book, description: '字'.repeat(12000) })), 'book', id).details;
  assert.ok(huge); assert.equal(huge.summary, undefined); assert.ok(new TextEncoder().encode(JSON.stringify(huge)).byteLength <= 16 * 1024);
  assert.deepEqual(parseDoubanDetails(huge), huge);
});

void test('a related review rating wrapper cannot stand in for the subject rating area', () => {
  const related = '<section id="related-reviews"><div class="rating_wrap"><div class="rating_self"><strong class="rating_num">9.9</strong></div>'
    + '<div class="rating_sum"><span property="v:votes">88</span></div></div></section>';
  assert.deepEqual(parseDoubanSubjectMetadata(subject('book', related), 'book', id), { kind: 'book', coverUrl: null });
  const own = schema({ '@type': 'Book', url: '/subject/' + id + '/', aggregateRating: { ratingValue: 8.6, ratingCount: 1234, bestRating: 10 } });
  assert.deepEqual(parseDoubanSubjectMetadata(subject('book', related, own), 'book', id).details, { doubanRating: 8.6, ratingCount: 1234 });
  assert.deepEqual(parseDoubanSubjectMetadata(subject('book', related + scores('8.1', '77'), own), 'book', id).details, { doubanRating: 8.1, ratingCount: 77 });
});

void test('album tracks exclude review playlists and require the main track block or its verified heading', () => {
  const related = '<section id="related-reviews"><h2>曲目</h2><div class="track-list">REVIEW_PLAYLIST_SENTINEL</div></section>';
  const article = (contents: string) => '<div id="content"><div class="article">' + contents + '</div></div>';
  assert.deepEqual(parseDoubanSubjectMetadata(subject('music', article(related)), 'music', id), { kind: 'music', coverUrl: null });
  assert.deepEqual(parseDoubanSubjectMetadata(subject('music', article(related.replace('class="track-list"', 'id="track-list"'))), 'music', id), { kind: 'music', coverUrl: null });
  const structured = schema({ '@type': 'MusicAlbum', url: '/subject/' + id + '/', track: [{ name: '结构化第一首' }, { name: '结构化第二首' }] });
  assert.deepEqual(parseDoubanSubjectMetadata(subject('music', article(related), structured), 'music', id).details, { tracks: ['结构化第一首', '结构化第二首'] });
  const primary = '<div class="related_info"><h2>曲目 · · · · · ·</h2><div class="indent"><div class="track-list">01. 第一首<br>02. 第二首</div></div></div>';
  const details = parseDoubanSubjectMetadata(subject('music', article(primary + related), structured), 'music', id).details;
  assert.deepEqual(details, { tracks: ['01. 第一首', '02. 第二首'] }); assert.doesNotMatch(JSON.stringify(details), /REVIEW_PLAYLIST_SENTINEL/);
});

void test('movie runtime microdata works with inside or outside label colons without using the work title', () => {
  const targetId = '36154853', cover = 'https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2915454411.webp';
  const own = '<link rel="canonical" href="https://movie.douban.com/subject/' + targetId + '/"><meta property="og:type" content="video.movie">'
    + '<meta property="og:image" content="' + cover + '"><h1>好东西</h1>'
    + schema({ '@type': 'Movie', url: '/subject/' + targetId + '/', duration: 'PT123M' });
  for (const label of ['<span class="pl">片长:</span>', '<span class="pl">片长</span>:', '<span class="pl">片长</span> ： ']) {
    // No release date is present here: the external-colon runtime is the only corroborating film detail.
    const raw = own + '<div id="info">' + label + '<span property="v:runtime" content="123">123分钟</span><br></div>';
    const metadata = parseDoubanSubjectMetadata(raw, 'screen', targetId);
    assert.equal(metadata.kind, 'movie'); assert.equal(metadata.coverUrl, cover); assert.equal(metadata.details?.duration, '123分钟');
    assert.equal(parseDoubanSubjectMetadata(raw.replace('<h1>好东西</h1>', '<h1>任意公开作品名称</h1>'), 'screen', targetId).kind, 'movie');
  }
  const standard = own + '<div id="info"><span class="pl">上映日期:</span><span property="v:initialReleaseDate" content="2024-11-22">2024-11-22(中国大陆)</span><br>'
    + '<span class="pl">片长:</span><span property="v:runtime" content="123">123分钟</span><br></div>';
  assert.equal(parseDoubanSubjectMetadata(standard, 'screen', targetId).kind, 'movie');
  assert.equal(parseDoubanSubjectMetadata(own, 'screen', targetId).kind, null, 'a known title and generic Movie JSON-LD still do not establish film classification');
});

void test('outside-colon episode evidence overrides generic Movie while premiere-only TV hints remain unclassified', () => {
  for (const [label, value] of [['集数', '24'], ['季数', '2'], ['单集片长', '45分钟']]) for (const colon of [':', ' ： ']) {
    const body = '<div id="info"><span class="pl">首播</span>:<span property="v:initialReleaseDate">2024-11-22(中国大陆)</span><br>'
      + '<span class="pl">' + label + '</span>' + colon + value + '<br><span class="pl">片长:</span>123分钟<br></div>';
    assert.equal(parseDoubanSubjectMetadata(subject('screen', body, movie()), 'screen', id).kind, 'series');
  }
  const premiere = '<div id="info"><span class="pl">首播</span>:2024-11-22<br><span class="pl">片长:</span>123分钟<br></div>';
  assert.equal(parseDoubanSubjectMetadata(subject('screen', premiere, movie()), 'screen', id).kind, null);
});
