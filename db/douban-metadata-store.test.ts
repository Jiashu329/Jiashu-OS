import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { classifyDoubanRecord, readDoubanMetadataRecord, saveDoubanSubjectMetadata } from './douban-metadata-store.ts';
import { DoubanStoreError, doubanDetailsJson, readDoubanRecord, type DoubanDatabase, type DoubanRecord } from './douban-store.ts';

const T1 = '2026-11-14T08:00:00.000Z', T2 = '2026-11-14T08:01:00.000Z';
const COVER = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg';
const KEY = { profileId: 'source-profile', domain: 'screen' as const, subjectId: '12345', expectedUpdatedAt: T1 };
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../drizzle/0024_douban.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0025_douban_data_resets.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0027_douban_subject_details.sql', import.meta.url), 'utf8'));
  const queries: string[] = [];
  const db = { prepare(sql: string) {
    queries.push(sql); const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const bound = { bind(...input: unknown[]) { values = input as SQLInputValue[]; return bound; },
      async first<T>() { const row = statement.get(...values); return row ? { ...row } as T : null; } };
    return bound;
  } } as unknown as DoubanDatabase;
  function seed(owner = 'alice', patch: Partial<DoubanRecord> = {}) {
    const item: DoubanRecord = { profileId: KEY.profileId, domain: 'screen', subjectId: KEY.subjectId, title: owner + '-private-title',
      url: 'https://movie.douban.com/subject/' + KEY.subjectId + '/', kind: 'screen', coverUrl: null, rating: 5,
      markedDate: '2026-11-01', comment: owner + '-private-comment', publishedAt: null, source: 'collection',
      observedAt: T1, createdAt: T1, updatedAt: T1, metadataCheckedRunId: 'old-run', ...patch };
    sqlite.prepare(`INSERT INTO douban_items (user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,observed_at,created_at,updated_at,metadata_checked_run_id,details_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner, item.profileId, item.domain, item.subjectId, item.kind, item.title, item.url,
      item.coverUrl, item.rating, item.markedDate, item.comment, item.publishedAt, item.source, item.observedAt, item.createdAt, item.updatedAt, item.metadataCheckedRunId, doubanDetailsJson(item.details));
    return item;
  }
  return { db, sqlite, queries, seed };
}
const conflict = (error: unknown) => error instanceof DoubanStoreError && error.code === 'DOUBAN_RECORD_CONFLICT';

void test('saved owner, original profile, domain and current version must all match before a metadata operation', async t => {
  const f = fixture(t); f.seed('alice'); f.seed('bob');
  assert.equal((await readDoubanMetadataRecord(f.db, 'alice', KEY)).comment, 'alice-private-comment');
  for (const [owner, patch] of [['third-user', {}], ['alice', { profileId: 'other-profile' }], ['alice', { domain: 'book' }]] as const) {
    await assert.rejects(readDoubanMetadataRecord(f.db, owner, { ...KEY, ...patch }), error => error instanceof DoubanStoreError && error.code === 'DOUBAN_RECORD_NOT_FOUND');
  }
  await assert.rejects(readDoubanMetadataRecord(f.db, 'alice', { ...KEY, expectedUpdatedAt: T2 }), conflict);
  for (const patch of [{ expectedUpdatedAt: 'invalid' }, { profileId: 'https://www.douban.com/people/source-profile/' }, { subjectId: '../12345' }]) {
    await assert.rejects(readDoubanMetadataRecord(f.db, 'alice', { ...KEY, ...patch }));
  }
});

void test('subject metadata changes only its owner’s cover and classification and keeps content versions monotonic', async t => {
  const f = fixture(t), old = f.seed('alice'), bob = f.seed('bob');
  const result = await saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: 'series', coverUrl: COVER }, T1);
  assert.equal(result.changed, true); assert.equal(result.item.kind, 'series'); assert.equal(result.item.coverUrl, COVER);
  assert.equal(result.item.updatedAt, '2026-11-14T08:00:00.001Z'); assert.equal(result.item.observedAt, result.item.updatedAt);
  for (const field of ['title', 'rating', 'markedDate', 'comment', 'publishedAt', 'source', 'createdAt', 'metadataCheckedRunId'] as const) {
    assert.equal(result.item[field], old[field], field);
  }
  assert.deepEqual(await readDoubanRecord(f.db, 'bob', KEY), bob);
  const correction = await saveDoubanSubjectMetadata(f.db, 'alice', result.item, { kind: 'movie', coverUrl: null }, T1);
  assert.equal(correction.item.updatedAt, '2026-11-14T08:00:00.002Z'); assert.equal(correction.item.coverUrl, COVER);
});

void test('unknown fields never erase a known cover or kind and unchanged metadata does not advance its version', async t => {
  const f = fixture(t), old = f.seed('alice', { kind: 'movie', coverUrl: COVER });
  const result = await saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: null, coverUrl: null }, T2);
  assert.deepEqual(result, { item: old, changed: false }); assert.equal(f.queries.some(sql => sql.startsWith('UPDATE')), false);
  await assert.rejects(saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: 'book', coverUrl: null }, T2));
  await assert.rejects(saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: null, coverUrl: 'https://evil.example/cover.jpg' }, T2));
  assert.deepEqual(await readDoubanRecord(f.db, 'alice', KEY), old);
});

void test('same-kind manual confirmation persists its provenance without changing content time, then protects later metadata', async t => {
  const f = fixture(t); f.seed('alice', { kind: 'movie' });
  const manual = await classifyDoubanRecord(f.db, 'alice', { ...KEY, kind: 'movie' }, T2);
  assert.equal(manual.kind, 'movie'); assert.equal(manual.metadataCheckedRunId, 'manual-kind'); assert.equal(manual.updatedAt, T1);
  const refreshed = await saveDoubanSubjectMetadata(f.db, 'alice', manual, { kind: 'series', coverUrl: COVER }, T2);
  assert.equal(refreshed.item.kind, 'movie'); assert.equal(refreshed.item.coverUrl, COVER); assert.equal(refreshed.item.metadataCheckedRunId, 'manual-kind');
  const changed = await classifyDoubanRecord(f.db, 'alice', { ...KEY, expectedUpdatedAt: refreshed.item.updatedAt, kind: 'series' }, T2);
  assert.equal(changed.kind, 'series'); assert.ok(changed.updatedAt > refreshed.item.updatedAt);
  assert.equal(changed.comment, manual.comment); assert.equal(changed.source, manual.source);
});

void test('explicit import classification is protected, unknown imports can be classified and an old automatic movie can become reliable TV', async t => {
  const f = fixture(t), old = f.seed('alice', { kind: 'movie', source: 'import' });
  const protectedItem = await saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: 'series', coverUrl: COVER }, T2);
  assert.equal(protectedItem.item.kind, 'movie'); assert.equal(protectedItem.item.coverUrl, COVER); assert.equal(protectedItem.item.source, 'import');
  const unknown = f.seed('unknown', { source: 'import' });
  assert.equal((await saveDoubanSubjectMetadata(f.db, 'unknown', unknown, { kind: 'series', coverUrl: null }, T2)).item.kind, 'series');
  const automatic = f.seed('automatic', { kind: 'movie' });
  assert.equal((await saveDoubanSubjectMetadata(f.db, 'automatic', automatic, { kind: 'series', coverUrl: null }, T2)).item.kind, 'series');
});

void test('CAS catches concurrent personal edits and manual confirmation even if updatedAt is unchanged', async t => {
  const f = fixture(t), old = f.seed('alice', { kind: 'movie' });
  f.sqlite.prepare('UPDATE douban_items SET comment=? WHERE user_id=?').run('new-private-comment', 'alice');
  await assert.rejects(saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: 'series', coverUrl: COVER }, T2), conflict);
  await assert.rejects(saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: null, coverUrl: null }, T2), conflict);
  const current = (await readDoubanRecord(f.db, 'alice', KEY))!;
  await classifyDoubanRecord(f.db, 'alice', { ...KEY, kind: 'movie' }, T2);
  await assert.rejects(saveDoubanSubjectMetadata(f.db, 'alice', current, { kind: 'series', coverUrl: COVER }, T2), conflict);
  const saved = (await readDoubanRecord(f.db, 'alice', KEY))!;
  assert.equal(saved.comment, 'new-private-comment'); assert.equal(saved.kind, 'movie'); assert.equal(saved.coverUrl, null);
});

void test('independent source observations are retained during metadata CAS and cannot move backwards', async t => {
  const f = fixture(t), old = f.seed();
  f.sqlite.prepare('UPDATE douban_items SET observed_at=? WHERE user_id=?').run(T2, 'alice');
  const result = await saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: 'series', coverUrl: null }, T1);
  assert.equal(result.item.observedAt, T2); assert.equal(result.item.updatedAt, '2026-11-14T08:00:00.001Z');
});

void test('work details merge independently of personal ratings and empty metadata never erases existing public facts', async t => {
  const f = fixture(t), old = f.seed('alice', { kind: 'movie', metadataCheckedRunId: 'manual-kind', details: { summary: '原简介', directors: ['导演甲'], doubanRating: 8.5 } });
  const result = await saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: 'series', coverUrl: COVER, details: { summary: '新简介', directors: [], cast: ['演员甲'], ratingCount: 1234 } }, T2);
  assert.equal(result.changed, true); assert.equal(result.item.kind, 'movie'); assert.equal(result.item.metadataCheckedRunId, 'manual-kind');
  assert.deepEqual(result.item.details, { summary: '新简介', directors: ['导演甲'], cast: ['演员甲'], doubanRating: 8.5, ratingCount: 1234 });
  assert.equal(result.item.rating, old.rating); assert.equal(result.item.comment, old.comment); assert.equal(result.item.markedDate, old.markedDate); assert.equal(result.item.source, old.source);
  const unchanged = await saveDoubanSubjectMetadata(f.db, 'alice', result.item, { kind: null, coverUrl: null, details: {} }, T2);
  assert.equal(unchanged.changed, false); assert.deepEqual(unchanged.item.details, result.item.details); assert.equal(unchanged.item.updatedAt, result.item.updatedAt);
});

void test('metadata guards include work details when another operation edits them without moving the timestamp', async t => {
  const f = fixture(t), old = f.seed('alice', { details: { summary: '旧简介' } });
  f.sqlite.prepare("UPDATE douban_items SET details_json=? WHERE user_id='alice'").run(JSON.stringify({ summary: '并发简介' }));
  await assert.rejects(saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: 'series', coverUrl: COVER, details: { year: 2020 } }, T2), conflict);
  await assert.rejects(saveDoubanSubjectMetadata(f.db, 'alice', old, { kind: null, coverUrl: null, details: {} }, T2), conflict);
  assert.equal((await readDoubanRecord(f.db, 'alice', KEY))?.details?.summary, '并发简介');
});

void test('a reset winning immediately before metadata CAS cannot contaminate a reimported same-key same-time record', async t => {
  const f = fixture(t), old = f.seed('alice', { details: { summary: '旧简介' } }); let reset = false;
  const racing = { prepare(sql: string) {
    const prepared = f.db.prepare(sql);
    return { bind(...values: unknown[]) {
      const bound = prepared.bind(...values);
      return { async first<T>() {
        if (!reset && sql.startsWith('UPDATE douban_items')) {
          reset = true; f.sqlite.prepare("DELETE FROM douban_items WHERE user_id='alice'").run();
          f.seed('alice', { comment: '清空后新私人短评', details: { summary: '新世代简介' } });
          f.sqlite.prepare('INSERT INTO douban_data_resets(user_id,data_epoch,last_request_id,last_request_hash,last_receipt_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('alice', 1, crypto.randomUUID(), 'a'.repeat(64), '{}', T2, T2);
        }
        return bound.first<T>();
      } };
    } };
  } } as unknown as DoubanDatabase;
  await assert.rejects(saveDoubanSubjectMetadata(racing, 'alice', old, { kind: 'series', coverUrl: COVER, details: { summary: '迟到的旧元数据' } }, T2, 0), error => error instanceof DoubanStoreError && error.code === 'DOUBAN_DATA_EPOCH_CONFLICT');
  const current = (await readDoubanRecord(f.db, 'alice', KEY))!;
  assert.equal(current.kind, 'screen'); assert.equal(current.coverUrl, null); assert.equal(current.details?.summary, '新世代简介'); assert.equal(current.comment, '清空后新私人短评'); assert.equal(current.updatedAt, T1);
});
