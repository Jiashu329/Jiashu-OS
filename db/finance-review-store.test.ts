import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { buildFinanceReview, parseFinanceReviewQuery } from '../lib/finance-review.ts';
import { readFinanceReviewSnapshot } from './finance-review-store.ts';
import type { FinanceReviewDatabase } from './finance-review-store.ts';

interface BatchStatement { execute(): { results: unknown[]; meta: { changes: number } } }
function migrate(sqlite: DatabaseSync) {
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
}
function adapter(sqlite: DatabaseSync, afterStatement?: (index: number) => Promise<void>) {
  let batchCalls = 0;
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        execute() { return { results: statement.all(...values), meta: { changes: 0 } }; },
      };
      return bound;
    },
    async batch(statements: BatchStatement[]) {
      batchCalls++;
      assert.equal(statements.length, 3, 'review must read accounts, balances and classifications in a single batch');
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const [index, statement] of statements.entries()) {
          result.push(statement.execute());
          if (afterStatement) await afterStatement(index);
        }
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as FinanceReviewDatabase;
  return { db, calls: () => batchCalls };
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  migrate(sqlite);
  t.after(() => sqlite.close());
  return { sqlite, ...adapter(sqlite) };
}
function addAccount(sqlite: DatabaseSync, id: string, options: { owner?: string; ledger?: string; currency?: string; archived?: boolean; type?: string } = {}) {
  sqlite.prepare(`INSERT INTO finance_accounts (id, user_id, ledger, name, type, currency, note, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, '', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z', ?)`)
    .run(id, options.owner ?? 'alice', options.ledger ?? 'personal', id, options.type ?? 'bank', options.currency ?? 'CNY', options.archived ? '2026-11-09T00:00:00Z' : null);
}
let balanceNumber = 0;
function addBalance(sqlite: DatabaseSync, accountId: string, amountMinor: string, asOfDate: string, owner = 'alice', createdAt = '2026-11-09T00:00:00Z') {
  sqlite.prepare(`INSERT INTO finance_balance_entries (id, user_id, account_id, amount_minor, as_of_date, note, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?)`)
    .run('synthetic-review-' + (++balanceNumber), owner, accountId, amountMinor, asOfDate, createdAt);
}

void test('review snapshot is read-only and isolates owners, ledgers and classification history in all queries', async (t) => {
  const { sqlite, db, calls } = fixture(t);
  addAccount(sqlite, 'a');
  addAccount(sqlite, 'usd', { currency: 'USD' });
  addAccount(sqlite, 'family', { ledger: 'family' });
  addAccount(sqlite, 'archived', { archived: true });
  addAccount(sqlite, 'bob', { owner: 'bob' });
  addBalance(sqlite, 'a', '100', '2026-10-31');
  addBalance(sqlite, 'usd', '200', '2026-11-01');
  addBalance(sqlite, 'family', '300', '2026-11-01');
  addBalance(sqlite, 'archived', '400', '2026-11-01');
  addBalance(sqlite, 'bob', '500', '2026-11-01', 'bob');
  addBalance(sqlite, 'a', '999999999999999999', '2026-11-01', 'bob');
  const before = sqlite.prepare('SELECT total_changes() AS total').get()!.total;
  const result = await readFinanceReviewSnapshot(db, 'alice', 'personal', '2026-11-09');
  assert.equal(calls(), 1);
  assert.deepEqual(result.accounts.map((row) => row.accountId), ['a', 'archived', 'usd']);
  assert.deepEqual(result.balances.map((row) => row.amountMinor), ['100', '400', '200']);
  assert.equal(result.accounts.find((row)=>row.accountId==='archived')!.archivedAt,'2026-11-09T00:00:00Z');
  assert.equal(sqlite.prepare('SELECT total_changes() AS total').get()!.total, before);
  const family = await readFinanceReviewSnapshot(db, 'alice', 'family', '2026-11-09');
  assert.deepEqual(family.accounts.map((row) => row.accountId), ['family']);
  assert.deepEqual(family.balances.map((row) => row.amountMinor), ['300']);
  assert.deepEqual(await readFinanceReviewSnapshot(db, "alice' OR 1=1 --", 'personal', '2026-11-09'), { accounts: [], balances: [], classifications: [] });
});

