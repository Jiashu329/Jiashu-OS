import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DoubanValidationError, doubanSubjectUrl, parseDoubanRecord, type DoubanRecordInput } from '../lib/douban.ts';
import { commitDoubanImport, commitDoubanStep, countUnclassifiedDoubanRecords, DoubanStoreError, listDoubanRecords, nextUnclassifiedRecord, previewDoubanImport, readDoubanConnection, readDoubanRecord, readDoubanRun,
  readDoubanImportRecords, startDoubanRun, writeDoubanConnection, type DoubanDatabase, type DoubanRun, type DoubanStep } from './douban-store.ts';
import { commitDoubanReset, previewDoubanReset, readDoubanDataEpoch } from './douban-reset-store.ts';
import { saveDoubanSubjectMetadata } from './douban-metadata-store.ts';

const T1 = '2026-11-14T08:00:00.000Z', T2 = '2026-11-14T08:01:00.000Z', T3 = '2026-11-14T08:02:00.000Z';
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0024_douban.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0025_douban_data_resets.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0027_douban_subject_details.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0028_douban_browser_source.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0029_douban_library.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0030_douban_manual_cover.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  let nextBatch: (() => void) | undefined, failStatement = -1;
  const batchSizes: number[] = [], bindingSizes: number[] = [];
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; bindingSizes.push(parameters.reduce<number>((sum, value) => sum + (typeof value === 'string' ? new TextEncoder().encode(value).byteLength : 8), 0)); return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        execute() { return { results: statement.columns().length ? statement.all(...values) : (statement.run(...values), []) }; },
      };
      return bound;
    },
    async batch(commands: Array<{ execute(): unknown }>) {
      batchSizes.push(commands.length); const before = nextBatch; nextBatch = undefined; before?.();
      sqlite.exec('BEGIN');
      try { const results = commands.map((command, index) => { if (index === failStatement) { failStatement = -1; throw new Error('Synthetic transaction failure'); } return command.execute(); }); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as DoubanDatabase;
  return { db, sqlite, batchSizes, bindingSizes, beforeBatch(callback: () => void) { nextBatch = callback; }, failAt(index: number) { failStatement = index; } };
}
function record(subjectId = '1', kind: DoubanRecordInput['kind'] = 'screen', patch: Partial<DoubanRecordInput> = {}): DoubanRecordInput {
  const domain = kind === 'movie' || kind === 'series' ? 'screen' : kind;
  return { domain, subjectId, kind, title: '合成条目 ' + subjectId, url: doubanSubjectUrl(domain, subjectId),
    coverUrl: null, rating: 4, markedDate: '2026-11-10', comment: '自己的短评', publishedAt: null, source: 'collection', ...patch };
}
function step(run: DoubanRun, items: DoubanRecordInput[] = [], patch: Partial<DoubanStep> = {}): DoubanStep {
  return { runId: run.id, expectedRevision: run.revision, connectionRevision: run.connectionRevision, items, state: { phase: 'collection', page: run.revision + 1 }, status: 'running', now: T2, ...patch };
}
async function connected(db: DoubanDatabase, userId = 'alice', profile = 'alice_douban') {
  const connection = await writeDoubanConnection(db, userId, profile, 0, T1);
  return startDoubanRun(db, userId, connection.revision, { phase: 'collection', page: 0 }, T1);
}
const conflict = (error: unknown) => error instanceof DoubanStoreError && error.status === 409;

test('bindings are owner-scoped CAS records; repeat configuration is idempotent and disconnect does not erase collected records', async t => {
  const { db } = fixture(t);
  assert.deepEqual(await readDoubanConnection(db, 'alice'), { profileId: null, revision: 0, updatedAt: null });
  const run = await connected(db);
  await commitDoubanStep(db, 'alice', step(run, [record()], { status: 'completed' }));
  assert.equal((await writeDoubanConnection(db, 'alice', 'alice_douban', 0, T2)).revision, 1);
  await assert.rejects(writeDoubanConnection(db, 'alice', 'stale_other', 0, T2), conflict);
  const next = await writeDoubanConnection(db, 'alice', 'new_profile', 1, T2);
  assert.equal(next.revision, 2); assert.equal(next.profileId, 'new_profile');
  assert.equal(await readDoubanRun(db, 'alice'), null, 'a previous binding run cannot appear current');
  const disconnected = await writeDoubanConnection(db, 'alice', null, 2, T3);
  assert.equal(disconnected.revision, 3);
  assert.equal((await listDoubanRecords(db, 'alice')).total, 1);
  assert.equal((await listDoubanRecords(db, 'bob')).total, 0);
  await assert.rejects(startDoubanRun(db, 'alice', 3, {}), error => error instanceof DoubanStoreError && error.code === 'DOUBAN_NOT_CONNECTED');
  assert.equal((await readDoubanConnection(db, "alice' OR 1=1 --")).profileId, null);
});

test('collection identity includes domain and source profile while public subject IDs never leak another owner’s rating or short comment', async t => {
  const { db } = fixture(t);
  const alice = await connected(db), bob = await connected(db, 'bob', 'alice_douban');
  await commitDoubanStep(db, 'alice', step(alice, [record('1', 'movie'), record('1', 'book')], { status: 'completed' }));
  await commitDoubanStep(db, 'bob', step(bob, [record('1', 'movie', { comment: 'BOB_PRIVATE' })], { status: 'completed' }));
  const connection = await writeDoubanConnection(db, 'alice', 'other_profile', 1, T2);
  const other = await startDoubanRun(db, 'alice', connection.revision, {}, T2);
  await commitDoubanStep(db, 'alice', step(other, [record('1', 'movie', { comment: 'other source' })], { status: 'completed', now: T3 }));
  const all = await listDoubanRecords(db, 'alice');
  assert.equal(all.total, 3); assert.equal(all.counts.movie, 2); assert.equal(all.counts.book, 1);
  assert.equal((await listDoubanRecords(db, 'alice', { profileId: 'alice_douban' })).total, 2);
  assert.equal(JSON.stringify(all).includes('BOB_PRIVATE'), false);
  assert.equal(await readDoubanRun(db, 'alice', bob.id), null);
});

test('refresh deduplicates a page, retains known rich fields through RSS and records source observation separately from content updates', async t => {
  const { db } = fixture(t); let run = await connected(db);
  const initial = record('1', 'movie', { coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg' });
  run = await commitDoubanStep(db, 'alice', step(run, [initial, initial]));
  assert.deepEqual([run.added, run.updated, run.unchanged], [1, 0, 0]);
  const first = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(first.observedAt, T2); assert.equal(first.markedDate, '2026-11-10');
  const rss = record('1', 'screen', { source: 'rss', rating: null, markedDate: null, comment: null, publishedAt: '2026-11-09T10:00:00.000Z' });
  run = await commitDoubanStep(db, 'alice', step(run, [rss], { now: T3 }));
  let saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.kind, 'movie'); assert.equal(saved.source, 'collection');
  assert.equal(saved.rating, 4); assert.equal(saved.comment, initial.comment); assert.equal(saved.markedDate, initial.markedDate); assert.equal(saved.coverUrl, initial.coverUrl);
  assert.equal(saved.publishedAt, rss.publishedAt); assert.equal(saved.observedAt, T3); assert.equal(saved.updatedAt, T3);
  run = await commitDoubanStep(db, 'alice', step(run, [rss], { now: '2026-11-14T08:03:00.000Z' }));
  saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.updatedAt, T3); assert.equal(saved.observedAt, '2026-11-14T08:03:00.000Z');
  assert.deepEqual([run.added, run.updated, run.unchanged], [1, 1, 1]);
});

test('an explicit collection unrating/removal can clear own rating and comment; missing publication date never overwrites a known RSS timestamp', async t => {
  const { db } = fixture(t); let run = await connected(db);
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'book', { publishedAt: '2026-11-01T00:00:00.000Z' })]));
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'book', { rating: null, comment: null, markedDate: null })], { now: T3 }));
  const saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.rating, null); assert.equal(saved.comment, null); assert.equal(saved.markedDate, null);
  assert.equal(saved.publishedAt, '2026-11-01T00:00:00.000Z'); assert.equal(saved.updatedAt, T3); assert.equal(run.updated, 1);
});

