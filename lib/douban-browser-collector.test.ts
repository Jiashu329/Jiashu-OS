import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom/worker';
import { minify } from 'vite';
import { createDoubanBrowserCollector, renderDoubanBrowserCollectorFactory, type DoubanBrowserCollectorReason } from './douban-browser-collector.ts';
import { parseDoubanRecord, type DoubanDomain } from './douban.ts';
import { parseDoubanSubjectMetadata } from './douban-metadata.ts';
import { parseDoubanDetails } from './douban-details.ts';

const parser = createDoubanBrowserCollector(html => parseHTML(html).document);
const hosts = { screen: 'movie.douban.com', book: 'book.douban.com', music: 'music.douban.com' };
const title = { screen: '看过的电影', book: '读过的书', music: '听过的音乐' };
const image = 'https://img3.doubanio.com/view/subject/s/public/s1234567.jpg';
function row(domain: DoubanDomain, id = '1234567', layout = 'grid', extra = '') {
  const name = '<a href="https://' + hosts[domain] + '/subject/' + id + '/"><em>合成 &amp; 名称第一季</em></a>';
  const content = '<div class="pic"><img src="/local-placeholder.jpg" data-src="' + image + '"></div>'
    + (layout === 'interest' ? '<div class="info"><h2>' + name + '</h2></div>' : '<div class="title">' + name + '</div>')
    + '<span class="rating4-t"></span><span class="date">2026-11-14 完成</span><p class="comment">自己的 &lt;短评&gt;</p>' + extra;
  return '<div class="' + (layout === 'list' ? 'item-show' : layout === 'interest' ? 'subject-item' : 'item') + '">' + content + '</div>';
}
function page(domain: DoubanDomain = 'screen', ids = ['1234567'], total = ids.length, next: number | null = null, layout = 'grid', head = '', before = '') {
  return '<!DOCTYPE html><html><head><title>合成用户' + title[domain] + '(' + total + ')</title>' + head + '</head><body>' + before
    + '<h1>合成用户' + title[domain] + '(' + total + ')</h1><span class="subject-num">1-' + ids.length + ' / ' + total + '</span>'
    + (layout === 'list' ? ids.map(id => row(domain, id, layout)).join('') : '<div class="' + (layout === 'interest' ? 'interest-list' : 'grid-view') + '">' + ids.map(id => row(domain, id, layout)).join('') + '</div>')
    + (next === null ? '' : '<div class="paginator"><span class="next"><a href="https://' + hosts[domain] + '/people/mine/collect?start=' + next + '&amp;sort=time&amp;rating=all&amp;filter=all&amp;mode=grid">下一页</a></span></div>') + '</body></html>';
}
function throws(operation: () => unknown, code = 'INVALID') {
  assert.throws(operation, (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'DOUBAN_BROWSER_' + code && !/PRIVATE|SECRET/.test(JSON.stringify(error))));
}
function globalNav(profile: string) { return '<div id="db-global-nav"><div class="top-nav-info"><div class="nav-user-account"><a href="https://www.douban.com/people/' + profile + '/">个人主页</a></div></div></div>'; }

void test('all completed collection layouts produce only normalized personal fields and official covers', () => {
  for (const domain of ['screen', 'book', 'music'] as const) for (const layout of ['grid', 'list', 'interest']) {
    const result = parser.parseCollection(page(domain, ['1234567'], 1, null, layout), 'mine', domain);
    assert.equal(result.accountProfileId, null); assert.equal(result.total, 1); assert.equal(result.nextStart, null);
    assert.deepEqual(result.items[0], { domain, subjectId: '1234567', url: 'https://' + hosts[domain] + '/subject/1234567/', title: '合成 & 名称第一季', kind: domain,
      coverUrl: image, rating: 4, markedDate: '2026-11-14', comment: '自己的 <短评>', publishedAt: null, source: 'import' });
    assert.deepEqual(parseDoubanRecord(result.items[0]), result.items[0]);
  }
});

