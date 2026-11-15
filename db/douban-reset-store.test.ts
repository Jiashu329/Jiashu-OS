import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { exportDataBackup } from './data-backup-store.ts';
import { BACKUP_TABLE_NAMES } from '../lib/data-backup.ts';
import { writeDoubanLocalRecord } from './douban-library-store.ts';
import { commitDoubanReset, DoubanResetStoreError, previewDoubanReset, readDoubanDataEpoch,
  type DoubanResetCommand, type DoubanResetDatabase, type DoubanResetReceipt } from './douban-reset-store.ts';

const T1 = '2026-11-14T08:00:00.000Z', T2 = '2026-11-14T08:01:00.000Z', T3 = '2026-11-14T08:02:00.000Z';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'), directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  sqlite.exec('CREATE TABLE unrelated_user_data(user_id TEXT PRIMARY KEY,content TEXT NOT NULL)');
  t.after(() => sqlite.close());
  let before: (() => void | Promise<void>) | null = null, failAt = -1, loseReply = false;
  const batchSizes: number[] = [];
  const db = {
    prepare(sql: string) {
      const query = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: unknown[]) { values = args as SQLInputValue[]; return statement; },
        async first<T>() { return query.get(...values) as T | undefined ?? null; },
        async all<T>() { return { results: query.all(...values) as T[] }; },
        execute() { if (query.columns().length) return { results: query.all(...values) }; return { results: [], meta: { changes: Number(query.run(...values).changes) } }; },
      }; return statement;
    },
    async batch(statements: Array<{ execute(): unknown }>) {
      batchSizes.push(statements.length); const callback = before; before = null; await callback?.();
      sqlite.exec('BEGIN');
      try {
        const result = statements.map((statement, index) => { if (index === failAt) { failAt = -1; throw new Error('PRIVATE_DATABASE_EXCEPTION'); } return statement.execute(); });
        sqlite.exec('COMMIT');
        if (loseReply) { loseReply = false; throw new Error('LOST_REPLY_AFTER_COMMIT'); }
        return result;
      } catch (error) { if (sqlite.isTransaction) sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as DoubanResetDatabase;
  return { db, sqlite, batchSizes, beforeBatch(callback: () => void | Promise<void>) { before = callback; }, failStatement(index: number) { failAt = index; }, loseNextReply() { loseReply = true; } };
}
function item(sqlite: DatabaseSync, owner = 'alice', subjectId = '1', kind = 'movie', profile = 'first_profile', time = T1) {
  const domain = ['movie', 'series'].includes(kind) ? 'screen' : kind;
  const host = { screen: 'movie', book: 'book', music: 'music' }[domain];
  sqlite.prepare(`INSERT INTO douban_items (user_id,profile_id,domain,subject_id,kind,title,url,rating,comment,source,observed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'import',?,?,?)`).run(owner, profile, domain, subjectId, kind, 'PRIVATE_TITLE_' + subjectId,
    'https://' + host + '.douban.com/subject/' + subjectId + '/', 5, 'PRIVATE_COMMENT_' + owner, time, time, time);
}
function diagnostics(sqlite: DatabaseSync, owner = 'alice') {
  sqlite.prepare('INSERT INTO douban_connections VALUES (?,?,1,?)').run(owner, 'saved_profile', T1);
  sqlite.prepare(`INSERT INTO douban_sync_runs(user_id,id,profile_id,connection_revision,status,state_json,created_at,updated_at)
    VALUES (?,?,?,1,'running',?,?,?)`).run(owner, A, 'saved_profile', '{"private":"PRIVATE_RUN_STATE"}', T1, T1);
  sqlite.prepare('INSERT INTO douban_import_receipts VALUES (?,?,?,?,?)').run(owner, A, 'a'.repeat(64), '{"private":"PRIVATE_IMPORT"}', T1);
  sqlite.prepare('INSERT INTO unrelated_user_data VALUES (?,?)').run(owner, 'PRIVATE_UNRELATED_' + owner);
}
async function command(db: DoubanResetDatabase, owner = 'alice', requestId = A): Promise<DoubanResetCommand> {
  const preview = await previewDoubanReset(db, owner);
  return { expectedEpoch: preview.epoch, expectedPreviewHash: preview.previewHash, requestId, confirmed: true, now: T2 };
}
const conflict = (error: unknown) => error instanceof DoubanResetStoreError && error.status === 409;
const epochConflict = (error: unknown) => error instanceof DoubanResetStoreError && error.code === 'DOUBAN_DATA_EPOCH_CONFLICT';

void test('a reset preview is bound to its owner and generation and contains only aggregate counts and timestamps', async t => {
  const { db, sqlite } = fixture(t);
  assert.equal(await readDoubanDataEpoch(db, 'alice'), 0);
  for (const [index, kind] of ['screen', 'movie', 'series', 'book', 'music', 'movie'].entries()) item(sqlite, 'alice', String(index + 1), kind, index > 4 ? 'other_profile' : 'first_profile');
  item(sqlite, 'bob', '1', 'music', 'first_profile', T3);
  const preview = await previewDoubanReset(db, 'alice');
  assert.deepEqual(preview.counts, { all: 6, screen: 1, movie: 2, series: 1, book: 1, music: 1 });
  assert.equal(preview.epoch, 0); assert.equal(preview.total, 6); assert.equal(preview.latestUpdatedAt, T1);
  assert.match(preview.previewHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_|first_profile|other_profile|subject/);
  assert.equal((await previewDoubanReset(db, "alice' OR 1=1 --")).total, 0);
  assert.notEqual((await previewDoubanReset(db, 'nobody')).previewHash, (await previewDoubanReset(db, 'other_nobody')).previewHash);
});

void test('confirmed clear erases all own source profiles and diagnostics atomically, keeps the binding and every other owner and feature', async t => {
  const { db, sqlite, batchSizes } = fixture(t);
  for (const owner of ['alice', 'bob']) { diagnostics(sqlite, owner); item(sqlite, owner); item(sqlite, owner, '2', 'book', 'old_profile'); }
  const bobBefore = sqlite.prepare("SELECT * FROM douban_items WHERE user_id='bob' ORDER BY subject_id").all();
  const receipt = await commitDoubanReset(db, 'alice', await command(db));
  assert.deepEqual(receipt, { requestId: A, epoch: 1, deleted: 2, counts: { all: 2, screen: 0, movie: 1, series: 0, book: 1, music: 0 }, clearedAt: T2 });
  for (const table of ['douban_items', 'douban_sync_runs', 'douban_import_receipts']) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get('alice')?.n, 0);
    assert.ok(Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get('bob')?.n) > 0);
  }
  assert.deepEqual(sqlite.prepare("SELECT * FROM douban_items WHERE user_id='bob' ORDER BY subject_id").all(), bobBefore);
  assert.deepEqual({ ...sqlite.prepare('SELECT profile_id,revision,updated_at FROM douban_connections WHERE user_id=?').get('alice') }, { profile_id: 'saved_profile', revision: 2, updated_at: T2 });
  assert.equal(sqlite.prepare('SELECT revision FROM douban_connections WHERE user_id=?').get('bob')?.revision, 1);
  assert.equal(sqlite.prepare('SELECT content FROM unrelated_user_data WHERE user_id=?').get('alice')?.content, 'PRIVATE_UNRELATED_alice');
  assert.equal(await readDoubanDataEpoch(db, 'alice'), 1); assert.equal(await readDoubanDataEpoch(db, 'bob'), 0);
  assert.deepEqual(batchSizes, [7]);
  assert.doesNotMatch(String(sqlite.prepare('SELECT last_receipt_json FROM douban_data_resets WHERE user_id=?').get('alice')?.last_receipt_json), /PRIVATE_|profile|subject/);
});