test('one active run is reused and competing step revisions cannot double-count or partially overwrite the winner', async t => {
  const { db } = fixture(t); const run = await connected(db);
  assert.equal((await startDoubanRun(db, 'alice', run.connectionRevision, { ignoredRetry: true }, T2)).id, run.id);
  const results = await Promise.allSettled([
    commitDoubanStep(db, 'alice', step(run, [record('1')])),
    commitDoubanStep(db, 'alice', step(run, [record('2')])),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const current = await readDoubanRun(db, 'alice', run.id);
  assert.equal(current?.revision, 1); assert.equal(current?.added, 1); assert.equal((await listDoubanRecords(db, 'alice')).total, 1);
  await assert.rejects(commitDoubanStep(db, 'alice', step(run, [record('3')])), conflict);
  assert.equal((await listDoubanRecords(db, 'alice')).total, 1);
});

test('a binding change between step preparation and its transaction rejects every mutation', async t => {
  const f = fixture(t); const run = await connected(f.db);
  f.beforeBatch(() => { f.sqlite.prepare("UPDATE douban_connections SET profile_id='new_profile',revision=revision+1 WHERE user_id='alice'").run(); });
  await assert.rejects(commitDoubanStep(f.db, 'alice', step(run, [record()])), conflict);
  assert.equal((await listDoubanRecords(f.db, 'alice')).total, 0);
  const old = await readDoubanRun(f.db, 'alice', run.id); assert.equal(old?.revision, 0); assert.equal(old?.added, 0);
  assert.equal(await readDoubanRun(f.db, 'alice'), null);
  const newer = await startDoubanRun(f.db, 'alice', 2, {}, T2);
  assert.notEqual(newer.id, run.id); assert.equal(newer.profileId, 'new_profile');
});

test('a failing final statement rolls a whole page back and every commit remains within the bounded D1 statement budget', async t => {
  const f = fixture(t); const run = await connected(f.db);
  f.failAt(2);
  await assert.rejects(commitDoubanStep(f.db, 'alice', step(run, [record()])), /Synthetic transaction failure/);
  assert.equal((await listDoubanRecords(f.db, 'alice')).total, 0);
  assert.equal((await readDoubanRun(f.db, 'alice', run.id))?.revision, 0);
  const items = Array.from({ length: 30 }, (_, index) => record(String(index + 1)));
  const done = await commitDoubanStep(f.db, 'alice', step(run, items, { status: 'completed' }));
  assert.equal(done.added, 30); assert.ok(f.batchSizes.every(size => size <= 32));
  await assert.rejects(commitDoubanStep(f.db, 'alice', step(done, [...items, record('31')])), error => error instanceof DoubanStoreError && error.status === 400);
});

test('unknown screen metadata is checked once per run and only a real kind change adds an update', async t => {
  const { db } = fixture(t); let run = await connected(db);
  run = await commitDoubanStep(db, 'alice', step(run, [record('1'), record('2', 'movie')]));
  assert.equal((await nextUnclassifiedRecord(db, 'alice', run.profileId, run.id))?.subjectId, '1');
  run = await commitDoubanStep(db, 'alice', step(run, [], { classification: { domain: 'screen', subjectId: '1', kind: null }, now: T3 }));
  assert.equal(run.updated, 0); assert.equal(await nextUnclassifiedRecord(db, 'alice', run.profileId, run.id), null);
  run = await commitDoubanStep(db, 'alice', step(run, [], { classification: { domain: 'screen', subjectId: '1', kind: 'series' }, now: '2026-11-14T08:03:00.000Z' }));
  assert.equal(run.updated, 1);
  const saved = (await listDoubanRecords(db, 'alice', { kind: 'series' })).items[0];
  assert.equal(saved.metadataCheckedRunId, run.id); assert.equal(saved.observedAt, saved.updatedAt); assert.equal(saved.kind, 'series');
  run = await commitDoubanStep(db, 'alice', step(run, [], { classification: { domain: 'screen', subjectId: '1', kind: 'series' } }));
  assert.equal(run.updated, 1); assert.equal((await listDoubanRecords(db, 'alice')).total, 2);
});

test('partial and failed outcomes retain earlier pages; a new run has a new checkpoint and the latest same-instant run is deterministic', async t => {
  const { db } = fixture(t); let run = await connected(db);
  run = await commitDoubanStep(db, 'alice', step(run, [record()], { status: 'partial' }));
  assert.equal(run.finishedAt, T2); assert.equal((await listDoubanRecords(db, 'alice')).total, 1);
  const next = await startDoubanRun(db, 'alice', run.connectionRevision, { page: 0 }, T2);
  const failed = await commitDoubanStep(db, 'alice', step(next, [], { status: 'failed' }));
  assert.equal((await readDoubanRun(db, 'alice'))?.id, failed.id);
  assert.equal(failed.status, 'failed'); assert.equal((await listDoubanRecords(db, 'alice')).total, 1);
  await assert.rejects(commitDoubanStep(db, 'alice', step(run, [record('2')])), conflict);
});

test('list filters use literal text, bounded pages and owner/profile-aware facet counts', async t => {
  const { db } = fixture(t); const run = await connected(db);
  await commitDoubanStep(db, 'alice', step(run, [record('1', 'movie', { title: '100% 电影' }), record('2', 'book', { title: '100% 书' }), record('3', 'music', { title: '普通音乐' })], { status: 'completed' }));
  const first = await listDoubanRecords(db, 'alice', { limit: 1 });
  assert.equal(first.total, 3); assert.equal(first.items.length, 1); assert.equal(first.hasMore, true);
  assert.equal((await listDoubanRecords(db, 'alice', { offset: 3, limit: 1 })).hasMore, false);
  const percent = await listDoubanRecords(db, 'alice', { query: '%', kind: 'book' });
  assert.equal(percent.total, 1); assert.equal(percent.counts.all, 2); assert.equal(percent.counts.movie, 1);
  assert.equal((await listDoubanRecords(db, 'alice', { query: "' OR 1=1 --" })).total, 0);
  for (const options of [{ offset: -1 }, { limit: 0 }, { limit: 101 }, { offset: 100001 }, { query: '字'.repeat(101) }, { kind: 'podcast' }, { query: 3 }]) {
    await assert.rejects(listDoubanRecords(db, 'alice', options as never), error => error instanceof DoubanStoreError && error.status === 400);
  }
});

test('invalid external identities, records and oversized/non-JSON checkpoints never write source records', async t => {
  const { db } = fixture(t); const run = await connected(db);
  await assert.rejects(writeDoubanConnection(db, 'alice', 'https://localhost/people/x/', 1));
  await assert.rejects(commitDoubanStep(db, 'alice', step(run, [{ ...record(), url: 'https://localhost/subject/1/' }])));
  await assert.rejects(commitDoubanStep(db, 'alice', step(run, [], { state: { payload: 'x'.repeat(20000) } })));
  const circular: Record<string, unknown> = {}; circular.self = circular;
  await assert.rejects(commitDoubanStep(db, 'alice', step(run, [], { state: circular })));
  await assert.rejects(commitDoubanStep(db, 'alice', step(run, [], { classification: { domain: 'screen', subjectId: '../1', kind: null } })));
  assert.equal((await readDoubanRun(db, 'alice', run.id))?.revision, 0);
  assert.equal((await listDoubanRecords(db, 'alice')).total, 0);
});

function privateRecord(subjectId = '1', kind: DoubanRecordInput['kind'] = 'movie', patch: Partial<DoubanRecordInput> = {}) {
  return record(subjectId, kind, { source: 'import', ...patch });
}
async function importRecords(db: DoubanDatabase, items: DoubanRecordInput[], options: { userId?: string; profileId?: string; requestId?: string; now?: string } = {}) {
  const userId = options.userId ?? 'alice', profileId = options.profileId ?? 'alice_douban';
  const preview = await previewDoubanImport(db, userId, { profileId, items });
  const command = { profileId, items, expectedSnapshotHash: preview.snapshotHash, requestId: options.requestId ?? crypto.randomUUID(), now: options.now ?? T1 };
  return { preview, command, receipt: await commitDoubanImport(db, userId, command) };
}

test('private file imports need no binding or network, persist normalized records once, and receipts contain counters rather than private content', async t => {
  const { db, sqlite } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('A private import must not connect to Douban'); });
  const items = [privateRecord('1', 'movie', { comment: 'PRIVATE_FILE_COMMENT' }), privateRecord('2', 'book')];
  const { preview, command, receipt } = await importRecords(db, items);
  assert.deepEqual([preview.total, preview.added, preview.updated, preview.unchanged], [2, 2, 0, 0]);
  assert.equal(receipt.requestId, command.requestId); assert.equal(receipt.profileId, 'alice_douban');
  assert.equal((await readDoubanConnection(db, 'alice')).profileId, null);
  assert.equal(await readDoubanRun(db, 'alice'), null);
  const saved = await listDoubanRecords(db, 'alice');
  assert.equal(saved.total, 2); assert.equal(saved.items[0].source, 'import');
  const raw = sqlite.prepare('SELECT receipt_json FROM douban_import_receipts').get()?.receipt_json as string;
  assert.equal(raw.includes('PRIVATE_FILE_COMMENT'), false); assert.equal(raw.includes('subjectId'), false);
  assert.deepEqual(await commitDoubanImport(db, 'alice', command), receipt);
  assert.equal((await listDoubanRecords(db, 'alice')).total, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM douban_import_receipts').get()?.n, 1);
});

void test('browser snapshots clear an explicitly removed rating and comment, including legacy browser records saved as imports', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'movie', { rating: 5, comment: 'old browser comment' })]);
  const items = [privateRecord('1', 'screen', { source: 'browser', rating: null, comment: null, markedDate: null })];
  const refreshed = await importRecords(db, items, { now: T2 });
  assert.equal(refreshed.preview.updated, 1); assert.equal(refreshed.receipt.updated, 1);
  let saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.deepEqual([saved.source, saved.rating, saved.comment, saved.markedDate, saved.kind], ['browser', null, null, null, 'movie']);
  assert.equal(saved.createdAt, T1);
  assert.deepEqual(await commitDoubanImport(db, 'alice', refreshed.command), refreshed.receipt, 'replaying the same browser page keeps the same receipt');
  const repeated = await importRecords(db, items, { now: T3 });
  assert.equal(repeated.receipt.unchanged, 1);
  saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.updatedAt, T2); assert.equal(saved.observedAt, T3);
});

