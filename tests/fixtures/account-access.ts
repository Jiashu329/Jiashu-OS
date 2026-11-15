import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { identityFromHeaders, pageAccountFailure } from '../../lib/account-identity.ts';
import type { SiteIdentity } from '../../lib/account-identity.ts';
import { resolveAccess } from '../../db/access-grants-store.ts';
import { resolveOwnerIdentity } from '../../db/owner-identity-store.ts';
import { getLocalUserById } from '../../db/local-users-store.ts';
import { normalizeLocalEmail } from '../../lib/local-users.ts';
import { safeAccountRetryPath } from '../../lib/account-retry.ts';

export interface AccessResult { identity: SiteIdentity | null; allowed: boolean; isOwner: boolean; reason?: string }
export class RedirectSignal extends Error { readonly destination: string; constructor(destination: string) { super(destination); this.destination = destination; } }
function load<T>(url: URL, bindings: Record<string, unknown>, names: string[]): T {
  const source = stripTypeScriptTypes(readFileSync(url, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn {' + names.join(',') + '};', Object.keys(bindings))(...Object.values(bindings)) as T;
}
export function authorizationFixture(t: TestContext, config: { userId?: string; email?: string } = { email: 'owner@example.test' }) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const migrations = new URL('../../drizzle/', import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }>; execute(): { results: unknown[]; meta: { changes: number } } }
  const db = { prepare(sql: string) {
    const query = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const statement: Statement = {
      bind(...parameters) { values = parameters as SQLInputValue[]; return statement; },
      async first<T>() { return (statement.execute().results[0] as T | undefined) ?? null; },
      async all<T>() { return { results: statement.execute().results as T[] }; },
      async run() { return statement.execute(); },
      execute() {
        const results = query.columns().length ? query.all(...values) : (query.run(...values), []);
        const changes = /^\s*(SELECT|WITH)\b/i.test(sql) ? 0 : Number(sqlite.prepare('SELECT changes() n').get()!.n);
        return { results, meta: { changes } };
      },
    }; return statement;
  }, async batch(statements: Statement[]) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  const env: { DB?: D1Database; APP_OWNER_USER_ID?: string; APP_OWNER_EMAIL?: string; SELFHOST_AUTH_PROVIDER?: 'local' } = { DB: db, APP_OWNER_USER_ID: config.userId, APP_OWNER_EMAIL: config.email };
  const diagnostics: string[] = [];
  const { accountAccess } = load<{ accountAccess: (headers: Pick<Headers, 'get'>) => Promise<AccessResult> }>(new URL('../../app/account-access.ts', import.meta.url),
    { env, identityFromHeaders, resolveAccess, resolveOwnerIdentity, getLocalUserById, normalizeLocalEmail, console: { error(value: string) { diagnostics.push(value); } } }, ['accountAccess']);
  let currentHeaders = new Headers();
  const auth = load<{
    getChatGPTAccess(): Promise<AccessResult>;
    getChatGPTUser(returnToOnUnavailable?: string): Promise<(SiteIdentity & { isOwner: boolean }) | null>;
    getChatGPTIdentity(): Promise<SiteIdentity | null>;
    requireChatGPTUser(returnTo: string): Promise<SiteIdentity & { isOwner: boolean }>;
    chatGPTSignInPath(returnTo: string): string; chatGPTSignOutPath(returnTo?: string): string;
  }>(new URL('../../app/chatgpt-auth.ts', import.meta.url), {
    headers: async () => currentHeaders, accountAccess, identityFromHeaders, safeAccountRetryPath,
    redirect(destination: string): never { throw new RedirectSignal(destination); },
  }, ['getChatGPTAccess', 'getChatGPTUser', 'getChatGPTIdentity', 'requireChatGPTUser', 'chatGPTSignInPath', 'chatGPTSignOutPath']);
  const api = load<{
    apiUser(): ReturnType<typeof auth.getChatGPTUser>;
    unauthenticated(message?: string): Promise<Response>;
    json(value: unknown, status?: number, headers?: Record<string, string>): Response;
  }>(new URL('../../app/api/_shared.ts', import.meta.url), { getChatGPTUser: () => auth.getChatGPTUser(), getChatGPTAccess: () => auth.getChatGPTAccess() }, ['apiUser', 'unauthenticated', 'json']);
  const { middleware } = load<{ middleware: (request: Request) => Promise<Response> }>(new URL('../../middleware.ts', import.meta.url), {
    accountAccess, pageAccountFailure, NextResponse: {
      json: (value: unknown, options: ResponseInit) => Response.json(value, options),
      next: () => new Response(null, { headers: { 'x-middleware-next': '1' } }),
    },
  }, ['middleware']);
  function identity(userId: string, email: string) { return new Headers({ 'oai-authenticated-user-id': userId, 'oai-authenticated-user-email': email }); }
  return { sqlite, db, env, auth, api, middleware, accountAccess, diagnostics, identity,
    signIn(userId: string | null, email = '') { currentHeaders = userId ? identity(userId, email) : new Headers(); },
    headers() { return new Headers(currentHeaders); },
  };
}
