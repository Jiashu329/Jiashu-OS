import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as finance from '../../../../lib/finance.ts';
import * as changes from '../../../../lib/finance-balance-change.ts';
import * as stores from '../../../../db/finance-store.ts';
import * as changeStores from '../../../../db/finance-balance-changes-store.ts';
import { FinanceBookError, type FinanceBookScope } from '../../../../lib/finance-books.ts';

const ORIGIN = 'https://synthetic-finance-book.example';
const BOOK = '11111111-aaaa-4111-8111-111111111111';
const OWNER_PERSONAL = '22222222-aaaa-4222-8222-222222222222';
const OWNER_FAMILY = '33333333-aaaa-4333-8333-333333333333';
const MEMBER_PERSONAL = '44444444-aaaa-4444-8444-444444444444';
const TODAY = finance.todayShanghai();

function load(path: URL, bindings: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  return runInNewContext('(() => {\n' + source + '\nreturn {' + names.join(',') + '};})()', { ...bindings, JSON, Object, Response, Request, Headers, URL, URLSearchParams, crypto, TextEncoder, TextDecoder, console }) as Record<string, unknown>;
}
interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<Result>; execute(): Result }
interface Result { results: unknown[]; meta: { changes: number } }
interface ScopeOptions { ledger?: 'personal' | 'family'; accountId?: string; write?: { action: string; input: unknown; operationId?: string; targetId?: string } }
type Route = { GET(request: Request, context?: { params: Promise<{ id: string; entryId?: string }> }): Promise<Response>; POST: Route['GET']; PATCH: Route['GET'] };

