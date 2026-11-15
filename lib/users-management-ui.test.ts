import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { renderUsersSettingsPage } from '../users-settings-page.ts';
import { renderUsersManagementScript } from './users-management-ui.ts';

const admin = { id: 'local-admin', email: 'admin@treefund.asia', status: 'active', revision: 1, isAdmin: true, createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z', lastLoginAt: null };
const member = { ...admin, id: 'local-member', email: 'member@example.com', isAdmin: false };
const metadata = (users = [admin, member], currentUserId = admin.id) => ({ users, currentUserId, csrfToken: 'current-admin-csrf' });
async function settled(check: () => boolean) {
  for (let count = 0; count < 70; count++) { if (check()) return; await new Promise<void>((done) => setImmediate(done)); }
  assert.ok(check(), 'Users management UI did not settle');
}
function fixture(initial = metadata()) {
  const html = renderUsersSettingsPage(admin.id), { document, window } = parseHTML(html);
  for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { configurable: true, get() { throw new Error('Passwords must not enter browser storage'); } });
  let handler: (url: string, options: RequestInit) => Promise<Response> = async () => Response.json(initial);
  const requests: Array<{ url: string; options: RequestInit; body: unknown }> = [], redirects: string[] = [];
  const fetch = async (url: string, options: RequestInit = {}) => { requests.push({ url, options, body: typeof options.body === 'string' ? JSON.parse(options.body) as unknown : null }); return handler(url, options); };
  const el = (id: string) => document.getElementById('users-' + id)! as HTMLInputElement;
  const event = (id: string, kind = 'click') => el(id).dispatchEvent(new window.Event(kind, { bubbles: true, cancelable: true }));
  const row = (id = member.id) => document.querySelector('[data-user-id="' + id + '"]')!;
  const action = (name: string, id = member.id) => [...row(id).querySelectorAll('button')].find((button) => button.textContent === name)!.dispatchEvent(new window.Event('click', { bubbles: true }));
  runInNewContext(renderUsersManagementScript(admin.id).replace(/^<script>/, '').replace(/<\/script>$/, ''), {
    document, window, fetch, AbortController, TextEncoder, Intl, Date,
    location: { replace(path: string) { redirects.push(path); } },
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay === 1200 ? 0 : delay), clearTimeout,
  });
  return { html, document, window, el, event, row, action, requests, redirects, respond(next: typeof handler) { handler = next; }, writes: () => requests.filter((request) => request.options.method) };
}

void test('initial forms are disabled, passwords are never prefilled, and only the local administrator sees user controls', async () => {
  const { document } = parseHTML(renderUsersSettingsPage(admin.id));
  for (const id of ['add-email', 'add-password', 'add-submit', 'edit-email', 'edit-password', 'edit-save']) assert.equal((document.getElementById('users-' + id) as HTMLInputElement).disabled, true);
  for (const input of document.querySelectorAll('input[type=password]')) { assert.equal(input.getAttribute('autocomplete'), 'new-password'); assert.equal(input.hasAttribute('value'), false); }
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  assert.match(f.el('count').textContent!, /2 个账户/);
  assert.deepEqual([...f.row(admin.id).querySelectorAll('button')].map((button) => button.textContent), ['编辑账户']);
  f.el('search').value = 'MEMBER@'; f.event('search', 'input'); assert.equal(f.el('list').children.length, 1); assert.match(f.el('list').textContent!, /member@example.com/);
});

