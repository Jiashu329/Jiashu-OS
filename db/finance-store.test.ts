import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  appendFinanceBalance,
  createFinanceAccount,
  exportFinanceBalances,
  exportFinanceSnapshot,
  findFinanceAccount,
  findFinanceAccountSnapshot,
  listFinanceAccounts,
  listFinanceBalances,
  patchFinanceAccount,
  FinanceIdempotencyConflictError,
  type FinanceDatabase,
  type NewFinanceAccount,
} from './finance-store.ts';

interface TestResult { results?: unknown[]; meta: { changes: number } }
interface TestStatement {
  bind(...parameters: unknown[]): TestStatement;
  run(): Promise<TestResult>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  execute(): TestResult;
}

function migrate(sqlite: DatabaseSync) {
  sqlite.exec(readFileSync(new URL('../drizzle/0002_reflective_human_robot.sql', import.meta.url), 'utf8'));
  const idempotencyMigration = readdirSync(new URL('../drizzle/', import.meta.url)).find((name) => /^0003_.*\.sql$/.test(name));
  assert.ok(idempotencyMigration, 'Finance idempotency migration must be generated before running store tests');
  sqlite.exec(readFileSync(new URL('../drizzle/' + idempotencyMigration, import.meta.url), 'utf8'));
}

function databaseAdapter(sqlite: DatabaseSync, afterBatchStatement?: (index: number) => Promise<void>): FinanceDatabase {
  const adapter = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound: TestStatement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        execute() {
          if (statement.columns().length) return { results: statement.all(...values), meta: { changes: 0 } };
          return { meta: { changes: Number(statement.run(...values).changes) } };
        },
        async run() { return bound.execute(); },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
      };
      return bound;
    },
    async batch(statements: TestStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results: TestResult[] = [];
        for (const [index, statement] of statements.entries()) {
          results.push(statement.execute());
          // Without a hook the batch executes synchronously, matching D1's
          // serialization of one transaction and preserving retry race tests.
          if (afterBatchStatement) await afterBatchStatement(index);
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return adapter as unknown as FinanceDatabase;
}

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  migrate(sqlite);
  t.after(() => sqlite.close());
  return { sqlite, db: databaseAdapter(sqlite) };
}

const initial: NewFinanceAccount = {
  ledger: 'personal', name: '合成测试银行账户', type: 'bank', currency: 'CNY',
  note: '', amountMinor: '10000', asOfDate: '2026-11-09',
};
const sameTime = '2026-11-09T02:00:00.000Z';

test('account and initial balance are created together and reads never invent accounts', async (t) => {
  const { db } = fixture(t);
  assert.deepEqual(await listFinanceAccounts(db, 'owner', 'personal'), []);
  assert.deepEqual(await exportFinanceBalances(db, 'owner', 'personal'), []);
  const accountId = await createFinanceAccount(db, 'owner', initial, sameTime);
  const account = await findFinanceAccount(db, 'owner', accountId);
  assert.ok(account);
  assert.equal(account.id, accountId);
  assert.equal(account.ledger, 'personal');
  assert.equal(account.balanceMinor, '10000');
  assert.equal(account.asOfDate, '2026-11-09');
  const balances = await listFinanceBalances(db, 'owner', accountId);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].accountId, accountId);
  assert.equal(balances[0].note, '初始余额');
});

test('a failed initial balance rolls back the account creation batch', async (t) => {
  const { db, sqlite } = fixture(t);
  sqlite.exec(`CREATE TRIGGER reject_initial_balance BEFORE INSERT ON finance_balance_entries
    BEGIN SELECT RAISE(ABORT, 'simulated balance failure'); END;`);
  await assert.rejects(createFinanceAccount(db, 'owner', initial, sameTime), /simulated balance failure/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_accounts').get()!.total, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_balance_entries').get()!.total, 0);
});