void test('absent account proof stays unknown, matching navigation is reported, explicit mismatch stops', () => {
  assert.equal(parser.parseCollection(page(), 'mine', 'screen').accountProfileId, null);
  assert.equal(parser.parseCollection(page('screen', ['1234567'], 1, null, 'grid', '', globalNav('mine')), 'mine', 'screen').accountProfileId, 'mine');
  throws(() => parser.parseCollection(page('screen', ['1234567'], 1, null, 'grid', '', globalNav('someone_else')), 'mine', 'screen'), 'PROFILE_MISMATCH');
  const unrelated = '<aside><a href="https://www.douban.com/people/someone_else/">个人主页</a></aside>';
  assert.equal(parser.parseCollection(page('screen', ['1234567'], 1, null, 'grid', '', unrelated), 'mine', 'screen').accountProfileId, null);
});

void test('real signed-in global navigation uses /mine/ without proving the account on all three domains', () => {
  for (const domain of ['screen', 'book', 'music'] as const) for (const href of ['https://www.douban.com/mine/', '/mine/', '//www.douban.com/mine/', 'https://www.douban.com/mine', '/mine/?from=nav%20account#profile']) {
    const nav = '<div id="db-global-nav" class="global-nav"><div class="top-nav-info"><ul><li class="nav-user-account"><a class="bn-more" href="#">合成账户的帐号</a>'
      + '<div class="more-items"><ul><li><a href="' + href + '">个人主页</a></li></ul></div></li></ul></div></div>';
    const result = parser.parseCollection(page(domain, ['1234567'], 1, null, 'grid', '', nav), 'mine', domain);
    assert.equal(result.items.length, 1); assert.equal(result.total, 1); assert.equal(result.accountProfileId, null);
    throws(() => parser.parseCollection(page(domain, ['1234567'], 1, null, 'grid', '', nav + globalNav('someone_else')), 'mine', domain), 'PROFILE_MISMATCH');
  }
  for (const href of ['https://evil.invalid/mine/', '//www.douban.com.evil.invalid/mine/', 'http://www.douban.com/mine/', 'https://SECRET@www.douban.com/mine/', 'javascript:alert(1)']) {
    const nav = globalNav('mine').replace('https://www.douban.com/people/mine/', href);
    throws(() => parser.parseCollection(page('screen', ['1234567'], 1, null, 'grid', '', nav), 'mine', 'screen'));
  }
});

void test('declared collection identity and every next link must stay on the selected profile and fixed host', () => {
  const nextPage = page('book', ['1234567'], 2, 1);
  assert.equal(parser.parseCollection(nextPage, 'mine', 'book').nextStart, 1);
  const canonical = '<link rel="canonical" href="https://book.douban.com/people/mine/collect">';
  assert.equal(parser.parseCollection(page('book', ['1234567'], 1, null, 'grid', canonical), 'mine', 'book').total, 1);
  for (const raw of [nextPage.replace('/people/mine/collect?', '/people/other/collect?'), nextPage.replace('https://book.douban.com/people/', 'https://evil.invalid/people/'),
    nextPage.replace('/people/mine/collect?', '/people/mine/wish?'), page('book', ['1234567'], 1, null, 'grid', canonical.replace('/mine/', '/other/'))]) {
    throws(() => parser.parseCollection(raw, 'mine', 'book'), 'PROFILE_MISMATCH');
  }
  for (const raw of [nextPage.replace('start=1', 'start=1&amp;start=2'), nextPage.replace('start=1', 'start=01'), nextPage.replace('start=1', 'start=999'),
    nextPage.replace('mode=grid', 'mode=grid&amp;cookie=PRIVATE'), nextPage.replace('&amp;sort=time', '#PRIVATE'), nextPage.replace('sort=time', 'sort=rating')]) {
    assert.throws(() => parser.parseCollection(raw, 'mine', 'book'));
  }
});

