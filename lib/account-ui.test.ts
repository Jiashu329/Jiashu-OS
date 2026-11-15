import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderAccountIdentityScript } from './account-ui.ts';
import { renderAccountPage } from '../account-page.ts';

async function settled(check: () => boolean) {
  for (let count = 0; count < 60; count++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'Account identity did not settle');
}

function fixture(responses: Array<Response | Promise<Response>>, expectedOwner = 'alice', pageOwner = '', localAuth = false) {
  const { window, document } = parseHTML(`<html><body><a href="/account"><span data-current-account-avatar>我</span><strong data-current-account-name>当前账户</strong><small data-current-account-hint>账户与切换登录</small></a><button data-account-retry data-account-sidebar-retry hidden>重新确认账户</button><main${localAuth ? ' data-account-auth-provider="local"' : ''}><p data-account-status role="status"></p><dl data-account-profile hidden><dd data-current-account-name></dd><dd data-current-account-email></dd></dl><button data-account-retry hidden>重试</button><a data-account-sign-in hidden>登录</a><a data-account-sign-out>退出</a><a data-account-owner-only hidden>管理使用名单</a></main></body></html>`);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const bound: string[] = [];
  const guard = { changed: false, bind(owner: string) { bound.push(owner); if (expectedOwner && owner !== expectedOwner) { this.changed = true; document.dispatchEvent(new window.Event('jiashu-account-changed')); return false; } return true; } };
  Object.assign(window, { JiashuAccountSession: guard, __JIASHU_PAGE_OWNER__: pageOwner });
  let reloads = 0;
  const source = renderAccountIdentityScript().replace(/^<script type="module">/, '').replace(/<\/script>$/, '');
  runInNewContext(source, { window, document, fetch: async (url: string, init: RequestInit) => { requests.push({ url, init }); const response = responses.shift(); if (!response) throw new Error('Synthetic session unavailable'); return response; }, AbortController, setTimeout, clearTimeout, location: { reload() { reloads++; } } });
  return { document, window, requests, bound, guard, get reloads() { return reloads; },
    names: () => [...document.querySelectorAll('[data-current-account-name]')].map((node) => node.textContent),
    status: () => document.querySelector('[data-account-status]')!,
    profile: () => document.querySelector('[data-account-profile]') as HTMLElement,
  };
}

void test('account identity renders only the current name and email as text and binds the immutable document owner', async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const f = fixture([Response.json({ userId: 'alice', displayName: malicious, email: 'alice@example.test', isOwner: true })]);
  await settled(() => !f.profile().hidden);
  assert.deepEqual(f.names(), [malicious, malicious]);
  assert.equal(f.document.querySelector('[data-current-account-email]')?.textContent, 'alice@example.test');
  assert.equal(f.document.querySelectorAll('img,script').length, 0);
  assert.deepEqual(f.bound, ['alice']);
  assert.equal((f.document.querySelector('[data-account-owner-only]') as HTMLElement).hidden, false);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/session');
  assert.equal(f.requests[0].init.credentials, 'same-origin'); assert.equal(f.requests[0].init.cache, 'no-store'); assert.equal(f.requests[0].init.method, undefined);
});

void test('a member sees their own account without the owner management link and legacy opaque responses stay usable', async () => {
  const f = fixture([Response.json({ userId: 'alice', displayName: 'Alice', email: 'alice@example.test', isOwner: false }), Response.json({ userId: 'alice' })]);
  await settled(() => !f.profile().hidden);
  assert.equal((f.document.querySelector('[data-account-owner-only]') as HTMLElement).hidden, true);
  f.window.dispatchEvent(new f.window.Event('focus'));
  await settled(() => f.names()[0] === '当前账户');
  assert.equal(f.document.querySelector('[data-current-account-email]')?.textContent, '—');
});

