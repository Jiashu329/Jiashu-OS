import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import * as store from '../../../../db/health-weekly-actions-store.ts';
import * as model from '../../../../lib/health-weekly-actions.ts';
import type { WeeklyAction } from '../../../../lib/health-weekly-actions.ts';

const ORIGIN = 'https://synthetic-actions.example';
const NOW = new Date('2026-11-12T08:00:00Z');
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn {' + names.join(',') + '};', Object.keys(bindings))(...Object.values(bindings));
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../../../../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  t.after(() => sqlite.close());
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const bound = { bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; }, async first<T>() { return statement.get(...values) as T ?? null; } };
    return bound;
  } } as unknown as D1Database;
  const env: { DB?: D1Database } = { DB: db };
  let userId: string | null = 'alice';
  const shared = load(new URL('../../_shared.ts', import.meta.url), { getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => userId ? { userId } : null }, ['apiUser','json','unauthenticated','unavailable','isSameOrigin','invalidOrigin']);
  const route = load(new URL('./route.ts', import.meta.url), { ...shared, ...store, ...model, env,
    weeklyActionWeek: (input: unknown) => model.weeklyActionWeek(input, NOW),
    parseWeeklyActionInput: (input: unknown) => model.parseWeeklyActionInput(input, NOW),
  }, ['GET','PUT']) as { GET(request: Request): Promise<Response>; PUT(request: Request): Promise<Response> };
  return { env, signIn(owner: string | null) { userId = owner; }, get(week = '') { return route.GET(new Request(ORIGIN + '/api/health/actions' + week)); },
    put(body: unknown, headers: Record<string,string> = {}) { return route.PUT(new Request(ORIGIN + '/api/health/actions', { method: 'PUT', headers: { Origin: ORIGIN, 'Content-Type':'application/json', ...headers }, body: JSON.stringify(body) })); } };
}
const action = { weekStart:'2026-11-16', text:'每天晚饭后散步15分钟',status:'planned',feedback:'',expectedRevision:0 };
void test('action API enforces sign-in, origin, content type and valid future planning', async (t) => {
  const f=fixture(t);f.signIn(null);
  assert.equal((await f.get()).status,401);assert.equal((await f.put(action)).status,401);f.signIn('alice');
  assert.equal((await f.put(action,{Origin:'https://elsewhere.example'})).status,403);
  assert.equal((await f.put(action,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await f.put({...action,weekStart:'2026-11-17'})).status,400);
  assert.equal((await f.put({...action,status:'completed'})).status,400);
  assert.equal((await f.put({...action,text:'a'.repeat(5000)})).status,413);
  assert.equal((await f.get('?week=2026-13-01')).status,400);
  assert.equal((await f.get('?week=2026-11-23')).status,400);
});
void test('action API persists owner-scoped plans, retries and feedback while rejecting stale changes', async (t) => {
  const f=fixture(t);
  const response=await f.put(action);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const data=await response.json() as {action:WeeklyAction};assert.equal(data.action.revision,1);
  assert.equal((await f.put(action)).status,200);
  assert.equal((await f.put({...action,text:'stale other plan'})).status,409);
  const loaded=await (await f.get('?week=2026-11-18')).json() as {action:WeeklyAction};assert.equal(loaded.action.text,action.text);
  f.signIn('bob');assert.equal((await (await f.get('?week=2026-11-16')).json() as {action:WeeklyAction|null}).action,null);
  f.signIn('alice');
  assert.equal((await f.put({...action,weekStart:'2026-11-09',status:'not_completed',feedback:'下周重新安排'})).status,200);
  const current=await (await f.get()).json() as {action:WeeklyAction};assert.equal(current.action.status,'not_completed');
  delete f.env.DB;assert.equal((await f.get()).status,503);
});