void test('browser provenance preserves an imported explicit media classification through later automatic cover completion', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'movie', { coverUrl: null, rating: 5, comment: 'old private comment' })]);
  await importRecords(db, [privateRecord('1', 'screen', { source: 'browser', coverUrl: null, rating: null, comment: null })], { now: T2 });
  const before = (await listDoubanRecords(db, 'alice')).items[0];
  assert.deepEqual([before.source, before.kind, before.rating, before.comment], ['browser', 'movie', null, null]);
  assert.equal(before.metadataCheckedRunId, 'import-kind');
  const completed = await saveDoubanSubjectMetadata(db, 'alice', before, { kind: 'series', coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg' }, T3, 0);
  assert.equal(completed.item.kind, 'movie', 'automatic metadata must not undo an explicit file classification during provenance migration');
  assert.ok(completed.item.coverUrl); assert.equal(completed.item.source, 'browser');
  await importRecords(db, [privateRecord('1', 'series', { source: 'browser', rating: null, comment: null })], { now: T3 });
  assert.equal((await listDoubanRecords(db, 'alice')).items[0].kind, 'movie', 'a later browser page must also retain the imported choice');
  await importRecords(db, [privateRecord('1', 'series')], { now: T3 });
  assert.equal((await listDoubanRecords(db, 'alice')).items[0].kind, 'series', 'a new explicit file classification may still correct the previous import');
});

void test('ordinary browser metadata classifications remain correctable and are not mistaken for explicit import choices', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'screen', { source: 'browser' })]);
  let item = (await listDoubanRecords(db, 'alice')).items[0];
  item = (await saveDoubanSubjectMetadata(db, 'alice', item, { kind: 'movie', coverUrl: null }, T2, 0)).item;
  await importRecords(db, [privateRecord('1', 'screen', { source: 'browser' })], { now: T3 });
  item = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(item.metadataCheckedRunId, null);
  item = (await saveDoubanSubjectMetadata(db, 'alice', item, { kind: 'series', coverUrl: null }, T3, 0)).item;
  assert.equal(item.kind, 'series'); assert.equal(item.source, 'browser');
});

void test('a transactional browser page also preserves the imported classification marker for later metadata reads', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'movie')]);
  const run = await connected(db);
  await commitDoubanStep(db, 'alice', step(run, [record('1', 'series', { source: 'browser', rating: null, comment: null })]));
  const item = (await listDoubanRecords(db, 'alice')).items[0];
  assert.deepEqual([item.kind, item.source, item.metadataCheckedRunId, item.rating, item.comment], ['movie', 'browser', 'import-kind', null, null]);
  assert.equal((await saveDoubanSubjectMetadata(db, 'alice', item, { kind: 'series', coverUrl: null }, T3, 0)).item.kind, 'movie');
});

