import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { renderAccessSettingsPage } from '../access-settings-page.ts';
import { renderAccessSettingsScript } from './access-settings-ui.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const original = { id: ID, email: 'member@example.com', bound: false, status: 'active', revision: 1, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', lastLoginAt: null };
async function settled(check: () => boolean) { for (let index = 0; index < 50; index++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); } assert.ok(check(), 'Access UI did not settle'); }
function fixture(owner = 'site-owner', storage = new Map<string, string>()) {
  const { window, document } = parseHTML(renderAccessSettingsPage(owner));
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  let grants = [{ ...original }];
  let handler: (url: string, options: RequestInit) => Promise<Response> = async (_url, options) => options.method ? Response.json({ grant: original, replayed: false }) : Response.json({ owner: { email: 'owner@example.com', automaticAccess: true }, grants });
  const requests: Array<{ url: string; options: RequestInit; body: unknown }> = [];
  const fetch = async (url: string, options: RequestInit = {}) => { requests.push({ url, options, body: typeof options.body === 'string' ? JSON.parse(options.body) as unknown : null }); return handler(url, options); };
  runInNewContext(renderAccessSettingsScript(owner).replace(/^<script>/, '').replace(/<\/script>$/, ''), { window, document, fetch, crypto: webcrypto, location: { origin: 'https://site.example' }, navigator: { clipboard: { async writeText() {} } }, AbortController, setTimeout, clearTimeout });
  const el = (id: string) => document.getElementById('access-' + id)! as HTMLElement & { value: string; disabled: boolean };
  const event = (id: string, name = 'click') => el(id).dispatchEvent(new window.Event(name, { bubbles: true, cancelable: true }));
  return { document, window, el, event, requests, storage, respond(next: typeof handler) { handler = next; }, grants(rows: typeof grants) { grants = rows; } };
}
void test('member responses are displayed as text and a validation failure preserves the typed email', async () => {
  const f = fixture();await settled(() => !f.el('add').disabled);
  f.respond(async (_url, options) => options.method ? Response.json({ error: '邮箱格式无效', code: 'INVALID_ACCESS_REQUEST' }, { status: 400 }) : Response.json({ owner: { email: 'owner@example.com', automaticAccess: true }, grants: [] }));
  f.el('email').value = 'wrong@example.com';f.event('form', 'submit');await settled(() => f.el('status').textContent?.includes('邮箱格式无效') === true);
  assert.equal(f.el('email').value, 'wrong@example.com');assert.equal(f.el('add').disabled, false);assert.equal(f.storage.size, 0);
  f.grants([{ ...original, email: '<img src=x onerror=alert(1)>@example.com' }]);
  f.respond(async () => Response.json({ owner: { email: 'owner@example.com', automaticAccess: true }, grants: [{ ...original, email: '<img src=x onerror=alert(1)>@example.com' }] }));
  f.event('refresh');await settled(() => f.el('list').textContent?.includes('<img') === true);assert.equal(f.el('list').querySelector('img'), null);
});
void test('uncertain writes retain one operation ID and a manual retry confirms exactly the same request', async () => {
  const f = fixture();await settled(() => !f.el('add').disabled);let attempts = 0;
  f.respond(async (_url, options) => { if (!options.method) return Response.json({ owner: { email: 'owner@example.com', automaticAccess: true }, grants: [original] }); if (++attempts === 1) throw new Error('transport interrupted'); return Response.json({ grant: original, replayed: true }); });
  f.el('email').value = 'member@example.com';f.event('form', 'submit');await settled(() => !f.el('pending').hidden && !f.el('resume').disabled);
  assert.equal(f.el('email').disabled, true);assert.equal(f.storage.size, 1);
  f.event('resume');await settled(() => f.el('pending').hidden && !f.el('add').disabled);
  const mutations = f.requests.filter((row) => row.options.method === 'POST');assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0].body, mutations[1].body);assert.equal((mutations[0].options.headers as Record<string, string>)['Idempotency-Key'], (mutations[1].options.headers as Record<string, string>)['Idempotency-Key']);
  assert.equal((mutations[0].options.headers as Record<string, string>)['X-Page-Owner'], 'site-owner');assert.equal(f.storage.size, 0);
});
void test('a version conflict refreshes the list without automatically submitting another status operation', async () => {
  const f = fixture();await settled(() => !f.el('add').disabled);
  f.respond(async (_url, options) => options.method ? Response.json({ error: '状态已变化', code: 'ACCESS_GRANT_CONFLICT' }, { status: 409 }) : Response.json({ owner: { email: 'owner@example.com', automaticAccess: true }, grants: [{ ...original, status: 'revoked', revision: 2 }] }));
  f.el('list').querySelector('button')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));await settled(() => f.el('status').textContent?.includes('核对最新状态') === true);
  assert.equal(f.requests.filter((row) => row.options.method === 'PATCH').length, 1);assert.match(f.el('list').textContent!, /恢复访问/);assert.equal(f.storage.size, 0);
});
void test('account changes lock the settings and preserve the original owner pending operation bytes', async () => {
  const storage = new Map<string, string>(), f = fixture('owner-one', storage);await settled(() => !f.el('add').disabled);
  f.respond(async () => Response.json({ error: '登录账号已变化', code: 'ACCOUNT_CHANGED' }, { status: 401 }));
  f.el('email').value = 'member@example.com';f.event('form', 'submit');await settled(() => f.el('status').textContent?.includes('原操作仍保留') === true);
  assert.equal(f.el('add').disabled, true);assert.equal(f.el('resume').disabled, true);assert.equal(f.el('list').children.length, 0);assert.equal(storage.size, 1);
  const pendingBefore = [...storage.values()][0], other = fixture('owner-two', storage);await settled(() => !other.el('add').disabled);
  assert.equal(other.el('pending').hidden, true);assert.equal([...storage.values()][0], pendingBefore);
  const originalOwner = fixture('owner-one', storage);await settled(() => !originalOwner.el('resume').disabled);
  assert.equal(originalOwner.el('pending').hidden, false);assert.equal(originalOwner.requests.filter((row) => row.options.method).length, 0);assert.equal([...storage.values()][0], pendingBefore);
});
