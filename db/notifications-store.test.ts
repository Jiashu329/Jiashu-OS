import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationsError } from '../lib/notifications.ts';
import type { FinanceBookActor } from '../lib/finance-books.ts';
import { changeFinanceBookMember, ensureOwnFamilyBook, inviteFinanceBookMember, respondFinanceBookInvitation } from './finance-books-store.ts';
import { markNotificationsRead, readNotifications, readNotificationSettings, writeNotificationSettings, type NotificationsDatabase } from './notifications-store.ts';

const NOW = '2026-11-14T03:00:00.000Z', LATER = '2026-11-14T04:00:00.000Z';
const alice: FinanceBookActor = { userId: 'alice', email: 'alice@example.test', displayName: 'Alice' };
const bob: FinanceBookActor = { userId: 'bob', email: 'bob@example.test', displayName: 'Bob' };
const carol: FinanceBookActor = { userId: 'carol', email: 'carol@example.test', displayName: 'Carol' };
const id = () => crypto.randomUUID();
const code = (expected: string) => (error: unknown) => error instanceof NotificationsError && error.code === expected;
function fixture(t: TestContext) {
  const sql = new DatabaseSync(':memory:'); sql.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sql.close());
  interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }>; execute(): { results: unknown[]; meta: { changes: number } } }
  const db = {
    prepare(query: string) {
      const prepared = sql.prepare(query); let values: SQLInputValue[] = [];
      const statement: Statement = {
        bind(...input) { values = input as SQLInputValue[]; return statement; },
        async first<T>() { return statement.execute().results[0] as T ?? null; },
        async all<T>() { return { results: statement.execute().results as T[] }; },
        async run() { return statement.execute(); },
        execute() {
          if (prepared.columns().length) return { results: prepared.all(...values), meta: { changes: 0 } };
          const result = prepared.run(...values); return { results: [], meta: { changes: Number(result.changes) } };
        },
      }; return statement;
    },
    async batch(statements: Statement[]) { sql.exec('BEGIN'); try { const result = statements.map((statement) => statement.execute()); sql.exec('COMMIT'); return result; } catch (error) { sql.exec('ROLLBACK'); throw error; } },
  } as unknown as NotificationsDatabase;
  for (const actor of [alice, bob, carol]) sql.prepare('INSERT INTO app_access_grants(id,email,bound_user_id,status,revision,created_at,updated_at) VALUES (?,?,?,\'active\',1,?,?)').run(id(), actor.email, actor.userId, NOW, NOW);
  return { sql, db,
    account(actor = alice, ledger = 'personal') { const accountId = id(); sql.prepare('INSERT INTO finance_accounts(id,user_id,ledger,name,type,currency,note,created_at,updated_at) VALUES (?,?,?,?,\'bank\',\'CNY\',\'\',?,?)').run(accountId, actor.userId, ledger, actor.displayName + ' account', NOW, NOW); return accountId; },
    failed(actor = alice, time = NOW) { const attempt = id(); sql.prepare('INSERT INTO health_sync_attempts(user_id,attempt_id,created_at,channel,device_label,status,batch_id,error_code,summary_json) VALUES (?,?,?,\'device\',NULL,\'failed\',NULL,\'SYNC_STORAGE_UNAVAILABLE\',\'{}\')').run(actor.userId, attempt, time); return attempt; },
    count(table: 'notification_read_states' | 'notification_preferences') { return Number(sql.prepare('SELECT COUNT(*) AS n FROM ' + table).get()?.n); },
  };
}

test('live notification reads are private, deduplicated and never mark read or create preference rows', async (t) => {
  const f = fixture(t); const invite = await inviteFinanceBookMember(f.db, bob, 'own', { email: alice.email }, id(), NOW);
  const attempt = f.failed(), foreignAttempt = f.failed(carol); f.account(); f.account(alice, 'family'); f.account(carol);
  const feed = await readNotifications(f.db, alice, {}, NOW);
  assert.equal(feed.unavailable.length, 0);
  assert.equal(feed.items.length, 4); assert.equal(feed.unreadCount, 4);
  assert.ok(feed.items.some((item) => item.id === `invite:${invite.member.id}:1`));
  assert.ok(feed.items.some((item) => item.id === 'sync:' + attempt));
  assert.equal(feed.items.filter((item) => item.category === 'balances').length, 2);
  assert.equal(new Set(feed.items.map((item) => item.id)).size, 4);
  assert.deepEqual(feed.unreadIds, feed.items.map((item) => item.id));
  assert.equal(feed.unreadIds.includes('sync:' + foreignAttempt), false);
  assert.ok(!JSON.stringify(feed).includes('Carol'));
  assert.equal(f.count('notification_read_states'), 0); assert.equal(f.count('notification_preferences'), 0);
  assert.deepEqual(await readNotificationSettings(f.db, alice.userId), { categories: DEFAULT_NOTIFICATION_PREFERENCES, revision: 0, updatedAt: null });
});

