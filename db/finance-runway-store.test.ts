import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { FinanceRunwayConflictError, readFinanceRunwaySettings, writeFinanceRunwaySettings } from './finance-runway-store.ts';
import type { FinanceRunwayDatabase } from './finance-runway-store.ts';
import { FinanceRunwayValidationError, parseFinanceRunwayInput } from '../lib/finance-runway.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-09T00:00:00Z';
const LATER = '2026-11-10T00:00:00Z';
interface Statement { execute(): { results: unknown[]; meta: { changes: number } } }
function adapter(sqlite: DatabaseSync, beforeBatch?: () => void): FinanceRunwayDatabase {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        execute() { return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } }
          : { results: [], meta: { changes: Number(statement.run(...values).changes) } }; },
      };
      return bound;
    },
    async batch(statements: Statement[]) {
      if (beforeBatch) beforeBatch();
      sqlite.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as FinanceRunwayDatabase;
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  return { sqlite, db: adapter(sqlite) };
}
function addAccount(sqlite: DatabaseSync, id = A, patch: { user?: string; ledger?: string; currency?: string; type?: string; archived?: string | null } = {}) {
  sqlite.prepare(`INSERT INTO finance_accounts (id, user_id, ledger, name, type, currency, note, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, '合成资产', ?, ?, '', ?, ?, ?)`)
    .run(id, patch.user ?? 'alice', patch.ledger ?? 'personal', patch.type ?? 'bank', patch.currency ?? 'CNY', NOW, NOW, patch.archived ?? null);
}
function input(patch: Record<string, unknown> = {}) {
  return parseFinanceRunwayInput({ monthlyExpenseAmount: '90071992547409.93', targetMonths: 6, accountIds: [A], ...patch }, 'CNY');
}

void test('new scopes remain unset without inserting default values and settings replace atomically with exact text money', async (t) => {
  const { sqlite, db } = fixture(t);
  assert.equal(await readFinanceRunwaySettings(db, 'alice', 'personal', 'CNY'), null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_runway_settings').get()!.total, 0);
  addAccount(sqlite);
  const created = await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input(), 0, NOW);
  assert.equal(created.monthlyExpenseMinor, '9007199254740993');
  assert.equal(sqlite.prepare('SELECT typeof(monthly_expense_minor) AS kind FROM finance_runway_settings').get()!.kind, 'text');
  const changed = await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input({ monthlyExpenseAmount: '1', targetMonths: 3 }), 1, LATER);
  assert.equal(changed.monthlyExpenseMinor, '100');
  assert.equal(changed.targetMonths, 3);
  assert.equal(changed.createdAt, NOW);
  assert.equal(changed.updatedAt, LATER);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_runway_settings').get()!.total, 1);
});

void test('owner, ledger and currency settings are independent and queries never borrow another scope', async (t) => {
  const { sqlite, db } = fixture(t);
  addAccount(sqlite);
  addAccount(sqlite, B, { user: 'bob' });
  const familyAccount = crypto.randomUUID();
  addAccount(sqlite, familyAccount, { ledger: 'family', currency: 'USD' });
  await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input(), 0, NOW);
  await writeFinanceRunwaySettings(db, 'bob', 'personal', 'CNY', input({ accountIds: [B] }), 0, NOW);
  await writeFinanceRunwaySettings(db, 'alice', 'family', 'USD', input({ accountIds: [familyAccount], targetMonths: 12 }), 0, NOW);
  assert.equal((await readFinanceRunwaySettings(db, 'alice', 'personal', 'CNY'))!.targetMonths, 6);
  assert.equal((await readFinanceRunwaySettings(db, 'alice', 'family', 'USD'))!.targetMonths, 12);
  assert.equal(await readFinanceRunwaySettings(db, 'alice', 'personal', 'USD'), null);
  assert.equal(await readFinanceRunwaySettings(db, "alice' OR 1=1 --", 'personal', 'CNY'), null);
  await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input({ targetMonths: 2 }), 1, LATER);
  assert.equal((await readFinanceRunwaySettings(db, 'bob', 'personal', 'CNY'))!.targetMonths, 6);
});

void test('first selection rejects cross-owner, ledger, currency, liability and archived account references without a row', async (t) => {
  const { sqlite, db } = fixture(t);
  for (const patch of [{ user: 'bob' }, { ledger: 'family' }, { currency: 'USD' }, { type: 'loan' }, { archived: NOW }]) {
    sqlite.prepare('DELETE FROM finance_accounts').run();
    addAccount(sqlite, A, patch);
    await assert.rejects(writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input(), 0, NOW), FinanceRunwayValidationError);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_runway_settings').get()!.total, 0);
  }
});

