import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { SQLiteD1Database } from './database.ts';
import { bootstrapLocalOwner, createLocalUser, getLocalUserByEmail, getLocalUserById, touchLocalUserLogin } from '../db/local-users-store.ts';
import { isLocalSessionRevoked, revokeLocalSession } from '../db/local-session-revocations-store.ts';
import { createSelfhostGateway, hashPassword, issueSelfhostSession, loadSelfhostAuthConfig, verifySelfhostSession } from './auth.ts';
import type { SelfhostGatewayOptions } from './auth.ts';

const NOW = Date.parse('2026-11-16T10:00:00Z');
const PASSWORD = 'native-synthetic-password-2026', HASH = await hashPassword(PASSWORD);
const config = loadSelfhostAuthConfig({ SELFHOST_PUBLIC_ORIGIN: 'https://native.synthetic.example', SELFHOST_PASSWORD_HASH: HASH,
  SELFHOST_SESSION_SECRET: Buffer.alloc(32, 27).toString('base64url'), APP_OWNER_USER_ID: 'native-synthetic-owner', APP_OWNER_EMAIL: 'owner@synthetic.example' });
interface ResponseData { status: number; headers: Record<string, string | string[] | undefined>; body: string; data: Record<string, unknown> }
interface LoginData { accessToken: string; expiresAt: string; user: { id: string; email: string } }

async function fixture(t: test.TestContext, overrides: { users?: SelfhostGatewayOptions['users']; sessions?: SelfhostGatewayOptions['sessions']; downstream?: (req: IncomingMessage, res: ServerResponse) => unknown } = {}) {
  const db = new SQLiteD1Database(':memory:');
  for (const path of ['0034_local_users.sql', '0035_local_session_revocations.sql']) db.transaction(() => db.executeMigrationSQL(readFileSync(new URL('../drizzle/' + path, import.meta.url), 'utf8')));
  await bootstrapLocalOwner(db, { id: config.ownerId, email: config.ownerEmail, passwordHash: HASH }, new Date(NOW).toISOString());
  const bob = '11111111-1111-4111-8111-111111111111';
  await createLocalUser(db, { id: bob, email: 'bob@synthetic.example', passwordHash: HASH }, new Date(NOW).toISOString());
  let time = NOW;
  const forwarded: IncomingMessage[] = [];
  const gateway = createSelfhostGateway(config, (req, res) => {
    forwarded.push(req);
    if (overrides.downstream) return overrides.downstream(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, actor: req.headers['oai-authenticated-user-id'] ?? null, email: req.headers['oai-authenticated-user-email'] ?? null,
      pageOwner: req.headers['x-page-owner'] ?? null, origin: req.headers.origin ?? null, authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null, rawHeaders: req.rawHeaders }));
  }, { now: () => time, readiness: () => ({ schemaReady: true, applied: 2, total: 2, pending: 0 }), commitSha: 'a'.repeat(40),
    users: overrides.users ?? { getById: id => getLocalUserById(db, id), getByEmail: email => getLocalUserByEmail(db, email),
      touchLogin: (id, at) => touchLocalUserLogin(db, id, new Date(at).toISOString()) },
    sessions: overrides.sessions ?? { isRevoked: (family, at) => isLocalSessionRevoked(db, family, at), revoke: (family, expires, at) => revokeLocalSession(db, family, expires, at) } });
  const server = createServer((req, res) => { void gateway(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<ResponseData> => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: address.port, path, method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }), ...headers } }, res => {
      const parts: Buffer[] = []; res.on('data', chunk => parts.push(Buffer.from(chunk))); res.on('end', () => {
        const text = Buffer.concat(parts).toString(); let data = {};
        try { data = JSON.parse(text); } catch { /* Web routes intentionally return HTML. */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, data });
      });
    });
    req.on('error', reject); req.end(body);
  });
  const login = async (email = config.ownerEmail, password = PASSWORD) => {
    const response = await call('/api/native/auth/login', 'POST', {}, JSON.stringify({ email, password }));
    assert.equal(response.status, 200, response.body);
    return response.data as unknown as LoginData;
  };
  return { db, bob, call, login, forwarded, time(at: number) { time = at; } };
}
const bearer = (session: LoginData) => ({ Authorization: 'Bearer ' + session.accessToken });