test('all lookups and mutations are owner isolated and ledgers remain separate', async (t) => {
  const { db } = fixture(t);
  const personalId = await createFinanceAccount(db, 'alice', initial, sameTime);
  const familyId = await createFinanceAccount(db, 'alice', { ...initial, ledger: 'family', name: '家庭测试', currency: 'HKD' }, sameTime);
  const bobId = await createFinanceAccount(db, 'bob', { ...initial, currency: 'USD', name: 'Bob test' }, sameTime);
  assert.deepEqual((await listFinanceAccounts(db, 'alice', 'personal')).map((row) => row.id), [personalId]);
  assert.deepEqual((await listFinanceAccounts(db, 'alice', 'family')).map((row) => row.id), [familyId]);
  assert.deepEqual((await listFinanceAccounts(db, 'bob', 'personal')).map((row) => row.id), [bobId]);
  assert.equal(await findFinanceAccount(db, 'alice', bobId), null);
  assert.deepEqual(await listFinanceBalances(db, 'alice', bobId), []);
  assert.equal(await patchFinanceAccount(db, 'alice', bobId, { name: 'unauthorized', archived: true }), false);
  assert.equal(await appendFinanceBalance(db, 'alice', bobId, { amountMinor: '1', asOfDate: '2026-11-09', note: '' }), null);
  assert.equal((await findFinanceAccount(db, 'bob', bobId))!.name, 'Bob test');
  assert.equal((await listFinanceBalances(db, 'bob', bobId)).length, 1);
  assert.deepEqual((await exportFinanceBalances(db, 'alice', 'family')).map((row) => row.accountId), [familyId]);
  assert.deepEqual((await exportFinanceBalances(db, 'bob', 'family')), []);
});

test('minor units beyond Number precision remain exact decimal strings', async (t) => {
  const { db } = fixture(t);
  const first = '999999999999999999';
  const second = '100000000000000001';
  const accountId = await createFinanceAccount(db, 'owner', { ...initial, amountMinor: first }, sameTime);
  assert.equal((await findFinanceAccount(db, 'owner', accountId))!.balanceMinor, first);
  await appendFinanceBalance(db, 'owner', accountId, { amountMinor: second, asOfDate: '2026-11-09', note: 'precision update' }, sameTime);
  assert.equal((await findFinanceAccount(db, 'owner', accountId))!.balanceMinor, second);
  assert.deepEqual((await listFinanceBalances(db, 'owner', accountId)).map((row) => row.amountMinor), [second, first]);
  assert.ok((await exportFinanceBalances(db, 'owner', 'personal')).every((row) => typeof row.amountMinor === 'string'));
});

test('backdated balance history does not roll the current balance backwards', async (t) => {
  const { db } = fixture(t);
  const accountId = await createFinanceAccount(db, 'owner', { ...initial, amountMinor: '50000' }, sameTime);
  await appendFinanceBalance(db, 'owner', accountId, { amountMinor: '20000', asOfDate: '2026-11-07', note: 'backfill' }, '2026-11-09T03:00:00.000Z');
  const account = await findFinanceAccount(db, 'owner', accountId);
  assert.equal(account!.balanceMinor, '50000');
  assert.equal(account!.asOfDate, '2026-11-09');
  assert.equal(account!.balanceUpdatedAt, sameTime);
  assert.equal(account!.updatedAt, '2026-11-09T03:00:00.000Z');
  assert.deepEqual((await listFinanceBalances(db, 'owner', accountId)).map((row) => row.asOfDate), ['2026-11-09', '2026-11-07']);
});

test('same-day and same-millisecond updates deterministically use the last appended balance', async (t) => {
  const { db } = fixture(t);
  const accountId = await createFinanceAccount(db, 'owner', initial, sameTime);
  await appendFinanceBalance(db, 'owner', accountId, { amountMinor: '20000', asOfDate: initial.asOfDate, note: 'first correction' }, sameTime);
  await appendFinanceBalance(db, 'owner', accountId, { amountMinor: '30000', asOfDate: initial.asOfDate, note: 'second correction' }, sameTime);
  assert.equal((await findFinanceAccount(db, 'owner', accountId))!.balanceMinor, '30000');
  assert.deepEqual((await listFinanceBalances(db, 'owner', accountId)).map((row) => row.amountMinor), ['30000', '20000', '10000']);
});

