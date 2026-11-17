import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This is a production-HTTP acceptance test for GitHub Actions or an explicitly
// selected standalone machine. Managed Sites previews must use their own server.
if (process.env.SITES_MANAGED_LINUX_CONTAINER === '1') {
  throw new Error('Standalone HTTP smoke tests cannot run in the managed Sites environment. Run the Self-hosted checks workflow instead.');
}
if (process.env.CI !== 'true' && process.env.SELFHOST_SMOKE_ALLOW_LOCAL !== '1') {
  throw new Error('Run this test in CI, or set SELFHOST_SMOKE_ALLOW_LOCAL=1 on a standalone test machine.');
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Self-hosted smoke tests require Node.js 24 or newer.');

const app = resolve('dist/standalone');
for (const file of ['selfhost/server.mjs', 'selfhost/auth.ts', 'selfhost/migrations.ts', 'dist/server/index.js']) {
  if (!existsSync(join(app, file))) throw new Error('Standalone production output is incomplete; run npm run build:selfhost first.');
}
const { hashPassword, issueSelfhostSession, loadSelfhostAuthConfig } = await import(pathToFileURL(join(app, 'selfhost/auth.ts')).href);
const temporary = mkdtempSync(join(tmpdir(), 'jiashu-selfhost-smoke-'));
const database = join(temporary, 'smoke.sqlite3');
const password = randomBytes(24).toString('base64url');
const ownerId = 'selfhost-smoke-owner', email = 'smoke@example.test';
const commitSha = 'd'.repeat(40);
const date = '2026-01-01';
let child;

async function freeLoopbackPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolveClose, reject) => socket.close(error => error ? reject(error) : resolveClose()));
  return port;
}

const port = await freeLoopbackPort();
const origin = 'http://127.0.0.1:' + port;
const childEnvironment = {
  ...process.env,
  CI: 'true', SELFHOST_ALLOW_HTTP: '1', SELFHOST_PUBLIC_ORIGIN: origin,
  HOST: '127.0.0.1', PORT: String(port), SELFHOST_DB_PATH: database,
  SELFHOST_USERNAME: 'legacy-smoke-admin', SELFHOST_PASSWORD_HASH: await hashPassword(password),
  SELFHOST_SESSION_SECRET: randomBytes(32).toString('base64url'),
  APP_OWNER_USER_ID: ownerId, APP_OWNER_EMAIL: email,
  AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_COMMIT_SHA: commitSha,
};

function migrate() {
  // Capture rather than inherit output: a failing child may emit implementation
  // diagnostics, but never echo private configuration into CI logs.
  try {
    execFileSync(process.execPath, ['selfhost/migrations.ts', 'migrate', '--database', database, '--directory', join(app, 'drizzle')], {
      cwd: app, env: childEnvironment, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new Error('Standalone database migration failed.'); }
}

async function start() {
  let output = '';
  child = spawn(process.execPath, ['selfhost/server.mjs'], { cwd: app, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-32000); });
  child.stderr.on('data', () => { /* Never forward child diagnostics or private configuration. */ });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => finish(new Error('Standalone production server did not become ready.')), 30000);
    const check = () => { if (output.split('\n').some(line => { try { const item = JSON.parse(line); return item.event === 'selfhost_ready' && item.port === port; } catch { return false; } })) finish(); };
    const exited = () => finish(new Error('Standalone production server exited before readiness.'));
    const failed = () => finish(new Error('Standalone production server could not start.'));
    function finish(error) {
      clearTimeout(timer); child.stdout.off('data', check); child.off('exit', exited); child.off('error', failed);
      if (error) reject(error);
      else resolveReady();
    }
    child.stdout.on('data', check); child.once('exit', exited); child.once('error', failed);
    check();
  });
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  child.kill('SIGTERM');
  try { await stopped; } finally { clearTimeout(timer); }
}

class Browser {
  cookies = new Map();
  async request(path, options = {}) {
    const headers = new Headers(options.headers);
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([name, value]) => name + '=' + value).join('; '));
    const response = await fetch(origin + path, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), separator = pair.indexOf('=');
      const name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

async function json(response, status, label) {
  let code = '';
  if (response.status !== status) {
    // Log only fixed error-code families, never response bodies, credentials,
    // filled form values or underlying provider/storage exception messages.
    try {
      const failure = await response.clone().json();
      if (typeof failure?.code === 'string' && failure.code.length <= 96
        && /^(?:(?:NATIVE|HEALTH|SYNC|DOUBAN|FINANCE|BACKUP|AI|TMDB|LOCAL|ACCOUNT)_[A-Z0-9_]+|INVALID_DOUBAN_INPUT|SIGN_IN_REQUIRED)$/.test(failure.code)) code = ' (' + failure.code + ')';
    } catch { /* Non-JSON failures retain the safe status-only assertion. */ }
  }
  assert.equal(response.status, status, label + ' status' + code);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, label + ' content type');
  return response.json();
}

async function form(browser, path, returnTo = '/health') {
  const response = await browser.request(path + '?return_to=' + encodeURIComponent(returnTo));
  assert.equal(response.status, 200, 'Authentication form is available');
  assert.match(response.headers.get('cache-control') ?? '', /no-store/, 'Authentication form is not cached');
  const html = await response.text();
  if (path === '/signin-with-chatgpt') {
    assert.match(html, /<input(?=[^>]*name="email")(?=[^>]*type="email")[^>]*>/, 'Login uses an email input');
    assert.doesNotMatch(html, /name="username"/, 'Legacy username is not a login field');
  }
  const csrf = /name="csrf" value="([A-Za-z0-9_.-]+)"/.exec(html)?.[1];
  assert.ok(csrf, 'Authentication form includes a CSRF token');
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('jso-test-csrf='));
  assert.ok(cookie && /; HttpOnly;/.test(cookie) && /; SameSite=Lax;/.test(cookie), 'CSRF cookie attributes');
  return csrf;
}

async function login(browser, loginEmail = email, loginPassword = password, expectedStatus = 303) {
  const csrf = await form(browser, '/signin-with-chatgpt');
  const response = await browser.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health', email: loginEmail, password: loginPassword }),
  });
  assert.equal(response.status, expectedStatus, 'Email credentials return the expected authentication status');
  if (expectedStatus !== 303) return response;
  assert.equal(response.headers.get('location'), '/health', 'Login preserves an allowed return path');
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('jso-test-session='));
  assert.ok(cookie && /; HttpOnly;/.test(cookie) && /; SameSite=Lax;/.test(cookie), 'Session cookie attributes');
  assert.equal(Number(/;\s*Max-Age=(\d+)/i.exec(cookie)?.[1]), 30 * 86400, 'The default login is persistent for thirty days');
  return response;
}

