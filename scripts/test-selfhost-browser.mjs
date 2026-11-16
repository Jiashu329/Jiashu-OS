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
const { hashPassword, issueSelfhostSession, loadSelfhostAuthConfig } = await import(pathToFileURL(join(app, 'selfhost/auth.ts')).href);
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

async function lateRenewalStaysLoggedOut(administratorContext, origin, environment) {
  phase = 'persistent-late-renewal-cookie-replay';
  const replayContext = await browser.newContext({ storageState: await administratorContext.storageState() });
  try {
    const config = loadSelfhostAuthConfig(environment);
    const legacyToken = issueSelfhostSession({ ...config, sessionTtl: 12 * 3600 }, { id: ownerId, revision: 1 });
    await replayContext.addCookies([{ name: 'jso-test-session', value: legacyToken, url: origin,
      httpOnly: true, secure: false, sameSite: 'Lax', expires: Date.now() / 1000 + 12 * 3600 }]);
    const replayPage = await replayContext.newPage(); replayPage.setDefaultTimeout(15000);
    const document = await replayPage.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
    assert.equal(document.status(), 200);
    const renewed = (await replayContext.cookies(origin)).find(cookie => cookie.name === 'jso-test-session');
    assert.ok(renewed && renewed.value !== legacyToken && renewed.expires > Date.now() / 1000 + 29 * 86400,
      'A real SSR response extends an existing login without another password form.');
    await replayPage.goto(origin + '/signout-with-chatgpt?return_to=%2Fhealth');
    await submitNormalForm(replayPage, '/signout-with-chatgpt', '确认退出', origin, '/signin-with-chatgpt');
    assert.equal((await replayContext.cookies(origin)).some(cookie => cookie.name === 'jso-test-session'), false);
    // Model a Set-Cookie response that was already in flight before logout and
    // arrives after its clearing cookie. Even if restored by the browser, the
    // persisted family revocation must reject this genuine pre-logout renewal.
    await replayContext.addCookies([renewed]);
    assert.equal((await replayContext.request.get(origin + '/api/session')).status(), 401);
    await replayPage.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
    assert.equal(new URL(replayPage.url()).pathname, '/signin-with-chatgpt');
    assert.equal((await administratorContext.request.get(origin + '/api/session')).status(), 200,
      'Logging out one browser family preserves another active login.');
  } finally { await replayContext.close(); }
}