void test('actual movie collection pagination uses unfiltered type=all and may omit rating=all', () => {
  const ids = Array.from({ length: 15 }, (_, index) => String(1234567 + index));
  const next = 'https://movie.douban.com/people/mine/collect?start=15&amp;sort=time&amp;type=all&amp;filter=all&amp;mode=grid';
  const canonical = '<link rel="canonical" href="https://movie.douban.com/people/mine/collect?start=0&amp;sort=time&amp;type=all&amp;filter=all&amp;mode=grid">';
  const html = page('screen', ids, 30, 15, 'grid', canonical).replace(/<a href="https:\/\/movie\.douban\.com\/people\/mine\/collect\?[^"]+">下一页<\/a>/, '<a href="' + next + '">下一页</a>');
  assert.ok(html.includes('<a href="' + next + '">下一页</a>'));
  const result = parser.parseCollection(html, 'mine', 'screen');
  assert.equal(result.items.length, 15); assert.equal(result.total, 30); assert.equal(result.nextStart, 15); assert.equal(result.accountProfileId, null);
  assert.equal(result.items.every(item => item.domain === 'screen' && item.kind === 'screen'), true);
  for (const key of ['type', 'filter']) {
    for (const raw of [html.replace(next, next.replace(key + '=all', key + '=1')), html.replace(canonical, canonical.replace(key + '=all', key + '=1')),
      html.replaceAll(key + '=all', key + '=all&amp;' + key + '=all')]) {
      assert.throws(() => parser.parseCollection(raw, 'mine', 'screen'), (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error && 'reason' in error);
        assert.equal(error.code, 'DOUBAN_BROWSER_INVALID'); assert.equal(error.reason, 'pagination_query');
        return true;
      });
    }
  }
});

void test('wish/doing, ambiguous empty, duplicate rows and broken pagination never become success', () => {
  assert.deepEqual(parser.parseCollection(page('music', [], 0), 'mine', 'music'), { items: [], nextStart: null, total: 0, accountProfileId: null });
  for (const raw of [page().replaceAll('看过的电影', '想看的电影'), page().replaceAll('看过的电影', '在看的电影'), page('screen', [], 1),
    page('screen', ['1234567', '1234567'], 2), page('screen', ['1234567'], 2), page('screen', ['1234567'], 1, 1),
    page('screen', ['1234567'], 2, 1).replaceAll('/subject/1234567/', '/subject/1234567/?cookie=SECRET'), '<h1>看过的电影</h1>']) throws(() => parser.parseCollection(raw, 'mine', 'screen'));
  throws(() => parser.parseCollection(page('screen', [], 0), 'mine', 'screen', 1));
});

void test('site scores cannot become personal stars, missing values stay null, invalid dates reject the page', () => {
  const raw = page().replace('<span class="rating4-t"></span>', '<span class="rating5-t aggregate-score">豆瓣站点评分</span>').replace('2026-11-14 完成', '未显示日期').replace('<p class="comment">自己的 &lt;短评&gt;</p>', '');
  const item = parser.parseCollection(raw, 'mine', 'screen').items[0];
  assert.equal(item.rating, null); assert.equal(item.markedDate, null); assert.equal(item.comment, null); assert.equal(item.kind, 'screen');
  throws(() => parser.parseCollection(page().replace('2026-11-14', '2026-02-30'), 'mine', 'screen'));
  throws(() => parser.parseCollection(page().replace('<span class="rating4-t"></span>', '<span class="rating4-t"></span><span class="rating5-t"></span>'), 'mine', 'screen'));
});