test('archive and restore preserve history while archived accounts reject new balances', async (t) => {
  const { db } = fixture(t);
  const accountId = await createFinanceAccount(db, 'owner', initial, sameTime);
  assert.equal(await patchFinanceAccount(db, 'owner', accountId, { archived: true }, sameTime), true);
  assert.deepEqual(await listFinanceAccounts(db, 'owner', 'personal'), []);
  const archived = await listFinanceAccounts(db, 'owner', 'personal', true);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].archivedAt, sameTime);
  assert.equal(await appendFinanceBalance(db, 'owner', accountId, { amountMinor: '99999', asOfDate: initial.asOfDate, note: '' }), null);
  assert.equal((await listFinanceBalances(db, 'owner', accountId)).length, 1);
  assert.equal((await exportFinanceBalances(db, 'owner', 'personal')).length, 1);
  assert.equal(await patchFinanceAccount(db, 'owner', accountId, { archived: false, name: '恢复后的账户', type: 'investment', note: 'retained' }), true);
  const restored = (await listFinanceAccounts(db, 'owner', 'personal'))[0];
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.name, '恢复后的账户');
  assert.equal(restored.balanceMinor, '10000');
  assert.equal(restored.currency, 'CNY');
  assert.ok(await appendFinanceBalance(db, 'owner', accountId, { amountMinor: '12000', asOfDate: initial.asOfDate, note: '' }));
  assert.equal((await listFinanceBalances(db, 'owner', accountId)).length, 2);
});

test('a failed account metadata write rolls back the appended balance', async (t) => {
  const { db, sqlite } = fixture(t);
  const accountId = await createFinanceAccount(db, 'owner', initial, sameTime);
  sqlite.exec(`CREATE TRIGGER reject_account_update BEFORE UPDATE ON finance_accounts
    BEGIN SELECT RAISE(ABORT, 'simulated account failure'); END;`);
  await assert.rejects(appendFinanceBalance(db, 'owner', accountId, { amountMinor: '20000', asOfDate: initial.asOfDate, note: '' }, sameTime), /simulated account failure/);
  assert.equal((await listFinanceBalances(db, 'owner', accountId)).length, 1);
  assert.equal((await findFinanceAccount(db, 'owner', accountId))!.balanceMinor, '10000');
});

test('missing accounts are not created by failed updates or reads', async (t) => {
  const { db } = fixture(t);
  assert.equal(await findFinanceAccount(db, 'owner', 'missing'), null);
  assert.deepEqual(await listFinanceBalances(db, 'owner', 'missing'), []);
  assert.equal(await patchFinanceAccount(db, 'owner', 'missing', { archived: true }), false);
  assert.equal(await appendFinanceBalance(db, 'owner', 'missing', { amountMinor: '1', asOfDate: initial.asOfDate, note: '' }), null);
  assert.deepEqual(await listFinanceAccounts(db, 'owner', 'personal', true), []);
});

function databaseSnapshot(sqlite: DatabaseSync) {
  return JSON.stringify({
    accounts: sqlite.prepare('SELECT * FROM finance_accounts ORDER BY id').all(),
    balances: sqlite.prepare('SELECT * FROM finance_balance_entries ORDER BY sequence').all(),
  });
}

test('retrying account creation keeps one account and initial balance without rolling back later edits', async (t) => {
  const { db, sqlite } = fixture(t);
  const requestKey = crypto.randomUUID();
  const accountId = await createFinanceAccount(db, 'owner', initial, sameTime, requestKey);
  assert.equal(accountId, requestKey);
  assert.equal(await createFinanceAccount(db, 'owner', initial, '2026-11-09T03:00:00.000Z', requestKey), accountId);
  assert.equal((await listFinanceAccounts(db, 'owner', 'personal')).length, 1);
  assert.equal((await listFinanceBalances(db, 'owner', accountId)).length, 1);

  await appendFinanceBalance(db, 'owner', accountId, { amountMinor: '25000', asOfDate: initial.asOfDate, note: 'new balance' }, '2026-11-09T04:00:00.000Z');
  await patchFinanceAccount(db, 'owner', accountId, { name: '后续编辑后的账户', note: 'keep this metadata' }, '2026-11-09T05:00:00.000Z');
  const before = databaseSnapshot(sqlite);
  assert.equal(await createFinanceAccount(db, 'owner', { ...initial }, '2026-11-09T06:00:00.000Z', requestKey), accountId);
  assert.equal(databaseSnapshot(sqlite), before);
  const account = await findFinanceAccount(db, 'owner', accountId);
  assert.equal(account!.name, '后续编辑后的账户');
  assert.equal(account!.balanceMinor, '25000');
  assert.equal(account!.createdAt, sameTime);
  assert.equal(account!.updatedAt, '2026-11-09T05:00:00.000Z');
});

