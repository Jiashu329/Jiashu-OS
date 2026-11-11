import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { NutritionInput } from '../lib/nutrition.ts';
import { createNutritionEntry, listNutritionEntries, NutritionConflictError, readNutritionEntry,
  replaceNutritionEntry, setNutritionEntryDeleted, createNutritionBatch, readNutritionDayStatus, writeNutritionDayStatus, listNutritionDayStatuses, addNutritionFavorite, listNutritionFavorites, removeNutritionFavorite, recentNutritionFoods, readNutritionRangeSnapshot } from './nutrition-store.ts';

const NOW = '2026-11-10T04:00:00.000Z';
const LATER = '2026-11-10T05:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  execute(): { results: unknown[]; meta: { changes: number } };
}
function fixture(t: TestContext, options: { file?: boolean } = {}) {
  const directoryPath = options.file ? mkdtempSync(join(tmpdir(), 'nutrition-snapshot-')) : null;
  const filename = directoryPath ? join(directoryPath, 'test.sqlite') : ':memory:';
  const sqlite = new DatabaseSync(filename);
  if (options.file) sqlite.exec('PRAGMA journal_mode=WAL');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => { sqlite.close(); if (directoryPath) rmSync(directoryPath, { recursive: true, force: true }); });
  let readHook: (() => void) | null = null;
  let hook: (() => void) | null = null;
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      function beforeWrite() { if (/^\s*(UPDATE|INSERT)/i.test(sql)) { const action = hook; hook = null; action?.(); } }
      const bound: Statement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { beforeWrite(); return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { beforeWrite(); return { results: statement.all(...values) as T[] }; },
        execute() { beforeWrite(); return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } } : { results: [], meta: { changes: Number(statement.run(...values).changes) } }; },
      }; return bound;
    },
    async batch(commands: Statement[]) {
      sqlite.exec('BEGIN');
      try { const results = commands.map((command, index) => { const result = command.execute(); if (index === 0) { const action = readHook; readHook = null; action?.(); } return result; }); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { db, sqlite, filename,
    afterFirstBatchRead(action: () => void) { readHook = action; },
    beforeWrite(action: () => void) { hook = action; },
    count() { return Number(sqlite.prepare('SELECT count(*) AS total FROM nutrition_entries').get()?.total); },
  };
}
const input = (patch: Partial<NutritionInput> = {}): NutritionInput => ({ date: '2026-11-10', meal: 'breakfast', name: 'synthetic oats', portion: 'one bowl', note: '', caloriesTenth: 1234, ...patch });

void test('zero calories and unknown calories remain distinct through persistence and list reads', async (t) => {
  const f = fixture(t);
  const zero = await createNutritionEntry(f.db, 'alice', input({ caloriesTenth: 0 }), ID, NOW);
  const unknown = await createNutritionEntry(f.db, 'alice', input({ caloriesTenth: null }), SECOND, NOW);
  assert.equal(zero.entry.caloriesTenth, 0); assert.equal(unknown.entry.caloriesTenth, null); assert.equal(zero.entry.revision, 1);
  const entries = await listNutritionEntries(f.db, 'alice', { from: '2026-11-10', to: '2026-11-10' }); assert.equal(entries.length, 2); assert.deepEqual(new Set(entries.map((entry) => entry.caloriesTenth)), new Set([0, null]));
});

void test('same normalized creation content replays without duplicates or exposing internal fields', async (t) => {
  const f = fixture(t); const original = input(); const first = await createNutritionEntry(f.db, 'alice', original, ID, NOW);
  const reordered = { note: original.note, caloriesTenth: original.caloriesTenth, portion: original.portion, name: original.name, meal: original.meal, date: original.date };
  const replay = await createNutritionEntry(f.db, 'alice', reordered, ID.toUpperCase(), LATER);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(f.count(), 1); assert.equal(replay.entry.createdAt, NOW); assert.equal(replay.entry.updatedAt, NOW);
  assert.equal(Object.hasOwn(replay.entry, 'userId'), false); assert.equal(Object.hasOwn(replay.entry, 'creationHash'), false);
});

void test('creation replay returns the current edited or deleted entry without reverting or restoring it', async (t) => {
  const f = fixture(t); const original = input(); const first = await createNutritionEntry(f.db, 'alice', original, ID, NOW);
  const hash = f.sqlite.prepare('SELECT creation_hash FROM nutrition_entries WHERE id=?').get(ID)?.creation_hash;
  const edited = await replaceNutritionEntry(f.db, 'alice', ID, input({ name: 'changed lunch', date: '2026-11-09', meal: 'lunch', portion: '', note: 'new note', caloriesTenth: 5678 }), first.entry.revision, LATER); assert.ok(edited);
  const deleted = await setNutritionEntryDeleted(f.db, 'alice', ID, true, edited.revision, LATER); assert.ok(deleted);
  const replay = await createNutritionEntry(f.db, 'alice', original, ID, LATER); assert.equal(replay.replayed, true); assert.deepEqual(replay.entry, deleted); assert.equal(replay.entry.deletedAt, LATER); assert.equal(replay.entry.revision, 3);
  assert.equal(f.sqlite.prepare('SELECT creation_hash FROM nutrition_entries WHERE id=?').get(ID)?.creation_hash, hash);
  assert.equal((await listNutritionEntries(f.db, 'alice', { from: '2026-11-09', to: '2026-11-09' })).length, 0);
  assert.equal((await listNutritionEntries(f.db, 'alice', { from: '2026-11-09', to: '2026-11-09', includeDeleted: true })).length, 1);
});

void test('different content or a different owner cannot reuse a creation identifier', async (t) => {
  const f = fixture(t); await createNutritionEntry(f.db, 'alice', input(), ID, NOW);
  await assert.rejects(createNutritionEntry(f.db, 'alice', input({ caloriesTenth: null }), ID, NOW), NutritionConflictError);
  await assert.rejects(createNutritionEntry(f.db, 'bob', input(), ID, NOW), NutritionConflictError); assert.equal(f.count(), 1);
  assert.equal(await readNutritionEntry(f.db, 'bob', ID), null);
});

void test('complete replacement moves the selected date and meal while preserving creation identity', async (t) => {
  const f = fixture(t); await createNutritionEntry(f.db, 'alice', input(), ID, NOW);
  const updated = await replaceNutritionEntry(f.db, 'alice', ID, input({ date: '2026-11-08', meal: 'dinner', name: 'new dinner', portion: '', note: 'replacement', caloriesTenth: 0 }), 1, LATER); assert.ok(updated);
  assert.equal(updated.date, '2026-11-08'); assert.equal(updated.meal, 'dinner'); assert.equal(updated.name, 'new dinner'); assert.equal(updated.portion, ''); assert.equal(updated.note, 'replacement'); assert.equal(updated.caloriesTenth, 0); assert.equal(updated.revision, 2); assert.equal(updated.createdAt, NOW); assert.equal(updated.updatedAt, LATER);
  assert.equal((await listNutritionEntries(f.db, 'alice', { from: '2026-11-10', to: '2026-11-10' })).length, 0);
  assert.equal((await listNutritionEntries(f.db, 'alice', { from: '2026-11-08', to: '2026-11-08' })).length, 1);
});

void test('soft deletion and restoration require current revision and preserve all content', async (t) => {
  const f = fixture(t); const first = (await createNutritionEntry(f.db, 'alice', input({ caloriesTenth: null }), ID, NOW)).entry;
  const deleted = await setNutritionEntryDeleted(f.db, 'alice', ID, true, 1, LATER); assert.ok(deleted); assert.equal(deleted.revision, 2); assert.equal(deleted.deletedAt, LATER);
  await assert.rejects(setNutritionEntryDeleted(f.db, 'alice', ID, false, 1, NOW), NutritionConflictError);
  const restored = await setNutritionEntryDeleted(f.db, 'alice', ID, false, 2, LATER); assert.ok(restored); assert.equal(restored.revision, 3); assert.equal(restored.deletedAt, null); assert.equal(restored.name, first.name); assert.equal(restored.caloriesTenth, null); assert.equal(restored.createdAt, NOW);
});

void test('editing a deleted entry does not implicitly restore it', async (t) => {
  const f = fixture(t); await createNutritionEntry(f.db, 'alice', input(), ID, NOW); await setNutritionEntryDeleted(f.db, 'alice', ID, true, 1, NOW);
  const updated = await replaceNutritionEntry(f.db, 'alice', ID, input({ name: 'corrected deleted meal' }), 2, LATER); assert.ok(updated); assert.equal(updated.deletedAt, NOW); assert.equal(updated.revision, 3);
  assert.equal((await listNutritionEntries(f.db, 'alice', { from: '2026-11-10', to: '2026-11-10' })).length, 0);
});

void test('concurrent updates fail CAS without partially replacing any food fields', async (t) => {
  const f = fixture(t); await createNutritionEntry(f.db, 'alice', input(), ID, NOW);
  f.beforeWrite(() => f.sqlite.prepare('UPDATE nutrition_entries SET name=?,revision=revision+1 WHERE id=?').run('winner', ID));
  await assert.rejects(replaceNutritionEntry(f.db, 'alice', ID, input({ name: 'stale loser', caloriesTenth: 0, date: '2026-11-01' }), 1, LATER), NutritionConflictError);
  const current = await readNutritionEntry(f.db, 'alice', ID); assert.ok(current); assert.equal(current.name, 'winner'); assert.equal(current.caloriesTenth, 1234); assert.equal(current.date, '2026-11-10'); assert.equal(current.revision, 2);
});

void test('owner and date ranges isolate every read and mutation without a hidden record cap', async (t) => {
  const f = fixture(t); await createNutritionEntry(f.db, 'alice', input(), ID, NOW);
  assert.equal(await replaceNutritionEntry(f.db, 'bob', ID, input({ name: 'foreign' }), 1, LATER), null); assert.equal(await setNutritionEntryDeleted(f.db, 'bob', ID, true, 1, LATER), null);
  assert.equal(await replaceNutritionEntry(f.db, 'alice', SECOND, input(), 1, LATER), null);
  const insert = f.sqlite.prepare(`INSERT INTO nutrition_entries (id,user_id,date,meal,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,NULL)`);
  for (let i = 0; i < 125; i++) insert.run('synthetic-' + i, 'alice', '2026-11-09', 'snack', 'snack', '', '', i === 0 ? 0 : null, 'local-fixture', NOW, NOW);
  insert.run('foreign-fixture', 'bob', '2026-11-09', 'snack', 'foreign', '', '', 99, 'local-fixture', NOW, NOW);
  insert.run('older-fixture', 'alice', '2026-11-02', 'snack', 'older', '', '', 99, 'local-fixture', NOW, NOW);
  assert.equal((await listNutritionEntries(f.db, 'alice', { from: '2026-11-09', to: '2026-11-09' })).length, 125);
  assert.equal((await listNutritionEntries(f.db, 'alice', { from: '2026-11-04', to: '2026-11-10' })).length, 126);
  assert.equal((await listNutritionEntries(f.db, 'bob', { from: '2026-11-04', to: '2026-11-10' })).length, 1);
});

void test('batches commit all entries once, reject changed content, and preserve edited entries on replay', async (t) => {
  const f = fixture(t); const items = [input(), input({ meal: 'lunch', caloriesTenth: null })];
  const first = await createNutritionBatch(f.db, 'alice', items, ID, NOW);
  assert.equal(first.replayed, false); assert.equal(first.entries.length, 2); assert.equal(f.count(), 2);
  const changed = await replaceNutritionEntry(f.db, 'alice', first.entries[0].id, input({ name: 'edited' }), 1, LATER);
  const replay = await createNutritionBatch(f.db, 'alice', items, ID, LATER);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.entries[0], changed); assert.equal(f.count(), 2);
  await assert.rejects(createNutritionBatch(f.db, 'alice', [input({ name: 'different' })], ID, NOW), NutritionConflictError);
  assert.equal(f.count(), 2);
  const other = await createNutritionBatch(f.db, 'bob', items, ID, NOW); assert.equal(other.entries.length, 2);
  assert.notEqual(other.entries[0].id, first.entries[0].id);
});

