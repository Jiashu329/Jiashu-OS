import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderFinanceBooksControl, renderFinanceBooksScript } from './finance-books-ui.ts';

const BOOK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const INVITATION = '33333333-3333-4333-8333-333333333333';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const own = { id: 'own', name: '我的家庭账本', ownerName: '本人', role: 'owner', accessRevision: 0, canManageMembers: true, canExport: true };
const shared = { id: BOOK, name: '共同生活账本', ownerName: '家人', role: 'editor', accessRevision: 3, canManageMembers: false, canExport: false };
const invitation = { id: INVITATION, bookId: OTHER, bookName: '另一家庭账本', ownerName: '邀请人', email: 'member@example.invalid', revision: 2, expiresAt: '2026-12-13T00:00:00.000Z' };
type Book = typeof own & { canWrite?: boolean };
type Metadata = { books: Book[]; invitations: typeof invitation[] };
type Client = { ready(): Promise<unknown>; scopeKey(): string; scopedUrl(path: string): string; current: Book | null; blocked: boolean; needsReload: boolean; canWrite(): boolean };
type RequestRow = { url: string; method: string; body: unknown; headers: Headers };
type Handler = (url: string, options: RequestInit) => Promise<Response>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function settled(check: () => boolean) {
  for (let count = 0; count < 70; count++) { if (check()) return; await new Promise<void>((done) => setImmediate(done)); }
  assert.ok(check(), 'Finance books UI did not settle');
}
function fixture(path = '/finance?ledger=family&currency=CNY', initial: Metadata = { books: [own, shared], invitations: [] }, content = '') {
  const { document, window } = parseHTML('<!doctype html><html><body>' + renderFinanceBooksControl() + content + '</body></html>');
  const current = new URL(path, 'https://finance.example');
  const assignments: string[] = []; const replacements: string[] = [];
  const location = {
    get href() { return current.href; }, get pathname() { return current.pathname; }, get search() { return current.search; }, get origin() { return current.origin; },
    assign(value: string) { assignments.push(new URL(value, current).href); },
    replace(value: string) { replacements.push(new URL(value, current).href); },
  };
  const history = { state: null, replaceState(_state: unknown, _title: string, value: string) { current.href = new URL(value, current).href; } };
  document.querySelectorAll('select').forEach((select) => Object.defineProperty(select, 'value', { configurable: true, writable: true, value: 'own' }));
  document.querySelectorAll('dialog').forEach((dialog) => {
    Object.defineProperty(dialog, 'open', { configurable: true, get() { return dialog.hasAttribute('open'); } });
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reportValidity() { return true; }, reset() { form.querySelectorAll('input').forEach((input) => { input.value = ''; }); } }));
  const originalPending = '{"scope":"original-family","body":{"amount":"42.00"}}';
  const stored = new Map([['old-pending', originalPending]]);
  const storage = { getItem(key: string) { return stored.get(key) ?? null; }, setItem(key: string, value: string) { stored.set(key, value); }, removeItem(key: string) { stored.delete(key); } };
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storage });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  const requests: RequestRow[] = [];
  let metadata = initial;
  let handler: Handler = async (url) => url === '/api/finance/books' ? Response.json(metadata) : url === '/api/finance/books/own/members' ? Response.json({ book: own, members: [] }) : Response.json({ ok: true });
  const transport = async (input: string | URL, options: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, method: options.method ?? 'GET', body: typeof options.body === 'string' ? JSON.parse(options.body) as unknown : null, headers: new Headers(options.headers) });
    return handler(url, options);
  };
  const accountSession = { request: transport };
  Object.assign(window, { fetch: transport, JiashuAccountSession: accountSession, location, history });
  const source = renderFinanceBooksScript('actor-one').replace(/^<script(?: type="module")?>/, '').replace(/<\/script>$/, '');
  runInNewContext(source, { document, window, location, history, fetch: transport, URL, URLSearchParams, Headers, Response, AbortController, crypto: webcrypto, Date, Intl, Event: window.Event, CustomEvent: window.CustomEvent, queueMicrotask, setTimeout, clearTimeout });
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const el = (id: string) => document.getElementById('finance-books-' + id)! as unknown as HTMLInputElement;
  const event = (id: string, kind = 'click') => el(id).dispatchEvent(new window.Event(kind, { bubbles: true, cancelable: true }));
  const click = (element: Element) => element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const client = (window as unknown as { JiashuFinanceBooks: Client }).JiashuFinanceBooks;
  return { document, window, location, history, assignments, replacements, el, event, click, client, requests, stored, originalPending, accountSession,
    fetch: (url: string, options?: RequestInit) => (window.fetch as unknown as typeof transport)(url, options),
    respond(next: Handler) { handler = next; }, metadata(value: Metadata) { metadata = value; }, writes: () => requests.filter((row) => row.method !== 'GET') };
}

