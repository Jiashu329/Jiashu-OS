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
  assert.equal(response.status, status, label + ' status');
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

  await stop();
  migrate(); // Existing migration ledger is safe to re-check on every deployment.
  await start();
  for (const oldCookie of revokedPersistentSessions) {
    const replay = new Browser(); replay.cookies.set('jso-test-session', oldCookie);
    assert.equal((await replay.request('/api/session')).status, 401, 'Logout remains revoked after the production server and database restart');
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
  process.stdout.write('Self-hosted production smoke passed: migrations, persistent rolling authentication, SSR identity bootstrap, CSRF, identity isolation, food catalog, persistent goals/nutrition, idempotency, restart, logout, administrator-only accounts, email login, isolation and immediate session revocation.\n');
}

try { await main(); }
finally { await stop(); rmSync(temporary, { recursive: true, force: true }); }
