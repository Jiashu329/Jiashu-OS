import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { runInThisContext } from 'node:vm';
import test, { type TestContext } from 'node:test';
import { shanghaiDay } from '../../../../lib/health.ts';
import * as nutritionRules from '../../../../lib/nutrition.ts';
import * as nutritionStore from '../../../../db/nutrition-store.ts';
import * as nutritionGoals from '../../../../lib/nutrition-goals.ts';
import * as nutritionGoalStore from '../../../../db/nutrition-goals-store.ts';
import { readWeightPlanSettings } from '../../../../db/weight-plan-store.ts';
import { getFood, LEGACY_FOOD_CATALOG_RELEASE, calculateFoodSelection } from '../../../../lib/food-catalog.ts';

const ORIGIN = 'https://synthetic-nutrition.example';
const TODAY = shanghaiDay(new Date().toISOString());
const shift = (days: number) => new Date(Date.parse(TODAY + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
interface ApiError { code: string; error: string }
async function readError(response: Response): Promise<ApiError> { return await response.json() as ApiError; }
function loadExports(path: URL, bindings: Record<string, unknown>, names?: string[]): Record<string, unknown> {
  const original = readFileSync(path, 'utf8');
  const exported = names ?? [...original.matchAll(/^export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/gm)].map((match) => match[1]);
  const source = stripTypeScriptTypes(original, { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  const factory = runInThisContext('(function(' + Object.keys(bindings).join(',') + '){' + source + '\nreturn {' + exported.join(',') + '};})') as (...values: unknown[]) => Record<string, unknown>;
  return factory(...Object.values(bindings));
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
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), { getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => owner ? { userId: owner } : null });
  const bindings = { ...shared, ...nutritionRules, ...nutritionStore, ...nutritionGoals, ...nutritionGoalStore, readWeightPlanSettings, shanghaiDay, env };
  const nutritionShared = loadExports(new URL('./_shared.ts', import.meta.url), bindings);
  const route = loadExports(new URL('./route.ts', import.meta.url), { ...bindings, ...nutritionShared }) as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> };
  const itemRoute = loadExports(new URL('./[id]/route.ts', import.meta.url), { ...bindings, ...nutritionShared }) as {
    GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response>;
    PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response>;
  };
  const batchRoute = loadExports(new URL('./batch/route.ts', import.meta.url), { ...bindings, ...nutritionShared }) as { POST(request: Request): Promise<Response> };
  const statusRoute = loadExports(new URL('./status/route.ts', import.meta.url), { ...bindings, ...nutritionShared }) as { GET(request: Request): Promise<Response>; PATCH(request: Request): Promise<Response> };
  const favoritesRoute = loadExports(new URL('./favorites/route.ts', import.meta.url), { ...bindings, ...nutritionShared }) as { GET(): Promise<Response>; POST(request: Request): Promise<Response>; DELETE(request: Request): Promise<Response> };
  const goalsRoute=loadExports(new URL('./goals/route.ts',import.meta.url),{...bindings,...nutritionShared}) as {GET():Promise<Response>;PUT(request:Request):Promise<Response>};
  const historyRoute=loadExports(new URL('./[id]/history/route.ts',import.meta.url),{...bindings,...nutritionShared}) as {GET(request:Request,context:{params:Promise<{id:string}>}):Promise<Response>};
  const restoreRoute=loadExports(new URL('./[id]/restore/route.ts',import.meta.url),{...bindings,...nutritionShared}) as {POST(request:Request,context:{params:Promise<{id:string}>}):Promise<Response>};
  function request(method: string, path: string, body?: unknown, options: { key?: string | null; origin?: string | null; contentType?: string; raw?: boolean } = {}) {
    const headers = new Headers({ 'Content-Type': options.contentType ?? 'application/json' });
    if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
    if (method === 'POST' && options.key !== null) headers.set('Idempotency-Key', options.key ?? crypto.randomUUID());
    if (options.raw && typeof body !== 'string') throw new TypeError('Raw synthetic request body must be text');
    return new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: options.raw ? body as string : JSON.stringify(body) }) });
  }
  return {
    sqlite, db, env, queries,
    signIn(userId: string | null) { owner = userId; },
    goals(){return goalsRoute.GET();},
    setGoals(body:unknown,options:Parameters<typeof request>[3]={}){return goalsRoute.PUT(request('PUT','/api/health/nutrition/goals',body,options));},
    history(id:string){return historyRoute.GET(request('GET','/api/health/nutrition/'+id+'/history'),{params:Promise.resolve({id})});},
    restore(id:string,body:unknown,options:Parameters<typeof request>[3]={}){return restoreRoute.POST(request('POST','/api/health/nutrition/'+id+'/restore',body,options),{params:Promise.resolve({id})});},
    list(date = TODAY, includeDeleted = false) { return route.GET(request('GET', '/api/health/nutrition?date=' + date + (includeDeleted ? '&includeDeleted=1' : ''))); },
    get(id: string) { return itemRoute.GET(request('GET', '/api/health/nutrition/' + id), { params: Promise.resolve({ id }) }); },
    create(body: unknown, options: Parameters<typeof request>[3] = {}) { return route.POST(request('POST', '/api/health/nutrition', body, options)); },
    patch(id: string, body: unknown, options: Parameters<typeof request>[3] = {}) { return itemRoute.PATCH(request('PATCH', '/api/health/nutrition/' + id, body, options), { params: Promise.resolve({ id }) }); },
    batch(body: unknown, options: Parameters<typeof request>[3] = {}) { return batchRoute.POST(request('POST', '/api/health/nutrition/batch', body, options)); },
    status(date = TODAY) { return statusRoute.GET(request('GET', '/api/health/nutrition/status?date=' + date)); },
    mark(body: unknown, options: Parameters<typeof request>[3] = {}) { return statusRoute.PATCH(request('PATCH', '/api/health/nutrition/status', body, options)); },
    favorites() { return favoritesRoute.GET(); },
    favorite(entryId: string, options: Parameters<typeof request>[3] = {}) { return favoritesRoute.POST(request('POST', '/api/health/nutrition/favorites', { entryId }, options)); },
    unfavorite(id: string, options: Parameters<typeof request>[3] = {}) { return favoritesRoute.DELETE(request('DELETE', '/api/health/nutrition/favorites?id=' + id, undefined, options)); },
    count() { return Number(sqlite.prepare('SELECT count(*) AS total FROM nutrition_entries').get()?.total); },
  };
}
type EntryView = nutritionRules.NutritionEntryView;
type ListResponse = nutritionRules.NutritionReview;
interface MutationResponse { entry: EntryView; replayed?: boolean }
async function readMutation(response: Response): Promise<MutationResponse> { return await response.json() as MutationResponse; }
async function readList(response: Response): Promise<ListResponse> { return await response.json() as ListResponse; }
const input = (patch: Record<string, unknown> = {}) => ({ date: TODAY, meal: 'breakfast', name: 'Synthetic meal', portion: '1 serving', calories: '0', note: 'Synthetic test', ...patch });
const edit = (entry: EntryView, patch: Record<string, unknown> = {}) => ({ date: entry.date, meal: entry.meal, name: entry.name, portion: entry.portion, calories: entry.calories, note: entry.note, expectedRevision: entry.revision, ...patch });

