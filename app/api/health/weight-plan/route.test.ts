import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import * as health from '../../../../lib/health.ts';
import * as composition from '../../../../lib/body-composition.ts';
import * as recordStore from '../../../../db/health-records-store.ts';
import * as importStore from '../../../../db/health-import-store.ts';
import * as planRules from '../../../../lib/weight-plan.ts';
import * as planStore from '../../../../db/weight-plan-store.ts';
import * as cycleStore from '../../../../db/weight-cycles-store.ts';
import * as cycleRules from '../../../../lib/weight-cycles.ts';

const ORIGIN = 'https://synthetic-weight-plan.example';
const NOW = new Date();
const TODAY = health.shanghaiDay(NOW.toISOString());
const shift = (days: number) => new Date(Date.parse(TODAY + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const FIRST_EXPORT = new Date(NOW.getTime() - 10000).toISOString();
type PlanResponse = ReturnType<typeof planRules.buildWeightPlanReview>;
interface ApiError { code: string; error: string }
async function readPlan(response: Response): Promise<PlanResponse> { return await response.json() as PlanResponse; }
async function readError(response: Response): Promise<ApiError> { return await response.json() as ApiError; }
function loadExports(path: URL, bindings: Record<string, unknown>, names?: string[]): Record<string, unknown> {
  const original = readFileSync(path, 'utf8');
  const exported = names ?? [...original.matchAll(/^export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/gm)].map((match) => match[1]);
  const source = stripTypeScriptTypes(original, { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + exported.join(',') + '};')(...Object.values(bindings));
}
interface LocalStatement {
  bind(...values: unknown[]): LocalStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: unknown[]; meta: { changes: number } }>;
  execute(): { results: unknown[]; meta: { changes: number } };
}
async function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../../../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  t.after(() => sqlite.close());
  const queries: string[] = [];
  const adapter = {
    prepare(sql: string) {
      queries.push(sql); const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound: LocalStatement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (bound.execute().results[0] as T | undefined) ?? null; },
        async all<T>() { return { results: bound.execute().results as T[] }; },
        async run() { return bound.execute(); },
        execute() {
          const before = Number(sqlite.prepare('SELECT total_changes() AS total').get()?.total);
          const results = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
          return { results, meta: { changes: Number(sqlite.prepare('SELECT total_changes() AS total').get()?.total) - before } };
        },
      };
      return bound;
    },
    async batch(statements: LocalStatement[]) {
      sqlite.exec('BEGIN');
      try { const results = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const db = adapter as unknown as D1Database;
  const env: { DB?: D1Database } = { DB: db }; let owner: string | null = 'alice';
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), { getChatGPTUser: async () => owner ? { userId: owner } : null });
  const repository = loadExports(new URL('../../../../db/health-repository.ts', import.meta.url), { env, ...health, ...composition, ...recordStore, ...importStore }, ['readHealth', 'importHealth']);
  const route = loadExports(new URL('./route.ts', import.meta.url), {
    ...shared, ...repository, ...planRules, ...planStore, ...cycleStore, env,
    parseWeightPlanInput: (input: unknown) => planRules.parseWeightPlanInput(input, NOW),
    buildWeightPlanReview: (...args: Parameters<typeof planRules.buildWeightPlanReview>) => planRules.buildWeightPlanReview(args[0], args[1], NOW),
  }) as { GET(): Promise<Response>; PUT(request: Request): Promise<Response> };
  const cycleRoute=loadExports(new URL('./cycles/route.ts',import.meta.url),{
    ...shared,...repository,...planRules,...planStore,...cycleStore,...cycleRules,env,
    parseWeightCycleCommand:(input:unknown)=>cycleRules.parseWeightCycleCommand(input,NOW),
  }) as {GET(request:Request):Promise<Response>;POST(request:Request):Promise<Response>};
  function seed(userId: string, id: string, value: number, startDate: string) {
    const measurement: health.HealthMeasurement = { id, metric: 'weight', value, unit: 'kg', source: 'synthetic-scale', aggregation: 'sample', startDate };
    sqlite.prepare(`INSERT OR REPLACE INTO health_measurements
      (user_id,record_key,metric,day,measurement_json,exported_at,received_at) VALUES (?,?,?,?,?,?,?)`)
      .run(userId, health.measurementKey(measurement), 'weight', health.measurementDay(measurement), JSON.stringify(measurement), FIRST_EXPORT, FIRST_EXPORT);
    return measurement;
  }
  return {
    db, env, queries, seed,
    signIn(userId: string | null) { owner = userId; },
    get() { return route.GET(); },
    cycles(){return cycleRoute.GET(new Request(ORIGIN+'/api/health/weight-plan/cycles'));},
    cycle(body:unknown,key='11111111-1111-4111-8111-111111111111',options:{origin?:string;contentType?:string}={}){return cycleRoute.POST(new Request(ORIGIN+'/api/health/weight-plan/cycles',{method:'POST',headers:{Origin:options.origin??ORIGIN,'Content-Type':options.contentType??'application/json','Idempotency-Key':key},body:JSON.stringify(body)}));},
    put(body: unknown, options: { origin?: string | null; contentType?: string } = {}) {
      const headers = new Headers({ 'Content-Type': options.contentType ?? 'application/json' });
      if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
      return route.PUT(new Request(ORIGIN + '/api/health/weight-plan', { method: 'PUT', headers, body: JSON.stringify(body&&typeof body==='object'&&!Array.isArray(body)?{expectedRevision:Number(sqlite.prepare('SELECT revision FROM health_weight_plan_settings WHERE user_id=?').get(owner)?.revision??0),...body}:body) }));
    },
    async sync(userId: string, payload: health.HealthSyncPayload) {
      const preview = await importStore.previewHealthImport(db, userId, payload);
      return (repository.importHealth as (userId: string, payload: health.HealthSyncPayload, deviceId: null, options: importStore.HealthImportOptions) => Promise<unknown>)(userId, payload, null, { previewToken: preview.token, confirmSourceChanges: true });
    },
  };
}
const input = (patch: Record<string, unknown> = {}) => ({ baselineWeight: 80, targetWeight: 70, startDate: shift(-10), deadline: shift(10), enabled: true, ...patch });