test('creation keys reject changed payloads, different owners and existing balance keys without mutation', async (t) => {
  const { db, sqlite } = fixture(t);
  const requestKey = crypto.randomUUID();
  const accountId = await createFinanceAccount(db, 'owner', initial, sameTime, requestKey);
  const otherBalanceKey = crypto.randomUUID();
  await appendFinanceBalance(db, 'owner', accountId, { amountMinor: '12000', asOfDate: initial.asOfDate, note: '' }, sameTime, otherBalanceKey);
  const before = databaseSnapshot(sqlite);
  for (const changed of [
    { ...initial, amountMinor: '10001' },
    { ...initial, ledger: 'family' },
    { ...initial, currency: 'USD' },
    { ...initial, name: 'different name' },
    { ...initial, type: 'investment' },
    { ...initial, note: 'different note' },
    { ...initial, asOfDate: '2026-11-08' },
  ]) {
    await assert.rejects(createFinanceAccount(db, 'owner', changed, sameTime, requestKey), FinanceIdempotencyConflictError);
    assert.equal(databaseSnapshot(sqlite), before);
  }
  await assert.rejects(createFinanceAccount(db, 'another-owner', initial, sameTime, requestKey), FinanceIdempotencyConflictError);
  await assert.rejects(createFinanceAccount(db, 'owner', initial, sameTime, otherBalanceKey), FinanceIdempotencyConflictError);
  assert.equal(databaseSnapshot(sqlite), before);
});

test('retrying a balance entry preserves one history row and leaves a newer update timestamp untouched', async (t) => {
  const { db, sqlite } = fixture(t);
  const accountId = await createFinanceAccount(db, 'owner', initial, sameTime);
  const requestKey = crypto.randomUUID();
  const entry = { amountMinor: '20000', asOfDate: initial.asOfDate, note: 'first update' };
  const entryId = await appendFinanceBalance(db, 'owner', accountId, entry, '2026-11-09T03:00:00.000Z', requestKey);
  assert.equal(entryId, requestKey);
  assert.equal(await appendFinanceBalance(db, 'owner', accountId, entry, '2026-11-09T04:00:00.000Z', requestKey), entryId);
  assert.equal((await listFinanceBalances(db, 'owner', accountId)).length, 2);
  assert.equal((await findFinanceAccount(db, 'owner', accountId))!.updatedAt, '2026-11-09T03:00:00.000Z');

  await appendFinanceBalance(db, 'owner', accountId, { amountMinor: '30000', asOfDate: initial.asOfDate, note: 'newer update' }, '2026-11-09T05:00:00.000Z', crypto.randomUUID());
  const before = databaseSnapshot(sqlite);
  assert.equal(await appendFinanceBalance(db, 'owner', accountId, entry, '2026-11-09T06:00:00.000Z', requestKey), entryId);
  assert.equal(databaseSnapshot(sqlite), before);
  assert.equal((await findFinanceAccount(db, 'owner', accountId))!.balanceMinor, '30000');
  assert.equal((await findFinanceAccount(db, 'owner', accountId))!.updatedAt, '2026-11-09T05:00:00.000Z');
});

