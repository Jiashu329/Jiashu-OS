import { advancedFinanceBookFixture, SHARED_FINANCE_BOOK } from '../../../../tests/fixtures/advanced-finance-book.ts';
import * as balanceChanges from '../../../../db/finance-balance-changes-store.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { FinanceIdempotencyConflictError, FinanceMetadataConflictError } from '../../../../db/finance-store.ts';
import { readFinanceReviewSnapshot } from '../../../../db/finance-review-store.ts';
import { readFinanceDecisionSummary } from '../../../../db/finance-decision-summary.ts';
import { readFinanceMonthCloseBundle, readFinanceMonthCloseOperation, writeFinanceMonthClose } from '../../../../db/finance-month-close-store.ts';
import { financeReviewHash, FinanceCloseConflictError, parseFinanceCloseInput } from '../../../../lib/finance-review-close.ts';
import { FinanceValidationError, LEDGERS, type AccountType, type CurrencyCode, type LedgerKind } from '../../../../lib/finance.ts';
import { buildFinanceReview, parseFinanceReviewQuery, type FinanceReview } from '../../../../lib/finance-review.ts';

const ORIGIN = 'https://synthetic-review.example';
const NOW = new Date('2026-11-09T08:00:00.000Z');
interface ApiError { code: string; error: string }
interface ReviewResponse extends FinanceReview {
  close: { state: 'draft' | 'closed'; version: number; latestVersion: number; previewHash: string | null; versions: { version: number }[] };
}
async function readReview(response: Response): Promise<ReviewResponse> { return await response.json() as ReviewResponse; }
async function readError(response: Response): Promise<ApiError> { return await response.json() as ApiError; }

// Evaluate the actual route with only Worker globals and request identity
// supplied at its boundary. Validation, accounting and SQL execute unchanged.
function loadExports(path: URL, bindings: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
}

interface StatementResult { results: unknown[]; meta: { changes: number } }
interface LocalStatement {
  bind(...parameters: unknown[]): LocalStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  execute(): StatementResult;
}
interface AccountInput {
  id: string; owner?: string; ledger?: LedgerKind; currency?: CurrencyCode;
  type?: AccountType; archivedAt?: string | null;
}

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../../../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  t.after(() => sqlite.close());
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
        execute() {
          if (statement.columns().length) return { results: statement.all(...values), meta: { changes: 0 } };
          return { results: [], meta: { changes: Number(statement.run(...values).changes) } };
        },
      };
      return bound;
    },
    async batch(statements: LocalStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const db = adapter as unknown as Parameters<typeof readFinanceReviewSnapshot>[0];
  const env: { DB?: typeof db } = { DB: db };
  let owner: string | null = 'alice';
  const bookFixture = advancedFinanceBookFixture(db as D1Database, (options, userId) => {
    const table = options.goalId ? 'finance_goal_plans' : options.accountId ? 'finance_accounts' : null;
    if (!table) return undefined;
    return sqlite.prepare('SELECT ledger FROM ' + table + ' WHERE user_id=? AND id=?').get(userId, options.goalId ?? options.accountId!)?.ledger as 'personal' | 'family' | undefined;
  }, () => env.DB !== undefined);
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTUser: async () => owner ? { userId: owner } : null,
  }, ['apiUser', 'json', 'isSameOrigin']);
  const financeShared = loadExports(new URL('../_shared.ts', import.meta.url), {
    ...shared, ...balanceChanges, ...bookFixture, FinanceValidationError, LEDGERS, FinanceIdempotencyConflictError, FinanceMetadataConflictError,
  }, ['apiUser', 'json', 'financeError', 'financeUnauthenticated', 'financeBody', 'financeIdempotencyKey', 'guardFinanceWrite', 'invalidFinanceIdempotencyKey']);
  const route = loadExports(new URL('./route.ts', import.meta.url), {
    ...financeShared, ...bookFixture, env, readFinanceReviewSnapshot, buildFinanceReview, FinanceValidationError,
    readFinanceMonthCloseBundle, financeReviewHash, readFinanceDecisionSummary,
    parseFinanceReviewQuery: (params: URLSearchParams) => parseFinanceReviewQuery(params, NOW),
  }, ['GET']) as { GET(request: Request): Promise<Response> };
  const closeRoute = loadExports(new URL('./close/route.ts', import.meta.url), {
    ...financeShared, ...bookFixture, env, readFinanceReviewSnapshot, buildFinanceReview, readFinanceMonthCloseOperation, writeFinanceMonthClose, FinanceValidationError,
    financeReviewHash, FinanceCloseConflictError,
    parseFinanceCloseInput: (input: unknown) => parseFinanceCloseInput(input, NOW),
  }, ['POST']) as { POST(request: Request): Promise<Response> };
  const accountOwners = new Map<string, string>();
  function account(input: AccountInput) {
    const userId = input.owner ?? 'alice';
    sqlite.prepare(`INSERT INTO finance_accounts
      (id,user_id,ledger,name,type,currency,note,created_at,updated_at,archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.id, userId, input.ledger ?? 'personal', input.id,
        input.type ?? 'bank', input.currency ?? 'CNY', '', NOW.toISOString(), NOW.toISOString(), input.archivedAt ?? null);
    accountOwners.set(input.id, userId);
  }
  let sequence = 0;
  function balance(accountId: string, amountMinor: string, asOfDate: string, options: { owner?: string; createdAt?: string } = {}) {
    sqlite.prepare(`INSERT INTO finance_balance_entries
      (id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('synthetic-balance-' + (++sequence), options.owner ?? accountOwners.get(accountId) ?? 'alice', accountId,
        amountMinor, asOfDate, '', options.createdAt ?? NOW.toISOString());
  }
  return {
    sqlite, env, queries, account, balance, bookFixture,
    signIn(userId: string | null) { owner = userId; },
    get(query = 'ledger=personal&currency=CNY&month=2026-11') {
      return route.GET(new Request(ORIGIN + '/api/finance/review?' + query));
    },
    close(body: unknown, key = crypto.randomUUID(), origin = ORIGIN, query = '') {
      return closeRoute.POST(new Request(ORIGIN + '/api/finance/review/close' + (query ? '?' + query : ''), {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body),
      }));
    },
  };
}