void test('login, challenge and blocked responses stop with fixed safe errors', () => {
  for (const [raw, code] of [['<title>豆瓣 - 登录跳转页</title>PRIVATE', 'LOGIN_REQUIRED'], ['<title>安全验证</title>SECRET', 'CHALLENGE'],
    ['<title>禁止访问</title>PRIVATE', 'BLOCKED'], ['<title>豆瓣</title><form action="https://sec.douban.com/c">验证码 PRIVATE</form>', 'CHALLENGE'],
    [page().replace('</body>', '<form id="login-form"><input type="password"></form></body>'), 'LOGIN_REQUIRED']]) throws(() => parser.parseCollection(raw, 'mine', 'screen'), code);
});

void test('inputs, size, structure and whitelist lengths are bounded before retaining records', () => {
  throws(() => parser.parseCollection('字'.repeat(1024 * 1024), 'mine', 'screen'), 'TOO_LARGE');
  throws(() => parser.parseCollection('<div>'.repeat(30001), 'mine', 'screen'));
  throws(() => parser.parseCollection('<!ENTITY private SYSTEM "https://private.invalid">' + page(), 'mine', 'screen'));
  throws(() => parser.parseCollection(page('screen', Array.from({ length: 31 }, (_, index) => String(1234567 + index))), 'mine', 'screen'));
  throws(() => parser.parseCollection(page().replace('合成 &amp; 名称第一季', 'x'.repeat(501)), 'mine', 'screen'));
  for (const offset of [-1, 0.5, Number.NaN, 100001]) throws(() => parser.parseCollection(page(), 'mine', 'screen', offset));
  throws(() => parser.parseCollection(page(), 'mine/../other', 'screen'));
});

void test('validation diagnostics use fixed reason enums without page text, addresses or private fields', () => {
  const cases: Array<[DoubanBrowserCollectorReason, () => unknown]> = [
    ['input', () => parser.parseCollection(page(), '../SECRET', 'screen')],
    ['document', () => parser.parseCollection('<!ENTITY private SYSTEM "https://private.invalid/SECRET">' + page(), 'mine', 'screen')],
    ['structure_limit', () => parser.parseCollection('<div>'.repeat(30001), 'mine', 'screen')],
    ['account_navigation', () => parser.parseCollection(page('screen', ['1234567'], 1, null, 'grid', '', globalNav('mine').replace('/people/mine/', '/private/SECRET')), 'mine', 'screen')],
    ['account_mismatch', () => parser.parseCollection(page('screen', ['1234567'], 1, null, 'grid', '', globalNav('SECRET')), 'mine', 'screen')],
    ['collection_identity', () => parser.parseCollection(page('screen', ['1234567'], 1, null, 'grid', '<link rel="canonical" href="https://movie.douban.com/people/SECRET/collect">'), 'mine', 'screen')],
    ['heading', () => parser.parseCollection(page().replaceAll('看过的电影', '想看的电影 SECRET'), 'mine', 'screen')],
    ['total', () => parser.parseCollection(page().replaceAll('(1)', '').replace('<span class="subject-num">1-1 / 1</span>', ''), 'mine', 'screen')],
    ['rows', () => parser.parseCollection(page('screen', [], 1), 'mine', 'screen')],
    ['item_url', () => parser.parseCollection(page().replaceAll('/subject/1234567/', '/subject/1234567/?token=SECRET'), 'mine', 'screen')],
    ['item_title', () => parser.parseCollection(page().replace('合成 &amp; 名称第一季', 'SECRET'.repeat(100)), 'mine', 'screen')],
    ['item_comment', () => parser.parseCollection(page().replace('自己的 &lt;短评&gt;', 'SECRET'.repeat(400)), 'mine', 'screen')],
    ['item_rating', () => parser.parseCollection(page().replace('<span class="rating4-t"></span>', '<span class="rating4-t"></span><span class="rating5-t"></span>'), 'mine', 'screen')],
    ['item_date', () => parser.parseCollection(page().replace('2026-11-14', '2026-02-30'), 'mine', 'screen')],
    ['duplicate_items', () => parser.parseCollection(page('screen', ['1234567', '1234567'], 2), 'mine', 'screen')],
    ['item_range', () => parser.parseCollection(page(), 'mine', 'screen', 1)],
    ['pagination_query', () => parser.parseCollection(page('screen', ['1234567'], 2, 1).replace('mode=grid', 'mode=grid&amp;token=SECRET'), 'mine', 'screen')],
    ['pagination_offset', () => parser.parseCollection(page('screen', ['1234567'], 2, 1).replace('start=1', 'start=2'), 'mine', 'screen')],
    ['pagination_incomplete', () => parser.parseCollection(page('screen', ['1234567'], 2), 'mine', 'screen')],
    ['subject_identity', () => parser.parseSubject('<h1>SECRET</h1>', 'screen', '1234567')],
    ['subject_structure', () => parser.parseSubject('<link rel="canonical" href="https://movie.douban.com/subject/1234567/">', 'screen', '1234567')],
  ];
  for (const [reason, operation] of cases) assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof Error && 'reason' in error && 'code' in error);
    assert.equal(error.reason, reason);
    assert.ok(typeof error.code === 'string' && ['DOUBAN_BROWSER_INVALID', 'DOUBAN_BROWSER_PROFILE_MISMATCH'].includes(error.code));
    assert.doesNotMatch(error.message + JSON.stringify(error), /SECRET|PRIVATE|private\.invalid|<h1>/);
    return true;
  });
});

