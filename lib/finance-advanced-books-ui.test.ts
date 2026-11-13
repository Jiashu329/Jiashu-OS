import assert from 'node:assert/strict';
import test from 'node:test';
import { compileFunction, runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { parseHTML } from 'linkedom';
import { renderFinanceGoalsPage } from '../finance-goals-page.ts';
import { renderFinanceRunwayPage } from '../finance-runway-page.ts';
import { renderBalanceCheckPage } from '../finance-balance-check-page.ts';
import { renderFinanceReviewPage } from '../finance-review-page.ts';
import { buildFinanceReview, parseFinanceReviewQuery } from './finance-review.ts';
import { CURRENCIES, todayShanghai } from './finance.ts';

const BOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = 'synthetic-actor';
const SCOPE = BOOK + ':3';
const NOW = '2026-11-13T03:00:00.000Z';
const account = { id: ACCOUNT, ledger: 'family', name: '合成共享账户', currency: 'CNY', type: 'bank', balanceMinor: '10000', asOfDate: '2026-11-13', archivedAt: null, liquidityKind: 'liquid', usableBps: 10000 };
type Page = 'goals' | 'runway' | 'balances' | 'review';
const prefixes: Record<Page, string> = { goals: 'finance-goals', runway: 'runway', balances: 'balance-check', review: 'review' };
const renderers = { goals: renderFinanceGoalsPage, runway: renderFinanceRunwayPage, balances: renderBalanceCheckPage, review: renderFinanceReviewPage };
async function settle(check: () => boolean) {
  for (let count = 0; count < 100; count++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'Advanced finance UI did not settle');
}
function fixture(page: Page, options: { shared?: boolean; pending?: Map<string, string> } = {}) {
  const shared = options.shared !== false;
  const { document, window } = parseHTML(renderers[page](OWNER));
  const current = new URL('/finance/' + page + '?ledger=family&currency=CNY&month=2026-10' + (shared ? '&book=' + BOOK + '&bookRevision=3' : ''), 'https://finance.example');
  const navigations: string[] = [];
  const location = { get href() { return current.href; }, get pathname() { return current.pathname; }, get search() { return current.search; }, get hash() { return current.hash; }, get origin() { return current.origin; }, assign(value: string) { navigations.push(new URL(value, current).href); } };
  const history = { replaceState(_state: unknown, _title: string, value: string) { current.href = new URL(value, current).href; } };
  document.querySelectorAll('select').forEach((select) => Object.defineProperty(select, 'value', { configurable: true, writable: true, value: select.querySelector('option')?.getAttribute('value') ?? '' }));
  document.querySelectorAll('dialog').forEach((dialog) => {
    Object.defineProperty(dialog, 'open', { configurable: true, get() { return dialog.hasAttribute('open'); } });
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reset() {}, reportValidity() { return true; }, requestSubmit() { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); } }));
  document.addEventListener('click', (event) => { const link = (event.target as Element | null)?.closest('a[href]'); if (link) { navigations.push(new URL(link.getAttribute('href')!, current).href); event.preventDefault(); } }, true);
  const stored = options.pending ?? new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem(key: string, value: string) { stored.set(key, value); }, removeItem(key: string) { stored.delete(key); } };
  const client = {
    current: { id: shared ? BOOK : 'own', role: shared ? 'editor' : 'owner', accessRevision: shared ? 3 : 0 }, blocked: false, needsReload: false,
    ready() { return Promise.resolve(this.current); }, scopeKey() { return shared ? SCOPE : ''; },
    scopedUrl(path: string) { const url = new URL(path, current); if (shared && /^\/(?:api\/)?finance(?:\/|$)/.test(url.pathname) && url.searchParams.get('ledger') !== 'personal' && !url.searchParams.has('book')) { url.searchParams.set('book', BOOK); url.searchParams.set('bookRevision', '3'); } return url.pathname + url.search + url.hash; },
  };
  const selection = parseFinanceReviewQuery(new URLSearchParams('ledger=family&currency=CNY&month=2026-10'), new Date(NOW));
  const review = buildFinanceReview([{ accountId: ACCOUNT, name: account.name, type: 'bank', ledger: 'family', currency: 'CNY', archivedAt: null }], [{ accountId: ACCOUNT, amountMinor: '10000', asOfDate: '2026-10-31', sequence: 1 }], selection);
  const calls: Array<{ url: URL; method: string; body: unknown }> = [];
  let failure = '';
  const fetch = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, current); const method = init.method ?? 'GET';
    calls.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null });
    if (method !== 'GET') {
      if (failure === 'network') throw new Error('Synthetic interrupted connection');
      if (failure) { client.blocked = true; document.dispatchEvent(new window.CustomEvent('jiashu-finance-book-blocked', { detail: { code: failure } })); return Response.json({ code: failure, error: '共享账本权限已改变' }, { status: failure === 'FINANCE_BOOK_ACCESS_REVOKED' ? 403 : 409 }); }
      return Response.json({ account, goal: { id: ACCOUNT, ledger: 'family', currency: 'CNY' } });
    }
    if (url.pathname === '/api/finance/goals') return Response.json({ ledger: 'family', currency: 'CNY', today: '2026-11-13', goals: [], accounts: [account] });
    if (url.pathname === '/api/finance/runway') return Response.json({ ledger: 'family', currency: 'CNY', revision: 1, accounts: [account], settings: { monthlyExpenseAmount: '100.00', monthlyExpenseMinor: '10000', targetMonths: 6, accountIds: [ACCOUNT], revision: 1 }, progress: null });
    if (url.pathname === '/api/finance/review') return Response.json({ ...review, close: { state: 'draft', version: 0, latestVersion: 0, canClose: true, currentToday: '2026-11-13', previewHash: 'a'.repeat(64), versions: [] } });
    return Response.json({ ledger: 'family', accounts: [account], meta: { today: '2026-11-13' } });
  };
  // The collaboration component owns the common transport wrapper; its real
  // scope and error behavior has separate tests in finance-books-ui.test.ts.
  const scopedFetch = (path: string, init?: RequestInit) => fetch(client.scopedUrl(path), init);
  Object.assign(window, { JiashuFinanceBooks: client, fetch: scopedFetch, location, history });
  const marker = page === 'review' ? "document.getElementById('monthly-review')" : "document.getElementById('" + prefixes[page] + "-'";
  const source = [...document.querySelectorAll('script')].find((script) => script.textContent?.includes(marker))?.textContent;
  assert.ok(source, 'Rendered advanced page must include its real script');
  runInNewContext(source, { document, window, location, history, fetch: scopedFetch, sessionStorage: storage, URL, URLSearchParams, Headers, Response, AbortController, Date, Intl, crypto, navigator: {}, queueMicrotask, setTimeout, clearTimeout, Event: window.Event, CustomEvent: window.CustomEvent, Element: window.Element });
  const el = (id: string) => { const node = document.getElementById(prefixes[page] + '-' + id); assert.ok(node, 'Missing actual rendered control ' + id); return node as unknown as HTMLInputElement; };
  const event = (id: string, kind = 'click') => el(id).dispatchEvent(new window.Event(kind, { bubbles: true, cancelable: true }));
  const input = (id: string, value: string) => { el(id).value = value; event(id, 'input'); };
  return { document, window, client, current, navigations, stored, calls, el, event, input, fail(code: string) { failure = code; }, writes: () => calls.filter((call) => call.method !== 'GET') };
}