void test('the latest clear request replays after a lost reply and after resync without deleting the new data again', async t => {
  const f = fixture(t); item(f.sqlite); diagnostics(f.sqlite);
  const clear = await command(f.db); f.loseNextReply();
  const receipt = await commitDoubanReset(f.db, 'alice', clear);
  item(f.sqlite, 'alice', '2', 'book', 'resynced', T3);
  const batchCount = f.batchSizes.length;
  assert.deepEqual(await commitDoubanReset(f.db, 'alice', { ...clear, now: T3 }), receipt);
  assert.equal(f.batchSizes.length, batchCount);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_items WHERE user_id='alice'").get()?.n, 1);
  assert.equal(f.sqlite.prepare("SELECT revision FROM douban_connections WHERE user_id='alice'").get()?.revision, 2);
  await assert.rejects(commitDoubanReset(f.db, 'alice', { ...clear, expectedPreviewHash: 'f'.repeat(64) }), conflict);
  const next = await command(f.db, 'alice', B); await commitDoubanReset(f.db, 'alice', next);
  item(f.sqlite, 'alice', '3', 'music', 'resynced', T3);
  await assert.rejects(commitDoubanReset(f.db, 'alice', clear), epochConflict);
  assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_items WHERE user_id='alice'").get()?.n, 1);
});

