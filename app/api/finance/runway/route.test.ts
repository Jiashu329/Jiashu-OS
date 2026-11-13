import { advancedFinanceBookFixture, SHARED_FINANCE_BOOK } from '../../../../tests/fixtures/advanced-finance-book.ts';
import * as balanceChanges from '../../../../db/finance-balance-changes-store.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import * as finance from '../../../../lib/finance.ts';
import * as financeStore from '../../../../db/finance-store.ts';
import * as runwayRules from '../../../../lib/finance-runway.ts';
import * as runwayStore from '../../../../db/finance-runway-store.ts';

const ORIGIN = 'https://synthetic-runway.example';
const ids = {
  cny: '11111111-1111-4111-8111-111111111111', zero: '22222222-2222-4222-8222-222222222222',
  usd: '33333333-3333-4333-8333-333333333333', jpy: '44444444-4444-4444-8444-444444444444',
  family: '55555555-5555-4555-8555-555555555555', loan: '66666666-6666-4666-8666-666666666666',
  archived: '77777777-7777-4777-8777-777777777777', bob: '88888888-8888-4888-8888-888888888888',
};
type RunwayResponse = ReturnType<typeof runwayRules.buildFinanceRunwayView> & {
  ledger: string; currency: string; today: string; accounts: { id: string }[];
};
interface ApiError { code: string; error: string }
async function readRunway(response: Response): Promise<RunwayResponse> { return await response.json() as RunwayResponse; }
async function readError(response: Response): Promise<ApiError> { return await response.json() as ApiError; }
function loadExports(path: URL, bindings: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
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
  const queries: string[] = [];
  let beforeWrite: (() => void) | null = null;
  const adapter = {
    prepare(sql: string) {
      queries.push(sql);
      const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      function runHook() { if (/^\s*(INSERT|UPDATE)/i.test(sql) && sql.includes('finance_runway_settings')) { const action = beforeWrite; beforeWrite = null; action?.(); } }
      const bound: LocalStatement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { runHook(); return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { runHook(); return { results: statement.all(...values) as T[] }; },
        async run() { return bound.execute(); },
        execute() { runHook(); return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } } : { results: [], meta: { changes: Number(statement.run(...values).changes) } }; },
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
  const env: { DB?: D1Database } = { DB: db };
  let owner: string | null = 'alice';
  const bookFixture = advancedFinanceBookFixture(db as D1Database, (options, userId) => {
    const table = options.goalId ? 'finance_goal_plans' : options.accountId ? 'finance_accounts' : null;
    if (!table) return undefined;
    return sqlite.prepare('SELECT ledger FROM ' + table + ' WHERE user_id=? AND id=?').get(userId, options.goalId ?? options.accountId!)?.ledger as 'personal' | 'family' | undefined;
  }, () => env.DB !== undefined);
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), { getChatGPTUser: async () => owner ? { userId: owner } : null }, ['apiUser', 'json', 'isSameOrigin']);
  const financeShared = loadExports(new URL('../_shared.ts', import.meta.url), { ...shared, ...balanceChanges, ...finance, ...financeStore, ...bookFixture }, ['apiUser', 'json', 'financeError', 'financeUnauthenticated', 'financeBody', 'guardFinanceWrite']);
  const route = loadExports(new URL('./route.ts', import.meta.url), { ...financeShared, ...finance, ...financeStore, ...runwayRules, ...runwayStore, ...bookFixture, env }, ['GET', 'PUT']) as { GET(request: Request): Promise<Response>; PUT(request: Request): Promise<Response> };
  for (const [key, currency, type, userId, ledger, amountMinor] of [
    ['cny', 'CNY', 'bank', 'alice', 'personal', '9007199254740993'], ['zero', 'CNY', 'bank', 'alice', 'personal', '0'],
    ['usd', 'USD', 'investment', 'alice', 'personal', '20000'], ['jpy', 'JPY', 'bank', 'alice', 'personal', '500'],
    ['family', 'CNY', 'bank', 'alice', 'family', '1000'], ['loan', 'CNY', 'loan', 'alice', 'personal', '10000'],
    ['archived', 'CNY', 'bank', 'alice', 'personal', '10000'], ['bob', 'CNY', 'bank', 'bob', 'personal', '77700'],
  ] as const) await financeStore.createFinanceAccount(db, userId, { ledger, currency, type, name: key, note: '', amountMinor, asOfDate: finance.todayShanghai() }, new Date().toISOString(), ids[key]);
  await financeStore.patchFinanceAccount(db, 'alice', ids.archived, { expectedRevision: 1, archived: true }); queries.length = 0;
  return {
    sqlite, db, env, queries, bookFixture,
    signIn(userId: string | null) { owner = userId; },
    beforeWrite(action: () => void) { beforeWrite = action; },
    get(query = 'ledger=personal&currency=CNY') { return route.GET(new Request(ORIGIN + '/api/finance/runway?' + query)); },
    put(body: unknown, query = 'ledger=personal&currency=CNY', origin: string | null = ORIGIN) {
      const headers = new Headers({ 'Content-Type': 'application/json' }); if (origin !== null) headers.set('Origin', origin);
      return route.PUT(new Request(ORIGIN + '/api/finance/runway?' + query, { method: 'PUT', headers, body: JSON.stringify(body) }));
    },
    count() { return Number(sqlite.prepare('SELECT count(*) AS total FROM finance_runway_settings').get()?.total); },
  };
}
const input = (patch: Record<string, unknown> = {}) => ({ monthlyExpenseAmount: '100', targetMonths: 6, accountIds: [ids.zero], expectedRevision: 0, ...patch });