async function persistentSessionAcceptance() {
  const config = loadSelfhostAuthConfig(childEnvironment), subject = { id: ownerId, revision: 1 };
  assert.equal(config.sessionTtl, 30 * 86400);
  const cookieName = 'jso-test-session';
  const sessionCookies = response => response.headers.getSetCookie().filter(cookie => cookie.startsWith(cookieName + '='));
  const maxAge = cookie => Number(/;\s*Max-Age=(\d+)/i.exec(cookie)?.[1]);
  const now = Date.now();
  const fresh = new Browser(); fresh.cookies.set(cookieName, issueSelfhostSession(config, subject, now));
  const freshRead = await fresh.request('/api/session');
  assert.equal((await json(freshRead, 200, 'Fresh persistent identity')).userId, ownerId);
  assert.equal(sessionCookies(freshRead).length, 0, 'A fresh login cookie is not rewritten on every API read');

  const legacy = new Browser();
  legacy.cookies.set(cookieName, issueSelfhostSession({ ...config, sessionTtl: 12 * 3600 }, subject, now));
  const legacyToken = legacy.cookies.get(cookieName);
  const readiness = await legacy.request('/_selfhost/healthz');
  assert.equal(readiness.status, 200);
  assert.equal(sessionCookies(readiness).length, 0, 'Readiness probes do not renew session cookies');
  const navigation = await legacy.request('/health');
  assert.equal(navigation.status, 200);
  const navigationHTML = await navigation.text();
  assert.ok(navigationHTML.includes('__JIASHU_PAGE_SESSION__'), 'Authenticated HTML includes its server-verified session bootstrap');
  assert.equal(sessionCookies(navigation).length, 1);
  assert.equal(maxAge(sessionCookies(navigation)[0]), config.sessionTtl, 'An existing twelve-hour login upgrades without another password entry');
  assert.ok(legacy.cookies.get(cookieName) !== legacyToken, 'Legacy session renewal emits a newly signed cookie');
  const nextRead = await legacy.request('/api/session');
  assert.equal(nextRead.status, 200); assert.equal(sessionCookies(nextRead).length, 0);

  const agedToken = issueSelfhostSession(config, subject, now - 2 * 86400000);
  const aged = new Browser(); aged.cookies.set(cookieName, agedToken);
  const agedRead = await aged.request('/api/session');
  assert.equal(agedRead.status, 200);
  assert.equal(maxAge(sessionCookies(agedRead)[0]), config.sessionTtl, 'Active use rolls an older valid session forward');
  aged.cookies.set(cookieName, agedToken);
  const administrative = await aged.request('/api/admin/users', { headers: { 'X-Page-Owner': ownerId } });
  assert.equal(administrative.status, 200);
  assert.ok(sessionCookies(administrative).some(cookie => maxAge(cookie) === config.sessionTtl));
  assert.ok(administrative.headers.getSetCookie().some(cookie => cookie.startsWith('jso-test-admin-csrf=')), 'Renewal preserves the administrative CSRF cookie');
  const renewalBeforeLogout = aged.cookies.get(cookieName);

  const expired = new Browser(); expired.cookies.set(cookieName, issueSelfhostSession({ ...config, sessionTtl: 12 * 3600 }, subject, now - 13 * 3600000));
  const expiredRead = await expired.request('/api/session');
  assert.equal(expiredRead.status, 401);
  assert.equal(sessionCookies(expiredRead).some(cookie => maxAge(cookie) > 0), false, 'Expired cookies never regain a valid session');

  const signingOut = new Browser(); signingOut.cookies.set(cookieName, agedToken);
  const csrf = await form(signingOut, '/signout-with-chatgpt');
  const loggedOut = await signingOut.request('/signout-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health' }),
  });
  assert.equal(loggedOut.status, 303);
  assert.equal(sessionCookies(loggedOut).length, 1);
  assert.equal(maxAge(sessionCookies(loggedOut)[0]), 0, 'Aging sessions log out without an accidental renewal cookie');
  assert.equal(signingOut.cookies.has(cookieName), false);
  for (const oldCookie of [agedToken, renewalBeforeLogout]) {
    const late = new Browser(); late.cookies.set(cookieName, oldCookie);
    const replay = await late.request('/api/session');
    assert.equal(replay.status, 401, 'A late pre-logout renewal cookie cannot restore the logged-out session family');
    assert.equal(sessionCookies(replay).some(cookie => maxAge(cookie) > 0), false);
  }
  return [agedToken, renewalBeforeLogout];
}


async function adminMetadata(browser) {
  const value = await json(await browser.request('/api/admin/users', { headers: { 'X-Page-Owner': ownerId } }), 200, 'Administrator account metadata');
  assert.equal(value.currentUserId, ownerId); assert.ok(Array.isArray(value.users));
  const fields = new Set(['id', 'email', 'status', 'revision', 'isAdmin', 'createdAt', 'updatedAt', 'lastLoginAt']);
  assert.ok(value.users.every(user => user && typeof user === 'object' && Object.keys(user).every(field => fields.has(field))), 'Account lists never disclose password hashes or private storage fields');
  assert.ok(typeof value.csrfToken === 'string' && value.csrfToken.length > 20);
  return value;
}

async function accountMutation(browser, path, method, body, expectedStatus = 200) {
  const metadata = await adminMetadata(browser); // Refresh the bound double-CSRF cookie before every mutation.
  return json(await browser.request(path, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Page-Owner': ownerId, 'X-CSRF-Token': metadata.csrfToken },
    body: JSON.stringify(body),
  }), expectedStatus, 'Administrator account mutation');
}

