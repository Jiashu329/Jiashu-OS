import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { SQLiteD1Database } from './database.ts';
import { bootstrapLocalOwner, getLocalUserByEmail, getLocalUserById, touchLocalUserLogin, updateLocalUser } from '../db/local-users-store.ts';
import { createSelfhostUserManagement } from './user-management.ts';
import type { SelfhostGatewayOptions } from './auth.ts';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSelfhostGateway, hashPassword, issueSelfhostSession, loadSelfhostAuthConfig, readCookie, safeSelfhostReturnTo,
  sanitizedSelfhostHeaders, selfhostCookieNames, SelfhostLoginLimiter, verifyPassword, verifySelfhostSession } from './auth.ts';

const PASSWORD = 'synthetic-long-password-2026';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const NOW = Date.parse('2026-11-15T12:00:00Z');
const base = { SELFHOST_PUBLIC_ORIGIN: 'https://www.treefund.example', SELFHOST_USERNAME: 'admin', SELFHOST_PASSWORD_HASH: PASSWORD_HASH,
  SELFHOST_SESSION_SECRET: Buffer.alloc(32, 11).toString('base64url'), APP_OWNER_USER_ID: 'synthetic-test-owner', APP_OWNER_EMAIL: 'admin@example.test' };
const config = loadSelfhostAuthConfig(base);
const owner = { id: config.ownerId, revision: 1 };
const databases = new Set<SQLiteD1Database>();
afterEach(() => { for (const db of databases) db.close(); databases.clear(); });
class FakeResponse {
  headersSent = false; statusCode = 0; headers: Record<string, string | string[]> = {}; body = '';
  writeHead(status: number, headers: Record<string, string | string[]>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  end(value = '') { this.body += String(value); return this; }
}
function request(path: string, method = 'GET', headers: Record<string, string> = {}, body?: URLSearchParams | string) {
  const encoded = body?.toString(), req = Readable.from(encoded === undefined ? [] : [Buffer.from(encoded)]);
  return Object.assign(req, { method, url: path, headers: { host: config.host, ...(encoded === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }), ...headers },
    rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
}
function fixture(options: { readiness?: () => { schemaReady: boolean; applied: number; total: number; pending: number }; limiter?: SelfhostLoginLimiter; users?: SelfhostGatewayOptions['users'] } = {}) {
  let time = NOW; const downstream: IncomingMessage[] = [];
  const db = new SQLiteD1Database(':memory:'); databases.add(db);
  db.transaction(() => db.executeMigrationSQL(readFileSync(new URL('../drizzle/0034_local_users.sql', import.meta.url), 'utf8')));
  const ready = bootstrapLocalOwner(db, { id: config.ownerId, email: config.ownerEmail, passwordHash: PASSWORD_HASH }, new Date(NOW).toISOString());
  const users = options.users ?? {
    async getById(id: string) { await ready; return getLocalUserById(db, id); },
    async getByEmail(email: string) { await ready; return getLocalUserByEmail(db, email); },
    async touchLogin(id: string, at: number) { await touchLocalUserLogin(db, id, new Date(at).toISOString()); },
  };
  const gateway = createSelfhostGateway(config, (req, res) => { downstream.push(req); res.writeHead(200); res.end('application'); }, {
    now: () => time, commitSha: 'a'.repeat(40), readiness: options.readiness ?? (() => ({ schemaReady: true, applied: 34, total: 34, pending: 0 })), limiter: options.limiter, users, manageUsers: createSelfhostUserManagement(config, db, { now: () => time }),
  });
  return { downstream, db, ready, time(value: number) { time = value; }, async call(path: string, method = 'GET', headers: Record<string, string> = {}, body?: URLSearchParams | string) {
    const req = request(path, method, headers, body), res = new FakeResponse(); await gateway(req, res as unknown as ServerResponse); return { req, res };
  } };
}
function setCookies(response: FakeResponse): string[] { const value = response.headers['Set-Cookie']; return Array.isArray(value) ? value : value ? [value] : []; }
function csrfForm(response: FakeResponse) {
  const csrf = response.body.match(/name="csrf" value="([^"]+)"/)?.[1]; assert.ok(csrf);
  const value = setCookies(response)[0]?.split(';')[0]; assert.ok(value); return { csrf, cookie: value };
}
async function login(f: ReturnType<typeof fixture>, password = PASSWORD, email = config.ownerEmail, returnTo = '/health?days=30') {
  const page = await f.call('/signin-with-chatgpt?return_to=' + encodeURIComponent(returnTo));
  const csrf = csrfForm(page.res);
  return f.call('/signin-with-chatgpt', 'POST', { origin: config.origin, cookie: csrf.cookie }, new URLSearchParams({ email, password, csrf: csrf.csrf, return_to: returnTo }));
}

void test('password hashes use bounded scrypt parameters and never accept malformed or wrong credentials', async () => {
  assert.match(PASSWORD_HASH, /^scrypt-v1\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword(PASSWORD, PASSWORD_HASH), true);
  assert.equal(await verifyPassword('wrong-password', PASSWORD_HASH), false);
  assert.equal(await verifyPassword(PASSWORD, PASSWORD_HASH.replace('$32768$', '$1073741824$')), false);
  assert.equal(await verifyPassword('x'.repeat(1025), PASSWORD_HASH), false);
  assert.notEqual(PASSWORD_HASH, await hashPassword(PASSWORD));
  await assert.rejects(hashPassword('short'));
});

void test('production configuration requires HTTPS and full credentials; HTTP only exists for explicit loopback CI', () => {
  assert.equal(config.origin, base.SELFHOST_PUBLIC_ORIGIN);
  for (const changed of [{ SELFHOST_SESSION_SECRET: 'short' }, { SELFHOST_PASSWORD_HASH: 'plain-password' }, { APP_OWNER_USER_ID: '' }, { APP_OWNER_EMAIL: '' },
    { SELFHOST_PUBLIC_ORIGIN: 'https://u:p@treefund.example/' }, { SELFHOST_PUBLIC_ORIGIN: 'https://treefund.example/path' }, { SELFHOST_SESSION_TTL_SECONDS: '86401' },
    { SELFHOST_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }, { SELFHOST_PUBLIC_ORIGIN: 'http://treefund.example', CI: 'true', SELFHOST_ALLOW_HTTP: '1' }]) {
    assert.throws(() => loadSelfhostAuthConfig({ ...base, ...changed }), /configuration/);
  }
  const dev = loadSelfhostAuthConfig({ ...base, SELFHOST_PUBLIC_ORIGIN: 'http://127.0.0.1:3000', CI: 'true', SELFHOST_ALLOW_HTTP: '1' });
  assert.equal(dev.secure, false); assert.equal(selfhostCookieNames(dev).session, 'jso-test-session');
});

void test('v2 sessions expire, reject tampering, rotate with origin/secret and do not depend on bootstrap credentials', () => {
  const value = issueSelfhostSession(config, owner, NOW); assert.deepEqual(verifySelfhostSession(config, value, NOW), { sub: owner.id, revision: 1 });
  assert.equal(verifySelfhostSession(config, value, NOW + config.sessionTtl * 1000), null);
  assert.equal(verifySelfhostSession(config, value + 'x', NOW), null);
  assert.equal(verifySelfhostSession(config, value, NOW - 31000), null);
  for (const changed of [{ sessionSecret: Buffer.alloc(32, 12).toString('base64url') }, { origin: 'https://elsewhere.example' }]) {
    assert.equal(verifySelfhostSession({ ...config, ...changed }, value, NOW), null);
  }
  assert.deepEqual(verifySelfhostSession({ ...config, passwordHash: PASSWORD_HASH + 'x', ownerEmail: 'changed@example.test' }, value, NOW), { sub: owner.id, revision: 1 });
  const name = selfhostCookieNames(config).session;
  assert.equal(readCookie(`${name}=${value}; ${name}=forged`, name), null);
});

void test('return paths cannot escape the site, reach internal APIs or create authentication loops', () => {
  for (const value of [null, '//evil.example/', 'https://evil.example', '/\\evil.example', '/health/%5c%5cevil.example', '/api/session', '/callback', '/signin-with-chatgpt', '/signout-with-chatgpt', '/service-unavailable', '/_selfhost/healthz', '/health\n/records']) assert.equal(safeSelfhostReturnTo(value), '/');
  assert.equal(safeSelfhostReturnTo('/health?days=30#goals'), '/health?days=30#goals');
});

void test('the gateway strips forged identity/proxy/middleware headers before any application handler, including raw headers', async () => {
  const f = fixture(), { req, res } = await f.call('/api/session', 'GET', { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'attacker@example.test',
    'x-auth-request-user': 'attacker', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', 'x-real-ip': 'evil', 'x-middleware-subrequest': 'middleware:middleware', 'x-vinext-prerender-secret': 'forged', 'x-page-owner': 'kept-for-app-validation' });
  assert.equal(res.statusCode, 200); assert.equal(f.downstream.length, 1);
  assert.equal(req.headers['oai-authenticated-user-id'], undefined); assert.equal(req.headers['x-auth-request-user'], undefined);
  assert.equal(req.headers['x-middleware-subrequest'], undefined); assert.equal(req.headers['x-vinext-prerender-secret'], undefined);
  assert.equal(req.headers.host, config.host); assert.equal(req.headers['x-forwarded-proto'], 'https'); assert.equal(req.headers['x-forwarded-host'], config.host);
  assert.equal(req.headers['x-page-owner'], 'kept-for-app-validation'); assert.doesNotMatch(req.rawHeaders.join(' '), /attacker|evil|forged/);
  const authenticated = sanitizedSelfhostHeaders({ 'oai-authenticated-user-id': 'attacker' }, config, { id: config.ownerId, email: config.ownerEmail });
  assert.equal(authenticated['oai-authenticated-user-id'], config.ownerId);
});

void test('login requires same-origin CSRF, issues a host-only secure cookie and injects only the configured owner', async () => {
  const f = fixture(), page = await f.call('/signin-with-chatgpt'); const form = csrfForm(page.res);
  assert.doesNotMatch(page.res.body, /scrypt-v1|synthetic-long-password/);
  assert.match(String(page.res.headers['Content-Security-Policy']), /frame-ancestors 'none'/);
  assert.equal(page.res.headers['Referrer-Policy'], 'same-origin');
  const payload = new URLSearchParams({ email: config.ownerEmail, password: PASSWORD, csrf: form.csrf, return_to: '/health' });
  assert.equal((await f.call('/signin-with-chatgpt', 'POST', { cookie: form.cookie }, payload)).res.statusCode, 403);
  assert.equal((await f.call('/signin-with-chatgpt', 'POST', { origin: 'null', cookie: form.cookie }, payload)).res.statusCode, 403);
  assert.equal((await f.call('/signin-with-chatgpt', 'POST', { origin: 'https://evil.example', cookie: form.cookie }, payload)).res.statusCode, 403);
  assert.equal((await f.call('/signin-with-chatgpt', 'POST', { origin: config.origin, cookie: form.cookie }, new URLSearchParams({ ...Object.fromEntries(payload), csrf: 'forged' }))).res.statusCode, 403);
  const result = await login(f); assert.equal(result.res.statusCode, 303); assert.equal(result.res.headers.Location, '/health?days=30');
  const session = setCookies(result.res).find(value => value.startsWith('__Host-jso-session='))!;
  assert.ok(session); assert.match(session, /; Path=\/; HttpOnly; SameSite=Lax;/); assert.match(session, /; Secure$/); assert.doesNotMatch(session, /Domain=/i);
  const cookie = session.split(';')[0]; await f.call('/api/session', 'GET', { cookie, 'oai-authenticated-user-id': 'forged' });
  assert.equal(f.downstream.at(-1)?.headers['oai-authenticated-user-id'], config.ownerId);
  assert.equal(f.downstream.at(-1)?.headers['oai-authenticated-user-email'], config.ownerEmail);
  assert.equal((await f.call('/signin-with-chatgpt', 'GET', { cookie })).res.statusCode, 303);
});

void test('wrong login stays generic, expired CSRF is rejected and unsafe business requests need the canonical Origin', async () => {
  const f = fixture(); const rejected = await login(f, 'invalid-password', 'not-admin');
  assert.equal(rejected.res.statusCode, 401); assert.match(rejected.res.body, /邮箱或密码不正确/); assert.doesNotMatch(rejected.res.body, /not-admin|invalid-password/);
  const page = await f.call('/signin-with-chatgpt'); const csrf = csrfForm(page.res); f.time(NOW + 600001);
  assert.equal((await f.call('/signin-with-chatgpt', 'POST', { cookie: csrf.cookie, origin: config.origin }, new URLSearchParams({ email: config.ownerEmail, password: PASSWORD, csrf: csrf.csrf, return_to: '/' }))).res.statusCode, 403);
  const cookie = '__Host-jso-session=' + issueSelfhostSession(config, owner, NOW);
  assert.equal((await f.call('/api/health/records', 'POST', { cookie })).res.statusCode, 403);
  assert.equal((await f.call('/api/health/records', 'POST', { cookie, origin: 'https://evil.example' })).res.statusCode, 403);
  assert.equal(f.downstream.length, 0);
  assert.equal((await f.call('/api/health/records', 'POST', { cookie, origin: config.origin })).res.statusCode, 200);
});

void test('logout GET only asks for confirmation; the same-origin CSRF POST expires the session cookie', async () => {
  const f = fixture(), session = '__Host-jso-session=' + issueSelfhostSession(config, owner, NOW);
  const page = await f.call('/signout-with-chatgpt?return_to=%2Faccount%3FsignedOut%3D1', 'GET', { cookie: session });
  assert.equal(page.res.statusCode, 200); assert.match(page.res.body, /确认退出/); assert.ok(setCookies(page.res).every(value => !value.startsWith('__Host-jso-session=')));
  const csrf = csrfForm(page.res), payload = new URLSearchParams({ csrf: csrf.csrf, return_to: '/account?signedOut=1' });
  const cleared = await f.call('/signout-with-chatgpt', 'POST', { cookie: session + '; ' + csrf.cookie, origin: config.origin }, payload);
  assert.equal(cleared.res.statusCode, 303); assert.equal(cleared.res.headers.Location, '/account?signedOut=1');
  assert.ok(setCookies(cleared.res).some(value => value.startsWith('__Host-jso-session=;') && value.includes('Max-Age=0')));
});

void test('login work is bounded by peer/global attempts and concurrent scrypt checks', async () => {
  const limiter = new SelfhostLoginLimiter(); for (let i = 0; i < 10; i++) assert.equal(limiter.consume('proxy', NOW), true);
  assert.equal(limiter.consume('proxy', NOW), false); assert.equal(limiter.consume('proxy', NOW + 900000), true);
  for (let i = 0; i < 29; i++) assert.equal(limiter.consume('peer-' + i, NOW + 900000), true);
  assert.equal(limiter.consume('another-peer', NOW + 900000), false);
  const f = fixture(); const responses = await Promise.all([login(f), login(f), login(f)]);
  assert.ok(responses.some(item => item.res.statusCode === 429)); assert.ok(responses.filter(item => item.res.statusCode === 303).length <= 2);
});

void test('health exposes only readiness and commit metadata and fails closed without a ready schema', async () => {
  const f = fixture(), health = await f.call('/_selfhost/healthz');
  assert.deepEqual(JSON.parse(health.res.body), { ok: true, commitSha: 'a'.repeat(40), schema: { schemaReady: true, applied: 34, total: 34, pending: 0 } });
  assert.equal(f.downstream.length, 0); assert.doesNotMatch(health.res.body, /owner|password|database|key/);
  const broken = fixture({ readiness() { throw new Error('PRIVATE sqlite path and data'); } });
  const response = await broken.call('/_selfhost/healthz'); assert.equal(response.res.statusCode, 503); assert.equal(response.res.body, '{"ok":false}');
  assert.equal((await f.call('/_selfhost/healthz', 'POST')).res.statusCode, 405);
  for (const path of ['https://evil.example/', '//evil.example/', '/health\\evil']) assert.equal((await f.call(path)).res.statusCode, 400);
});

async function adminContext(f: ReturnType<typeof fixture>, session = issueSelfhostSession(config, owner, NOW)) {
  const cookie = '__Host-jso-session=' + session;
  const response = await f.call('/api/admin/users', 'GET', { cookie, 'x-page-owner': owner.id });
  assert.equal(response.res.statusCode, 200);
  assert.equal(response.res.headers['X-Account-Owner'], owner.id);
  const csrf = JSON.parse(response.res.body).csrfToken as string;
  const csrfCookie = setCookies(response.res).find(value => value.startsWith('__Host-jso-admin-csrf='))!.split(';')[0];
  return { cookie: cookie + '; ' + csrfCookie, csrf };
}
async function adminWrite(f: ReturnType<typeof fixture>, context: Awaited<ReturnType<typeof adminContext>>, method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return f.call(path, method, { cookie: context.cookie, 'x-page-owner': owner.id, origin: config.origin,
    'x-csrf-token': context.csrf, 'content-type': 'application/json', ...headers }, JSON.stringify(body));
}
function loginCookie(response: FakeResponse) { return setCookies(response).find(value => value.startsWith('__Host-jso-session='))!.split(';')[0]; }

void test('only the protected administrator can use user APIs, with owner binding and same-origin revision-bound CSRF', async () => {
  const f = fixture(); await f.ready;
  assert.equal((await f.call('/api/admin/users')).res.statusCode, 401);
  const session = '__Host-jso-session=' + issueSelfhostSession(config, owner, NOW);
  assert.equal((await f.call('/api/admin/users', 'GET', { cookie: session, 'x-page-owner': 'other-account' })).res.statusCode, 409);
  const context = await adminContext(f);
  for (const headers of [{ origin: 'null' }, { origin: 'https://evil.example' }, { 'x-csrf-token': 'forged' }] as Array<Record<string, string>>) {
    const response = await adminWrite(f, context, 'POST', '/api/admin/users', { email: 'member@example.test', password: PASSWORD }, headers);
    assert.equal(response.res.statusCode, 403); assert.equal(JSON.parse(response.res.body).code, 'LOCAL_USER_CSRF_INVALID');
  }
  const reused = await f.call('/api/admin/users', 'GET', { cookie: context.cookie, 'x-page-owner': owner.id });
  assert.equal(JSON.parse(reused.res.body).csrfToken, context.csrf);
  const body = JSON.parse((await adminWrite(f, context, 'POST', '/api/admin/users', { email: ' Member@Example.Test ', password: PASSWORD })).res.body);
  assert.match(body.user.id, /^[0-9a-f-]{36}$/); assert.equal(body.user.email, 'member@example.test'); assert.equal(body.user.isAdmin, false);
  assert.doesNotMatch(JSON.stringify(body), /password|scrypt|session/i);
  const normal = await login(f, PASSWORD, 'member@example.test');
  assert.equal(normal.res.statusCode, 303);
  const refused = await f.call('/api/admin/users', 'GET', { cookie: loginCookie(normal.res), 'x-page-owner': body.user.id });
  assert.equal(refused.res.statusCode, 403);
  assert.equal((await f.call('/settings/access')).res.headers.Location, '/settings/users');
});

void test('password reset, disable, re-enable and email changes revoke every old session through the persisted revision', async () => {
  const f = fixture(); const context = await adminContext(f);
  const created = await adminWrite(f, context, 'POST', '/api/admin/users', { email: 'member@example.test', password: PASSWORD });
  assert.equal(created.res.statusCode, 201); assert.equal(created.res.headers['X-Account-Owner'], owner.id); const member = JSON.parse(created.res.body).user;
  const first = await login(f, PASSWORD, member.email), firstCookie = loginCookie(first.res);
  const second = await login(f, PASSWORD, member.email), secondCookie = loginCookie(second.res);
  const newPassword = 'synthetic-reset-password-2026';
  const reset = await adminWrite(f, context, 'PATCH', '/api/admin/users/' + member.id, { expectedRevision: 1, password: newPassword });
  assert.equal(reset.res.statusCode, 200); assert.equal(JSON.parse(reset.res.body).user.revision, 2);
  for (const cookie of [firstCookie, secondCookie]) {
    const old = await f.call('/api/session', 'GET', { cookie, 'oai-authenticated-user-id': member.id });
    assert.equal(old.req.headers['oai-authenticated-user-id'], undefined);
  }
  assert.equal((await login(f, PASSWORD, member.email)).res.statusCode, 401);
  const fresh = await login(f, newPassword, member.email); assert.equal(fresh.res.statusCode, 303);
  assert.equal((await f.call('/api/session', 'GET', { cookie: loginCookie(fresh.res) })).req.headers['oai-authenticated-user-id'], member.id);
  const disabled = await adminWrite(f, context, 'PATCH', '/api/admin/users/' + member.id, { expectedRevision: 2, status: 'disabled' });
  assert.equal(disabled.res.statusCode, 200);
  assert.equal((await f.call('/api/session', 'GET', { cookie: loginCookie(fresh.res) })).req.headers['oai-authenticated-user-id'], undefined);
  assert.equal((await login(f, newPassword, member.email)).res.statusCode, 401);
  const enabled = await adminWrite(f, context, 'PATCH', '/api/admin/users/' + member.id, { expectedRevision: 3, status: 'active', email: 'renamed@example.test' });
  assert.equal(enabled.res.statusCode, 200); assert.equal(JSON.parse(enabled.res.body).user.revision, 4);
  assert.equal((await login(f, newPassword, member.email)).res.statusCode, 401);
  const renamed = await login(f, newPassword, 'renamed@example.test'); assert.equal(renamed.res.statusCode, 303);
  assert.equal((await f.call('/api/session', 'GET', { cookie: loginCookie(renamed.res) })).req.headers['oai-authenticated-user-email'], 'renamed@example.test');
});

void test('admin mutations reject stale or duplicate writes and cannot disable the administrator; self edit requires fresh login', async () => {
  const f = fixture(); const context = await adminContext(f);
  const duplicate = await adminWrite(f, context, 'POST', '/api/admin/users', { email: config.ownerEmail, password: PASSWORD });
  assert.equal(duplicate.res.statusCode, 409); assert.equal(JSON.parse(duplicate.res.body).code, 'LOCAL_USER_DUPLICATE');
  const forbidden = await adminWrite(f, context, 'PATCH', '/api/admin/users/' + owner.id, { expectedRevision: 1, status: 'disabled' });
  assert.equal(forbidden.res.statusCode, 400); assert.equal(JSON.parse(forbidden.res.body).code, 'LOCAL_USER_OWNER_PROTECTED');
  const edited = await adminWrite(f, context, 'PATCH', '/api/admin/users/' + owner.id, { expectedRevision: 1, email: 'new-admin@example.test' });
  assert.equal(edited.res.statusCode, 200); assert.equal(JSON.parse(edited.res.body).reauthRequired, true);
  assert.equal(edited.res.headers['X-Account-Owner'], owner.id);
  assert.equal((await f.call('/api/admin/users', 'GET', { cookie: context.cookie, 'x-page-owner': owner.id })).res.statusCode, 401);
  await bootstrapLocalOwner(f.db, { id: owner.id, email: config.ownerEmail, passwordHash: PASSWORD_HASH });
  assert.equal((await getLocalUserById(f.db, owner.id))?.email, 'new-admin@example.test');
  assert.equal((await login(f, PASSWORD, config.ownerEmail)).res.statusCode, 401);
  const fresh = await login(f, PASSWORD, 'new-admin@example.test'); assert.equal(fresh.res.statusCode, 303);
  const current = await adminContext(f, loginCookie(fresh.res).split('=')[1]);
  const stale = await adminWrite(f, current, 'PATCH', '/api/admin/users/' + owner.id, { expectedRevision: 1, email: 'stale@example.test' });
  assert.equal(stale.res.statusCode, 409); assert.equal(JSON.parse(stale.res.body).code, 'LOCAL_USER_STALE');
  const priorCsrf = await adminWrite(f, { cookie: loginCookie(fresh.res) + '; ' + context.cookie.split('; ')[1], csrf: context.csrf }, 'PATCH', '/api/admin/users/' + owner.id, { expectedRevision: 2, email: 'forged@example.test' });
  assert.equal(priorCsrf.res.statusCode, 403);
});

void test('database failures fail closed without leaking configuration and owner changes never restore bootstrap credentials', async () => {
  const f = fixture({ users: { async getById() { throw new Error('PRIVATE database path and password'); }, async getByEmail() { throw new Error('PRIVATE'); }, async touchLogin() {} } });
  const cookie = '__Host-jso-session=' + issueSelfhostSession(config, owner, NOW);
  const failed = await f.call('/api/admin/users', 'GET', { cookie, 'x-page-owner': owner.id });
  assert.equal(failed.res.statusCode, 503); assert.equal(JSON.parse(failed.res.body).code, 'LOCAL_USERS_UNAVAILABLE'); assert.doesNotMatch(failed.res.body, /PRIVATE|password/);
  assert.equal((await login(f)).res.statusCode, 503);
  const normal = fixture(); await normal.ready;
  await updateLocalUser(normal.db, owner.id, owner.id, { expectedRevision: 1, passwordHash: await hashPassword('changed-bootstrap-password-2026') });
  await bootstrapLocalOwner(normal.db, { id: owner.id, email: config.ownerEmail, passwordHash: PASSWORD_HASH });
  assert.equal((await login(normal, PASSWORD)).res.statusCode, 401);
  assert.equal((await login(normal, 'changed-bootstrap-password-2026')).res.statusCode, 303);
});

void test('legacy owner cookies require a clean login and supported Unicode passwords survive native form encoding', async () => {
  const encoded = Buffer.from(JSON.stringify({ v: 1, sub: owner.id, iat: NOW / 1000, exp: NOW / 1000 + 3600, nonce: Buffer.alloc(24, 1).toString('base64url') })).toString('base64url');
  const oldKey = createHmac('sha256', Buffer.from(config.sessionSecret, 'base64url')).update(JSON.stringify(['jiashu-selfhost-v1', 'session', config.origin, 'admin', config.passwordHash, config.ownerId, config.ownerEmail])).digest();
  const legacy = encoded + '.' + createHmac('sha256', oldKey).update(encoded).digest('base64url');
  assert.equal(verifySelfhostSession(config, legacy, NOW), null);
  const f = fixture(); await f.ready;
  assert.equal((await f.call('/api/session', 'GET', { cookie: '__Host-jso-session=' + legacy })).req.headers['oai-authenticated-user-id'], undefined);
  const unicodePassword = '😀'.repeat(256);
  await updateLocalUser(f.db, owner.id, owner.id, { expectedRevision: 1, passwordHash: await hashPassword(unicodePassword) });
  const path = '/health?notes=' + 'a'.repeat(1500);
  const response = await login(f, unicodePassword, config.ownerEmail, path);
  assert.equal(response.res.statusCode, 303); assert.equal(response.res.headers.Location, path);
  const form = await f.call('/signin-with-chatgpt');
  assert.match(form.res.body, /name="password"[^>]*maxlength="1024"/);
  assert.doesNotMatch(form.res.body, /name="username"/);
  assert.equal(safeSelfhostReturnTo('/health?notes=' + '😀'.repeat(900)), '/');
});

void test('successful logins do not exhaust the shared failure budget across legitimate users', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 35; attempt++) assert.equal((await login(f)).res.statusCode, 303);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await login(f, 'wrong-long-password')).res.statusCode, 401);
  assert.equal((await login(f, 'wrong-long-password')).res.statusCode, 429);
});