async function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../../../../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
  function adapter(check = () => {}) {
    return {
      prepare(sql: string) {
        const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
        const bound: Statement = {
          bind(...args) { values = args as SQLInputValue[]; return bound; },
          async first<T>() { check(); return (statement.get(...values) as T | undefined) ?? null; },
          async all<T>() { check(); return { results: statement.all(...values) as T[] }; },
          async run() { return bound.execute(); },
          execute() { check(); return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } } : { results: [], meta: { changes: Number(statement.run(...values).changes) } }; },
        }; return bound;
      },
      async batch(statements: Statement[]) {
        check(); sqlite.exec('BEGIN');
        try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    } as unknown as D1Database;
  }
  const raw = adapter();
  for (const [id, owner, ledger, amountMinor] of [[OWNER_PERSONAL, 'owner', 'personal', '999900'], [OWNER_FAMILY, 'owner', 'family', '10000'], [MEMBER_PERSONAL, 'member', 'personal', '5000']] as const) {
    await stores.createFinanceAccount(raw, owner, { ledger, name: id, type: 'bank', currency: 'CNY', note: '', amountMinor, asOfDate: TODAY }, undefined, id);
  }
  let actor: string | null = 'member'; let active = true; let revokeAtWrite = false;
  const scopeCalls: { options: ScopeOptions; scope: FinanceBookScope }[] = [];
  // This mock isolates the API/repository contract: all real persistence executes
  // through the returned DB, whose guard can revoke access after scope resolution.
  const financeRequestScope = async (request: Request, user: { userId: string }, options: ScopeOptions = {}) => {
    const query = new URL(request.url).searchParams; const book = query.get('book');
    const shared = book !== null && book !== 'own';
    if (shared && book !== BOOK) throw new FinanceBookError('FINANCE_BOOK_NOT_FOUND', 404, '找不到账本。');
    if (shared && !active) throw new FinanceBookError('FINANCE_BOOK_ACCESS_REVOKED', 403, '访问权限已撤销。');
    const owner = shared ? 'owner' : user.userId;
    let ledger = options.ledger ?? (shared ? 'family' : 'personal');
    if (options.accountId) {
      const account = sqlite.prepare('SELECT user_id,ledger FROM finance_accounts WHERE id=?').get(options.accountId);
      if (!account || account.user_id !== owner || (shared && account.ledger !== 'family')) throw new FinanceBookError('FINANCE_ACCOUNT_NOT_FOUND', 404, '找不到账户。');
      ledger = account.ledger as 'personal' | 'family';
    }
    if (shared && ledger !== 'family') throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '家庭权限不适用于个人账本。');
    if (shared && options.write && query.get('bookRevision') !== '3') throw new FinanceBookError('FINANCE_BOOK_ACCESS_CHANGED', 409, '访问版本已变化。');
    const scope: FinanceBookScope = { actorUserId: user.userId, actorEmail: user.userId + '@example.test', actorName: user.userId, ownerUserId: owner,
      ledger, bookId: shared ? BOOK : null, role: shared && user.userId !== 'owner' ? 'editor' : 'owner', membershipId: shared ? 'member-grant' : null, accessRevision: shared ? 3 : 0, isSiteOwner: false };
    scopeCalls.push({ options, scope });
    if (options.write && revokeAtWrite) { revokeAtWrite = false; active = false; }
    return { scope, db: adapter(() => { if (shared && !active) throw new FinanceBookError('FINANCE_BOOK_ACCESS_REVOKED', 403, '访问权限已撤销。'); }) };
  };
  const publicFinanceBook = (scope: FinanceBookScope) => ({ id: scope.bookId ?? 'own', role: scope.role, accessRevision: scope.accessRevision, canManageMembers: scope.role === 'owner', canExport: scope.role === 'owner' });
  const shared = load(new URL('../../_shared.ts', import.meta.url), { getChatGPTUser: async () => actor ? { userId: actor } : null }, ['apiUser', 'json', 'isSameOrigin']);
  const financeShared = load(new URL('../_shared.ts', import.meta.url), { ...shared, ...finance, ...stores, ...changeStores, FinanceBookError },
    ['apiUser', 'json', 'financeError', 'financeUnauthenticated', 'financeNotFound', 'financeBody', 'financeIdempotencyKey', 'invalidFinanceIdempotencyKey', 'guardFinanceWrite', 'validAccountId', 'ledgerFromRequest']);
  // Any accidental fallback to env.DB fails the test, including post-write details.
  const env = { get DB(): D1Database { throw new Error('API bypassed the scoped database'); } };
  const repository = load(new URL('../../../../db/finance-repository.ts', import.meta.url), { ...finance, ...stores, ...changeStores, env },
    ['financeOverview', 'financeAccountDetails', 'previewBalanceChange', 'applyBalanceChange', 'newFinanceAccount', 'updateFinanceAccount', 'newFinanceBalance', 'financeExport']);
  const bindings = { ...finance, ...changes, ...financeShared, ...repository, financeRequestScope, publicFinanceBook, readWithDeadline: async (value: Promise<unknown>) => value };
  const create = load(new URL('./route.ts', import.meta.url), bindings, ['POST']) as Route;
  const item = load(new URL('./[id]/route.ts', import.meta.url), bindings, ['GET', 'PATCH']) as Route;
  const balance = load(new URL('./[id]/balances/route.ts', import.meta.url), bindings, ['POST']) as Route;
  const change = load(new URL('./[id]/balances/[entryId]/route.ts', import.meta.url), bindings, ['POST']) as Route;
  const preview = load(new URL('./[id]/balances/[entryId]/preview/route.ts', import.meta.url), bindings, ['POST']) as Route;
  const overview = load(new URL('../route.ts', import.meta.url), bindings, ['GET']) as Route;
  function request(method: string, path: string, body?: unknown, key = crypto.randomUUID(), origin = ORIGIN) {
    return new Request(ORIGIN + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const query = '?book=' + BOOK + '&bookRevision=3';
  return { sqlite, raw, repository, scopeCalls, request, query,
    signIn(value: string | null) { actor = value; }, revoke() { active = false; }, revokeDuringWrite() { revokeAtWrite = true; },
    get(id = OWNER_FAMILY, suffix = query) { return item.GET(request('GET', '/api/finance/accounts/' + id + suffix), { params: Promise.resolve({ id }) }); },
    patch(id: string, body: unknown, suffix = query) { return item.PATCH(request('PATCH', '/api/finance/accounts/' + id + suffix, body), { params: Promise.resolve({ id }) }); },
    create(body: unknown, key = crypto.randomUUID(), suffix = query) { return create.POST(request('POST', '/api/finance/accounts' + suffix, body, key)); },
    append(id: string, body: unknown, key = crypto.randomUUID(), suffix = query) { return balance.POST(request('POST', '/api/finance/accounts/' + id + '/balances' + suffix, body, key), { params: Promise.resolve({ id }) }); },
    preview(id: string, entryId: string, body: unknown) { return preview.POST(request('POST', '/api/finance/accounts/' + id + '/balances/' + encodeURIComponent(entryId) + '/preview' + query, body), { params: Promise.resolve({ id, entryId }) }); },
    change(id: string, entryId: string, body: unknown, key = crypto.randomUUID()) { return change.POST(request('POST', '/api/finance/accounts/' + id + '/balances/' + encodeURIComponent(entryId) + query, body, key), { params: Promise.resolve({ id, entryId }) }); },
    overview(ledger = 'family', suffix = query) { return overview.GET(request('GET', '/api/finance' + suffix + (suffix ? '&' : '?') + 'ledger=' + ledger)); },
  };
}
const accountInput = () => ({ ledger: 'family', name: '共享合成账户', currency: 'CNY', type: 'bank', note: '', amount: '20.00', asOfDate: TODAY });
const balanceInput = () => ({ amount: '150.00', asOfDate: TODAY, note: '共同核对' });
interface Payload { account: { id: string; balanceMinor: string }; accounts: { id: string }[]; balances: { originalAmountMinor: string }[]; changes: unknown[]; book: { id: string; role: string }; after: { amountMinor: string } }
async function data(response: Response): Promise<Payload> { return await response.json() as Payload; }

void test('shared overview and direct account reads use the owner scope while the viewer keeps independent personal data', async (t) => {
  const f = await fixture(t);
  const overview = await f.overview(); assert.equal(overview.status, 200);
  const shared = await data(overview); assert.deepEqual(shared.accounts.map((account: { id: string }) => account.id), [OWNER_FAMILY]);
  assert.equal(shared.book.id, BOOK); assert.equal(shared.book.role, 'editor');
  const personal = await data(await f.overview('personal', '')); assert.deepEqual(personal.accounts.map((account: { id: string }) => account.id), [MEMBER_PERSONAL]);
  assert.equal((await f.get()).status, 200); assert.equal((await f.get(OWNER_PERSONAL)).status, 404);
  assert.equal((await f.get(OWNER_FAMILY, '')).status, 404);
  assert.equal((await f.overview('personal')).status, 400);
  assert.equal((await f.overview('business')).status, 400);
});

void test('shared account creation cannot switch the owner or ledger and all detail queries retain the guarded DB', async (t) => {
  const f = await fixture(t); const key = crypto.randomUUID();
  const response = await f.create(accountInput(), key); assert.equal(response.status, 201);
  const result = await data(response); assert.equal(result.account.id, key); assert.equal(result.book.id, BOOK);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM finance_accounts WHERE id=?').get(key)?.user_id, 'owner');
  assert.equal((await f.create(accountInput(), key)).status, 201);
  assert.equal((await f.create({ ...accountInput(), ledger: 'personal' })).status, 400);
  assert.equal((await f.create({ ...accountInput(), userId: 'owner' })).status, 400);
  assert.equal((await f.create(accountInput(), crypto.randomUUID(), '?book=' + BOOK)).status, 409);
  const audit = f.scopeCalls.find((call) => call.options.write?.action === 'account.create');
  assert.equal(audit?.scope.actorUserId, 'member'); assert.equal(audit?.scope.ownerUserId, 'owner');
  assert.equal(audit?.options.write?.operationId, key); assert.equal(audit?.options.write?.targetId, key);
});

void test('account edits preserve metadata CAS and never let a family member patch the owner personal account', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.patch(OWNER_PERSONAL, { name: '越权', expectedRevision: 1 })).status, 404);
  assert.equal((await f.patch(OWNER_FAMILY, { name: '共同更新', expectedRevision: 1 })).status, 200);
  assert.equal((await f.patch(OWNER_FAMILY, { name: '旧版本', expectedRevision: 1 })).status, 409);
  const row = f.sqlite.prepare('SELECT name,metadata_revision,user_id FROM finance_accounts WHERE id=?').get(OWNER_FAMILY);
  assert.equal(row?.name, '共同更新'); assert.equal(row?.user_id, 'owner'); assert.equal(row?.metadata_revision, 2);
});