void test('unchanged references may remain inactive while expense and target change, but newly selected links must be active assets', async (t) => {
  const { sqlite, db } = fixture(t);
  addAccount(sqlite);
  await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input(), 0, NOW);
  sqlite.prepare('UPDATE finance_accounts SET archived_at = ? WHERE id = ?').run(LATER, A);
  const changed = await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input({ targetMonths: 8 }), 1, LATER);
  assert.deepEqual(changed.accountIds, [A]);
  assert.equal(changed.targetMonths, 8);
  addAccount(sqlite, B, { type: 'loan' });
  await assert.rejects(writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input({ accountIds: [B] }), 2, LATER), FinanceRunwayValidationError);
  assert.deepEqual(await readFinanceRunwaySettings(db, 'alice', 'personal', 'CNY'), changed);
});

void test('SQL state rechecks prevent a half-create or lost old settings when selected accounts change after prevalidation', async (t) => {
  const { sqlite, db } = fixture(t);
  addAccount(sqlite);
  const initialRace = adapter(sqlite, () => { sqlite.prepare('UPDATE finance_accounts SET archived_at = ? WHERE id = ?').run(LATER, A); });
  await assert.rejects(writeFinanceRunwaySettings(initialRace, 'alice', 'personal', 'CNY', input(), 0, NOW), FinanceRunwayValidationError);
  assert.equal(await readFinanceRunwaySettings(db, 'alice', 'personal', 'CNY'), null);
  sqlite.prepare('UPDATE finance_accounts SET archived_at = NULL WHERE id = ?').run(A);
  const initial = await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input(), 0, NOW);
  addAccount(sqlite, B);
  const changedRace = adapter(sqlite, () => { sqlite.prepare("UPDATE finance_accounts SET type = 'loan' WHERE id = ?").run(B); });
  await assert.rejects(writeFinanceRunwaySettings(changedRace, 'alice', 'personal', 'CNY', input({ accountIds: [B], targetMonths: 12 }), 1, LATER), FinanceRunwayValidationError);
  assert.deepEqual(await readFinanceRunwaySettings(db, 'alice', 'personal', 'CNY'), initial);
});

void test('stale tab writes never replace the first saved revision, including an in-transaction race', async (t) => {
  const { sqlite, db } = fixture(t); addAccount(sqlite);
  const first = await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input(), 0, NOW);
  assert.equal(first.revision, 1);
  const second = await writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input({ targetMonths: 8 }), first.revision, LATER);
  assert.equal(second.revision, 2);
  await assert.rejects(writeFinanceRunwaySettings(db, 'alice', 'personal', 'CNY', input({ targetMonths: 99 }), first.revision), FinanceRunwayConflictError);
  assert.equal((await readFinanceRunwaySettings(db, 'alice', 'personal', 'CNY'))?.targetMonths, 8);
  const raced = adapter(sqlite, () => sqlite.prepare('UPDATE finance_runway_settings SET revision=revision+1,target_months=10 WHERE user_id=?').run('alice'));
  await assert.rejects(writeFinanceRunwaySettings(raced, 'alice', 'personal', 'CNY', input({ targetMonths: 99 }), second.revision), FinanceRunwayConflictError);
  const latest = await readFinanceRunwaySettings(db, 'alice', 'personal', 'CNY');
  assert.equal(latest?.revision, 3); assert.equal(latest?.targetMonths, 10);
});

void test('two initial tabs with revision zero cannot overwrite a concurrent first creation', async (t) => {
  const { sqlite } = fixture(t); addAccount(sqlite);
  const raced = adapter(sqlite, () => sqlite.prepare(`INSERT INTO finance_runway_settings
    (user_id,ledger,currency,monthly_expense_minor,target_months,account_ids_json,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('alice','personal','CNY','10000',4,JSON.stringify([A]),NOW,NOW,1));
  await assert.rejects(writeFinanceRunwaySettings(raced, 'alice', 'personal', 'CNY', input({ targetMonths: 99 }), 0), FinanceRunwayConflictError);
  assert.equal(sqlite.prepare('SELECT target_months FROM finance_runway_settings').get()?.target_months, 4);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM finance_runway_settings').get()?.n, 1);
});
