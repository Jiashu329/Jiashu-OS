import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInThisContext } from 'node:vm';
import test from 'node:test';
import { advancedFinanceBookFixture, SHARED_FINANCE_BOOK } from '../../../../tests/fixtures/advanced-finance-book.ts';
import { FinanceBookError } from '../../../../lib/finance-books.ts';

function fixture() {
  const db = {} as D1Database;
  let userId: string | null = 'alice';
  const book = advancedFinanceBookFixture(db, () => undefined);
  const calls: Array<{ owner: string; ledger: string; db: D1Database }> = [];
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers });
  const bindings = {
    ...book, json, apiUser: async () => userId ? { userId } : null,
    financeUnauthenticated: () => json({ code: 'SIGN_IN_REQUIRED' }, 401),
    financeError: (error: unknown) => error instanceof FinanceBookError ? json({ code: error.code }, error.status) : json({ code: 'FINANCE_UNAVAILABLE' }, 503),
    ledgerFromRequest: (request: Request) => {
      const ledger = new URL(request.url).searchParams.get('ledger') ?? 'personal';
      return ['personal', 'family'].includes(ledger) ? ledger : null;
    },
    financeExport: async (owner: string, ledger: string, selectedDb: D1Database) => {
      calls.push({ owner, ledger, db: selectedDb });
      return { version: 1, kind: 'jiashu-finance-backup', ledger, accounts: [], balances: [] };
    },
  };
  const handler = runInThisContext('(function(' + Object.keys(bindings).join(',') + '){' + source + '\nreturn GET;})')(...Object.values(bindings)) as (request: Request) => Promise<Response>;
  return {
    calls, db, book, signIn(value: string | null) { userId = value; },
    get(query: string) { return handler(new Request('https://synthetic-export.example/api/finance/export?' + query)); },
  };
}

void test('finance export passes exactly the owner, selected ledger and scoped database without using complete business backup', async () => {
  const f = fixture();
  const response = await f.get('ledger=family&book=' + SHARED_FINANCE_BOOK);
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, [{ owner: 'alice', ledger: 'family', db: f.db }]);
  const result = await response.json() as { kind: string; ledger: string; tables?: unknown };
  assert.equal(result.kind, 'jiashu-finance-backup'); assert.equal(result.ledger, 'family'); assert.equal(result.tables, undefined);
  assert.match(response.headers.get('Content-Disposition') ?? '', /jiashu-finance-family\.json/);
});

void test('family editors cannot export and cannot select the owner personal ledger; revoked or anonymous requests never reach export', async () => {
  const f = fixture(); f.signIn('bob');
  assert.equal((await f.get('ledger=family&book=' + SHARED_FINANCE_BOOK)).status, 403);
  assert.equal((await f.get('ledger=personal&book=' + SHARED_FINANCE_BOOK)).status, 400);
  assert.equal(f.calls.length, 0);
  f.signIn('alice'); f.book.revoke();
  assert.equal((await f.get('ledger=family&book=' + SHARED_FINANCE_BOOK)).status, 403);
  f.signIn(null); assert.equal((await f.get('ledger=personal')).status, 401);
  assert.equal(f.calls.length, 0);
});