void test('management starts hidden and owner invitations and revocations require explicit actions', async () => {
  const { document } = parseHTML(renderFinanceBooksControl());
  assert.equal(document.getElementById('finance-books-manage')?.hidden, true);
  const f = fixture(); await f.client.ready();
  assert.equal(f.el('manage').hidden, false); assert.equal(f.writes().length, 0);
  f.event('manage'); await settled(() => f.requests.some((row) => row.url === '/api/finance/books/own/members') && !f.el('invite-submit').disabled);
  assert.equal(f.el('dialog').hasAttribute('open'), true); assert.equal(f.writes().length, 0);
  f.respond(async (url, options) => options.method === 'POST' ? Response.json({ invitation }) : url === '/api/finance/books/own/members' ? Response.json({ book: own, members: [] }) : Response.json({ books: [own, shared], invitations: [] }));
  f.el('email').value = 'member@example.invalid'; f.event('invite-form', 'submit');
  await settled(() => f.writes().length === 1);
  assert.equal(f.writes()[0].url, '/api/finance/books/own/invitations'); assert.deepEqual(f.writes()[0].body, { email: 'member@example.invalid' });
  assert.match(f.writes()[0].headers.get('Idempotency-Key') ?? '', uuid);
  assert.match(f.el('dialog').textContent ?? '', /网站访问权限|访问网站/);
  await settled(() => !f.el('invite-submit').disabled && f.el('dialog-status').textContent?.includes('邀请已创建') === true);
  const member = { id: MEMBER, email: 'member@example.invalid', status: 'active', revision: 6, expiresAt: null };
  f.event('dialog-close');
  f.respond(async () => Response.json({ book: own, members: [member] })); f.event('manage');
  await settled(() => !f.el('invite-submit').disabled && Boolean(f.document.querySelector('[data-finance-member-revoke]')));
  assert.equal(f.writes().length, 1);
  f.respond(async (_url, options) => options.method === 'POST' ? Response.json({ member: { ...member, status: 'revoked', revision: 7 } }) : Response.json({ book: own, members: [{ ...member, status: 'revoked', revision: 7 }] }));
  f.click(f.document.querySelector('[data-finance-member-revoke="' + MEMBER + '"]')!);
  await settled(() => f.writes().length === 2 && !f.el('invite-submit').disabled);
  assert.equal(f.writes()[1].url, '/api/finance/books/own/members/' + MEMBER);
  assert.deepEqual(f.writes()[1].body, { action: 'revoke', expectedRevision: 6 }); assert.match(f.writes()[1].headers.get('Idempotency-Key') ?? '', uuid);
});

