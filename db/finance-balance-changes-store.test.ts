import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { appendFinanceBalance, createFinanceAccount, exportFinanceSnapshot, findFinanceAccount, listFinanceAccounts, listFinanceBalances, type FinanceDatabase } from './finance-store.ts';
import { changeFinanceBalance, financeBalanceChangeHistory, FinanceBalanceChangeConflictError, FinanceLastBalanceError, previewFinanceBalanceChange } from './finance-balance-changes-store.ts';
import { readFinanceReviewSnapshot } from './finance-review-store.ts';
import { buildFinanceSummary } from '../lib/finance.ts';
import { parseFinanceBalanceChange, type FinanceBalanceChangeInput } from '../lib/finance-balance-change.ts';

interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown>; execute(): { results: unknown[]; meta: { changes: number } } }
async function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound: Statement = {
        bind(...args) { values = args as SQLInputValue[]; return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        async run() { return bound.execute(); },
        execute() { return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } } : { results: [], meta: { changes: Number(statement.run(...values).changes) } }; },
      }; return bound;
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as FinanceDatabase;
  const accountId = await createFinanceAccount(db, 'alice', { ledger: 'personal', currency: 'CNY', type: 'bank', name: 'synthetic correction account', note: '', amountMinor: '10000', asOfDate: '2026-10-01' }, '2026-11-11T01:00:00Z');
  const entryId = (await appendFinanceBalance(db, 'alice', accountId, { amountMinor: '9007199254740993', asOfDate: '2026-11-11', note: 'wrong day' }, '2026-11-11T01:00:00Z'))!;
  return { db, sqlite, accountId, entryId };
}
function correct(revision = 0, accountRevision = 1): FinanceBalanceChangeInput {
  return { action: 'correct', expectedRevision: revision, expectedAccountRevision: accountRevision, amountMinor: '9007199254740994', asOfDate: '2026-10-31', note: 'correct date', reason: 'synthetic wrong date correction' };
}
function voidInput(revision = 0, accountRevision = 1): FinanceBalanceChangeInput {
  return { action: 'void', expectedRevision: revision, expectedAccountRevision: accountRevision, amountMinor: null, asOfDate: null, note: null, reason: 'synthetic void' };
}

test('correcting a mistaken later date changes every effective read without changing the original entry', async (t) => {
  const { db, sqlite, accountId, entryId } = await fixture(t);
  const input = correct();
  const preview = await previewFinanceBalanceChange(db, 'alice', accountId, entryId, input);
  assert.equal(preview!.currentAfter.amountMinor, '9007199254740994');
  assert.equal(preview!.currentAfter.asOfDate, '2026-10-31');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_changes').get()!.total, 0);
  await changeFinanceBalance(db, 'alice', accountId, entryId, input, crypto.randomUUID());
  const account = (await findFinanceAccount(db, 'alice', accountId))!;
  assert.equal(account.balanceMinor, '9007199254740994');
  assert.equal(account.asOfDate, '2026-10-31');
  assert.equal(account.balanceRevision, 2);
  const original = sqlite.prepare('SELECT amount_minor,as_of_date FROM finance_balance_entries WHERE id=?').get(entryId)!;
  assert.equal(original.amount_minor, '9007199254740993');
  assert.equal(original.as_of_date, '2026-11-11');
  const history = await listFinanceBalances(db, 'alice', accountId);
  assert.equal(history[0].status, 'corrected'); assert.equal(history[0].revision, 1);
  assert.equal(history[0].originalAsOfDate, '2026-11-11');
  const accounts = await listFinanceAccounts(db, 'alice', 'personal');
  const total = buildFinanceSummary(accounts.map((row) => ({ ...row, ledger: 'personal', currency: 'CNY', type: 'bank' })), 'personal');
  assert.equal(total.byCurrency.CNY!.assetsMinor, '9007199254740994');
  const review = await readFinanceReviewSnapshot(db, 'alice', 'personal', '2026-10-31');
  assert.equal(review.balances.at(-1)!.amountMinor, '9007199254740994');
  const exported = await exportFinanceSnapshot(db, 'alice', 'personal');
  assert.equal(exported.balances[0].amountMinor, '9007199254740994');
});

