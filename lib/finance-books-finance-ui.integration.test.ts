import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderFinanceApp } from '../finance-ui.ts';

const ACTOR = 'shared-finance-editor';
const BOOK = '11111111-1111-4111-8111-111111111111';
const SHARED_PATH = '/finance?ledger=family&currency=CNY&book=' + BOOK + '&bookRevision=3';
const own = { id: 'own', name: '我的家庭账本', ownerName: '本人', role: 'owner', accessRevision: 0, canManageMembers: true, canExport: true };
const shared = { id: BOOK, name: '家人的家庭账本', ownerName: '家人', role: 'editor', accessRevision: 3, canManageMembers: false, canExport: false };
type Pending = { key: string; ownerId: string; path: string; body: Record<string, string> };
type Write = { path: string; key: string; body: Record<string, string> };
function sessionStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem(key: string, value: string) { values.set(key, value); }, removeItem(key: string) { values.delete(key); } };
}
function server() {
  const state = { loseNextResponse: true, revoke: false };
  const writes: Write[] = [];
  const operations = new Map<string, { account: Record<string, string>; balances: unknown[] }>();
  const reads: string[] = [];
  const fetch = async (path: string, options: RequestInit = {}) => {
    const url = new URL(path, 'https://finance.example');
    if (!options.method || options.method === 'GET') {
      reads.push(path);
      if (url.pathname === '/api/finance/books') return Response.json({ books: [own, shared], invitations: [] });
      assert.equal(url.pathname, '/api/finance');
      return Response.json({ ledger: url.searchParams.get('ledger') ?? 'personal', accounts: [], summary: { byCurrency: {} }, meta: { today: '2026-11-13' } });
    }
    assert.equal(options.method, 'POST'); assert.equal(url.pathname, '/api/finance/accounts');
    const key = new Headers(options.headers).get('Idempotency-Key'); assert.ok(key); assert.equal(typeof options.body, 'string');
    const body = JSON.parse(options.body as string) as Record<string, string>;
    writes.push({ path, key, body });
    if (state.revoke) return Response.json({ error: '此家庭账本的访问权限已撤销', code: 'FINANCE_BOOK_ACCESS_REVOKED' }, { status: 403 });
    if (!operations.has(key)) operations.set(key, { account: { id: key, ...body }, balances: [] });
    if (state.loseNextResponse) { state.loseNextResponse = false; throw new Error('Synthetic connection lost after commit'); }
    return Response.json(operations.get(key), { status: 201 });
  };
  return { state, writes, reads, fetch, operations };
}
async function settled(check: () => boolean) {
  for (let index = 0; index < 80; index++) { if (check()) return; await new Promise<void>((done) => setImmediate(done)); }
  assert.ok(check(), 'Shared finance integration did not settle');
}
function fixture(path: string, storage: ReturnType<typeof sessionStorage>, service: ReturnType<typeof server>) {
  const { window, document } = parseHTML(renderFinanceApp(ACTOR));
  const location = new URL(path, 'https://finance.example');
  Object.assign(location, { assign(value: string) { location.href = new URL(value, location).href; }, replace(value: string) { location.href = new URL(value, location).href; } });
  const history = { state: null, replaceState(_state: unknown, _title: string, value: string) { location.href = new URL(value, location).href; } };
  Object.defineProperty(window, 'sessionStorage', { value: storage, configurable: true });
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? this.querySelector('option')?.getAttribute('value') ?? ''; },
    set(value: string) { this.querySelectorAll('option').forEach((option: Element) => option.toggleAttribute('selected', option.getAttribute('value') === value)); },
  });
  document.querySelectorAll('dialog').forEach((dialog) => {
    Object.defineProperty(dialog, 'open', { configurable: true, get() { return dialog.hasAttribute('open'); } });
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reportValidity() { return true; }, reset() { form.querySelectorAll('input,textarea').forEach((field) => { (field as unknown as HTMLInputElement).value = field.getAttribute('value') ?? ''; }); } }));
  document.querySelectorAll('input').forEach((input) => Object.assign(input, { select() {} }));
  const transport = (url: string | URL, options: RequestInit = {}) => service.fetch(String(url), options);
  Object.assign(window, { location, history, fetch: transport, JiashuAccountSession: { request: transport } });
  const timer = (callback: (...args: unknown[]) => void, delay: number) => { const handle = setTimeout(callback, delay); handle.unref(); return handle; };
  const sandbox = { document, window, location, history, URL, URLSearchParams, Headers, Response, AbortController, Intl, Date, crypto: webcrypto, queueMicrotask, setTimeout: timer, clearTimeout, Event: window.Event };
  // Browser globals reference the same fetch that the book component installs.
  Object.defineProperty(sandbox, 'fetch', { configurable: true, get() { return window.fetch; } });
  const context = createContext(sandbox);
  const scripts = [...document.querySelectorAll('script')].map((script) => script.textContent ?? '').filter((source) => source.includes('JiashuFinanceBooks?.document') || source.includes('const ledgerLabels='));
  assert.equal(scripts.length, 2, 'Execute the actual book component and basic finance renderer scripts, without sidebar scripts');
  for (const [index, source] of scripts.entries()) runInContext(source, context, { filename: 'shared-finance-inline-' + index + '.js' });
  const el = (id: string) => document.getElementById(id)! as unknown as HTMLInputElement;
  const click = (id: string) => el(id).dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const submit = () => el('account-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const create = () => { click('add-account'); el('account-name').value = '共享家庭银行账户'; el('account-amount').value = '250.00'; el('account-date').value = '2026-11-13'; el('account-note').value = '只属于原家庭账本'; };
  const client = (window as unknown as { JiashuFinanceBooks: { blocked: boolean; scopeKey(): string } }).JiashuFinanceBooks;
  return { document, el, click, submit, create, client };
}
function originalPending(storage: ReturnType<typeof sessionStorage>) {
  assert.equal(storage.values.size, 1);
  const [storageKey, raw] = [...storage.values.entries()][0];
  return { storageKey, raw, operation: JSON.parse(raw) as Pending };
}

