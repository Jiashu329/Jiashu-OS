import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { doubanMissingFields, parseDoubanLocalRecord } from '../lib/douban-library.ts';
import { doubanSubjectUrl, type DoubanRecordInput } from '../lib/douban.ts';
import { commitDoubanStep, startDoubanRun, writeDoubanConnection, type DoubanDatabase } from './douban-store.ts';
import { classifyDoubanLibrary, listDoubanLibrary, writeDoubanLocalRecord } from './douban-library-store.ts';

const NOW = '2026-11-15T08:00:00.000Z';
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0024_douban', '0025_douban_data_resets', '0027_douban_subject_details', '0028_douban_browser_source', '0029_douban_library', '0030_douban_manual_cover', '0031_tmdb_covers_and_settings', '0032_imdb_ratings', '0033_douban_sync_hints']) sqlite.exec(readFileSync(new URL('../drizzle/' + migration + '.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound = { bind(...args: unknown[]) { values = args as SQLInputValue[]; return bound; },
        async first<T>() { return statement.get(...values) as T ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        execute() { return { results: statement.columns().length ? statement.all(...values) : (statement.run(...values), []) }; } };
      return bound;
    },
    async batch(statements: Array<{ execute(): unknown }>) { sqlite.exec('BEGIN'); try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  } as unknown as DoubanDatabase;
  async function seed(owner = 'alice', items: Array<Partial<DoubanRecordInput> & { subjectId: string }> = [{ subjectId: '1' }]) {
    const connection = await writeDoubanConnection(db, owner, 'profile', 0, NOW);
    const run = await startDoubanRun(db, owner, connection.revision, {}, NOW);
    const records: DoubanRecordInput[] = items.map(item => { const domain = item.domain ?? 'screen'; return { domain, kind: domain, title: '合成作品 ' + item.subjectId,
      url: doubanSubjectUrl(domain, item.subjectId), coverUrl: null, rating: 4, markedDate: '2026-11-01', comment: null, publishedAt: null, source: 'collection', ...item }; });
    return commitDoubanStep(db, owner, { runId: run.id, expectedRevision: run.revision, connectionRevision: connection.revision, state: {}, items: records, status: 'completed', now: NOW });
  }
  return { db, sqlite, seed };
}
const conflict = (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409);

test('rating, marking year, people search, literal wildcards and null-last sorting keep facets owner scoped', async t => {
  const { db, seed } = fixture(t);
  await seed('alice', [
    { subjectId: '1', domain: 'book', title: '甲书', rating: 5, markedDate: '2025-10-01', details: { authors: ['合成作者'] } },
    { subjectId: '2', kind: 'movie', title: '乙片', rating: 2, markedDate: '2026-01-01', details: { directors: ['合成导演'] } },
    { subjectId: '3', domain: 'music', title: '100%_音乐', rating: null, markedDate: null },
  ]);
  await seed('bob', [{ subjectId: '4', rating: 5, markedDate: '2024-01-01' }]);
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { rating: 5, year: 2025 })).items.map(item => item.subjectId), ['1']);
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { query: '合成作者' })).items.map(item => item.subjectId), ['1']);
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { query: '合成导演' })).items.map(item => item.subjectId), ['2']);
  assert.equal((await listDoubanLibrary(db, 'alice', { query: '%_' })).total, 1);
  assert.equal((await listDoubanLibrary(db, 'alice', { query: "' OR 1=1 --" })).total, 0);
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { sort: 'rating-asc' })).items.map(item => item.subjectId), ['2', '1', '3']);
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { sort: 'rating-desc' })).items.map(item => item.subjectId), ['1', '2', '3']);
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { sort: 'date-asc' })).items.map(item => item.subjectId), ['1', '2', '3']);
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { sort: 'date-desc' })).items.map(item => item.subjectId), ['2', '1', '3'], 'unknown marking dates stay last rather than borrowing observation dates');
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { kind: 'book', rating: 5 })).years, [2026, 2025]);
  assert.equal((await listDoubanLibrary(db, 'alice', { rating: 'unrated' })).total, 1);
});

