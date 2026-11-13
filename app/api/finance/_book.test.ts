import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { FinanceBookError, parseFinanceBookId, type FinanceBookActor, type FinanceBookScope } from '../../../lib/finance-books.ts';
import { inviteFinanceBookMember, respondFinanceBookInvitation, changeFinanceBookMember, resolveFinanceBookScope } from '../../../db/finance-books-store.ts';
import { financeBookDatabase } from '../../../db/finance-book-database.ts';
import { createFinanceAccount, findFinanceAccount, listFinanceAccounts, patchFinanceAccount } from '../../../db/finance-store.ts';
import { createFinanceGoalPlan, findFinanceGoalPlan } from '../../../db/finance-goals-store.ts';
import { exportDataBackup } from '../../../db/data-backup-store.ts';

const NOW = '2026-11-12T02:00:00.000Z';
const owner: FinanceBookActor = { userId: 'family-owner', email: 'owner@example.test', displayName: '家庭Owner', isOwner: false };
const bob: FinanceBookActor = { userId: 'bob', email: 'bob@example.test', displayName: 'Bob', isOwner: false };
const original = { ledger: 'family', name: '家庭存款', type: 'bank', currency: 'CNY', note: '', amountMinor: '10000', asOfDate: '2026-11-12' };
interface ScopeOptions { ledger?: 'personal' | 'family'; accountId?: string; goalId?: string; write?: { action: string; input: unknown; operationId?: string; targetId?: string } }
type RequestScope = (request: Request, actor: FinanceBookActor, options?: ScopeOptions) => Promise<{ scope: FinanceBookScope; db: D1Database }>;
interface NativeStatement { bind(...values: unknown[]): NativeStatement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<Result>; execute(): Result }
interface Result { results: Record<string, unknown>[]; meta: { changes: number } }