void test('previewed counts, kind totals and latest modification or observation timestamps detect concurrent new data before clearing', async t => {
  const f = fixture(t); item(f.sqlite);
  const clear = await command(f.db); item(f.sqlite, 'alice', '2', 'book', 'new_profile', T2);
  await assert.rejects(commitDoubanReset(f.db, 'alice', clear), conflict);
  assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 0);
  const changedKind = await command(f.db);
  f.sqlite.prepare("UPDATE douban_items SET kind='series' WHERE user_id='alice' AND domain='screen'").run();
  await assert.rejects(commitDoubanReset(f.db, 'alice', changedKind), conflict);
  const changedBusiness = await command(f.db);
  f.sqlite.prepare("UPDATE douban_items SET comment='new private comment',updated_at=? WHERE user_id='alice'").run(T3);
  await assert.rejects(commitDoubanReset(f.db, 'alice', changedBusiness), conflict);
  const observed = await command(f.db);
  f.sqlite.prepare("UPDATE douban_items SET observed_at=? WHERE user_id='alice'").run('2026-11-14T08:03:00.000Z');
  await assert.rejects(commitDoubanReset(f.db, 'alice', observed), conflict);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_items WHERE user_id='alice'").get()?.n, 2);
});

void test('new data between the final preparation read and the batch aborts the entire reset for both initial and existing fences', async t => {
  for (const alreadyReset of [false, true]) {
    const f = fixture(t);
    if (alreadyReset) await commitDoubanReset(f.db, 'alice', await command(f.db));
    item(f.sqlite); diagnostics(f.sqlite);
    const clear = await command(f.db, 'alice', alreadyReset ? B : A);
    f.beforeBatch(() => { item(f.sqlite, 'alice', '2', 'book', 'race', T3); });
    await assert.rejects(commitDoubanReset(f.db, 'alice', clear), conflict);
    assert.equal(await readDoubanDataEpoch(f.db, 'alice'), alreadyReset ? 1 : 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_items WHERE user_id='alice'").get()?.n, 2);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_sync_runs WHERE user_id='alice'").get()?.n, 1);
    assert.equal(f.sqlite.prepare("SELECT revision FROM douban_connections WHERE user_id='alice'").get()?.revision, 1);
  }
});

void test('new local notes, tags and visibility invalidate a clear preview without changing the synchronization timestamps', async t => {
  for (const changes of [{ note: 'Important new note', tags: [], hidden: false }, { note: '', tags: ['new tag'], hidden: false }, { note: '', tags: [], hidden: true }]) {
    const f = fixture(t); item(f.sqlite); diagnostics(f.sqlite);
    const clear = await command(f.db);
    await writeDoubanLocalRecord(f.db, 'alice', { profileId: 'first_profile', domain: 'screen', subjectId: '1', expectedDataEpoch: 0, expectedLocalRevision: 0, ...changes });
    assert.deepEqual({ ...f.sqlite.prepare("SELECT updated_at,observed_at FROM douban_items WHERE user_id='alice'").get() }, { updated_at: T1, observed_at: T1 });
    await assert.rejects(commitDoubanReset(f.db, 'alice', clear), conflict);
    assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 0);
    const saved = f.sqlite.prepare("SELECT local_note,local_tags_json,local_hidden,local_revision FROM douban_items WHERE user_id='alice'").get();
    assert.deepEqual({ ...saved }, { local_note: changes.note, local_tags_json: JSON.stringify(changes.tags), local_hidden: changes.hidden ? 1 : 0, local_revision: 1 });
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM douban_sync_runs WHERE user_id='alice'").get()?.n, 1);
  }
});