test('balance keys reject changed payloads, accounts, owners and account-creation keys', async (t) => {
  const { db, sqlite } = fixture(t);
  const creationKey = crypto.randomUUID();
  const firstAccount = await createFinanceAccount(db, 'owner', initial, sameTime, creationKey);
  const secondAccount = await createFinanceAccount(db, 'owner', { ...initial, ledger: 'family' }, sameTime);
  const otherOwnerAccount = await createFinanceAccount(db, 'another-owner', initial, sameTime);
  const requestKey = crypto.randomUUID();
  const entry = { amountMinor: '20000', asOfDate: initial.asOfDate, note: 'retained note' };
  await appendFinanceBalance(db, 'owner', firstAccount, entry, '2026-11-09T03:00:00.000Z', requestKey);
  const before = databaseSnapshot(sqlite);
  for (const changed of [
    { ...entry, amountMinor: '20001' },
    { ...entry, asOfDate: '2026-11-08' },
    { ...entry, note: 'different note' },
  ]) {
    await assert.rejects(appendFinanceBalance(db, 'owner', firstAccount, changed, sameTime, requestKey), FinanceIdempotencyConflictError);
    assert.equal(databaseSnapshot(sqlite), before);
  }
  await assert.rejects(appendFinanceBalance(db, 'owner', secondAccount, entry, sameTime, requestKey), FinanceIdempotencyConflictError);
  await assert.rejects(appendFinanceBalance(db, 'another-owner', otherOwnerAccount, entry, sameTime, requestKey), FinanceIdempotencyConflictError);
  await assert.rejects(appendFinanceBalance(db, 'owner', firstAccount, entry, sameTime, creationKey), FinanceIdempotencyConflictError);
  assert.equal(databaseSnapshot(sqlite), before);
});

test('concurrent account retries converge on one account and one initial balance', async (t) => {
  const { db } = fixture(t);
  const requestKey = crypto.randomUUID();
  const ids = await Promise.all([
    createFinanceAccount(db, 'owner', initial, sameTime, requestKey),
    createFinanceAccount(db, 'owner', { ...initial }, '2026-11-09T03:00:00.000Z', requestKey),
  ]);
  assert.deepEqual(ids, [requestKey, requestKey]);
  assert.equal((await listFinanceAccounts(db, 'owner', 'personal')).length, 1);
  assert.equal((await listFinanceBalances(db, 'owner', requestKey)).length, 1);
});

test('concurrent balance retries append once and keep metadata aligned with the stored entry', async (t) => {
  const { db } = fixture(t);
  const accountId = await createFinanceAccount(db, 'owner', initial, sameTime);
  const requestKey = crypto.randomUUID();
  const entry = { amountMinor: '20000', asOfDate: initial.asOfDate, note: 'concurrent retry' };
  const ids = await Promise.all([
    appendFinanceBalance(db, 'owner', accountId, entry, '2026-11-09T03:00:00.000Z', requestKey),
    appendFinanceBalance(db, 'owner', accountId, { ...entry }, '2026-11-09T04:00:00.000Z', requestKey),
  ]);
  assert.deepEqual(ids, [requestKey, requestKey]);
  const history = await listFinanceBalances(db, 'owner', accountId);
  assert.equal(history.length, 2);
  const inserted = history.find((row) => row.id === requestKey)!;
  assert.equal((await findFinanceAccount(db, 'owner', accountId))!.updatedAt, inserted.createdAt);
});

