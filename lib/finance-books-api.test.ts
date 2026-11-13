import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createFinanceBookHandlers } from './finance-books-api.ts';
import type { FinanceBookActor } from './finance-books.ts';
import type { FinanceBooksDatabase } from '../db/finance-books-store.ts';

const OP = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://synthetic-family.example';
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  let user: FinanceBookActor | null = { userId: 'alice', email: 'alice@example.invalid', displayName: 'Alice', isOwner: false };
  let calls = 0, broken = false;
  interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown>; execute(): { results: unknown[]; meta: { changes: number } } }
  const db = { prepare(sql: string) {
    calls++; if (broken) throw new Error('SECRET_DATABASE_INTERNAL');
    const query = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const statement: Statement = { bind(...input) { values = input as SQLInputValue[]; return statement; },
      async first<T>() { return statement.execute().results[0] as T ?? null; },
      async all<T>() { return { results: statement.execute().results as T[] }; }, async run() { return statement.execute(); },
      execute() { const results = query.columns().length ? query.all(...values) : (query.run(...values), []); return { results, meta: { changes: Number(sqlite.prepare('SELECT changes() n').get()!.n) } }; } };
    return statement;
  }, async batch(statements: Statement[]) {
    sqlite.exec('BEGIN IMMEDIATE'); try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as FinanceBooksDatabase;
  const handlers = createFinanceBookHandlers({ async user() { return user; }, database() { return db; }, json(value, status = 200) { return Response.json(value, { status }); } });
  const request = (input?: unknown, patch: Record<string, string> = {}, operationId = crypto.randomUUID()) => new Request(ORIGIN + '/api/finance/books', {
    method: input === undefined ? 'GET' : 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Page-Owner': user?.userId ?? '', 'Idempotency-Key': operationId, ...patch },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return { handlers, sqlite, request, calls: () => calls, identity(value: FinanceBookActor | null) { user = value; }, breakStorage() { broken = true; } };
}

void test('book API authenticates the real actor and enforces origin, page identity, request limits and exact inputs before writes', async (t) => {
  const f = fixture(t); f.identity(null);
  assert.equal((await f.handlers.GET(f.request())).status, 401);
  assert.equal((await f.handlers.INVITE(f.request({ email: 'bob@example.invalid' }), 'own')).status, 401); assert.equal(f.calls(), 0);
  f.identity({ userId: 'alice', email: 'alice@example.invalid', isOwner: false });
  assert.equal((await f.handlers.GET(f.request(undefined, { 'X-Page-Owner': 'bob' }))).status, 401);
  for (const [headers, status] of [[{ Origin: 'https://foreign.invalid' }, 403], [{ 'Content-Type': 'text/plain' }, 415], [{ 'Idempotency-Key': '' }, 400]] as const) {
    assert.equal((await f.handlers.INVITE(f.request({ email: 'bob@example.invalid' }, headers), 'own')).status, status);
  }
  for (const extra of ['ownerUserId', 'actorUserId', 'role', 'isOwner']) assert.equal((await f.handlers.INVITE(f.request({ email: 'bob@example.invalid', [extra]: 'forged' }), 'own')).status, 400);
  assert.equal((await f.handlers.INVITE(f.request({ email: 'x'.repeat(10000) }), 'own')).status, 413);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM family_books').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_access_grants').get()!.n, 0);
});

void test('any book owner can invite without site-administrator status and only the targeted recipient can explicitly join', async (t) => {
  const f = fixture(t);
  const listed = await f.handlers.GET(f.request()); assert.equal(listed.status, 200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM family_books').get()!.n, 0, 'Viewing invitations does not enable sharing or accept anything');
  const response = await f.handlers.INVITE(f.request({ email: 'bob@example.invalid' }, {}, OP), 'own'); assert.equal(response.status, 200);
  const invited = await response.json() as { member: { id: string; bookId: string; revision: number } };
  assert.equal((await f.handlers.INVITE(f.request({ email: 'bob@example.invalid' }, {}, OP), 'own')).status, 200);
  f.identity({ userId: 'carol', email: 'carol@example.invalid' });
  assert.equal((await f.handlers.RESPOND(f.request({ action: 'accept', expectedRevision: 1 }), invited.member.id)).status, 403);
  f.identity({ userId: 'bob', email: 'bob@example.invalid' });
  const before = await (await f.handlers.GET(f.request())).json() as { books: unknown[]; invitations: unknown[] };
  assert.equal(before.books.length, 1); assert.equal(before.invitations.length, 1);
  assert.equal((await f.handlers.RESPOND(f.request({ action: 'accept', expectedRevision: 1, userId: 'alice' }), invited.member.id)).status, 400);
  assert.equal((await f.handlers.RESPOND(f.request({ action: 'accept', expectedRevision: 1 }), invited.member.id)).status, 200);
  const joined = await (await f.handlers.GET(f.request())).json() as { books: Array<{ id: string; role: string }>; invitations: unknown[] };
  assert.ok(joined.books.some((book) => book.id === invited.member.bookId && book.role === 'editor')); assert.equal(joined.invitations.length, 0);
  assert.equal((await f.handlers.MEMBERS(f.request(), invited.member.bookId)).status, 403);
  assert.equal((await f.handlers.INVITE(f.request({ email: 'carol@example.invalid' }), invited.member.bookId)).status, 403);
  assert.equal((await f.handlers.REVOKE(f.request({ action: 'revoke', expectedRevision: 2 }), invited.member.bookId, invited.member.id)).status, 403);
  f.identity({ userId: 'alice', email: 'alice@example.invalid' });
  const members = await f.handlers.MEMBERS(f.request(), 'own'); assert.equal(members.status, 200);
  assert.doesNotMatch(await members.text(), /userId|ownerUserId|actorUserId/);
  assert.equal((await f.handlers.REVOKE(f.request({ action: 'revoke', expectedRevision: 2 }), 'own', invited.member.id)).status, 200);
  f.identity({ userId: 'bob', email: 'bob@example.invalid' });
  const ended = await (await f.handlers.GET(f.request())).json() as { books: unknown[] }; assert.equal(ended.books.length, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_access_grants').get()!.n, 0, 'Family invitations do not change site admission');
});

void test('family management does not disclose database failures', async (t) => {
  const f = fixture(t); f.breakStorage();
  const result = await f.handlers.GET(f.request()); assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /SECRET_DATABASE_INTERNAL|SELECT|family_books/);
});
