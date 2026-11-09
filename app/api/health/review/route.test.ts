import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { readGoalSettings, writeGoalSettings } from '../../../../db/health-goals-store.ts';
import type { GoalTargets } from '../../../../lib/health-goals.ts';
import { buildHealthSummary, measurementDay, measurementKey, type HealthMeasurement } from '../../../../lib/health.ts';
import { buildBodyComposition } from '../../../../lib/body-composition.ts';
import * as weekly from '../../../../lib/health-weekly.ts';

const NOW = new Date('2026-11-12T08:00:00.000Z');
const ORIGIN = 'https://synthetic-weekly.example';
interface ApiError { code: string; error: string }
async function readReview(response: Response): Promise<weekly.HealthWeeklyReview> { return await response.json() as weekly.HealthWeeklyReview; }
async function readError(response: Response): Promise<ApiError> { return await response.json() as ApiError; }

function loadExports(path: URL, bindings: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
}

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../../../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => /^000[04]_.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  t.after(() => sqlite.close());
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
      };
      return bound;
    },
  } as unknown as D1Database;
  const env: { DB?: D1Database } = { DB: db };
  let userId: string | null = 'alice';
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTUser: async () => userId ? { userId } : null,
  }, ['apiUser', 'json', 'unauthenticated', 'unavailable']);
  const repository = loadExports(new URL('../../../../db/health-repository.ts', import.meta.url), { env, buildHealthSummary, buildBodyComposition }, ['readHealthRange']);
  const route = loadExports(new URL('./route.ts', import.meta.url), {
    ...shared, ...repository, ...weekly, env, readGoalSettings,
    parseHealthWeekQuery: (params: URLSearchParams) => weekly.parseHealthWeekQuery(params, NOW),
    buildHealthWeeklyReview: (...args: Parameters<typeof weekly.buildHealthWeeklyReview>) => weekly.buildHealthWeeklyReview(args[0], args[1], args[2], NOW),
  }, ['GET']) as { GET(request: Request): Promise<Response> };
  function record(owner: string, measurement: HealthMeasurement) {
    sqlite.prepare(`INSERT OR REPLACE INTO health_measurements
      (user_id,record_key,metric,day,measurement_json,exported_at,received_at) VALUES (?,?,?,?,?,?,?)`)
      .run(owner, measurementKey(measurement), measurement.metric, measurementDay(measurement), JSON.stringify(measurement), NOW.toISOString(), NOW.toISOString());
  }
  return {
    env, queries, record,
    signIn(owner: string | null) { userId = owner; },
    setGoals(owner: string, targets: GoalTargets) { return writeGoalSettings(db, owner, targets, NOW.toISOString()); },
    get(query = '') { return route.GET(new Request(ORIGIN + '/api/health/review?' + query)); },
  };
}

function daily(metric: 'steps' | 'sleep' | 'active_energy', day: string, value: number, source = 'synthetic-device'): HealthMeasurement {
  return {
    id: metric + ':' + day, metric, value, source, aggregation: 'daily',
    unit: metric === 'steps' ? 'count' : metric === 'sleep' ? 'hours' : 'kcal',
    startDate: day + 'T00:00:00+08:00', endDate: day + 'T08:00:00+08:00',
  };
}
function weight(id: string, startDate: string, value: number): HealthMeasurement {
  return { id, metric: 'weight', value, unit: 'kg', startDate, source: 'synthetic-scale', aggregation: 'sample' };
}

test('weekly reviews require sign-in and return private no-store responses', async (t) => {
  const f = fixture(t);
  f.signIn(null);
  const response = await f.get();
  assert.equal(response.status, 401);
  assert.equal((await readError(response)).code, 'SIGN_IN_REQUIRED');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.deepEqual(f.queries, []);
});

test('invalid calendar inputs and future weeks fail before reading health records', async (t) => {
  const f = fixture(t);
  for (const week of ['2026-02-30', '2026-11-16', '2026-W46', '2026-1-02', 'invalid', '2026-11-02T00:00:00Z']) {
    const response = await f.get('week=' + encodeURIComponent(week));
    assert.equal(response.status, 400, week);
    assert.equal((await readError(response)).code, 'INVALID_HEALTH_WEEK');
  }
  assert.deepEqual(f.queries, []);
});

test('the partial current week compares equal weekday windows and averages observed days without adding sources', async (t) => {
  const f = fixture(t);
  await f.setGoals('alice', { steps: 8000, sleep: 7.5, active_energy: 500 });
  for (const [day, value] of [['2026-11-09', 0], ['2026-11-10', 8000], ['2026-11-12', 16000], ['2026-11-02', 4000], ['2026-11-03', 6000], ['2026-11-05', 10000], ['2026-11-06', 99999]] as const) f.record('alice', daily('steps', day, value));
  f.record('alice', daily('steps', '2026-11-10', 9000, 'another-selected-source'));
  f.record('alice', daily('active_energy', '2026-11-09', 0));
  const response = await f.get();
  assert.equal(response.status, 200);
  const data = await readReview(response);
  assert.equal(data.weekStart, '2026-11-09');
  assert.equal(data.cutoffDay, '2026-11-12');
  assert.equal(data.previousStart, '2026-11-02');
  assert.equal(data.previousCutoffDay, '2026-11-05');
  assert.equal(data.comparisonDays, 4);
  const steps = data.metrics.find((metric) => metric.metric === 'steps');
  assert.ok(steps);
  assert.equal(steps.currentAverage, 25000 / 3);
  assert.equal(steps.previousAverage, 20000 / 3);
  assert.equal(steps.delta, 25000 / 3 - 20000 / 3);
  assert.equal(steps.currentRecordedDays, 3);
  assert.equal(steps.previousRecordedDays, 3);
  assert.equal(steps.currentAchievedDays, 2);
  assert.equal(steps.previousAchievedDays, 1);
  assert.deepEqual(steps.currentPoints.map((point) => point.value), [0, 9000, null, 16000]);
  const energy = data.metrics.find((metric) => metric.metric === 'active_energy');
  assert.ok(energy);
  assert.equal(energy.currentAverage, 0);
  assert.equal(energy.previousAverage, null);
  assert.equal(energy.delta, null);
  assert.equal(energy.currentRecordedDays, 1);
});