async function multiuserAcceptance() {
  const administrator = new Browser(); await login(administrator);
  const initial = await adminMetadata(administrator);
  assert.equal(initial.users.length, 1, 'The first empty database is seeded with only its configured administrator');
  assert.equal(initial.users[0].id, ownerId); assert.equal(initial.users[0].email, email); assert.equal(initial.users[0].isAdmin, true);

  const unauthenticated = new Browser();
  assert.equal((await unauthenticated.request('/api/admin/users', { headers: { 'X-Page-Owner': ownerId } })).status, 401);
  const noCsrf = await administrator.request('/api/admin/users', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Page-Owner': ownerId },
    body: JSON.stringify({ email: 'unwanted@example.test', password: randomBytes(24).toString('base64url') }),
  });
  assert.equal(noCsrf.status, 403, 'Account creation requires the bound administrator CSRF token');

  const memberPassword = randomBytes(24).toString('base64url');
  const created = await accountMutation(administrator, '/api/admin/users', 'POST', { email: '  Member@Example.Test  ', password: memberPassword }, 201);
  let member = created.user;
  assert.ok(typeof member.id === 'string' && member.id !== ownerId);
  assert.equal(member.email, 'member@example.test'); assert.equal(member.status, 'active'); assert.equal(member.isAdmin, false);
  assert.ok(Number.isSafeInteger(member.revision));
  const memberId = member.id, memberSession = new Browser();
  await login(memberSession, 'MEMBER@EXAMPLE.TEST', memberPassword);
  const identity = await json(await memberSession.request('/api/session'), 200, 'Normal email session');
  assert.equal(identity.userId, memberId); assert.equal(identity.email, member.email); assert.equal(identity.isOwner, false);
  assert.equal((await memberSession.request('/api/admin/users', { headers: { 'X-Page-Owner': memberId } })).status, 403, 'Normal users cannot manage accounts');
  const wrongScope = await json(await memberSession.request('/api/health/goals', { headers: { 'X-Page-Owner': ownerId } }), 401, 'A normal user cannot select the administrator data scope');
  assert.equal(wrongScope.code, 'ACCOUNT_CHANGED');
  const memberHeaders = { Origin: origin, 'Content-Type': 'application/json', 'X-Page-Owner': memberId };
  const freshGoals = await json(await memberSession.request('/api/health/goals', { headers: memberHeaders }), 200, 'Isolated normal-user goals');
  assert.equal(freshGoals.revision, 0);
  const memberTargets = { steps: 4321, sleep: 7, active_energy: 350 };
  await json(await memberSession.request('/api/health/goals', {
    method: 'PUT', headers: memberHeaders, body: JSON.stringify({ targets: memberTargets, expectedRevision: 0, effectiveFrom: date }),
  }), 200, 'Normal-user independent goal persistence');
  const rootGoals = await json(await administrator.request('/api/health/goals', { headers: { 'X-Page-Owner': ownerId } }), 200, 'Administrator goal isolation');
  assert.equal(rootGoals.targets.steps, 8000, 'Normal-user writes preserve the administrator goals');
  const memberNutrition = await json(await memberSession.request('/api/health/nutrition?date=' + date, { headers: { 'X-Page-Owner': memberId } }), 200, 'Normal-user nutrition isolation');
  assert.equal(memberNutrition.entries.length, 0, 'Administrator nutrition is not visible in a normal account');

  const renamed = await accountMutation(administrator, '/api/admin/users/' + encodeURIComponent(memberId), 'PATCH', { expectedRevision: member.revision, email: 'renamed@example.test' });
  member = renamed.user; assert.equal(member.id, memberId); assert.equal(member.email, 'renamed@example.test');
  assert.equal((await memberSession.request('/api/session')).status, 401, 'An email change immediately revokes previous sessions');
  await login(new Browser(), 'member@example.test', memberPassword, 401);
  const renamedSession = new Browser(); await login(renamedSession, member.email, memberPassword);
  assert.equal((await json(await renamedSession.request('/api/session'), 200, 'Renamed account identity')).userId, memberId);
  assert.equal((await json(await renamedSession.request('/api/health/goals', { headers: { 'X-Page-Owner': memberId } }), 200, 'Stable renamed account data')).targets.steps, memberTargets.steps);

  member = (await accountMutation(administrator, '/api/admin/users/' + encodeURIComponent(memberId), 'PATCH', { expectedRevision: member.revision, status: 'disabled' })).user;
  assert.equal(member.status, 'disabled');
  assert.equal((await renamedSession.request('/api/session')).status, 401, 'Disabling an account revokes its existing session immediately');
  await login(new Browser(), member.email, memberPassword, 401);
  member = (await accountMutation(administrator, '/api/admin/users/' + encodeURIComponent(memberId), 'PATCH', { expectedRevision: member.revision, status: 'active' })).user;
  const beforeReset = new Browser(), secondOldSession = new Browser();
  await login(beforeReset, member.email, memberPassword); await login(secondOldSession, member.email, memberPassword);
  const resetPassword = randomBytes(24).toString('base64url');
  member = (await accountMutation(administrator, '/api/admin/users/' + encodeURIComponent(memberId), 'PATCH', { expectedRevision: member.revision, password: resetPassword })).user;
  assert.equal((await beforeReset.request('/api/session')).status, 401, 'Password resets revoke the first old cookie');
  assert.equal((await secondOldSession.request('/api/session')).status, 401, 'Password resets revoke every old cookie');
  await login(new Browser(), member.email, memberPassword, 401);
  const resetSession = new Browser(); await login(resetSession, member.email, resetPassword);

  await stop(); migrate(); await start();
  const stored = (await adminMetadata(administrator)).users.find(user => user.id === memberId);
  assert.ok(stored); assert.equal(stored.email, member.email); assert.equal(stored.status, 'active'); assert.equal(stored.revision, member.revision);
  assert.equal((await json(await resetSession.request('/api/session'), 200, 'Restarted account session')).userId, memberId);
  assert.equal((await json(await resetSession.request('/api/health/goals', { headers: { 'X-Page-Owner': memberId } }), 200, 'Restarted normal-user data')).targets.steps, memberTargets.steps);
  const stillRoot = await json(await administrator.request('/api/health/goals', { headers: { 'X-Page-Owner': ownerId } }), 200, 'Restarted administrator data');
  assert.equal(stillRoot.targets.steps, 8000);
  await login(new Browser(), member.email, resetPassword); // Database credentials survive restart and are not reseeded from env.

  const rootAccount = (await adminMetadata(administrator)).users.find(user => user.id === ownerId);
  const changedRootEmail = 'changed-administrator@example.test';
  const rootChange = await accountMutation(administrator, '/api/admin/users/' + encodeURIComponent(ownerId), 'PATCH', { expectedRevision: rootAccount.revision, email: changedRootEmail });
  assert.equal(rootChange.user.id, ownerId); assert.equal(rootChange.user.isAdmin, true); assert.equal(rootChange.reauthRequired, true);
  assert.equal((await administrator.request('/api/session')).status, 401, 'Administrator email edits revoke its old session too');
  await login(new Browser(), email, password, 401);
  const changedRootSession = new Browser(); await login(changedRootSession, changedRootEmail, password);
  await stop(); migrate(); await start(); // APP_OWNER_EMAIL deliberately still has the original bootstrap email.
  const changedRootIdentity = await json(await changedRootSession.request('/api/session'), 200, 'Persisted administrator email');
  assert.equal(changedRootIdentity.userId, ownerId); assert.equal(changedRootIdentity.email, changedRootEmail); assert.equal(changedRootIdentity.isOwner, true);
  assert.equal((await json(await changedRootSession.request('/api/health/goals', { headers: { 'X-Page-Owner': ownerId } }), 200, 'Stable administrator data after email change')).targets.steps, 8000);
  await login(new Browser(), email, password, 401);
  await login(new Browser(), changedRootEmail, password);
}