test('export reads one owner-and-ledger snapshot while another WAL connection commits changes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'finance-snapshot-'));
  const filename = join(directory, 'test.sqlite');
  const writerSqlite = new DatabaseSync(filename);
  writerSqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;');
  migrate(writerSqlite);
  const readerSqlite = new DatabaseSync(filename);
  readerSqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;');
  t.after(() => { readerSqlite.close(); writerSqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  const writer = databaseAdapter(writerSqlite);
  const activeId = await createFinanceAccount(writer, 'owner', initial, sameTime);
  const archivedId = await createFinanceAccount(writer, 'owner', { ...initial, name: '归档账户' }, sameTime);
  await patchFinanceAccount(writer, 'owner', archivedId, { archived: true }, sameTime);
  const familyId = await createFinanceAccount(writer, 'owner', { ...initial, ledger: 'family', name: '家庭账户' }, sameTime);
  const otherOwnerId = await createFinanceAccount(writer, 'other-owner', initial, sameTime);
  let insertedId = '';
  let committedBetweenReads = false;
  const reader = databaseAdapter(readerSqlite, async (index) => {
    if (index !== 0 || committedBetweenReads) return;
    committedBetweenReads = true;
    await appendFinanceBalance(writer, 'owner', activeId, { amountMinor: '25000', asOfDate: initial.asOfDate, note: 'written between export reads' }, '2026-11-09T03:00:00.000Z');
    insertedId = await createFinanceAccount(writer, 'owner', { ...initial, name: '导出中途新增', amountMinor: '30000' }, '2026-11-09T03:00:00.000Z');
    await patchFinanceAccount(writer, 'owner', archivedId, { archived: false }, '2026-11-09T03:00:00.000Z');
  });

  const snapshot = await exportFinanceSnapshot(reader, 'owner', 'personal');
  assert.equal(committedBetweenReads, true);
  assert.ok(insertedId);
  assert.deepEqual(new Set(snapshot.accounts.map((account) => account.id)), new Set([activeId, archivedId]));
  assert.deepEqual(new Set(snapshot.balances.map((balance) => balance.accountId)), new Set([activeId, archivedId]));
  assert.equal(snapshot.balances.length, 2);
  assert.ok(snapshot.accounts.every((account) => account.id !== familyId && account.id !== otherOwnerId && account.id !== insertedId));
  assert.equal(snapshot.accounts.find((account) => account.id === activeId)!.balanceMinor, '10000');
  assert.equal(snapshot.accounts.find((account) => account.id === archivedId)!.archivedAt, sameTime);
  assert.equal(snapshot.balances.find((balance) => balance.accountId === activeId)!.amountMinor, '10000');

  // The writer really committed: a read after the export transaction sees
  // those changes, even though both exported arrays remain at the earlier point.
  assert.equal((await findFinanceAccount(writer, 'owner', activeId))!.balanceMinor, '25000');
  assert.equal((await findFinanceAccount(writer, 'owner', archivedId))!.archivedAt, null);
  const fresh = await exportFinanceSnapshot(databaseAdapter(readerSqlite), 'owner', 'personal');
  assert.deepEqual(new Set(fresh.accounts.map((account) => account.id)), new Set([activeId, archivedId, insertedId]));
  assert.equal(fresh.balances.length, 4);
});

test('account details keep current balance and history in one snapshot during a concurrent update', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'finance-details-snapshot-'));
  const filename = join(directory, 'test.sqlite');
  const writerSqlite = new DatabaseSync(filename);
  writerSqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;');
  migrate(writerSqlite);
  const readerSqlite = new DatabaseSync(filename);
  readerSqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;');
  t.after(() => { readerSqlite.close(); writerSqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  const writer = databaseAdapter(writerSqlite);
  const accountId = await createFinanceAccount(writer, 'owner', initial, sameTime);
  let committedBetweenReads = false;
  const reader = databaseAdapter(readerSqlite, async (index) => {
    if (index !== 0 || committedBetweenReads) return;
    committedBetweenReads = true;
    await appendFinanceBalance(writer, 'owner', accountId, { amountMinor: '25000', asOfDate: initial.asOfDate, note: 'concurrent update' }, '2026-11-09T03:00:00.000Z');
  });

  const snapshot = await findFinanceAccountSnapshot(reader, 'owner', accountId);
  assert.equal(committedBetweenReads, true);
  assert.equal(snapshot.account!.balanceMinor, '10000');
  assert.equal(snapshot.balances[0].amountMinor, '10000');
  assert.equal(snapshot.balances.length, 1);

  const fresh = await findFinanceAccountSnapshot(databaseAdapter(readerSqlite), 'owner', accountId);
  assert.equal(fresh.account!.balanceMinor, '25000');
  assert.equal(fresh.balances[0].amountMinor, '25000');
  assert.equal(fresh.balances.length, 2);
  const unauthorized = await findFinanceAccountSnapshot(databaseAdapter(readerSqlite), 'another-owner', accountId);
  assert.equal(unauthorized.account, null);
  assert.deepEqual(unauthorized.balances, []);
});