async function persistentNavigation(page, origin) {
  const sessionPattern = origin + '/api/session';
  const foreignId = 'synthetic-other-owner', foreignName = 'PRIVATE_SESSION_NAME', foreignEmail = 'private-session@example.invalid';
  const pending = new Set();
  let mode = 'healthy', sessionRequests = 0;
  const interceptSession = async route => {
    sessionRequests++;
    if (mode === 'pending') await new Promise(resolvePending => pending.add(resolvePending));
    try {
      if (mode === 'healthy') { await route.continue(); return; }
      if (mode === 'pending') { await route.abort('failed'); return; }
      const status = mode === 'signed-out' ? 401 : mode === 'forbidden' ? 403 : mode === 'unavailable' ? 503 : 200;
      const body = mode === 'invalid-json' ? '{' : mode === 'changed'
        ? JSON.stringify({ userId: foreignId, displayName: foreignName, email: foreignEmail, isOwner: true })
        : JSON.stringify({ code: mode === 'signed-out' ? 'SIGN_IN_REQUIRED' : 'ACCOUNT_ACCESS_UNAVAILABLE' });
      await route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body });
    } catch { /* A canceled/reloaded request is intentionally discarded. */ }
  };
  const releasePending = () => { for (const resolvePending of pending) resolvePending(); pending.clear(); };
  const recovery = page.locator('[data-account-recovery]');
  await page.addInitScript(() => {
    const probe = { verificationSeen: false, recoverySeen: false };
    Object.defineProperty(window, '__accountNavigationProbe', { value: probe });
    new MutationObserver(records => {
      for (const record of records) {
        if (record.target === document.documentElement && record.attributeName === 'data-account-verifying' && record.oldValue === null) probe.verificationSeen = true;
      }
      const panel = document.querySelector('[data-account-recovery]');
      if (panel && !panel.hidden) probe.recoverySeen = true;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
  });
  async function restored() {
    await page.waitForFunction(() => {
      const main = document.querySelector('.app > main'), panel = document.querySelector('[data-account-recovery]');
      return main && getComputedStyle(main).visibility === 'visible' && panel?.hidden
        && !document.documentElement.hasAttribute('data-account-verifying')
        && !document.documentElement.hasAttribute('data-account-changed');
    }, undefined, { timeout: 2500 });
    const trusted = await page.evaluate(() => ({
      matches: window.__JIASHU_PAGE_SESSION__?.userId === window.__JIASHU_PAGE_OWNER__,
      frozen: Object.isFrozen(window.__JIASHU_PAGE_SESSION__),
      immutable: Object.getOwnPropertyDescriptor(window, '__JIASHU_PAGE_SESSION__')?.writable === false,
    }));
    assert.ok(trusted.matches && trusted.frozen && trusted.immutable, 'A fresh authenticated document uses its immutable server-verified account.');
  }
  async function noBlockingCheck() {
    await restored();
    const probe = await page.evaluate(() => window.__accountNavigationProbe);
    assert.equal(probe.verificationSeen, false, 'Ordinary navigation never starts by covering the server-authorized document.');
    assert.equal(probe.recoverySeen, false, 'Ordinary navigation never flashes a full-page login check.');
  }
  async function covered(states) {
    await page.waitForFunction(expected => {
      const panel = document.querySelector('[data-account-recovery]');
      return panel && !panel.hidden && expected.includes(panel.dataset.accountRecoveryState);
    }, states, { timeout: 20000 });
    assert.equal(await recovery.isVisible(), true);
    assert.equal(await page.locator('.app > main').isVisible(), false, 'Invalid/restored account documents keep private content covered.');
    assert.equal(await recovery.evaluate(panel => panel.closest('main') === null), true);
    const text = await recovery.textContent();
    assert.ok(text.trim().length > 0);
    for (const privateValue of [ownerId, ownerEmail, foreignId, foreignName, foreignEmail]) {
      assert.equal(text.includes(privateValue), false, 'Recovery copy does not show account identity data.');
    }
  }
  async function clickBackgroundRetry() {
    const retry = page.locator('[data-account-background-retry]');
    const reachable = await retry.evaluate(button => {
      const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === button || button.contains(hit);
    });
    assert.equal(reachable, true, 'The real background retry target must remain above or outside floating assistant controls.');
    await retry.click();
  }
  async function refreshIdentity() {
    const requested = page.waitForRequest(request => request.url() === sessionPattern);
    await page.evaluate(() => { void window.JiashuAccountIdentity.refresh({ force: true }); });
    await requested;
  }
  await page.route(sessionPattern, interceptSession);
  try {
    // Hold the background session response on every new document. If navigation
    // depends on it, these assertions fail before the interceptor is released.
    mode = 'pending';
    for (const path of ['/', '/health', '/finance', '/life/douban', '/account']) {
      phase = 'persistent-visible-navigation-' + path.replaceAll('/', '_');
      sessionRequests = 0;
      const document = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      assert.equal(document.status(), 200);
      await noBlockingCheck();
      await page.waitForFunction(() => document.documentElement.dataset.accountIdentityReady === 'true');
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await noBlockingCheck();
      assert.equal(sessionRequests, 0, 'Fresh SSR navigation and immediate focus/visibility do not need a second login check.');
      const beforeBusinessReads = sessionRequests;
      await browserJSON(page, '/api/health/goals', ownerId);
      await browserJSON(page, '/api/health/goals', ownerId);
      assert.equal(sessionRequests, beforeBusinessReads, 'Attested business API responses do not make extra session round trips.');
      await noBlockingCheck();
      mode = 'healthy'; releasePending();
      await page.waitForFunction(() => !window.JiashuAccountSession?.changed);
      mode = 'pending';
    }

    for (const [responseMode, label] of [['unavailable', '503'], ['invalid-json', 'invalid-json']]) {
      phase = 'persistent-background-' + label + '-navigation';
      mode = responseMode; releasePending();
      await page.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
      await noBlockingCheck();
      phase = 'persistent-background-' + label + '-refresh';
      await refreshIdentity();
      phase = 'persistent-background-' + label + '-feedback';
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-account-background-error'));
      assert.equal(await page.locator('[data-account-background-status]').isVisible(), true);
      await noBlockingCheck();
      mode = 'healthy';
      phase = 'persistent-background-' + label + '-retry';
      await clickBackgroundRetry();
      phase = 'persistent-background-' + label + '-recovered';
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-account-background-error'));
      await noBlockingCheck();
    }

    phase = 'persistent-pending-background';
    sessionRequests = 0;
    mode = 'pending';
    await page.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
    await noBlockingCheck();
    await refreshIdentity();
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await noBlockingCheck();
    assert.equal(sessionRequests, 1, 'An in-flight background check is shared across lifecycle events.');
    phase = 'persistent-background-timeout';
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-account-background-error'), undefined, { timeout: 20000 });
    await noBlockingCheck();
    mode = 'healthy'; releasePending();
    phase = 'persistent-background-timeout-retry';
    await clickBackgroundRetry();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-account-background-error'));
    await noBlockingCheck();

    for (const responseMode of ['signed-out', 'forbidden']) {
      phase = 'persistent-' + responseMode + '-session-recovery';
      mode = responseMode;
      await page.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
      await restored();
      await refreshIdentity();
      await covered(['signed-out', 'changed', 'error']);
    }
    const login = recovery.locator('[data-account-recovery-login]');
    assert.equal(await login.isVisible(), true);
    const signIn = new URL(await login.getAttribute('href'), origin);
    assert.equal(signIn.origin, origin); assert.equal(signIn.pathname, '/signin-with-chatgpt');

    phase = 'persistent-account-change-recovery';
    mode = 'changed';
    await page.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
    await restored();
    await refreshIdentity();
    await covered(['changed']);
    assert.equal(await recovery.locator('[data-account-recovery-retry]').textContent(), '刷新页面');
    mode = 'healthy';
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      recovery.locator('[data-account-recovery-retry]').click(),
    ]);
    await noBlockingCheck();

    // Deterministically exercise the bfcache lifecycle independently of whether
    // this Chromium build chooses to cache a no-store document in history.
    phase = 'persistent-bfcache-before-revalidation';
    mode = 'pending';
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await covered(['loading']);
    phase = 'persistent-bfcache-same-account';
    mode = 'healthy'; releasePending();
    await restored();
    phase = 'persistent-bfcache-account-changed';
    mode = 'changed';
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await covered(['changed']);
  } finally {
    mode = 'healthy'; releasePending();
    await page.unroute(sessionPattern, interceptSession);
    await page.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
    await restored();
  }
}
async function restoredDocumentRejectsOtherAccount(administratorContext, memberContext, origin) {
  phase = 'persistent-real-account-switch-restored-document';
  const restoredContext = await browser.newContext({ storageState: await administratorContext.storageState() });
  try {
    const oldPage = await restoredContext.newPage(); oldPage.setDefaultTimeout(15000);
    await oldPage.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
    await oldPage.waitForFunction(() => document.documentElement.dataset.accountIdentityReady === 'true');
    assert.equal(await oldPage.locator('.app > main').isVisible(), true);
    const memberCookie = (await memberContext.cookies(origin)).find(cookie => cookie.name === 'jso-test-session');
    assert.ok(memberCookie);
    await restoredContext.addCookies([memberCookie]);
    await oldPage.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await oldPage.waitForFunction(() => document.documentElement.hasAttribute('data-account-changed'));
    assert.equal(await oldPage.locator('.app > main').isVisible(), false, 'A restored document cannot reveal the previous account after its cookie changes.');
    assert.equal(await oldPage.locator('[data-account-recovery]').isVisible(), true);
    const response = await oldPage.evaluate(async () => {
      const result = await fetch('/api/health/goals');
      return { status: result.status, code: (await result.json()).code };
    });
    assert.equal(response.status, 401); assert.equal(response.code, 'ACCOUNT_CHANGED');
  } finally { await restoredContext.close(); }
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
  await restoredDocumentRejectsOtherAccount(context, normal.context, origin);
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

  await normal.page.goto(origin + '/health', { waitUntil: 'domcontentloaded' });
  phase = 'disable-account-through-ui';
  await refreshAccounts(administratorPage);
  await row.getByRole('button', { name: '停用账户', exact: true }).click();
  await adminUIResponse(administratorPage, memberId, () => administratorPage.getByRole('button', { name: '确认停用', exact: true }).click());
  assert.equal((await normal.context.request.get(origin + '/api/session')).status(), 401, 'Disabling immediately revokes an open browser session.');
  await browserJSON(normal.page, '/api/health/goals', memberId, 'GET', undefined, 401);
  await normal.page.waitForFunction(() => document.documentElement.hasAttribute('data-account-changed') || document.documentElement.hasAttribute('data-account-verifying'));
  assert.equal(await normal.page.locator('.app > main').isVisible(), false, 'A revoked account immediately covers its existing private document.');
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
  await browserJSON(restored.page, '/api/health/goals', memberId, 'GET', undefined, 401);
  await restored.page.waitForFunction(() => document.documentElement.hasAttribute('data-account-changed') || document.documentElement.hasAttribute('data-account-verifying'));
  assert.equal(await restored.page.locator('.app > main').isVisible(), false);
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
  await administratorPage.waitForFunction(() => document.getElementById('users-status-text')?.textContent.includes('登录信息已更新'));
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
  const persistentCookie = (await context.cookies()).find(cookie => cookie.name === 'jso-test-session');
  assert.ok(persistentCookie && persistentCookie.httpOnly && persistentCookie.sameSite === 'Lax');
  assert.ok(persistentCookie.expires > Date.now() / 1000 + 29 * 86400, 'The browser retains its login across restarts for the configured thirty-day period.');

  await lateRenewalStaysLoggedOut(context, origin, environment);
  await persistentNavigation(page, origin);
  await multiuserBrowser(context, page, origin);

  phase = 'logout-page';
  const logoutDocument = await page.goto(origin + '/signout-with-chatgpt?return_to=%2Fhealth');
  assert.equal(logoutDocument.status(), 200);
  phase = 'native-logout-form';
  await submitNormalForm(page, '/signout-with-chatgpt', '确认退出', origin, '/signin-with-chatgpt');
  phase = 'logged-out-session';
  assert.equal((await context.request.get(origin + '/api/session')).status(), 401);
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'jso-test-session'), false);
  process.stdout.write('Real Chromium self-hosted email login/logout passed: native Origin, persistent nonblocking account navigation and privacy-preserving recovery, administrator UI accounts, isolation, disable/reset/email session revocation, and missing/empty/null/foreign Origin rejection.\n');
}

try { await main(); }
catch (error) {
  // Playwright errors can embed filled values. Never print an error object,
  // request body, trace, screenshot, cookie, environment or private password.
  const kind = ['AssertionError', 'TimeoutError', 'Error'].includes(error?.name) ? error.name : 'Error';
  process.stderr.write('Self-hosted real-browser acceptance failed at phase: ' + phase + ' (' + kind + ').\n');
  process.exitCode = 1;
}
finally {
  try { await browser?.close(); } catch { process.exitCode = 1; }
  try { await stop(); } catch { process.exitCode = 1; }
  rmSync(directory, { recursive: true, force: true });
}