void test('a batch rolls back every food, batch key and day-state write when one entry fails', async (t) => {
  const f = fixture(t);
  f.sqlite.exec("CREATE TRIGGER reject_second_food BEFORE INSERT ON nutrition_entries WHEN NEW.name='reject-me' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const items = [input(), input({ name: 'reject-me' })];
  await assert.rejects(createNutritionBatch(f.db, 'alice', items, ID, NOW));
  assert.equal(f.count(), 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM nutrition_batches').get()?.total, 0);
  assert.equal((await readNutritionDayStatus(f.db, 'alice', '2026-11-10')).revision, 0);
  f.sqlite.exec('DROP TRIGGER reject_second_food');
  assert.equal((await createNutritionBatch(f.db, 'alice', items, ID, NOW)).replayed, false);
  assert.equal(f.count(), 2);
});

void test('meal status is scoped, validates existing foods, and automatically reopens completed dates on changes', async (t) => {
  const f = fixture(t); const selected = '2026-11-10';
  const initial = await readNutritionDayStatus(f.db, 'alice', selected);
  assert.equal(initial.complete, false); assert.equal(initial.revision, 0); assert.equal(initial.meals.breakfast, 'unrecorded');
  await createNutritionEntry(f.db, 'alice', input(), ID, NOW);
  const current = await readNutritionDayStatus(f.db, 'alice', selected);
  assert.equal(current.meals.breakfast, 'recorded'); assert.ok(current.revision > 0);
  const done = await writeNutritionDayStatus(f.db, 'alice', { date: selected, complete: true, meals: { breakfast: 'recorded', lunch: 'skipped', dinner: 'skipped', snack: 'unrecorded' }, expectedRevision: current.revision }, NOW);
  assert.equal(done.complete, true);
  await assert.rejects(writeNutritionDayStatus(f.db, 'alice', { ...done, expectedRevision: current.revision }, NOW), NutritionConflictError);
  await createNutritionEntry(f.db, 'alice', input({ meal: 'lunch' }), SECOND, LATER);
  const changed = await readNutritionDayStatus(f.db, 'alice', selected);
  assert.equal(changed.complete, false); assert.equal(changed.meals.lunch, 'recorded'); assert.ok(changed.revision > done.revision);
  assert.equal((await readNutritionDayStatus(f.db, 'bob', selected)).revision, 0);
  assert.equal((await listNutritionDayStatuses(f.db, 'bob', { from: selected, to: selected })).length, 0);
  await assert.rejects(writeNutritionDayStatus(f.db, 'alice', { ...changed, meals: { ...changed.meals, breakfast: 'skipped' }, expectedRevision: changed.revision }, NOW));
  await replaceNutritionEntry(f.db, 'alice', ID, input({ date: '2026-11-09', meal: 'dinner' }), 1, LATER);
  assert.equal((await readNutritionDayStatus(f.db, 'alice', selected)).meals.breakfast, 'unrecorded');
  assert.equal((await readNutritionDayStatus(f.db, 'alice', '2026-11-09')).meals.dinner, 'recorded');
});

void test('a concurrent food mutation prevents a stale completion mark from succeeding', async (t) => {
  const f = fixture(t); await createNutritionEntry(f.db, 'alice', input(), ID, NOW);
  const current = await readNutritionDayStatus(f.db, 'alice', '2026-11-10');
  f.beforeWrite(() => f.sqlite.prepare('UPDATE nutrition_entries SET note=? WHERE id=?').run('concurrent edit', ID));
  await assert.rejects(writeNutritionDayStatus(f.db, 'alice', { date: current.date, complete: true, meals: { breakfast: 'recorded', lunch: 'skipped', dinner: 'skipped', snack: 'unrecorded' }, expectedRevision: current.revision }, NOW), NutritionConflictError);
  assert.equal((await readNutritionDayStatus(f.db, 'alice', current.date)).complete, false);
});

void test('favorites are deduplicated snapshots scoped to their owner and recent foods exclude deleted records', async (t) => {
  const f = fixture(t); await createNutritionEntry(f.db, 'alice', input(), ID, NOW);
  const saved = await addNutritionFavorite(f.db, 'alice', ID, NOW); assert.ok(saved); assert.equal(saved.calories, '123.4');
  assert.deepEqual(await addNutritionFavorite(f.db, 'alice', ID, LATER), saved);
  assert.equal((await listNutritionFavorites(f.db, 'alice')).length, 1); assert.equal((await listNutritionFavorites(f.db, 'bob')).length, 0);
  assert.equal(await addNutritionFavorite(f.db, 'bob', ID, NOW), null);
  assert.equal(await removeNutritionFavorite(f.db, 'bob', saved.id), false);
  await replaceNutritionEntry(f.db, 'alice', ID, input({ name: 'changed', caloriesTenth: null }), 1, LATER);
  assert.equal((await listNutritionFavorites(f.db, 'alice'))[0].name, 'synthetic oats');
  assert.equal((await recentNutritionFoods(f.db, 'alice', '2026-11-10'))[0].name, 'changed');
  await setNutritionEntryDeleted(f.db, 'alice', ID, true, 2, LATER);
  assert.equal((await recentNutritionFoods(f.db, 'alice', '2026-11-10')).length, 0);
  assert.equal((await listNutritionFavorites(f.db, 'alice')).length, 1);
  assert.equal(await removeNutritionFavorite(f.db, 'alice', saved.id), true);
});

void test('range snapshots cannot combine new food calories with a stale complete-day flag during a concurrent write', async (t) => {
  const f = fixture(t, { file: true });
  await createNutritionEntry(f.db, 'alice', input(), ID, NOW);
  const current = await readNutritionDayStatus(f.db, 'alice', '2026-11-10');
  await writeNutritionDayStatus(f.db, 'alice', { date: current.date, complete: true, meals: { breakfast: 'recorded', lunch: 'skipped', dinner: 'skipped', snack: 'unrecorded' }, expectedRevision: current.revision }, NOW);
  const writer = new DatabaseSync(f.filename);
  try {
    // WAL permits another real connection to commit after the reader's first SELECT.
    f.afterFirstBatchRead(() => writer.prepare('UPDATE nutrition_entries SET calories_tenth=?,note=? WHERE id=?').run(9999, 'concurrent write', ID));
    const snapshot = await readNutritionRangeSnapshot(f.db, 'alice', { from: current.date, to: current.date });
    assert.equal(snapshot.entries[0].caloriesTenth, 1234);
    assert.equal(snapshot.statuses[0].complete, true);
    const latest = await readNutritionRangeSnapshot(f.db, 'alice', { from: current.date, to: current.date });
    assert.equal(latest.entries[0].caloriesTenth, 9999);
    assert.equal(latest.statuses[0].complete, false);
    assert.ok(latest.statuses[0].revision > snapshot.statuses[0].revision);
  } finally { writer.close(); }
});
