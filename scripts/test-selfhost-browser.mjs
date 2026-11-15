import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Guard before loading Chromium, allocating ports, or starting any HTTP server.
if (process.env.SITES_MANAGED_LINUX_CONTAINER === '1') throw new Error('Real self-hosted browser acceptance cannot run in the managed Sites environment.');
if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run real self-hosted browser acceptance in GitHub Actions.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Self-hosted browser acceptance requires Node.js 24.');

const app = resolve('dist/standalone');
for (const file of ['selfhost/server.mjs', 'selfhost/auth.ts', 'selfhost/migrations.ts', 'dist/server/index.js']) {
  if (!existsSync(join(app, file))) throw new Error('Build the standalone application before browser acceptance.');
}
const { chromium } = await import('@playwright/test');
const { hashPassword } = await import(pathToFileURL(join(app, 'selfhost/auth.ts')).href);
const directory = mkdtempSync(join(tmpdir(), 'jiashu-selfhost-browser-'));
const database = join(directory, 'browser.sqlite3');
const username = 'browser-admin', ownerId = 'selfhost-browser-owner', ownerEmail = 'browser@example.test';
const password = randomBytes(24).toString('base64url');
let child, browser, phase = 'fixture';

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolveClose, reject) => socket.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function start(environment, port) {
  let output = '';
  child = spawn(process.execPath, ['selfhost/server.mjs'], { cwd: app, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-32000); });
  child.stderr.on('data', () => { /* Never forward fixture credentials or server diagnostics. */ });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => finish(new Error('Production fixture readiness timed out.')), 30000);
    const check = () => {
      if (output.split('\n').some(line => { try { const value = JSON.parse(line); return value.event === 'selfhost_ready' && value.port === port; } catch { return false; } })) finish();
    };
    const exited = () => finish(new Error('Production fixture exited.'));
    const failed = () => finish(new Error('Production fixture could not start.'));
    function finish(error) {
      clearTimeout(timer); child.stdout.off('data', check); child.off('exit', exited); child.off('error', failed);
      if (error) reject(error); else resolveReady();
    }
    child.stdout.on('data', check); child.once('exit', exited); child.once('error', failed); check();
  });
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  child.kill('SIGTERM');
  try { await stopped; } finally { clearTimeout(timer); }
}

async function submitNormalForm(page, endpoint, buttonName, origin, landingPath = '/health') {
  const [response] = await Promise.all([
    page.waitForResponse(value => value.request().method() === 'POST' && value.url() === origin + endpoint),
    page.getByRole('button', { name: buttonName, exact: true }).click(),
  ]);
  // Observe Chromium's real navigation headers. Do not inject Origin or use
  // request.post() for the successful flow: no-referrer made this "null".
  const headers = await response.request().allHeaders();
  assert.equal(headers.origin, origin, 'A native same-site form includes the configured Origin.');
  assert.equal(response.status(), 303, 'A native authentication form succeeds.');
  assert.equal(response.headers().location, '/health');
  await page.waitForURL(url => url.origin === origin && url.pathname === landingPath);
}

async function main() {
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const environment = {
    ...process.env, CI: 'true', SELFHOST_ALLOW_HTTP: '1', SELFHOST_PUBLIC_ORIGIN: origin,
    HOST: '127.0.0.1', PORT: String(port), SELFHOST_DB_PATH: database,
    SELFHOST_USERNAME: username, SELFHOST_PASSWORD_HASH: await hashPassword(password),
    SELFHOST_SESSION_SECRET: randomBytes(32).toString('base64url'),
    APP_OWNER_USER_ID: ownerId, APP_OWNER_EMAIL: ownerEmail,
    AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_COMMIT_SHA: 'b'.repeat(40),
  };
  phase = 'migrations';
  execFileSync(process.execPath, ['selfhost/migrations.ts', 'migrate', '--database', database, '--directory', join(app, 'drizzle')], {
    cwd: app, env: environment, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  phase = 'server-readiness';
  await start(environment, port);
  phase = 'chromium';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  phase = 'login-page';
  const document = await page.goto(origin + '/signin-with-chatgpt?return_to=%2Fhealth');
  assert.equal(document.status(), 200);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  const csrf = await page.locator('input[name="csrf"]').inputValue();

  // API-only negative cases retain strict Origin checks. The positive browser
  // navigation below always uses an ordinary unmodified HTML form submission.
  for (const [label, invalidOrigin] of [['missing', undefined], ['empty', ''], ['null', 'null'], ['foreign', 'https://attacker.invalid']]) {
    phase = 'reject-' + label + '-origin';
    const rejected = await context.request.post(origin + '/signin-with-chatgpt', {
      headers: invalidOrigin === undefined ? {} : { Origin: invalidOrigin },
      form: { username, password, csrf, return_to: '/health' }, maxRedirects: 0,
    });
    assert.equal(rejected.status(), 403, 'Invalid or absent Origin stays rejected.');
  }

  phase = 'native-login-form';
  await submitNormalForm(page, '/signin-with-chatgpt', '登录', origin);
  phase = 'authenticated-owner';
  const sessionResponse = await context.request.get(origin + '/api/session');
  assert.equal(sessionResponse.status(), 200);
  const identity = await sessionResponse.json();
  assert.equal(identity.userId, ownerId); assert.equal(identity.email, ownerEmail); assert.equal(identity.isOwner, true);
  assert.ok((await context.cookies()).some(cookie => cookie.name === 'jso-test-session' && cookie.httpOnly && cookie.sameSite === 'Lax'));

  phase = 'logout-page';
  const logoutDocument = await page.goto(origin + '/signout-with-chatgpt?return_to=%2Fhealth');
  assert.equal(logoutDocument.status(), 200);
  phase = 'native-logout-form';
  await submitNormalForm(page, '/signout-with-chatgpt', '确认退出', origin, '/signin-with-chatgpt');
  phase = 'logged-out-session';
  assert.equal((await context.request.get(origin + '/api/session')).status(), 401);
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'jso-test-session'), false);
  process.stdout.write('Real Chromium self-hosted login/logout passed: native form Origin, owner session, and missing/empty/null/foreign Origin rejection.\n');
}

try { await main(); }
catch {
  // Playwright errors can embed filled values. Never print an error object,
  // request body, trace, screenshot, cookie, environment or private password.
  process.stderr.write('Self-hosted real-browser acceptance failed at phase: ' + phase + '.\n');
  process.exitCode = 1;
}
finally {
  try { await browser?.close(); } catch { process.exitCode = 1; }
  try { await stop(); } catch { process.exitCode = 1; }
  rmSync(directory, { recursive: true, force: true });
}
