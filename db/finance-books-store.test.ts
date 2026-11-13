import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { FinanceBookError } from '../lib/finance-books.ts';
import type { FinanceBookActor } from '../lib/finance-books.ts';
import {
  changeFinanceBookMember, ensureOwnFamilyBook, inviteFinanceBookMember, listFinanceBookMembers, listFinanceBooks,
  resolveFinanceBookScope, respondFinanceBookInvitation,
} from './finance-books-store.ts';
import type { FinanceBooksDatabase } from './finance-books-store.ts';

const NOW = '2026-11-13T03:00:00.000Z';
const LATER = '2026-11-14T03:00:00.000Z';
const owner: FinanceBookActor = { userId: 'book-owner', email: 'owner@example.test', displayName: 'Owner' };
const member: FinanceBookActor = { userId: 'book-member', email: 'member@example.test', displayName: 'Member' };
const other: FinanceBookActor = { userId: 'other-owner', email: 'other@example.test', displayName: 'Other', isOwner: true };
const uuid = () => crypto.randomUUID();
const code = (expected: string, status?: number) => (error: unknown) => error instanceof FinanceBookError && error.code === expected && (status === undefined || error.status === status);

interface LocalStatement {
  bind(...values: unknown[]): LocalStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: unknown[]; meta: { changes: number } }>;
  execute(): { results: unknown[]; meta: { changes: number } };
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
  let hook: (() => void) | null = null;
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql); const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound: LocalStatement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (bound.execute().results[0] as T | undefined) ?? null; },
        async all<T>() { return { results: bound.execute().results as T[] }; },
        async run() { return bound.execute(); },
        execute() {
          const before = Number(sqlite.prepare('SELECT total_changes() AS n').get()?.n);
          const results = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
          return { results, meta: { changes: Number(sqlite.prepare('SELECT total_changes() AS n').get()?.n) - before } };
        },
      }; return bound;
    },
    async batch(statements: LocalStatement[]) {
      const action = hook; hook = null; action?.();
      sqlite.exec('BEGIN');
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as FinanceBooksDatabase;
  return { db, sqlite, queries, beforeBatch(action: () => void) { hook = action; }, count(table: string) { assert.match(table, /^(family_books|family_book_members|family_book_member_operations|family_finance_commands)$/); return Number(sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get()?.n); } };
}

async function invite(f: ReturnType<typeof fixture>, actor = owner, email = member.email) {
  const result = await inviteFinanceBookMember(f.db, actor, 'own', { email }, uuid(), NOW);
  return { ...result, book: await ensureOwnFamilyBook(f.db, actor, NOW) };
}
async function join(f: ReturnType<typeof fixture>, actor = member, bookOwner = owner) {
  const invitation = await invite(f, bookOwner, actor.email);
  const accepted = await respondFinanceBookInvitation(f.db, actor, invitation.member.id, { action: 'accept', expectedRevision: invitation.member.revision }, uuid(), NOW);
  return { ...accepted, book: invitation.book };
}

void test('legacy personal and family scopes remain owned by the actor without creating a household on read', async (t) => {
  const f = fixture(t);
  const personal = await resolveFinanceBookScope(f.db, owner, 'personal');
  const family = await resolveFinanceBookScope(f.db, owner, 'family', 'own', 0);
  assert.equal(personal.ownerUserId, owner.userId); assert.equal(personal.bookId, null);
  assert.equal(family.ownerUserId, owner.userId); assert.equal(family.bookId, null); assert.equal(family.accessRevision, 0);
  assert.equal(family.membershipId, null); assert.equal(family.role, 'owner'); assert.equal(f.count('family_books'), 0);
  const books = await listFinanceBooks(f.db, owner, NOW); assert.equal(books.books.length, 1); assert.equal(books.books[0].id, 'own');
  assert.deepEqual((await listFinanceBookMembers(f.db, owner)).members, []); assert.equal(f.count('family_books'), 0);
  await assert.rejects(resolveFinanceBookScope(f.db, owner, 'personal', uuid()), code('FINANCE_BOOK_INVALID', 400));
  await assert.rejects(resolveFinanceBookScope(f.db, owner, 'family', 'own', 2), code('FINANCE_BOOK_ACCESS_CHANGED', 409));
});

