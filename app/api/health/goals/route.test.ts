import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { HealthGoalConflictError, readGoalSettings, writeGoalSettings, type HealthGoalsDatabase } from '../../../../db/health-goals-store.ts';
import { buildGoalProgress, GoalValidationError, parseGoalUpdateInput, parseGoalSettingsInput, type GoalSettings, type GoalProgress } from '../../../../lib/health-goals.ts';
import { buildHealthSummary, type HealthMeasurement } from '../../../../lib/health.ts';

type Handler = (...args: Request[]) => Promise<Response>;
const ORIGIN = 'https://synthetic-goals.example';
const targets = { steps: 8000, sleep: 7.5, active_energy: 500 };

interface ErrorResponse { error: string; code: string }
async function readSettings(response: Response): Promise<GoalSettings> {
  return await response.json() as GoalSettings;
}
async function readProgress(response: Response): Promise<GoalProgress> {
  return await response.json() as GoalProgress;
}
async function readError(response: Response): Promise<ErrorResponse> {
  return await response.json() as ErrorResponse;
}

// Worker globals and next/headers are supplied at the route boundary. The
// actual route, shared responses, validation, SQL and progress logic still run.
function loadHandlers(path: URL, bindings: Record<string, unknown>, exports: string[]): Record<string, Handler> {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + exports.join(',') + '};')(...Object.values(bindings));
}

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../../../drizzle/', import.meta.url);
  for(const migration of readdirSync(migrations).filter((name)=>/^\d+.*\.sql$/.test(name)).sort())sqlite.exec(readFileSync(new URL(migration,migrations),'utf8'));
  t.after(()=>sqlite.close());
  interface Statement {bind(...parameters:unknown[]):Statement;execute():{results:unknown[];meta:{changes:number}}}
  const db={prepare(sql:string){const prepared=sqlite.prepare(sql);let values:SQLInputValue[]=[];const bound:Statement={bind(...p){values=p as SQLInputValue[];return bound;},execute(){const before=Number(sqlite.prepare('SELECT total_changes() n').get()?.n);const results=prepared.columns().length?prepared.all(...values):(prepared.run(...values),[]);return{results,meta:{changes:Number(sqlite.prepare('SELECT total_changes() n').get()?.n)-before}};}};return bound;},async batch(commands:Statement[]){sqlite.exec('BEGIN');try{const result=commands.map((c)=>c.execute());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}}as unknown as HealthGoalsDatabase;
  let userId: string | null = 'alice';
  const env: { DB?: HealthGoalsDatabase } = { DB: db };
  const shared = loadHandlers(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => userId ? { userId } : null,
  }, ['apiUser', 'json', 'unauthenticated', 'unavailable', 'isSameOrigin', 'invalidOrigin']);
  const route = loadHandlers(new URL('./route.ts', import.meta.url), {
    ...shared, env, readGoalSettings, writeGoalSettings, HealthGoalConflictError, GoalValidationError, parseGoalUpdateInput, parseGoalSettingsInput,
  }, ['GET', 'PUT']);
  const reads: { userId: string; days: number }[] = [];
  const measurements = new Map<string, HealthMeasurement[]>();
  const progress = loadHandlers(new URL('./progress/route.ts', import.meta.url), {
    ...shared, env, readGoalSettings, buildGoalProgress,
    readHealth: async (owner: string, days: number) => {
      reads.push({ userId: owner, days });
      return { summary: buildHealthSummary(measurements.get(owner) ?? []) };
    },
  }, ['GET']);
  return { sqlite, db, env, route, progress, reads, measurements, signIn(owner: string | null) { userId = owner; } };
}

function request(body: unknown = { targets }, options: { origin?: string | null; contentType?: string; raw?: boolean; length?: string } = {}) {
  const headers = new Headers({ 'Content-Type': options.contentType ?? 'application/json' });
  if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
  if (options.length) headers.set('Content-Length', options.length);
  return new Request(ORIGIN + '/api/health/goals', {
    method: 'PUT', headers, body: options.raw ? String(body) : JSON.stringify(body&&typeof body==='object'&&!Array.isArray(body)?{expectedRevision:0,effectiveFrom:'2026-01-01',...body}:body),
  });
}

