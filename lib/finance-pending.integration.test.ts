import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderFinanceApp } from '../finance-ui.ts';

const initialId = '11111111-1111-4111-8111-111111111111';
type Account = { id: string; name: string; type: string; ledger: string; currency: string; note: string; amount: string; balanceMinor: string; asOfDate: string; archived: boolean; metadataRevision: number };
type Result = { account: Account; balances: Array<{ id: string; amountMinor: string }> };
function sessionStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem(key: string, value: string) { values.set(key, value); }, removeItem(key: string) { values.delete(key); } };
}
function server(initial = false) {
  const accounts = new Map<string, Account>(); const operations = new Map<string, Result>();
  const writes: Array<{ key: string; owner: string; path: string; body: Record<string, string> }> = [];
  const balances = new Map<string, Array<{ id: string; amountMinor: string }>>();
  if (initial) {
    accounts.set(initialId, { id: initialId, name: '合成银行账户', type: 'bank', ledger: 'personal', currency: 'CNY', note: '', amount: '100.00', balanceMinor: '10000', asOfDate: '2026-11-11', archived: false, metadataRevision: 1 });
    balances.set(initialId, [{ id: 'initial:' + initialId, amountMinor: '10000' }]);
  }
  const state = { loseNextResponse: true, rejectNext: 0, malformedNext: false, overviewFails: false, conflictNextMetadata: false };
  const fetch = async (owner: string, path: string, options: RequestInit = {}) => {
    if (!options.method || options.method === 'GET') {
      if (state.overviewFails) return Response.json({ error: '合成读取失败' }, { status: 503 });
      if (path === '/api/finance/accounts/' + initialId) return Response.json({ account: accounts.get(initialId), balances: balances.get(initialId) });
      const ledger = new URL(path, 'https://finance.example').searchParams.get('ledger') ?? 'personal';
      return Response.json({ accounts: [...accounts.values()].filter((account) => account.ledger === ledger), summary: { byCurrency: {} }, meta: { today: '2026-11-11' } });
    }
    const key = new Headers(options.headers).get('Idempotency-Key')!; const body = JSON.parse(String(options.body));
    writes.push({ key, owner, path, body });
    if (state.rejectNext) { const status = state.rejectNext; state.rejectNext = 0; return Response.json({ error: '合成明确拒绝', code: 'INVALID_FINANCE_DATA' }, { status }); }
    if (options.method === 'PATCH') {
      const id = path.split('/')[4]; const previous = accounts.get(id)!;
      if (state.conflictNextMetadata) { state.conflictNextMetadata = false; accounts.set(id, { ...previous, name: '另一页面保存的新账户名', note: '最新备注', metadataRevision: previous.metadataRevision + 1 }); }
      const latest = accounts.get(id)!;
      if (body.expectedRevision !== latest.metadataRevision) return Response.json({ error: '账户已在其他页面更新，请读取最新内容。', code: 'FINANCE_METADATA_CONFLICT' }, { status: 409 });
      const updated = { ...latest, ...body, metadataRevision: latest.metadataRevision + 1 };
      accounts.set(id, updated);
      return Response.json({ account: updated, balances: balances.get(id) });
    }
    let result = operations.get(owner + ':' + key);
    if (!result) {
      const creating = path === '/api/finance/accounts'; const id = creating ? key : path.split('/')[4];
      const account = creating ? { id, ...body, balanceMinor: '25000', amount: body.amount, archived: false, metadataRevision: 1 } as Account : { ...accounts.get(id)!, amount: body.amount, balanceMinor: '35000', asOfDate: body.asOfDate };
      accounts.set(id, account);
      const rows = [...(balances.get(id) ?? []), { id: creating ? 'initial:' + key : key, amountMinor: account.balanceMinor }];
      balances.set(id, rows); result = { account, balances: rows }; operations.set(owner + ':' + key, result);
    }
    if (state.loseNextResponse) { state.loseNextResponse = false; throw new Error('Synthetic response disconnected after commit'); }
    if (state.malformedNext) { state.malformedNext = false; return Response.json({ account: { id: 'unrelated-account' } }); }
    return Response.json(result, { status: 201 });
  };
  return { state, fetch, writes, accounts, balances };
}
async function settled(check: () => boolean) {
  for (let count = 0; count < 50; count++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'Synthetic finance page did not settle');
}
function fixture(owner: string, session: ReturnType<typeof sessionStorage>, service: ReturnType<typeof server>) {
  const { window, document } = parseHTML(renderFinanceApp(owner));
  Object.defineProperty(window, 'sessionStorage', { value: session, configurable: true });
  const location = new URL('https://finance.example/finance?ledger=personal&currency=CNY');
  document.querySelectorAll('dialog').forEach((dialog) => {
    Object.defineProperty(dialog, 'open', { get() { return dialog.hasAttribute('open'); } });
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reset() {}, reportValidity() { return true; } }));
  document.querySelectorAll('input').forEach((input) => Object.assign(input, { select() {} }));
  const source = [...document.querySelectorAll('script')].find((script) => script.textContent?.includes('const ledgerLabels='))!.textContent!;
  const timer = ((callback: (...args: unknown[]) => void, delay: number) => { const handle = setTimeout(callback, delay); handle.unref(); return handle; });
  runInNewContext(source, { document, window, location, history: { state: null, replaceState(_state: unknown, _title: string, path: string) { location.href = new URL(path, location).href; } }, fetch: (path: string, options: RequestInit) => service.fetch(owner, path, options), URL, URLSearchParams, AbortController, Intl, Date, crypto, queueMicrotask, setTimeout: timer, clearTimeout, Event: window.Event });
  const el = (id: string) => document.getElementById(id)!;
  const click = (element: Element) => element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const submit = (id: string) => el(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const value = (id: string, text: string) => { (el(id) as HTMLInputElement).value = text; };
  const close = (id: string) => click(el(id).querySelector('[data-close]')!);
  const create = () => { click(el('add-account')); value('account-name', '合成新账户'); value('account-amount', '250.00'); value('account-date', '2026-11-11'); value('account-note', '合成测试备注'); };
  return { el, click, submit, value, close, create, document };
}