void test('subject metadata uses bound evidence: TV beats Movie, generic Movie stays unknown', () => {
  const own = '<link rel="canonical" href="https://movie.douban.com/subject/1234567/"><h1>名称第一季</h1>';
  const movie = '<script type="application/ld+json">{"@type":"Movie","url":"/subject/1234567/"}</script>';
  assert.deepEqual(parser.parseSubject(own + movie, 'screen', '1234567'), { kind: null, coverUrl: null });
  assert.equal(parser.parseSubject(own + movie + '<div id="info"><span class="pl">集数:</span>24<br><span class="pl">单集片长:</span>45分钟</div>', 'screen', '1234567').kind, 'series');
  assert.equal(parser.parseSubject(own + movie + '<div id="info"><span class="pl">片长:</span>112分钟</div>', 'screen', '1234567').kind, 'movie');
  const unrelated = '<script type="application/ld+json">{"@type":"TVSeries","url":"/subject/9999999/","image":"' + image + '"}</script>';
  assert.deepEqual(parser.parseSubject(own + unrelated, 'screen', '1234567'), { kind: null, coverUrl: null });
  assert.equal(parser.parseSubject(own + '<script type="application/ld+json">{"@type":"TVSeries","@id":"/subject/1234567/#tv"}</script>', 'screen', '1234567').kind, 'series');
  throws(() => parser.parseSubject(own.replace('/1234567/', '/9999999/'), 'screen', '1234567'));
});

void test('subject and collection covers reject arbitrary resources and support official lazy variants', () => {
  for (const domain of ['book', 'music'] as const) {
    const own = '<link rel="canonical" href="https://' + hosts[domain] + '/subject/1234567/"><h1>条目</h1>';
    assert.deepEqual(parser.parseSubject(own + '<meta property="og:image" content="' + image + '">', domain, '1234567'), { kind: domain, coverUrl: image });
    assert.equal(parser.parseSubject(own + '<div id="mainpic"><img src="data:image/png,PRIVATE" data-srcset="//img3.doubanio.com/view/subject/s/public/s1234567.jpg 1x"></div>', domain, '1234567').coverUrl, image);
    for (const url of ['https://private.invalid/SECRET.jpg', 'https://img3.doubanio.com/view/subject/public/a.jpg?token=SECRET', 'javascript:alert(1)', 'data:image/svg+xml,SECRET']) {
      assert.equal(parser.parseSubject(own + '<meta property="og:image" content="' + url + '">', domain, '1234567').coverUrl, null);
      assert.equal(parser.parseCollection(page(domain).replace(image, url), 'mine', domain).items[0].coverUrl, null);
    }
  }
});

