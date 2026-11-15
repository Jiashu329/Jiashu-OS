import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { minify } from 'vite';
import { createDoubanDetailsParser, DOUBAN_DETAILS_MAX_BYTES, DoubanDetailsValidationError, mergeDoubanDetails, parseDoubanDetails,
  renderDoubanDetailsParserFactory, type DoubanSubjectDetails } from './douban-details.ts';

const details: DoubanSubjectDetails = {
  summary: '合成作品简介。\n\n第二段，保留作者的段落。', alternateTitles: ['Another Title', '别名'], year: 2026,
  genres: ['剧情', '科幻'], countries: ['中国大陆'], languages: ['汉语普通话'], doubanRating: 8.7, ratingCount: 123456, imdbId: 'tt1234567',
  directors: ['导演甲'], writers: ['编剧甲'], cast: ['演员甲', '演员乙'], releaseDates: ['2026-11-01(中国大陆)'],
  duration: '118分钟 / 125分钟(导演剪辑版)', episodes: 12, seasons: 2, episodeDuration: '45分钟',
  authors: ['作者甲'], translators: ['译者乙'], publisher: '合成出版社', publicationDate: '2026-11', pages: 320,
  isbn: '978-7-000-00000-0', binding: '精装', price: '68.00元', seriesTitle: '合成丛书', artists: ['乐手甲'],
  albumType: '专辑', medium: 'CD', label: '合成唱片', releaseDate: '2026-10-01', tracks: ['01 序曲', '02 终章'],
};
const invalid = (error: unknown) => error instanceof DoubanDetailsValidationError && error.code === 'INVALID_DOUBAN_INPUT' && error.status === 400;

void test('all supported public subject fields survive without coercing personal scores, textual dates or durations', () => {
  assert.deepEqual(parseDoubanDetails(details), details);
  assert.equal(parseDoubanDetails({ doubanRating: 0, ratingCount: 0 }).doubanRating, 0);
  assert.deepEqual(parseDoubanDetails({ publicationDate: '2026年冬', releaseDate: '未定', duration: '118分钟 / 125分钟' }), {
    duration: '118分钟 / 125分钟', publicationDate: '2026年冬', releaseDate: '未定',
  });
  assert.deepEqual(Object.keys(parseDoubanDetails(Object.fromEntries(Object.entries(details).reverse()))), Object.keys(details));
});

void test('legacy missing details and empty optional fields normalize to an empty object while malformed top-level data is refused', () => {
  for (const raw of [undefined, null, {}, { summary: '  ', cast: [], pages: null, year: undefined, countries: ['', '\t'] }]) assert.deepEqual(parseDoubanDetails(raw), {});
  for (const raw of ['', '{}', 0, false, [], new Date(), Object.create({ summary: 'inherited' })]) assert.throws(() => parseDoubanDetails(raw), invalid);
  assert.deepEqual(parseDoubanDetails(Object.assign(Object.create(null), { publisher: ' 合成出版社 ' })), { publisher: '合成出版社' });
});

void test('formatting whitespace is normalized, summaries retain paragraphs and lists deduplicate without reordering', () => {
  assert.deepEqual(parseDoubanDetails({ summary: ' \t第一段\r\n\r\n第二段\r第三段 \n', directors: ['导演甲', ' 导演乙 ', '导演甲', ''],
    publisher: '  合成\n 出版社\t 研究分社 ' }), { summary: '第一段\n\n第二段\n第三段', directors: ['导演甲', '导演乙'], publisher: '合成 出版社 研究分社' });
  assert.deepEqual(parseDoubanDetails({ summary: '数值满足 0 < x 且 x > 1，书名为《作品》；这是纯文本。' }), {
    summary: '数值满足 0 < x 且 x > 1，书名为《作品》；这是纯文本。',
  });
});

void test('private or unknown keys, symbol keys, getters and prototype-shaped data are rejected without executing getters', () => {
  for (const key of ['myRating', 'myComment', 'profileId', 'cookie', 'source', 'unknown', 'constructor', '__proto__']) {
    assert.throws(() => parseDoubanDetails(Object.fromEntries([[key, 'PRIVATE_PAYLOAD']])), invalid);
  }
  assert.throws(() => parseDoubanDetails({ [Symbol('private')]: 'PRIVATE_PAYLOAD' }), invalid);
  let accessed = false;
  const getter = Object.defineProperty({}, 'summary', { enumerable: true, get() { accessed = true; return 'PRIVATE_PAYLOAD'; } });
  assert.throws(() => parseDoubanDetails(getter), invalid); assert.equal(accessed, false);
});

void test('HTML and nonformatting control bytes cannot enter public metadata or leak into validation messages', () => {
  for (const value of ['<script>PRIVATE_PAYLOAD</script>', '<img src="https://private.invalid/PRIVATE_PAYLOAD">', '<!--PRIVATE_PAYLOAD-->',
    '<!DOCTYPE html>PRIVATE_PAYLOAD', 'PRIVATE_PAYLOAD\u0000', 'PRIVATE_PAYLOAD\u000b', 'PRIVATE_PAYLOAD\u007f', 'PRIVATE_PAYLOAD\u0085']) {
    for (const raw of [{ summary: value }, { authors: [value] }]) assert.throws(() => parseDoubanDetails(raw), error => {
      assert.ok(invalid(error)); assert.doesNotMatch((error as Error).message, /PRIVATE_PAYLOAD|private\.invalid|<script|<img/); return true;
    });
  }
});