test('a committed account with a lost response survives dialog close and replays the same frozen request once', async () => {
  const session = sessionStorage(); const service = server(); const f = fixture('owner-A', session, service);
  await settled(() => f.el('status-banner').hidden); f.create(); f.submit('account-form');
  await settled(() => service.writes.length === 1 && !f.el('account-error').hidden);
  assert.equal(service.accounts.size, 1); assert.equal((f.el('account-name') as HTMLInputElement).disabled, true);
  f.close('account-dialog'); assert.equal(f.el('account-dialog').hasAttribute('open'), false);
  f.click(f.el('finance-resume')); assert.equal(f.el('account-dialog-title').textContent, '确认原账户创建');
  f.value('account-name', '篡改输入不应改变原请求'); f.submit('account-form');
  await settled(() => service.writes.length === 2 && session.values.size === 0);
  assert.equal(service.accounts.size, 1);
  assert.equal(service.writes[0].key, service.writes[1].key);
  assert.deepEqual(service.writes[0].body, service.writes[1].body);
  assert.equal(f.el('finance-pending').hidden, true);
});

test('refresh does not send automatically and resumes the original account creation with the same identity', async () => {
  const session = sessionStorage(); const service = server(); const first = fixture('owner-A', session, service);
  await settled(() => first.el('status-banner').hidden); first.create(); first.submit('account-form');
  await settled(() => service.writes.length === 1 && !first.el('account-error').hidden);
  const refreshed = fixture('owner-A', session, service); await settled(() => refreshed.el('status-banner').hidden);
  assert.equal(service.writes.length, 1); assert.equal(refreshed.el('finance-pending').hidden, false);
  refreshed.click(refreshed.el('finance-resume')); refreshed.submit('account-form');
  await settled(() => service.writes.length === 2 && session.values.size === 0);
  assert.equal(service.accounts.size, 1); assert.equal(service.writes[0].key, service.writes[1].key);
});