test('read receipts follow the current user across reloads and retries without accepting another user message ID', async (t) => {
  const f = fixture(t), attempt = f.failed(), key = 'sync:' + attempt;
  await markNotificationsRead(f.db, alice, [key], NOW);
  const first = await readNotifications(f.db, alice, {}, LATER);
  assert.equal(first.items[0].readAt, NOW); assert.equal(first.unreadCount, 0);
  assert.deepEqual(first.unreadIds, []);
  assert.equal((await readNotifications(f.db, alice, { unread: true }, LATER)).total, 0);
  await markNotificationsRead(f.db, alice, [key], LATER);
  assert.equal((await readNotifications(f.db, alice, {}, LATER)).items[0].readAt, NOW);
  await assert.rejects(markNotificationsRead(f.db, bob, [key], LATER), code('NOTIFICATION_NOT_FOUND'));
  assert.equal(f.count('notification_read_states'), 1);
  f.account(); await markNotificationsRead(f.db, alice, 'all', LATER);
  assert.equal((await readNotifications(f.db, alice, {}, LATER)).unreadCount, 0);
  assert.equal(f.count('notification_read_states'), 2);
});

test('preferences use CAS, preserve independent user settings and suppress disabled categories without source reads', async (t) => {
  const f = fixture(t); f.failed(); f.account();
  const off = { invitations: false, collaboration: false, sync: false, balances: false };
  const saved = await writeNotificationSettings(f.db, alice.userId, off, 0, NOW);
  assert.equal(saved.settings.revision, 1); assert.equal(saved.replayed, false);
  assert.equal((await writeNotificationSettings(f.db, alice.userId, off, 0, LATER)).replayed, true);
  await assert.rejects(writeNotificationSettings(f.db, alice.userId, { ...off, sync: true }, 0, LATER), code('NOTIFICATIONS_SETTINGS_CHANGED'));
  assert.equal((await readNotificationSettings(f.db, bob.userId)).revision, 0);
  f.sql.exec('DROP TABLE health_sync_attempts');
  const disabled = await readNotifications(f.db, alice, {}, NOW);
  assert.equal(disabled.total, 0); assert.equal(disabled.unreadCount, 0); assert.deepEqual(disabled.unavailable, []);
  await writeNotificationSettings(f.db, alice.userId, { ...off, sync: true, balances: true }, 1, NOW);
  const partial = await readNotifications(f.db, alice, {}, NOW);
  assert.deepEqual(partial.unavailable, ['sync']); assert.equal(partial.items.length, 1); assert.equal(partial.items[0].category, 'balances');
});

test('concurrent preference updates cannot overwrite each other through a stale revision', async (t) => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    writeNotificationSettings(f.db, alice.userId, { ...DEFAULT_NOTIFICATION_PREFERENCES, sync: false }, 0, NOW),
    writeNotificationSettings(f.db, alice.userId, { ...DEFAULT_NOTIFICATION_PREFERENCES, balances: false }, 0, NOW),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await readNotificationSettings(f.db, alice.userId)).revision, 1);
});