void test('all four advanced shared pages keep API requests, history and back links in the selected book', async () => {
  for (const page of ['goals', 'runway', 'balances', 'review'] as const) {
    const f = fixture(page); await settle(() => f.calls.length > 0 && !f.el(page === 'balances' ? 'page' : page === 'review' ? 'content' : page === 'goals' ? 'page' : 'save').hidden);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const call of f.calls) { assert.equal(call.url.searchParams.get('book'), BOOK, page + ' API lost book'); assert.equal(call.url.searchParams.get('bookRevision'), '3'); }
    assert.equal(f.current.searchParams.get('book'), BOOK, page + ' history lost book');
    const back = new URL(f.el('back-link').getAttribute('href')!, f.current);
    assert.equal(back.searchParams.get('book'), BOOK, page + ' back link lost book');
    assert.equal(back.searchParams.get('bookRevision'), '3');
  }
});

void test('shared-to-personal tabs use guarded full navigation and leave the active shared scope intact', async () => {
  for (const page of ['goals', 'runway', 'balances', 'review'] as const) {
    const f = fixture(page); await settle(() => f.calls.length > 0); await new Promise<void>((resolve) => setImmediate(resolve));
    const before = f.calls.length; f.event('ledger-personal');
    assert.equal(f.navigations.length, 1, page + ' must leave this shared page');
    const target = new URL(f.navigations[0]); assert.equal(target.searchParams.get('ledger'), 'personal'); assert.equal(target.searchParams.has('book'), false); assert.equal(target.searchParams.has('bookRevision'), false);
    assert.equal(f.client.scopeKey(), SCOPE); assert.equal(f.calls.length, before);
  }
});

