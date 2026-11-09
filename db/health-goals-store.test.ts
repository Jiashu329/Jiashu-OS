import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { emptyGoalSettings } from '../lib/health-goals.ts';
import { readGoalSettings, writeGoalSettings } from './health-goals-store.ts';
import type { HealthGoalsDatabase } from './health-goals-store.ts';

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='health_goal_settings'").get(), 'Generate the health goals migration before running persistence tests');
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
      };
      return bound;
    },
  } as unknown as HealthGoalsDatabase;
  return { sqlite, db };
}

const firstTime = '2026-11-09T02:00:00.000Z';
const nextTime = '2026-11-10T02:00:00.000Z';

void test('reading a new user returns unset targets without persisting default values', async (t) => {
  const { db, sqlite } = fixture(t);
  const defaults = await readGoalSettings(db, 'alice');
  assert.deepEqual(defaults, emptyGoalSettings());
  defaults.targets.steps = 1000;
  assert.deepEqual(await readGoalSettings(db, 'bob'), emptyGoalSettings());
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM health_goal_settings').get()!.count, 0);
});

void test('goal replacement persists decimal targets, explicit cancellations and the update timestamp', async (t) => {
  const { db, sqlite } = fixture(t);
  const initial = { steps: 8000, sleep: 7.5, active_energy: 500.25 };
  assert.deepEqual(await writeGoalSettings(db, 'alice', initial, firstTime), { targets: initial, updatedAt: firstTime });
  assert.deepEqual(await readGoalSettings(db, 'alice'), { targets: initial, updatedAt: firstTime });
  const replaced = { steps: 6000, sleep: null, active_energy: null };
  assert.deepEqual(await writeGoalSettings(db, 'alice', replaced, nextTime), { targets: replaced, updatedAt: nextTime });
  assert.deepEqual(await readGoalSettings(db, 'alice'), { targets: replaced, updatedAt: nextTime });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM health_goal_settings').get()!.count, 1);
  await writeGoalSettings(db, 'alice', emptyGoalSettings().targets, nextTime);
  assert.deepEqual(await readGoalSettings(db, 'alice'), { targets: emptyGoalSettings().targets, updatedAt: nextTime });
});

void test('all settings reads and updates remain isolated to the authenticated user', async (t) => {
  const { db } = fixture(t);
  const alice = { steps: 8000, sleep: 8, active_energy: null };
  const bob = { steps: null, sleep: 7, active_energy: 450 };
  await writeGoalSettings(db, 'alice', alice, firstTime);
  await writeGoalSettings(db, 'bob', bob, nextTime);
  assert.deepEqual(await readGoalSettings(db, 'alice'), { targets: alice, updatedAt: firstTime });
  assert.deepEqual(await readGoalSettings(db, 'bob'), { targets: bob, updatedAt: nextTime });
  assert.deepEqual(await readGoalSettings(db, "alice' OR 1=1 --"), emptyGoalSettings());
  await writeGoalSettings(db, 'alice', emptyGoalSettings().targets, nextTime);
  assert.deepEqual(await readGoalSettings(db, 'bob'), { targets: bob, updatedAt: nextTime });
});

void test('a failed replacement leaves all previously saved targets intact', async (t) => {
  const { db, sqlite } = fixture(t);
  const initial = { steps: 8000, sleep: 7.5, active_energy: 500 };
  await writeGoalSettings(db, 'alice', initial, firstTime);
  sqlite.exec("CREATE TRIGGER reject_goal_update BEFORE UPDATE ON health_goal_settings BEGIN SELECT RAISE(ABORT, 'simulated save failure'); END;");
  await assert.rejects(writeGoalSettings(db, 'alice', { steps: 10000, sleep: null, active_energy: 600 }, nextTime), /simulated save failure/);
  assert.deepEqual(await readGoalSettings(db, 'alice'), { targets: initial, updatedAt: firstTime });
});