async function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../../../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
  const adapter = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const bound: NativeStatement = {
        bind(...args) { values = args as SQLInputValue[]; return bound; },
        execute() {
          const statement = sqlite.prepare(sql);
          return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } }
            : { results: [], meta: { changes: Number(statement.run(...values).changes) } };
        },
        async first<T>() { return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] }; },
        async run() { return bound.execute(); },
      }; return bound;
    },
    async batch(items: NativeStatement[]) {
      sqlite.exec('BEGIN');
      try { const results = items.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const db = adapter as unknown as D1Database;
  for (const actor of [owner, bob]) sqlite.prepare('INSERT INTO app_access_grants(id,email,bound_user_id,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), actor.email, actor.userId, 'active', 1, NOW, NOW);
  const ownerPersonal = await createFinanceAccount(db, owner.userId, { ...original, ledger: 'personal', name: 'OWNER PRIVATE SECRET', amountMinor: '987654321' }, NOW);
  const ownerFamily = await createFinanceAccount(db, owner.userId, original, NOW);
  const bobPersonal = await createFinanceAccount(db, bob.userId, { ...original, ledger: 'personal', name: 'Bob私人账户', amountMinor: '3000' }, NOW);
  const privateGoal = await createFinanceGoalPlan(db, owner.userId, { ledger: 'personal', currency: 'CNY', name: 'OWNER PRIVATE GOAL', targetMinor: '200000', deadline: '2027-01-31', accountIds: [ownerPersonal] }, crypto.randomUUID(), NOW);
  const familyGoal = await createFinanceGoalPlan(db, owner.userId, { ledger: 'family', currency: 'CNY', name: '家庭储蓄', targetMinor: '200000', deadline: '2027-01-31', accountIds: [ownerFamily] }, crypto.randomUUID(), NOW);
  const invitation = await inviteFinanceBookMember(db, owner, 'own', { email: bob.email }, crypto.randomUUID(), NOW);
  const book = sqlite.prepare('SELECT id FROM family_books WHERE owner_user_id=?').get(owner.userId)!;
  const bookId = String(book.id);
  const source = stripTypeScriptTypes(readFileSync(new URL('./_book.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const financeRequestScope = runInNewContext('(() => {\n' + source + '\nreturn financeRequestScope;})()', {
    env: { DB: db }, FinanceBookError, parseFinanceBookId, resolveFinanceBookScope, financeBookDatabase,
    crypto, JSON, Object, URL, TextEncoder,
  }) as RequestScope;
  function request(revision: number | null = 2, path = '/api/finance', includeBook = true) {
    const query = new URLSearchParams({ ledger: 'family' });
    if (includeBook) query.set('book', bookId);
    if (revision !== null) query.set('bookRevision', String(revision));
    return new Request('https://synthetic-family-chain.example' + path + '?' + query);
  }
  async function accept(revision = invitation.member.revision) {
    return respondFinanceBookInvitation(db, bob, invitation.member.id, { action: 'accept', expectedRevision: revision }, crypto.randomUUID(), NOW);
  }
  function businessState() {
    return JSON.stringify(['finance_accounts', 'finance_balance_entries', 'finance_goal_plans', 'family_finance_commands'].map((table) => sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()));
  }
  return { sqlite, db, ownerPersonal, ownerFamily, bobPersonal, privateGoal, familyGoal, invitation, bookId, request, accept, financeRequestScope, businessState };
}
const hasCode = (code: string) => (error: unknown) => { assert.ok(error instanceof FinanceBookError); assert.equal(error.code, code); return true; };

void test('actual request helper follows invitation acceptance into owner-family reads and actor-attributed create/edit commands', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.financeRequestScope(f.request(), bob, { ledger: 'family' }), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  const accepted = await f.accept(); assert.equal(accepted.member.revision, 2);
  const read = await f.financeRequestScope(f.request(), bob, { ledger: 'family' });
  assert.equal(read.scope.actorUserId, bob.userId); assert.equal(read.scope.ownerUserId, owner.userId); assert.equal(read.scope.role, 'editor');
  assert.deepEqual((await listFinanceAccounts(read.db, read.scope.ownerUserId, 'family')).map((account) => account.id), [f.ownerFamily]);
  const key = crypto.randomUUID(); const input = { ...original, name: 'Bob共同新增' };
  const create = await f.financeRequestScope(f.request(), bob, { ledger: 'family', write: { action: 'account.create', input, operationId: key, targetId: key } });
  assert.equal(await createFinanceAccount(create.db, create.scope.ownerUserId, input, NOW, key), key);
  const patch = { note: 'Bob共同修改', expectedRevision: 1 }; const updateKey = crypto.randomUUID();
  const edit = await f.financeRequestScope(f.request(2, '/api/finance/accounts/' + key), bob, { accountId: key, write: { action: 'account.update', input: patch, operationId: updateKey, targetId: key } });
  assert.equal(await patchFinanceAccount(edit.db, edit.scope.ownerUserId, key, patch, NOW), true);
  assert.equal((await findFinanceAccount(read.db, owner.userId, key))!.metadataRevision, 2);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM finance_accounts WHERE id=?').get(key)!.user_id, owner.userId);
  const journal = f.sqlite.prepare('SELECT actor_user_id,actor_name,actor_email,access_revision,membership_id FROM family_finance_commands WHERE operation_id=?').get(updateKey)!;
  assert.equal(journal.actor_user_id, bob.userId); assert.equal(journal.actor_name, 'Bob'); assert.equal(journal.actor_email, bob.email);
  assert.equal(journal.access_revision, 2); assert.equal(journal.membership_id, f.invitation.member.id);
  const ownerRead = await f.financeRequestScope(f.request(0), owner, { ledger: 'family' });
  assert.equal(ownerRead.scope.role, 'owner'); assert.equal(ownerRead.scope.isSiteOwner, false);
  assert.equal((await listFinanceAccounts(ownerRead.db, owner.userId, 'family')).length, 2, 'family ownership works for a regular admitted site account');
});

void test('actual resource gates reject owner personal IDs, unscoped owner IDs and missing or stale member write revisions', async (t) => {
  const f = await fixture(t); await f.accept();
  await assert.rejects(f.financeRequestScope(f.request(), bob, { accountId: f.ownerPersonal }), hasCode('FINANCE_ACCOUNT_NOT_FOUND'));
  await assert.rejects(f.financeRequestScope(f.request(), bob, { goalId: f.privateGoal.id }), hasCode('FINANCE_GOAL_NOT_FOUND'));
  await assert.rejects(f.financeRequestScope(f.request(null, '/api/finance/accounts/' + f.ownerFamily, false), bob, { accountId: f.ownerFamily }), hasCode('FINANCE_ACCOUNT_NOT_FOUND'));
  await assert.rejects(f.financeRequestScope(f.request(null, '/api/finance/goals/' + f.familyGoal.id, false), bob, { goalId: f.familyGoal.id }), hasCode('FINANCE_GOAL_NOT_FOUND'));
  await assert.rejects(f.financeRequestScope(f.request(), bob, { ledger: 'personal' }), hasCode('FINANCE_BOOK_INVALID'));
  const command = { action: 'account.create', input: original, operationId: crypto.randomUUID() };
  await assert.rejects(f.financeRequestScope(f.request(null), bob, { ledger: 'family', write: command }), hasCode('FINANCE_BOOK_ACCESS_CHANGED'));
  await assert.rejects(f.financeRequestScope(f.request(1), bob, { ledger: 'family', write: command }), hasCode('FINANCE_BOOK_ACCESS_CHANGED'));
  const goal = await f.financeRequestScope(f.request(), bob, { goalId: f.familyGoal.id });
  assert.equal((await findFinanceGoalPlan(goal.db, goal.scope.ownerUserId, f.familyGoal.id))!.name, '家庭储蓄');
  const personal = await f.financeRequestScope(new Request('https://synthetic-family-chain.example/api/finance/accounts/' + f.bobPersonal), bob, { accountId: f.bobPersonal });
  assert.equal(personal.scope.ownerUserId, bob.userId); assert.equal(personal.scope.ledger, 'personal');
});

void test('owner revoke blocks old resolved DBs and committed-key replay; reacceptance does not revive old pages or commands', async (t) => {
  const f = await fixture(t); await f.accept(); const key = crypto.randomUUID();
  const options = { ledger: 'family' as const, write: { action: 'account.create', input: original, operationId: key, targetId: key } };
  const committed = await f.financeRequestScope(f.request(), bob, options);
  await createFinanceAccount(committed.db, owner.userId, original, NOW, key);
  const oldRead = await f.financeRequestScope(f.request(), bob, { ledger: 'family' });
  const pendingKey = crypto.randomUUID();
  const pending = await f.financeRequestScope(f.request(), bob, { ledger: 'family', write: { action: 'account.create', input: original, operationId: pendingKey, targetId: pendingKey } });
  const before = f.businessState();
  const revoked = await changeFinanceBookMember(f.db, owner, f.bookId, f.invitation.member.id, { action: 'revoke', expectedRevision: 2 }, crypto.randomUUID(), NOW);
  assert.equal(revoked.member.revision, 3);
  await assert.rejects(listFinanceAccounts(oldRead.db, owner.userId, 'family'), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  await assert.rejects(createFinanceAccount(pending.db, owner.userId, original, NOW, pendingKey), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  await assert.rejects(createFinanceAccount(committed.db, owner.userId, original, NOW, key), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  await assert.rejects(f.financeRequestScope(f.request(), bob, options), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  assert.equal(f.businessState(), before);
  const invited = await inviteFinanceBookMember(f.db, owner, f.bookId, { email: bob.email }, crypto.randomUUID(), NOW);
  assert.equal(invited.member.revision, 4); const accepted = await f.accept(4); assert.equal(accepted.member.revision, 5);
  await assert.rejects(f.financeRequestScope(f.request(2), bob, options), hasCode('FINANCE_BOOK_ACCESS_CHANGED'));
  await assert.rejects(listFinanceAccounts(oldRead.db, owner.userId, 'family'), hasCode('FINANCE_BOOK_ACCESS_CHANGED'));
  const reclaim = await f.financeRequestScope(f.request(5), bob, options);
  await assert.rejects(createFinanceAccount(reclaim.db, owner.userId, original, NOW, key), hasCode('FINANCE_BOOK_OPERATION_CONFLICT'));
  assert.equal(f.businessState(), before);
});

void test('a member cannot claim legacy owner operation IDs and personal backups exclude shared data and all authorization tables', async (t) => {
  const f = await fixture(t); await f.accept(); const before = f.businessState();
  const collision = await f.financeRequestScope(f.request(), bob, { ledger: 'family', write: { action: 'account.create', input: original, operationId: f.ownerFamily, targetId: f.ownerFamily } });
  await assert.rejects(createFinanceAccount(collision.db, owner.userId, original, NOW, f.ownerFamily), hasCode('FINANCE_BOOK_OPERATION_CONFLICT'));
  assert.equal(f.businessState(), before);
  const backup = await exportDataBackup(f.db, bob.userId, NOW);
  assert.deepEqual(backup.tables.finance_accounts.map((account) => account.id), [f.bobPersonal]);
  assert.equal(backup.tables.finance_goal_plans.length, 0);
  assert.equal(backup.tables.finance_balance_entries.length, 1);
  for (const table of ['family_books', 'family_book_members', 'family_book_member_operations', 'family_finance_commands', 'app_access_grants']) assert.equal(Object.hasOwn(backup.tables, table), false, table);
  assert.equal(JSON.stringify(backup).includes('OWNER PRIVATE SECRET'), false);
  assert.equal(JSON.stringify(backup).includes('家庭存款'), false);
});