void test('serialized and minified factories remain self-contained and use an unattached inert template', async () => {
  const source = renderDoubanBrowserCollectorFactory();
  assert.doesNotMatch(source, /(?:fetch\(|document\.cookie|localStorage|sessionStorage|XMLHttpRequest|sendBeacon|DOMParser)/);
  const compacted = await minify('douban-collector.js', 'globalThis.factory=' + source + ';', { compress: true, mangle: true });
  assert.equal(compacted.errors.length, 0);
  const original = { factory: undefined as unknown as typeof createDoubanBrowserCollector };
  runInNewContext(compacted.code, original);
  const { document } = parseHTML('<!DOCTYPE html><html><body><div id="existing"></div></body></html>');
  const payload = page('book').replace('</body>', '<script>globalThis.EXECUTED=true</script><iframe src="https://private.invalid/iframe"></iframe><img src="https://private.invalid/image"><style>@import "https://private.invalid/css";</style></body>');
  const sandbox = { document, URL, TextEncoder, payload, result: undefined as unknown, EXECUTED: undefined as unknown,
    fetch() { throw new Error('unexpected network request'); } };
  runInNewContext('globalThis.result=(' + original.factory.toString() + ')().parseCollection(payload,"mine","book");', sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), parser.parseCollection(payload, 'mine', 'book'));
  assert.equal(sandbox.EXECUTED, undefined); assert.equal(document.querySelectorAll('iframe,script,img,style').length, 0); assert.ok(document.getElementById('existing'));
  const detailPayload = '<link rel="canonical" href="https://book.douban.com/subject/1234567/"><h1>图书</h1><div id="info"><span class="pl">作者:</span><a>作者甲</a><br><span class="pl">页数:</span>320<br></div>'
    + '<div id="link-report"><div class="intro"><p>完整图书简介。</p><p>第二段。</p></div></div><iframe src="https://private.invalid/frame"></iframe>';
  const detailedSandbox = { document, URL, TextEncoder, payload: detailPayload, result: undefined as unknown };
  runInNewContext('globalThis.result=(' + original.factory.toString() + ')().parseSubject(payload,"book","1234567");', detailedSandbox);
  const detailed = JSON.parse(JSON.stringify(detailedSandbox.result));
  assert.deepEqual(detailed, parser.parseSubject(detailPayload, 'book', '1234567'));
  assert.deepEqual(detailed.details, { summary: '完整图书简介。\n第二段。', authors: ['作者甲'], pages: 320 });
  assert.equal(document.querySelectorAll('iframe,script,img,style').length, 0);
});

void test('browser and server share subject detail extraction for all domains, including sparse structured fallbacks', () => {
  for (const domain of ['screen', 'book', 'music'] as const) {
    const own = 'https://' + hosts[domain] + '/subject/1234567/';
    const details = domain === 'screen' ? { '@type': 'TVSeries', numberOfEpisodes: 24, numberOfSeasons: 2, director: [{ name: '导演甲' }], actor: [{ name: '演员甲' }], duration: 'PT45M' }
      : domain === 'book' ? { '@type': 'Book', author: [{ name: '作者甲' }], translator: { name: '译者甲' }, publisher: { name: '出版社' }, numberOfPages: 320, isbn: '9781234567890' }
        : { '@type': 'MusicAlbum', byArtist: [{ name: '歌手甲' }], albumProductionType: '专辑', musicReleaseFormat: 'CD', recordLabel: { name: '唱片公司' }, track: [{ name: '第一首' }, { name: '第二首' }] };
    const actual = { ...details, mainEntityOfPage: { '@id': own }, description: '作品完整简介。\n第二段。', genre: ['合成类型'], alternateName: ['别名'], datePublished: '2021-01-01',
      aggregateRating: { ratingValue: 8.8, ratingCount: 1234 } };
    const raw = '<link rel="canonical" href="' + own + '"><h1>作品</h1><script type="application/ld+json">' + JSON.stringify(actual) + '</script>';
    const result = parser.parseSubject(raw, domain, '1234567');
    assert.deepEqual(result, parseDoubanSubjectMetadata(raw, domain, '1234567'));
    assert.ok(result.details); assert.deepEqual(parseDoubanDetails(result.details), result.details);
    assert.equal(result.details.summary, '作品完整简介。\n第二段。');
  }
});