void test('a signed-out session clears identity and offers the existing ChatGPT sign-in without creating account data', async () => {
  const f = fixture([Response.json({ code: 'SIGN_IN_REQUIRED' }, { status: 401 })]);
  await settled(() => f.status().getAttribute('data-account-status') === 'signed-out');
  assert.ok(f.names().every((name) => name === '尚未登录')); assert.equal(f.profile().hidden, true);
  assert.equal((f.document.querySelector('[data-account-sign-in]') as HTMLElement).hidden, false);
  assert.equal((f.document.querySelector('[data-account-sign-out]') as HTMLElement).hidden, true);
  assert.equal((f.document.querySelector('[data-account-owner-only]') as HTMLElement).hidden, true);
  assert.deepEqual(f.bound, []); assert.equal(f.requests.length, 1);
});

void test('the self-hosted account page provides email login and an owner-only user management link', async () => {
  const local = renderAccountPage({ signInHref: '/signin-with-chatgpt', signOutHref: '/signout-with-chatgpt', authMode: 'selfhost' });
  const { document } = parseHTML(local);
  assert.equal(document.querySelector('main')?.getAttribute('data-account-auth-provider'), 'local');
  assert.equal(document.querySelector('#account-current-title')?.textContent, '当前账户');
  assert.equal(document.querySelector('[data-account-sign-in]')?.textContent, '使用邮箱和密码登录');
  assert.match(document.querySelector('main')?.textContent ?? '', /需要开通账户或重设密码时，请联系管理员/);
  assert.doesNotMatch(document.querySelector('main')?.textContent ?? '', /ChatGPT/);
  assert.equal(document.querySelector('[data-account-owner-only]')?.getAttribute('href'), '/settings/users');
  assert.equal(document.querySelector('[data-account-owner-only]')?.textContent, '用户管理');
  assert.equal((document.querySelector('[data-account-owner-only]') as HTMLElement).hidden, true);
  const sites = renderAccountPage({ signInHref: '/signin-with-chatgpt', signOutHref: '/signout-with-chatgpt' });
  assert.match(sites, /当前 ChatGPT 账户/);
  assert.equal(parseHTML(sites).document.querySelector('main')?.hasAttribute('data-account-auth-provider'), false);
  const f = fixture([Response.json({}, { status: 401 })], 'alice', '', true);
  await settled(() => f.status().getAttribute('data-account-status') === 'signed-out');
  assert.match(f.status().textContent, /自己的邮箱和密码/);
  assert.doesNotMatch(f.status().textContent, /ChatGPT/);
});

void test('a switched account is never displayed in the old document and can only be continued by refresh', async () => {
  const f = fixture([Response.json({ userId: 'bob', displayName: 'Bob', email: 'bob@example.test', isOwner: true })]);
  await settled(() => f.status().getAttribute('data-account-status') === 'changed');
  assert.ok(f.names().every((name) => name === '账户已切换'));
  assert.equal(f.document.querySelector('[data-current-account-email]')?.textContent, '—');
  assert.equal(f.document.documentElement.hasAttribute('data-account-changed'), true);
  assert.equal(f.profile().hidden, true); assert.equal((f.document.querySelector('[data-account-owner-only]') as HTMLElement).hidden, true);
  f.document.querySelector('[data-account-retry]')?.dispatchEvent(new f.window.Event('click'));
  assert.equal(f.reloads, 1); assert.equal(f.requests.length, 1);
});

void test('identity change invalidates a late session reply and failed reads can retry without adopting another account', async () => {
  let resolve!: (value: Response) => void;
  const waiting = new Promise<Response>((complete) => { resolve = complete; });
  const f = fixture([waiting]);
  f.guard.changed = true; f.document.dispatchEvent(new f.window.Event('jiashu-account-changed'));
  resolve(Response.json({ userId: 'bob', displayName: 'Late Bob', email: 'bob@example.test' }));
  await settled(() => f.names()[0] === '账户已切换');
  assert.deepEqual(f.bound, []);
  const retry = fixture([Response.json({}, { status: 503 }), Response.json({ userId: 'alice', displayName: 'Alice', email: 'alice@example.test' })]);
  await settled(() => retry.status().getAttribute('data-account-status') === 'error');
  retry.document.querySelector('[data-account-retry]')?.dispatchEvent(new retry.window.Event('click'));
  await settled(() => !retry.profile().hidden); assert.deepEqual(retry.bound, ['alice']);
});