test('runway reads and writes require sign-in and writes require the same origin', async (t) => {
  const f = await fixture(t); f.signIn(null);
  for (const response of [await f.get(), await f.put(input())]) { assert.equal(response.status, 401); assert.equal((await readError(response)).code, 'SIGN_IN_REQUIRED'); assert.equal(response.headers.get('Cache-Control'), 'no-store'); }
  assert.deepEqual(f.queries, []); f.signIn('alice'); assert.equal((await f.put(input(), undefined, 'https://other.example')).status, 403); assert.equal((await f.put(input(), undefined, null)).status, 403); assert.equal(f.count(), 0);
});

test('unconfigured reserves stay unset and eligible choices exclude other owners, scopes, debts and archives', async (t) => {
  const f = await fixture(t); const response = await f.get(); assert.equal(response.status, 200); const data = await readRunway(response);
  assert.equal(data.settings, null); assert.equal(data.progress, null); assert.deepEqual(new Set(data.accounts.map((account) => account.id)), new Set([ids.cny, ids.zero])); assert.equal(f.count(), 0);
  for (const query of ['ledger=business&currency=CNY', 'ledger=personal&currency=BTC']) assert.equal((await f.get(query)).status, 400);
});

test('runway revision is explicit and two-tab conflicts return 409 without overwriting saved data', async (t) => {
  const f = await fixture(t);
  assert.equal(((await f.get()).status), 200);
  assert.equal((await f.put({ monthlyExpenseAmount: '100', targetMonths: 6, accountIds: [ids.zero] })).status, 400);
  for (const expectedRevision of [-1, '0', 0.5, null]) assert.equal((await f.put(input({ expectedRevision }))).status, 400);
  const initial = await readRunway(await f.put(input())); assert.equal(initial.settings?.revision, 1);
  const changed = await readRunway(await f.put(input({ targetMonths: 8, expectedRevision: 1 }))); assert.equal(changed.settings?.revision, 2);
  const conflict = await f.put(input({ targetMonths: 99, expectedRevision: 1 })); assert.equal(conflict.status, 409);
  assert.equal((await readError(conflict)).code, 'FINANCE_RUNWAY_CONFLICT');
  const saved = await readRunway(await f.get()); assert.equal(saved.settings?.targetMonths, 8); assert.equal(saved.settings?.revision, 2);
});