async function nativeAcceptance(browser) {
  // Use a separate synthetic day so the existing browser persistence assertions
  // continue exercising their unchanged fixtures and expected row counts.
  const nativeDate = '2026-01-02';
  const request = (path, token, options = {}) => fetch(origin + '/api/native' + path, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers },
  });
  const write = (path, token, body, headers = {}, method = 'POST') => request(path, token, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  await json(await request('/overview'), 401, 'Anonymous native overview');
  const loginResponse = await write('/auth/login', null, { email, password });
  const session = await json(loginResponse, 200, 'Native JSON login');
  assert.equal(loginResponse.headers.getSetCookie().length, 0, 'Native login never establishes a browser session');
  assert.deepEqual(session.user, { id: ownerId, email });
  assert.ok(typeof session.accessToken === 'string' && Number.isFinite(Date.parse(session.expiresAt)));
  const token = session.accessToken;
  const overviewResponse = await request('/overview', token);
  assert.equal(overviewResponse.headers.get('x-account-owner'), ownerId, 'Native identity reaches the real application middleware');
  const overview = await json(overviewResponse, 200, 'Native overview through the production bundle');
  assert.equal(overview.health.status, 'ready');
  assert.equal(overview.modules.health.status, 'ready');
  await json(await fetch(origin + '/api/health', { headers: { Authorization: 'Bearer ' + token }, redirect: 'manual', signal: AbortSignal.timeout(10000) }), 401, 'Native token does not authenticate browser APIs');
  await json(await request('/overview', token, { headers: { Origin: origin } }), 403, 'Native browser-origin rejection');

  const payload = {
    version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: '2026-01-03T01:00:00Z',
    measurements: [
      { id: 'native-smoke-steps', metric: 'steps', value: 6543, unit: 'count', startDate: nativeDate + 'T00:00:00+08:00', endDate: '2026-01-03T00:00:00+08:00', source: 'apple-health-merged', aggregation: 'daily' },
      { id: 'native-smoke-energy', metric: 'active_energy', value: 456.7, unit: 'kcal', startDate: nativeDate + 'T00:00:00+08:00', endDate: '2026-01-03T00:00:00+08:00', source: 'apple-health-merged', aggregation: 'daily' },
      { id: 'native-smoke-sleep', metric: 'sleep', value: 7.5, unit: 'hours', startDate: '2026-01-01T22:30:00+08:00', endDate: nativeDate + 'T06:00:00+08:00', source: 'native-synthetic-watch', aggregation: 'daily',
        sleepStages: { unspecified: 0.5, core: 4, deep: 1, rem: 2, awake: 0, inBed: 0 },
        sleepTiming: { onset: '2026-01-01T22:30:00+08:00', wake: nativeDate + 'T06:00:00+08:00', clipped: false, method: 'longest-sleep-group-v1' } },
      { id: 'native-smoke/weight', metric: 'weight', value: 73.4, unit: 'kg', startDate: nativeDate + 'T08:00:00+08:00', source: 'native-synthetic-scale', aggregation: 'sample' },
      { id: 'native-smoke-lean', metric: 'lean_body_mass', value: 54.3, unit: 'kg', startDate: nativeDate + 'T08:00:00+08:00', source: 'native-synthetic-scale', aggregation: 'sample' },
    ],
  };
  const preview = (await json(await write('/health/import/preview', token, payload), 200, 'Native five-metric import preview')).preview;
  assert.equal(preview.total, 5); assert.equal(preview.added, 5); assert.equal(preview.sourceChanges, 0);
  assert.equal(preview.sourceChangesAuthorized, false, 'Ordinary imports do not inherit automatic channel consent.');
  assert.match(preview.token, /^[a-f0-9]{64}$/);
  const receipt = await json(await write('/health/import', token, payload, { 'X-Import-Preview': preview.token }), 200, 'Native five-metric import');
  assert.equal(receipt.ok, true); assert.equal(receipt.imported, 5);
  const replay = await json(await write('/health/import', token, payload, { 'X-Import-Preview': preview.token }), 200, 'Native deterministic import retry');
  assert.equal(replay.replayed, true); assert.equal(replay.batchId, receipt.batchId);
  const health = await json(await request('/health?from=' + nativeDate + '&to=' + nativeDate, token), 200, 'Native stored health range');
  assert.equal(health.measurements.length, 5, 'A retried import creates no duplicate measurements');
  for (const [metric, value] of [['steps', 6543], ['active_energy', 456.7], ['sleep', 7.5], ['weight', 73.4], ['lean_body_mass', 54.3]]) {
    assert.equal(health.measurements.find(row => row.metric === metric)?.value, value, 'Stored native metric ' + metric);
  }
  assert.equal(health.summary.metrics.sleep.points[0].value, 7.5);
  const changedSource = { ...payload, exportedAt: '2026-01-04T01:00:00Z', measurements: payload.measurements.map(row => row.metric === 'steps' ? { ...row, source: 'native-confirmed-alternative', value: 6888 } : row) };
  const changedPreview = (await json(await write('/health/import/preview', token, changedSource), 200, 'Native source-change preview')).preview;
  assert.equal(changedPreview.sourceChanges, 1);
  const missingConfirmation = await json(await write('/health/import', token, changedSource, { 'X-Import-Preview': changedPreview.token }), 409, 'Native source change needs explicit confirmation');
  assert.equal(missingConfirmation.code, 'HEALTH_IMPORT_SOURCE_CONFIRMATION');
  const confirmed = await json(await write('/health/import', token, changedSource, { 'X-Import-Preview': changedPreview.token, 'X-Confirm-Source-Changes': 'true' }), 200, 'Native explicitly confirmed source change');
  assert.equal(confirmed.imported, 1);

  const emptyChannel = await json(await request('/sync/channel', token), 200, 'Native initial daily channel');
  assert.equal(emptyChannel.revision, 0); assert.equal(emptyChannel.deviceId, null); assert.equal(emptyChannel.isCurrentDevice, false);
  const deviceToken = 'jso_sync_' + randomBytes(32).toString('base64url');
  const consent = { deviceToken, label: 'Synthetic daily iPhone', expectedRevision: emptyChannel.revision };
  const forgedConsent = await browser.request('/api/sync/channel', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Page-Owner': ownerId, 'X-Jso-Native-Client': 'healthkit-v1' },
    body: JSON.stringify(consent),
  });
  await json(forgedConsent, 403, 'Browser cannot spoof native daily-channel consent');
  const selected = await json(await write('/sync/channel', token, consent, {}, 'PUT'), 200, 'Native explicit daily-channel consent');
  assert.equal(selected.revision, 1); assert.equal(selected.isCurrentDevice, true); assert.ok(selected.deviceId);
  assert.equal((await json(await write('/sync/channel', token, consent, {}, 'PUT'), 200, 'Native consent lost-response retry')).revision, 1);
  assert.equal((await json(await request('/sync/channel', token), 200, 'Channel without local credential')).isCurrentDevice, false);
  const channelHeaders = { 'X-Sync-Device': deviceToken };
  assert.equal((await json(await request('/sync/channel', token, { headers: channelHeaders }), 200, 'Current local channel credential')).isCurrentDevice, true);
  const shortcut = await json(await browser.request('/api/sync/devices', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Page-Owner': ownerId },
    body: JSON.stringify({ label: 'Synthetic older shortcut' }),
  }), 201, 'Independent old shortcut remains a valid connection');
  const blockedShortcut = await json(await write('/health/import/preview', token, changedSource, { 'X-Sync-Device': shortcut.deviceToken }), 409, 'Old shortcut cannot preview through the selected native channel');
  assert.equal(blockedShortcut.code, 'HEALTH_SYNC_CHANNEL_REQUIRED');
  assert.equal((await json(await write('/health/import', token, changedSource, {
    'X-Sync-Device': shortcut.deviceToken, 'X-Confirm-Source-Changes': 'true',
  }), 409, 'An old shortcut cannot override channel selection by confirming a physical source change')).code, 'HEALTH_SYNC_CHANNEL_REQUIRED');
  const blockedManual = await json(await write('/health/import', token, changedSource, { 'X-Confirm-Source-Changes': 'true' }), 409, 'Explicit per-batch source confirmation cannot bypass the selected channel');
  assert.equal(blockedManual.code, 'HEALTH_SYNC_CHANNEL_REQUIRED');

  const sourceSnapshot = (exportedAt, suffix, stepValue) => ({ ...payload, exportedAt,
    measurements: payload.measurements.map(row => ({ ...row, source: 'native-daily-' + suffix + '-' + row.metric,
      ...(row.metric === 'steps' ? { value: stepValue } : {}) })),
  });
  const dailyFirst = sourceSnapshot('2026-01-05T01:00:00Z', 'first', 7001);
  const firstDailyPreview = (await json(await write('/health/import/preview', token, dailyFirst, channelHeaders), 200, 'Selected channel previews changed physical sources')).preview;
  assert.ok(firstDailyPreview.sourceChanges > 0);
  assert.equal(firstDailyPreview.sourceChangesAuthorized, true);
  assert.equal((await json(await write('/health/import', token, dailyFirst, { ...channelHeaders, 'X-Import-Preview': firstDailyPreview.token }), 200, 'Selected daily channel automatically accepts its physical source changes')).ok, true);

  const stepRecords = await json(await browser.request('/api/health/records?from=' + nativeDate + '&to=' + nativeDate + '&metric=steps'), 200, 'Current imported step record for manual correction');
  const stepRecord = stepRecords.records.find(row => row.recordKey === 'steps:' + nativeDate);
  assert.ok(stepRecord?.base);
  const correctedStep = await json(await browser.request('/api/health/records/' + encodeURIComponent(stepRecord.recordKey), {
    method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Page-Owner': ownerId, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ action: 'correct', value: 7777, expectedRevision: stepRecord.revision,
      expectedBaseExportedAt: stepRecord.base.exportedAt, reason: 'Synthetic correction must survive automatic channel imports' }),
  }), 200, 'Manual step correction before daily resync');
  assert.equal(correctedStep.record.effective.value, 7777);
  const dailySecond = sourceSnapshot('2026-01-06T01:00:00Z', 'second', 8888);
  const secondDailyPreview = (await json(await write('/health/import/preview', token, dailySecond, channelHeaders), 200, 'Selected channel previews another physical source change')).preview;
  assert.ok(secondDailyPreview.sourceChanges > 0); assert.ok(secondDailyPreview.manualOverrides > 0);
  assert.equal(secondDailyPreview.sourceChangesAuthorized, true);
  await json(await write('/health/import', token, dailySecond, { ...channelHeaders, 'X-Import-Preview': secondDailyPreview.token }), 200, 'Repeated physical source change needs no repeated consent');
  const correctedHealth = await json(await request('/health?from=' + nativeDate + '&to=' + nativeDate, token), 200, 'Daily sync keeps manual overlays');
  assert.equal(correctedHealth.summary.metrics.steps.points[0].value, 7777);

  const inFlight = sourceSnapshot('2026-01-07T01:00:00Z', 'before-takeover', 9000);
  const inFlightPreview = (await json(await write('/health/import/preview', token, inFlight, channelHeaders), 200, 'Preview obtained before explicit device takeover')).preview;
  const replacementToken = 'jso_sync_' + randomBytes(32).toString('base64url');
  const staleConsent = await json(await write('/sync/channel', token, { deviceToken: replacementToken, label: 'Replacement iPhone', expectedRevision: 0 }, {}, 'PUT'), 409, 'Device takeover rejects stale observed revision');
  assert.equal(staleConsent.code, 'NATIVE_HEALTH_CHANNEL_STALE');
  const replacement = await json(await write('/sync/channel', token, { deviceToken: replacementToken, label: 'Replacement iPhone', expectedRevision: selected.revision }, {}, 'PUT'), 200, 'Explicit replacement-device takeover');
  assert.equal(replacement.revision, 2); assert.notEqual(replacement.deviceId, selected.deviceId);
  const oldInFlight = await json(await write('/health/import', token, inFlight, { ...channelHeaders, 'X-Import-Preview': inFlightPreview.token, 'X-Confirm-Source-Changes': 'true' }), 403, 'Revoked former daily device cannot finish an in-flight import');
  assert.equal(oldInFlight.code, 'SYNC_DEVICE_INVALID');
  const wrongRelease = await json(await write('/sync/channel', token, { expectedRevision: replacement.revision }, { 'X-Sync-Device': shortcut.deviceToken }, 'DELETE'), 409, 'An independent connection cannot clear the selected channel');
  assert.equal(wrongRelease.code, 'NATIVE_HEALTH_CHANNEL_NOT_CURRENT');
  const replacementHeaders = { 'X-Sync-Device': replacementToken };
  const cleared = await json(await write('/sync/channel', token, { expectedRevision: replacement.revision }, replacementHeaders, 'DELETE'), 200, 'Current daily device can release its channel');
  assert.equal(cleared.deviceId, null); assert.equal(cleared.revision, 3);
  assert.equal((await json(await write('/sync/channel', token, { expectedRevision: replacement.revision }, replacementHeaders, 'DELETE'), 200, 'Daily-channel release lost-response retry')).revision, 3);
  const finalToken = 'jso_sync_' + randomBytes(32).toString('base64url');
  const finalChannel = await json(await write('/sync/channel', token, { deviceToken: finalToken, label: 'Persistent daily iPhone', expectedRevision: cleared.revision }, {}, 'PUT'), 200, 'A newly consented connection replaces the released device');
  assert.equal(finalChannel.revision, 4);

  const recordId = randomUUID(), recordInput = { metric: 'weight', value: 72.9, date: nativeDate, time: '09:00', capturedAt: new Date().toISOString(), reason: 'Synthetic native manual record' };
  const record = await json(await write('/health/records', token, recordInput, { 'Idempotency-Key': recordId }), 201, 'Native manual weight persistence');
  assert.equal(record.replayed, false); assert.equal(record.record.effective.value, 72.9);
  const recordRetry = await json(await write('/health/records', token, recordInput, { 'Idempotency-Key': recordId }), 201, 'Native manual record retry');
  assert.equal(recordRetry.replayed, true); assert.equal(recordRetry.record.recordKey, record.record.recordKey);
  const records = await json(await request('/health/records?from=' + nativeDate + '&to=' + nativeDate + '&metric=weight', token), 200, 'Native manual records read');
  assert.equal(records.records.filter(row => row.manual).length, 1);

  const foodId = randomUUID(), food = { date: nativeDate, meal: 'lunch', name: 'Native smoke fixture', portion: '1份', calories: '345.6', carbs: '40', protein: '20', fat: '10', note: '' };
  const nutrition = await json(await write('/health/nutrition', token, food, { 'Idempotency-Key': foodId }), 201, 'Native nutrition persistence');
  assert.equal(nutrition.entry.name, food.name); assert.equal(nutrition.replayed, false);
  const nutritionRetry = await json(await write('/health/nutrition', token, food, { 'Idempotency-Key': foodId }), 201, 'Native nutrition retry');
  assert.equal(nutritionRetry.replayed, true); assert.equal(nutritionRetry.entry.id, nutrition.entry.id);
  const foods = await json(await request('/health/nutrition?date=' + nativeDate, token), 200, 'Native nutrition read');
  assert.equal(foods.entries.length, 1); assert.equal(foods.entries[0].id, nutrition.entry.id);
  const browserFoods = await json(await browser.request('/api/health/nutrition?date=' + nativeDate), 200, 'Native and browser share the existing account');
  assert.equal(browserFoods.entries[0].id, nutrition.entry.id);

  await nativeWorkspaceAcceptance(request, write, token, nativeDate, nutrition.entry.id);

  const refreshed = await json(await request('/auth/refresh', token, { method: 'POST' }), 200, 'Native session refresh');
  assert.deepEqual(refreshed.user, session.user);
  await json(await request('/auth/logout', token, { method: 'POST' }), 200, 'Native durable logout');
  for (const prior of [token, refreshed.accessToken]) {
    await json(await request('/overview', prior), 401, 'Native logout rejects original and refreshed tokens');
    await json(await request('/auth/refresh', prior, { method: 'POST' }), 401, 'Native logged-out refresh stays rejected');
  }
  assert.equal((await browser.request('/api/session')).status, 200, 'Native logout preserves the independent browser session');
  return [token, refreshed.accessToken];
}