test('weight-plan reads and writes require sign-in and same-origin JSON', async (t) => {
  const f = await fixture(t); f.signIn(null);
  for (const response of [await f.get(), await f.put(input())]) { assert.equal(response.status, 401); assert.equal(response.headers.get('Cache-Control'), 'no-store'); }
  assert.deepEqual(f.queries, []); f.signIn('alice');
  assert.equal((await f.put(input(), { origin: 'https://other.example' })).status, 403);
  assert.equal((await f.put(input(), { origin: null })).status, 403);
  assert.equal((await f.put(input(), { contentType: 'text/plain' })).status, 415);
});

test('observations remain available without a plan and use daily last samples without future values', async (t) => {
  const f = await fixture(t);
  f.seed('alice', 'morning', 70, shift(-1) + 'T07:00:00+08:00');
  f.seed('alice', 'evening', 72, shift(-1) + 'T20:00:00+08:00');
  f.seed('alice', 'older', 74, shift(-2) + 'T07:00:00+08:00');
  f.seed('alice', 'future', 99, new Date(NOW.getTime() + 3600000).toISOString());
  const data = await readPlan(await f.get()); assert.equal(data.settings, null); assert.equal(data.progress, null);
  assert.equal(data.observations.latestWeight, 72); assert.equal(data.observations.latestDate, shift(-1)); assert.equal(data.observations.average7, 73); assert.equal(data.observations.recordedDays7, 2); assert.deepEqual(data.observations.points.map((point) => point.value), [74, 72]);
});

test('loss, gain and maintenance remain directional and maintenance avoids division by zero', async (t) => {
  const f = await fixture(t); f.seed('alice', 'observed', 75, shift(-1) + 'T07:00:00+08:00');
  const loss = await readPlan(await f.put(input())); assert.ok(loss.progress); assert.equal(loss.progress.direction, 'loss'); assert.equal(loss.progress.progressPercent, 50); assert.equal(loss.progress.gapKg, 5); assert.equal(loss.progress.referenceWeight, 75);
  const gain = await readPlan(await f.put(input({ baselineWeight: 70, targetWeight: 80 }))); assert.ok(gain.progress); assert.equal(gain.progress.direction, 'gain'); assert.equal(gain.progress.progressPercent, 50); assert.equal(gain.progress.gapKg, 5);
  const maintain = await readPlan(await f.put(input({ baselineWeight: 75, targetWeight: 75 }))); assert.ok(maintain.progress); assert.equal(maintain.progress.direction, 'maintain'); assert.equal(maintain.progress.progressPercent, null); assert.equal(maintain.progress.gapKg, 0);
});

