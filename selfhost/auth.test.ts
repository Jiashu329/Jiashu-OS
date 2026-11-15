import assert from 'node:assert/strict';
import test from 'node:test';
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
function fixture(options: { readiness?: () => { schemaReady: boolean; applied: number; total: number; pending: number }; limiter?: SelfhostLoginLimiter } = {}) {
  let time = NOW; const downstream: IncomingMessage[] = [];
  const gateway = createSelfhostGateway(config, (req, res) => { downstream.push(req); res.writeHead(200); res.end('application'); }, {
    now: () => time, commitSha: 'a'.repeat(40), readiness: options.readiness ?? (() => ({ schemaReady: true, applied: 34, total: 34, pending: 0 })), limiter: options.limiter,
  });
  return { downstream, time(value: number) { time = value; }, async call(path: string, method = 'GET', headers: Record<string, string> = {}, body?: URLSearchParams | string) {
    const req = request(path, method, headers, body), res = new FakeResponse(); await gateway(req, res as unknown as ServerResponse); return { req, res };
  } };
}
function setCookies(response: FakeResponse): string[] { const value = response.headers['Set-Cookie']; return Array.isArray(value) ? value : value ? [value] : []; }
function csrfForm(response: FakeResponse) {
  const csrf = response.body.match(/name="csrf" value="([^"]+)"/)?.[1]; assert.ok(csrf);
  const value = setCookies(response)[0]?.split(';')[0]; assert.ok(value); return { csrf, cookie: value };
}
async function login(f: ReturnType<typeof fixture>, password = PASSWORD, username = 'admin', returnTo = '/health?days=30') {
  const page = await f.call('/signin-with-chatgpt?return_to=' + encodeURIComponent(returnTo));
  const csrf = csrfForm(page.res);
  return f.call('/signin-with-chatgpt', 'POST', { origin: config.origin, cookie: csrf.cookie }, new URLSearchParams({ username, password, csrf: csrf.csrf, return_to: returnTo }));
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

void test('sessions expire, reject tampering and are invalidated by password, secret, owner or origin rotation', () => {
  const value = issueSelfhostSession(config, NOW); assert.equal(verifySelfhostSession(config, value, NOW), true);
  assert.equal(verifySelfhostSession(config, value, NOW + config.sessionTtl * 1000), false);
  assert.equal(verifySelfhostSession(config, value + 'x', NOW), false);
  assert.equal(verifySelfhostSession(config, value, NOW - 31000), false);
  for (const changed of [{ sessionSecret: Buffer.alloc(32, 12).toString('base64url') }, { passwordHash: PASSWORD_HASH + 'x' }, { ownerId: 'another-owner' }, { ownerEmail: 'another@example.test' }, { origin: 'https://elsewhere.example' }]) {
    assert.equal(verifySelfhostSession({ ...config, ...changed }, value, NOW), false);
  }
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
  const authenticated = sanitizedSelfhostHeaders({ 'oai-authenticated-user-id': 'attacker' }, config, true);
  assert.equal(authenticated['oai-authenticated-user-id'], config.ownerId);
});

void test('login requires same-origin CSRF, issues a host-only secure cookie and injects only the configured owner', async () => {
  const f = fixture(), page = await f.call('/signin-with-chatgpt'); const form = csrfForm(page.res);
  assert.doesNotMatch(page.res.body, /synthetic-test-owner|scrypt-v1|synthetic-long-password/);
  assert.match(String(page.res.headers['Content-Security-Policy']), /frame-ancestors 'none'/);
  const payload = new URLSearchParams({ username: 'admin', password: PASSWORD, csrf: form.csrf, return_to: '/health' });
  assert.equal((await f.call('/signin-with-chatgpt', 'POST', { cookie: form.cookie }, payload)).res.statusCode, 403);
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
  assert.equal(rejected.res.statusCode, 401); assert.match(rejected.res.body, /账号或密码不正确/); assert.doesNotMatch(rejected.res.body, /not-admin|invalid-password/);
  const page = await f.call('/signin-with-chatgpt'); const csrf = csrfForm(page.res); f.time(NOW + 600001);
  assert.equal((await f.call('/signin-with-chatgpt', 'POST', { cookie: csrf.cookie, origin: config.origin }, new URLSearchParams({ username: 'admin', password: PASSWORD, csrf: csrf.csrf, return_to: '/' }))).res.statusCode, 403);
  const cookie = '__Host-jso-session=' + issueSelfhostSession(config, NOW);
  assert.equal((await f.call('/api/health/records', 'POST', { cookie })).res.statusCode, 403);
  assert.equal((await f.call('/api/health/records', 'POST', { cookie, origin: 'https://evil.example' })).res.statusCode, 403);
  assert.equal(f.downstream.length, 0);
  assert.equal((await f.call('/api/health/records', 'POST', { cookie, origin: config.origin })).res.statusCode, 200);
});

void test('logout GET only asks for confirmation; the same-origin CSRF POST expires the session cookie', async () => {
  const f = fixture(), session = '__Host-jso-session=' + issueSelfhostSession(config, NOW);
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