async function nativeWorkspaceAcceptance(request, write, token, nativeDate, nutritionId) {
  const identity = await json(await request('/session', token), 200, 'Full native current-account identity');
  assert.equal(identity.userId, ownerId); assert.equal(identity.isOwner, true);
  const users = await json(await request('/admin/users', token), 200, 'Native administrator user management');
  assert.equal(users.currentUserId, ownerId); assert.ok(Array.isArray(users.users)); assert.equal(users.csrfToken, undefined);
  const notifications = await json(await request('/notifications', token), 200, 'Native notifications');
  assert.ok(Number.isInteger(notifications.unreadCount));
  const sync = await json(await request('/sync/devices', token), 200, 'Native sync devices');
  assert.ok(Array.isArray(sync.devices));
  await json(await request('/sync/status', token), 200, 'Native sync diagnostics');
  const ai = await json(await request('/ai/settings', token), 200, 'Native AI service configuration');
  assert.equal(ai.canManage, true); assert.equal(ai.settings.configured, false);
  const media = await json(await request('/media/tmdb/settings', token), 200, 'Native media service configuration');
  assert.equal(media.canManage, true);
  const foods = await json(await request('/health/foods?limit=2', token), 200, 'Native unified food library');
  assert.ok(Array.isArray(foods.foods));
  await json(await request('/health/nutrition/reuse', token), 200, 'Native nutrition reuse');
  const nutritionHistory = await json(await request('/health/nutrition/' + encodeURIComponent(nutritionId) + '/history', token), 200, 'Native nutrition record history');
  assert.ok(nutritionHistory);
  const nativeRecords = await json(await request('/health/records?from=' + nativeDate + '&to=' + nativeDate, token), 200, 'Native health record workspace');
  const recordKey = (nativeRecords.records.find(row => row.recordKey.includes('/')) ?? nativeRecords.records[0]).recordKey;
  const detail = await json(await request('/health/records/' + encodeURIComponent(recordKey), token), 200, 'Native encoded health resource detail');
  assert.equal(detail.record.recordKey, recordKey);
  await json(await request('/health/records/' + encodeURIComponent(recordKey) + '/history', token), 200, 'Native health resource history');

  const operation = randomUUID();
  const account = await json(await write('/finance/accounts', token, {
    ledger: 'personal', name: 'Native synthetic account', type: 'bank', currency: 'CNY', amount: '90071992547409.93', asOfDate: nativeDate, note: '',
  }, { 'Idempotency-Key': operation }), 201, 'Native finance account create');
  assert.equal(account.account.balanceMinor, '9007199254740993', 'Native finance preserves exact integer money strings');
  const id = encodeURIComponent(account.account.id);
  const details = await json(await request('/finance/accounts/' + id + '?ledger=personal', token), 200, 'Native finance dynamic account detail');
  assert.equal(details.account.id, account.account.id);
  const updated = await json(await write('/finance/accounts/' + id, token, { name: 'Native account updated', expectedRevision: details.account.metadataRevision }, {}, 'PATCH'), 200, 'Native finance metadata revision');
  assert.equal(updated.account.name, 'Native account updated');
  const balance = await json(await write('/finance/accounts/' + id + '/balances', token, { amount: '90071992547409.94', asOfDate: nativeDate, note: 'synthetic balance' }, { 'Idempotency-Key': randomUUID() }), 201, 'Native balance append');
  assert.equal(balance.account.balanceMinor, '9007199254740994');
  const overview = await json(await request('/finance?ledger=personal', token), 200, 'Native finance overview');
  assert.ok(overview.accounts.some(row => row.id === account.account.id));
  await json(await request('/finance/books', token), 200, 'Native family book selector');
  await json(await request('/finance/books/own/members', token), 200, 'Native family members');
  await json(await request('/finance/goals?ledger=personal', token), 200, 'Native finance goals');
  await json(await request('/finance/runway?ledger=personal&currency=CNY', token), 200, 'Native emergency fund');
  const review = await json(await request('/finance/review?ledger=personal&currency=CNY&month=2026-01', token), 200, 'Native finance monthly review');
  assert.ok(typeof review.close.previewHash === 'string');
  const closed = await json(await write('/finance/review/close', token, { ledger: 'personal', currency: 'CNY', month: '2026-01',
    expectedVersion: 0, previewHash: review.close.previewHash, reason: 'Native synthetic close' }, { 'Idempotency-Key': randomUUID() }), 201, 'Native finance close with exact report preview');
  assert.equal(closed.version, 1);
  const financeExport = await request('/finance/export?ledger=personal', token);
  assert.match(financeExport.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal((await json(financeExport, 200, 'Native finance export')).accounts.length, 1);

  const connection = await json(await write('/life/douban/connection', token, { profile: 'native-smoke', expectedRevision: 0 }, {}, 'PUT'), 200, 'Native media source configuration');
  assert.equal(connection.connection.profileId, 'native-smoke');
  const item = { domain: 'book', subjectId: '1234567', title: 'Native synthetic book', url: 'https://book.douban.com/subject/1234567/',
    kind: 'book', coverUrl: null, rating: 4, markedDate: nativeDate, comment: 'Synthetic completed reading', publishedAt: null, source: 'import' };
  const preview = await json(await write('/life/douban/import', token, { action: 'preview', profile: 'native-smoke', items: [item] }), 200, 'Native media import preview');
  const imported = await json(await write('/life/douban/import', token, { action: 'commit', profile: 'native-smoke', items: [item],
    expectedSnapshotHash: preview.preview.snapshotHash, expectedDataEpoch: preview.preview.dataEpoch, requestId: randomUUID(), confirmed: true }), 200, 'Native explicitly confirmed media import');
  assert.equal(imported.receipt.added, 1);
  const library = await json(await request('/life/douban?kind=book', token), 200, 'Native media library');
  assert.equal(library.items[0].title, item.title);
  const saved = await json(await write('/life/douban/library', token, { profileId: 'native-smoke', domain: 'book', subjectId: item.subjectId,
    expectedDataEpoch: library.dataEpoch, expectedLocalRevision: library.items[0].local.revision, note: 'Native personal note', tags: ['synthetic'], hidden: false }, {}, 'PUT'), 200, 'Native media local organization');
  assert.equal(saved.item.local.note, 'Native personal note');

  const backupResponse = await request('/data/backup', token);
  assert.match(backupResponse.headers.get('content-disposition') ?? '', /attachment/);
  const backup = await json(backupResponse, 200, 'Native complete backup download');
  assert.equal(backup.version, 2);
  const restorePreview = await json(await write('/data/backup', token, { action: 'preview', backup }), 200, 'Native complete backup restore preview');
  assert.equal(restorePreview.total.conflicts, 0);
  const restored = await json(await write('/data/backup', token, { action: 'restore', backup, previewHash: restorePreview.previewHash }), 200, 'Native explicitly confirmed backup restore');
  assert.equal(restored.added, 0);
}

async function main() {
  migrate();
  await start();
  const anonymous = new Browser(), authenticated = new Browser();
  const health = await json(await anonymous.request('/_selfhost/healthz'), 200, 'Readiness');
  assert.equal(health.ok, true); assert.equal(health.commitSha, commitSha);
  assert.equal(health.schema.schemaReady, true); assert.equal(health.schema.pending, 0);
  assert.ok(health.schema.applied > 0 && health.schema.applied === health.schema.total, 'All schema migrations are applied');
  await json(await anonymous.request('/api/session'), 401, 'Anonymous session');
  await json(await anonymous.request('/api/session', { headers: {
    'oai-authenticated-user-id': ownerId, 'oai-authenticated-user-email': 'smoke@example.test',
    'x-authenticated-user-id': ownerId, 'x-forwarded-host': 'attacker.example',
  } }), 401, 'Client-supplied identity headers');
  await json(await anonymous.request('/api/health/goals'), 401, 'Anonymous business data');

  let csrf = await form(anonymous, '/signin-with-chatgpt');
  const legacyLogin = await anonymous.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health', username: 'legacy-smoke-admin', password }),
  });
  assert.equal(legacyLogin.status, 403, 'Legacy username fields cannot authenticate the seeded email account');
  await json(await anonymous.request('/api/session'), 401, 'Legacy username grants no session');
  csrf = await form(anonymous, '/signin-with-chatgpt');
  let response = await anonymous.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health', email, password }),
  });
  assert.equal(response.status, 403, 'Cross-origin login is rejected');
  response = await anonymous.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'invalid', return_to: '/health', email, password }),
  });
  assert.equal(response.status, 403, 'Invalid login CSRF is rejected');
  response = await anonymous.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health', email, password: randomBytes(24).toString('base64url') }),
  });
  assert.equal(response.status, 401, 'Incorrect password is rejected');
  await json(await anonymous.request('/api/session'), 401, 'Incorrect password grants no session');

  await login(authenticated);
  const revokedPersistentSessions = await persistentSessionAcceptance();
  const session = await json(await authenticated.request('/api/session'), 200, 'Authenticated session');
  assert.equal(session.userId, ownerId); assert.equal(session.isOwner, true);
  const page = await authenticated.request('/health');
  assert.equal(page.status, 200, 'Production health page renders');
  assert.match(await page.text(), /<!doctype html>/i, 'Production HTML is returned');

  const foodCatalog = await json(await authenticated.request('/api/health/nutrition/foods?limit=2'), 200, 'Bundled food catalog');
  assert.equal(foodCatalog.foods.length, 2); assert.ok(foodCatalog.total >= 2);
  assert.ok(Array.isArray(foodCatalog.sources) && foodCatalog.sources.length >= 2, 'Bundled food source metadata is available');
  const initialGoals = await json(await authenticated.request('/api/health/goals'), 200, 'Initial goal settings');
  assert.equal(initialGoals.revision, 0, 'Fresh test database has no goal history');
  const targets = { steps: 8000, sleep: 8, active_energy: 500 };
  const writes = { Origin: origin, 'Content-Type': 'application/json', 'X-Page-Owner': ownerId };
  response = await authenticated.request('/api/health/goals', {
    method: 'PUT', headers: { ...writes, Origin: 'https://attacker.example' },
    body: JSON.stringify({ targets, expectedRevision: 0, effectiveFrom: date }),
  });
  assert.equal(response.status, 403, 'Cross-origin business mutation is rejected');
  const savedGoals = await json(await authenticated.request('/api/health/goals', {
    method: 'PUT', headers: writes, body: JSON.stringify({ targets, expectedRevision: 0, effectiveFrom: date }),
  }), 200, 'Goal persistence');
  assert.deepEqual(savedGoals.targets, targets); assert.equal(savedGoals.revision, 1);

  const entryInput = { date, meal: 'breakfast', name: 'Standalone smoke fixture', portion: '1份', calories: '123.4', carbs: '12.3', protein: '4.5', fat: '6.7', note: '' };
  const entryHeaders = { ...writes, 'Idempotency-Key': randomUUID() };
  const created = await json(await authenticated.request('/api/health/nutrition', {
    method: 'POST', headers: entryHeaders, body: JSON.stringify(entryInput),
  }), 201, 'Nutrition persistence');
  assert.equal(created.replayed, false); assert.equal(created.entry.name, entryInput.name); assert.equal(created.entry.calories, '123.4');
  const replayed = await json(await authenticated.request('/api/health/nutrition', {
    method: 'POST', headers: entryHeaders, body: JSON.stringify(entryInput),
  }), 201, 'Nutrition idempotency');
  assert.equal(replayed.replayed, true); assert.equal(replayed.entry.id, created.entry.id);

  const revokedNativeSessions = await nativeAcceptance(authenticated);
  const channelBeforeRestart = await json(await authenticated.request('/api/sync/channel'), 200, 'Browser reads persistent channel status without selection authority');
  assert.equal(channelBeforeRestart.revision, 4); assert.equal(channelBeforeRestart.label, 'Persistent daily iPhone');
  assert.equal(channelBeforeRestart.isCurrentDevice, false);

  await stop();
  migrate(); // Existing migration ledger is safe to re-check on every deployment.
  await start();
  assert.deepEqual(await json(await authenticated.request('/api/sync/channel'), 200, 'Daily channel survives a process and database restart'), channelBeforeRestart);
  for (const oldCookie of revokedPersistentSessions) {
    const replay = new Browser(); replay.cookies.set('jso-test-session', oldCookie);
    assert.equal((await replay.request('/api/session')).status, 401, 'Logout remains revoked after the production server and database restart');
  }
  for (const token of revokedNativeSessions) {
    await json(await fetch(origin + '/api/native/overview', { headers: { Authorization: 'Bearer ' + token }, redirect: 'manual', signal: AbortSignal.timeout(10000) }), 401, 'Native logout survives the production server and database restart');
  }
  const persistedGoals = await json(await authenticated.request('/api/health/goals'), 200, 'Restarted goal persistence');
  assert.deepEqual(persistedGoals.targets, targets); assert.equal(persistedGoals.revision, 1);
  const nutrition = await json(await authenticated.request('/api/health/nutrition?date=' + date), 200, 'Restarted nutrition persistence');
  assert.equal(nutrition.entries.length, 1); assert.equal(nutrition.entries[0].id, created.entry.id);

  csrf = await form(authenticated, '/signout-with-chatgpt');
  response = await authenticated.request('/signout-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health' }),
  });
  assert.equal(response.status, 303, 'Logout succeeds');
  assert.equal(authenticated.cookies.has('jso-test-session'), false, 'Logout clears the session cookie');
  await json(await authenticated.request('/api/session'), 401, 'Logged out session');
  await json(await authenticated.request('/api/health/goals'), 401, 'Logged out business data');
  await multiuserAcceptance();
  process.stdout.write('Self-hosted production smoke passed: migrations, persistent rolling authentication, SSR identity bootstrap, CSRF, identity isolation, food catalog, persistent goals/nutrition, idempotency, restart, logout, administrator-only accounts, email login, native bearer login/overview/five-metric import/source confirmation/manual records/nutrition, persistent daily HealthKit channel consent/source changes/takeover/manual overlays, and durable independent session revocation.\n');
}

try { await main(); }
finally { await stop(); rmSync(temporary, { recursive: true, force: true }); }
