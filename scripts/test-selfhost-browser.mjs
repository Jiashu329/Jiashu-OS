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
const email = 'browser@example.test', ownerId = 'selfhost-browser-owner', ownerEmail = email;
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

async function submitNormalForm(page, endpoint, buttonName, origin, landingPath = '/health', expectedStatus = 303, expectedRedirect = '/health') {
  const [response] = await Promise.all([
    page.waitForResponse(value => value.request().method() === 'POST' && value.url() === origin + endpoint),
    page.getByRole('button', { name: buttonName, exact: true }).click(),
  ]);
  // Observe Chromium's real navigation headers. Do not inject Origin or use
  // request.post() for the successful flow: no-referrer made this "null".
  const headers = await response.request().allHeaders();
  assert.equal(headers.origin, origin, 'A native same-site form includes the configured Origin.');
  assert.equal(response.status(), expectedStatus, 'The native email authentication form returns the expected status.');
  if (expectedStatus !== 303) return;
  assert.equal(response.headers().location, expectedRedirect);
  await page.waitForURL(url => url.origin === origin && url.pathname === landingPath);
}

async function loginEmail(browserInstance, origin, accountEmail, accountPassword, expectedStatus = 303) {
  const context = await browserInstance.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const document = await page.goto(origin + '/signin-with-chatgpt?return_to=%2Fhealth');
  assert.equal(document.status(), 200);
  await page.locator('input[name="email"]').fill(accountEmail);
  await page.locator('input[name="password"]').fill(accountPassword);
  await submitNormalForm(page, '/signin-with-chatgpt', '登录', origin, '/health', expectedStatus);
  if (expectedStatus !== 303) {
    assert.equal((await context.request.get(origin + '/api/session')).status(), 401);
    await context.close(); return null;
  }
  return { context, page };
}