void test('related subject detail blocks and foreign WebPage mainEntity cannot enter the current subject', () => {
  const own = '<link rel="canonical" href="https://movie.douban.com/subject/1234567/"><h1>本作品</h1>';
  const foreign = { '@type': 'WebPage', url: '/subject/9999999/', mainEntity: { '@type': 'TVSeries', description: 'RELATED_PRIVATE', director: { name: 'RELATED_DIRECTOR' } } };
  const json = '<script type="application/ld+json">' + JSON.stringify(foreign) + '</script>';
  assert.deepEqual(parser.parseSubject(own + json, 'screen', '1234567'), { kind: null, coverUrl: null });
  const actual = { '@type': 'Movie', url: '/subject/1234567/', description: '本作品简介', director: { name: '本作品导演' } };
  const mixed = own + '<aside><span property="v:summary">RELATED_SUMMARY</span><strong class="rating_num">1.1</strong></aside>'
    + '<script type="application/ld+json">' + JSON.stringify({ '@graph': [foreign, actual] }) + '</script>';
  const parsed = parser.parseSubject(mixed, 'screen', '1234567');
  assert.deepEqual(parsed.details, { summary: '本作品简介', directors: ['本作品导演'] }); assert.doesNotMatch(JSON.stringify(parsed), /RELATED_/);
});

void test('related rating wrappers stay excluded while bound JSON-LD and the primary rating area remain usable', () => {
  const own = '<link rel="canonical" href="https://book.douban.com/subject/1234567/"><h1>本作品</h1>';
  const related = '<section id="related-reviews"><div class="rating_wrap"><div class="rating_self"><strong class="rating_num">9.9</strong></div>'
    + '<div class="rating_sum"><span property="v:votes">88</span></div></div></section>';
  assert.deepEqual(parser.parseSubject(own + related, 'book', '1234567'), { kind: 'book', coverUrl: null });
  const structured = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Book', url: '/subject/1234567/', aggregateRating: { ratingValue: 8.6, ratingCount: 1234 } }) + '</script>';
  assert.deepEqual(parser.parseSubject(own + related + structured, 'book', '1234567').details, { doubanRating: 8.6, ratingCount: 1234 });
  const primary = '<div id="interest_sectl"><div class="rating_self"><strong property="v:average">8.1</strong></div><div class="rating_sum"><span property="v:votes">77</span></div></div>';
  assert.deepEqual(parser.parseSubject(own + related + structured + primary, 'book', '1234567').details, { doubanRating: 8.1, ratingCount: 77 });
});

void test('album track lists require the primary block or main article heading and never use a review playlist', () => {
  const own = '<link rel="canonical" href="https://music.douban.com/subject/1234567/"><h1>本专辑</h1>';
  const related = '<section id="related-reviews"><h2>曲目</h2><div class="track-list">REVIEW_PLAYLIST_SENTINEL</div></section>';
  const article = (contents: string) => '<div id="content"><div class="article">' + contents + '</div></div>';
  assert.deepEqual(parser.parseSubject(own + article(related), 'music', '1234567'), { kind: 'music', coverUrl: null });
  assert.deepEqual(parser.parseSubject(own + article(related.replace('class="track-list"', 'id="track-list"')), 'music', '1234567'), { kind: 'music', coverUrl: null });
  const structured = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'MusicAlbum', url: '/subject/1234567/', track: [{ name: '结构化曲目' }] }) + '</script>';
  assert.deepEqual(parser.parseSubject(own + article(related) + structured, 'music', '1234567').details, { tracks: ['结构化曲目'] });
  const primary = '<div class="related_info"><h2>曲目 · · · · · ·</h2><div class="indent"><div class="track-list">01. 第一首<br>02. 第二首</div></div></div>';
  const details = parser.parseSubject(own + article(primary + related) + structured, 'music', '1234567').details;
  assert.deepEqual(details, { tracks: ['01. 第一首', '02. 第二首'] }); assert.doesNotMatch(JSON.stringify(details), /REVIEW_PLAYLIST_SENTINEL/);
  assert.deepEqual(parser.parseSubject(own + '<div id="track-list">主曲目</div>', 'music', '1234567').details, { tracks: ['主曲目'] });
});