void test('nutrition targets require owner login, same-origin writes and a current revision',async(t)=>{
  const f=await fixture(t);f.signIn(null);assert.equal((await f.goals()).status,401);
  assert.equal((await f.setGoals({})).status,401);f.signIn('alice');
  const empty=await(await f.goals()).json() as {goals:nutritionGoals.NutritionGoals;weightPlan:unknown};assert.equal(empty.goals.revision,0);assert.equal(empty.weightPlan,null);
  const command={calories:'1800',carbs:null,protein:'80.5',fat:'0',expectedRevision:0};
  assert.equal((await f.setGoals(command,{origin:null})).status,403);
  const response=await f.setGoals(command);assert.equal(response.status,200);
  const saved=await response.json() as {goals:nutritionGoals.NutritionGoals};assert.equal(saved.goals.protein,'80.5');assert.equal(saved.goals.fat,'0.0');
  assert.equal((await f.setGoals(command)).status,409);
  f.signIn('bob');assert.equal(((await(await f.goals()).json()) as {goals:nutritionGoals.NutritionGoals}).goals.protein,null);
});

void test('nutrition history and revision restoration are private, audited and replay-safe',async(t)=>{
  const f=await fixture(t);const created=(await readMutation(await f.create(input({calories:'420',provenance:{calories:{source:'ai',basis:'按普通份量估算',originalValue:'420'}}})))).entry;
  const edited=(await readMutation(await f.patch(created.id,edit(created,{calories:'380',provenance:{calories:{source:'label',basis:'包装已核对',originalValue:'420'}}})))).entry;
  assert.equal(edited.provenance?.calories?.source,'label');
  const history=await(await f.history(created.id)).json() as {history:nutritionStore.NutritionHistoryItem[]};assert.equal(history.history.length,2);assert.equal(history.history[0].before?.calories,'420.0');
  const key=crypto.randomUUID(),command={revision:1,expectedRevision:2};
  assert.equal((await f.restore(created.id,command,{origin:null,key})).status,403);
  const restored=await readMutation(await f.restore(created.id,command,{key}));assert.equal(restored.entry.calories,'420.0');assert.equal(restored.entry.revision,3);assert.equal(restored.entry.provenance?.calories?.source,'ai');
  const replay=await readMutation(await f.restore(created.id,command,{key}));assert.equal(replay.replayed,true);assert.equal(replay.entry.revision,3);
  const after=await(await f.history(created.id)).json() as {history:nutritionStore.NutritionHistoryItem[]};assert.equal(after.history.length,3);assert.equal(after.history[0].action,'restore');
  f.signIn('bob');assert.equal((await f.history(created.id)).status,404);assert.equal((await f.restore(created.id,command,{key})).status,404);
});

