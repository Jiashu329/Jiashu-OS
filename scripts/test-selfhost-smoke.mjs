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
const { hashPassword } = await import(pathToFileURL(join(app, 'selfhost/auth.ts')).href);
const temporary = mkdtempSync(join(tmpdir(), 'jiashu-selfhost-smoke-'));
const database = join(temporary, 'smoke.sqlite3');
const password = randomBytes(24).toString('base64url');
const ownerId = 'selfhost-smoke-owner', username = 'smoke-admin';
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
  SELFHOST_USERNAME: username, SELFHOST_PASSWORD_HASH: await hashPassword(password),
  SELFHOST_SESSION_SECRET: randomBytes(32).toString('base64url'),
  APP_OWNER_USER_ID: ownerId, APP_OWNER_EMAIL: 'smoke@example.test',
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
  const csrf = /name="csrf" value="([A-Za-z0-9_.-]+)"/.exec(html)?.[1];
  assert.ok(csrf, 'Authentication form includes a CSRF token');
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('jso-test-csrf='));
  assert.ok(cookie && /; HttpOnly;/.test(cookie) && /; SameSite=Lax;/.test(cookie), 'CSRF cookie attributes');
  return csrf;
}

async function login(browser) {
  const csrf = await form(browser, '/signin-with-chatgpt');
  const response = await browser.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health', username, password }),
  });
  assert.equal(response.status, 303, 'Valid credentials authenticate');
  assert.equal(response.headers.get('location'), '/health', 'Login preserves an allowed return path');
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('jso-test-session='));
  assert.ok(cookie && /; HttpOnly;/.test(cookie) && /; SameSite=Lax;/.test(cookie), 'Session cookie attributes');
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
  let response = await anonymous.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health', username, password }),
  });
  assert.equal(response.status, 403, 'Cross-origin login is rejected');
  response = await anonymous.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'invalid', return_to: '/health', username, password }),
  });
  assert.equal(response.status, 403, 'Invalid login CSRF is rejected');
  response = await anonymous.request('/signin-with-chatgpt', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, return_to: '/health', username, password: randomBytes(24).toString('base64url') }),
  });
  assert.equal(response.status, 401, 'Incorrect password is rejected');
  await json(await anonymous.request('/api/session'), 401, 'Incorrect password grants no session');

  await login(authenticated);
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
  process.stdout.write('Self-hosted production smoke passed: migrations, authentication, CSRF, identity isolation, food catalog, persistent goals/nutrition, idempotency, restart and logout.\n');
}

try { await main(); }
finally { await stop(); rmSync(temporary, { recursive: true, force: true }); }