test('monthly review requires sign-in and keeps responses private', async (t) => {
  const f = fixture(t);
  f.signIn(null);
  const response = await f.get();
  assert.equal(response.status, 401);
  assert.equal((await readError(response)).code, 'SIGN_IN_REQUIRED');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.deepEqual(f.queries, []);
});

test('invalid months, ledgers and currencies are rejected before querying balances', async (t) => {
  const f = fixture(t);
  for (const query of [
    'ledger=personal&currency=CNY&month=1969-12',
    'ledger=personal&currency=CNY&month=2026-00',
    'ledger=personal&currency=CNY&month=2026-13',
    'ledger=personal&currency=CNY&month=2026-1',
    'ledger=personal&currency=CNY&month=2026-12',
    'ledger=business&currency=CNY&month=2026-11',
    'ledger=personal&currency=BTC&month=2026-11',
  ]) {
    const response = await f.get(query);
    assert.equal(response.status, 400, query);
    assert.equal((await readError(response)).code, 'INVALID_FINANCE_DATA');
  }
  assert.deepEqual(f.queries, []);
});

test('owners, ledgers, currencies and archived accounts remain separate in review totals', async (t) => {
  const f = fixture(t);
  for (const input of [
    { id: 'alice-bank' },
    { id: 'alice-usd', currency: 'USD' as const },
    { id: 'alice-family', ledger: 'family' as const },
    { id: 'bob-bank', owner: 'bob' },
    { id: 'archived-bank', archivedAt: NOW.toISOString() },
  ]) { f.account(input); f.balance(input.id, '10000', '2026-10-20'); }
  f.balance('alice-bank', '12500', '2026-11-08');
  // A mismatched tenant row must not leak through an account-id-only join.
  f.balance('alice-bank', '999999999', '2026-11-09', { owner: 'bob' });
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await readReview(response);
  assert.equal(data.snapshot.netMinor, '12500');
  assert.equal(data.previous.netMinor, '10000');
  assert.equal(data.change.netMinor, '2500');
  assert.deepEqual(data.accounts.map((row) => row.accountId), ['alice-bank']);
  assert.deepEqual(new Set(data.availableCurrencies), new Set(['CNY', 'USD']));
  const usd = await readReview(await f.get('ledger=personal&currency=USD&month=2026-11'));
  assert.equal(usd.snapshot.netMinor, '10000');
  const family = await readReview(await f.get('ledger=family&currency=CNY&month=2026-11'));
  assert.equal(family.snapshot.netMinor, '10000');
  f.signIn('bob');
  const other = await readReview(await f.get());
  assert.equal(other.snapshot.netMinor, '10000');
  assert.deepEqual(other.accounts.map((row) => row.accountId), ['bob-bank']);
});