void test('macro grams roundtrip through create, list, edit and deleted-record restoration without replacing unknown with zero', async (t) => {
  const f = await fixture(t);
  const response = await f.create(input({carbs:'30.5',protein:null,fat:'0'}));assert.equal(response.status,201);
  let item = (await readMutation(response)).entry;
  const values = (entry: EntryView) => [entry.carbs,entry.protein,entry.fat];
  assert.deepEqual(values(item),['30.5',null,'0.0']);
  assert.deepEqual(values((await readList(await f.list())).entries[0]),['30.5',null,'0.0']);
  item = (await readMutation(await f.patch(item.id,edit(item,{carbs:'25',protein:'12.3',fat:null})))).entry;
  assert.deepEqual(values(item),['25.0','12.3',null]);
  item = (await readMutation(await f.patch(item.id,{deleted:true,expectedRevision:item.revision}))).entry;
  item = (await readMutation(await f.patch(item.id,{deleted:false,expectedRevision:item.revision}))).entry;
  assert.deepEqual(values(item),['25.0','12.3',null]);
  assert.deepEqual(values((await readMutation(await f.get(item.id))).entry),['25.0','12.3',null]);
  f.signIn('bob');assert.equal((await f.get(item.id)).status,404);
});

void test('nutrition endpoints require authentication, same-origin JSON and a valid creation identifier', async (t) => {
  const f = await fixture(t); const id = crypto.randomUUID(); f.signIn(null);
  for (const response of [await f.list(), await f.create(input()), await f.get(id), await f.patch(id, { deleted: true, expectedRevision: 1 })]) {
    assert.equal(response.status, 401); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(f.queries, []); f.signIn('alice');
  assert.equal((await f.create(input(), { origin: 'https://other.example' })).status, 403);
  assert.equal((await f.create(input(), { origin: null })).status, 403);
  assert.equal((await f.create(input(), { contentType: 'text/plain' })).status, 415);
  assert.equal((await f.create(input(), { key: null })).status, 400);
  assert.equal((await f.create(input(), { key: 'not-a-uuid' })).status, 400);
  assert.equal((await f.create('{', { raw: true })).status, 400);
  assert.equal((await f.create(' '.repeat(65536), { raw: true })).status, 413);
  assert.equal((await f.patch(id, { deleted: true, expectedRevision: 1 }, { origin: null })).status, 403);
  assert.equal((await f.patch(id, ' '.repeat(65536), { raw: true })).status, 413);
  assert.equal(f.count(), 0);
});

void test('empty days and unknown calories stay null, while zero and decimal meal totals remain exact', async (t) => {
  const f = await fixture(t); const empty = await readList(await f.list());
  assert.equal(empty.summary.entryCount, 0); assert.equal(empty.summary.knownCalories, null);
  assert.equal(empty.recent7days.length, 7); assert.equal(empty.recent7days[0].date, shift(-6)); assert.equal(empty.recent7days.at(-1)?.date, TODAY);
  assert.ok(empty.recent7days.every((day) => day.summary.knownCalories === null));
  const earliest = await readList(await f.list('1970-01-01')); assert.equal(earliest.recentFrom, '1970-01-01'); assert.equal(earliest.recent7days.length, 1); assert.equal(earliest.recent7days[0].date, '1970-01-01');
  const zero = await readMutation(await f.create(input())); assert.equal(zero.entry.calories, '0.0'); assert.equal(zero.entry.caloriesTenth, 0);
  assert.equal((await readList(await f.list())).summary.knownCalories, '0.0');
  await f.create(input({ meal: 'lunch', name: 'Unknown lunch', calories: null }));
  await f.create(input({ meal: 'dinner', calories: '0.1' })); await f.create(input({ meal: 'dinner', calories: '0.2' }));
  const data = await readList(await f.list());
  assert.equal(data.summary.knownCalories, '0.3'); assert.equal(data.summary.entryCount, 4); assert.equal(data.summary.knownCount, 3); assert.equal(data.summary.unknownCount, 1);
  assert.equal(data.summary.meals.find((meal) => meal.meal === 'breakfast')?.knownCalories, '0.0');
  assert.equal(data.summary.meals.find((meal) => meal.meal === 'lunch')?.knownCalories, null);
  assert.equal(data.summary.meals.find((meal) => meal.meal === 'lunch')?.unknownCount, 1);
  assert.equal(data.summary.meals.find((meal) => meal.meal === 'dinner')?.knownCalories, '0.3');
  assert.equal(data.summary.meals.find((meal) => meal.meal === 'snack')?.entryCount, 0);
});

void test('cross-day and cross-meal edits move totals once and stale revisions cannot overwrite newer entries', async (t) => {
  const f = await fixture(t); const created = (await readMutation(await f.create(input({ calories: '123.4' })))).entry;
  const response = await f.patch(created.id, edit(created, { date: shift(-2), meal: 'dinner', calories: '200.1' })); assert.equal(response.status, 200);
  const moved = (await readMutation(response)).entry; assert.equal(moved.revision, 2); assert.equal(moved.date, shift(-2)); assert.equal(moved.meal, 'dinner');
  assert.equal((await readList(await f.list())).summary.knownCalories, null);
  const day = await readList(await f.list(shift(-2))); assert.equal(day.entries.length, 1); assert.equal(day.summary.knownCalories, '200.1');
  assert.equal(day.summary.meals.find((meal) => meal.meal === 'dinner')?.knownCalories, '200.1');
  assert.equal(day.recentTo, shift(-2)); assert.equal(day.recentFrom, shift(-8)); assert.equal(day.recent7days.at(-1)?.date, shift(-2));
  const stale = await f.patch(created.id, edit(created, { name: 'Lost stale change' })); assert.equal(stale.status, 409); assert.equal((await readError(stale)).code, 'NUTRITION_CONFLICT');
  assert.equal((await readMutation(await f.get(created.id))).entry.name, created.name);
  assert.equal((await readList(await f.list(shift(-2)))).summary.knownCalories, '200.1');
});

void test('soft deletion removes calories from all summaries and restoring preserves unknown and zero values', async (t) => {
  const f = await fixture(t); const zero = (await readMutation(await f.create(input()))).entry;
  const unknown = (await readMutation(await f.create(input({ meal: 'lunch', calories: null })))).entry;
  const deleted = (await readMutation(await f.patch(zero.id, { deleted: true, expectedRevision: zero.revision }))).entry; assert.equal(deleted.deleted, true);
  let data = await readList(await f.list()); assert.equal(data.entries.length, 1); assert.equal(data.summary.knownCalories, null); assert.equal(data.summary.unknownCount, 1);
  data = await readList(await f.list(TODAY, true)); assert.equal(data.entries.length, 2); assert.equal(data.summary.entryCount, 1); assert.equal(data.summary.knownCalories, null); assert.equal(data.recent7days.at(-1)?.summary.knownCalories, null);
  const restored = (await readMutation(await f.patch(zero.id, { deleted: false, expectedRevision: deleted.revision }))).entry;
  assert.equal(restored.caloriesTenth, 0); assert.equal(restored.deleted, false); assert.equal((await readList(await f.list())).summary.knownCalories, '0.0');
  const hiddenUnknown = (await readMutation(await f.patch(unknown.id, { deleted: true, expectedRevision: unknown.revision }))).entry;
  await f.patch(unknown.id, { deleted: false, expectedRevision: hiddenUnknown.revision });
  assert.equal((await readMutation(await f.get(unknown.id))).entry.caloriesTenth, null); assert.equal(f.count(), 2);
});

void test('creation replay returns the latest edited or deleted entry without duplicating or restoring it', async (t) => {
  const f = await fixture(t); const key = crypto.randomUUID(); const body = input({ calories: '123.4' });
  const createdResponse = await f.create(body, { key }); assert.equal(createdResponse.status, 201); const created = (await readMutation(createdResponse)).entry;
  const normalizedReplay = await readMutation(await f.create({ ...body, name: ' Synthetic meal ', calories: '00123.4', note: ' Synthetic test ' }, { key: key.toUpperCase() }));
  assert.equal(normalizedReplay.replayed, true); assert.equal(normalizedReplay.entry.id, created.id);
  const edited = (await readMutation(await f.patch(created.id, edit(created, { name: 'Edited meal', calories: '99.9' })))).entry;
  let replay = await readMutation(await f.create(body, { key })); assert.equal(replay.replayed, true); assert.equal(replay.entry.id, created.id); assert.equal(replay.entry.name, 'Edited meal'); assert.equal(replay.entry.calories, '99.9');
  await f.patch(created.id, { deleted: true, expectedRevision: edited.revision });
  replay = await readMutation(await f.create(body, { key })); assert.equal(replay.replayed, true); assert.equal(replay.entry.deleted, true); assert.equal((await readList(await f.list())).entries.length, 0);
  const mismatch = await f.create({ ...body, calories: '123.5' }, { key }); assert.equal(mismatch.status, 409); assert.equal((await readError(mismatch)).code, 'NUTRITION_CONFLICT'); assert.equal(f.count(), 1);
  f.signIn('bob'); assert.equal((await f.create(body, { key })).status, 409); assert.equal((await readList(await f.list(TODAY, true))).entries.length, 0);
});

void test('invalid dates, meal values, caloric precision and forged edits leave stored data unchanged', async (t) => {
  const f = await fixture(t);
  for (const patch of [{ date: shift(1) }, { date: '2026-02-30' }, { date: '1969-12-31' }, { meal: 'brunch' }, { name: '' }, { name: 'x'.repeat(101) }, { portion: 'x'.repeat(101) }, { note: 'x'.repeat(501) }, { calories: '-0.1' }, { calories: '0.01' }, { calories: '20000.1' }, { calories: '1e2' }, { calories: 12 }]) {
    const response = await f.create(input(patch)); assert.equal(response.status, 400, JSON.stringify(patch)); assert.equal((await readError(response)).code, 'INVALID_NUTRITION_ENTRY');
  }
  assert.equal((await f.list(shift(1))).status, 400); assert.equal((await f.list('2026-02-30')).status, 400); assert.equal(f.count(), 0);
  const created = (await readMutation(await f.create(input()))).entry;
  for (const body of [edit(created, { date: shift(1) }), edit(created, { ownerId: 'bob' }), { name: 'Incomplete', expectedRevision: created.revision }, { deleted: true, expectedRevision: 0 }, { deleted: true, expectedRevision: created.revision, calories: '1' }]) assert.equal((await f.patch(created.id, body)).status, 400, JSON.stringify(body));
  const retained = (await readMutation(await f.get(created.id))).entry; assert.equal(retained.revision, 1); assert.equal(retained.caloriesTenth, 0);
});

void test('nutrition entries and daily summaries remain isolated to their authenticated owner', async (t) => {
  const f = await fixture(t); const alice = (await readMutation(await f.create(input({ calories: '100' })))).entry;
  f.signIn('bob'); assert.equal((await f.get(alice.id)).status, 404); assert.equal((await f.patch(alice.id, edit(alice))).status, 404); assert.equal((await readList(await f.list(TODAY, true))).summary.entryCount, 0);
  await f.create(input({ calories: '200' })); assert.equal((await readList(await f.list())).summary.knownCalories, '200.0');
  f.signIn('alice'); assert.equal((await readList(await f.list())).summary.knownCalories, '100.0');
  delete f.env.DB; const unavailable = await f.list(); assert.equal(unavailable.status, 503); assert.equal((await readError(unavailable)).code, 'HEALTH_STORAGE_UNAVAILABLE'); assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
});

void test('a rejected database insert leaves no half-created entry and the same creation key can safely retry', async (t) => {
  const f = await fixture(t); const key = crypto.randomUUID();
  f.sqlite.exec("CREATE TRIGGER reject_synthetic_nutrition BEFORE INSERT ON nutrition_entries BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
  const failed = await f.create(input(), { key }); assert.equal(failed.status, 503); assert.equal(f.count(), 0);
  f.sqlite.exec('DROP TRIGGER reject_synthetic_nutrition');
  const retry = await f.create(input(), { key }); assert.equal(retry.status, 201); const created = await readMutation(retry); assert.equal(created.replayed, false); assert.equal(f.count(), 1);
  assert.equal((await readMutation(await f.create(input(), { key }))).replayed, true); assert.equal(f.count(), 1);
});

void test('batch endpoints validate the whole draft, require a request key and keep replays atomic', async (t) => {
  const f = await fixture(t); const key = crypto.randomUUID();
  assert.equal((await f.batch({ entries: [input()] }, { origin: null })).status, 403);
  assert.equal((await f.batch({ entries: [input()] }, { key: null })).status, 400);
  assert.equal((await f.batch({ entries: [input(), input({ date: shift(1) })] })).status, 400);
  assert.equal(f.count(), 0);
  const first = await f.batch({ entries: [input(), input({ meal: 'lunch', calories: null })] }, { key });
  assert.equal(first.status, 201); const saved = await first.json() as { entries: EntryView[]; replayed: boolean };
  assert.equal(saved.entries.length, 2); assert.equal(saved.replayed, false);
  const replay = await f.batch({ entries: [input(), input({ meal: 'lunch', calories: null })] }, { key });
  assert.equal((await replay.json() as { replayed: boolean }).replayed, true); assert.equal(f.count(), 2);
  assert.equal((await f.batch({ entries: [input()] }, { key })).status, 409); assert.equal(f.count(), 2);
  f.signIn(null); assert.equal((await f.batch({ entries: [input()] })).status, 401);
});

void test('favorite API snapshots belong to one user and all mutations enforce same-origin', async (t) => {
  const f = await fixture(t); const item = (await readMutation(await f.create(input()))).entry;
  assert.equal((await f.favorite(item.id, { origin: null })).status, 403);
  const first = await f.favorite(item.id); assert.equal(first.status, 200);
  const saved = (await first.json() as { favorite: { id: string } }).favorite;
  await f.favorite(item.id); assert.equal((await f.favorites().then((response) => response.json()) as { favorites: unknown[] }).favorites.length, 1);
  f.signIn('bob'); assert.equal((await f.favorite(item.id)).status, 404); assert.equal((await f.unfavorite(saved.id)).status, 404);
  assert.equal((await f.favorites().then((response) => response.json()) as { favorites: unknown[] }).favorites.length, 0);
  f.signIn('alice'); assert.equal((await f.unfavorite(saved.id, { origin: null })).status, 403); assert.equal((await f.unfavorite(saved.id)).status, 200);
});

void test('day completion uses revisions and reopens automatically when food records change', async (t) => {
  const f = await fixture(t); await f.create(input());
  const initial = (await f.status().then((response) => response.json()) as { dayStatus: nutritionRules.NutritionDayStatus }).dayStatus;
  const body = { date: TODAY, complete: true, expectedRevision: initial.revision, meals: { breakfast: 'recorded', lunch: 'skipped', dinner: 'skipped', snack: 'unrecorded' } };
  assert.equal((await f.mark(body, { origin: null })).status, 403);
  assert.equal((await f.mark(body)).status, 200); assert.equal((await f.mark(body)).status, 409);
  const list = await readList(await f.list()) as ListResponse & { dayStatus: nutritionRules.NutritionDayStatus; recentFoods: EntryView[] };
  assert.equal(list.dayStatus.complete, true); assert.equal(list.recentFoods.length, 1);
  await f.create(input({ meal: 'lunch' }));
  const changed = (await f.status().then((response) => response.json()) as { dayStatus: nutritionRules.NutritionDayStatus }).dayStatus;
  assert.equal(changed.complete, false); assert.equal(changed.meals.lunch, 'recorded');
  f.signIn('bob'); assert.equal((await f.status().then((response) => response.json()) as { dayStatus: nutritionRules.NutritionDayStatus }).dayStatus.revision, 0);
});

void test('withdrawn catalog source snapshots survive saving and forged client calories never override the food library', async (t) => {
  const f = await fixture(t); const food = getFood('tfda:A0550601', LEGACY_FOOD_CATALOG_RELEASE)!;
  const selection = { id: food.id, amount: 125.5, unit: 'g', catalogRelease: food.catalogRelease };
  const expected = calculateFoodSelection(selection);
  const response = await f.create(input({ name: 'forged', portion: 'forged', calories: '0', food: selection }));
  assert.equal(response.status, 201); const saved = (await readMutation(response)).entry;
  assert.deepEqual(saved.food, expected); assert.equal(saved.caloriesTenth, expected.caloriesTenth); assert.equal(saved.name, food.name);
  assert.deepEqual((await readMutation(await f.get(saved.id))).entry.food, expected);
  assert.equal((await f.create(input({ food: { ...selection, id: 'unknown' } }))).status, 400);
  assert.equal(f.count(), 1);
});