void test('adding an account sends one normalized email and CSRF-protected request while clearing the password immediately', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  const created = { ...member, id: 'new-user', email: 'new@example.com' };
  f.respond(async (_url, options) => options.method ? Response.json({ user: created }) : Response.json(metadata([admin, member, created])));
  f.el('add-email').value = ' NEW@Example.com '; f.el('add-password').value = 'private-password-123'; f.event('add-form', 'submit');
  assert.equal(f.el('add-password').value, ''); assert.equal(f.el('add-submit').disabled, true);
  f.event('add-form', 'submit'); await settled(() => !f.el('add-submit').disabled && f.el('count').textContent?.includes('3 个账户') === true);
  assert.equal(f.writes().length, 1); assert.deepEqual(f.writes()[0].body, { email: 'new@example.com', password: 'private-password-123' });
  assert.equal((f.writes()[0].options.headers as Record<string, string>)['X-CSRF-Token'], 'current-admin-csrf');
  assert.equal((f.writes()[0].options.headers as Record<string, string>)['X-Page-Owner'], admin.id);
  assert.equal(f.el('add-email').value, ''); assert.doesNotMatch(f.document.body.textContent!, /private-password-123/);
});

void test('editing uses the selected revision and status changes need confirmation without exposing administrator disable controls', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  let current = { ...member };
  f.respond(async (_url, options) => { if (options.method) { const body = JSON.parse(options.body as string) as { email?: string; status?: string }; current = { ...current, ...(body.email ? { email: body.email } : {}), ...(body.status ? { status: body.status } : {}), revision: current.revision + 1 }; return Response.json({ user: current }); } return Response.json(metadata([admin, current])); });
  f.action('编辑账户'); f.el('edit-email').value = 'renamed@example.com'; f.el('edit-password').value = 'replacement-password'; f.event('edit-form', 'submit');
  await settled(() => !f.el('add-submit').disabled && f.el('status-text').textContent?.includes('密码已重设') === true);
  assert.deepEqual(f.writes()[0].body, { expectedRevision: 1, email: 'renamed@example.com', password: 'replacement-password' });
  assert.equal(f.el('edit-password').value, '');
  f.action('停用账户'); assert.equal(f.writes().length, 1); assert.equal(f.el('confirm').hidden, false); f.event('confirm-submit');
  await settled(() => !f.el('add-submit').disabled && f.el('status-text').textContent?.includes('账户已停用') === true);
  assert.deepEqual(f.writes()[1].body, { expectedRevision: 2, status: 'disabled' }); assert.match(f.row().textContent!, /恢复账户/);
});

void test('uncertain writes clear secrets and prevent blind retries until a manual list refresh', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  f.respond(async (_url, options) => { if (options.method) throw new Error('private network details'); return Response.json(metadata()); });
  f.el('add-email').value = 'new@example.com'; f.el('add-password').value = 'private-password-123'; f.event('add-form', 'submit');
  await settled(() => f.el('status-text').textContent?.includes('暂时无法确认') === true);
  assert.equal(f.el('add-password').value, ''); assert.equal(f.el('add-submit').disabled, true); assert.equal(f.el('refresh').disabled, false);
  f.el('add-password').value = 'must-not-retry'; f.event('add-form', 'submit'); assert.equal(f.writes().length, 1); assert.equal(f.el('add-password').value, '');
  f.event('refresh'); await settled(() => !f.el('add-submit').disabled); assert.equal(f.writes().length, 1);
  assert.match(f.el('status-text').textContent!, /请核对账户状态/);
});

void test('an unexpected successful mutation response does not claim completion or allow another submission', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  f.respond(async () => Response.json({ user: member }));
  f.el('add-email').value = 'different@example.com'; f.el('add-password').value = 'private-password-123'; f.event('add-form', 'submit');
  await settled(() => f.el('status-text').textContent?.includes('暂时无法确认') === true);
  assert.equal(f.el('add-submit').disabled, true); assert.equal(f.el('refresh').disabled, false); assert.equal(f.el('add-password').value, ''); assert.equal(f.writes().length, 1);
});

void test('conflicts refresh authoritative revisions without repeating the mutation and render emails as text', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  f.respond(async (_url, options) => options.method ? Response.json({ error: '账户版本已变化', code: 'USER_CONFLICT' }, { status: 409 }) : Response.json(metadata([admin, { ...member, email: '<img src=x onerror=alert(1)>@example.com', revision: 8 }])));
  f.action('停用账户'); f.event('confirm-submit');
  await settled(() => f.el('status-text').textContent?.includes('核对最新列表') === true);
  assert.equal(f.writes().length, 1); assert.equal(f.el('list').querySelector('img'), null); assert.match(f.row().textContent!, /<img/);
  f.action('停用账户'); f.event('confirm-submit'); await settled(() => !f.el('add-submit').disabled); assert.deepEqual(f.writes()[1].body, { expectedRevision: 8, status: 'disabled' });
});