void test('browser film classification reads standard runtime microdata and span-external colons identically to the server', () => {
  const targetId = '36154853', cover = 'https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2915454411.webp';
  const own = '<link rel="canonical" href="https://movie.douban.com/subject/' + targetId + '/"><meta property="og:type" content="video.movie">'
    + '<meta property="og:image" content="' + cover + '"><h1>好东西</h1><script type="application/ld+json">'
    + JSON.stringify({ '@type': 'Movie', url: '/subject/' + targetId + '/', duration: 'PT123M' }) + '</script>';
  for (const label of ['<span class="pl">片长:</span>', '<span class="pl">片长</span>:', '<span class="pl">片长</span> ： ']) {
    const raw = own + '<div id="info">' + label + '<span property="v:runtime" content="123">123分钟</span><br></div>';
    const metadata = parser.parseSubject(raw, 'screen', targetId);
    assert.equal(metadata.kind, 'movie'); assert.equal(metadata.coverUrl, cover); assert.equal(metadata.details?.duration, '123分钟');
    assert.deepEqual(metadata, parseDoubanSubjectMetadata(raw, 'screen', targetId));
    assert.equal(parser.parseSubject(raw.replace('<h1>好东西</h1>', '<h1>任意公开作品名称</h1>'), 'screen', targetId).kind, 'movie');
  }
  const standard = own + '<div id="info"><span class="pl">上映日期:</span><span property="v:initialReleaseDate" content="2024-11-22">2024-11-22(中国大陆)</span><br>'
    + '<span class="pl">片长:</span><span property="v:runtime" content="123">123分钟</span><br></div>';
  assert.equal(parser.parseSubject(standard, 'screen', targetId).kind, 'movie');
  assert.equal(parser.parseSubject(own, 'screen', targetId).kind, null);
});

void test('browser episode counts and durations outside labels take TV priority without treating premiere-only as proven TV', () => {
  const own = '<link rel="canonical" href="https://movie.douban.com/subject/1234567/"><h1>合成影视</h1>'
    + '<script type="application/ld+json">{"@type":"Movie","url":"/subject/1234567/"}</script>';
  for (const [label, value] of [['集数', '24'], ['季数', '2'], ['单集片长', '45分钟']]) for (const colon of [':', ' ： ']) {
    const raw = own + '<div id="info"><span class="pl">首播</span>:<span property="v:initialReleaseDate">2024-11-22(中国大陆)</span><br>'
      + '<span class="pl">' + label + '</span>' + colon + value + '<br><span class="pl">片长:</span>123分钟<br></div>';
    assert.equal(parser.parseSubject(raw, 'screen', '1234567').kind, 'series');
    assert.deepEqual(parser.parseSubject(raw, 'screen', '1234567'), parseDoubanSubjectMetadata(raw, 'screen', '1234567'));
  }
  const premiere = own + '<div id="info"><span class="pl">首播</span>:2024-11-22<br><span class="pl">片长:</span>123分钟<br></div>';
  assert.equal(parser.parseSubject(premiere, 'screen', '1234567').kind, null);
});
