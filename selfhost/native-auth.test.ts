import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { SQLiteD1Database } from './database.ts';
import { bootstrapLocalOwner, createLocalUser, getLocalUserByEmail, getLocalUserById, touchLocalUserLogin } from '../db/local-users-store.ts';
import { isLocalSessionRevoked, revokeLocalSession } from '../db/local-session-revocations-store.ts';
import { createSelfhostGateway, hashPassword, issueSelfhostSession, loadSelfhostAuthConfig, verifySelfhostSession } from './auth.ts';
import type { SelfhostGatewayOptions } from './auth.ts';
import { nativeAPIMethods } from './native-auth.ts';
import { createSelfhostUserManagement } from './user-management.ts';

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
      cookie: req.headers.cookie ?? null, nativeClient: req.headers['x-jso-native-client'] ?? null, rawHeaders: req.rawHeaders }));
  }, { now: () => time, readiness: () => ({ schemaReady: true, applied: 2, total: 2, pending: 0 }), commitSha: 'a'.repeat(40),
    users: overrides.users ?? { getById: id => getLocalUserById(db, id), getByEmail: email => getLocalUserByEmail(db, email),
      touchLogin: (id, at) => touchLocalUserLogin(db, id, new Date(at).toISOString()) },
    sessions: overrides.sessions ?? { isRevoked: (family, at) => isLocalSessionRevoked(db, family, at), revoke: (family, expires, at) => revokeLocalSession(db, family, expires, at) },
    manageUsers: createSelfhostUserManagement(config, db, { now: () => time }) });
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
      'oai-authenticated-user-email': 'forged@example.test', 'x-forwarded-host': 'evil.example', 'x-page-owner': 'forged', 'x-jso-native-client': 'forged-client' });
    assert.equal(response.status, 200); assert.equal(response.data.path, '/api/health?days=30');
    assert.equal(response.data.actor, session.user.id); assert.equal(response.data.pageOwner, session.user.id);
    assert.equal(response.data.email, session.user.email); assert.equal(response.data.origin, config.origin);
    assert.equal(response.data.authorization, null); assert.equal(response.data.cookie, null);
    assert.equal(response.data.nativeClient, 'healthkit-v1');
    assert.doesNotMatch(JSON.stringify(response.data.rawHeaders), /forged|evil\.example|Bearer/);
    assert.equal(response.headers['set-cookie'], undefined);
  }
});

void test('the native channel marker is gateway-owned and channel methods map to the existing application boundary', async t => {
  const f = await fixture(t), session = await f.login();
  const cookie = '__Host-jso-session=' + issueSelfhostSession(config, { id: config.ownerId, revision: 1 }, NOW);
  const browser = await f.call('/api/sync/channel', 'GET', { Cookie: cookie, 'X-Jso-Native-Client': 'healthkit-v1' });
  assert.equal(browser.status, 200);
  assert.equal(browser.data.actor, config.ownerId);
  assert.equal(browser.data.nativeClient, null, 'A browser session cannot spoof native selection consent.');
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await f.call('/api/native/sync/channel', method, { ...bearer(session), 'X-Jso-Native-Client': 'spoofed' });
    assert.equal(response.status, 200);
    assert.equal(response.data.path, '/api/sync/channel');
    assert.equal(response.data.nativeClient, 'healthkit-v1');
    assert.equal(response.data.actor, config.ownerId);
  }
  assert.equal((await f.call('/api/native/sync/channel', 'POST', bearer(session))).status, 405);
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
  for (const path of ['/api/native/admin/secrets', '/api/native/finance/unknown', '/api/native/health/records/arbitrary', '/api/native/health/', '/api/native/auth/unknown']) {
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

void test('every existing web API has an explicitly reviewed native method mapping without a wildcard proxy', () => {
  const root = new URL('../app/api/', import.meta.url);
  const walk = (directory: URL, relative = '') => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory()) { walk(new URL(item.name + '/', directory), relative + item.name + '/'); continue; }
      if (item.name !== 'route.ts') continue;
      const source = readFileSync(new URL(item.name, directory), 'utf8');
      const methods = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b/g)]
        .map(match => match[1] ?? match[2]);
      if (/export\s*\{\s*GET,\s*POST\s*\}/.test(source)) methods.push('GET', 'POST');
      const path = '/api/native/' + relative.replace(/\/$/, '')
        .replace('[key]', 'weight%3Asynthetic%2Fscale')
        .replace(/\[(?:id|bookId|memberId|entryId)\]/g, relative.startsWith('health/import/') ? 'a'.repeat(64) : '10000000-0000-4000-8000-000000000001');
      const expected = [...new Set(methods)].sort((left, right) => left.localeCompare(right));
      assert.deepEqual([...(nativeAPIMethods(path) ?? [])].sort((left, right) => left.localeCompare(right)), expected, path);
    }
  };
  walk(root);
  for (const path of ['/api/native/finance/new-feature', '/api/native/settings/secrets', '/api/native/health/records/steps:2026-01-01/extra', '/api/native/admin/users/owner/delete']) {
    assert.equal(nativeAPIMethods(path), null, path);
  }
});