test('collaboration notifications include the actual actor and disappear immediately after membership revocation', async (t) => {
  const f = fixture(t), invitation = await inviteFinanceBookMember(f.db, bob, 'own', { email: alice.email, role: 'viewer' }, id(), NOW);
  const joined = await respondFinanceBookInvitation(f.db, alice, invitation.member.id, { action: 'accept', expectedRevision: invitation.member.revision }, id(), NOW);
  const book = await ensureOwnFamilyBook(f.db, bob, NOW), account = f.account(bob, 'family');
  f.sql.prepare(`INSERT INTO family_finance_commands(book_id,operation_id,actor_user_id,actor_name,actor_email,membership_id,access_revision,request_hash,action,target_id,created_at) VALUES (?,?,?,?,?,NULL,0,?,?,?,?)`)
    .run(book.id, id(), bob.userId, 'Bob', bob.email, 'a'.repeat(64), 'account.update', account, LATER);
  const before = await readNotifications(f.db, alice, {}, LATER);
  const activity = before.items.find((item) => item.category === 'collaboration' && item.summary.includes('account'));
  assert.ok(activity); assert.match(activity.summary, /Bob.*更新了账户资料/); assert.equal(before.unavailable.length, 0);
  assert.ok(before.unreadIds.includes(activity.id));
  await markNotificationsRead(f.db, alice, [activity.id], LATER);
  await changeFinanceBookMember(f.db, bob, 'own', joined.member.id, { action: 'revoke', expectedRevision: joined.member.revision }, id(), LATER);
  const after = await readNotifications(f.db, alice, {}, LATER);
  assert.equal(after.items.some((item) => item.category === 'collaboration'), false);
  assert.equal(after.unreadIds.some((key) => key.startsWith('activity:')), false);
  await assert.rejects(markNotificationsRead(f.db, alice, [activity.id], LATER), code('NOTIFICATION_NOT_FOUND'));
  assert.equal(f.count('notification_read_states'), 1);
});

test('unread IDs are an authorized enabled-category snapshot independent of pagination and unread filtering', async (t) => {
  const f = fixture(t), attempt = f.failed(); f.account();
  await inviteFinanceBookMember(f.db, bob, 'own', { email: alice.email }, id(), NOW);
  const page = await readNotifications(f.db, alice, { offset: 1, limit: 1 }, NOW);
  assert.equal(page.items.length, 1); assert.equal(page.unreadIds.length, 3); assert.equal(page.unreadCount, 3);
  const original = [...page.unreadIds];
  await markNotificationsRead(f.db, alice, [original[0]], NOW);
  const next = await readNotifications(f.db, alice, { unread: true, offset: 1, limit: 1 }, NOW);
  assert.equal(next.items.length, 1); assert.equal(next.unreadIds.length, 2);
  assert.deepEqual(next.unreadIds, original.filter((key) => key !== original[0]));
  await writeNotificationSettings(f.db, alice.userId, { ...DEFAULT_NOTIFICATION_PREFERENCES, sync: false }, 0, NOW);
  const disabled = await readNotifications(f.db, alice, { limit: 1 }, NOW);
  assert.equal(disabled.unreadIds.includes('sync:' + attempt), false);
});

test('resolved sync failures and current effective balance corrections stop their respective reminders', async (t) => {
  const f = fixture(t), account = f.account(), attempt = f.failed();
  const entry = id();
  f.sql.prepare('INSERT INTO finance_balance_entries(id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES (?,?,?,\'100\',\'2026-10-01\',\'\',?)').run(entry, alice.userId, account, NOW);
  assert.equal((await readNotifications(f.db, alice, {}, NOW)).total, 2);
  f.sql.prepare('INSERT INTO finance_balance_changes(id,user_id,account_id,entry_id,revision,action,amount_minor,as_of_date,note,reason,request_hash,created_at) VALUES (?,?,?,?,1,\'correct\',\'100\',\'2026-11-14\',\'\',\'correction\',?,?)').run(id(), alice.userId, account, entry, 'a'.repeat(64), NOW);
  const corrected = await readNotifications(f.db, alice, {}, NOW);
  assert.equal(corrected.total, 1); assert.equal(corrected.items[0].id, 'sync:' + attempt);
  f.sql.prepare('INSERT INTO health_sync_attempts(user_id,attempt_id,created_at,channel,device_label,status,batch_id,error_code,summary_json) VALUES (?,?,?,\'device\',NULL,\'success\',NULL,NULL,\'{}\')').run(alice.userId, id(), LATER);
  assert.equal((await readNotifications(f.db, alice, {}, LATER)).total, 0);
  f.sql.prepare('INSERT INTO finance_balance_changes(id,user_id,account_id,entry_id,revision,action,amount_minor,as_of_date,note,reason,request_hash,created_at) VALUES (?,?,?,?,2,\'void\',NULL,NULL,NULL,\'void\',?,?)').run(id(), alice.userId, account, entry, 'b'.repeat(64), LATER);
  assert.equal((await readNotifications(f.db, alice, {}, LATER)).items[0].category, 'balances');
});