test('local notes, tags and reversible hiding survive real resync while source and local concurrency remain independent', async t => {
  const { db, seed } = fixture(t); await seed();
  const original = (await listDoubanLibrary(db, 'alice')).items[0];
  const saved = await writeDoubanLocalRecord(db, 'alice', { ...original, expectedDataEpoch: 0, expectedLocalRevision: 0, note: '重看时关注配乐', tags: ['重看', '喜欢'], hidden: true });
  assert.deepEqual(saved.local, { note: '重看时关注配乐', tags: ['重看', '喜欢'], hidden: true, revision: 1 });
  assert.equal(saved.updatedAt, original.updatedAt, 'local edits cannot invalidate a source metadata version');
  assert.equal((await listDoubanLibrary(db, 'alice')).total, 0);
  assert.equal((await listDoubanLibrary(db, 'alice')).counts.all, 0, 'hidden records do not inflate visible category counts');
  assert.equal((await listDoubanLibrary(db, 'alice', { hidden: 'hidden', tag: '重看' })).total, 1);
  assert.equal((await listDoubanLibrary(db, 'alice', { hidden: 'all' })).counts.screen, 1);
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { hidden: 'all' })).tags, ['喜欢', '重看']);
  assert.equal((await listDoubanLibrary(db, 'bob', { hidden: 'all' })).total, 0);
  await assert.rejects(writeDoubanLocalRecord(db, 'bob', { ...original, expectedDataEpoch: 0, expectedLocalRevision: 0, note: 'wrong owner', tags: [], hidden: false }), conflict);
  await assert.rejects(writeDoubanLocalRecord(db, 'alice', { ...original, expectedDataEpoch: 0, expectedLocalRevision: 0, note: 'stale', tags: [], hidden: false }), conflict);
  const run = await startDoubanRun(db, 'alice', 1, {}, '2026-11-15T09:00:00.000Z');
  const snapshot = Object.fromEntries(['domain', 'subjectId', 'kind', 'title', 'url', 'coverUrl', 'rating', 'markedDate', 'comment', 'publishedAt', 'source'].map(key => [key, original[key as keyof typeof original]])) as unknown as DoubanRecordInput;
  await commitDoubanStep(db, 'alice', { runId: run.id, expectedRevision: run.revision, connectionRevision: 1, state: {}, status: 'completed', now: '2026-11-15T09:00:00.000Z', items: [{ ...snapshot, rating: 5, comment: '新豆瓣短评', source: 'collection' }] });
  const refreshed = (await listDoubanLibrary(db, 'alice', { hidden: 'all' })).items[0];
  assert.equal(refreshed.rating, 5); assert.equal(refreshed.comment, '新豆瓣短评'); assert.deepEqual(refreshed.local, saved.local);
  const restored = await writeDoubanLocalRecord(db, 'alice', { ...original, expectedDataEpoch: 0, expectedLocalRevision: 1, note: saved.local.note, tags: saved.local.tags, hidden: false });
  assert.equal(restored.local.revision, 2); assert.equal((await listDoubanLibrary(db, 'alice')).total, 1);
});

test('batch classification is atomic for stale records, wrong owners and duplicate keys and retains manual intent through resync', async t => {
  const { db, seed, sqlite } = fixture(t); await seed('alice', [{ subjectId: '1' }, { subjectId: '2' }]);
  const selected = (await listDoubanLibrary(db, 'alice')).items.map(item => ({ profileId: item.profileId, domain: 'screen' as const, subjectId: item.subjectId, expectedUpdatedAt: item.updatedAt }));
  const command = { kind: 'movie' as const, expectedDataEpoch: 0, items: selected };
  await assert.rejects(classifyDoubanLibrary(db, 'alice', { ...command, items: [{ ...selected[0], expectedUpdatedAt: '2026-11-01T00:00:00.000Z' }, selected[1]] }), conflict);
  assert.ok((await listDoubanLibrary(db, 'alice')).items.every(item => item.kind === 'screen'));
  await assert.rejects(classifyDoubanLibrary(db, 'bob', command), conflict);
  await assert.rejects(classifyDoubanLibrary(db, 'alice', { ...command, items: [selected[0], selected[0]] }));
  const saved = await classifyDoubanLibrary(db, 'alice', command, NOW);
  assert.equal(saved.length, 2); assert.ok(saved.every(item => item.kind === 'movie' && item.metadataCheckedRunId === 'manual-kind' && item.updatedAt > NOW));
  assert.ok(saved.every(item => item.observedAt >= item.updatedAt), 'classified records remain valid for complete backup export');
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM douban_items WHERE kind='movie'").get()?.n, 2);
  await assert.rejects(classifyDoubanLibrary(db, 'alice', { ...command, expectedDataEpoch: 1 }), conflict);
  await assert.rejects(writeDoubanLocalRecord(db, 'alice', { ...selected[0], expectedDataEpoch: 1, expectedLocalRevision: 0, note: '', tags: [], hidden: false }), conflict);
});

test('missing-only filtering matches shared core-field labels without requiring a site score', async t => {
  const { db, seed } = fixture(t), coverUrl = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg';
  await seed('alice', [
    { subjectId: '1', kind: 'movie', coverUrl, details: { imdbId: 'tt1234567', summary: '完整简介', directors: ['导演'] } },
    { subjectId: '2', kind: 'screen', coverUrl, details: { imdbId: 'tt1234568', summary: '已有简介', directors: ['导演'] } },
    { subjectId: '3', domain: 'book', coverUrl, details: { summary: '书籍简介' } },
    { subjectId: '4', domain: 'music', details: { artists: ['音乐人'] } },
  ]);
  const all = (await listDoubanLibrary(db, 'alice')).items;
  assert.deepEqual((await listDoubanLibrary(db, 'alice', { missing: true })).items.map(item => item.subjectId).sort(), all.filter(item => doubanMissingFields(item).length).map(item => item.subjectId).sort());
  assert.deepEqual(doubanMissingFields(all.find(item => item.subjectId === '1')!), []);
  assert.deepEqual(doubanMissingFields(all.find(item => item.subjectId === '2')!), ['影视分类']);
});

test('personal input validation bounds notes and canonical tags without accepting control characters', () => {
  assert.deepEqual(parseDoubanLocalRecord({ note: '第一行\r\n第二行', tags: [' 标签 '], hidden: false }), { note: '第一行\n第二行', tags: ['标签'], hidden: false });
  for (const patch of [{ note: 'x'.repeat(4001) }, { tags: ['重复', '重复'] }, { tags: Array(13).fill('tag') }, { tags: ['bad\nvalue'] }, { note: '\u0000' }, { hidden: 1 }]) assert.throws(() => parseDoubanLocalRecord({ note: '', tags: [], hidden: false, ...patch }));
});