void test('an imported classification marker arriving after preview fences both its preparation hash and transactional guard', async t => {
  for (const duringBatch of [false, true]) {
    const f = fixture(t);
    await importRecords(f.db, [privateRecord('1', 'movie', { source: 'browser' })]);
    const items = [privateRecord('1', 'series', { source: 'browser' })];
    const preview = await previewDoubanImport(f.db, 'alice', { profileId: 'alice_douban', items });
    const protect = () => { f.sqlite.prepare("UPDATE douban_items SET metadata_checked_run_id='import-kind' WHERE user_id='alice'").run(); };
    if (duringBatch) f.beforeBatch(protect); else protect();
    await assert.rejects(commitDoubanImport(f.db, 'alice', { profileId: 'alice_douban', items, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID() }), conflict);
    const item = (await listDoubanRecords(f.db, 'alice')).items[0];
    assert.equal(item.kind, 'movie'); assert.equal(item.metadataCheckedRunId, 'import-kind');
  }
});

void test('file and old extension imports keep unknown empty personal fields conservative after browser provenance is introduced', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'book', { source: 'browser', rating: 5, comment: 'known private comment' })]);
  const partialFile = [privateRecord('1', 'book', { rating: null, comment: null, markedDate: null })];
  await importRecords(db, partialFile, { now: T2 });
  const saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.deepEqual([saved.source, saved.rating, saved.comment, saved.markedDate], ['import', 5, 'known private comment', '2026-11-10']);
});

void test('anonymous collection and RSS refreshes cannot erase browser-only personal fields or restore explicitly cleared values', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'book', { source: 'browser', rating: null, comment: null, markedDate: null }),
    privateRecord('2', 'book', { source: 'browser', rating: 5, comment: 'private browser note' })]);
  let run = await connected(db);
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'book', { rating: 4, comment: 'stale public note', details: { authors: ['Public author'] } }),
    record('2', 'book', { rating: null, comment: null, markedDate: null })]));
  await commitDoubanStep(db, 'alice', step(run, [record('1', 'book', { source: 'rss', rating: 3, comment: 'RSS note', markedDate: null, publishedAt: T3 })], { now: T3 }));
  const saved = await listDoubanRecords(db, 'alice');
  const empty = saved.items.find(item => item.subjectId === '1')!;
  const rich = saved.items.find(item => item.subjectId === '2')!;
  assert.deepEqual([empty.source, empty.rating, empty.comment, empty.markedDate], ['browser', null, null, null]);
  assert.deepEqual(empty.details?.authors, ['Public author'], 'public work metadata can still fill missing details');
  assert.deepEqual([rich.source, rich.rating, rich.comment], ['browser', 5, 'private browser note']);
});

void test('transactional sync merge matches browser snapshot semantics and retains an explicit manual classification', async t => {
  const { db, sqlite } = fixture(t);
  await importRecords(db, [privateRecord('1', 'movie', { rating: 5, comment: 'old comment' })]);
  sqlite.prepare("UPDATE douban_items SET metadata_checked_run_id='manual-kind' WHERE user_id='alice'").run();
  const run = await connected(db);
  await commitDoubanStep(db, 'alice', step(run, [record('1', 'series', { source: 'browser', rating: null, comment: null, markedDate: null })]));
  const saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.deepEqual([saved.source, saved.rating, saved.comment, saved.markedDate, saved.kind], ['browser', null, null, null, 'movie']);
});

test('a lost import reply replays its original summary after later edits and an operation ID cannot be reused for changed private contents', async t => {
  const { db } = fixture(t);
  const first = await importRecords(db, [privateRecord('1', 'movie', { rating: 3, comment: 'first private comment' })]);
  await importRecords(db, [privateRecord('1', 'movie', { rating: 5, comment: 'newer private comment' })], { now: T2 });
  assert.deepEqual(await commitDoubanImport(db, 'alice', first.command), first.receipt);
  assert.equal((await listDoubanRecords(db, 'alice')).items[0].comment, 'newer private comment');
  const changed = [privateRecord('1', 'movie', { comment: 'different payload' })];
  const preview = await previewDoubanImport(db, 'alice', { profileId: 'alice_douban', items: changed });
  await assert.rejects(commitDoubanImport(db, 'alice', { ...first.command, items: changed, expectedSnapshotHash: preview.snapshotHash }),
    error => error instanceof DoubanStoreError && error.code === 'DOUBAN_IMPORT_CONFLICT');
});

test('import previews bind owner, profile and proposed contents while allowing observation-only changes', async t => {
  const { db, sqlite } = fixture(t);
  await importRecords(db, [privateRecord()]);
  const items = [privateRecord('1', 'movie', { rating: 5, comment: 'confirmed replacement' })];
  const preview = await previewDoubanImport(db, 'alice', { profileId: 'alice_douban', items });
  const base = { profileId: 'alice_douban', items, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), now: T2 };
  await assert.rejects(commitDoubanImport(db, 'bob', base), conflict);
  await assert.rejects(commitDoubanImport(db, 'alice', { ...base, profileId: 'other_profile' }), conflict);
  await assert.rejects(commitDoubanImport(db, 'alice', { ...base, items: [privateRecord('1', 'movie', { rating: 2 })] }), conflict);
  sqlite.prepare("UPDATE douban_items SET observed_at=?,updated_at=?,metadata_checked_run_id='bookkeeping-only' WHERE user_id='alice'").run(T3, T2);
  const afterObservation = await previewDoubanImport(db, 'alice', { profileId: 'alice_douban', items });
  assert.equal(afterObservation.snapshotHash, preview.snapshotHash);
  const receipt = await commitDoubanImport(db, 'alice', base);
  assert.equal(receipt.updated, 1);
  const saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.createdAt, T1); assert.equal(saved.updatedAt, T3); assert.equal(saved.observedAt, T3); assert.equal(saved.comment, 'confirmed replacement');
});