test('a lost balance response survives refresh and replay does not append a second balance entry', async () => {
  const session = sessionStorage(); const service = server(true); const first = fixture('owner-A', session, service);
  await settled(() => first.el('status-banner').hidden);
  first.click(first.document.querySelector('[data-action="balance"]')!); first.value('balance-amount', '350.00'); first.value('balance-date', '2026-11-11'); first.submit('balance-form');
  await settled(() => service.writes.length === 1 && !first.el('balance-error').hidden);
  const refreshed = fixture('owner-A', session, service); await settled(() => refreshed.el('status-banner').hidden);
  refreshed.click(refreshed.el('finance-resume')); assert.equal((refreshed.el('balance-amount') as HTMLInputElement).disabled, true); refreshed.submit('balance-form');
  await settled(() => service.writes.length === 2 && session.values.size === 0);
  assert.equal(service.accounts.size, 1); assert.equal(service.balances.get(initialId)?.length, 2);
  assert.equal(service.writes[0].key, service.writes[1].key); assert.deepEqual(service.writes[0].body, service.writes[1].body);
});

test('pending balance confirmation remains usable when the refreshed overview is unavailable', async () => {
  const session = sessionStorage(); const service = server(true); const first = fixture('owner-A', session, service);
  await settled(() => first.el('status-banner').hidden);
  first.click(first.document.querySelector('[data-action="balance"]')!); first.value('balance-amount', '350.00'); first.value('balance-date', '2026-11-11'); first.submit('balance-form');
  await settled(() => service.writes.length === 1 && !first.el('balance-error').hidden);
  service.state.overviewFails = true; const refreshed = fixture('owner-A', session, service);
  await settled(() => refreshed.el('status-title').textContent === '账本读取失败');
  refreshed.click(refreshed.el('finance-resume'));
  assert.equal(refreshed.el('balance-current').textContent, '待重新读取');
  assert.equal((refreshed.el('balance-amount') as HTMLInputElement).value, '350.00');
  refreshed.submit('balance-form'); await settled(() => service.writes.length === 2 && session.values.size === 0);
  assert.equal(service.balances.get(initialId)?.length, 2); assert.equal(service.writes[0].key, service.writes[1].key);
});

test('explicit validation rejection releases the fixed request and allows a corrected fresh submission', async () => {
  const session = sessionStorage(); const service = server(); service.state.rejectNext = 400; service.state.loseNextResponse = false;
  const f = fixture('owner-A', session, service); await settled(() => f.el('status-banner').hidden); f.create(); f.submit('account-form');
  await settled(() => service.writes.length === 1 && !f.el('account-error').hidden);
  assert.equal(session.values.size, 0); assert.equal((f.el('account-name') as HTMLInputElement).disabled, false);
  f.value('account-name', '修正后账户'); f.submit('account-form'); await settled(() => service.writes.length === 2 && service.accounts.size === 1);
  assert.notEqual(service.writes[0].key, service.writes[1].key); assert.equal(service.writes[1].body.name, '修正后账户');
});

test('a different signed-in owner never restores or sends another owner pending request', async () => {
  const session = sessionStorage(); const service = server(); const first = fixture('owner-A', session, service);
  await settled(() => first.el('status-banner').hidden); first.create(); first.submit('account-form'); await settled(() => service.writes.length === 1 && !first.el('account-error').hidden);
  const second = fixture('owner-B', session, service); await settled(() => second.el('status-banner').hidden);
  assert.equal(second.el('finance-pending').hidden, true); assert.equal(service.writes.length, 1);
  assert.match([...session.values.keys()][0], /owner-A$/);
});

