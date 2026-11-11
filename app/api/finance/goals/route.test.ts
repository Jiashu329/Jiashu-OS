import * as balanceChanges from '../../../../db/finance-balance-changes-store.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import * as finance from '../../../../lib/finance.ts';
import * as goalRules from '../../../../lib/finance-goals.ts';
import * as financeStore from '../../../../db/finance-store.ts';
import * as goalStore from '../../../../db/finance-goals-store.ts';

const ORIGIN = 'https://synthetic-finance-goals.example';
const TODAY = finance.todayShanghai();
const PAST = new Date(Date.parse(TODAY + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const FUTURE = new Date(Date.parse(TODAY + 'T12:00:00Z') + 62 * 86400000).toISOString().slice(0, 10);
const ids = {
  cny: '11111111-1111-4111-8111-111111111111', zero: '22222222-2222-4222-8222-222222222222',
  usd: '33333333-3333-4333-8333-333333333333', jpy: '44444444-4444-4444-8444-444444444444',
  family: '55555555-5555-4555-8555-555555555555', loan: '66666666-6666-4666-8666-666666666666',
  archived: '77777777-7777-4777-8777-777777777777', bob: '88888888-8888-4888-8888-888888888888',
};
type GoalView = ReturnType<typeof goalRules.buildFinanceGoalView>;
interface GoalResponse { goal: GoalView }
interface ListResponse { ledger: string; currency: string; today: string; goals: GoalView[]; accounts: { id: string }[] }
interface ApiError { code: string; error: string }
async function readGoal(response: Response): Promise<GoalResponse> { return await response.json() as GoalResponse; }
async function readList(response: Response): Promise<ListResponse> { return await response.json() as ListResponse; }
async function readError(response: Response): Promise<ApiError> { return await response.json() as ApiError; }

function loadExports(path: URL, bindings: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
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
  let beforeNextBatch: (() => void) | null = null;
  const queries: string[] = [];
  const adapter = {
    prepare(sql: string) {
      queries.push(sql);
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound: LocalStatement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        async run() { return bound.execute(); },
        execute() { return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } } : { results: [], meta: { changes: Number(statement.run(...values).changes) } }; },
      };
      return bound;
    },
    async batch(statements: LocalStatement[]) {
      const action = beforeNextBatch; beforeNextBatch = null; action?.();
      sqlite.exec('BEGIN');
      try { const results = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const db = adapter as unknown as D1Database;
  const env: { DB?: D1Database } = { DB: db };
  let owner: string | null = 'alice';
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTUser: async () => owner ? { userId: owner } : null,
  }, ['apiUser', 'json', 'isSameOrigin']);
  const financeShared = loadExports(new URL('../_shared.ts', import.meta.url), {
    ...shared, ...balanceChanges, ...finance, ...financeStore,
  }, ['apiUser', 'json', 'financeError', 'financeUnauthenticated', 'financeNotFound', 'financeBody', 'financeIdempotencyKey', 'invalidFinanceIdempotencyKey', 'guardFinanceWrite', 'validAccountId', 'ledgerFromRequest']);
  const baseBindings = { ...financeShared, ...finance, ...financeStore, ...goalRules, ...goalStore, env };
  const goalsShared = loadExports(new URL('./_shared.ts', import.meta.url), baseBindings, ['goalsDatabase', 'goalsError', 'goalNotFound', 'goalAccounts', 'presentGoal']);
  const bindings = { ...baseBindings, ...goalsShared };
  const route = loadExports(new URL('./route.ts', import.meta.url), bindings, ['GET', 'POST']) as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> };
  const itemRoute = loadExports(new URL('./[id]/route.ts', import.meta.url), bindings, ['PATCH']) as { PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> };
  for (const [key, currency, type, userId, ledger, amountMinor] of [
    ['cny', 'CNY', 'bank', 'alice', 'personal', '9007199254740993'], ['zero', 'CNY', 'bank', 'alice', 'personal', '0'],
    ['usd', 'USD', 'investment', 'alice', 'personal', '20000'], ['jpy', 'JPY', 'bank', 'alice', 'personal', '500'],
    ['family', 'CNY', 'bank', 'alice', 'family', '1000'], ['loan', 'CNY', 'loan', 'alice', 'personal', '10000'],
    ['archived', 'CNY', 'bank', 'alice', 'personal', '10000'], ['bob', 'CNY', 'bank', 'bob', 'personal', '77700'],
  ] as const) {
    await financeStore.createFinanceAccount(db, userId, { ledger, currency, type, name: key, note: '', amountMinor, asOfDate: TODAY }, new Date().toISOString(), ids[key]);
  }
  await financeStore.patchFinanceAccount(db, 'alice', ids.archived, { archived: true });
  queries.length = 0;
  function request(method: string, path: string, body: unknown, key?: string, origin: string | null = ORIGIN) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (origin !== null) headers.set('Origin', origin);
    if (key) headers.set('Idempotency-Key', key);
    return new Request(ORIGIN + path, { method, headers, body: JSON.stringify(body) });
  }
  return {
    sqlite, db, env, queries,
    signIn(userId: string | null) { owner = userId; },
    beforeBatch(action: () => void) { beforeNextBatch = action; },
    get(query = 'ledger=personal&currency=all') { return route.GET(new Request(ORIGIN + '/api/finance/goals?' + query)); },
    post(body: unknown, key: string | undefined = crypto.randomUUID(), origin: string | null = ORIGIN) { return route.POST(request('POST', '/api/finance/goals', body, key, origin)); },
    patch(id: string, body: unknown, origin: string | null = ORIGIN) { return itemRoute.PATCH(request('PATCH', '/api/finance/goals/' + id, body, undefined, origin), { params: Promise.resolve({ id }) }); },
    count() { return Number(sqlite.prepare('SELECT count(*) AS total FROM finance_goal_plans').get()?.total); },
  };
}
const input = (patch: Record<string, unknown> = {}) => ({ ledger: 'personal', currency: 'CNY', name: 'Synthetic target', targetAmount: '1000', deadline: FUTURE, accountIds: [ids.zero], ...patch });