void test('own-ledger SPA navigation updates collaboration visibility while editors cannot trigger management', async () => {
  const mine = fixture('/finance?ledger=personal&currency=USD'); await mine.client.ready();
  assert.equal(mine.el('control').hidden, true); assert.equal(mine.el('manage').hidden, true);
  mine.history.replaceState(null, '', '/finance?ledger=family&currency=USD'); mine.window.dispatchEvent(new mine.window.Event('jiashu-navigation'));
  assert.equal(mine.el('control').hidden, false); assert.equal(mine.el('manage').hidden, false); assert.equal(mine.client.scopeKey(), '');
  mine.history.replaceState(null, '', '/finance?ledger=personal&currency=USD'); mine.document.body.dispatchEvent(new mine.window.Event('click', { bubbles: true }));
  await settled(() => mine.el('control').hidden === true); assert.equal(mine.el('manage').hidden, true); assert.equal(mine.writes().length, 0);
  const f = fixture('/finance?ledger=family&book=' + BOOK + '&bookRevision=3'); await f.client.ready();
  assert.equal(f.el('manage').hidden, true); assert.equal(f.client.current?.id, BOOK);
  f.event('manage'); f.el('email').value = 'other@example.invalid'; f.event('invite-form', 'submit');
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.writes().length, 0); assert.equal(f.requests.some((row) => row.url.endsWith('/members')), false);
});

void test('received invitations require explicit acceptance and send the invitation revision without selecting a book', async () => {
  const f = fixture('/finance?ledger=family', { books: [own], invitations: [invitation] }); await f.client.ready();
  assert.equal(f.writes().length, 0); assert.match(f.el('invitations').textContent ?? '', /另一家庭账本/);
  f.respond(async (_url, options) => options.method === 'POST' ? Response.json({ accepted: true }) : Response.json({ books: [own, { ...shared, id: OTHER }], invitations: [] }));
  const accept = f.document.querySelector('[data-finance-invitation="accept"][data-invitation-id="' + INVITATION + '"]'); assert.ok(accept); f.click(accept);
  await settled(() => f.writes().length === 1 && f.requests.filter((row) => row.url === '/api/finance/books').length > 1);
  assert.equal(f.writes()[0].url, '/api/finance/books/invitations/' + INVITATION + '/respond');
  assert.deepEqual(f.writes()[0].body, { action: 'accept', expectedRevision: 2 }); assert.match(f.writes()[0].headers.get('Idempotency-Key') ?? '', uuid);
  assert.equal(f.assignments.length, 0); assert.equal(f.client.scopeKey(), '');
});

void test('fixed shared scope reaches both fetch and account transport while explicit targets, personal and management URLs stay intact', async () => {
  const ownerRevisionZero = fixture('/finance?ledger=family&book=' + BOOK + '&bookRevision=0', { books: [own, { ...shared, role: 'owner', accessRevision: 0 }], invitations: [] }); await ownerRevisionZero.client.ready();
  assert.equal(ownerRevisionZero.client.scopeKey(), BOOK + ':0'); assert.equal(ownerRevisionZero.client.blocked, false); assert.equal(ownerRevisionZero.replacements.length, 0);
  const missingRevision = fixture('/finance?ledger=family&book=' + BOOK); await missingRevision.client.ready();
  assert.equal(missingRevision.client.scopeKey(), BOOK + ':missing'); assert.equal(missingRevision.client.blocked, true); assert.equal(missingRevision.client.needsReload, true); assert.equal(missingRevision.replacements.length, 1); assert.equal(new URL(missingRevision.replacements[0]).searchParams.get('bookRevision'), '3');
  const f = fixture('/finance?ledger=family&book=' + BOOK + '&bookRevision=3'); await f.client.ready();
  assert.equal(f.client.scopeKey(), BOOK + ':3');
  const scoped = new URL(f.client.scopedUrl('/api/finance?ledger=family'), f.location.href);
  assert.equal(scoped.searchParams.get('book'), BOOK); assert.equal(scoped.searchParams.get('bookRevision'), '3');
  const explicit = '/api/finance/accounts?book=' + OTHER + '&bookRevision=7'; assert.equal(f.client.scopedUrl(explicit), explicit);
  for (const url of ['/api/finance?ledger=personal', '/api/finance/books', '/api/finance/books/own/members', '/api/backup', '/api/health']) assert.equal(f.client.scopedUrl(url), url);
  await f.fetch('/api/finance/accounts/synthetic'); await f.accountSession.request('/api/finance/runway?ledger=family&currency=CNY');
  for (const row of f.requests.slice(-2)) { const url = new URL(row.url, f.location.href); assert.equal(url.searchParams.get('book'), BOOK); assert.equal(url.searchParams.get('bookRevision'), '3'); }
});