test('goal endpoints require sign-in and never create a row for anonymous requests', async (t) => {
  const f = fixture(t);
  f.signIn(null);
  for (const response of [await f.route.GET(), await f.route.PUT(request()), await f.progress.GET()]) {
    assert.equal(response.status, 401);
    assert.equal((await readError(response)).code, 'SIGN_IN_REQUIRED');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM health_goal_settings').get()?.count, 0);
  assert.deepEqual(f.reads, []);
});

test('a saved goal survives a new read while another signed-in owner remains isolated', async (t) => {
  const f = fixture(t);
  const saved = await f.route.PUT(request());
  assert.equal(saved.status, 200);
  const settings = await readSettings(saved);
  assert.deepEqual(settings.targets, targets);
  assert.ok(settings.updatedAt !== null);
  assert.ok(Number.isFinite(Date.parse(settings.updatedAt)));
  assert.deepEqual(await readSettings(await f.route.GET()), settings);
  f.signIn('bob');
  assert.deepEqual(await readSettings(await f.route.GET()), {
    targets: { steps: null, sleep: null, active_energy: null }, updatedAt: null,revision:0,effectiveFrom:null,history:[],
  });
  await f.route.PUT(request({ targets: { steps: 5000, sleep: null, active_energy: null } }));
  f.signIn('alice');
  assert.deepEqual((await readSettings(await f.route.GET())).targets, targets);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM health_goal_settings').get()?.count, 2);
});

test('cross-origin and missing-origin goal submissions are rejected before persistence', async (t) => {
  const f = fixture(t);
  for (const origin of [null, 'https://other.example', ORIGIN + '.other.example']) {
    const response = await f.route.PUT(request({ targets }, { origin }));
    assert.equal(response.status, 403);
    assert.equal((await readError(response)).code, 'INVALID_ORIGIN');
  }
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM health_goal_settings').get()?.count, 0);
});

test('bad goal values, incomplete replacements and attempts to choose another owner leave settings unchanged', async (t) => {
  const f = fixture(t);
  await f.route.PUT(request());
  for (const body of [
    { targets: { ...targets, steps: 0 } },
    { targets: { ...targets, steps: 8000.5 } },
    { targets: { ...targets, steps: 200001 } },
    { targets: { ...targets, sleep: 24.01 } },
    { targets: { ...targets, active_energy: -1 } },
    { targets: { ...targets, active_energy: 20001 } },
    { targets: { ...targets, sleep: '8' } },
    { targets: { steps: 1000 } },
    { targets: { ...targets, weight: 60 } },
    { targets, userId: 'bob' },
    { targets: [] },
  ]) {
    const response = await f.route.PUT(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await readError(response)).code, 'INVALID_HEALTH_GOALS');
  }
  const nonfinite = await f.route.PUT(request('{"targets":{"steps":8000,"sleep":1e309,"active_energy":500}}', { raw: true }));
  assert.equal(nonfinite.status, 400);
  assert.deepEqual((await readSettings(await f.route.GET())).targets, targets);
});

test('malformed JSON, wrong media type and oversized UTF-8 bodies return clear errors without writes', async (t) => {
  const f = fixture(t);
  assert.equal((await f.route.PUT(request('{', { raw: true }))).status, 400);
  assert.equal((await f.route.PUT(request({ targets }, { contentType: 'text/plain' }))).status, 415);
  for (const oversized of [
    request({ targets }, { length: '2049' }),
    request(' '.repeat(2050), { raw: true }),
    request('中'.repeat(700), { raw: true, length: '1' }),
  ]) {
    const response = await f.route.PUT(oversized);
    assert.equal(response.status, 413);
    assert.equal((await readError(response)).code, 'HEALTH_GOALS_TOO_LARGE');
  }
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM health_goal_settings').get()?.count, 0);
});

test('clearing all goals is persisted as an intentional cancellation', async (t) => {
  const f = fixture(t);
  await f.route.PUT(request());
  const cleared = { steps: null, sleep: null, active_energy: null };
  const response = await f.route.PUT(request({ targets: cleared,expectedRevision:1 }));
  assert.equal(response.status, 200);
  assert.deepEqual((await readSettings(response)).targets, cleared);
  assert.deepEqual((await readSettings(await f.route.GET())).targets, cleared);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM health_goal_settings').get()?.count, 1);
});

test('progress reads only its signed-in owner and distinguishes missing days from observed zero', async (t) => {
  const f = fixture(t);
  await f.route.PUT(request());
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  f.measurements.set('alice', [{
    id: 'synthetic-zero', metric: 'steps', value: 0, unit: 'count', aggregation: 'daily',
    source: 'synthetic-source', startDate: today + 'T00:00:00+08:00', endDate: today + 'T23:59:00+08:00',
  }]);
  const response = await f.progress.GET();
  assert.equal(response.status, 200);
  const data = await readProgress(response);
  assert.deepEqual(f.reads, [{ userId: 'alice', days: 30 }]);
  assert.equal(data.timezone, 'Asia/Shanghai');
  assert.equal(data.metrics[0].days.length, 30);
  assert.equal(data.metrics[0].current.value, 0);
  assert.equal(data.metrics[0].current.status, 'in-progress');
  assert.equal(data.metrics[0].recordedDays, 1);
  const previous = data.metrics[0].days.at(-2);
  assert.ok(previous);
  assert.equal(previous.value, null);
  assert.equal(previous.status, 'missing');
  f.signIn('bob');
  const other = await readProgress(await f.progress.GET());
  assert.equal(other.metrics[0].current.value, null);
  assert.equal(other.metrics[0].current.status, 'unset');
  assert.deepEqual(f.reads.at(-1), { userId: 'bob', days: 30 });
});

test('unavailable goal storage returns failure instead of inventing empty settings or progress', async (t) => {
  const f = fixture(t);
  delete f.env.DB;
  for (const response of [await f.route.GET(), await f.route.PUT(request()), await f.progress.GET()]) {
    assert.equal(response.status, 503);
    assert.equal((await readError(response)).code, 'HEALTH_STORAGE_UNAVAILABLE');
  }
});

test('stale goal revisions return 409 without replacing the new goals or appending history',async(t)=>{const f=fixture(t);assert.equal((await f.route.PUT(request())).status,200);const response=await f.route.PUT(request({targets:{...targets,steps:10000},expectedRevision:0}));assert.equal(response.status,409);assert.equal((await readError(response)).code,'HEALTH_GOAL_CONFLICT');assert.deepEqual((await readSettings(await f.route.GET())).targets,targets);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM health_goal_versions').get()?.n,2);});