void test('an SSR-bound page hides private content immediately while a delayed session check discovers a switched account', async () => {
  let resolve!: (value: Response) => void;
  const waiting = new Promise<Response>((complete) => { resolve = complete; });
  const f = fixture([Response.json({ userId: 'alice', displayName: 'Alice', email: 'alice@example.test' }), waiting], 'alice', 'alice');
  assert.equal(f.document.documentElement.hasAttribute('data-account-verifying'), true);
  await settled(() => !f.profile().hidden);
  assert.equal(f.document.documentElement.hasAttribute('data-account-verifying'), false);
  f.window.dispatchEvent(new f.window.Event('focus'));
  assert.equal(f.document.documentElement.hasAttribute('data-account-verifying'), true);
  assert.equal(f.profile().hidden, true);
  resolve(Response.json({ userId: 'bob', displayName: 'Bob', email: 'bob@example.test' }));
  await settled(() => f.status().getAttribute('data-account-status') === 'changed');
  assert.equal(f.document.documentElement.hasAttribute('data-account-verifying'), true);
  assert.ok(f.names().every((name) => name === '账户已切换'));
  assert.equal((f.document.querySelector('[data-account-sidebar-retry]') as HTMLElement).hidden, false);
});

void test('failed SSR identity checks stay covered but the sidebar can retry and restore the same account view', async () => {
  const f = fixture([Response.json({}, { status: 503 }), Response.json({ userId: 'alice', displayName: 'Alice', email: 'alice@example.test' })], 'alice', 'alice');
  await settled(() => f.status().getAttribute('data-account-status') === 'error');
  assert.equal(f.document.documentElement.hasAttribute('data-account-verifying'), true);
  const retry = f.document.querySelector('[data-account-sidebar-retry]') as HTMLElement;
  assert.equal(retry.hidden, false);
  retry.dispatchEvent(new f.window.Event('click'));
  await settled(() => !f.profile().hidden);
  assert.equal(f.document.documentElement.hasAttribute('data-account-verifying'), false);
  assert.equal(f.document.documentElement.hasAttribute('data-account-changed'), false);
  assert.equal(retry.hidden, true); assert.equal(f.names()[0], 'Alice');
});

void test('account page keeps auth navigation and data scope explanations while hiding owner tools before identity verification', () => {
  const html = renderAccountPage({ signInHref: '/signin-with-chatgpt?return_to=%2Faccount', signOutHref: '/signout-with-chatgpt?return_to=%2Faccount%3FsignedOut%3D1' });
  const { document } = parseHTML(html);
  assert.equal(document.querySelector('.sidebar-account')?.getAttribute('href'), '/account');
  assert.equal(document.querySelector('.sidebar-account')?.getAttribute('aria-current'), 'page');
  assert.equal(document.querySelectorAll('[data-navigation-page]').length, 6);
  assert.equal((document.querySelector('[data-account-owner-only]') as HTMLElement).hidden, true);
  assert.match(document.querySelector('main')?.textContent ?? '', /健康与饮食/);
  assert.match(document.querySelector('main')?.textContent ?? '', /多人分别登录不会自动共享账本/);
  assert.equal(document.querySelector('[data-account-sign-out]')?.getAttribute('href'), '/signout-with-chatgpt?return_to=%2Faccount%3FsignedOut%3D1');
  assert.match(html, /html\[data-account-changed\] \.app>main/);
  assert.match(html, /html\[data-account-verifying\] \.app>main/);
  assert.ok(document.querySelector('[data-account-sidebar-retry]'));
});
