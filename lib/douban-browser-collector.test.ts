import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom/worker';
import { minify } from 'vite';
import { createDoubanBrowserCollector, renderDoubanBrowserCollectorFactory } from './douban-browser-collector.ts';
import { parseDoubanRecord, type DoubanDomain } from './douban.ts';

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
});