test('historical selection follows balance date, same-day sequence and month-end carry-forward', async (t) => {
  const f = fixture(t);
  f.account({ id: 'bank' });
  f.balance('bank', '10000', '2026-09-30');
  f.balance('bank', '15000', '2026-10-20', { createdAt: '2026-11-09T08:00:00Z' });
  f.balance('bank', '16000', '2026-10-20', { createdAt: '2026-11-01T08:00:00Z' });
  f.balance('bank', '999', '2026-10-01', { createdAt: '2026-11-09T09:00:00Z' });
  f.balance('bank', '20000', '2026-11-10');
  const october = await readReview(await f.get('ledger=personal&currency=CNY&month=2026-10'));
  assert.equal(october.cutoffDay, '2026-10-31');
  assert.equal(october.snapshot.netMinor, '16000');
  assert.equal(october.previous.netMinor, '10000');
  assert.equal(october.accounts[0].currentAsOfDate, '2026-10-20');
  const november = await readReview(await f.get());
  assert.equal(november.today, '2026-11-09');
  assert.equal(november.cutoffDay, '2026-11-09');
  assert.equal(november.snapshot.netMinor, '16000', 'future-dated balances are excluded from a partial current month');
  assert.equal(november.change.comparableNetMinor, '0');
  assert.equal(november.accounts[0].carried, true);
  assert.equal(november.snapshot.carriedAccountCount, 1);
});

test('newly recorded accounts are separated from comparable net-asset changes', async (t) => {
  const f = fixture(t);
  f.account({ id: 'existing-bank' });
  f.balance('existing-bank', '10000', '2026-10-31');
  f.balance('existing-bank', '11000', '2026-11-08');
  f.account({ id: 'new-bank' });
  f.balance('new-bank', '50000', '2026-11-08');
  const data = await readReview(await f.get());
  assert.equal(data.snapshot.netMinor, '61000');
  assert.equal(data.change.netMinor, '51000');
  assert.equal(data.change.comparableNetMinor, '1000');
  assert.equal(data.change.newNetMinor, '50000');
  const added = data.accounts.find((row) => row.accountId === 'new-bank');
  assert.ok(added);
  assert.equal(added.kind, 'new');
  assert.equal(added.previousMinor, null);
  assert.equal(added.netChangeMinor, null, 'a first recorded balance is not an investment gain');
});

test('zero recorded balances remain comparable while absent history stays unknown', async (t) => {
  const f = fixture(t);
  const empty = await readReview(await f.get());
  assert.equal(empty.snapshot.netMinor, null);
  assert.equal(empty.previous.netMinor, null);
  assert.equal(empty.change.netMinor, null);
  f.account({ id: 'zero-bank' });
  f.balance('zero-bank', '0', '2026-10-31');
  f.balance('zero-bank', '0', '2026-11-09');
  const zero = await readReview(await f.get());
  assert.equal(zero.snapshot.netMinor, '0');
  assert.equal(zero.previous.netMinor, '0');
  assert.equal(zero.change.netMinor, '0');
  assert.equal(zero.accounts[0].kind, 'existing');
});

