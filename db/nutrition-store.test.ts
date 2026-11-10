import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { NutritionInput } from '../lib/nutrition.ts';
import { createNutritionEntry, listNutritionEntries, NutritionConflictError, readNutritionEntry,
  replaceNutritionEntry, setNutritionEntryDeleted } from './nutrition-store.ts';

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
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
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
      try { const results = commands.map((command) => command.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { db, sqlite,
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