void test('a local edit after the last clear preparation read also fails the atomic deletion guard', async t => {
  for (const alreadyReset of [false, true]) {
    const f = fixture(t);
    if (alreadyReset) await commitDoubanReset(f.db, 'alice', await command(f.db));
    item(f.sqlite); diagnostics(f.sqlite);
    const clear = await command(f.db, 'alice', alreadyReset ? B : A);
    f.beforeBatch(async () => {
      await writeDoubanLocalRecord(f.db, 'alice', { profileId: 'first_profile', domain: 'screen', subjectId: '1', expectedDataEpoch: alreadyReset ? 1 : 0, expectedLocalRevision: 0,
        note: 'Saved while another tab was confirming clear', tags: ['keep'], hidden: false });
    });
    await assert.rejects(commitDoubanReset(f.db, 'alice', clear), conflict);
    assert.equal(await readDoubanDataEpoch(f.db, 'alice'), alreadyReset ? 1 : 0);
    assert.equal(f.sqlite.prepare("SELECT local_note FROM douban_items WHERE user_id='alice'").get()?.local_note, 'Saved while another tab was confirming clear');
    assert.equal(f.sqlite.prepare("SELECT revision FROM douban_connections WHERE user_id='alice'").get()?.revision, 1);
  }
});

void test('the fixed-size local revision snapshot stays exact across carries and whole-revision sum overflow', async t => {
  const f = fixture(t);
  for (let index = 0; index < 1025; index++) item(f.sqlite, 'alice', String(index + 1));
  f.sqlite.prepare("UPDATE douban_items SET local_revision=? WHERE user_id='alice'").run(Number.MAX_SAFE_INTEGER - 1);
  assert.throws(() => f.sqlite.prepare("SELECT SUM(local_revision) FROM douban_items WHERE user_id='alice'").get(), /integer overflow/);
  const clear = await command(f.db);
  await writeDoubanLocalRecord(f.db, 'alice', { profileId: 'first_profile', domain: 'screen', subjectId: '1', expectedDataEpoch: 0, expectedLocalRevision: Number.MAX_SAFE_INTEGER - 1,
    note: 'Exact last revision', tags: [], hidden: false });
  await assert.rejects(commitDoubanReset(f.db, 'alice', clear), conflict);
  f.sqlite.prepare("UPDATE douban_items SET local_revision=1023 WHERE user_id='alice' AND subject_id='2'").run();
  const beforeCarry = await command(f.db);
  await writeDoubanLocalRecord(f.db, 'alice', { profileId: 'first_profile', domain: 'screen', subjectId: '2', expectedDataEpoch: 0, expectedLocalRevision: 1023,
    note: 'Carry into the next revision segment', tags: [], hidden: false });
  await assert.rejects(commitDoubanReset(f.db, 'alice', beforeCarry), conflict);
  const refreshed = await command(f.db);
  assert.equal((await commitDoubanReset(f.db, 'alice', refreshed)).deleted, 1025);
});

void test('a failed later statement rolls the new epoch, prior deletions, diagnostics and connection revision back together', async t => {
  const f = fixture(t); item(f.sqlite); diagnostics(f.sqlite);
  const clear = await command(f.db); f.failStatement(3);
  await assert.rejects(commitDoubanReset(f.db, 'alice', clear), error => error instanceof DoubanResetStoreError && error.status === 503 && !error.message.includes('PRIVATE_'));
  assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 0);
  for (const table of ['douban_items', 'douban_sync_runs', 'douban_import_receipts']) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get('alice')?.n, 1);
  assert.equal(f.sqlite.prepare("SELECT revision FROM douban_connections WHERE user_id='alice'").get()?.revision, 1);
  assert.equal((await commitDoubanReset(f.db, 'alice', clear)).deleted, 1);
});