void test('native dynamic resources preserve encoded identity and family scope while refusing ambiguous traversal and double encodings', async t => {
  const f = await fixture(t), session = await f.login();
  for (const [path, method] of [
    ['/api/native/finance/accounts/10000000%2D0000%2D4000%2D8000%2D000000000001?book=family-book&accessRevision=7', 'PATCH'],
    ['/api/native/finance/accounts/10000000-0000-4000-8000-000000000001/balances/initial%3A10000000-0000-4000-8000-000000000002/preview', 'POST'],
    ['/api/native/health/records/weight%3Ahealthkit%2Fscale/history', 'GET'],
  ]) {
    const response = await f.call(path, method, { ...bearer(session), 'Idempotency-Key': '10000000-0000-4000-8000-000000000001' }, method === 'GET' ? undefined : '{}');
    assert.equal(response.status, 200, path); assert.equal(response.data.path, path.replace('/api/native/', '/api/'));
    assert.equal(response.data.actor, config.ownerId);
  }
  for (const path of ['/api/native/finance/accounts/a%2Fb', '/api/native/finance/accounts/%252e%252e', '/api/native/finance/accounts/%00',
    '/api/native/finance/accounts/%FF', '/api/native/finance/accounts/%2E%2E', '/api/native/health/records/weight%3Ascale%2F..%2Fother',
    '/api/native/health/records/weight%253Ascales', '/api/native/finance/books/book/members/member%3Fadmin']) {
    const response = await f.call(path, 'GET', bearer(session));
    assert.ok(response.status === 400 || response.status === 404, path);
  }
});

void test('native administrator users reuse role checks, credential revisions and owner protection without accepting browser marker spoofing', async t => {
  const f = await fixture(t), owner = await f.login(), bob = await f.login('bob@synthetic.example');
  assert.equal((await f.call('/api/native/admin/users', 'GET', bearer(bob))).status, 403);
  const listing = await f.call('/api/native/admin/users', 'GET', bearer(owner));
  assert.equal(listing.status, 200); assert.equal(listing.data.currentUserId, config.ownerId); assert.equal(listing.headers['set-cookie'], undefined);
  assert.equal(listing.data.csrfToken, undefined); assert.doesNotMatch(listing.body, /passwordHash|scrypt/);
  const created = await f.call('/api/native/admin/users', 'POST', bearer(owner), JSON.stringify({ email: 'native-created@synthetic.example', password: PASSWORD }));
  assert.equal(created.status, 201); const user = created.data.user as { id: string; revision: number };
  const protectedOwner = await f.call('/api/native/admin/users/' + config.ownerId, 'PATCH', bearer(owner), JSON.stringify({ expectedRevision: 1, status: 'disabled' }));
  assert.equal(protectedOwner.status, 400); assert.equal(protectedOwner.data.code, 'LOCAL_USER_OWNER_PROTECTED');
  const member = await f.login('native-created@synthetic.example');
  const disabled = await f.call('/api/native/admin/users/' + user.id, 'PATCH', bearer(owner), JSON.stringify({ expectedRevision: user.revision, status: 'disabled' }));
  assert.equal(disabled.status, 200);
  assert.equal((await f.call('/api/native/session', 'GET', bearer(member))).status, 401);
  const browserCookie = '__Host-jso-session=' + issueSelfhostSession(config, { id: config.ownerId, revision: 1 }, NOW);
  const spoofed = await f.call('/api/admin/users', 'POST', { Cookie: browserCookie, Origin: config.origin, 'X-Page-Owner': config.ownerId, 'X-Jso-Native-Client': 'healthkit-v1' }, JSON.stringify({ email: 'forged@synthetic.example', password: PASSWORD }));
  assert.equal(spoofed.status, 403); assert.equal(spoofed.data.code, 'LOCAL_USER_CSRF_INVALID');
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