test('void removes an effective entry, retains its audit trail and may be explicitly corrected back', async (t) => {
  const { db, accountId, entryId } = await fixture(t);
  await changeFinanceBalance(db, 'alice', accountId, entryId, voidInput(), crypto.randomUUID());
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceMinor, '10000');
  assert.equal((await listFinanceBalances(db, 'alice', accountId))[0].status, 'void');
  assert.equal((await exportFinanceSnapshot(db, 'alice', 'personal')).balances.length, 1);
  assert.equal((await readFinanceReviewSnapshot(db, 'alice', 'personal', '2026-11-11')).balances.length, 1);
  await changeFinanceBalance(db, 'alice', accountId, entryId, correct(1, 2), crypto.randomUUID());
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceMinor, '9007199254740994');
  const history = await financeBalanceChangeHistory(db, 'alice', accountId);
  assert.deepEqual(history.map((row) => row.action), ['correct', 'void']);
  assert.deepEqual(history.map((row) => row.revision), [2, 1]);
});

test('the final effective balance cannot be voided or converted into an invented zero', async (t) => {
  const { db, sqlite, accountId, entryId } = await fixture(t);
  await changeFinanceBalance(db, 'alice', accountId, entryId, voidInput(), crypto.randomUUID());
  const initialId = 'initial:' + accountId;
  await assert.rejects(changeFinanceBalance(db, 'alice', accountId, initialId, voidInput(0, 2), crypto.randomUUID()), FinanceLastBalanceError);
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceMinor, '10000');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_changes').get()!.total, 1);
});

test('replays precede stale-revision checks and conflicting operation payloads never modify existing changes', async (t) => {
  const { db, sqlite, accountId, entryId } = await fixture(t);
  const id = crypto.randomUUID(); const input = correct();
  await changeFinanceBalance(db, 'alice', accountId, entryId, input, id);
  await appendFinanceBalance(db, 'alice', accountId, { amountMinor: '50000', asOfDate: '2026-11-11', note: '' });
  assert.equal(await changeFinanceBalance(db, 'alice', accountId, entryId, input, id), id);
  await assert.rejects(changeFinanceBalance(db, 'alice', accountId, entryId, { ...input, reason: 'changed' }, id), /submission key/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_changes').get()!.total, 1);
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceMinor, '50000');
});

test('an identical request committed between the idempotency and snapshot reads is still a successful replay', async (t) => {
  const { db, sqlite, accountId, entryId } = await fixture(t);
  const id = crypto.randomUUID(); const input = correct(); let injected = false;
  const racing = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.startsWith('SELECT user_id AS userId, request_hash AS requestHash FROM finance_balance_changes')) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async first<T>() {
              const result = await bound.first<T>();
              if (!injected) { injected = true; await changeFinanceBalance(db, 'alice', accountId, entryId, input, id); }
              return result;
            },
          };
        },
      };
    },
    batch: db.batch.bind(db),
  } as unknown as FinanceDatabase;
  assert.equal(await changeFinanceBalance(racing, 'alice', accountId, entryId, input, id), id);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_changes').get()!.total, 1);
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceRevision, 2);
});

test('owner isolation, archival and whole-account revisions reject stale or unauthorized changes', async (t) => {
  const { db, sqlite, accountId, entryId } = await fixture(t);
  assert.equal(await changeFinanceBalance(db, 'bob', accountId, entryId, correct(), crypto.randomUUID()), null);
  assert.deepEqual(await financeBalanceChangeHistory(db, 'bob', accountId), []);
  await appendFinanceBalance(db, 'alice', accountId, { amountMinor: '123', asOfDate: '2026-11-10', note: '' });
  await assert.rejects(changeFinanceBalance(db, 'alice', accountId, entryId, correct(), crypto.randomUUID()), FinanceBalanceChangeConflictError);
  sqlite.prepare('UPDATE finance_accounts SET archived_at=? WHERE id=?').run('2026-11-11T02:00:00Z', accountId);
  await assert.rejects(changeFinanceBalance(db, 'alice', accountId, entryId, correct(0, 2), crypto.randomUUID()), FinanceBalanceChangeConflictError);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_changes').get()!.total, 0);
});