test('missing and stale observations never fall back to the configured baseline', async (t) => {
  const f = await fixture(t); const empty = await readPlan(await f.put(input())); assert.ok(empty.progress); assert.equal(empty.progress.status, 'missing'); assert.equal(empty.progress.gapKg, null); assert.equal(empty.progress.progressPercent, null); assert.equal(empty.observations.latestWeight, null);
  f.seed('alice', 'stale', 75, shift(-20) + 'T07:00:00+08:00'); const stale = await readPlan(await f.get()); assert.ok(stale.progress); assert.equal(stale.observations.latestWeight, 75); assert.equal(stale.observations.latestDate, shift(-20)); assert.equal(stale.observations.average7, null); assert.equal(stale.observations.recordedDays7, 0); assert.equal(stale.progress.status, 'missing');
  const ended = await readPlan(await f.put(input({ startDate: shift(-10), deadline: shift(-1) }))); assert.ok(ended.progress); assert.equal(ended.progress.status, 'ended');
});

test('disabling and restoring a plan preserves observations and stored settings', async (t) => {
  const f = await fixture(t); f.seed('alice', 'observed', 75, shift(-1) + 'T07:00:00+08:00');
  const active = await readPlan(await f.put(input())); const disabled = await readPlan(await f.put(input({ enabled: false })));
  assert.ok(disabled.settings); assert.equal(disabled.settings.enabled, false); assert.equal(disabled.progress, null); assert.deepEqual(disabled.observations, active.observations);
  const restored = await readPlan(await f.put(input())); assert.ok(restored.progress); assert.equal(restored.progress.direction, 'loss'); assert.deepEqual(restored.observations, active.observations);
});

test('manual corrections, hide and reset influence weight-plan observations through the shared effective reader', async (t) => {
  const f = await fixture(t); const measured = f.seed('alice', 'manual-integration', 75, shift(-1) + 'T07:00:00+08:00'); await f.put(input()); const key = health.measurementKey(measured);
  const original = await recordStore.readHealthRecord(f.db, 'alice', key); assert.ok(original);
  const corrected = await recordStore.writeHealthRecord(f.db, 'alice', { action: 'correct', recordKey: key, value: 74, expectedRevision: original.revision, expectedBaseExportedAt: original.base?.exportedAt ?? null, reason: 'synthetic correction' }, crypto.randomUUID());
  assert.equal((await readPlan(await f.get())).observations.average7, 74);
  await f.sync('alice', health.parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: NOW.toISOString(), measurements: [{ ...measured, value: 76 }] }));
  assert.equal((await readPlan(await f.get())).observations.average7, 74);
  const fresh = await recordStore.readHealthRecord(f.db, 'alice', key); assert.ok(fresh);
  const hidden = await recordStore.writeHealthRecord(f.db, 'alice', { action: 'hide', recordKey: key, expectedRevision: corrected.record.revision, expectedBaseExportedAt: fresh.base?.exportedAt ?? null, reason: '' }, crypto.randomUUID());
  const absent = await readPlan(await f.get()); assert.equal(absent.observations.latestWeight, null); assert.ok(absent.progress); assert.equal(absent.progress.status, 'missing');
  await recordStore.writeHealthRecord(f.db, 'alice', { action: 'reset', recordKey: key, expectedRevision: hidden.record.revision, expectedBaseExportedAt: hidden.record.base?.exportedAt ?? null, reason: '' }, crypto.randomUUID());
  assert.equal((await readPlan(await f.get())).observations.average7, 76);
});

test('invalid weights, dates and incomplete settings are rejected without changing an existing plan', async (t) => {
  const f = await fixture(t); await f.put(input());
  for (const body of [input({ baselineWeight: 0 }), input({ targetWeight: 601 }), input({ baselineWeight: '80' }), input({ startDate: shift(1) }), input({ deadline: shift(-10) }), input({ deadline: '2026-02-30' }), input({ enabled: 'true' }), { baselineWeight: 80 }]) assert.equal((await f.put(body)).status, 400, JSON.stringify(body));
  const retained = await readPlan(await f.get()); assert.ok(retained.settings); assert.equal(retained.settings.baselineWeight, 80); assert.equal(retained.settings.targetWeight, 70);
});