void test('expired CSRF information refreshes without replaying a password or locking the administrator out', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  f.respond(async (_url, options) => options.method ? Response.json({ error: '请刷新用户列表', code: 'LOCAL_USER_CSRF_INVALID' }, { status: 403 }) : Response.json({ ...metadata(), csrfToken: 'fresh-admin-csrf' }));
  f.el('add-email').value = 'new@example.com'; f.el('add-password').value = 'private-password-123'; f.event('add-form', 'submit');
  await settled(() => !f.el('add-submit').disabled && f.el('status-text').textContent?.includes('验证信息已刷新') === true);
  assert.equal(f.writes().length, 1); assert.equal(f.el('add-password').value, ''); assert.equal(f.el('login').hidden, true);
  f.el('add-password').value = 'second-private-password'; f.event('add-form', 'submit');
  await settled(() => !f.el('add-submit').disabled);
  assert.equal((f.writes()[1].options.headers as Record<string, string>)['X-CSRF-Token'], 'fresh-admin-csrf');
});

void test('password validation counts Unicode characters consistently and rejects oversized or multiline values', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  f.el('add-email').value = 'new@example.com';
  for (const password of ['😀'.repeat(11), 'a'.repeat(257), 'valid-password\nextra', 'valid-password\0extra']) {
    f.el('add-password').value = password; f.event('add-form', 'submit');
    assert.equal(f.writes().length, 0); assert.equal(f.el('add-password').value, ''); assert.match(f.el('status-text').textContent!, /12–256/);
  }
  const unicodePassword = '😀'.repeat(256);
  f.respond(async (_url, options) => options.method ? Response.json({ user: { ...member, id: 'unicode-user', email: 'new@example.com' } }) : Response.json(metadata()));
  f.el('add-password').value = unicodePassword; f.event('add-form', 'submit'); await settled(() => !f.el('add-submit').disabled);
  assert.equal(f.writes().length, 1); assert.equal((f.writes()[0].body as { password: string }).password, unicodePassword);
});

void test('account changes lock old documents and late responses cannot reveal a user list', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  f.respond(async () => Response.json(metadata([admin, member], 'other-admin'))); f.event('refresh');
  await settled(() => f.el('login').hidden === false); assert.equal(f.el('list').children.length, 0); assert.equal(f.el('add-submit').disabled, true);
  const late = fixture(); await settled(() => !late.el('add-submit').disabled);
  let resolve!: (response: Response) => void; late.respond(async () => new Promise<Response>((done) => { resolve = done; })); late.event('refresh');
  late.document.dispatchEvent(new late.window.Event('jiashu-account-changed')); resolve(Response.json(metadata()));
  await settled(() => late.el('page').getAttribute('aria-busy') === 'false');
  assert.equal(late.el('list').children.length, 0); assert.equal(late.el('add-submit').disabled, true);
});

void test('changing the current administrator credentials clears the page and returns to sign-in', async () => {
  const f = fixture(); await settled(() => !f.el('add-submit').disabled);
  f.respond(async () => Response.json({ user: { ...admin, email: 'new-admin@example.com', revision: 2 }, reauthRequired: true }));
  f.action('编辑账户', admin.id); f.el('edit-email').value = 'new-admin@example.com'; f.event('edit-form', 'submit');
  await settled(() => f.el('login').hidden === false); await new Promise<void>((done) => setTimeout(done, 5));
  assert.deepEqual(f.redirects, ['/signin-with-chatgpt?return_to=%2Fsettings%2Fusers']); assert.equal(f.el('list').children.length, 0);
  assert.equal(f.el('add-submit').disabled, true); assert.match(f.el('status-text').textContent!, /新的邮箱和密码重新登录/);
});