test('concurrent revisions converge on one change and account revision advances exactly once', async (t) => {
  const { db, sqlite, accountId, entryId } = await fixture(t);
  const results = await Promise.allSettled([
    changeFinanceBalance(db, 'alice', accountId, entryId, correct(), crypto.randomUUID()),
    changeFinanceBalance(db, 'alice', accountId, entryId, correct(), crypto.randomUUID()),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_changes').get()!.total, 1);
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceRevision, 2);
});

test('the preview protects the whole account when concurrent changes target different records', async (t) => {
  const { db, sqlite, accountId, entryId } = await fixture(t);
  const results = await Promise.allSettled([
    changeFinanceBalance(db, 'alice', accountId, entryId, correct(), crypto.randomUUID()),
    changeFinanceBalance(db, 'alice', accountId, 'initial:' + accountId, { ...correct(), amountMinor: '20000', asOfDate: '2026-10-01' }, crypto.randomUUID()),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_changes').get()!.total, 1);
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceRevision, 2);
});

test('correcting a wrong date back before another valid balance chooses that newer valid balance', async (t) => {
  const { db, accountId, entryId } = await fixture(t);
  await appendFinanceBalance(db, 'alice', accountId, { amountMinor: '20000', asOfDate: '2026-10-31', note: 'correct month end' });
  const input = { ...correct(0, 2), amountMinor: '12345', asOfDate: '2026-09-30' };
  const preview = await previewFinanceBalanceChange(db, 'alice', accountId, entryId, input);
  assert.equal(preview!.currentAfter.amountMinor, '20000');
  assert.equal(preview!.currentAfter.asOfDate, '2026-10-31');
  await changeFinanceBalance(db, 'alice', accountId, entryId, input, crypto.randomUUID());
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceMinor, '20000');
});

test('account-update failures roll back a new correction and preserve the old effective amount', async (t) => {
  const { db, sqlite, accountId, entryId } = await fixture(t);
  sqlite.exec("CREATE TRIGGER reject_correction_account_update BEFORE UPDATE ON finance_accounts BEGIN SELECT RAISE(ABORT, 'synthetic account update failure'); END;");
  await assert.rejects(changeFinanceBalance(db, 'alice', accountId, entryId, correct(), crypto.randomUUID()), /synthetic account update failure/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_changes').get()!.total, 0);
  assert.equal((await findFinanceAccount(db, 'alice', accountId))!.balanceMinor, '9007199254740993');
});

test('correction validation rejects coercions, unknown fields, impossible dates and currency precision loss', () => {
  const body = { action: 'correct', expectedRevision: 0, expectedAccountRevision: 1, reason: 'test', amount: '12.34', asOfDate: '2026-10-31', note: '' };
  assert.equal(parseFinanceBalanceChange(body, 'CNY', '2026-11-11').amountMinor, '1234');
  for (const patch of [{ expectedRevision: '0' }, { expectedAccountRevision: -1 }, { asOfDate: '2026-02-30' }, { amount: '12.345' }, { reason: '' }, { userId: 'bob' }]) assert.throws(() => parseFinanceBalanceChange({ ...body, ...patch }, 'CNY', '2026-11-11'));
  assert.throws(() => parseFinanceBalanceChange(body, 'JPY', '2026-11-11'));
  assert.throws(() => parseFinanceBalanceChange({ ...body, action: 'void' }, 'CNY', '2026-11-11'));
});
