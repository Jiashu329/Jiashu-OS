import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { commitDoubanReset, previewDoubanReset } from './douban-reset-store.ts';

const migration = readFileSync(new URL('../drizzle/0026_owner_requested_douban_reset.sql', import.meta.url), 'utf8');
// Exercise the exact maintenance SQL against synthetic local identities only.
const target = migration.match(/WHERE id='owner' AND user_id='((?:''|[^'])+)'/)[1];
const requestId = migration.match(/SELECT owner.user_id,1,'([0-9a-f-]+)'/)[1];
const draft = migration.replaceAll(target, '__TARGET_USER_ID__').replaceAll(requestId, '__REQUEST_ID__');
const ACTOR = 'synthetic-owner', OTHER = 'synthetic-other';
const REQUEST = '11111111-1111-4111-8111-111111111111', LATER = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-14T08:00:00.000Z';
function render(actor = ACTOR) { return draft.replaceAll('__TARGET_USER_ID__', actor.replaceAll("'", "''")).replaceAll('__REQUEST_ID__', REQUEST); }
function atomic(sqlite, sql) {
  sqlite.exec('BEGIN');
  try { sqlite.exec(sql); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:'), directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  t.after(() => sqlite.close());
  sqlite.prepare("INSERT INTO app_owner_identity VALUES ('owner',?,?,?)").run(ACTOR, 'synthetic-owner@example.invalid', NOW);
  sqlite.exec('CREATE TABLE other_feature(user_id TEXT PRIMARY KEY,contents TEXT NOT NULL)');
  for (const owner of [ACTOR, OTHER]) {
    sqlite.prepare('INSERT INTO douban_connections VALUES (?,?,1,?)').run(owner, 'saved_profile', NOW);
    sqlite.prepare(`INSERT INTO douban_sync_runs(user_id,id,profile_id,connection_revision,status,state_json,created_at,updated_at)
      VALUES (?,?,?,1,'running',?,?,?)`).run(owner, REQUEST, 'saved_profile', '{"private":"RAW_PRIVATE_DIAGNOSTICS"}', NOW, NOW);
    sqlite.prepare('INSERT INTO douban_import_receipts VALUES (?,?,?,?,?)').run(owner, REQUEST, 'a'.repeat(64), '{"private":"RAW_PRIVATE_IMPORT"}', NOW);
    sqlite.prepare('INSERT INTO other_feature VALUES (?,?)').run(owner, 'OTHER_FEATURE_UNCHANGED');
    item(sqlite, owner, '1', 'movie'); item(sqlite, owner, '2', 'book', 'old_profile');
  }
  const db = { prepare(sql) { const statement = sqlite.prepare(sql); let values = [];
    const bound = { bind(...args) { values = args; return bound; }, async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; }, execute() { return { results: statement.columns().length ? statement.all(...values) : (statement.run(...values), []) }; } }; return bound;
  }, async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  return { sqlite, db };
}
function item(sqlite, owner, subject, kind, profile = 'saved_profile') {
  const domain = ['movie', 'series'].includes(kind) ? 'screen' : kind;
  const host = { screen: 'movie', book: 'book', music: 'music' }[domain];
  sqlite.prepare(`INSERT INTO douban_items(user_id,profile_id,domain,subject_id,kind,title,url,comment,source,observed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'import',?,?,?)`).run(owner, profile, domain, subject, kind, 'PRIVATE_TITLE', 'https://' + host + '.douban.com/subject/' + subject + '/', 'PRIVATE_COMMENT', NOW, NOW, NOW);
}
function rows(sqlite, table, owner = ACTOR) { return sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY rowid`).all(owner).map(row => ({ ...row })); }
function assertNewItemSurvives(sqlite) { assert.deepEqual(rows(sqlite, 'douban_items').map(row => row.subject_id), ['3']); }

test('exact owner cleanup deletes all source profiles and diagnostics, retains its profile, and cannot touch another owner or feature', t => {
  const { sqlite } = fixture(t), sql = render();
  const otherBefore = ['douban_items', 'douban_sync_runs', 'douban_import_receipts', 'douban_connections'].map(table => rows(sqlite, table, OTHER));
  atomic(sqlite, sql);
  for (const table of ['douban_items', 'douban_sync_runs', 'douban_import_receipts']) assert.deepEqual(rows(sqlite, table), []);
  assert.deepEqual(['douban_items', 'douban_sync_runs', 'douban_import_receipts', 'douban_connections'].map(table => rows(sqlite, table, OTHER)), otherBefore);
  assert.deepEqual(rows(sqlite, 'other_feature'), [{ user_id: ACTOR, contents: 'OTHER_FEATURE_UNCHANGED' }]);
  const connection = rows(sqlite, 'douban_connections')[0]; assert.equal(connection.profile_id, 'saved_profile'); assert.equal(connection.revision, 2);
  const control = rows(sqlite, 'douban_data_resets')[0], receipt = JSON.parse(control.last_receipt_json);
  assert.equal(control.data_epoch, 1); assert.equal(control.last_request_id, REQUEST); assert.match(control.last_request_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.counts, { all: 2, screen: 0, movie: 1, series: 0, book: 1, music: 0 }); assert.equal(receipt.deleted, 2);
  assert.equal(receipt.requestId, REQUEST); assert.equal(receipt.epoch, 1); assert.match(receipt.clearedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_|profile|subject|email|user_id/);
});

test('manual SQL replay fails before deletes and cannot erase newly resynced data', t => {
  const { sqlite } = fixture(t); atomic(sqlite, render()); item(sqlite, ACTOR, '3', 'music');
  const before = rows(sqlite, 'douban_data_resets');
  assert.throws(() => atomic(sqlite, render()), /NOT NULL/);
  assertNewItemSurvives(sqlite); assert.deepEqual(rows(sqlite, 'douban_data_resets'), before);
  assert.equal(rows(sqlite, 'douban_connections')[0].revision, 2);
});

test('later ordinary clear may replace the last receipt but a replay of this migration still preserves subsequent data', async t => {
  const { sqlite, db } = fixture(t); atomic(sqlite, render()); item(sqlite, ACTOR, '3', 'music');
  const preview = await previewDoubanReset(db, ACTOR);
  await commitDoubanReset(db, ACTOR, { expectedEpoch: preview.epoch, expectedPreviewHash: preview.previewHash, requestId: LATER, confirmed: true });
  item(sqlite, ACTOR, '3', 'book', 'resynced_again');
  assert.throws(() => atomic(sqlite, render()), /NOT NULL/);
  assertNewItemSurvives(sqlite); assert.equal(rows(sqlite, 'douban_data_resets')[0].data_epoch, 2);
  assert.equal(rows(sqlite, 'douban_data_resets')[0].last_request_id, LATER);
  assert.equal(rows(sqlite, 'douban_connections')[0].revision, 3);
});

test('an already positive epoch from another reset blocks this maintenance command without modifying data', async t => {
  const { sqlite, db } = fixture(t), preview = await previewDoubanReset(db, ACTOR);
  await commitDoubanReset(db, ACTOR, { expectedEpoch: 0, expectedPreviewHash: preview.previewHash, requestId: LATER, confirmed: true });
  item(sqlite, ACTOR, '3', 'book');
  assert.throws(() => atomic(sqlite, render()), /NOT NULL/); assertNewItemSurvives(sqlite);
  assert.equal(rows(sqlite, 'douban_data_resets')[0].last_request_id, LATER);
});

test('missing, different, unresolved, and SQL-escaped owner identities are safe no-ops without clearing either user', t => {
  const { sqlite } = fixture(t), before = [rows(sqlite, 'douban_items'), rows(sqlite, 'douban_items', OTHER)];
  for (const sql of [render(OTHER), render("' OR 1=1 --"), draft]) {
    assert.doesNotThrow(() => atomic(sqlite, sql));
    assert.deepEqual([rows(sqlite, 'douban_items'), rows(sqlite, 'douban_items', OTHER)], before);
    assert.deepEqual(rows(sqlite, 'douban_data_resets'), []);
  }
  sqlite.prepare("DELETE FROM app_owner_identity WHERE id='owner'").run();
  assert.doesNotThrow(() => atomic(sqlite, render()));
  assert.deepEqual([rows(sqlite, 'douban_items'), rows(sqlite, 'douban_items', OTHER)], before);
});

test('an old matching maintenance receipt cannot permit deletion after database ownership changes', t => {
  const { sqlite } = fixture(t); atomic(sqlite, render()); item(sqlite, ACTOR, '3', 'book');
  sqlite.prepare("UPDATE app_owner_identity SET user_id=?,email=? WHERE id='owner'").run(OTHER, 'synthetic-other@example.invalid');
  const before = [rows(sqlite, 'douban_items'), rows(sqlite, 'douban_items', OTHER), rows(sqlite, 'douban_data_resets')];
  assert.doesNotThrow(() => atomic(sqlite, render()));
  assert.deepEqual([rows(sqlite, 'douban_items'), rows(sqlite, 'douban_items', OTHER), rows(sqlite, 'douban_data_resets')], before);
});

test('a genuinely fresh database applies this data migration as a schema-preserving no-op', t => {
  const sqlite = new DatabaseSync(':memory:'), directory = new URL('../drizzle/', import.meta.url);
  t.after(() => sqlite.close());
  for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  const before = sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.doesNotThrow(() => atomic(sqlite, render()));
  assert.deepEqual(sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(), before);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM douban_data_resets').get().n, 0);
});

test('a failure after deleting items rolls the full migration back, including the new fence and diagnostic deletions', t => {
  const { sqlite } = fixture(t), before = rows(sqlite, 'douban_items');
  sqlite.exec("CREATE TRIGGER synthetic_delete_failure BEFORE DELETE ON douban_sync_runs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => atomic(sqlite, render()), /synthetic failure/);
  assert.deepEqual(rows(sqlite, 'douban_items'), before); assert.deepEqual(rows(sqlite, 'douban_data_resets'), []);
  assert.equal(rows(sqlite, 'douban_sync_runs').length, 1); assert.equal(rows(sqlite, 'douban_import_receipts').length, 1);
  assert.equal(rows(sqlite, 'douban_connections')[0].revision, 1);
});
