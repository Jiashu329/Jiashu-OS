import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { readWeightPlanSettings, writeWeightPlanSettings } from './weight-plan-store.ts';
import type { WeightPlanDatabase } from './weight-plan-store.ts';
import type { WeightPlanInput } from '../lib/weight-plan.ts';

const NOW = '2026-11-09T00:00:00Z';
const LATER = '2026-11-10T00:00:00Z';
const initial: WeightPlanInput = { baselineWeight: 80.25, targetWeight: 70.5, startDate: '2026-11-01', deadline: '2027-01-01', enabled: true };
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
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
  } as unknown as WeightPlanDatabase;
  return { sqlite, db };
}

void test('reading a new owner returns no plan and persists no inferred default values', async (t) => {
  const { sqlite, db } = fixture(t);
  assert.equal(await readWeightPlanSettings(db, 'alice'), null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM health_weight_plan_settings').get()!.total, 0);
});

void test('complete replacement stores fractional weights, keeps creation time and preserves disabled settings for re-enabling', async (t) => {
  const { sqlite, db } = fixture(t);
  assert.deepEqual(await writeWeightPlanSettings(db, 'alice', initial, NOW), { ...initial, createdAt: NOW, updatedAt: NOW });
  const replaced = { ...initial, baselineWeight: 60.75, targetWeight: 65.25, enabled: false };
  assert.deepEqual(await writeWeightPlanSettings(db, 'alice', replaced, LATER), { ...replaced, createdAt: NOW, updatedAt: LATER });
  assert.deepEqual(await readWeightPlanSettings(db, 'alice'), { ...replaced, createdAt: NOW, updatedAt: LATER });
  const resumed = await writeWeightPlanSettings(db, 'alice', { ...replaced, enabled: true }, LATER);
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.targetWeight, 65.25);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM health_weight_plan_settings').get()!.total, 1);
});

void test('each owner keeps an independent plan and bound lookups cannot escape the owner filter', async (t) => {
  const { db } = fixture(t);
  await writeWeightPlanSettings(db, 'alice', initial, NOW);
  await writeWeightPlanSettings(db, 'bob', { ...initial, baselineWeight: 60, targetWeight: 60 }, NOW);
  await writeWeightPlanSettings(db, 'alice', { ...initial, enabled: false }, LATER);
  assert.equal((await readWeightPlanSettings(db, 'bob'))!.enabled, true);
  assert.equal((await readWeightPlanSettings(db, 'bob'))!.targetWeight, 60);
  assert.equal(await readWeightPlanSettings(db, "alice' OR 1=1 --"), null);
});

void test('a failed complete replacement leaves the previous plan intact', async (t) => {
  const { sqlite, db } = fixture(t);
  const saved = await writeWeightPlanSettings(db, 'alice', initial, NOW);
  sqlite.exec("CREATE TRIGGER reject_weight_plan BEFORE UPDATE ON health_weight_plan_settings BEGIN SELECT RAISE(ABORT, 'simulated replacement failure'); END;");
  await assert.rejects(writeWeightPlanSettings(db, 'alice', { ...initial, enabled: false }, LATER), /simulated replacement failure/);
  assert.deepEqual(await readWeightPlanSettings(db, 'alice'), saved);
});