void test('selecting a different book follows a guarded page link and leaves original pending storage unchanged', async () => {
  const f = fixture('/finance/review?ledger=family&currency=USD&month=2026-10&book=' + BOOK + '&bookRevision=3', { books: [own, shared, { ...shared, id: OTHER, accessRevision: 7 }], invitations: [] }); await f.client.ready();
  const guarded: string[] = [];
  f.document.addEventListener('click', (event) => { const link = (event.target as Element | null)?.closest('a[href]'); if (link) { guarded.push(link.getAttribute('href')!); event.preventDefault(); } }, true);
  f.el('select').value = OTHER; f.event('select', 'change');
  assert.equal(guarded.length, 1); const target = new URL(guarded[0], f.location.href);
  assert.equal(target.pathname, '/finance/review'); assert.equal(target.searchParams.get('ledger'), 'family'); assert.equal(target.searchParams.get('book'), OTHER); assert.equal(target.searchParams.get('bookRevision'), '7'); assert.equal(target.searchParams.get('currency'), 'USD');
  assert.equal(f.assignments.length, 0); assert.equal(f.stored.get('old-pending'), f.originalPending); assert.equal(f.client.scopeKey(), BOOK + ':3');
});

void test('revoked and changed access preserve the real error response, lock the original scope and never alter pending bytes', async () => {
  for (const [code, status] of [['FINANCE_BOOK_ACCESS_REVOKED', 403], ['FINANCE_BOOK_ACCESS_CHANGED', 409]] as const) {
    const f = fixture('/finance?ledger=family&book=' + BOOK + '&bookRevision=3'); await f.client.ready();
    const changes: string[] = []; f.document.addEventListener('jiashu-finance-book-blocked', (event) => { changes.push((event as unknown as CustomEvent<{ code: string }>).detail.code); });
    f.respond(async () => Response.json({ error: '原账本权限发生变化', code, diagnostic: 'unchanged' }, { status }));
    const response = await f.fetch('/api/finance?ledger=family'); assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: '原账本权限发生变化', code, diagnostic: 'unchanged' });
    assert.equal(f.client.blocked, true); assert.deepEqual(changes, [code]); assert.equal(f.client.scopeKey(), BOOK + ':3'); assert.equal(f.stored.get('old-pending'), f.originalPending);
    f.respond(async () => Response.json({ personal: 'still available' }));
    const personal = await f.fetch('/api/finance?ledger=personal'); assert.equal(personal.status, 200); assert.deepEqual(await personal.json(), { personal: 'still available' });
    assert.equal(f.requests.at(-1)?.url, '/api/finance?ledger=personal'); assert.equal(f.client.blocked, true); assert.deepEqual(changes, [code]);
  }
});