test('saving and replacing reserve settings does not duplicate rows or change account balances', async (t) => {
  const f = await fixture(t); const firstResponse = await f.put(input()); assert.equal(firstResponse.status, 200); const first = await readRunway(firstResponse); assert.ok(first.settings); assert.ok(first.progress); assert.equal(first.settings.monthlyExpenseMinor, '10000'); assert.equal(first.progress.currentMinor, '0'); assert.equal(first.progress.runwayMonths, '0.00'); assert.equal(first.progress.gapMinor, '60000');
  assert.equal((await f.put(input({ expectedRevision: 1 }))).status, 200); assert.equal(f.count(), 1); const updated = await readRunway(await f.put(input({ monthlyExpenseAmount: '125.50', targetMonths: 9, expectedRevision: 2 }))); assert.ok(updated.settings); assert.equal(updated.settings.monthlyExpenseMinor, '12550'); assert.equal(updated.settings.targetMonths, 9); assert.equal(f.count(), 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM finance_balance_entries').get()?.total, 8);
});

test('account selection rejects mismatched owners, currencies, ledgers, debts and archived accounts', async (t) => {
  const f = await fixture(t);
  for (const accountIds of [[], [ids.bob], [ids.family], [ids.usd], [ids.loan], [ids.archived], ['invalid']]) { const response = await f.put(input({ accountIds })); assert.equal(response.status, 400, JSON.stringify(accountIds)); assert.equal((await readError(response)).code, 'INVALID_FINANCE_RUNWAY'); }
  assert.equal(f.count(), 0);
});

test('expense and month validation reject zero, coercions, fractional months and malformed money', async (t) => {
  const f = await fixture(t);
  for (const body of [input({ monthlyExpenseAmount: '0' }), input({ monthlyExpenseAmount: 100 }), input({ monthlyExpenseAmount: '1.001' }), input({ targetMonths: 0 }), input({ targetMonths: 1.5 }), input({ targetMonths: '6' }), input({ targetMonths: Number.MAX_SAFE_INTEGER + 1 }), input({ userId: 'bob' })]) assert.equal((await f.put(body)).status, 400, JSON.stringify(body));
  assert.equal((await f.put(input({ monthlyExpenseAmount: '1.5', accountIds: [ids.jpy] }), 'ledger=personal&currency=JPY')).status, 400); assert.equal(f.count(), 0);
});

test('extreme balances, fractional coverage and JPY retain exact string arithmetic', async (t) => {
  const f = await fixture(t);
  const huge = await readRunway(await f.put(input({ monthlyExpenseAmount: '0.01', accountIds: [ids.cny] }))); assert.ok(huge.progress); assert.equal(huge.progress.currentMinor, '9007199254740993'); assert.equal(huge.progress.runwayWholeMonths, '9007199254740993'); assert.equal(huge.progress.runwayMonths, '9007199254740993.00'); assert.equal(huge.progress.gapMinor, '0');
  const jpy = await readRunway(await f.put(input({ monthlyExpenseAmount: '300', targetMonths: 3, accountIds: [ids.jpy] }), 'ledger=personal&currency=JPY')); assert.ok(jpy.progress); assert.equal(jpy.progress.currentMinor, '500'); assert.equal(jpy.progress.runwayMonths, '1.66'); assert.equal(jpy.progress.runwayWholeMonths, '1'); assert.equal(jpy.progress.runwayRemainderMinor, '200'); assert.equal(jpy.progress.targetMinor, '900'); assert.equal(jpy.progress.gapMinor, '400');
});

test('unchanged invalid links can be retained for expense edits, while failed re-selection leaves settings unchanged', async (t) => {
  const f = await fixture(t); await f.put(input()); await financeStore.patchFinanceAccount(f.db, 'alice', ids.zero, { expectedRevision: 1, archived: true });
  const edited = await readRunway(await f.put(input({ monthlyExpenseAmount: '200', targetMonths: 9, expectedRevision: 1 }))); assert.ok(edited.progress); assert.ok(edited.settings); assert.equal(edited.progress.missingCount, 1); assert.equal(edited.progress.currentMinor, '0'); assert.equal(edited.settings.monthlyExpenseMinor, '20000');
  f.beforeWrite(() => f.sqlite.prepare('UPDATE finance_accounts SET archived_at=? WHERE id=?').run(new Date().toISOString(), ids.cny));
  assert.equal((await f.put(input({ accountIds: [ids.cny], monthlyExpenseAmount: '999', expectedRevision: 2 }))).status, 400);
  const retained = await readRunway(await f.get()); assert.ok(retained.settings); assert.equal(retained.settings.monthlyExpenseMinor, '20000'); assert.deepEqual(retained.settings.accountIds, [ids.zero]); assert.equal(f.count(), 1);
});

test('reserve settings remain independent for every owner, ledger and currency', async (t) => {
  const f = await fixture(t); await f.put(input()); await f.put(input({ accountIds: [ids.usd], monthlyExpenseAmount: '50' }), 'ledger=personal&currency=USD'); await f.put(input({ accountIds: [ids.family], monthlyExpenseAmount: '5' }), 'ledger=family&currency=CNY'); f.signIn('bob'); await f.put(input({ accountIds: [ids.bob], monthlyExpenseAmount: '70' }));
  const bob = await readRunway(await f.get()); assert.ok(bob.settings); assert.equal(bob.settings.monthlyExpenseMinor, '7000'); assert.deepEqual(bob.accounts.map((account) => account.id), [ids.bob]); f.signIn('alice');
  const personal = await readRunway(await f.get()); assert.ok(personal.settings); assert.equal(personal.settings.monthlyExpenseMinor, '10000'); const family = await readRunway(await f.get('ledger=family&currency=CNY')); assert.ok(family.settings); assert.equal(family.settings.monthlyExpenseMinor, '500'); assert.equal(f.count(), 4);
});

test('runway returns exact reviewed liquidity contributions without rewriting saved selection or targets',async(t)=>{
 const f=await fixture(t);const initial=await readRunway(await f.put(input({accountIds:[ids.cny]})));assert.equal(initial.settings!.targetMonths,6);
 f.sqlite.prepare("UPDATE finance_accounts SET liquidity_kind='restricted',usable_bps=3333 WHERE id=?").run(ids.cny);
 const reviewed=await readRunway(await f.get());assert.equal(reviewed.progress!.nominalMinor,'9007199254740993');assert.equal(reviewed.progress!.currentMinor,(BigInt('9007199254740993')*BigInt(3333)/BigInt(10000)).toString());
 f.sqlite.prepare("UPDATE finance_accounts SET liquidity_kind='unreviewed',usable_bps=0 WHERE id=?").run(ids.cny);
 const unreviewed=await readRunway(await f.get());assert.equal(unreviewed.progress!.currentMinor,'0');assert.equal(unreviewed.progress!.unreviewedMinor,'9007199254740993');assert.equal(unreviewed.progress!.excludedMinor,'9007199254740993');assert.equal(unreviewed.settings!.revision,initial.settings!.revision);assert.deepEqual(unreviewed.settings!.accountIds,[ids.cny]);assert.equal(unreviewed.settings!.monthlyExpenseMinor,'10000');assert.equal(unreviewed.settings!.targetMonths,6);
});

void test('shared family runway reads and writes the book owner while requiring the editor current membership version',async(t)=>{
  const f=await fixture(t),query='ledger=family&currency=CNY&book='+SHARED_FINANCE_BOOK;
  await f.put(input({accountIds:[ids.family]}),'ledger=family&currency=CNY');
  f.signIn('bob');f.env.DB={prepare(){throw new Error('Unscoped database must not be used');}} as unknown as D1Database;
  const selected=await readRunway(await f.get(query));assert.deepEqual(selected.accounts.map((account)=>account.id),[ids.family]);
  assert.deepEqual(selected.settings?.accountIds,[ids.family]);
  const command=input({accountIds:[ids.family],expectedRevision:1,targetMonths:9});
  assert.equal((await f.put(command,query)).status,409);assert.equal((await f.put(command,query+'&bookRevision=2')).status,409);
  assert.equal((await f.put(command,query+'&bookRevision=3')).status,200);
  const write=f.bookFixture.calls.findLast((call)=>call.options.write);
  assert.equal(write?.actorUserId,'bob');assert.equal(write?.ownerUserId,'alice');assert.equal(write?.options.write?.action,'runway.update');
  assert.equal(f.sqlite.prepare("SELECT target_months FROM finance_runway_settings WHERE user_id='alice' AND ledger='family'").get()?.target_months,9);
  assert.equal((await f.get('ledger=personal&book='+SHARED_FINANCE_BOOK)).status,400);
  f.bookFixture.revoke();assert.equal((await f.get(query)).status,403);assert.equal((await f.put(command,query+'&bookRevision=3')).status,403);
});