void test('lost shared account creation retains its original book path, stays dormant on refresh and cannot restore into the actor own book', async () => {
  const storage = sessionStorage(), service = server();
  const first = fixture(SHARED_PATH, storage, service); await settled(() => first.el('status-banner').hidden === true);
  first.create(); first.submit(); await settled(() => service.writes.length === 1 && first.el('account-error').hidden === false);
  const saved = originalPending(storage);
  assert.match(saved.storageKey, new RegExp(':scope:' + encodeURIComponent(BOOK + ':3') + '$'));
  assert.equal(saved.operation.ownerId, ACTOR); assert.equal(saved.operation.path, '/api/finance/accounts?book=' + BOOK + '&bookRevision=3');
  assert.equal(saved.operation.body.ledger, 'family'); assert.equal(saved.operation.body.name, '共享家庭银行账户');
  assert.equal(saved.operation.key, service.writes[0].key); assert.equal(saved.operation.path, service.writes[0].path); assert.deepEqual(saved.operation.body, service.writes[0].body);
  const refreshed = fixture(SHARED_PATH, storage, service); await settled(() => refreshed.el('status-banner').hidden === true);
  assert.equal(service.writes.length, 1); assert.equal(refreshed.el('finance-pending').hidden, false); assert.equal(storage.values.get(saved.storageKey), saved.raw);
  const mine = fixture('/finance?ledger=family&currency=CNY', storage, service); await settled(() => mine.el('status-banner').hidden === true);
  assert.equal(mine.el('finance-pending').hidden, true); assert.equal(mine.client.scopeKey(), ''); assert.equal(service.writes.length, 1); assert.equal(storage.values.get(saved.storageKey), saved.raw);
  refreshed.click('finance-resume'); assert.equal(refreshed.el('account-dialog').hasAttribute('open'), true);
  refreshed.el('account-name').value = '不能改投到此名称'; refreshed.submit();
  await settled(() => service.writes.length === 2 && storage.values.size === 0);
  assert.deepEqual(service.writes[1], service.writes[0]); assert.equal(service.operations.size, 1); assert.equal(refreshed.el('account-dialog').hasAttribute('open'), false);
});

void test('revocation while confirming a frozen shared request locks dialogs and retains exact pending bytes across later synthetic submits', async () => {
  const storage = sessionStorage(), service = server();
  const first = fixture(SHARED_PATH, storage, service); await settled(() => first.el('status-banner').hidden === true);
  first.create(); first.submit(); await settled(() => service.writes.length === 1 && first.el('account-error').hidden === false);
  const saved = originalPending(storage);
  const recovered = fixture(SHARED_PATH, storage, service); await settled(() => recovered.el('status-banner').hidden === true);
  assert.equal(service.writes.length, 1); recovered.click('finance-resume'); assert.equal(recovered.el('account-dialog').hasAttribute('open'), true);
  service.state.revoke = true; recovered.submit();
  await settled(() => service.writes.length === 2 && recovered.client.blocked && recovered.el('account-dialog').dataset.busy !== '1');
  assert.equal(recovered.document.documentElement.hasAttribute('data-finance-book-blocked'), true);
  assert.equal(recovered.el('account-dialog').hasAttribute('open'), false, 'The rejected retry must not reopen the closed dialog in its catch or finally branches');
  assert.equal(storage.values.get(saved.storageKey), saved.raw); assert.deepEqual(JSON.parse(storage.values.get(saved.storageKey)!), saved.operation);
  assert.deepEqual(service.writes[1], service.writes[0]); assert.equal(service.operations.size, 1);
  assert.match(recovered.el('account-list').textContent ?? '', /访问权限已变化/);
  recovered.click('finance-resume'); recovered.click('add-account'); recovered.submit();
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(service.writes.length, 2); assert.equal(recovered.el('account-dialog').hasAttribute('open'), false); assert.equal(storage.values.get(saved.storageKey), saved.raw);
});
