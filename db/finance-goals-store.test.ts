import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { FinanceIdempotencyConflictError, FinanceMetadataConflictError } from './finance-store.ts';
import { createFinanceGoalPlan, findFinanceGoalPlan, patchFinanceGoalPlan, readFinanceGoalPlans } from './finance-goals-store.ts';
import type { FinanceGoalsDatabase } from './finance-goals-store.ts';
import { FinanceGoalValidationError, parseFinanceGoalCreate } from '../lib/finance-goals.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-09T02:00:00.000Z';
const LATER = '2026-11-10T02:00:00.000Z';
interface TestStatement { execute(): { results: unknown[]; meta: { changes: number } } }
function adapter(sqlite: DatabaseSync, beforeBatch?: () => void): FinanceGoalsDatabase {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        execute() { return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } }
          : { results: [], meta: { changes: Number(statement.run(...values).changes) } }; },
      };
      return bound;
    },
    async batch(statements: TestStatement[]) {
      if (beforeBatch) beforeBatch();
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as FinanceGoalsDatabase;
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort()) {
    sqlite.exec(readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  return { sqlite, db: adapter(sqlite) };
}
function account(sqlite: DatabaseSync, id = A, patch: { user?: string; ledger?: string; currency?: string; type?: string; archived?: string | null } = {}) {
  sqlite.prepare(`INSERT INTO finance_accounts (id, user_id, ledger, name, currency, type, note, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, '合成账户', ?, ?, '', ?, ?, ?)`)
    .run(id, patch.user ?? 'alice', patch.ledger ?? 'personal', patch.currency ?? 'CNY', patch.type ?? 'bank', NOW, NOW, patch.archived ?? null);
}
function input(patch: Record<string, unknown> = {}) {
  return parseFinanceGoalCreate({ ledger: 'personal', currency: 'CNY', name: '合成目标', targetAmount: '90071992547409.93', deadline: '2027-01-01', accountIds: [A], ...patch });
}

void test('goal edits archive and restore require the current revision and stale writes cannot change any field', async (t) => {
  const { sqlite, db } = fixture(t);account(sqlite);
  const key=crypto.randomUUID();const first=await createFinanceGoalPlan(db,'alice',input(),key,NOW);
  assert.equal(first.revision,1);
  const edited=(await patchFinanceGoalPlan(db,'alice',key,{name:'新目标',expectedRevision:1},LATER))!;
  assert.equal(edited.revision,2);
  await assert.rejects(patchFinanceGoalPlan(db,'alice',key,{archived:true,expectedRevision:1}),FinanceMetadataConflictError);
  await assert.rejects(patchFinanceGoalPlan(db,'alice',key,{name:'legacy'} as never),FinanceMetadataConflictError);
  assert.deepEqual(await findFinanceGoalPlan(db,'alice',key),edited);
  const archived=(await patchFinanceGoalPlan(db,'alice',key,{archived:true,expectedRevision:2},LATER))!;
  assert.equal(archived.revision,3);
  await assert.rejects(patchFinanceGoalPlan(db,'alice',key,{archived:false,expectedRevision:2}),FinanceMetadataConflictError);
  const restored=(await patchFinanceGoalPlan(db,'alice',key,{archived:false,expectedRevision:3},LATER))!;
  assert.equal(restored.revision,4);assert.equal(restored.archivedAt,null);
  assert.equal(await patchFinanceGoalPlan(db,'bob',key,{name:'foreign',expectedRevision:4}),null);
  assert.equal((await createFinanceGoalPlan(db,'alice',input(),key,NOW)).revision,4);
});

void test('goal compare-and-swap also rejects a concurrent edit committed after prevalidation', async (t) => {
  const { sqlite, db } = fixture(t); account(sqlite);
  const goal = await createFinanceGoalPlan(db, 'alice', input(), crypto.randomUUID(), NOW);
  const racing = adapter(sqlite, () => {
    sqlite.prepare('UPDATE finance_goal_plans SET name = ?, revision = revision + 1 WHERE id = ?').run('并发页面的修改', goal.id);
  });
  await assert.rejects(patchFinanceGoalPlan(racing, 'alice', goal.id, { name: '过期填写', archived: true, expectedRevision: 1 }, LATER), FinanceMetadataConflictError);
  const retained = (await findFinanceGoalPlan(db, 'alice', goal.id))!;
  assert.equal(retained.name, '并发页面的修改'); assert.equal(retained.revision, 2); assert.equal(retained.archivedAt, null);
});

void test('a goal persists exact text money and duplicate references normalize before validation', async (t) => {
  const { sqlite, db } = fixture(t);
  account(sqlite);
  const key = crypto.randomUUID();
  const goal = await createFinanceGoalPlan(db, 'alice', input({ accountIds: [A, A] }), key, NOW);
  assert.equal(goal.id, key);
  assert.equal(goal.targetMinor, '9007199254740993');
  assert.deepEqual(goal.accountIds, [A]);
  assert.equal(sqlite.prepare('SELECT typeof(target_minor) AS kind FROM finance_goal_plans').get()!.kind, 'text');
  assert.deepEqual(await findFinanceGoalPlan(db, 'alice', key), goal);
});

void test('immutable creation fingerprints replay without rolling back edits or requiring still-active linked accounts', async (t) => {
  const { sqlite, db } = fixture(t);
  account(sqlite);
  const key = crypto.randomUUID();
  const initial = input();
  const created = await createFinanceGoalPlan(db, 'alice', initial, key, NOW);
  const edited = await patchFinanceGoalPlan(db, 'alice', key, { expectedRevision: 1, name: '已编辑', targetMinor: '1', archived: true }, LATER);
  sqlite.prepare('UPDATE finance_accounts SET archived_at = ? WHERE id = ?').run(LATER, A);
  const replay = await createFinanceGoalPlan(db, 'alice', initial, key, '2026-11-11T02:00:00Z');
  assert.deepEqual(replay, edited);
  assert.equal(replay.creationHash, created.creationHash);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_goal_plans').get()!.total, 1);
  await assert.rejects(createFinanceGoalPlan(db, 'alice', input({ name: 'different' }), key, LATER), FinanceIdempotencyConflictError);
  await assert.rejects(createFinanceGoalPlan(db, 'bob', initial, key, LATER), FinanceIdempotencyConflictError);
});

void test('new links reject other owners, ledgers, currencies, liabilities and archived accounts without leaving a target', async (t) => {
  const { sqlite, db } = fixture(t);
  for (const patch of [{ user: 'bob' }, { ledger: 'family' }, { currency: 'USD' }, { type: 'loan' }, { archived: LATER }]) {
    sqlite.prepare('DELETE FROM finance_accounts').run();
    account(sqlite, A, patch);
    await assert.rejects(createFinanceGoalPlan(db, 'alice', input(), crypto.randomUUID(), NOW), FinanceGoalValidationError);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_goal_plans').get()!.total, 0);
  }
});

void test('goal listings and mutations isolate owner, ledger, currency and archive status', async (t) => {
  const { sqlite, db } = fixture(t);
  account(sqlite);
  account(sqlite, B, { ledger: 'family', currency: 'USD' });
  const alice = await createFinanceGoalPlan(db, 'alice', input(), crypto.randomUUID(), NOW);
  const family = await createFinanceGoalPlan(db, 'alice', input({ ledger: 'family', currency: 'USD', accountIds: [B] }), crypto.randomUUID(), NOW);
  const otherId = crypto.randomUUID();
  account(sqlite, otherId, { user: 'bob' });
  await createFinanceGoalPlan(db, 'bob', input({ accountIds: [otherId] }), crypto.randomUUID(), NOW);
  assert.deepEqual((await readFinanceGoalPlans(db, 'alice', 'personal', 'all')).map((row) => row.id), [alice.id]);
  assert.deepEqual((await readFinanceGoalPlans(db, 'alice', 'family', 'USD')).map((row) => row.id), [family.id]);
  assert.deepEqual(await readFinanceGoalPlans(db, 'alice', 'family', 'CNY'), []);
  assert.equal(await findFinanceGoalPlan(db, 'bob', alice.id), null);
  assert.equal(await patchFinanceGoalPlan(db, 'bob', alice.id, { expectedRevision: 1, name: 'unowned' }, LATER), null);
  await patchFinanceGoalPlan(db, 'alice', alice.id, { expectedRevision: 1, archived: true }, LATER);
  assert.deepEqual(await readFinanceGoalPlans(db, 'alice', 'personal', 'all'), []);
  assert.equal((await readFinanceGoalPlans(db, 'alice', 'personal', 'all', true)).length, 1);
  await patchFinanceGoalPlan(db, 'alice', alice.id, { expectedRevision: 2, archived: false }, LATER);
  assert.equal((await readFinanceGoalPlans(db, 'alice', 'personal', 'CNY')).length, 1);
});

void test('SQL rechecks linked account state after prevalidation and never writes a partial create or edit', async (t) => {
  const { sqlite, db } = fixture(t);
  account(sqlite);
  const racingCreate = adapter(sqlite, () => { sqlite.prepare('UPDATE finance_accounts SET archived_at = ? WHERE id = ?').run(LATER, A); });
  await assert.rejects(createFinanceGoalPlan(racingCreate, 'alice', input(), crypto.randomUUID(), NOW), FinanceGoalValidationError);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM finance_goal_plans').get()!.total, 0);
  sqlite.prepare('UPDATE finance_accounts SET archived_at = NULL WHERE id = ?').run(A);
  const existing = await createFinanceGoalPlan(db, 'alice', input(), crypto.randomUUID(), NOW);
  account(sqlite, B);
  const racingPatch = adapter(sqlite, () => { sqlite.prepare("UPDATE finance_accounts SET type = 'loan' WHERE id = ?").run(B); });
  await assert.rejects(patchFinanceGoalPlan(racingPatch, 'alice', existing.id, { expectedRevision: 1, name: 'must not leak', accountIds: [B] }, LATER), FinanceGoalValidationError);
  assert.deepEqual(await findFinanceGoalPlan(db, 'alice', existing.id), existing);
});

void test('inactive links can remain while renaming, archiving or restoring but cannot be explicitly reselected', async (t) => {
  const { sqlite, db } = fixture(t);
  account(sqlite);
  const existing = await createFinanceGoalPlan(db, 'alice', input(), crypto.randomUUID(), NOW);
  sqlite.prepare('UPDATE finance_accounts SET archived_at = ? WHERE id = ?').run(LATER, A);
  await patchFinanceGoalPlan(db, 'alice', existing.id, { expectedRevision: 1, name: '保留失效关联', archived: true }, LATER);
  const restored = await patchFinanceGoalPlan(db, 'alice', existing.id, { expectedRevision: 2, archived: false }, LATER);
  assert.equal(restored!.archivedAt, null);
  assert.deepEqual(restored!.accountIds, [A]);
  await assert.rejects(patchFinanceGoalPlan(db, 'alice', existing.id, { expectedRevision: 3, accountIds: [A] }, LATER), FinanceGoalValidationError);
});