void test('competing clear commands advance the epoch once and a loser cannot clear a later generation', async t => {
  const f = fixture(t); item(f.sqlite); diagnostics(f.sqlite);
  const clear = await command(f.db);
  const result = await Promise.allSettled([commitDoubanReset(f.db, 'alice', clear), commitDoubanReset(f.db, 'alice', { ...clear, requestId: B })]);
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
  const loser = result.find(value => value.status === 'rejected'); assert.ok(loser && epochConflict(loser.reason));
  assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 1);
  assert.equal(f.sqlite.prepare("SELECT revision FROM douban_connections WHERE user_id='alice'").get()?.revision, 2);
});

void test('a concurrent duplicate losing its CAS replays the winner and cannot delete data resynced before its own batch', async t => {
  const f = fixture(t); item(f.sqlite); diagnostics(f.sqlite);
  const clear = await command(f.db); let winner: DoubanResetReceipt | null = null;
  f.beforeBatch(async () => { winner = await commitDoubanReset(f.db, 'alice', clear); item(f.sqlite, 'alice', '2', 'book', 'resynced', T3); });
  const retried = await commitDoubanReset(f.db, 'alice', clear);
  assert.equal(retried.deleted, 1); assert.deepEqual(retried, winner);
  assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 1);
  assert.equal(f.sqlite.prepare("SELECT subject_id FROM douban_items WHERE user_id='alice'").get()?.subject_id, '2');
  assert.equal(f.sqlite.prepare("SELECT revision FROM douban_connections WHERE user_id='alice'").get()?.revision, 2);
  assert.deepEqual(f.batchSizes, [7, 7]);
});

void test('a confirmed empty reset still advances its fence without creating or changing a profile binding', async t => {
  const f = fixture(t); const clear = await command(f.db);
  const receipt = await commitDoubanReset(f.db, 'alice', clear);
  assert.equal(receipt.deleted, 0); assert.equal(receipt.epoch, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_connections').get()?.n, 0);
  assert.equal((await previewDoubanReset(f.db, 'alice')).epoch, 1);
  assert.deepEqual(await commitDoubanReset(f.db, 'alice', clear), receipt);
});

void test('invalid or unconfirmed reset inputs never mutate business records or their generation', async t => {
  const f = fixture(t); item(f.sqlite); const clear = await command(f.db);
  for (const patch of [{ confirmed: false }, { expectedEpoch: -1 }, { expectedEpoch: 0.5 }, { expectedEpoch: '0' }, { expectedEpoch: Number.MAX_SAFE_INTEGER },
    { expectedPreviewHash: 'x'.repeat(64) }, { expectedPreviewHash: 'A'.repeat(64) }, { requestId: 'not-a-uuid' }, { requestId: [A] }, { now: 'not-a-date' }]) {
    await assert.rejects(commitDoubanReset(f.db, 'alice', { ...clear, ...patch } as unknown as DoubanResetCommand), error => error instanceof DoubanResetStoreError && error.status === 400);
  }
  assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM douban_items').get()?.n, 1);
  assert.equal(f.batchSizes.length, 0);
});

void test('reset control records and counter receipts remain outside portable backups and cannot be restored as business data', async t => {
  const f = fixture(t); item(f.sqlite); await commitDoubanReset(f.db, 'alice', await command(f.db));
  assert.equal((BACKUP_TABLE_NAMES as readonly string[]).includes('douban_data_resets'), false);
  const backup = await exportDataBackup(f.db, 'alice', T3);
  assert.equal(Object.hasOwn(backup.tables, 'douban_data_resets'), false);
  assert.doesNotMatch(JSON.stringify(backup), /douban_data_resets|last_request_id|last_receipt_json|data_epoch/);
  assert.equal(await readDoubanDataEpoch(f.db, 'alice'), 1);
});