void test('real HTTP native login and mapped APIs bind each user to their own existing identity and strip caller credentials', async t => {
  const f = await fixture(t), alice = await f.login(), bob = await f.login('bob@synthetic.example');
  assert.deepEqual(alice.user, { id: config.ownerId, email: config.ownerEmail });
  assert.equal(alice.expiresAt, new Date(NOW + config.sessionTtl * 1000).toISOString());
  assert.equal(verifySelfhostSession(config, alice.accessToken, NOW), null, 'Native signing has a distinct domain.');
  assert.doesNotMatch(JSON.stringify(alice), /passwordHash|scrypt|synthetic-password/);
  for (const session of [alice, bob]) {
    const response = await f.call('/api/native/health?days=30', 'GET', { ...bearer(session), 'oai-authenticated-user-id': 'forged',
      'oai-authenticated-user-email': 'forged@example.test', 'x-forwarded-host': 'evil.example', 'x-page-owner': 'forged' });
    assert.equal(response.status, 200); assert.equal(response.data.path, '/api/health?days=30');
    assert.equal(response.data.actor, session.user.id); assert.equal(response.data.pageOwner, session.user.id);
    assert.equal(response.data.email, session.user.email); assert.equal(response.data.origin, config.origin);
    assert.equal(response.data.authorization, null); assert.equal(response.data.cookie, null);
    assert.doesNotMatch(JSON.stringify(response.data.rawHeaders), /forged|evil\.example|Bearer/);
    assert.equal(response.headers['set-cookie'], undefined);
  }
});

void test('native tokens cannot authenticate browser routes and browser cookies or Origins cannot authenticate native routes', async t => {
  const f = await fixture(t), session = await f.login();
  const browser = await f.call('/api/session', 'GET', bearer(session)); assert.equal(browser.data.actor, null);
  const cookie = '__Host-jso-session=' + issueSelfhostSession(config, { id: config.ownerId, revision: 1 }, NOW);
  assert.equal((await f.call('/api/native/overview', 'GET', { Cookie: cookie })).status, 403);
  assert.equal((await f.call('/api/native/overview', 'GET', { ...bearer(session), Cookie: cookie })).status, 403);
  for (const origin of [config.origin, 'https://evil.example', 'null']) {
    assert.equal((await f.call('/api/native/overview', 'GET', { ...bearer(session), Origin: origin })).status, 403);
    assert.equal((await f.call('/api/native/auth/login', 'POST', { Origin: origin }, JSON.stringify({ email: config.ownerEmail, password: PASSWORD }))).status, 403);
  }
  const cookieAsBearer = await f.call('/api/native/overview', 'GET', { Authorization: 'Bearer ' + cookie.split('=')[1] });
  assert.equal(cookieAsBearer.status, 401);
  const normalWrite = await f.call('/api/health/import', 'POST', bearer(session), '{}');
  assert.equal(normalWrite.status, 403, 'Browser Origin/CSRF boundary remains in place.');
});