test('weight settings and observed measurements remain isolated to their signed-in owner', async (t) => {
  const f = await fixture(t); f.seed('alice', 'alice-observation', 75, shift(-1) + 'T07:00:00+08:00'); f.seed('bob', 'bob-observation', 65, shift(-1) + 'T07:00:00+08:00'); await f.put(input());
  f.signIn('bob'); const empty = await readPlan(await f.get()); assert.equal(empty.settings, null); assert.equal(empty.observations.latestWeight, 65); await f.put(input({ baselineWeight: 60, targetWeight: 70 }));
  f.signIn('alice'); const alice = await readPlan(await f.get()); assert.ok(alice.settings); assert.equal(alice.settings.baselineWeight, 80); assert.equal(alice.observations.latestWeight, 75);
  delete f.env.DB; const failure = await f.get(); assert.equal(failure.status, 503); assert.equal((await readError(failure)).code, 'HEALTH_STORAGE_UNAVAILABLE');
});

test('two tabs cannot overwrite a newer weight plan with an old revision',async(t)=>{const f=await fixture(t);assert.equal((await f.put(input({expectedRevision:0}))).status,200);assert.equal((await f.put(input({targetWeight:68,expectedRevision:1}))).status,200);const stale=await f.put(input({targetWeight:60,expectedRevision:1}));assert.equal(stale.status,409);assert.equal((await readError(stale)).code,'WEIGHT_PLAN_CONFLICT');assert.equal((await readPlan(await f.get())).settings?.targetWeight,68);});

test('cycle actions require the signed-in owner, same-origin JSON, valid operation id and explicit CAS revision',async(t)=>{
  const f=await fixture(t);f.signIn(null);assert.equal((await f.cycle({action:'archive',expectedRevision:0})).status,401);assert.equal((await f.cycles()).status,401);assert.deepEqual(f.queries,[]);f.signIn('alice');
  assert.equal((await f.cycle({action:'archive',expectedRevision:0},undefined,{origin:'https://foreign.example'})).status,403);
  assert.equal((await f.cycle({action:'archive',expectedRevision:0},undefined,{contentType:'text/plain'})).status,415);
  assert.equal((await f.cycle({action:'archive',expectedRevision:0},'bad')).status,400);
  assert.equal((await f.cycle({action:'archive'})).status,400);assert.equal((await f.cycle({action:'unknown',expectedRevision:0})).status,400);
});

test('archive and explicit new-cycle API actions preserve frozen history and replay original requests',async(t)=>{
  const f=await fixture(t);f.seed('alice','cycle-weight',75,shift(-1)+'T07:00:00+08:00');await f.put(input());
  const archive={action:'archive',expectedRevision:1};const first=await f.cycle(archive);assert.equal(first.status,200);const archived=await first.json() as PlanResponse&{cycle:{id:string;archivedAt:string};cycles:cycleRules.WeightCycleArchive[];operation:{replayed:boolean}};
  assert.equal(archived.settings?.enabled,false);assert.equal(archived.cycles.length,1);assert.equal(archived.cycles[0].summary.average7,75);assert.equal(archived.operation.replayed,false);
  f.seed('alice','later-correction',80,shift(-1)+'T20:00:00+08:00');const replay=await(await f.cycle(archive)).json() as typeof archived;assert.equal(replay.operation.replayed,true);assert.equal(replay.cycles[0].summary.average7,75);
  assert.equal((await f.put(input({expectedRevision:2}))).status,409);
  const start={action:'start',expectedRevision:2,plan:input({baselineWeight:75,targetWeight:72})};const started=await f.cycle(start,'22222222-2222-4222-8222-222222222222');assert.equal(started.status,200);const next=await started.json() as PlanResponse&{cycle:{id:string;archivedAt:null};cycles:cycleRules.WeightCycleArchive[]};assert.equal(next.cycle.archivedAt,null);assert.equal(next.settings?.targetWeight,72);assert.equal(next.cycles[0].settings.targetWeight,70);assert.equal(next.settings?.revision,3);
  f.signIn('bob');const isolated=await(await f.cycles()).json() as {cycles:unknown[]};assert.deepEqual(isolated.cycles,[]);
});