test('session persistence failure prevents sending, and malformed success responses remain pending', async () => {
  const session = sessionStorage(); const service = server(); service.state.loseNextResponse = false;
  const f = fixture('owner-A', session, service); await settled(() => f.el('status-banner').hidden); f.create();
  session.setItem = () => { throw new Error('Synthetic browser storage unavailable'); }; f.submit('account-form');
  await settled(() => !f.el('account-error').hidden); assert.match(f.el('account-error').textContent!, /本次未发送/); assert.equal(service.writes.length, 0);
  const anotherSession = sessionStorage(); const second = fixture('owner-A', anotherSession, service); await settled(() => second.el('status-banner').hidden);
  service.state.malformedNext = true; second.create(); second.submit('account-form'); await settled(() => service.writes.length === 1 && !second.el('account-error').hidden);
  assert.equal(anotherSession.values.size, 1); assert.equal(second.el('finance-pending').hidden, false);
  second.submit('account-form'); await settled(() => service.writes.length === 2 && anotherSession.values.size === 0); assert.equal(service.accounts.size, 1);
});

test('account edit conflicts keep every unsaved field and block retry until latest metadata is read', async () => {
  const service = server(true); service.state.conflictNextMetadata = true;
  const f = fixture('owner-A', sessionStorage(), service); await settled(() => f.el('status-banner').hidden);
  f.click(f.document.querySelector('[data-action="edit"]')!);
  f.value('account-name', '我填写的新名字'); f.value('account-note', '我的未保存备注'); f.submit('account-form');
  await settled(() => service.writes.length === 1 && !f.el('account-error').hidden);
  assert.equal((f.el('account-name') as HTMLInputElement).value, '我填写的新名字');
  assert.equal((f.el('account-note') as HTMLTextAreaElement).value, '我的未保存备注');
  assert.equal((f.el('account-submit') as HTMLButtonElement).disabled, true);
  f.submit('account-form'); assert.equal(service.writes.length, 1);
  f.click(f.el('account-reload-latest')); await settled(() => !(f.el('account-submit') as HTMLButtonElement).disabled);
  assert.match(f.el('account-current-info').textContent!, /另一页面保存的新账户名.*最新备注/);
  assert.equal((f.el('account-name') as HTMLInputElement).value, '我填写的新名字');
  assert.equal((f.el('account-note') as HTMLTextAreaElement).value, '我的未保存备注');
  assert.equal(service.writes.length, 1, 'reading latest must never send the retained draft');
  f.submit('account-form'); await settled(() => service.writes.length === 2 && !f.el('account-dialog').hasAttribute('open'));
  assert.equal(service.writes[0].body.expectedRevision, 1); assert.equal(service.writes[1].body.expectedRevision, 2);
  assert.equal(service.accounts.get(initialId)!.name, '我填写的新名字'); assert.equal(service.accounts.get(initialId)!.metadataRevision, 3);
});

test('account archive conflicts require reading latest and a fresh explicit confirmation', async () => {
  const service = server(true); service.state.conflictNextMetadata = true;
  const f = fixture('owner-A', sessionStorage(), service); await settled(() => f.el('status-banner').hidden);
  f.click(f.document.querySelector('[data-action="archive"]')!); f.click(f.el('archive-submit'));
  await settled(() => service.writes.length === 1 && !f.el('archive-error').hidden);
  assert.equal((f.el('archive-submit') as HTMLButtonElement).disabled, true); assert.equal(service.accounts.get(initialId)!.archived, false);
  f.click(f.el('archive-submit')); assert.equal(service.writes.length, 1);
  f.click(f.el('archive-reload-latest')); await settled(() => !(f.el('archive-submit') as HTMLButtonElement).disabled);
  assert.match(f.el('archive-description').textContent!, /另一页面保存的新账户名/); assert.equal(service.writes.length, 1);
  f.click(f.el('archive-submit')); await settled(() => service.writes.length === 2 && !f.el('archive-dialog').hasAttribute('open'));
  assert.equal(service.writes[1].body.expectedRevision, 2); assert.equal(service.accounts.get(initialId)!.archived, true);
});