void test('native API methods and paths are explicitly allowlisted and write requests retain business operation headers and bodies', async t => {
  const f = await fixture(t, { downstream(req, res) {
    const chunks: Buffer[] = []; req.on('data', value => chunks.push(Buffer.from(value))); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString(), operation: req.headers['x-request-id'], owner: req.headers['x-page-owner'] }));
    });
  } }), session = await f.login();
  for (const path of ['/api/native/admin/users', '/api/native/finance/accounts', '/api/native/health/records/arbitrary', '/api/native/health/', '/api/native/auth/unknown']) {
    assert.equal((await f.call(path, 'GET', bearer(session))).status, 404, path);
  }
  for (const path of ['/api/native/health/../overview', '/api/native/health%2fimport', '/api/native//overview', '/api/native/overview#fragment']) {
    assert.equal((await f.call(path, 'GET', bearer(session))).status, 400, path);
  }
  assert.equal((await f.call('/api/native/overview', 'DELETE', bearer(session))).status, 405);
  assert.equal((await f.call('/api/native/auth/login?return_to=https://evil.example', 'POST', {}, '{}')).status, 400);
  const command = '{"metric":"weight","value":72,"expectedRevision":0}';
  const response = await f.call('/api/native/health/records', 'POST', { ...bearer(session), 'X-Request-ID': 'synthetic-operation' }, command);
  assert.equal(response.status, 200); assert.equal(response.data.path, '/api/health/records');
  assert.equal(response.data.body, command); assert.equal(response.data.operation, 'synthetic-operation'); assert.equal(response.data.owner, config.ownerId);
});

void test('refresh preserves the revocable family, logout revokes both old and renewed tokens without affecting another device', async t => {
  const f = await fixture(t), original = await f.login(), other = await f.login();
  f.time(NOW + 60000);
  const refreshed = await f.call('/api/native/auth/refresh', 'POST', bearer(original));
  assert.equal(refreshed.status, 200); const renewed = refreshed.data as unknown as LoginData;
  assert.notEqual(renewed.accessToken, original.accessToken);
  assert.equal((await f.call('/api/native/auth/logout', 'POST', bearer(original))).status, 200);
  for (const session of [original, renewed]) {
    assert.equal((await f.call('/api/native/overview', 'GET', bearer(session))).status, 401);
    assert.equal((await f.call('/api/native/auth/refresh', 'POST', bearer(session))).status, 401);
  }
  assert.equal((await f.call('/api/native/overview', 'GET', bearer(other))).status, 200);
  f.time(NOW + 29 * 24 * 60 * 60 * 1000);
  assert.equal((await f.call('/api/native/overview', 'GET', bearer(renewed))).status, 401);
});

void test('expired, tampered, disabled and credential-revision-changed native sessions fail before forwarding', async t => {
  const f = await fixture(t), alice = await f.login(), bob = await f.login('bob@synthetic.example');
  for (const Authorization of ['Bearer ' + alice.accessToken + 'x', alice.accessToken, 'bearer ' + alice.accessToken, 'Bearer ']) {
    assert.equal((await f.call('/api/native/overview', 'GET', { Authorization })).status, 401);
  }
  f.time(NOW + config.sessionTtl * 1000);
  assert.equal((await f.call('/api/native/overview', 'GET', bearer(alice))).status, 401, 'Exact expiry invalidates an otherwise active unchanged user.');
  f.time(NOW);
  await f.db.prepare('UPDATE local_users SET revision=revision+1 WHERE id=?').bind(config.ownerId).run();
  assert.equal((await f.call('/api/native/overview', 'GET', bearer(alice))).status, 401);
  await f.db.prepare("UPDATE local_users SET status='disabled' WHERE id=?").bind(f.bob).run();
  assert.equal((await f.call('/api/native/overview', 'GET', bearer(bob))).status, 401);
  f.time(NOW + config.sessionTtl * 1000);
  assert.equal((await f.call('/api/native/overview', 'GET', bearer(alice))).status, 401);
  assert.equal(f.forwarded.length, 0);
});

