import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderFinanceApp } from './finance-ui.ts';
import { renderAppNavigationScript } from './lib/app-navigation-ui.ts';

const snapshot = (ledger: string) => ({
  accounts: [
    { id: 'cash-cny', name: ledger === 'family' ? '家庭账户' : '日常账户', ledger, type: 'bank', currency: 'CNY', balanceMinor: '123450', asOfDate: '2026-11-11', archived: false },
    { id: 'cash-usd', name: '美元账户', ledger, type: 'bank', currency: 'USD', balanceMinor: '20000', asOfDate: '2026-11-10', archived: false },
  ],
  summary: { byCurrency: {
    CNY: { accountCount: 1, assetCount: 1, liabilityCount: 0, assetsMinor: '123450', liabilitiesMinor: '0', netMinor: '123450' },
    USD: { accountCount: 1, assetCount: 1, liabilityCount: 0, assetsMinor: '20000', liabilitiesMinor: '0', netMinor: '20000' },
  } }, meta: { today: '2026-11-11' },
});

async function settled(check: () => boolean) {
  for (let count = 0; count < 25; count++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'The synthetic finance operation did not settle');
}

function fixture(options: { initialUrl?: string; onlyUsdFamily?: boolean } = {}) {
  const { window, document } = parseHTML(renderFinanceApp());
  const location = new URL(options.initialUrl ?? 'https://finance-ux.example/finance?ledger=personal&currency=USD');
  const requests: Array<{ url: string; method: string }> = [];
  const fetch = async (url: string, requestOptions?: RequestInit) => {
    requests.push({ url, method: requestOptions?.method ?? 'GET' });
    const ledger = new URL(url, location).searchParams.get('ledger') ?? 'personal';
    const data = snapshot(ledger);
    return Response.json(options.onlyUsdFamily && ledger === 'family' ? { ...data, accounts: data.accounts.filter((account) => account.currency === 'USD'), summary: { byCurrency: { USD: data.summary.byCurrency.USD } } } : data);
  };
  const history = { state: null as unknown, replaceState(state: unknown, _unused: string, url: string) { this.state = state; location.href = new URL(url, location).href; } };
  document.querySelectorAll('dialog').forEach((dialog) => {
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reset() {} }));
  document.querySelectorAll('input').forEach((input) => Object.assign(input, { select() {} }));
  const source = [...document.querySelectorAll('script')].find((script) => script.textContent?.includes('const ledgerLabels='))!.textContent!;
  const context = { document, window, location, history, fetch, URL, URLSearchParams, AbortController, Intl, Date, queueMicrotask, setTimeout, clearTimeout, crypto, Event: window.Event, Element: window.Element };
  runInNewContext(renderAppNavigationScript().replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''), context);
  runInNewContext(source, context);
  const el = (id: string) => document.getElementById(id)!;
  const click = (target: Element) => target.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  return { document, window, location, requests, el, click };
}

test('finance overview gives net assets first and keeps export scope and account actions explicit', () => {
  const { document } = parseHTML(renderFinanceApp());
  assert.deepEqual([...document.querySelectorAll('.stats .stat-heading')].map((node) => node.textContent), ['净资产', '资产', '负债']);
  assert.equal(document.querySelector('.heading-actions .primary')?.id, 'balance-check-link');
  assert.match(document.getElementById('export-link')?.textContent ?? '', /导出账户与余额/);
  assert.equal(document.getElementById('export-link')?.hasAttribute('download'), true);
  assert.match(document.querySelector('.finance-export small')?.textContent ?? '', /仅含当前账本的账户及余额记录/);
  assert.equal(document.querySelectorAll('.heading-actions #add-account').length, 1);
  assert.equal(document.querySelectorAll('nav.finance-tools a').length, 3);
});

test('ledger and currency selection preserve context in every analysis and update entry', async () => {
  const f = fixture(); await settled(() => f.el('status-banner').hidden);
  assert.match(f.el('net-value').textContent ?? '', /US\$ 200\.00/);
  f.click(f.el('tab-family')); await settled(() => f.el('accounts-title').textContent === '家庭账户' && f.el('status-banner').hidden);
  Object.defineProperty(f.el('view-currency'), 'value', { value: 'USD', configurable: true });
  f.el('view-currency').dispatchEvent(new f.window.Event('change'));
  for (const [id, path] of [['finance-review-link', '/finance/review'], ['finance-goals-link', '/finance/goals'], ['finance-runway-link', '/finance/runway'], ['balance-check-link', '/finance/balances']]) {
    assert.equal(f.el(id).getAttribute('href'), path + '?ledger=family&currency=USD');
  }
  assert.equal(f.el('export-link').getAttribute('href'), '/api/finance/export?ledger=family');
  assert.equal(f.location.search, '?ledger=family&currency=USD');
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});

test('the lighter finance layout retains the per-account update and create dialogs', async () => {
  const f = fixture(); await settled(() => f.el('status-banner').hidden);
  const balance = f.document.querySelector('[data-action="balance"][data-id="cash-usd"]')!;
  assert.ok(balance); f.click(balance);
  await settled(() => f.el('balance-dialog').hasAttribute('open'));
  assert.match(f.el('balance-account-name').textContent ?? '', /美元账户/);
  assert.equal(f.el('balance-submit').textContent, '保存余额记录');
  f.click(f.el('add-account')); await settled(() => f.el('account-dialog').hasAttribute('open'));
  assert.equal(f.el('account-dialog-title').textContent, '新增账户');
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});


test('async currency selection keeps sidebar destinations aligned with a USD-only family ledger', async () => {
  const f = fixture({ initialUrl: 'https://finance-ux.example/finance?ledger=personal', onlyUsdFamily: true });
  await settled(() => f.el('status-banner').hidden);
  f.click(f.el('tab-family'));
  await settled(() => f.el('accounts-title').textContent === '家庭账户' && f.el('status-banner').hidden);
  assert.equal(f.location.search, '?ledger=family&currency=USD');
  for (const path of ['/finance/balances', '/finance/goals', '/finance/runway', '/finance/review']) {
    assert.equal(f.document.querySelector('[data-context-path="' + path + '"]')!.getAttribute('href'), path + '?ledger=family&currency=USD');
  }
});
