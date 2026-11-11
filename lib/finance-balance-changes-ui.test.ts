import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { FINANCE_BALANCE_CHANGES_SCRIPT, renderFinanceBalanceChangeDialog } from './finance-balance-changes-ui.ts';
import { FINANCE_PENDING_SCRIPT } from './finance-pending.ts';

const account = { id: '11111111-1111-4111-8111-111111111111', name: 'synthetic bank', type: 'bank', ledger: 'personal', currency: 'CNY', balanceRevision: 4 };
const entry = { id: 'initial:' + account.id, revision: 0, asOfDate: '2026-11-11', amount: '10.00', amountMinor: '1000', note: '', status: 'active' };
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
function fixture(initialStorage = new Map<string, string>()) {
  const { document, window } = parseHTML('<html><body><dialog id="detail-dialog"></dialog>' + renderFinanceBalanceChangeDialog() + '</body></html>');
  const calls: { path: string; options: RequestInit; body: Record<string, unknown> }[] = [];
  const storage = initialStorage;
  let failCommit = false;
  let refreshed = 0;
  const $ = (id: string) => document.getElementById(id)! as unknown as HTMLElement & { value: string; open: boolean; close(): void; reset(): void; reportValidity(): boolean };
  for (const dialog of document.querySelectorAll('dialog')) {
    Object.defineProperty(dialog, 'open', { get() { return this.hasAttribute('open'); } });
    (dialog as unknown as { close(): void }).close = () => dialog.removeAttribute('open');
  }
  $('balance-change-form').reportValidity = () => true;
  $('balance-change-form').reset = () => { document.querySelectorAll('input,textarea').forEach((element) => { (element as HTMLInputElement).value = ''; }); };
  const context = createContext({
    document, window, $, crypto, URL, Date, JSON, Number, Object, encodeURIComponent,
    formatMoney: (minor: string, currency: string) => currency + ' ' + minor,
    textDate: (day: string) => day,
    today: () => '2026-11-11',
    errorText: (error: Error) => error.message,
    busy(dialog: HTMLElement, value: boolean) { dialog.dataset.busy = value ? '1' : '0'; },
    openDialog(dialog: HTMLElement) { dialog.setAttribute('open', ''); },
    openPending() {}, renderPending() {}, toast() {},
    loadOverview: async () => { refreshed++; },
    pendingFailure: (error: Error) => error.message + ' 原操作待确认',
    storage: { setItem: (key: string, value: string) => storage.set(key, value), getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) },
    async request(path: string, options: RequestInit) {
      calls.push({ path, options, body: JSON.parse(String(options.body)) });
      if (path.endsWith('/preview')) return { currency: 'CNY', currentBefore: { amountMinor: '1000', asOfDate: '2026-11-11' }, currentAfter: { amountMinor: '2000', asOfDate: '2026-10-31' }, changesCurrentBalance: true };
      if (failCommit) throw new Error('synthetic response lost');
      const operation = runInContext('pendingStore.value', context) as { key: string };
      return { account, changes: [{ id: operation.key }] };
    },
  });
  runInContext(FINANCE_PENDING_SCRIPT + "\nconst pendingStore=createFinancePendingStore('synthetic-owner',()=>storage);\n" + FINANCE_BALANCE_CHANGES_SCRIPT, context);
  const invoke = (name: string, ...args: unknown[]) => { context.invokeArgs = args; return runInContext(name + '(...invokeArgs)', context); };
  const click = (id: string) => $(id).dispatchEvent(new window.Event('click', { bubbles: true }));
  const submit = () => $('balance-change-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { $, context, calls, storage, invoke, click, submit, setFail: (value: boolean) => { failCommit = value; }, refreshed: () => refreshed };
}

test('a correction needs an explicit preview and new edits invalidate its confirmation', async () => {
  const f = fixture();
  f.invoke('openBalanceChange', account, entry, 'correct', null);
  f.$('balance-change-amount').value = '20.00'; f.$('balance-change-date').value = '2026-10-31'; f.$('balance-change-reason').value = 'synthetic wrong date';
  f.click('balance-change-confirm'); await flush();
  assert.equal(f.calls.length, 0);
  f.submit(); await flush();
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].path.endsWith('/preview'));
  assert.equal(f.calls[0].body.expectedAccountRevision, 4);
  assert.equal(f.$('balance-change-confirm').hidden, false);
  assert.match(f.$('balance-change-preview').textContent!, /2026-10-31/);
  f.$('balance-change-reason').value = 'edited reason';
  f.$('balance-change-reason').dispatchEvent(new (f.context.window as typeof window).Event('input', { bubbles: true }));
  assert.equal(f.$('balance-change-confirm').hidden, true);
  f.click('balance-change-confirm'); await flush(); assert.equal(f.calls.length, 1);
  f.submit(); await flush(); f.click('balance-change-confirm'); await flush();
  assert.equal(f.calls.length, 3); assert.equal(f.refreshed(), 1);
  assert.equal(f.$('balance-change-dialog').open, false); assert.equal(f.storage.size, 0);
});

test('an uncertain correction keeps the exact operation for confirmation and locks its inputs', async () => {
  const f = fixture(); f.setFail(true);
  f.invoke('openBalanceChange', account, entry, 'void', null);
  f.$('balance-change-reason').value = 'synthetic void'; f.submit(); await flush(); f.click('balance-change-confirm'); await flush();
  const first = f.calls.at(-1)!;
  assert.equal(first.body.action, 'void'); assert.equal(f.storage.size, 1);
  assert.match(f.$('balance-change-error').textContent!, /待确认/);
  assert.equal((f.$('balance-change-reason') as unknown as { disabled: boolean }).disabled, true);
  f.setFail(false); f.click('balance-change-confirm'); await flush();
  const second = f.calls.at(-1)!;
  assert.equal(first.options.headers && (first.options.headers as Record<string, string>)['Idempotency-Key'], (second.options.headers as Record<string, string>)['Idempotency-Key']);
  assert.deepEqual(first.body, second.body);
  assert.equal(f.storage.size, 0); assert.equal(f.refreshed(), 1);
});

test('a refreshed page can confirm a stored correction without loading account overview', async () => {
  const first = fixture(); first.setFail(true);
  first.invoke('openBalanceChange', account, entry, 'correct', null);
  first.$('balance-change-amount').value = '20.00'; first.$('balance-change-date').value = '2026-10-31'; first.$('balance-change-reason').value = 'synthetic refreshed correction';
  first.submit(); await flush(); first.click('balance-change-confirm'); await flush();
  const original = first.calls.at(-1)!;
  const refreshed = fixture(new Map(first.storage));
  const operation = runInContext('pendingStore.value', refreshed.context);
  assert.equal(operation.account.balanceMinor, undefined);
  refreshed.invoke('openPendingBalanceChange', operation, null);
  assert.equal(refreshed.$('balance-change-date').value, '2026-10-31');
  refreshed.click('balance-change-confirm'); await flush();
  assert.equal(refreshed.calls.length, 1);
  assert.equal((original.options.headers as Record<string, string>)['Idempotency-Key'], (refreshed.calls[0].options.headers as Record<string, string>)['Idempotency-Key']);
  assert.deepEqual(original.body, refreshed.calls[0].body);
  assert.equal(refreshed.storage.size, 0);
});
