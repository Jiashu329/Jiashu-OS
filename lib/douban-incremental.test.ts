import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { shouldRefreshDoubanDetails, shouldRefreshIMDbRating } from './douban-incremental.ts';

const now = Date.parse('2026-11-15T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;
const timestamp = (age = 0) => new Date(now - age).toISOString();
const hint = (age = 0) => ({ collectionHash: 'a'.repeat(64), detailsCheckedAt: timestamp(age) });
const imdbId = 'tt1234567';
const snapshot = (age = 0) => ({ imdbId, rating: 8.6, ratingCount: 12345, source: 'imdb-datasets', checkedAt: timestamp(age) });
const screen = (age = 0) => ({ domain: 'screen', details: { imdbId }, imdb: snapshot(age) });

test('a successful recent details check is reusable even when the source left optional fields unknown', () => {
  const item = { domain: 'screen', kind: 'screen', coverUrl: null, details: {}, sync: hint() };
  assert.equal(shouldRefreshDoubanDetails(item, false, now), false);
  assert.equal(shouldRefreshDoubanDetails({ ...item, sync: hint(7 * day - 1) }, false, now), false);
  assert.equal(shouldRefreshDoubanDetails({ ...item, sync: hint(7 * day) }, false, now), true);
  assert.equal(shouldRefreshDoubanDetails({ ...item, sync: hint(7 * day + 1) }, false, now), true);
  assert.equal(shouldRefreshDoubanDetails(item, true, now), true);
});

test('missing, changed, invalid or future details hints refresh conservatively without trusting updatedAt', () => {
  for (const sync of [undefined, null, [], {}, { ...hint(), collectionHash: null }, { ...hint(), collectionHash: 'z'.repeat(64) },
    { ...hint(), collectionHash: 'a'.repeat(63) }, { ...hint(), detailsCheckedAt: null }, { ...hint(), detailsCheckedAt: 'not-a-time' },
    { ...hint(), detailsCheckedAt: '2026-02-30T12:00:00.000Z' }, hint(-1)]) {
    assert.equal(shouldRefreshDoubanDetails({ sync, updatedAt: timestamp() }, false, now), true);
  }
  assert.equal(shouldRefreshDoubanDetails({ sync: hint() }, false, NaN), true);
  assert.equal(shouldRefreshDoubanDetails(null, false, now), true);
  assert.equal(shouldRefreshDoubanDetails({ sync: { ...hint(), detailsCheckedAt: '2026-11-15T12:00:00Z' } }, false, now), false);
});

test('IMDb ratings use a separate twenty-four-hour boundary and full mode still needs a real screen IMDb ID', () => {
  assert.equal(shouldRefreshIMDbRating(screen(), false, now), false);
  assert.equal(shouldRefreshIMDbRating(screen(day - 1), false, now), false);
  assert.equal(shouldRefreshIMDbRating(screen(day), false, now), true);
  assert.equal(shouldRefreshIMDbRating(screen(day + 1), false, now), true);
  assert.equal(shouldRefreshIMDbRating(screen(), true, now), true);
  for (const item of [null, {}, { ...screen(), domain: 'book' }, { ...screen(), details: {} }, { ...screen(), details: { imdbId: 'tt123' } }]) {
    assert.equal(shouldRefreshIMDbRating(item, false, now), false);
    assert.equal(shouldRefreshIMDbRating(item, true, now), false);
  }
});

test('IMDb reuse requires the current ID, official source, a valid score, vote count and checked time', () => {
  for (const imdb of [null, [], {}, { ...snapshot(), imdbId: 'tt7654321' }, { ...snapshot(), source: 'tmdb' },
    { ...snapshot(), rating: 0 }, { ...snapshot(), rating: 10.1 }, { ...snapshot(), rating: '8.6' },
    { ...snapshot(), ratingCount: 0 }, { ...snapshot(), ratingCount: 1.5 }, { ...snapshot(), ratingCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot(), checkedAt: '2026-02-30T12:00:00.000Z' }, { ...snapshot(), checkedAt: 'not-a-time' }, snapshot(-1)]) {
    assert.equal(shouldRefreshIMDbRating({ ...screen(), imdb, updatedAt: timestamp(), sync: hint() }, false, now), true);
  }
  assert.equal(shouldRefreshIMDbRating(screen(), false, NaN), true);
  assert.equal(shouldRefreshIMDbRating({ ...screen(), imdb: { ...snapshot(), checkedAt: '2026-11-15T12:00:00Z' } }, false, now), false);
});

test('both decisions work when embedded from toString without module imports or shared helpers', () => {
  const details = runInNewContext('(' + shouldRefreshDoubanDetails.toString() + ')') as typeof shouldRefreshDoubanDetails;
  const rating = runInNewContext('(' + shouldRefreshIMDbRating.toString() + ')') as typeof shouldRefreshIMDbRating;
  assert.equal(details({ sync: hint() }, false, now), false);
  assert.equal(details({ sync: hint(7 * day) }, false, now), true);
  assert.equal(rating(screen(), false, now), false);
  assert.equal(rating(screen(day), false, now), true);
  assert.equal(rating(screen(), true, now), true);
});