void test('a delayed refresh racing logout cannot regain authorization after the revocation retention window', async t => {
  let pauseNext = false;
  let release: () => void = () => {}, started: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, { sessions: {
    async isRevoked(family, at) {
      const result = await isLocalSessionRevoked(database, family, at);
      if (pauseNext) { pauseNext = false; started(); await held; }
      return result;
    },
    revoke: (family, expires, at) => revokeLocalSession(database, family, expires, at),
  } });
  const database: SQLiteD1Database = f.db;
  const original = await f.login();
  pauseNext = true;
  const pending = f.call('/api/native/auth/refresh', 'POST', bearer(original));
  await waiting;
  f.time(NOW + 1000);
  assert.equal((await f.call('/api/native/auth/logout', 'POST', bearer(original))).status, 200);
  f.time(NOW + 5000); release();
  const refreshed = await pending; assert.equal(refreshed.status, 200);
  const late = refreshed.data as unknown as LoginData;
  assert.equal((await f.call('/api/native/overview', 'GET', bearer(late))).status, 401);
  f.time(NOW + 1001 + config.sessionTtl * 1000);
  assert.equal((await f.call('/api/native/overview', 'GET', bearer(late))).status, 401, 'Late issuance cannot extend beyond the retained logout tombstone.');
});

void test('native logins bound concurrent password verification before storage and credential work', async t => {
  let release: () => void = () => {}, entered = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { users: {
    getById: id => getLocalUserById(database, id),
    async getByEmail(email) { entered++; await held; return getLocalUserByEmail(database, email); },
    touchLogin: (id, at) => touchLocalUserLogin(database, id, new Date(at).toISOString()),
  } });
  const database: SQLiteD1Database = f.db;
  const body = JSON.stringify({ email: config.ownerEmail, password: PASSWORD });
  const pending = [f.call('/api/native/auth/login', 'POST', {}, body), f.call('/api/native/auth/login', 'POST', {}, body)];
  while (entered < 2) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await f.call('/api/native/auth/login', 'POST', {}, body)).status, 429);
  assert.equal(entered, 2); release();
  assert.deepEqual((await Promise.all(pending)).map(response => response.status), [200, 200]);
});

void test('malformed, oversized and incorrect logins have bounded generic errors and repeated failures are throttled', async t => {
  const f = await fixture(t);
  for (const body of ['not json', '[]', '{}', '{"email":"a","password":"b","userId":"forged"}', JSON.stringify({ email: config.ownerEmail, password: 'x'.repeat(17000) })]) {
    const response = await f.call('/api/native/auth/login', 'POST', {}, body); assert.equal(response.status, 400);
    assert.doesNotMatch(response.body, /scrypt|passwordHash|forged/);
  }
  for (let index = 0; index < 10; index++) {
    assert.equal((await f.call('/api/native/auth/login', 'POST', {}, JSON.stringify({ email: config.ownerEmail, password: 'wrong-password' }))).status, 401);
  }
  const blocked = await f.call('/api/native/auth/login', 'POST', {}, JSON.stringify({ email: config.ownerEmail, password: PASSWORD }));
  assert.equal(blocked.status, 429); assert.equal(blocked.headers['retry-after'], '900'); assert.equal(blocked.headers['set-cookie'], undefined);
});

void test('native session lookup and durable logout errors fail closed with JSON and do not leak storage details', async t => {
  let failed = false;
  const f = await fixture(t, { sessions: { async isRevoked() { if (failed) throw new Error('PRIVATE database path'); return false; }, async revoke() { throw new Error('PRIVATE revocation data'); } } });
  const session = await f.login();
  const logout = await f.call('/api/native/auth/logout', 'POST', bearer(session));
  assert.equal(logout.status, 503); assert.equal(logout.data.code, 'LOCAL_USERS_UNAVAILABLE'); assert.doesNotMatch(logout.body, /PRIVATE/);
  failed = true;
  const read = await f.call('/api/native/overview', 'GET', bearer(session));
  assert.equal(read.status, 503); assert.equal(read.data.code, 'LOCAL_USERS_UNAVAILABLE'); assert.doesNotMatch(read.body, /PRIVATE/);
  assert.equal(f.forwarded.length, 0);
});