void test('field types and numeric ranges are strict, including the independent ten-point site rating', () => {
  const cases: unknown[] = [{ summary: 1 }, { authors: '作者甲' }, { cast: [null] }, { tracks: [['曲目']] }, { year: '2026' },
    { year: 0 }, { year: 2101 }, { year: 2026.5 }, { doubanRating: 10.1 }, { doubanRating: -0.1 }, { doubanRating: 8.75 },
    { doubanRating: NaN }, { ratingCount: Infinity }, { ratingCount: 1.5 }, { ratingCount: 1000000001 }, { episodes: 0 },
    { episodes: 100001 }, { seasons: 10001 }, { pages: 0 }, { pages: 1000001 }, { duration: 118 }];
  for (const raw of cases) assert.throws(() => parseDoubanDetails(raw), invalid);
  assert.deepEqual(parseDoubanDetails({ year: 1, doubanRating: 10, ratingCount: 1000000000, episodes: 100000, seasons: 10000, pages: 1000000 }),
    { year: 1, doubanRating: 10, ratingCount: 1000000000, episodes: 100000, seasons: 10000, pages: 1000000 });
});

void test('IMDb accepts only a bounded external title ID and never a URL, rating, whitespace or person ID', () => {
  for (const imdbId of ['tt1234567', 'tt1234567890']) assert.deepEqual(parseDoubanDetails({ imdbId }), { imdbId });
  for (const imdbId of ['', ' tt1234567', 'tt1234567 ', 'TT1234567', 'tt123456', 'tt12345678901', 'nm1234567',
    'https://www.imdb.com/title/tt1234567/', 'tt1234567?ref_=x', 'tt1234567\n', 8.5, { id: 'tt1234567' }]) {
    assert.throws(() => parseDoubanDetails({ imdbId }), invalid);
  }
  assert.deepEqual(mergeDoubanDetails({ imdbId: 'tt1234567', doubanRating: 8.5 }, { summary: '刷新简介' }),
    { summary: '刷新简介', doubanRating: 8.5, imdbId: 'tt1234567' });
});

void test('individual strings, list sizes, and combined multilingual JSON bytes are bounded without silent truncation', () => {
  for (const raw of [{ duration: 'x'.repeat(101) }, { isbn: 'x'.repeat(65) }, { publisher: 'x'.repeat(501) }, { summary: 'x'.repeat(12001) },
    { directors: ['x'.repeat(201)] }, { alternateTitles: Array(51).fill('别名') }, { releaseDates: Array(51).fill('2026') },
    { tracks: Array(301).fill('序曲') }, { tracks: ['x'.repeat(501)] }, { summary: '中'.repeat(5500) }]) assert.throws(() => parseDoubanDetails(raw), invalid);
  const known = parseDoubanDetails({ summary: '中'.repeat(5000) });
  assert.equal(known.summary?.length, 5000); assert.ok(new TextEncoder().encode(JSON.stringify(known)).byteLength < DOUBAN_DETAILS_MAX_BYTES);
  assert.equal(createDoubanDetailsParser().limits.jsonBytes, DOUBAN_DETAILS_MAX_BYTES);
});

void test('metadata refresh replaces nonempty fields while missing facts preserve older known values and input arrays stay untouched', () => {
  const old: DoubanSubjectDetails = { summary: '原简介', directors: ['导演甲', '导演乙'], genres: ['旧分类'], year: 2020, doubanRating: 8.5, ratingCount: 10 };
  const incoming = { summary: null, directors: [], genres: ['新分类'], year: undefined, doubanRating: 8.6, ratingCount: 0, authors: ['作者甲'] };
  const beforeOld = structuredClone(old), beforeIncoming = structuredClone(incoming);
  const merged = mergeDoubanDetails(old, incoming);
  assert.deepEqual(merged, { summary: '原简介', year: 2020, genres: ['新分类'], doubanRating: 8.6, ratingCount: 0, directors: ['导演甲', '导演乙'], authors: ['作者甲'] });
  assert.deepEqual(old, beforeOld); assert.deepEqual(incoming, beforeIncoming);
  merged.directors?.push('仅修改结果'); assert.deepEqual(old.directors, ['导演甲', '导演乙']);
  assert.deepEqual(mergeDoubanDetails(undefined, undefined), {});
  assert.throws(() => mergeDoubanDetails(old, { privateField: 'PRIVATE_PAYLOAD' }), invalid);
  assert.throws(() => mergeDoubanDetails({ summary: '中'.repeat(5000) }, { tracks: ['曲'.repeat(500)] }), invalid);
});

void test('the serialized minified factory validates and merges in a fresh realm without model, DOM, network or persistent storage dependencies', async () => {
  const source = renderDoubanDetailsParserFactory();
  assert.doesNotMatch(source, /(?:fetch\(|document\.|localStorage|sessionStorage|XMLHttpRequest|sendBeacon|eval\()/);
  const result = await minify('douban-details-factory.js', 'globalThis.factory=' + source + ';', { compress: true, mangle: true });
  assert.equal(result.errors.length, 0);
  const sandbox = { TextEncoder, payload: JSON.stringify(details), output: undefined as unknown, invalidError: undefined as unknown };
  runInNewContext(result.code + '\nconst helper=factory();globalThis.output=helper.merge(JSON.parse(payload),{summary:null,genres:["刷新分类"]});'
    + 'try{helper.parse({cookie:"PRIVATE_PAYLOAD"});}catch(error){globalThis.invalidError={name:error.name,code:error.code,status:error.status,message:error.message};}', sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.output)), { ...details, genres: ['刷新分类'] });
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.invalidError)), { name: 'DoubanDetailsValidationError', code: 'INVALID_DOUBAN_INPUT', status: 400,
    message: '豆瓣作品详情格式不正确，请核对字段、长度和数值后重试。' });
});