void test('revocation blocks an already committed balance replay and a write revoked after context resolution', async (t) => {
  const f = await fixture(t); const key = crypto.randomUUID();
  assert.equal((await f.append(OWNER_FAMILY, balanceInput(), key)).status, 201);
  assert.equal((await f.append(OWNER_FAMILY, balanceInput(), key)).status, 201);
  const count = f.sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_entries').get()?.total;
  f.revoke(); assert.equal((await f.append(OWNER_FAMILY, balanceInput(), key)).status, 403);
  assert.equal((await f.get()).status, 403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_entries').get()?.total, count);
  const raced = await fixture(t); raced.revokeDuringWrite();
  assert.equal((await raced.append(OWNER_FAMILY, balanceInput())).status, 403);
  assert.equal(raced.sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_entries').get()?.total, 3);
});

void test('balance preview is read only, corrections retain audit history, and foreign entries stay inaccessible', async (t) => {
  const f = await fixture(t); const entryId = 'initial:' + OWNER_FAMILY;
  const correction = { action: 'correct', amount: '125.00', asOfDate: TODAY, note: '', reason: '共同更正', expectedRevision: 0, expectedAccountRevision: 0 };
  const preview = await f.preview(OWNER_FAMILY, entryId, correction); assert.equal(preview.status, 200);
  assert.equal((await data(preview)).after.amountMinor, '12500');
  assert.equal(f.scopeCalls.some((call) => call.options.write), false);
  assert.equal((await f.preview(OWNER_FAMILY, 'initial:' + OWNER_PERSONAL, correction)).status, 404);
  assert.equal((await f.preview(OWNER_PERSONAL, 'initial:' + OWNER_PERSONAL, correction)).status, 404);
  assert.equal((await f.change(OWNER_FAMILY, entryId, correction)).status, 200);
  const detail = await data(await f.get()); assert.equal(detail.account.balanceMinor, '12500'); assert.equal(detail.changes.length, 1);
  assert.equal(detail.balances[0].originalAmountMinor, '10000');
  assert.equal(f.scopeCalls.find((call) => call.options.write?.action === 'balance.correct')?.scope.actorUserId, 'member');
  const exportFn = f.repository.financeExport as (owner: string, ledger: string, db: D1Database) => Promise<{ accounts: { id: string }[] }>;
  assert.deepEqual((await exportFn('owner', 'family', f.raw)).accounts.map((account) => account.id), [OWNER_FAMILY]);
});

void test('authentication and body validation remain ahead of scoped writes', async (t) => {
  const f = await fixture(t); f.signIn(null);
  assert.equal((await f.create(accountInput())).status, 401); assert.equal((await f.get()).status, 401);
  f.signIn('member'); assert.equal((await f.create({ ...accountInput(), amount: '0.001' })).status, 400);
  assert.equal(f.scopeCalls.length, 0);
});
