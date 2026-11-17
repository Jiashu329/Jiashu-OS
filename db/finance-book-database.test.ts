import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { financeBookDatabase, type FinanceBookCommand } from './finance-book-database.ts';
import { appendFinanceBalance, createFinanceAccount, findFinanceAccount, patchFinanceAccount, FinanceMetadataConflictError } from './finance-store.ts';
import type { FinanceBookScope } from '../lib/finance-books.ts';
import { SQLiteD1Database } from '../selfhost/database.ts';
import { loadMigrations } from '../selfhost/migrations.ts';
import { bootstrapLocalOwner, createLocalUser, updateLocalUser } from './local-users-store.ts';
import { inviteFinanceBookMember, resolveFinanceBookScope, respondFinanceBookInvitation } from './finance-books-store.ts';

const time = '2026-11-13T01:00:00.000Z';
const bookId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const input = { ledger: 'family', name: '家庭存款', type: 'bank', currency: 'CNY', note: '', amountMinor: '10000', asOfDate: '2026-11-12' };
const owner: FinanceBookScope = { actorUserId: 'owner', actorEmail: 'owner@example.com', actorName: 'Owner', ownerUserId: 'owner', ledger: 'family', bookId, role: 'owner', membershipId: null, accessRevision: 0, isSiteOwner: true };
const editor: FinanceBookScope = { ...owner, actorUserId: 'editor', actorEmail: 'editor@example.com', actorName: 'Editor', role: 'editor', membershipId: memberId, accessRevision: 2, isSiteOwner: false };
const command = (action = 'account.create', targetId: string | null = null): FinanceBookCommand => ({ operationId: crypto.randomUUID(), requestHash: 'a'.repeat(64), action, targetId });
interface NativeStatement { sql: string; bind(...values: unknown[]): NativeStatement; execute(): { results: Record<string, unknown>[]; meta: { changes: number } }; first<T>(): Promise<T | null> }
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  let hook: (() => void) | null = null;
  const adapter = {
    prepare(sql: string) {
      function bind(values: SQLInputValue[] = []): NativeStatement {
        return { sql, bind(...next: unknown[]) { return bind(next as SQLInputValue[]); },
          execute() {
            const native = sqlite.prepare(sql);
            const before = Number(sqlite.prepare('SELECT total_changes() n').get()!.n);
            const results = native.columns().length ? native.all(...values) : (native.run(...values), []);
            return { results, meta: { changes: Number(sqlite.prepare('SELECT total_changes() n').get()!.n) - before } };
          }, async first<T>() { return sqlite.prepare(sql).get(...values) as T ?? null; },
        };
      }
      return bind();
    },
    async batch(items: NativeStatement[]) {
      if (items.some((item) => /^\s*(INSERT|UPDATE|DELETE)/i.test(item.sql) && !item.sql.includes('INTO family_finance_commands'))) { const next = hook; hook = null; next?.(); }
      sqlite.exec('BEGIN');
      try { const result = items.map((item) => item.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  sqlite.prepare('INSERT INTO family_books(id,owner_user_id,owner_email,owner_name,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(bookId, 'owner', owner.actorEmail, owner.actorName, '家庭', time, time);
  const addMember = (scope: FinanceBookScope) => {
    sqlite.prepare('INSERT INTO family_book_members(id,book_id,email,user_id,status,revision,expires_at,accepted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(scope.membershipId!, bookId, scope.actorEmail, scope.actorUserId, 'active', scope.accessRevision, '2026-11-01T00:00:00.000Z', time, time, time);
    sqlite.prepare('INSERT INTO app_access_grants(id,email,bound_user_id,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), scope.actorEmail, scope.actorUserId, 'active', 1, time, time);
  };
  addMember(editor);
  return { sqlite, db: adapter as unknown as D1Database, beforeWrite(this: void, fn: () => void) { hook = fn; }, addMember };
}
const hasCode = (code: string) => (error: unknown) => { assert.equal((error as { code: string }).code, code); return true; };
const count = (sqlite: DatabaseSync, table: string) => Number(sqlite.prepare('SELECT COUNT(*) n FROM ' + table).get()!.n);

void test('legacy databases stay identical; shared statements cannot write authorization tables or bypass prepared guards', async (t) => {
  const { db } = fixture(t);
  assert.equal(financeBookDatabase(db, { ...owner, bookId: null }), db);
  const shared = financeBookDatabase(db, editor);
  assert.throws(() => shared.prepare("UPDATE app_access_grants SET status='active'"), /Only finance/);
  assert.throws(() => shared.prepare('SELECT 1; DELETE FROM app_access_grants'), /exactly one/);
  assert.throws(() => shared.exec('UPDATE finance_accounts SET name=1'), /prepared/);
  await assert.rejects(shared.prepare('UPDATE finance_accounts SET note=? WHERE user_id=?').bind('x', 'owner').run(), hasCode('FINANCE_BOOK_COMMAND_REQUIRED'));
});

void test('editor create and same-actor replay retain one receipt and preserve store result indices and changes chains', async (t) => {
  const { db, sqlite } = fixture(t); const cmd = command();
  const shared = financeBookDatabase(db, editor, cmd);
  const id = await createFinanceAccount(shared, 'owner', input, time, cmd.operationId);
  assert.equal(await createFinanceAccount(shared, 'owner', input, time, cmd.operationId), id);
  assert.equal(count(sqlite, 'finance_accounts'), 1); assert.equal(count(sqlite, 'finance_balance_entries'), 1); assert.equal(count(sqlite, 'family_finance_commands'), 1);
  const balanceCmd = command('balance.append', id);
  await appendFinanceBalance(financeBookDatabase(db, editor, balanceCmd), 'owner', id, { amountMinor: '20000', asOfDate: input.asOfDate, note: '' }, time, balanceCmd.operationId);
  assert.equal((await findFinanceAccount(financeBookDatabase(db, editor), 'owner', id))!.balanceRevision, 1);
  assert.equal(count(sqlite, 'family_finance_commands'), 2);
  const receipt = sqlite.prepare('SELECT actor_user_id,actor_name,actor_email,membership_id,access_revision FROM family_finance_commands WHERE operation_id=?').get(cmd.operationId)!;
  assert.equal(receipt.actor_user_id, 'editor'); assert.equal(receipt.actor_name, 'Editor'); assert.equal(receipt.actor_email, editor.actorEmail); assert.equal(receipt.membership_id, memberId); assert.equal(receipt.access_revision, 2);
});

void test('revocation between pre-read and commit aborts all business and audit writes and every early replay', async (t) => {
  const { db, sqlite, beforeWrite } = fixture(t); const cmd = command();
  const shared = financeBookDatabase(db, editor, cmd);
  beforeWrite(() => sqlite.prepare("UPDATE family_book_members SET status='revoked',revision=revision+1 WHERE id=?").run(memberId));
  await assert.rejects(createFinanceAccount(shared, 'owner', input, time, cmd.operationId), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  assert.equal(count(sqlite, 'finance_accounts'), 0); assert.equal(count(sqlite, 'finance_balance_entries'), 0); assert.equal(count(sqlite, 'family_finance_commands'), 0);
  await assert.rejects(shared.prepare('SELECT * FROM finance_accounts').all(), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
});

void test('site access revocation is checked again in the write transaction', async (t) => {
  const { db, sqlite, beforeWrite } = fixture(t); const cmd = command();
  beforeWrite(() => sqlite.prepare("UPDATE app_access_grants SET status='revoked' WHERE bound_user_id=?").run(editor.actorUserId));
  await assert.rejects(createFinanceAccount(financeBookDatabase(db, editor, cmd), 'owner', input, time, cmd.operationId), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  assert.equal(count(sqlite, 'finance_accounts'), 0); assert.equal(count(sqlite, 'family_finance_commands'), 0);
});

void test('reinvitation changes the authorization generation and cannot reclaim a prior command', async (t) => {
  const { db, sqlite } = fixture(t); const cmd = command();
  await createFinanceAccount(financeBookDatabase(db, editor, cmd), 'owner', input, time, cmd.operationId);
  sqlite.prepare('UPDATE family_book_members SET revision=revision+2 WHERE id=?').run(memberId);
  await assert.rejects(financeBookDatabase(db, editor, cmd).prepare('SELECT 1').first(), hasCode('FINANCE_BOOK_ACCESS_CHANGED'));
  const reinvited = { ...editor, accessRevision: 4 };
  await assert.rejects(createFinanceAccount(financeBookDatabase(db, reinvited, cmd), 'owner', input, time, cmd.operationId), hasCode('FINANCE_BOOK_OPERATION_CONFLICT'));
  const fresh = command();
  await createFinanceAccount(financeBookDatabase(db, reinvited, fresh), 'owner', input, time, fresh.operationId);
  assert.equal(count(sqlite, 'finance_accounts'), 2);
});

void test('another actor or changed hash cannot replay a command and editors cannot claim unreceipted owner IDs', async (t) => {
  const { db, sqlite, addMember } = fixture(t); const cmd = command();
  await createFinanceAccount(financeBookDatabase(db, editor, cmd), 'owner', input, time, cmd.operationId);
  const other = { ...editor, actorUserId: 'editor-2', actorEmail: 'second@example.com', membershipId: crypto.randomUUID() }; addMember(other);
  await assert.rejects(createFinanceAccount(financeBookDatabase(db, other, cmd), 'owner', input, time, cmd.operationId), hasCode('FINANCE_BOOK_OPERATION_CONFLICT'));
  await assert.rejects(financeBookDatabase(db, editor, { ...cmd, requestHash: 'b'.repeat(64) }).prepare('SELECT 1').first(), hasCode('FINANCE_BOOK_OPERATION_CONFLICT'));
  const legacy = command(); await createFinanceAccount(db, 'owner', input, time, legacy.operationId);
  await assert.rejects(createFinanceAccount(financeBookDatabase(db, editor, legacy), 'owner', input, time, legacy.operationId), hasCode('FINANCE_BOOK_OPERATION_CONFLICT'));
  assert.equal(await createFinanceAccount(financeBookDatabase(db, owner, legacy), 'owner', input, time, legacy.operationId), legacy.operationId);
  assert.equal(count(sqlite, 'family_finance_commands'), 1);
});

void test('metadata changes and their audit commit together; failed CAS and failed journal never consume a command', async (t) => {
  const { db, sqlite, beforeWrite } = fixture(t);
  const id = await createFinanceAccount(db, 'owner', input, time);
  const cmd = command('account.patch', id);
  const shared = financeBookDatabase(db, editor, cmd);
  sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON family_finance_commands BEGIN SELECT RAISE(ABORT,'synthetic audit unavailable'); END");
  await assert.rejects(patchFinanceAccount(shared, 'owner', id, { type: 'cash', expectedRevision: 1 }, time), /synthetic audit/);
  assert.equal((await findFinanceAccount(db, 'owner', id))!.metadataRevision, 1);
  assert.equal(count(sqlite, 'finance_account_classifications'), 1); assert.equal(count(sqlite, 'family_finance_commands'), 0);
  sqlite.exec('DROP TRIGGER fail_audit');
  assert.equal(await patchFinanceAccount(shared, 'owner', id, { type: 'cash', expectedRevision: 1 }, time), true);
  assert.equal(count(sqlite, 'finance_account_classifications'), 2); assert.equal(count(sqlite, 'family_finance_commands'), 1);
  const staleCmd = command('account.patch', id);
  beforeWrite(() => sqlite.prepare('UPDATE finance_accounts SET metadata_revision=metadata_revision+1 WHERE id=?').run(id));
  await assert.rejects(patchFinanceAccount(financeBookDatabase(db, editor, staleCmd), 'owner', id, { note: 'stale', expectedRevision: 2 }, time), FinanceMetadataConflictError);
  assert.equal(count(sqlite, 'family_finance_commands'), 1);
  assert.equal((await findFinanceAccount(db, 'owner', id))!.note, '');
});

void test('direct first/run writes are guarded and audited while reads preserve first(column) and bound values', async (t) => {
  const { db, sqlite } = fixture(t); const id = await createFinanceAccount(db, 'owner', input, time);
  const shared = financeBookDatabase(db, editor, command('account.patch', id));
  const result = await shared.prepare('UPDATE finance_accounts SET note=? WHERE user_id=? AND id=? RETURNING note').bind('direct', 'owner', id).first<string>('note');
  assert.equal(result, 'direct'); assert.equal(count(sqlite, 'family_finance_commands'), 1);
  assert.equal(await financeBookDatabase(db, editor).prepare('SELECT note FROM finance_accounts WHERE id=?').bind(id).first<string>('note'), 'direct');
  const run = financeBookDatabase(db, editor, command('account.patch', id));
  assert.equal((await run.prepare('UPDATE finance_accounts SET note=? WHERE user_id=? AND id=?').bind('run', 'owner', id).run()).meta.changes, 1);
  assert.equal(count(sqlite, 'family_finance_commands'), 2);
});

void test('a revoked actor cannot replay an already committed command even when the original business fingerprint matches', async (t) => {
  const { db, sqlite } = fixture(t); const cmd = command();
  await createFinanceAccount(financeBookDatabase(db, editor, cmd), 'owner', input, time, cmd.operationId);
  sqlite.prepare("UPDATE family_book_members SET status='revoked',revision=revision+1 WHERE id=?").run(memberId);
  await assert.rejects(createFinanceAccount(financeBookDatabase(db, editor, cmd), 'owner', input, time, cmd.operationId), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  assert.equal(count(sqlite, 'finance_accounts'), 1); assert.equal(count(sqlite, 'family_finance_commands'), 1);
});

void test('the self-host SQLite transaction rechecks account credentials independently of Sites grants', async (t) => {
  const db = new SQLiteD1Database(':memory:');
  t.after(() => db.close());
  const migrations = loadMigrations();
  db.transaction(() => { for (const migration of migrations) db.executeMigrationSQL(migration.sql); });
  const passwordHash = ['scrypt-v1', '32768', '8', '1', Buffer.alloc(16, 1).toString('base64url'), Buffer.alloc(64, 2).toString('base64url')].join('$');
  const admin = { userId: owner.actorUserId, email: owner.actorEmail, isOwner: true, localAccountRevision: 1 };
  const actor = { userId: crypto.randomUUID(), email: editor.actorEmail, localAccountRevision: 1 };
  await bootstrapLocalOwner(db, { id: admin.userId, email: admin.email, passwordHash }, time);
  await createLocalUser(db, { id: actor.userId, email: actor.email, passwordHash }, time);
  const invitation = await inviteFinanceBookMember(db, admin, 'own', { email: actor.email }, crypto.randomUUID(), time);
  const accepted = await respondFinanceBookInvitation(db, actor, invitation.member.id, { action: 'accept', expectedRevision: 1 }, crypto.randomUUID(), time);
  const book = await db.prepare('SELECT id FROM family_books WHERE owner_user_id=?').bind(admin.userId).first<string>('id');
  assert.ok(book);

  const sitesScope = await resolveFinanceBookScope(db, { userId: actor.userId, email: actor.email }, 'family', book, accepted.member.revision);
  await assert.rejects(financeBookDatabase(db, sitesScope).prepare('SELECT 1').first(), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  const localScope = await resolveFinanceBookScope(db, actor, 'family', book, accepted.member.revision);
  const cmd = command();
  const guarded = financeBookDatabase(db, localScope, cmd);
  assert.equal(await createFinanceAccount(guarded, admin.userId, input, time, cmd.operationId), cmd.operationId);
  const pending = command();
  const pendingWrite = financeBookDatabase(db, localScope, pending);

  // A Sites grant must not preserve a stale or disabled local account's access.
  await db.prepare("INSERT INTO app_access_grants(id,email,bound_user_id,status,revision,created_at,updated_at) VALUES(?,?,?,'active',1,?,?)")
    .bind(crypto.randomUUID(), actor.email, actor.userId, time, time).run();
  await updateLocalUser(db, admin.userId, actor.userId, { expectedRevision: 1, passwordHash }, time);
  await assert.rejects(createFinanceAccount(guarded, admin.userId, input, time, cmd.operationId), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  await assert.rejects(createFinanceAccount(pendingWrite, admin.userId, input, time, pending.operationId), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  const fresh = await resolveFinanceBookScope(db, { ...actor, localAccountRevision: 2 }, 'family', book, accepted.member.revision);
  assert.equal((await findFinanceAccount(financeBookDatabase(db, fresh), admin.userId, cmd.operationId))?.id, cmd.operationId);
  await updateLocalUser(db, admin.userId, actor.userId, { expectedRevision: 2, status: 'disabled' }, time);
  await assert.rejects(findFinanceAccount(financeBookDatabase(db, fresh), admin.userId, cmd.operationId), hasCode('FINANCE_BOOK_ACCESS_REVOKED'));
  assert.equal(count(db.sqlite, 'finance_accounts'), 1);
  assert.equal(count(db.sqlite, 'family_finance_commands'), 1);
});