test('large minor-unit values and liability reductions produce exact signed contributions', async (t) => {
  const f = fixture(t);
  f.account({ id: 'large-bank' });
  f.balance('large-bank', '9007199254740993', '2026-10-31');
  f.balance('large-bank', '9007199254740994', '2026-11-09');
  f.account({ id: 'loan', type: 'loan' });
  f.balance('loan', '5000', '2026-10-31');
  f.balance('loan', '3000', '2026-11-09');
  const data = await readReview(await f.get());
  assert.equal(data.snapshot.assetsMinor, '9007199254740994');
  assert.equal(data.snapshot.liabilitiesMinor, '3000');
  assert.equal(data.snapshot.netMinor, '9007199254737994');
  assert.equal(data.change.netMinor, '2001');
  assert.equal(data.change.comparableNetMinor, '2001');
  assert.equal(data.change.liabilitiesMinor, '-2000');
  const debt = data.accounts.find((row) => row.accountId === 'loan');
  assert.ok(debt);
  assert.equal(debt.netChangeMinor, '2000');
  const point = data.trend.find((row) => row.month === '2026-11');
  assert.ok(point);
  assert.equal(point.netMinor, data.snapshot.netMinor);
});

test('missing storage fails explicitly rather than presenting an empty monthly ledger', async (t) => {
  const f = fixture(t);
  delete f.env.DB;
  const response = await f.get();
  assert.equal(response.status, 503);
  assert.equal((await readError(response)).code, 'FINANCE_UNAVAILABLE');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

void test('confirmed reports remain fixed through account archive, reclassification and later corrections; reclose keeps earlier versions', async (t) => {
  const f = fixture(t);
  f.account({ id: 'bank' }); f.balance('bank', '10000', '2026-10-20');
  const query = 'ledger=personal&currency=CNY&month=2026-10';
  const preview = await readReview(await f.get(query));
  const body = { ledger: 'personal', currency: 'CNY', month: '2026-10', expectedVersion: 0, previewHash: preview.close.previewHash, reason: '' };
  const key = crypto.randomUUID();
  assert.equal((await f.close(body, key)).status, 201);
  f.sqlite.prepare("UPDATE finance_accounts SET archived_at = ?, type = 'loan' WHERE id = 'bank'").run(NOW.toISOString());
  f.balance('bank', '99900', '2026-10-30');
  const fixed = await readReview(await f.get(query));
  assert.equal(fixed.close.state, 'closed'); assert.equal(fixed.close.version, 1);
  assert.equal(fixed.snapshot.netMinor, '10000'); assert.equal(fixed.accounts[0].type, 'bank');
  assert.equal((await f.close(body, key)).status, 200, 'a lost-response retry returns the original result after source changes');
  const live = await readReview(await f.get(query + '&draft=1'));
  assert.equal(live.close.state, 'draft'); assert.equal(live.snapshot.netMinor, null);
  f.sqlite.prepare("UPDATE finance_accounts SET archived_at = NULL WHERE id = 'bank'").run();
  const newPreview = await readReview(await f.get(query + '&draft=1'));
  const reclose = { ...body, expectedVersion: 1, previewHash: newPreview.close.previewHash, reason: '分类与余额已重新核对' };
  assert.equal((await f.close({ ...reclose, reason: '' })).status, 400);
  assert.equal((await f.close(reclose)).status, 201);
  const latest = await readReview(await f.get(query));
  assert.equal(latest.close.version, 2); assert.equal(latest.snapshot.netMinor, '-99900');
  assert.deepEqual(latest.close.versions.map((row) => row.version), [2, 1]);
  const original = await readReview(await f.get(query + '&version=1'));
  assert.equal(original.snapshot.netMinor, '10000'); assert.equal(original.accounts[0].type, 'bank');
  assert.equal((await f.get(query + '&version=99')).status, 404);
});

void test('month-close requires ended month, same-origin identity, matching preview and current expected version', async (t) => {
  const f = fixture(t); f.account({ id: 'bank' }); f.balance('bank', '10000', '2026-10-20');
  const preview = await readReview(await f.get('ledger=personal&currency=CNY&month=2026-10'));
  const body = { ledger: 'personal', currency: 'CNY', month: '2026-10', expectedVersion: 0, previewHash: preview.close.previewHash, reason: '' };
  assert.equal((await f.close(body, crypto.randomUUID(), 'https://other.example')).status, 403);
  assert.equal((await f.close({ ...body, month: '2026-11' })).status, 400);
  assert.equal((await f.close({ ...body, previewHash: '0'.repeat(64) })).status, 409);
  f.balance('bank', '12000', '2026-10-25');
  assert.equal((await f.close(body)).status, 409);
  const fresh = await readReview(await f.get('ledger=personal&currency=CNY&month=2026-10'));
  const current = { ...body, previewHash: fresh.close.previewHash };
  const results = await Promise.all([f.close(current), f.close(current)]);
  assert.deepEqual(results.map((response) => response.status).sort((a, b) => a - b), [201, 409]);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM finance_month_closes').get()!.total, 1);
  f.signIn(null); assert.equal((await f.close(body)).status, 401);
});

void test('closed versions are isolated by owner, ledger and currency and invalid version selectors fail', async (t) => {
  const f = fixture(t); f.account({ id: 'bank' }); f.balance('bank', '10000', '2026-10-20');
  const query = 'ledger=personal&currency=CNY&month=2026-10';
  const preview = await readReview(await f.get(query));
  const body = { ledger: 'personal', currency: 'CNY', month: '2026-10', expectedVersion: 0, previewHash: preview.close.previewHash, reason: '' };
  const key = crypto.randomUUID(); assert.equal((await f.close(body, key)).status, 201);
  assert.equal((await f.close({ ...body, reason: 'changed' }, key)).status, 409);
  assert.equal((await f.get(query + '&version=1&draft=1')).status, 400);
  assert.equal((await f.get(query + '&version=0')).status, 400);
  assert.equal((await f.get('ledger=family&currency=CNY&month=2026-10&version=1')).status, 404);
  assert.equal((await f.get('ledger=personal&currency=USD&month=2026-10&version=1')).status, 404);
  f.signIn('bob'); assert.equal((await f.get(query + '&version=1')).status, 404);
  assert.equal((await readReview(await f.get(query))).close.state, 'draft');
});

test('review API keeps pre-change bank assets after later debt reclassification and archive',async(t)=>{
 const f=fixture(t);f.account({id:'a',type:'loan',archivedAt:'2026-11-06T02:00:00Z'});f.balance('a','10000','2026-10-15');
 for(const [revision,effective,type,archived,origin]of [[1,'1970-01-01','bank',0,'opening'],[2,'2026-11-05','loan',0,'change'],[3,'2026-11-06','loan',1,'change']] as const)f.sqlite.prepare('INSERT INTO finance_account_classifications(user_id,account_id,revision,effective_from,type,archived,origin,recorded_at)VALUES(?,?,?,?,?,?,?,?)').run('alice','a',revision,effective,type,archived,origin,'2026-11-06T02:00:00Z');
 const october=await readReview(await f.get('month=2026-10'));assert.equal(october.snapshot.assetsMinor,'10000');assert.equal(october.snapshot.netMinor,'10000');
 const november=await readReview(await f.get());assert.equal(november.previous.netMinor,'10000');assert.equal(november.snapshot.netMinor,'0');assert.equal(november.change.membershipNetMinor,'-10000');assert.equal(november.trend.find(p=>p.month==='2026-10')!.netMinor,'10000');
 f.signIn('bob');const foreign=await readReview(await f.get());assert.equal(foreign.snapshot.netMinor,null);assert.deepEqual(foreign.historicalAssumptions,[]);
});

void test('month closes include effective corrected balances and dated membership, while later voids preserve the confirmed version', async (t) => {
  const f = fixture(t); f.account({ id: 'bank' }); f.balance('bank', '10000', '2026-09-15'); f.balance('bank', '20000', '2026-10-15');
  f.sqlite.prepare("INSERT INTO finance_account_classifications(user_id,account_id,revision,effective_from,type,archived,origin,recorded_at) VALUES('alice','bank',1,'1970-01-01','bank',0,'opening','2026-09-15T04:00:00Z')").run();
  f.sqlite.prepare("INSERT INTO finance_balance_changes(id,user_id,account_id,entry_id,revision,action,amount_minor,as_of_date,note,reason,request_hash,created_at) VALUES('correction','alice','bank','synthetic-balance-2',1,'correct','25000','2026-10-15','','合成更正','synthetic','2026-11-01T04:00:00Z')").run();
  const query = 'ledger=personal&currency=CNY&month=2026-10';
  const preview = await readReview(await f.get(query)); assert.equal(preview.snapshot.netMinor, '25000');
  const body = { ledger: 'personal', currency: 'CNY', month: '2026-10', expectedVersion: 0, previewHash: preview.close.previewHash, reason: '' };
  assert.equal((await f.close(body)).status, 201);
  f.sqlite.prepare("INSERT INTO finance_balance_changes(id,user_id,account_id,entry_id,revision,action,amount_minor,as_of_date,note,reason,request_hash,created_at) VALUES('void','alice','bank','synthetic-balance-2',2,'void',NULL,NULL,NULL,'合成作废','synthetic','2026-11-02T04:00:00Z')").run();
  assert.equal((await readReview(await f.get(query))).snapshot.netMinor, '25000');
  assert.equal((await readReview(await f.get(query + '&draft=1'))).snapshot.netMinor, '10000');
  f.sqlite.prepare("UPDATE finance_accounts SET archived_at='2026-10-25T04:00:00Z' WHERE id='bank'").run();
  f.sqlite.prepare("INSERT INTO finance_account_classifications(user_id,account_id,revision,effective_from,type,archived,origin,recorded_at) VALUES('alice','bank',2,'2026-10-25','bank',1,'change','2026-10-25T04:00:00Z')").run();
  const zero = await readReview(await f.get(query + '&draft=1'));
  assert.equal(zero.snapshot.accountCount, 0); assert.equal(zero.snapshot.netMinor, '0');
  assert.equal((await f.close({ ...body, expectedVersion: 1, previewHash: zero.close.previewHash, reason: '确认已归档空账本' })).status, 201);
  const fixed = await readReview(await f.get(query)); assert.equal(fixed.close.version, 2); assert.equal(fixed.snapshot.netMinor, '0');
  assert.equal(fixed.change.membershipNetMinor, '-10000');
  assert.equal((await readReview(await f.get(query + '&version=1'))).snapshot.netMinor, '25000');
});

void test('shared family review and closes preserve owner scope, preview CAS and the member actor boundary',async(t)=>{
  const f=fixture(t),book='book='+SHARED_FINANCE_BOOK,query='ledger=family&currency=CNY&month=2026-10&'+book;
  f.account({id:'family-bank',ledger:'family'});f.balance('family-bank','12300','2026-10-20');
  f.account({id:'private-bank'});f.balance('private-bank','99900','2026-10-20');
  f.signIn('bob');f.env.DB={prepare(){throw new Error('Unscoped database must not be used');}} as unknown as D1Database;
  const preview=await readReview(await f.get(query));assert.equal(preview.snapshot.netMinor,'12300');
  assert.deepEqual(preview.accounts.map((account)=>account.accountId),['family-bank']);
  const body={ledger:'family',currency:'CNY',month:'2026-10',expectedVersion:0,previewHash:preview.close.previewHash,reason:''},key=crypto.randomUUID();
  assert.equal((await f.close(body,key,ORIGIN,book)).status,409);
  assert.equal((await f.close(body,key,ORIGIN,book+'&bookRevision=2')).status,409);
  assert.equal((await f.close({...body,previewHash:'0'.repeat(64)},key,ORIGIN,book+'&bookRevision=3')).status,409);
  assert.equal((await f.close(body,key,ORIGIN,book+'&bookRevision=3')).status,201);
  assert.equal((await f.close(body,key,ORIGIN,book+'&bookRevision=3')).status,200);
  const write=f.bookFixture.calls.findLast((call)=>call.options.write);
  assert.equal(write?.actorUserId,'bob');assert.equal(write?.ownerUserId,'alice');assert.equal(write?.options.write?.action,'review.close');assert.equal(write?.options.write?.operationId,key);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM finance_month_closes').get()?.user_id,'alice');
  assert.equal((await f.get('ledger=personal&month=2026-10&'+book)).status,400);
  f.bookFixture.revoke();assert.equal((await f.get(query)).status,403);assert.equal((await f.close(body,key,ORIGIN,book+'&bookRevision=3')).status,403);
});
