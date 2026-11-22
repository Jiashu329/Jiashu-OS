import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { readGoalSettings, writeGoalSettings } from '../../../../db/health-goals-store.ts';
import type { GoalTargets } from '../../../../lib/health-goals.ts';
import { buildHealthSummary, measurementDay, measurementKey, type HealthMeasurement } from '../../../../lib/health.ts';
import { buildBodyComposition } from '../../../../lib/body-composition.ts';
import * as weekly from '../../../../lib/health-weekly.ts';
import { buildHealthWeeklyFocus, type HealthWeeklyFocus } from '../../../../lib/health-weekly-focus.ts';
import * as recordsStore from '../../../../db/health-records-store.ts';
import { readWeightPlanSettings, writeWeightPlanSettings } from '../../../../db/weight-plan-store.ts';
import { listNutritionEntries } from '../../../../db/nutrition-store.ts';
import { readWeeklyActions, writeWeeklyAction } from '../../../../db/health-weekly-actions-store.ts';
import { shiftWeekDay } from '../../../../lib/health-weekly-actions.ts';
import { readWithDeadline } from '../../../../lib/read-deadline.ts';
import { readAppleActivityDaily } from '../../../../db/apple-health-activity-store.ts';
import { buildWeeklyAppleActivity, type WeeklyAppleActivity } from '../../../../lib/apple-activity-supplements.ts';

const NOW = new Date('2026-11-12T08:00:00.000Z');
const ORIGIN = 'https://synthetic-weekly.example';
interface ApiError { code: string; error: string }
type WeeklyResponse = weekly.HealthWeeklyReview & { focus: HealthWeeklyFocus; appleActivity: WeeklyAppleActivity };
async function readReview(response: Response): Promise<WeeklyResponse> { return await response.json() as WeeklyResponse; }
async function readError(response: Response): Promise<ApiError> { return await response.json() as ApiError; }

function loadExports(path: URL, bindings: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn {' + names.join(',') + '};', Object.keys(bindings))(...Object.values(bindings));
}