void test('one lazy family book per stable owner is unique, preserves existing finance ownership and ignores site-owner status', async (t) => {
  const f = fixture(t);
  const accountId = uuid();
  f.sqlite.prepare(`INSERT INTO finance_accounts(id,user_id,ledger,name,type,currency,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(accountId, owner.userId, 'family', 'Legacy family account', 'bank', 'CNY', '', NOW, NOW);
  const [one, two] = await Promise.all([ensureOwnFamilyBook(f.db, owner, NOW), ensureOwnFamilyBook(f.db, owner, NOW)]);
  assert.equal(one.id, two.id); assert.equal(f.count('family_books'), 1);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM finance_accounts WHERE id=?').get(accountId)?.user_id, owner.userId);
  await assert.rejects(resolveFinanceBookScope(f.db, other, 'family', one.id), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
  await assert.rejects(listFinanceBookMembers(f.db, other, one.id), code('FINANCE_BOOK_OWNER_REQUIRED', 403));
});

void test('invitations are explicit, verified-email bound, thirty days long and expose no stable user identifiers', async (t) => {
  const f = fixture(t); const invitation = await invite(f);
  assert.equal(invitation.member.status, 'pending'); assert.equal(invitation.member.bound, false);
  assert.equal(invitation.member.expiresAt, '2026-12-13T03:00:00.000Z');
  assert.equal(Object.hasOwn(invitation.member, 'userId'), false);
  assert.equal((await listFinanceBooks(f.db, member, NOW)).invitations[0].id, invitation.member.id);
  await assert.rejects(resolveFinanceBookScope(f.db, member, 'family', invitation.book.id), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
  await assert.rejects(respondFinanceBookInvitation(f.db, other, invitation.member.id, { action: 'accept', expectedRevision: 1 }, uuid(), NOW), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
  const accepted = await respondFinanceBookInvitation(f.db, { ...member, email: ' MEMBER@EXAMPLE.TEST ' }, invitation.member.id, { action: 'accept', expectedRevision: 1 }, uuid(), NOW);
  assert.equal(accepted.member.status, 'active'); assert.equal(accepted.member.revision, 2); assert.equal(accepted.member.bound, true);
  assert.equal(Object.hasOwn(accepted.member, 'userId'), false);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM family_book_members WHERE id=?').get(accepted.member.id)?.user_id, member.userId);
});

void test('active membership follows the stable user even after email changes and invitation expiration', async (t) => {
  const f = fixture(t); const joined = await join(f);
  const actor = { ...member, email: 'new-member@example.test' };
  const scope = await resolveFinanceBookScope(f.db, actor, 'family', joined.book.id, 2);
  assert.equal(scope.ownerUserId, owner.userId); assert.equal(scope.actorUserId, member.userId); assert.equal(scope.actorEmail, actor.email);
  assert.equal(scope.bookId, joined.book.id); assert.equal(scope.membershipId, joined.member.id); assert.equal(scope.role, 'editor');
  assert.equal((await listFinanceBooks(f.db, actor, '2027-01-01T00:00:00Z')).books[1].id, joined.book.id);
  await assert.rejects(resolveFinanceBookScope(f.db, { ...other, email: member.email }, 'family', joined.book.id), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
});

void test('accepted members can join several independent books but cannot invite or revoke anyone', async (t) => {
  const f = fixture(t); const first = await join(f); const second = await join(f, member, other);
  const choices = await listFinanceBooks(f.db, member, NOW);
  assert.deepEqual(new Set(choices.books.map((book) => book.id)), new Set(['own', first.book.id, second.book.id]));
  assert.ok(choices.books.filter((book) => book.id !== 'own').every((book) => !book.canManageMembers && !book.canExport && book.role === 'editor'));
  await assert.rejects(inviteFinanceBookMember(f.db, member, first.book.id, { email: 'new@example.test' }, uuid(), NOW), code('FINANCE_BOOK_OWNER_REQUIRED', 403));
  await assert.rejects(changeFinanceBookMember(f.db, member, first.book.id, first.member.id, { action: 'revoke', expectedRevision: 2 }, uuid(), NOW), code('FINANCE_BOOK_OWNER_REQUIRED', 403));
  await assert.rejects(listFinanceBookMembers(f.db, member, first.book.id), code('FINANCE_BOOK_OWNER_REQUIRED', 403));
});

void test('revocation is immediate and a new invitation generation cannot reuse stale accept commands', async (t) => {
  const f = fixture(t); const invitation = await invite(f); const acceptId = uuid();
  await respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'accept', expectedRevision: 1 }, acceptId, NOW);
  await changeFinanceBookMember(f.db, owner, 'own', invitation.member.id, { action: 'revoke', expectedRevision: 2 }, uuid(), LATER);
  await assert.rejects(resolveFinanceBookScope(f.db, member, 'family', invitation.book.id, 2), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
  const retry = await respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'accept', expectedRevision: 1 }, acceptId, LATER);
  assert.equal(retry.replayed, true); assert.equal(retry.member.status, 'revoked');
  const reinvited = await inviteFinanceBookMember(f.db, owner, 'own', { email: member.email }, uuid(), LATER);
  assert.equal(reinvited.member.id, invitation.member.id); assert.equal(reinvited.member.revision, 4); assert.equal(reinvited.member.bound, true);
  assert.equal(reinvited.member.acceptedAt, null); assert.equal(reinvited.member.expiresAt, '2026-12-14T03:00:00.000Z');
  await assert.rejects(respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'accept', expectedRevision: 1 }, uuid(), LATER), code('FINANCE_BOOK_MEMBER_CHANGED', 409));
  await respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'accept', expectedRevision: 4 }, uuid(), LATER);
  await assert.rejects(resolveFinanceBookScope(f.db, member, 'family', invitation.book.id, 2), code('FINANCE_BOOK_ACCESS_CHANGED', 409));
  assert.equal((await resolveFinanceBookScope(f.db, member, 'family', invitation.book.id, 5)).accessRevision, 5);
});

void test('reinviting a revoked email retains its original user binding and cannot authorize a different user at that email', async (t) => {
  const f = fixture(t); const joined = await join(f);
  await changeFinanceBookMember(f.db, owner, 'own', joined.member.id, { action: 'revoke', expectedRevision: 2 }, uuid(), LATER);
  const reinvited = await inviteFinanceBookMember(f.db, owner, 'own', { email: member.email }, uuid(), LATER);
  const replacement = { ...other, email: member.email };
  assert.equal((await listFinanceBooks(f.db, replacement, LATER)).invitations.length, 0);
  await assert.rejects(respondFinanceBookInvitation(f.db, replacement, reinvited.member.id, { action: 'accept', expectedRevision: 4 }, uuid(), LATER), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
  assert.equal(f.sqlite.prepare('SELECT user_id FROM family_book_members WHERE id=?').get(joined.member.id)?.user_id, member.userId);
});

void test('expired invitations never grant access and decline remains an explicit non-access response', async (t) => {
  const f = fixture(t); const invitation = await invite(f);
  assert.equal((await listFinanceBooks(f.db, member, '2026-12-13T03:00:00Z')).invitations.length, 0);
  await assert.rejects(respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'accept', expectedRevision: 1 }, uuid(), '2026-12-13T03:00:00Z'), code('FINANCE_BOOK_INVITATION_EXPIRED', 409));
  assert.equal(f.count('family_book_member_operations'), 1);
  const declined = await respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'decline', expectedRevision: 1 }, uuid(), LATER);
  assert.equal(declined.member.status, 'declined'); assert.equal(declined.member.bound, false);
  await assert.rejects(resolveFinanceBookScope(f.db, member, 'family', invitation.book.id), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
});

void test('idempotency is bound to the actor, book and complete payload, without duplicate state changes', async (t) => {
  const f = fixture(t); const requestId = uuid();
  const first = await inviteFinanceBookMember(f.db, owner, 'own', { email: member.email }, requestId, NOW);
  const replay = await inviteFinanceBookMember(f.db, owner, 'own', { email: member.email.toUpperCase() }, requestId, LATER);
  assert.equal(replay.replayed, true); assert.equal(replay.member.revision, 1); assert.equal(first.member.id, replay.member.id);
  await assert.rejects(inviteFinanceBookMember(f.db, owner, 'own', { email: 'different@example.test' }, requestId, NOW), code('FINANCE_BOOK_OPERATION_CONFLICT', 409));
  await assert.rejects(inviteFinanceBookMember(f.db, other, 'own', { email: member.email }, requestId, NOW), code('FINANCE_BOOK_OPERATION_CONFLICT', 409));
  assert.equal(f.count('family_book_members'), 1); assert.equal(f.count('family_book_member_operations'), 1);
  const acceptedId = uuid();
  await respondFinanceBookInvitation(f.db, member, first.member.id, { action: 'accept', expectedRevision: 1 }, acceptedId, NOW);
  assert.equal((await respondFinanceBookInvitation(f.db, member, first.member.id, { action: 'accept', expectedRevision: 1 }, acceptedId, LATER)).replayed, true);
  await assert.rejects(respondFinanceBookInvitation(f.db, member, first.member.id, { action: 'decline', expectedRevision: 1 }, acceptedId, LATER), code('FINANCE_BOOK_OPERATION_CONFLICT', 409));
  assert.equal(f.count('family_book_member_operations'), 2);
});

void test('a concurrent membership change rejects stale CAS without writing an operation receipt', async (t) => {
  const f = fixture(t); const joined = await join(f); const requestId = uuid();
  f.beforeBatch(() => f.sqlite.prepare("UPDATE family_book_members SET status='revoked',revision=revision+1 WHERE id=?").run(joined.member.id));
  await assert.rejects(changeFinanceBookMember(f.db, owner, 'own', joined.member.id, { action: 'revoke', expectedRevision: 2 }, requestId, LATER), code('FINANCE_BOOK_MEMBER_CHANGED', 409));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM family_book_member_operations WHERE operation_id=?').get(requestId)?.n, 0);
  assert.equal((await listFinanceBookMembers(f.db, owner)).members[0].revision, 3);
});

void test('revoking a pending invitation at the transaction boundary prevents an in-flight acceptance from binding the account', async (t) => {
  const f = fixture(t); const invitation = await invite(f); const operation = uuid();
  f.beforeBatch(() => f.sqlite.prepare("UPDATE family_book_members SET status='revoked',revision=revision+1 WHERE id=?").run(invitation.member.id));
  await assert.rejects(respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'accept', expectedRevision: 1 }, operation, NOW), code('FINANCE_BOOK_MEMBER_CHANGED', 409));
  const stored = f.sqlite.prepare('SELECT status,user_id,revision FROM family_book_members WHERE id=?').get(invitation.member.id);
  assert.equal(stored?.status, 'revoked'); assert.equal(stored?.user_id, null); assert.equal(stored?.revision, 2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM family_book_member_operations WHERE operation_id=?').get(operation)?.n, 0);
  await assert.rejects(resolveFinanceBookScope(f.db, member, 'family', invitation.book.id), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
});

void test('receipt failures roll back new invitations and accepting an invitation without changing its stable identity', async (t) => {
  const f = fixture(t); const id = uuid();
  f.sqlite.exec("CREATE TRIGGER reject_family_receipt BEFORE INSERT ON family_book_member_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  await assert.rejects(inviteFinanceBookMember(f.db, owner, 'own', { email: member.email }, id, NOW));
  assert.equal(f.count('family_book_members'), 0); assert.equal(f.count('family_book_member_operations'), 0);
  f.sqlite.exec('DROP TRIGGER reject_family_receipt');
  const invitation = await inviteFinanceBookMember(f.db, owner, 'own', { email: member.email }, id, NOW);
  f.sqlite.exec("CREATE TRIGGER reject_family_receipt BEFORE INSERT ON family_book_member_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  await assert.rejects(respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'accept', expectedRevision: 1 }, uuid(), NOW));
  const stored = f.sqlite.prepare('SELECT status,user_id,revision FROM family_book_members WHERE id=?').get(invitation.member.id);
  assert.equal(stored?.status, 'pending'); assert.equal(stored?.user_id, null); assert.equal(stored?.revision, 1);
});

void test('self invites, forged fields and malformed IDs fail before member state or authorization can change', async (t) => {
  const f = fixture(t);
  await assert.rejects(inviteFinanceBookMember(f.db, owner, 'own', { email: owner.email.toUpperCase() }, uuid(), NOW), code('FINANCE_BOOK_INVALID', 400));
  await assert.rejects(inviteFinanceBookMember(f.db, owner, 'own', { email: member.email, userId: member.userId } as { email: string }, uuid(), NOW), code('FINANCE_BOOK_INVALID', 400));
  await assert.rejects(resolveFinanceBookScope(f.db, member, 'family', 'not-a-book'), code('FINANCE_BOOK_INVALID', 400));
  assert.equal(f.count('family_books'), 0); assert.equal(f.count('family_book_members'), 0);
  const invitation = await invite(f);
  await assert.rejects(respondFinanceBookInvitation(f.db, owner, invitation.member.id, { action: 'accept', expectedRevision: 1 }, uuid(), NOW), code('FINANCE_BOOK_ACCESS_REVOKED', 403));
  await assert.rejects(respondFinanceBookInvitation(f.db, member, invitation.member.id, { action: 'accept', expectedRevision: 0 }, uuid(), NOW), code('FINANCE_BOOK_INVALID', 400));
});

void test('household authorization and command attribution are excluded from portable business backups', async (t) => {
  const f = fixture(t); await join(f);
  const { BACKUP_TABLE_NAMES } = await import('../lib/data-backup.ts');
  assert.ok(!BACKUP_TABLE_NAMES.some((name: string) => name.startsWith('family_')));
  assert.equal(f.count('family_finance_commands'), 0);
});