test('weight uses the last sample of each recorded day and sleep follows its ending date', async (t) => {
  const f = fixture(t);
  f.record('alice', weight('morning', '2026-11-09T07:00:00+08:00', 70));
  f.record('alice', weight('evening', '2026-11-09T20:00:00+08:00', 71));
  f.record('alice', weight('next-day', '2026-11-10T07:00:00+08:00', 69));
  f.record('alice', weight('prior-week', '2026-11-02T07:00:00+08:00', 72));
  f.record('alice', weight('future-same-day', '2026-11-12T23:00:00+08:00', 99));
  f.record('alice', weight('future-day', '2026-11-13T07:00:00+08:00', 98));
  f.record('alice', { ...daily('sleep', '2026-11-09', 8), startDate: '2026-11-08T23:00:00+08:00', endDate: '2026-11-09T07:00:00+08:00' });
  f.record('alice', daily('sleep', '2026-11-02', 7));
  const data = await readReview(await f.get());
  const mass = data.metrics.find((metric) => metric.metric === 'weight');
  assert.ok(mass);
  assert.equal(mass.currentAverage, 70);
  assert.equal(mass.previousAverage, 72);
  assert.equal(mass.delta, -2);
  assert.equal(mass.currentRecordedDays, 2);
  assert.deepEqual(mass.currentPoints.map((point) => point.value), [71, 69, null, null]);
  assert.equal(mass.currentAchievedDays, null);
  const sleep = data.metrics.find((metric) => metric.metric === 'sleep');
  assert.ok(sleep);
  assert.equal(sleep.currentPoints[0].value, 8);
  assert.equal(sleep.delta, 1);
});

test('a date within a historical week normalizes to Monday and includes both full Sundays', async (t) => {
  const f = fixture(t);
  f.record('alice', daily('steps', '2026-11-01', 7000));
  f.record('alice', daily('steps', '2026-10-25', 5000));
  const data = await readReview(await f.get('week=2026-10-28'));
  assert.equal(data.weekStart, '2026-10-26');
  assert.equal(data.weekEnd, '2026-11-01');
  assert.equal(data.cutoffDay, '2026-11-01');
  assert.equal(data.previousCutoffDay, '2026-10-25');
  assert.equal(data.comparisonDays, 7);
  assert.equal(data.isCurrent, false);
  const steps = data.metrics[0];
  assert.equal(steps.currentPoints.length, 7);
  assert.equal(steps.currentPoints.at(-1)?.value, 7000);
  assert.equal(steps.previousPoints.at(-1)?.value, 5000);
  assert.equal(steps.delta, 2000);
});

test('weekly health records and goals remain scoped to the signed-in user', async (t) => {
  const f = fixture(t);
  await f.setGoals('alice', { steps: 2000, sleep: null, active_energy: null });
  await f.setGoals('bob', { steps: 100, sleep: null, active_energy: null });
  f.record('alice', daily('steps', '2026-11-09', 1000, 'alice-private-device'));
  f.record('bob', daily('steps', '2026-11-09', 500, 'bob-private-device'));
  const alice = await readReview(await f.get('userId=bob'));
  assert.equal(alice.metrics[0].currentAverage, 1000);
  assert.equal(alice.metrics[0].target, 2000);
  assert.equal(alice.metrics[0].currentAchievedDays, 0);
  assert.ok(!JSON.stringify(alice).includes('private-device'));
  f.signIn('bob');
  const bob = await readReview(await f.get());
  assert.equal(bob.metrics[0].currentAverage, 500);
  assert.equal(bob.metrics[0].target, 100);
  assert.equal(bob.metrics[0].currentAchievedDays, 1);
});

test('an empty review keeps unrecorded days and unset goals empty', async (t) => {
  const f = fixture(t);
  const data = await readReview(await f.get());
  assert.equal(data.metrics.length, 4);
  for (const metric of data.metrics) {
    assert.equal(metric.currentAverage, null);
    assert.equal(metric.previousAverage, null);
    assert.equal(metric.delta, null);
    assert.equal(metric.currentRecordedDays, 0);
    assert.equal(metric.previousRecordedDays, 0);
    assert.equal(metric.currentAchievedDays, null);
    assert.ok(metric.currentPoints.every((point) => point.value === null));
  }
});

test('unavailable storage returns an error rather than an empty health review', async (t) => {
  const f = fixture(t);
  delete f.env.DB;
  const response = await f.get();
  assert.equal(response.status, 503);
  assert.equal((await readError(response)).code, 'HEALTH_STORAGE_UNAVAILABLE');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