test('a concurrent change in a later import chunk rolls every earlier chunk and its receipt back', async t => {
  const f = fixture(t), profileId = 'alice_douban';
  const items = Array.from({ length: 101 }, (_, index) => privateRecord(String(100000 + index), 'book'));
  const preview = await previewDoubanImport(f.db, 'alice', { profileId, items });
  f.beforeBatch(() => {
    const item = record('100100', 'book', { comment: 'concurrent record must survive' });
    f.sqlite.prepare(`INSERT INTO douban_items(user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,observed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('alice', profileId, item.domain, item.subjectId, item.kind, item.title, item.url, item.coverUrl, item.rating, item.markedDate, item.comment, item.publishedAt, item.source, T1, T1, T1);
  });
  await assert.rejects(commitDoubanImport(f.db, 'alice', { profileId, items, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), now: T2 }),
    error => error instanceof DoubanStoreError && error.code === 'DOUBAN_IMPORT_CONFLICT');
  const saved = await listDoubanRecords(f.db, 'alice');
  assert.equal(saved.total, 1); assert.equal(saved.items[0].subjectId, '100100'); assert.equal(saved.items[0].comment, 'concurrent record must survive');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_import_receipts').get()?.n, 0);
});

test('500 imported records use a bounded bulk transaction and reject unconfirmed, duplicate, public-source or excessive input', async t => {
  const f = fixture(t);
  const items = Array.from({ length: 500 }, (_, index) => privateRecord(String(index + 1), 'music'));
  const { receipt } = await importRecords(f.db, items);
  assert.equal(receipt.total, 500); assert.equal(receipt.added, 500);
  assert.ok(f.batchSizes.every(size => size <= 11));
  assert.equal((await listDoubanRecords(f.db, 'alice')).total, 500);
  for (const input of [[], [...items, privateRecord('501')], [privateRecord(), privateRecord()], [record()]]) {
    await assert.rejects(previewDoubanImport(f.db, 'alice', { profileId: 'alice_douban', items: input }), error => error instanceof DoubanStoreError && error.status === 400);
  }
  const preview = await previewDoubanImport(f.db, 'alice', { profileId: 'alice_douban', items: [privateRecord()] });
  for (const patch of [{ requestId: 'not-a-uuid' }, { expectedSnapshotHash: 'bad-hash' }]) {
    await assert.rejects(commitDoubanImport(f.db, 'alice', { profileId: 'alice_douban', items: [privateRecord()], expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), ...patch }), error => error instanceof DoubanStoreError && error.status === 400);
  }
});

test('public refresh and classification preserve imported private ratings, comments, dates and known media kind', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'movie', { rating: 5, comment: 'PRIVATE_IMPORT_COMMENT', markedDate: '2026-11-01' }), privateRecord('2', 'screen')]);
  let run = await connected(db);
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'series', { rating: 1, comment: null, markedDate: '2026-11-13' }), record('3', 'screen')]));
  let saved = (await listDoubanRecords(db, 'alice', { kind: 'movie' })).items[0];
  assert.equal(saved.rating, 5); assert.equal(saved.comment, 'PRIVATE_IMPORT_COMMENT'); assert.equal(saved.markedDate, '2026-11-01'); assert.equal(saved.source, 'import');
  run = await commitDoubanStep(db, 'alice', step(run, [], { classification: { domain: 'screen', subjectId: '1', kind: 'series' }, now: T3 }));
  saved = (await listDoubanRecords(db, 'alice', { kind: 'movie' })).items[0];
  assert.equal(saved.kind, 'movie'); assert.equal(run.updated, 0);
  assert.equal(await countUnclassifiedDoubanRecords(db, 'alice', 'alice_douban'), 1, 'private-only imported IDs are not public metadata candidates');
  assert.equal((await nextUnclassifiedRecord(db, 'alice', 'alice_douban', run.id))?.subjectId, '3');
});

test('public information can fill an imported blank but cannot later replace that now-known private field', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'screen', { rating: null, comment: null, markedDate: null })]);
  let run = await connected(db);
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'series', { rating: 3, comment: 'first available value' })]));
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'movie', { rating: 1, comment: 'later public value', markedDate: '2026-11-13' })], { now: T3 }));
  const saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.source, 'import'); assert.equal(saved.kind, 'series'); assert.equal(saved.rating, 3); assert.equal(saved.comment, 'first available value'); assert.equal(saved.markedDate, '2026-11-10');
});

test('private comment search is owner-scoped and treats percent, underscore and backslash as literal text', async t => {
  const { db } = fixture(t);
  await importRecords(db, [privateRecord('1', 'book', { title: '只在短评中匹配', comment: 'PRIVATE 100%_\\ done' }), privateRecord('2', 'book', { title: '普通书', comment: 'no wildcard here' })]);
  await importRecords(db, [privateRecord('1', 'book', { comment: 'BOB PRIVATE 100%_\\ done' })], { userId: 'bob' });
  assert.equal((await listDoubanRecords(db, 'alice', { query: '%_\\' })).total, 1);
  assert.equal((await listDoubanRecords(db, 'alice', { query: 'PRIVATE' })).total, 1);
  assert.equal((await listDoubanRecords(db, 'alice', { query: 'BOB' })).total, 0);
  assert.equal((await listDoubanRecords(db, 'alice', { query: '_' })).items[0].title, '只在短评中匹配');
});

test('RSS cannot replace a current collection rating, restore an intentionally empty rating/comment, or rewrite its authoritative title', async t => {
  for (const latest of [{ rating: 5 as const, comment: 'current collection comment' }, { rating: null, comment: null }]) {
    const { db } = fixture(t); let run = await connected(db);
    run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'movie', { ...latest, title: '最新收藏页名称', publishedAt: '2026-11-10T00:00:00.000Z' })]));
    run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'screen', { source: 'rss', title: '旧RSS名称', rating: 1, comment: 'old RSS comment', markedDate: null, publishedAt: '2026-11-13T00:00:00.000Z' })], { now: T3 }));
    const saved = (await listDoubanRecords(db, 'alice')).items[0];
    assert.equal(saved.rating, latest.rating); assert.equal(saved.comment, latest.comment); assert.equal(saved.title, '最新收藏页名称');
    assert.equal(saved.kind, 'movie'); assert.equal(saved.publishedAt, '2026-11-10T00:00:00.000Z');
    assert.equal(saved.source, 'collection'); assert.equal(saved.updatedAt, T2); assert.equal(saved.observedAt, T3);
    assert.deepEqual([run.added, run.updated, run.unchanged], [1, 0, 1]);
  }
});

test('RSS-to-RSS content advances only with a known newer publication timestamp', async t => {
  const { db } = fixture(t); let run = await connected(db);
  const rss = (publishedAt: string | null, patch: Partial<DoubanRecordInput> = {}) => record('1', 'screen', { source: 'rss', markedDate: null, publishedAt, ...patch });
  run = await commitDoubanStep(db, 'alice', step(run, [rss('2026-11-10T00:00:00.000Z', { rating: 4, comment: 'known newer comment' })]));
  run = await commitDoubanStep(db, 'alice', step(run, [rss('2026-11-01T00:00:00.000Z', { rating: 1, title: 'stale title', comment: 'stale comment' })], { now: T3 }));
  run = await commitDoubanStep(db, 'alice', step(run, [rss(null, { rating: 1, title: 'unknown time title', comment: 'unknown time comment' })], { now: T3 }));
  let saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.rating, 4); assert.equal(saved.comment, 'known newer comment'); assert.equal(saved.title, '合成条目 1'); assert.equal(saved.updatedAt, T2);
  run = await commitDoubanStep(db, 'alice', step(run, [rss('2026-11-13T00:00:00.000Z', { rating: 2, title: 'new title', comment: 'new comment' })], { now: T3 }));
  saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.rating, 2); assert.equal(saved.comment, 'new comment'); assert.equal(saved.title, 'new title'); assert.equal(saved.publishedAt, '2026-11-13T00:00:00.000Z');
  assert.deepEqual([run.added, run.updated, run.unchanged], [1, 1, 2]);
});

test('reimporting another format with missing optional fields preserves known private details and yields an unchanged preview', async t => {
  const { db } = fixture(t);
  const known = privateRecord('1', 'movie', { rating: 5, comment: 'original private details', markedDate: '2026-10-01',
    coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg', publishedAt: '2026-10-02T00:00:00.000Z' });
  await importRecords(db, [known]);
  const unknown = privateRecord('1', 'screen', { rating: null, comment: null, markedDate: null, coverUrl: null, publishedAt: null });
  const second = await importRecords(db, [unknown], { now: T2 });
  assert.deepEqual([second.preview.added, second.preview.updated, second.preview.unchanged], [0, 0, 1]);
  const saved = (await listDoubanRecords(db, 'alice')).items[0];
  for (const key of ['rating', 'comment', 'markedDate', 'coverUrl', 'publishedAt', 'kind'] as const) assert.equal(saved[key], known[key]);
  assert.equal(saved.updatedAt, T1); assert.equal(saved.observedAt, T2);
});

test('a private or authoritative update arriving after public-step planning rejects the stale whole page without misleading counters', async t => {
  const f = fixture(t); let run = await connected(f.db);
  run = await commitDoubanStep(f.db, 'alice', step(run, [record('1', 'screen', { source: 'rss', markedDate: null, publishedAt: '2026-11-01T00:00:00.000Z' })]));
  f.beforeBatch(() => { f.sqlite.prepare("UPDATE douban_items SET source='import',rating=5,comment='private concurrent value',kind='movie',updated_at=?,observed_at=? WHERE user_id='alice' AND subject_id='1'").run(T3, T3); });
  await assert.rejects(commitDoubanStep(f.db, 'alice', step(run, [record('1', 'screen', { source: 'rss', markedDate: null, rating: 1, comment: 'old public value', publishedAt: '2026-11-13T00:00:00.000Z' }), record('2')], { now: T3 })), conflict);
  const saved = await listDoubanRecords(f.db, 'alice');
  assert.equal(saved.total, 1); assert.equal(saved.items[0].comment, 'private concurrent value'); assert.equal(saved.items[0].rating, 5); assert.equal(saved.items[0].kind, 'movie');
  const current = await readDoubanRun(f.db, 'alice', run.id);
  assert.equal(current?.revision, run.revision); assert.deepEqual([current?.added, current?.updated, current?.unchanged], [1, 0, 0]);
});

test('saved-record lookup resolves covers and metadata only inside the authenticated owner, profile and media domain', async t => {
  const { db } = fixture(t);
  const cover = 'https://img1.doubanio.com/view/subject/s/public/s1.jpg';
  await importRecords(db, [privateRecord('1', 'book', { coverUrl: cover, comment: 'ALICE_ONLY' })]);
  await importRecords(db, [privateRecord('1', 'book', { comment: 'BOB_ONLY' })], { userId: 'bob' });
  const key = { profileId: 'alice_douban', domain: 'book' as const, subjectId: '1' };
  const saved = await readDoubanRecord(db, 'alice', key);
  assert.equal(saved?.coverUrl, cover); assert.equal(saved?.comment, 'ALICE_ONLY');
  assert.equal((await readDoubanRecord(db, 'bob', key))?.comment, 'BOB_ONLY');
  assert.equal(await readDoubanRecord(db, 'alice', { ...key, profileId: 'other_profile' }), null);
  assert.equal(await readDoubanRecord(db, 'alice', { ...key, domain: 'screen' }), null);
  assert.equal(await readDoubanRecord(db, "alice' OR 1=1 --", key), null);
  await assert.rejects(readDoubanRecord(db, 'alice', { ...key, subjectId: '../1' }));
});

test('an explicit manual media kind survives collection, RSS, classification steps and later imported category values', async t => {
  const { db, sqlite } = fixture(t); let run = await connected(db);
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'movie')]));
  sqlite.prepare("UPDATE douban_items SET metadata_checked_run_id='manual-kind' WHERE user_id='alice'").run();
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'series')], { now: T3 }));
  let saved = await readDoubanRecord(db, 'alice', { profileId: 'alice_douban', domain: 'screen', subjectId: '1' });
  assert.equal(saved?.kind, 'movie'); assert.equal(saved?.metadataCheckedRunId, 'manual-kind'); assert.equal(run.updated, 0);
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'series', { source: 'rss', markedDate: null, publishedAt: '2026-11-13T00:00:00.000Z' })], { now: T3 }));
  run = await commitDoubanStep(db, 'alice', step(run, [], { classification: { domain: 'screen', subjectId: '1', kind: 'series' }, now: T3 }));
  saved = await readDoubanRecord(db, 'alice', { profileId: 'alice_douban', domain: 'screen', subjectId: '1' });
  assert.equal(saved?.kind, 'movie'); assert.equal(saved?.metadataCheckedRunId, 'manual-kind');
  await importRecords(db, [privateRecord('1', 'series')], { now: T3 });
  saved = await readDoubanRecord(db, 'alice', { profileId: 'alice_douban', domain: 'screen', subjectId: '1' });
  assert.equal(saved?.kind, 'movie'); assert.equal(saved?.metadataCheckedRunId, 'manual-kind');
});

test('newer RSS does not override a manually chosen type even when other RSS metadata can advance', async t => {
  const { db, sqlite } = fixture(t); let run = await connected(db);
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'movie', { source: 'rss', markedDate: null, publishedAt: '2026-11-01T00:00:00.000Z' })]));
  sqlite.prepare("UPDATE douban_items SET metadata_checked_run_id='manual-kind' WHERE user_id='alice'").run();
  run = await commitDoubanStep(db, 'alice', step(run, [record('1', 'series', { source: 'rss', markedDate: null, title: '更新后的公开名称', publishedAt: '2026-11-13T00:00:00.000Z' })], { now: T3 }));
  const saved = (await listDoubanRecords(db, 'alice')).items[0];
  assert.equal(saved.kind, 'movie'); assert.equal(saved.title, '更新后的公开名称'); assert.equal(saved.metadataCheckedRunId, 'manual-kind'); assert.equal(run.updated, 1);
});

test('a same-kind manual choice after preview invalidates that import while ordinary metadata observations remain compatible', async t => {
  const { db, sqlite } = fixture(t);
  await importRecords(db, [privateRecord('1', 'movie')]);
  const items = [privateRecord('1', 'series')], input = { profileId: 'alice_douban', items };
  const preview = await previewDoubanImport(db, 'alice', input);
  sqlite.prepare("UPDATE douban_items SET metadata_checked_run_id='manual-kind' WHERE user_id='alice'").run();
  await assert.rejects(commitDoubanImport(db, 'alice', { ...input, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), now: T3 }), conflict);
  const fresh = await previewDoubanImport(db, 'alice', input);
  assert.notEqual(fresh.snapshotHash, preview.snapshotHash); assert.equal(fresh.unchanged, 1);
  await commitDoubanImport(db, 'alice', { ...input, expectedSnapshotHash: fresh.snapshotHash, requestId: crypto.randomUUID(), now: T3 });
  assert.equal((await listDoubanRecords(db, 'alice')).items[0].kind, 'movie');
});

test('the transactional import snapshot also detects a same-kind manual choice arriving after its final preparation read', async t => {
  const f = fixture(t);
  await importRecords(f.db, [privateRecord('1', 'movie')]);
  const input = { profileId: 'alice_douban', items: [privateRecord('1', 'series'), privateRecord('2', 'book')] };
  const preview = await previewDoubanImport(f.db, 'alice', input);
  f.beforeBatch(() => { f.sqlite.prepare("UPDATE douban_items SET metadata_checked_run_id='manual-kind' WHERE user_id='alice' AND subject_id='1'").run(); });
  await assert.rejects(commitDoubanImport(f.db, 'alice', { ...input, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), now: T3 }), conflict);
  const saved = await listDoubanRecords(f.db, 'alice');
  assert.equal(saved.total, 1); assert.equal(saved.items[0].kind, 'movie'); assert.equal(saved.items[0].metadataCheckedRunId, 'manual-kind');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_import_receipts').get()?.n, 1);
});

async function clearRecords(db: DoubanDatabase, userId = 'alice') {
  const preview = await previewDoubanReset(db, userId);
  return commitDoubanReset(db, userId, { expectedEpoch: preview.epoch, expectedPreviewHash: preview.previewHash, requestId: crypto.randomUUID(), confirmed: true, now: T3 });
}
function simulateConcurrentClear(sqlite: DatabaseSync, userId = 'alice') {
  sqlite.prepare('DELETE FROM douban_items WHERE user_id=?').run(userId);
  sqlite.prepare('DELETE FROM douban_sync_runs WHERE user_id=?').run(userId);
  sqlite.prepare('DELETE FROM douban_import_receipts WHERE user_id=?').run(userId);
  sqlite.prepare(`INSERT INTO douban_data_resets(user_id,data_epoch,last_request_id,last_request_hash,last_receipt_json,created_at,updated_at)
    VALUES (?,1,?,?,?, ?,?)`).run(userId, crypto.randomUUID(), 'a'.repeat(64), '{}', T3, T3);
}
const epochConflict = (error: unknown) => error instanceof DoubanStoreError && error.code === 'DOUBAN_DATA_EPOCH_CONFLICT' && error.status === 409;

void test('even an empty-target import preview is fenced by reset generation and a refreshed preview needs the explicit current epoch', async t => {
  const { db } = fixture(t), input = { profileId: 'alice_douban', items: [privateRecord('77', 'book')] };
  const before = await previewDoubanImport(db, 'alice', input); assert.equal(before.dataEpoch, 0); assert.equal(before.added, 1);
  await clearRecords(db); assert.equal(await readDoubanDataEpoch(db, 'alice'), 1);
  await assert.rejects(previewDoubanImport(db, 'alice', input), epochConflict);
  await assert.rejects(commitDoubanImport(db, 'alice', { ...input, expectedSnapshotHash: before.snapshotHash, requestId: crypto.randomUUID() }), epochConflict);
  const fresh = await previewDoubanImport(db, 'alice', { ...input, expectedDataEpoch: 1 }); assert.equal(fresh.dataEpoch, 1); assert.notEqual(fresh.snapshotHash, before.snapshotHash);
  const receipt = await commitDoubanImport(db, 'alice', { ...input, expectedDataEpoch: 1, expectedSnapshotHash: fresh.snapshotHash, requestId: crypto.randomUUID() });
  assert.equal(receipt.dataEpoch, 1); assert.equal((await listDoubanRecords(db, 'alice')).total, 1);
  assert.equal((await previewDoubanImport(db, 'bob', input)).dataEpoch, 0, 'other actors retain epoch-zero compatibility');
});

void test('a clear winning after import planning rejects the first receipt and rolls back every chunk without resurrecting records', async t => {
  const f = fixture(t); await importRecords(f.db, [privateRecord('1', 'book')]); await importRecords(f.db, [privateRecord('2', 'book')], { userId: 'bob' });
  const input = { profileId: 'alice_douban', items: Array.from({ length: 101 }, (_, index) => privateRecord(String(1000 + index), 'book')) };
  const preview = await previewDoubanImport(f.db, 'alice', input);
  f.beforeBatch(() => simulateConcurrentClear(f.sqlite));
  await assert.rejects(commitDoubanImport(f.db, 'alice', { ...input, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID() }), epochConflict);
  assert.equal((await listDoubanRecords(f.db, 'alice')).total, 0); assert.equal((await listDoubanRecords(f.db, 'bob')).total, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_import_receipts WHERE user_id='alice'").get()?.n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_import_receipts WHERE user_id='bob'").get()?.n, 1);
});

void test('a pre-clear import receipt cannot report replay success after clear, even when the target was emptied', async t => {
  const { db } = fixture(t), original = await importRecords(db, [privateRecord('1', 'book')]);
  await clearRecords(db); await assert.rejects(commitDoubanImport(db, 'alice', original.command), epochConflict);
  assert.equal((await listDoubanRecords(db, 'alice')).total, 0);
  for (const expectedDataEpoch of [-1, 0.5, null, '0'] as unknown as number[]) {
    await assert.rejects(previewDoubanImport(db, 'alice', { profileId: 'alice_douban', items: [privateRecord()], expectedDataEpoch }), error => error instanceof DoubanStoreError && error.status === 400);
  }
});

void test('clear after the import batch but before its response prevents a stale successful receipt from returning', async t => {
  const f = fixture(t), input = { profileId: 'alice_douban', items: [privateRecord('1', 'book')] };
  const preview = await previewDoubanImport(f.db, 'alice', input);
  const racing = { prepare: f.db.prepare, async batch(commands: Parameters<DoubanDatabase['batch']>[0]) { const result = await f.db.batch(commands); await clearRecords(f.db); return result; } } as DoubanDatabase;
  await assert.rejects(commitDoubanImport(racing, 'alice', { ...input, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID() }), epochConflict);
  assert.equal((await listDoubanRecords(f.db, 'alice')).total, 0); assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_import_receipts').get()?.n, 0);
});

void test('work details round-trip through imports and public refresh without erasing personal fields or manual kind', async t => {
  const f = fixture(t);
  const details = { summary: '作品简介', directors: ['导演甲'], genres: ['剧情'], doubanRating: 8.5, ratingCount: 123 };
  await importRecords(f.db, [privateRecord('1', 'movie', { details })]);
  f.sqlite.prepare("UPDATE douban_items SET metadata_checked_run_id='manual-kind' WHERE user_id='alice'").run();
  let run = await connected(f.db);
  run = await commitDoubanStep(f.db, 'alice', step(run, [record('1', 'series', { rating: null, comment: null, markedDate: null, details: { countries: ['中国'] } })]));
  let saved = (await listDoubanRecords(f.db, 'alice')).items[0];
  assert.deepEqual(saved.details, { ...details, countries: ['中国'] }); assert.equal(saved.kind, 'movie'); assert.equal(saved.rating, 4); assert.equal(saved.comment, '自己的短评'); assert.equal(saved.source, 'import');
  await importRecords(f.db, [privateRecord('1', 'screen', { details: { summary: '更新的作品简介', directors: [] }, rating: null, comment: null, markedDate: null })], { now: T3 });
  saved = (await listDoubanRecords(f.db, 'alice')).items[0]; assert.equal(saved.details?.summary, '更新的作品简介'); assert.deepEqual(saved.details?.directors, ['导演甲']); assert.equal(saved.kind, 'movie');
  assert.equal(JSON.stringify(saved).includes('detailsJson'), false);
  run = await commitDoubanStep(f.db, 'alice', step(run, [record('1', 'screen', { details: {} })], { now: T3 }));
  assert.equal((await listDoubanRecords(f.db, 'alice')).items[0].details?.summary, '更新的作品简介');
});

void test('public classification saves same-response details and cover even when type is unknown, retaining a manual kind', async t => {
  const f = fixture(t); let run = await connected(f.db);
  run = await commitDoubanStep(f.db, 'alice', step(run, [record('1', 'screen')]));
  const coverUrl = 'https://img1.doubanio.com/view/subject/s/public/s1.jpg';
  run = await commitDoubanStep(f.db, 'alice', step(run, [], { classification: { domain: 'screen', subjectId: '1', kind: null, coverUrl, details: { summary: '已确认的简介', cast: ['演员甲'] } } }));
  let saved = (await listDoubanRecords(f.db, 'alice')).items[0]; assert.equal(saved.kind, 'screen'); assert.equal(saved.coverUrl, coverUrl); assert.equal(saved.details?.summary, '已确认的简介'); assert.equal(saved.metadataCheckedRunId, run.id); assert.equal(run.updated, 1);
  f.sqlite.prepare("UPDATE douban_items SET kind='movie',metadata_checked_run_id='manual-kind' WHERE user_id='alice'").run();
  run = await commitDoubanStep(f.db, 'alice', step(run, [], { classification: { domain: 'screen', subjectId: '1', kind: 'series', details: { episodes: 12 } }, now: T3 }));
  saved = (await listDoubanRecords(f.db, 'alice')).items[0]; assert.equal(saved.kind, 'movie'); assert.equal(saved.details?.episodes, 12); assert.deepEqual(saved.details?.cast, ['演员甲']); assert.equal(saved.metadataCheckedRunId, 'manual-kind');
});

void test('a concurrent work-details change fences public and import snapshots even if content timestamps remain unchanged', async t => {
  const f = fixture(t); await importRecords(f.db, [privateRecord('1', 'movie', { details: { summary: '原简介' } })]);
  const input = { profileId: 'alice_douban', items: [privateRecord('1', 'movie', { details: { year: 2020 } }), privateRecord('2', 'book')] };
  const preview = await previewDoubanImport(f.db, 'alice', input);
  f.beforeBatch(() => { f.sqlite.prepare("UPDATE douban_items SET details_json=? WHERE user_id='alice' AND subject_id='1'").run(JSON.stringify({ summary: '另一个已确认的简介' })); });
  await assert.rejects(commitDoubanImport(f.db, 'alice', { ...input, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID() }), conflict);
  const saved = await listDoubanRecords(f.db, 'alice'); assert.equal(saved.total, 1); assert.equal(saved.items[0].details?.summary, '另一个已确认的简介');
  const run = await connected(f.db);
  f.beforeBatch(() => { f.sqlite.prepare("UPDATE douban_items SET details_json=? WHERE user_id='alice'").run(JSON.stringify({ summary: '第三份简介' })); });
  await assert.rejects(commitDoubanStep(f.db, 'alice', step(run, [record('1', 'screen', { details: { year: 2022 } }), record('3')])), conflict);
  assert.equal((await listDoubanRecords(f.db, 'alice')).total, 1);
});

void test('rich Unicode imports split by encoded binding size while retaining sparse known details', async t => {
  const f = fixture(t);
  const items = Array.from({ length: 150 }, (_, index) => privateRecord(String(10000 + index), 'book', { title: '书'.repeat(500), comment: '评'.repeat(2000), details: { summary: 's'.repeat(12000), authors: ['作者甲'] } }));
  const first = await importRecords(f.db, items); assert.equal(first.receipt.added, 150);
  const second = await importRecords(f.db, items.map(({ details: _details, ...item }) => item), { now: T2 }); assert.equal(second.receipt.unchanged, 150);
  assert.ok(f.bindingSizes.every(size => size < 2 * 1024 * 1024), 'each D1 statement stays below 2 MiB even when details and personal text are rich');
  assert.equal((await listDoubanRecords(f.db, 'alice')).items[0].details?.summary?.length, 12000);
});

void test('record validation keeps empty details optional and maps detail violations to the existing public input error', () => {
  const item = privateRecord('1', 'book');
  assert.deepEqual(parseDoubanRecord({ ...item, details: { summary: ' ', authors: [] } }), parseDoubanRecord(item));
  for (const details of [{ cookie: 'PRIVATE' }, { myRating: 1 }, { summary: '<script>unsafe()</script>' }, { pages: -1 }, { doubanRating: '8.5' }]) {
    assert.throws(() => parseDoubanRecord({ ...item, details }), error => error instanceof DoubanValidationError && error.code === 'INVALID_DOUBAN_INPUT' && error.status === 400);
  }
});

void test('small import-page reads return only current owner/profile/key versions and never copy rows into the receipt', async t => {
  const f = fixture(t), input = [privateRecord('1', 'screen', { comment: 'ALICE_PRIVATE' }), privateRecord('2', 'book')];
  const imported = await importRecords(f.db, input);
  await importRecords(f.db, [privateRecord('1', 'screen', { comment: 'BOB_PRIVATE' })], { userId: 'bob' });
  await importRecords(f.db, [privateRecord('1', 'screen', { comment: 'OTHER_SOURCE_PRIVATE' })], { profileId: 'another_profile' });
  f.sqlite.prepare("UPDATE douban_items SET kind='movie',updated_at=?,metadata_checked_run_id='manual-kind',details_json=? WHERE user_id='alice' AND profile_id='alice_douban' AND subject_id='1'").run(T3, JSON.stringify({ summary: '最新已保存详情' }));
  const records = await readDoubanImportRecords(f.db, 'alice', { profileId: 'alice_douban', items: [input[0]], expectedDataEpoch: 0 });
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'movie'); assert.equal(records[0].updatedAt, T3); assert.equal(records[0].details?.summary, '最新已保存详情');
  assert.equal(records[0].comment, 'ALICE_PRIVATE'); assert.doesNotMatch(JSON.stringify(records), /BOB_PRIVATE|OTHER_SOURCE_PRIVATE/);
  assert.deepEqual(await commitDoubanImport(f.db, 'alice', imported.command), imported.receipt, 'the receipt still replays its original counters');
  const storedReceipt = f.sqlite.prepare("SELECT receipt_json FROM douban_import_receipts WHERE user_id='alice' AND request_id=?").get(imported.command.requestId)?.receipt_json as string;
  assert.doesNotMatch(storedReceipt, /ALICE_PRIVATE|最新已保存详情|records|updatedAt/);
  await assert.rejects(readDoubanImportRecords(f.db, 'alice', { profileId: 'alice_douban', items: Array.from({ length: 31 }, (_, index) => privateRecord(String(index + 1))) }), error => error instanceof DoubanStoreError && error.status === 400);
});

void test('a clear winning during current import-row reads fences the entire response instead of returning old versions', async t => {
  const f = fixture(t), input = { profileId: 'alice_douban', items: [privateRecord('1', 'book')] };
  await importRecords(f.db, input.items); let reset = false;
  const racing = { prepare(sql: string) {
    const prepared = f.db.prepare(sql);
    return { bind(...values: unknown[]) {
      const bound = prepared.bind(...values);
      return { first<T>() { return bound.first<T>(); }, async all<T>() {
        const result = await bound.all<T>(); if (!reset && sql.includes('ORDER BY domain,subject_id')) { reset = true; simulateConcurrentClear(f.sqlite); } return result;
      } };
    } };
  } } as unknown as DoubanDatabase;
  await assert.rejects(readDoubanImportRecords(racing, 'alice', { ...input, expectedDataEpoch: 0 }), epochConflict);
  assert.equal((await listDoubanRecords(f.db, 'alice')).total, 0);
});