async function browserJSON(page, path, scope, method = 'GET', body, expectedStatus = 200) {
  // Browser fetch generates Origin itself; successful requests never forge it.
  const result = await page.evaluate(async input => {
    const response = await fetch(input.path, {
      method: input.method, headers: { 'Content-Type': 'application/json', 'X-Page-Owner': input.scope },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    return { status: response.status, value };
  }, { path, scope, method, body });
  assert.equal(result.status, expectedStatus);
  return result.value;
}

async function refreshAccounts(page) {
  await Promise.all([
    page.waitForResponse(value => value.request().method() === 'GET' && new URL(value.url()).pathname === '/api/admin/users' && value.status() === 200),
    page.getByRole('button', { name: '刷新列表', exact: true }).click(),
  ]);
  await page.waitForFunction(() => document.getElementById('users-refresh')?.disabled === false);
}

async function adminUIResponse(page, memberId, action) {
  const [response] = await Promise.all([
    page.waitForResponse(value => value.request().method() === 'PATCH' && new URL(value.url()).pathname === '/api/admin/users/' + memberId),
    action(),
  ]);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['x-account-owner'], ownerId, 'Native administrative responses remain bound to the page account.');
  assert.equal((await response.request().allHeaders()).origin, new URL(page.url()).origin);
}

async function multiuserBrowser(context, administratorPage, origin) {
  phase = 'administrator-goal-fixture';
  const date = '2026-01-01';
  const rootTargets = { steps: 8000, sleep: 8, active_energy: 500 };
  await browserJSON(administratorPage, '/api/health/goals', ownerId, 'PUT', { targets: rootTargets, expectedRevision: 0, effectiveFrom: date });

  phase = 'administrator-account-page';
  const document = await administratorPage.goto(origin + '/settings/users');
  assert.equal(document.status(), 200);
  const createForm = administratorPage.locator('#users-add-form');
  await createForm.waitFor({ state: 'visible' });
  const memberEmail = 'browser-member@example.test', memberPassword = randomBytes(24).toString('base64url');
  await createForm.locator('#users-add-email').fill(memberEmail);
  await createForm.locator('#users-add-password').fill(memberPassword);
  phase = 'create-account-through-ui';
  const [createdResponse] = await Promise.all([
    administratorPage.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/admin/users'),
    createForm.getByRole('button', { name: '添加账户', exact: true }).click(),
  ]);
  assert.equal(createdResponse.status(), 201);
  assert.equal(createdResponse.headers()['x-account-owner'], ownerId);
  assert.equal((await createdResponse.request().allHeaders()).origin, origin);
  const created = await createdResponse.json(), memberId = created.user.id;
  assert.ok(typeof memberId === 'string' && memberId !== ownerId);
  assert.equal(created.user.email, memberEmail); assert.equal(created.user.isAdmin, false);
  const row = administratorPage.locator('article.users-row').filter({ hasText: memberEmail });
  await row.waitFor({ state: 'visible' });
  assert.equal(await row.getAttribute('data-user-id'), memberId);

  phase = 'normal-native-email-login';
  const normal = await loginEmail(browser, origin, memberEmail, memberPassword);
  const identity = await normal.context.request.get(origin + '/api/session');
  assert.equal(identity.status(), 200);
  const normalIdentity = await identity.json(); assert.equal(normalIdentity.userId, memberId); assert.equal(normalIdentity.isOwner, false);
  phase = 'normal-administrator-page-forbidden';
  const forbiddenPage = await normal.page.goto(origin + '/settings/users');
  assert.equal(forbiddenPage.status(), 403);
  assert.equal(await normal.page.locator('#users-add-form').count(), 0);
  assert.equal((await normal.context.request.get(origin + '/api/admin/users', { headers: { 'X-Page-Owner': memberId } })).status(), 403);
  phase = 'browser-data-isolation';
  const memberTargets = { steps: 3456, sleep: 7, active_energy: 300 };
  const initial = await browserJSON(normal.page, '/api/health/goals', memberId);
  assert.equal(initial.revision, 0);
  await browserJSON(normal.page, '/api/health/goals', memberId, 'PUT', { targets: memberTargets, expectedRevision: 0, effectiveFrom: date });
  assert.equal((await browserJSON(administratorPage, '/api/health/goals', ownerId)).targets.steps, rootTargets.steps);
  const wrongScope = await browserJSON(normal.page, '/api/health/goals', ownerId, 'GET', undefined, 401);
  assert.equal(wrongScope.code, 'ACCOUNT_CHANGED');

  phase = 'disable-account-through-ui';
  await refreshAccounts(administratorPage);
  await row.getByRole('button', { name: '停用账户', exact: true }).click();
  await adminUIResponse(administratorPage, memberId, () => administratorPage.getByRole('button', { name: '确认停用', exact: true }).click());
  assert.equal((await normal.context.request.get(origin + '/api/session')).status(), 401, 'Disabling immediately revokes an open browser session.');
  await loginEmail(browser, origin, memberEmail, memberPassword, 401);

  phase = 'restore-account-through-ui';
  await refreshAccounts(administratorPage);
  await row.getByRole('button', { name: '恢复账户', exact: true }).click();
  await adminUIResponse(administratorPage, memberId, () => administratorPage.getByRole('button', { name: '确认恢复', exact: true }).click());
  const restored = await loginEmail(browser, origin, memberEmail, memberPassword);
  const secondSession = await loginEmail(browser, origin, memberEmail, memberPassword);

  phase = 'reset-password-through-ui';
  await refreshAccounts(administratorPage);
  await row.getByRole('button', { name: '编辑账户', exact: true }).click();
  const resetPassword = randomBytes(24).toString('base64url');
  await administratorPage.locator('#users-edit-password').fill(resetPassword);
  await adminUIResponse(administratorPage, memberId, () => administratorPage.getByRole('button', { name: '保存修改', exact: true }).click());
  assert.equal((await restored.context.request.get(origin + '/api/session')).status(), 401);
  assert.equal((await secondSession.context.request.get(origin + '/api/session')).status(), 401, 'Reset revokes every active browser cookie.');
  await loginEmail(browser, origin, memberEmail, memberPassword, 401);
  const reset = await loginEmail(browser, origin, memberEmail, resetPassword);

  phase = 'change-email-through-ui';
  await refreshAccounts(administratorPage);
  await row.getByRole('button', { name: '编辑账户', exact: true }).click();
  const renamedEmail = 'browser-renamed@example.test';
  await administratorPage.locator('#users-edit-email').fill(renamedEmail);
  await adminUIResponse(administratorPage, memberId, () => administratorPage.getByRole('button', { name: '保存修改', exact: true }).click());
  assert.equal((await reset.context.request.get(origin + '/api/session')).status(), 401);
  await loginEmail(browser, origin, memberEmail, resetPassword, 401);
  const renamed = await loginEmail(browser, origin, renamedEmail, resetPassword);
  const renamedIdentity = await (await renamed.context.request.get(origin + '/api/session')).json();
  assert.equal(renamedIdentity.userId, memberId); assert.equal(renamedIdentity.email, renamedEmail);
  assert.equal((await browserJSON(renamed.page, '/api/health/goals', memberId)).targets.steps, memberTargets.steps, 'Email edits preserve the account ID and its data.');

  phase = 'normal-native-email-logout';
  await renamed.page.goto(origin + '/signout-with-chatgpt?return_to=%2Fhealth');
  await submitNormalForm(renamed.page, '/signout-with-chatgpt', '确认退出', origin, '/signin-with-chatgpt');
  assert.equal((await renamed.context.request.get(origin + '/api/session')).status(), 401);
  assert.equal((await context.request.get(origin + '/api/session')).status(), 200, 'Normal-user account changes preserve the administrator session.');

  phase = 'administrator-self-email-change-through-ui';
  await refreshAccounts(administratorPage);
  const administratorRow = administratorPage.locator('article.users-row').filter({ hasText: ownerEmail });
  await administratorRow.getByRole('button', { name: '编辑账户', exact: true }).click();
  const changedAdministratorEmail = 'changed-browser-administrator@example.test';
  await administratorPage.locator('#users-edit-email').fill(changedAdministratorEmail);
  await adminUIResponse(administratorPage, ownerId, () => administratorPage.getByRole('button', { name: '保存修改', exact: true }).click());
  await administratorPage.locator('#users-status-text').filter({ hasText: '登录信息已更新' }).waitFor({ state: 'visible' });
  await administratorPage.waitForURL(url => url.origin === origin && url.pathname === '/signin-with-chatgpt');
  phase = 'administrator-native-reauthentication';
  await administratorPage.locator('input[name="email"]').fill(changedAdministratorEmail);
  await administratorPage.locator('input[name="password"]').fill(password);
  await submitNormalForm(administratorPage, '/signin-with-chatgpt', '登录', origin, '/settings/users', 303, '/settings/users');
  const administratorIdentity = await (await context.request.get(origin + '/api/session')).json();
  assert.equal(administratorIdentity.userId, ownerId); assert.equal(administratorIdentity.email, changedAdministratorEmail); assert.equal(administratorIdentity.isOwner, true);
  assert.equal((await browserJSON(administratorPage, '/api/health/goals', ownerId)).targets.steps, rootTargets.steps, 'Administrator email edits preserve its owner ID and original data.');

}

async function main() {
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const environment = {
    ...process.env, CI: 'true', SELFHOST_ALLOW_HTTP: '1', SELFHOST_PUBLIC_ORIGIN: origin,
    HOST: '127.0.0.1', PORT: String(port), SELFHOST_DB_PATH: database,
    SELFHOST_USERNAME: 'legacy-browser-admin', SELFHOST_PASSWORD_HASH: await hashPassword(password),
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
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  const csrf = await page.locator('input[name="csrf"]').inputValue();

  // API-only negative cases retain strict Origin checks. The positive browser
  // navigation below always uses an ordinary unmodified HTML form submission.
  for (const [label, invalidOrigin] of [['missing', undefined], ['empty', ''], ['null', 'null'], ['foreign', 'https://attacker.invalid']]) {
    phase = 'reject-' + label + '-origin';
    const rejected = await context.request.post(origin + '/signin-with-chatgpt', {
      headers: invalidOrigin === undefined ? {} : { Origin: invalidOrigin },
      form: { email, password, csrf, return_to: '/health' }, maxRedirects: 0,
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

  await multiuserBrowser(context, page, origin);

  phase = 'logout-page';
  const logoutDocument = await page.goto(origin + '/signout-with-chatgpt?return_to=%2Fhealth');
  assert.equal(logoutDocument.status(), 200);
  phase = 'native-logout-form';
  await submitNormalForm(page, '/signout-with-chatgpt', '确认退出', origin, '/signin-with-chatgpt');
  phase = 'logged-out-session';
  assert.equal((await context.request.get(origin + '/api/session')).status(), 401);
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'jso-test-session'), false);
  process.stdout.write('Real Chromium self-hosted email login/logout passed: native Origin, administrator UI accounts, isolation, disable/reset/email session revocation, and missing/empty/null/foreign Origin rejection.\n');
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
