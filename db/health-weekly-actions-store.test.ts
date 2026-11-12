import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { readWeeklyAction, readWeeklyActions, writeWeeklyAction, WeeklyActionConflictError } from './health-weekly-actions-store.ts';
import type { WeeklyActionDatabase } from './health-weekly-actions-store.ts';
import { parseWeeklyActionInput, weeklyActionWeek, WeeklyActionValidationError } from '../lib/health-weekly-actions.ts';

const NOW = new Date('2026-11-12T08:00:00Z');
const initial = { weekStart: '2026-11-16', text: '午饭后散步15分钟', status: 'planned' as const, feedback: '', expectedRevision: 0 };
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound = { bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return statement.get(...values) as T ?? null; } };
      return bound;
    },
  } as unknown as WeeklyActionDatabase;
  return { sqlite, db };
}

void test('one action survives retries, feedback revisions and owner/week isolation', async (t) => {
  const { db, sqlite } = fixture(t);
  assert.equal(await readWeeklyAction(db, 'alice', initial.weekStart), null);
  const saved = await writeWeeklyAction(db, 'alice', initial, NOW.toISOString());
  assert.equal(saved.action.revision, 1);
  assert.equal(saved.replayed, false);
  const retry = await writeWeeklyAction(db, 'alice', initial);
  assert.equal(retry.replayed, true);
  assert.equal(retry.action.revision, 1);
  await writeWeeklyAction(db, 'bob', { ...initial, text: 'Bob private' });
  const feedback = { ...initial, expectedRevision: 1, status: 'completed' as const, feedback: '做到了四天' };
  const done = await writeWeeklyAction(db, 'alice', feedback);
  assert.equal(done.action.revision, 2);
  assert.equal((await writeWeeklyAction(db, 'alice', feedback)).replayed, true);
  await assert.rejects(writeWeeklyAction(db, 'alice', { ...initial, expectedRevision: 1, text: 'stale overwrite' }), WeeklyActionConflictError);
  await assert.rejects(writeWeeklyAction(db, 'alice', initial), WeeklyActionConflictError);
  assert.equal((await readWeeklyAction(db, 'bob', initial.weekStart))?.text, 'Bob private');
  assert.equal(await readWeeklyAction(db, "alice' OR 1=1 --", initial.weekStart), null);
  assert.deepEqual((await readWeeklyActions(db, 'alice', ['2026-11-09', initial.weekStart])).map((action) => action?.status ?? null), [null, 'completed']);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM health_weekly_actions').get()?.n, 2);
});

void test('action validation requires a concrete Monday plan and cannot mark a future week complete', () => {
  assert.deepEqual(parseWeeklyActionInput({ ...initial, text: '  饭后散步  ' }, NOW), { ...initial, text: '饭后散步' });
  assert.equal(weeklyActionWeek(undefined, NOW), '2026-11-09');
  assert.equal(weeklyActionWeek('2026-11-12', NOW), '2026-11-09');
  for (const patch of [
    { weekStart: '2026-11-17' }, { weekStart: '2026-11-23' }, { weekStart: '2026-02-30' },
    { weekStart: '' }, { weekStart: '2026-13-01' }, { text: '' }, { text: 'a'.repeat(201) },
    { text: 'first\nsecond' }, { status: 'completed' }, { feedback: 'already done' }, { expectedRevision: -1 },
    { expectedRevision: 1.5 }, { status: 'other' }, { unknown: true },
  ]) assert.throws(() => parseWeeklyActionInput({ ...initial, ...patch }, NOW), WeeklyActionValidationError);
  const current = parseWeeklyActionInput({ ...initial, weekStart: '2026-11-09', status: 'not_completed', feedback: '下雨，下周调整' }, NOW);
  assert.equal(current.status, 'not_completed');
});