function fixture(t: TestContext, now = NOW) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../../../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
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
        execute(){const before=Number(sqlite.prepare('SELECT total_changes() n').get()?.n);const results=statement.columns().length?statement.all(...values):(statement.run(...values),[]);return{results,meta:{changes:Number(sqlite.prepare('SELECT total_changes() n').get()?.n)-before}};},
      };
      return bound;
    },
    async batch(commands:Array<{execute():unknown}>){sqlite.exec('BEGIN');try{const result=commands.map((c)=>c.execute());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}},
  } as unknown as D1Database;
  const env: { DB?: D1Database } = { DB: db };
  let userId: string | null = 'alice';
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => userId ? { userId } : null,
  }, ['apiUser', 'json', 'unauthenticated', 'unavailable']);
  const repository = loadExports(new URL('../../../../db/health-repository.ts', import.meta.url), { ...recordsStore, env, buildHealthSummary, buildBodyComposition }, ['readHealthRange']);
  const route = loadExports(new URL('./route.ts', import.meta.url), {
    ...shared, ...repository, ...weekly, env, buildHealthWeeklyFocus, readGoalSettings, readWeightPlanSettings, listNutritionEntries, readWeeklyActions, shiftWeekDay, readWithDeadline,
    readAppleActivityDaily, buildWeeklyAppleActivity,
    parseHealthWeekQuery: (params: URLSearchParams) => weekly.parseHealthWeekQuery(params, now),
    buildHealthWeeklyReview: (...args: Parameters<typeof weekly.buildHealthWeeklyReview>) => weekly.buildHealthWeeklyReview(args[0], args[1], args[2], now, args[4]),
  }, ['GET']) as { GET(request: Request): Promise<Response> };
  function record(owner: string, measurement: HealthMeasurement) {
    sqlite.prepare(`INSERT OR REPLACE INTO health_measurements
      (user_id,record_key,metric,day,measurement_json,exported_at,received_at) VALUES (?,?,?,?,?,?,?)`)
      .run(owner, measurementKey(measurement), measurement.metric, measurementDay(measurement), JSON.stringify(measurement), NOW.toISOString(), NOW.toISOString());
  }
  return {
    env, queries, record, sqlite, db,
    signIn(owner: string | null) { userId = owner; },
    setGoals(owner: string, targets: GoalTargets) { return readGoalSettings(db,owner).then((settings)=>writeGoalSettings(db,owner,targets,settings.revision??0,'1970-01-02',NOW.toISOString())); },
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

void test('weekly reviews require sign-in and return private no-store responses', async (t) => {
  const f = fixture(t);
  f.signIn(null);
  const response = await f.get();
  assert.equal(response.status, 401);
  assert.equal((await readError(response)).code, 'SIGN_IN_REQUIRED');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.deepEqual(f.queries, []);
});

void test('invalid calendar inputs and future weeks fail before reading health records', async (t) => {
  const f = fixture(t);
  for (const week of ['2026-02-30', '2026-11-16', '2026-W46', '2026-1-02', 'invalid', '2026-11-02T00:00:00Z']) {
    const response = await f.get('week=' + encodeURIComponent(week));
    assert.equal(response.status, 400, week);
    assert.equal((await readError(response)).code, 'INVALID_HEALTH_WEEK');
  }
  assert.deepEqual(f.queries, []);
});

void test('the partial current week compares equal weekday windows and averages observed days without adding sources', async (t) => {
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

void test('weight uses the last sample of each recorded day and sleep follows its ending date', async (t) => {
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

void test('a date within a historical week normalizes to Monday and includes both full Sundays', async (t) => {
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

void test('weekly health records and goals remain scoped to the signed-in user', async (t) => {
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

void test('an empty review keeps unrecorded days and unset goals empty', async (t) => {
  const f = fixture(t);
  const data = await readReview(await f.get());
  assert.equal(data.metrics.length, 4);
  assert.ok(data.focus.headline);
  assert.ok(data.focus.summary);
  assert.ok((data.focus.primary ? 1 : 0) + data.focus.secondary.length <= 3);
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

void test('Apple weekly records compare completed weekdays, separate today, and stay scoped to the owner', async t => {
  const f = fixture(t);
  const vital = f.sqlite.prepare('INSERT INTO health_apple_vitals(user_id, day, metric, value_json, exported_at, received_at) VALUES (?,?,?,?,?,?)');
  const workout = f.sqlite.prepare('INSERT INTO health_apple_workouts(user_id, workout_id, day, start_date, workout_json, exported_at, received_at) VALUES (?,?,?,?,?,?,?)');
  const asOf = NOW.toISOString();
  for (const [owner, day, value, count] of [
    ['alice', '2026-11-09', 70, 3], ['alice', '2026-11-11', 78, 2], ['alice', '2026-11-12', 90, 5],
    ['alice', '2026-11-04', 72, 4], ['alice', '2026-11-05', 84, 2], ['alice', '2026-11-08', 120, 7],
    ['bob', '2026-11-10', 100, 20],
  ] as const) {
    vital.run(owner, day, 'heartRate', JSON.stringify({ average: value, min: value - 5, max: value + 5 }), asOf, asOf);
    vital.run(owner, day, 'oxygenSaturation', JSON.stringify({ latest: 97, average: 96, min: 95, max: 97, count, measuredAt: day + 'T01:00:00.000Z' }), asOf, asOf);
    if (day === '2026-11-11') vital.run(owner, day, 'restingHeartRate', JSON.stringify({ value: 57, measuredAt: day + 'T02:00:00.000Z' }), asOf, asOf);
    workout.run(owner, day, day, day + 'T01:00:00.000Z', JSON.stringify({ durationSeconds: count * 300, energyKcal: 2000 }), asOf, asOf);
  }
  workout.run('alice', 'second', '2026-11-09', '2026-11-09T02:00:00.000Z', JSON.stringify({ durationSeconds: 105, energyKcal: 300 }), asOf, asOf);
  const { appleActivity } = await readReview(await f.get('userId=bob'));
  assert.deepEqual(appleActivity, {
    status: 'ready',
    current: { from: '2026-11-09', to: '2026-11-11', heartRate: { average: 74, days: 2 }, restingHeartRate: { average: 57, days: 1 },
      oxygenSaturation: { days: 2, samples: 5 }, workouts: { count: 3, durationSeconds: 1605 } },
    previous: { from: '2026-11-02', to: '2026-11-04', heartRate: { average: 72, days: 1 }, restingHeartRate: null,
      oxygenSaturation: { days: 1, samples: 4 }, workouts: { count: 1, durationSeconds: 1200 } },
    today: { from: '2026-11-12', to: '2026-11-12', heartRate: { average: 90, days: 1 }, restingHeartRate: null,
      oxygenSaturation: { days: 1, samples: 5 }, workouts: { count: 1, durationSeconds: 1500 } },
  });
  const historical = (await readReview(await f.get('week=2026-11-05'))).appleActivity;
  assert.equal(historical.status, 'ready');
  assert.equal(historical.current?.to, '2026-11-08');
  assert.equal(historical.current?.heartRate?.days, 3);
  assert.equal(historical.previous?.to, '2026-11-01');
  assert.equal(historical.today, null);
});

void test('Apple weekly status distinguishes Monday without completed days from a failed read', async t => {
  // Monday in Beijing while it is still Sunday in UTC.
  const f = fixture(t, new Date('2026-11-08T17:00:00.000Z'));
  const empty = await readReview(await f.get());
  assert.deepEqual(empty.appleActivity, { status: 'ready', current: null, previous: null,
    today: { from: '2026-11-09', to: '2026-11-09', heartRate: null, restingHeartRate: null, oxygenSaturation: null, workouts: null } });
  f.sqlite.exec('DROP TABLE health_apple_vitals');
  const response = await f.get();
  assert.equal(response.status, 200);
  const failed = await readReview(response);
  assert.deepEqual(failed.appleActivity, { status: 'unavailable' });
  assert.deepEqual(failed.metrics, empty.metrics);
  assert.deepEqual(failed.focus, empty.focus);
});

void test('weekly priorities explain only the signed-in user’s completed-day evidence without saving an action', async (t) => {
  const f = fixture(t);
  await f.setGoals('alice', { steps: null, sleep: 7, active_energy: null });
  await f.setGoals('bob', { steps: null, sleep: 7, active_energy: null });
  for (const day of ['2026-11-09', '2026-11-10', '2026-11-11']) {
    f.record('alice', daily('sleep', day, 5.5, 'alice-private-source'));
    f.record('bob', daily('sleep', day, 8, 'bob-private-source'));
  }
  f.record('alice', daily('sleep', '2026-11-12', 0, 'unfinished-today'));
  const alice = await readReview(await f.get('userId=bob'));
  assert.equal(alice.focus.primary?.metric, 'sleep');
  assert.equal(alice.focus.primary?.kind, 'attention');
  assert.match(alice.focus.primary?.evidence ?? '', /5\.5/);
  assert.ok(alice.focus.suggestedAction?.text);
  assert.deepEqual(alice.actions, { previous: null, current: null, next: null }, 'reading priorities must not persist suggested actions');
  assert.equal(JSON.stringify(alice.focus).includes('private-source'), false);
  assert.equal(JSON.stringify(alice.focus).includes('unfinished-today'), false);
  f.signIn('bob');
  const bob = await readReview(await f.get());
  assert.notDeepEqual(bob.focus, alice.focus);
  assert.deepEqual(bob.actions, { previous: null, current: null, next: null });
  assert.ok([bob.focus.primary, ...bob.focus.secondary].filter(Boolean).every(item => {
    const url = new URL(item!.href, ORIGIN);
    return url.origin === ORIGIN && ['/health', '/health/nutrition', '/sync'].includes(url.pathname);
  }));
});

void test('unavailable storage returns an error rather than an empty health review', async (t) => {
  const f = fixture(t);
  delete f.env.DB;
  const response = await f.get();
  assert.equal(response.status, 503);
  assert.equal((await readError(response)).code, 'HEALTH_STORAGE_UNAVAILABLE');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});


void test('reviews combine same-period nutrition, cutoff-only weight progress, and owner-scoped actions', async (t) => {
  const f = fixture(t);
  for (const [owner,id,date,calories,deleted] of [
    ['alice','food-a','2026-11-09',1000,null], ['alice','food-b','2026-11-09',null,null],
    ['alice','food-c','2026-11-12',0,null], ['alice','food-d','2026-11-02',2000,null],
    ['alice','outside','2026-11-06',9999,null], ['alice','deleted','2026-11-10',9999,NOW.toISOString()],
    ['bob','private','2026-11-09',88888,null],
  ] as const) f.sqlite.prepare(`INSERT INTO nutrition_entries
    (id,user_id,date,meal,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at)
    VALUES (?,?,?,'lunch','synthetic','','',?,'hash',1,?,?,?)`).run(id,owner,date,calories,NOW.toISOString(),NOW.toISOString(),deleted);
  await writeWeightPlanSettings(f.db,'alice',{baselineWeight:80,targetWeight:70,startDate:'2026-10-01',deadline:'2026-12-01',enabled:true},0);
  f.record('alice',weight('old-weight','2026-11-01T08:00:00+08:00',78));
  f.record('alice',weight('later-weight','2026-11-09T08:00:00+08:00',70));
  await writeWeeklyAction(f.db,'alice',{weekStart:'2026-11-09',text:'午饭后散步',status:'planned',feedback:'',expectedRevision:0});
  await writeWeeklyAction(f.db,'alice',{weekStart:'2026-11-16',text:'按时睡觉',status:'planned',feedback:'',expectedRevision:0});
  await writeWeeklyAction(f.db,'bob',{weekStart:'2026-11-09',text:'bob private action',status:'planned',feedback:'',expectedRevision:0});
  const current=await readReview(await f.get());
  assert.equal(current.nutrition.current.recordedDays,2);
  assert.equal(current.nutrition.current.knownCalories,'100.0');
  assert.equal(current.nutrition.current.unknownCount,1);
  assert.equal(current.nutrition.previous.knownCalories,'200.0');
  assert.equal(current.nutrition.previous.points.length,4);
  assert.equal(current.actions.current?.text,'午饭后散步');
  assert.equal(current.actions.next?.weekStart,'2026-11-16');
  assert.ok(!JSON.stringify(current).includes('bob private'));
  const history=await readReview(await f.get('week=2026-10-28'));
  assert.equal(history.weightPlan.asOfDay,'2026-11-01');
  assert.equal(history.weightPlan.review.observations.average7,78);
  assert.equal(history.weightPlan.review.progress?.progressPercent,20);
  assert.equal(history.weightPlan.usesCurrentSettings,true);
});


void test('optional action storage failure preserves metrics and never looks like an empty saved plan', async(t)=>{
  const f=fixture(t);f.record('alice',daily('steps','2026-11-09',1234));
  f.sqlite.exec('DROP TABLE health_weekly_actions');
  const response=await f.get();assert.equal(response.status,200);
  const data=await readReview(response);assert.equal(data.metrics[0].currentAverage,1234);
  assert.equal(data.supplementalStatus.actions,'unavailable');assert.equal(data.supplementalStatus.nutrition,'ready');
});