void test('sequence and as-of dates survive SQL reads for precise corrections, backfills and per-currency calculation', async (t) => {
  const { sqlite, db } = fixture(t);
  addAccount(sqlite, 'a');
  addAccount(sqlite, 'loan', { type: 'loan' });
  addAccount(sqlite, 'usd', { currency: 'USD' });
  addBalance(sqlite, 'a', '9007199254740993', '2026-10-31', 'alice', '2026-11-09T20:00:00Z');
  addBalance(sqlite, 'a', '9007199254740994', '2026-10-31', 'alice', '2026-10-31T00:00:00Z');
  addBalance(sqlite, 'a', '1', '2026-10-01');
  addBalance(sqlite, 'a', '9007199254740995', '2026-11-09');
  addBalance(sqlite, 'a', '999999999999999999', '2026-11-10');
  addBalance(sqlite, 'loan', '500', '2026-10-31');
  addBalance(sqlite, 'loan', '400', '2026-11-09');
  addBalance(sqlite, 'usd', '999999999999999999', '2026-11-09');
  const data = await readFinanceReviewSnapshot(db, 'alice', 'personal', '2026-11-09');
  assert.ok(data.balances.every((row) => typeof row.sequence === 'number' && typeof row.amountMinor === 'string'));
  assert.ok(data.balances.every((row) => row.asOfDate <= '2026-11-09'));
  const result = buildFinanceReview(data.accounts, data.balances, parseFinanceReviewQuery(new URLSearchParams(), new Date('2026-11-09T08:00:00Z')));
  assert.equal(result.previous.assetsMinor, '9007199254740994');
  assert.equal(result.snapshot.assetsMinor, '9007199254740995');
  assert.equal(result.change.comparableNetMinor, '101');
  assert.deepEqual(result.availableCurrencies, ['CNY', 'USD']);
});

void test('current unarchived accounts with no as-of history stay available without invented balances', async (t) => {
  const { sqlite, db } = fixture(t);
  addAccount(sqlite, 'no-history', { currency: 'HKD' });
  addAccount(sqlite, 'future');
  addBalance(sqlite, 'future', '100', '2026-12-01');
  const result = await readFinanceReviewSnapshot(db, 'alice', 'personal', '2026-11-09');
  assert.equal(result.accounts.length, 2);
  assert.deepEqual(result.balances, []);
  const review = buildFinanceReview(result.accounts, result.balances, parseFinanceReviewQuery(new URLSearchParams(), new Date('2026-11-09T08:00:00Z')));
  assert.deepEqual(review.availableCurrencies, ['CNY', 'HKD']);
  assert.equal(review.snapshot.accountCount, 0);
  assert.equal(review.snapshot.netMinor, null);
});

void test('accounts and balances remain one snapshot while another WAL connection commits between reads', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jiashu-finance-review-'));
  const path = join(directory, 'review.sqlite');
  const reader = new DatabaseSync(path);
  reader.exec('PRAGMA journal_mode=WAL');
  migrate(reader);
  const writer = new DatabaseSync(path);
  t.after(() => { writer.close(); reader.close(); rmSync(directory, { recursive: true, force: true }); });
  addAccount(writer, 'a');
  addBalance(writer, 'a', '100', '2026-11-01');
  let wrote = false;
  const { db, calls } = adapter(reader, async (index) => {
    if (index !== 0 || wrote) return;
    wrote = true;
    addBalance(writer, 'a', '200', '2026-11-02');
    addAccount(writer, 'new');
    addBalance(writer, 'new', '300', '2026-11-02');
  });
  const snapshot = await readFinanceReviewSnapshot(db, 'alice', 'personal', '2026-11-09');
  assert.equal(calls(), 1);
  assert.equal(wrote, true);
  assert.deepEqual(snapshot.accounts.map((row) => row.accountId), ['a']);
  assert.deepEqual(snapshot.balances.map((row) => row.amountMinor), ['100']);
  const fresh = await readFinanceReviewSnapshot(db, 'alice', 'personal', '2026-11-09');
  assert.deepEqual(fresh.accounts.map((row) => row.accountId), ['a', 'new']);
  assert.deepEqual(fresh.balances.map((row) => row.amountMinor), ['100', '200', '300']);
});
