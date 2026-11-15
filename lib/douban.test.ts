import assert from 'node:assert/strict';
import test from 'node:test';
import { DoubanValidationError, doubanSubjectUrl, normalizeDoubanCover, parseDoubanProfile, parseDoubanRecord } from './douban.ts';
import type { DoubanRecordInput } from './douban.ts';

const sample: DoubanRecordInput = { domain: 'screen', subjectId: '1234567', title: ' 合成电影 ', url: 'https://movie.douban.com/subject/1234567/', kind: 'movie', coverUrl: null,
  rating: 4, markedDate: '2026-11-14', comment: ' 很喜欢这部作品。 ', publishedAt: null, source: 'collection' };

test('profile parsing only accepts a bounded declared Douban profile and canonicalises the known host', () => {
  for (const raw of ['synthetic_user-1', 'https://www.douban.com/people/synthetic_user-1/', ' https://douban.com/people/synthetic_user-1 ']) {
    assert.deepEqual(parseDoubanProfile(raw), { profileId: 'synthetic_user-1', profileUrl: 'https://www.douban.com/people/synthetic_user-1/' });
  }
  assert.equal(parseDoubanProfile('1234567').profileId, '1234567');
  for (const raw of [null, {}, '', 'a'.repeat(65), 'http://www.douban.com/people/alice/', 'https://www.douban.com:443/people/alice/',
    'https://www.douban.com:444/people/alice/', 'https://www.douban.com/people/alice/?', 'https://www.douban.com/people/alice/#',
    'https://www.douban.com/people/alice/?user=bob', 'https://user:secret@www.douban.com/people/alice/', 'https://www.douban.com.evil.invalid/people/alice/',
    'https://movie.douban.com/people/alice/', 'https://127.0.0.1/people/alice/', 'https://www.douban.com/x/../people/alice/',
    'https://www.douban.com/people/%61lice/', 'alice\nCookie: secret', 'https://www.douban.com\\people\\alice\\']) {
    assert.throws(() => parseDoubanProfile(raw), DoubanValidationError, String(raw));
  }
});

test('normalised records retain personal unknowns, independent publication time and safe canonical identities', () => {
  const result = parseDoubanRecord(sample);
  assert.equal(result.title, '合成电影'); assert.equal(result.comment, '很喜欢这部作品。'); assert.equal(result.markedDate, '2026-11-14');
  assert.equal(result.rating, 4); assert.equal(result.publishedAt, null);
  assert.equal(sample.title, ' 合成电影 ', 'normalisation must not mutate caller data');
  const rss = parseDoubanRecord({ ...sample, kind: 'screen', rating: null, comment: null, markedDate: null, publishedAt: '2026-11-14T08:00:00+08:00', source: 'rss' });
  assert.equal(rss.markedDate, null); assert.equal(rss.publishedAt, '2026-11-14T00:00:00.000Z'); assert.equal(rss.rating, null);
  assert.equal(doubanSubjectUrl('book', '1234567'), 'https://book.douban.com/subject/1234567/');
});

void test('browser provenance retains explicit empty personal fields while requiring the complete snapshot shape', () => {
  const browser = parseDoubanRecord({ ...sample, source: 'browser', rating: null, comment: null, markedDate: null });
  assert.deepEqual([browser.source, browser.rating, browser.comment, browser.markedDate], ['browser', null, null, null]);
  const missing = { ...browser } as Record<string, unknown>; delete missing.comment;
  assert.throws(() => parseDoubanRecord(missing), DoubanValidationError, 'unknown and explicitly empty fields must not be conflated');
});

test('strict record validation rejects cross-source IDs, unknown fields, rating coercion and impossible dates', () => {
  for (const change of [{ userId: 'another-user' }, { profileId: 'another-profile' }, { domain: 'movie' }, { kind: 'book' }, { title: '' },
    { title: 'a'.repeat(501) }, { subjectId: '0123' }, { subjectId: 123 }, { rating: '5' }, { rating: 0 }, { rating: 6 },
    { markedDate: '2026-02-30' }, { publishedAt: '2026-02-30T00:00:00Z' }, { publishedAt: 'bad' },
    { url: 'https://book.douban.com/subject/1234567/' }, { url: 'https://movie.douban.com/subject/1234567/?url=https://evil.invalid' },
    { source: 'rss' }, { comment: 'a'.repeat(2001) }, { comment: 'bad\u0000data' }, { coverUrl: 'https://evil.invalid/cover.jpg' }]) {
    assert.throws(() => parseDoubanRecord({ ...sample, ...change }), DoubanValidationError);
  }
  const missing = { ...sample } as Record<string, unknown>; delete missing.publishedAt;
  assert.throws(() => parseDoubanRecord(missing), DoubanValidationError);
});

test('covers allow only bounded official image locations and carry no URL credentials or parameters', () => {
  assert.equal(normalizeDoubanCover('http://img3.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg'), 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg');
  assert.equal(normalizeDoubanCover(null), null);
  for (const url of ['https://img3.doubanio.com.evil.invalid/view/photo/p.jpg', 'https://img3.doubanio.com/view/photo/p.jpg?secret=x',
    'https://user:secret@img3.doubanio.com/view/photo/p.jpg', 'http://127.0.0.1/view/photo/p.jpg', 'https://img3.doubanio.com/not-an-image']) {
    assert.throws(() => normalizeDoubanCover(url), DoubanValidationError);
  }
});