void test('goals pending journals stay book-scoped and a revoked create retains the immutable operation', async () => {
  const oldKey = 'jiashu-finance-goal-create:' + encodeURIComponent(OWNER);
  const oldBytes = JSON.stringify({ key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', body: { ledger: 'personal', currency: 'CNY', name: '个人待确认', targetAmount: '100.00', deadline: '2027-01-01', accountIds: [ACCOUNT] } });
  const stored = new Map([[oldKey, oldBytes]]); const f = fixture('goals', { pending: stored });
  await settle(() => f.calls.length > 0); f.event('add'); await settle(() => !f.el('save').disabled);
  f.input('name', '共享目标'); f.input('amount', '250.00'); f.input('deadline', '2027-01-01');
  const checkbox = f.document.querySelector('[data-goal-account]') as HTMLInputElement | null; assert.ok(checkbox); checkbox.checked = true; checkbox.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  f.fail('FINANCE_BOOK_ACCESS_REVOKED'); f.event('form', 'submit'); await settle(() => f.writes().length === 1 && !f.el('form-error').hidden);
  assert.equal(stored.get(oldKey), oldBytes);
  const scopedKey = oldKey + ':scope:' + encodeURIComponent(SCOPE); assert.ok(stored.get(scopedKey), 'revoked operation must remain in its book journal');
  assert.equal(f.el('save').disabled, true); assert.equal(f.el('name').disabled, true);
});

void test('balance-check access changes retain original pending bytes and lock further writes', async () => {
  const f = fixture('balances'); await settle(() => Boolean(f.document.getElementById('balance-check-amount-' + ACCOUNT)));
  const amount = f.document.getElementById('balance-check-amount-' + ACCOUNT) as unknown as HTMLInputElement; amount.value = '250.00'; amount.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.fail('FINANCE_BOOK_ACCESS_CHANGED'); f.event('save'); await settle(() => f.writes().length === 1 && !f.el('progress').textContent?.includes('正在处理'));
  const key = 'jiashu-balance-check:' + encodeURIComponent(OWNER) + ':family:' + encodeURIComponent(SCOPE);
  assert.ok(f.stored.get(key), 'access-change rejection must not discard its original operation');
  assert.equal(f.el('retry-pending').disabled, true); assert.equal(f.el('date').disabled, true); assert.equal(f.el('save').disabled, true);
});

void test('runway access revocation preserves entered values while hiding the old shared accounting', async () => {
  const f = fixture('runway'); await settle(() => !f.el('save').disabled);
  f.input('expense', '250.00'); f.input('target-months', '9'); f.fail('FINANCE_BOOK_ACCESS_REVOKED'); f.event('form', 'submit');
  await settle(() => f.writes().length === 1 && f.el('save').disabled);
  assert.equal(f.el('expense').value, '250.00'); assert.equal(f.el('target-months').value, '9');
  assert.equal(f.el('summary').textContent, ''); assert.equal(f.el('accounts').textContent, '');
  assert.equal(f.el('expense').disabled, true); f.event('form', 'submit'); assert.equal(f.writes().length, 1);
});

void test('review revocation closes the confirmation without exposing the original report or trapping the book picker behind a modal', async () => {
  const f = fixture('review'); await settle(() => !f.el('content').hidden);
  f.event('close-confirm'); assert.equal(f.el('close-dialog').hasAttribute('open'), true);
  f.fail('FINANCE_BOOK_ACCESS_CHANGED'); f.event('close-form', 'submit');
  await settle(() => f.writes().length === 1 && Boolean(f.el('content').hidden));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.el('content').textContent, '');
  assert.equal(f.el('close-dialog').hasAttribute('open'), false, 'access lock must not leave an unclosable modal over book selection');
  assert.equal(f.el('close-submit').disabled, true);
});

void test('all five authenticated finance routes preserve explicit and repeated book parameters in the sign-in return path', async () => {
  for (const page of ['', 'goals/', 'runway/', 'balances/', 'review/']) {
    const source = stripTypeScriptTypes(readFileSync(new URL('../app/finance/' + page + 'route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
      .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
    let returnTo = '';
    const bindings = { CURRENCIES, todayShanghai, withPageAccount: (html: string) => html,
      requireChatGPTUser: async (path: string) => { returnTo = path; return { userId: OWNER }; },
      renderFinanceApp: () => '<html></html>', renderFinanceGoalsPage: () => '<html></html>', renderFinanceRunwayPage: () => '<html></html>', renderBalanceCheckPage: () => '<html></html>', renderFinanceReviewPage: () => '<html></html>',
    };
    const get = compileFunction(source + '\nreturn GET;', Object.keys(bindings))(...Object.values(bindings)) as (request: Request) => Promise<Response>;
    const response = await get(new Request('https://finance.example/finance/' + page + '?ledger=family&currency=CNY&month=2026-10&book=' + BOOK + '&bookRevision=3&book=own&bookRevision=4'));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const returned = new URL(returnTo, 'https://finance.example');
    assert.deepEqual(returned.searchParams.getAll('book'), [BOOK, 'own']); assert.deepEqual(returned.searchParams.getAll('bookRevision'), ['3', '4']);
  }
});
