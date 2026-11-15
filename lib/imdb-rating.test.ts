import assert from 'node:assert/strict';
import test from 'node:test';
import { IMDB_ATTRIBUTION, IMDB_DATASET_URL, IMDB_RATING_SOURCE, parseIMDbRating, serializeIMDbRating, validIMDbRatingDate } from './imdb-rating.ts';

const snapshot = { imdbId: 'tt0111161', rating: 9.3, ratingCount: 3000000, source: IMDB_RATING_SOURCE,
  checkedAt: '2026-11-15T12:30:40.000Z', datasetDate: '2026-11-14' };

test('official rating snapshots serialize in a canonical order and keep absent scores distinct from zero', () => {
  assert.equal(parseIMDbRating({}), null); assert.equal(serializeIMDbRating({}), '{}');
  assert.equal(parseIMDbRating(Object.create(null)), null);
  const shuffled = { datasetDate: snapshot.datasetDate, checkedAt: snapshot.checkedAt, source: snapshot.source,
    ratingCount: snapshot.ratingCount, rating: snapshot.rating, imdbId: snapshot.imdbId };
  assert.deepEqual(parseIMDbRating(Object.freeze(shuffled)), snapshot);
  assert.equal(serializeIMDbRating(shuffled), JSON.stringify(snapshot));
  assert.deepEqual(parseIMDbRating(Object.assign(Object.create(null), { ...snapshot, datasetDate: null })), { ...snapshot, datasetDate: null });
  const result = parseIMDbRating(snapshot); assert.notEqual(result, snapshot);
  assert.equal(IMDB_DATASET_URL, 'https://datasets.imdbws.com/title.ratings.tsv.gz');
  assert.equal(IMDB_ATTRIBUTION, 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.');
});

test('invalid identifiers, scores and counts cannot become a trusted IMDb rating', () => {
  for (const value of [null, undefined, [], '', 8.5, { ...snapshot, imdbId: 'tt123' }, { ...snapshot, imdbId: 'https://www.imdb.com/title/tt0111161/' },
    { ...snapshot, imdbId: 'tt12345678901' }, { ...snapshot, rating: 0 }, { ...snapshot, rating: -1 }, { ...snapshot, rating: 10.1 },
    { ...snapshot, rating: Number.NaN }, { ...snapshot, rating: Infinity }, { ...snapshot, rating: '9.3' }, { ...snapshot, ratingCount: 0 },
    { ...snapshot, ratingCount: 1.1 }, { ...snapshot, ratingCount: Number.MAX_SAFE_INTEGER + 1 }, { ...snapshot, ratingCount: '3000000' }]) {
    assert.throws(() => parseIMDbRating(value), TypeError);
    assert.throws(() => serializeIMDbRating(value), TypeError);
  }
  assert.equal(parseIMDbRating({ ...snapshot, rating: 10, ratingCount: 1 })?.rating, 10);
});

test('dataset dates and check timestamps require real calendar dates and exact UTC serialization', () => {
  assert.equal(validIMDbRatingDate('2024-02-29'), true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '2026-11-14T00:00:00.000Z', '', null, undefined]) {
    assert.equal(validIMDbRatingDate(value), false);
    if (value !== null) assert.throws(() => parseIMDbRating({ ...snapshot, datasetDate: value }), TypeError);
  }
  for (const value of ['2026-02-29T12:30:40.000Z', '2026-11-15T24:00:00.000Z', '2026-11-15T12:30:40Z', '2026-11-15T12:30:40.000+00:00',
    '2026-11-15', '', null, undefined]) assert.throws(() => parseIMDbRating({ ...snapshot, checkedAt: value }), TypeError);
  assert.throws(() => parseIMDbRating({ ...snapshot, datasetDate: '2026-11-16' }), TypeError);
  assert.throws(() => parseIMDbRating({ ...snapshot, checkedAt: '2026-11-13T23:59:59.999Z' }), TypeError);
  assert.equal(parseIMDbRating({ ...snapshot, checkedAt: '2026-11-14T00:00:00.000Z' })?.datasetDate, '2026-11-14');
});

test('untrusted sources and missing, hidden, inherited or additional fields cannot masquerade as dataset provenance', () => {
  const missing = { ...snapshot } as Partial<typeof snapshot>; delete missing.datasetDate;
  const hidden = { ...snapshot }; Object.defineProperty(hidden, 'rating', { value: snapshot.rating, enumerable: false });
  const hiddenExtra = { ...snapshot }; Object.defineProperty(hiddenExtra, 'extra', { value: 'PRIVATE', enumerable: false });
  for (const value of [{ ...snapshot, source: 'tmdb' }, { ...snapshot, source: 'imdb' }, { ...snapshot, vote_average: 9.3 },
    { ...snapshot, token: 'PRIVATE' }, missing, hidden, hiddenExtra, { ...snapshot, [Symbol('secret')]: 'PRIVATE' },
    Object.create(snapshot), Object.assign(new Date(), snapshot)]) assert.throws(() => parseIMDbRating(value), TypeError);
});

test('accessor fields and toJSON hooks are rejected without executing or reflecting their contents', () => {
  let reads = 0;
  const accessor = { ...snapshot };
  Object.defineProperty(accessor, 'rating', { enumerable: true, get() { reads++; throw new Error('PRIVATE'); } });
  for (const value of [accessor, { ...snapshot, toJSON() { reads++; return { token: 'PRIVATE' }; } }]) {
    assert.throws(() => serializeIMDbRating(value), error => error instanceof TypeError && !error.message.includes('PRIVATE'));
  }
  assert.equal(reads, 0);
});