void test('viewer metadata creates a read-only scope that preserves navigation and reads while stopping every finance mutation transport', async () => {
  const viewer = { ...shared, role: 'viewer', canWrite: false };
  const content = '<main><button id="add-account">添加</button><button data-create>添加空账户</button><button data-action="detail">详情</button><button data-action="edit">编辑</button><button data-balance-change="correct">更正</button><button id="finance-goals-add">新增目标</button><button data-goal-action="archive">归档目标</button><button id="runway-save">保存储备</button><button id="review-close-confirm">确认月结</button><button id="balance-check-save">保存余额</button><button id="retry">重试读取</button><select id="view-currency"><option>CNY</option></select><form id="runway-form"><input id="runway-expense" value="1000"></form></main>';
  const f = fixture('/finance?ledger=family&book=' + BOOK + '&bookRevision=3', { books: [own, viewer], invitations: [] }, content);
  await f.client.ready();
  assert.equal(f.client.canWrite(), false); assert.equal(f.client.blocked, false);
  assert.equal(f.document.documentElement.hasAttribute('data-finance-readonly'), true);
  assert.equal(f.el('readonly').hidden, false); assert.match(f.el('status').textContent ?? '', /只读权限/);
  for (const selector of ['#add-account','[data-create]','[data-action="edit"]','[data-balance-change]','#finance-goals-add','[data-goal-action]','#runway-save','#review-close-confirm','#balance-check-save']) assert.equal(f.document.querySelector(selector)?.hasAttribute('data-finance-write'), true, selector);
  for (const selector of ['[data-action="detail"]','#retry','#view-currency']) assert.equal(f.document.querySelector(selector)?.hasAttribute('data-finance-write'), false, selector);
  assert.equal((f.document.getElementById('runway-expense') as HTMLInputElement).disabled, true);
  const late=f.document.createElement('input');late.setAttribute('data-check-amount','newly-rendered');f.document.querySelector('main')!.appendChild(late);
  await settled(()=>late.disabled===true);late.disabled=false;await settled(()=>late.disabled===true);
  const lateAction=f.document.createElement('button');lateAction.setAttribute('data-goal-action','edit');f.document.querySelector('main')!.appendChild(lateAction);
  await settled(()=>lateAction.hasAttribute('data-finance-write'));
  assert.equal(f.el('select').disabled, false); assert.equal(f.el('refresh').disabled, false);
  await f.fetch('/api/finance?ledger=family');
  await assert.rejects(f.fetch('/api/finance/accounts', { method: 'POST' }), (error: unknown) => (error as { code: string }).code === 'FINANCE_BOOK_READ_ONLY');
  await assert.rejects(f.accountSession.request('/api/finance/runway?ledger=family', { method: 'PUT' }), (error: unknown) => (error as { code: string }).code === 'FINANCE_BOOK_READ_ONLY');
  assert.equal(f.writes().length, 0); assert.equal(f.stored.get('old-pending'), f.originalPending);
  assert.equal((await f.fetch('/api/finance?ledger=personal', { method:'POST' })).status, 200, 'personal operations retain their independent account scope');
});

void test('owners explicitly choose read-only invitations and save a revised member role without automatic writes', async () => {
  const f = fixture(); await f.client.ready(); f.event('manage');
  await settled(() => !f.el('invite-submit').disabled);
  f.el('invite-role').value='viewer';f.el('email').value='reader@example.invalid';
  f.respond(async (url, options) => options.method==='POST'?Response.json({invitation}):url.endsWith('/members')?Response.json({book:own,members:[]}):Response.json({books:[own,shared],invitations:[]}));
  f.event('invite-form','submit');await settled(()=>f.writes().length===1&&!f.el('invite-submit').disabled);
  assert.deepEqual(f.writes()[0].body,{email:'reader@example.invalid',role:'viewer'});
  const member={id:MEMBER,email:'reader@example.invalid',status:'active',revision:6,role:'viewer',expiresAt:null};
  f.event('dialog-close');f.respond(async()=>Response.json({book:own,members:[member]}));f.event('manage');
  await settled(()=>!f.el('invite-submit').disabled&&Boolean(f.document.querySelector('[data-finance-member-role]')));
  assert.match(f.el('members').textContent??'',/只读/);
  const select=f.document.querySelector('[data-finance-member-role-select]')!;
  Object.defineProperty(select,'value',{configurable:true,writable:true,value:'editor'});
  f.respond(async(_url,options)=>options.method==='POST'?Response.json({member:{...member,role:'editor',revision:7}}):Response.json({book:own,members:[{...member,role:'editor',revision:7}]}));
  assert.equal(f.writes().length,1);f.click(f.document.querySelector('[data-finance-member-role]')!);
  await settled(()=>f.writes().length===2&&!f.el('invite-submit').disabled);
  assert.deepEqual(f.writes()[1].body,{action:'role',role:'editor',expectedRevision:6});assert.match(f.writes()[1].headers.get('Idempotency-Key')??'',uuid);
});