test('financial goal reads and writes require sign-in and same-origin submission', async (t) => {
  const f = await fixture(t); f.signIn(null);
  for (const response of [await f.get(), await f.post(input()), await f.patch(crypto.randomUUID(), { name: 'changed' })]) {
    assert.equal(response.status, 401); assert.equal((await readError(response)).code, 'SIGN_IN_REQUIRED'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(f.queries, []); f.signIn('alice');
  assert.equal((await f.post(input(), crypto.randomUUID(), 'https://other.example')).status, 403);
  assert.equal((await f.post(input(), crypto.randomUUID(), null)).status, 403);
  assert.equal(f.count(), 0);
});

test('same-key creation is idempotent, retains later edits and conflicts with changed bodies or owners', async (t) => {
  const f = await fixture(t); const key = crypto.randomUUID(); const body = input();
  const firstResponse = await f.post(body, key); assert.equal(firstResponse.status, 201); const first = (await readGoal(firstResponse)).goal; assert.equal(first.id, key);
  const replay = await f.post(body, key); assert.equal(replay.status, 201); assert.equal((await readGoal(replay)).goal.id, key); assert.equal(f.count(), 1);
  const edited = await f.patch(key, { name: 'Updated target', targetAmount: '2000' }); assert.equal(edited.status, 200);
  const originalReplay = (await readGoal(await f.post(body, key))).goal; assert.equal(originalReplay.name, 'Updated target'); assert.equal(originalReplay.targetMinor, '200000'); assert.equal(f.count(), 1);
  const conflict = await f.post(input({ name: 'Different initial body' }), key); assert.equal(conflict.status, 409); assert.equal((await readError(conflict)).code, 'FINANCE_IDEMPOTENCY_CONFLICT');
  f.signIn('bob'); const foreign = await f.post(input({ accountIds: [ids.bob] }), key); assert.equal(foreign.status, 409); assert.equal((await f.patch(key, { name: 'unauthorized' })).status, 404); assert.equal((await readList(await f.get())).goals.length, 0);
});

test('linked accounts must belong to the owner, ledger and currency and be unarchived assets', async (t) => {
  const f = await fixture(t);
  for (const accountIds of [[], [ids.bob], [ids.family], [ids.usd], [ids.loan], [ids.archived], ['not-an-id']]) {
    const response = await f.post(input({ accountIds })); assert.equal(response.status, 400, JSON.stringify(accountIds));
  }
  assert.equal(f.count(), 0);
  const goal = (await readGoal(await f.post(input()))).goal;
  assert.equal((await f.patch(goal.id, { accountIds: [ids.loan] })).status, 400);
  assert.deepEqual((await readList(await f.get())).goals[0].accountIds, [ids.zero]);
});

test('target money and deadline validation reject zero, coercions, extra precision and impossible dates', async (t) => {
  const f = await fixture(t);
  for (const body of [input({ targetAmount: '0' }), input({ targetAmount: 1000 }), input({ targetAmount: '1.001' }),
    input({ deadline: '2026-02-30' }), input({ deadline: '1969-12-31' }), input({ deadline: '2101-01-01' }),
    input({ currency: 'JPY', accountIds: [ids.jpy], targetAmount: '1.5' }), input({ name: '' })]) {
    const response = await f.post(body); assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(f.count(), 0);
});

test('current amounts, gaps and monthly requirements retain exact minor units and overdue semantics', async (t) => {
  const f = await fixture(t);
  const huge = (await readGoal(await f.post(input({ accountIds: [ids.cny], targetAmount: '90071992547409.94', deadline: TODAY })))).goal;
  assert.equal(huge.targetMinor, '9007199254740994'); assert.equal(huge.currentMinor, '9007199254740993'); assert.equal(huge.gapMinor, '1'); assert.equal(huge.monthlyMinor, '1'); assert.equal(huge.daysRemaining, 0); assert.ok(huge.percent >= 0 && huge.percent <= 100);
  const zero = (await readGoal(await f.post(input({ deadline: TODAY })))).goal; assert.equal(zero.currentMinor, '0'); assert.equal(zero.gapMinor, '100000'); assert.equal(zero.percent, 0);
  const expired = (await readGoal(await f.post(input({ deadline: PAST })))).goal; assert.equal(expired.status, 'overdue'); assert.equal(expired.monthlyMinor, null);
  const jpy = (await readGoal(await f.post(input({ currency: 'JPY', accountIds: [ids.jpy], targetAmount: '1001', deadline: TODAY })))).goal;
  assert.equal(jpy.currentMinor, '500'); assert.equal(jpy.gapMinor, '501'); assert.equal(jpy.monthlyMinor, '501');
});

test('editing preserves fixed ledger/currency and archive/restore keeps associations without moving funds', async (t) => {
  const f = await fixture(t); const goal = (await readGoal(await f.post(input()))).goal;
  for (const patch of [{ currency: 'USD' }, { ledger: 'family' }, { id: crypto.randomUUID() }, {}]) assert.equal((await f.patch(goal.id, patch)).status, 400);
  const archived = await f.patch(goal.id, { archived: true }); assert.equal(archived.status, 200); assert.equal((await readGoal(archived)).goal.archived, true); assert.equal((await readList(await f.get())).goals.length, 0);
  assert.equal((await readList(await f.get('ledger=personal&currency=all&includeArchived=1'))).goals.length, 1);
  assert.equal((await readGoal(await f.patch(goal.id, { archived: false }))).goal.archived, false);
  await financeStore.patchFinanceAccount(f.db, 'alice', ids.zero, { archived: true });
  const updated = (await readGoal(await f.patch(goal.id, { name: 'Retained links' }))).goal; assert.equal(updated.name, 'Retained links'); assert.equal(updated.missingCount, 1); assert.equal(updated.currentMinor, '0');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM finance_balance_entries').get()?.total, 8, 'Goals must never create balance records or transfer funds');
});

test('a linked account archived between validation and write cannot leave a partial goal', async (t) => {
  const f = await fixture(t);
  f.beforeBatch(() => f.sqlite.prepare('UPDATE finance_accounts SET archived_at=? WHERE id=?').run(new Date().toISOString(), ids.zero));
  const response = await f.post(input()); assert.equal(response.status, 400); assert.equal(f.count(), 0);
});

test('list filters and eligible account choices remain scoped to one owner and ledger', async (t) => {
  const f = await fixture(t);
  await f.post(input());
  await f.post(input({ ledger: 'family', accountIds: [ids.family] }));
  await f.post(input({ currency: 'USD', accountIds: [ids.usd] }));
  const archived = (await readGoal(await f.post(input({ name: 'Archived target' })))).goal; await f.patch(archived.id, { archived: true });
  const personal = await readList(await f.get('ledger=personal&currency=CNY'));
  assert.equal(personal.goals.length, 1); assert.deepEqual(new Set(personal.accounts.map((account) => account.id)), new Set([ids.cny, ids.zero, ids.usd, ids.jpy]));
  assert.equal((await readList(await f.get('ledger=family&currency=all'))).goals.length, 1);
  assert.equal((await readList(await f.get('ledger=personal&currency=all&includeArchived=1'))).goals.length, 3);
  f.signIn('bob'); await f.post(input({ accountIds: [ids.bob] })); const other = await readList(await f.get()); assert.equal(other.goals.length, 1); assert.deepEqual(other.accounts.map((account) => account.id), [ids.bob]);
});
