import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderFinanceGoalsPage } from '../finance-goals-page.ts';
import { renderFinanceRunwayPage } from '../finance-runway-page.ts';

const A = '11111111-1111-4111-8111-111111111111';
const account = { id: A, name: '合成账户', type: 'bank', currency: 'CNY', ledger: 'personal', balanceMinor: '100000', asOfDate: '2026-11-09' };
async function settle(check: () => boolean) {
  for (let index = 0; index < 100; index++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.ok(check(), 'page interaction must settle');
}
function fixture(html: string, prefix: 'runway' | 'finance-goals', path: string, fetch: (path: string, options: RequestInit) => Promise<Response>) {
  const { window, document } = parseHTML(html); const location = new URL(path, 'https://synthetic-finance.example');
  const storage = new Map<string, string>(); const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  document.querySelectorAll('dialog').forEach((dialog) => {
    Object.defineProperty(dialog, 'open', { get() { return dialog.hasAttribute('open'); } });
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reset() {}, reportValidity() { return true; }, requestSubmit() { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); } }));
  const source = [...document.querySelectorAll('script')].find((script) => script.textContent?.includes("document.getElementById('" + prefix + "-'"))!.textContent!;
  runInNewContext(source, { window, document, location, history: { replaceState(_state: unknown, _title: string, path: string) { location.href = new URL(path, location).href; } }, navigator: {}, sessionStorage, fetch, Response, URL, URLSearchParams, AbortController, Intl, Date, crypto, queueMicrotask, setTimeout, clearTimeout, Event: window.Event, CustomEvent: window.CustomEvent, Element: window.Element });
  const el = (id: string) => document.getElementById(prefix + '-' + id)!;
  const click = (id: string) => el(id).dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const input = (id: string, value: string) => { (el(id) as HTMLInputElement).value = value; el(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = () => el('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { window, document, el, click, input, submit };
}

test('goal cards label achieved stale balances and provide a scoped reconciliation link', async () => {
  const goal = { id: A, ledger: 'family', currency: 'USD', name: '合成目标', currentMinor: '10000', targetMinor: '10000', gapMinor: '0', percent: 100, deadline: '2027-01-01', daysRemaining: 40, monthlyMinor: '0', status: 'achieved', archived: false, matchedAccountCount: 1, missingCount: 2, staleAccountCount: 1, archivedAccountCount: 1, missingAccountCount: 1, unavailableAccountCount: 0, oldestBalanceDate: '2026-09-01', latestBalanceDate: '2026-09-01' };
  const f = fixture(renderFinanceGoalsPage('alice'), 'finance-goals', '/finance/goals?ledger=family&currency=USD', async () => Response.json({ ledger: 'family', currency: 'USD', today: '2026-11-09', goals: [goal], accounts: [] }));
  await settle(() => f.document.querySelector('[data-finance-goal]') !== null);
  const card = f.document.querySelector('[data-finance-goal]')!;
  assert.match(card.textContent!, /按旧余额估计已达成/);
  assert.match(card.textContent!, /2026-09-01/);
  assert.match(card.textContent!, /1 个关联账户已归档/);
  assert.match(card.textContent!, /1 个关联账户缺失/);
  assert.match(card.textContent!, /超过 30 天/);
  assert.equal(card.querySelector('[data-goal-balance-basis] a')?.getAttribute('href'), '/finance/balances?ledger=family&currency=USD');
});

test('runway 409 preserves the draft until the user reads and acknowledges the latest settings', async () => {
  let revision = 1; const writes: Array<Record<string, unknown>> = [];
  const data = () => ({ ledger: 'personal', currency: 'CNY', revision, accounts: [account], settings: { monthlyExpenseAmount: '100.00', monthlyExpenseMinor: '10000', targetMonths: 6, accountIds: [A], revision }, progress: null });
  const f = fixture(renderFinanceRunwayPage('alice'), 'runway', '/finance/runway?ledger=personal&currency=CNY', async (_path, options) => {
    if (options?.method !== 'PUT') return Response.json(data());
    const body = JSON.parse(options.body as string) as Record<string, unknown>; writes.push(body);
    if (writes.length === 1) { revision = 2; return Response.json({ code: 'FINANCE_RUNWAY_CONFLICT', error: '其他页面已保存新版本' }, { status: 409 }); }
    assert.equal(body.expectedRevision, 2); revision = 3;
    return Response.json({ ...data(), settings: { ...data().settings, monthlyExpenseAmount: body.monthlyExpenseAmount, targetMonths: body.targetMonths } });
  });
  await settle(() => !(f.el('save') as HTMLButtonElement).disabled);
  f.input('expense', '250.00'); f.input('target-months', '9'); f.submit();
  await settle(() => !f.el('conflict').hidden);
  assert.equal((f.el('expense') as HTMLInputElement).value, '250.00');
  assert.equal((f.el('target-months') as HTMLInputElement).value, '9');
  assert.equal((f.el('save') as HTMLButtonElement).disabled, true);
  f.click('read-latest'); await settle(() => !f.el('keep-draft').hidden && !(f.el('keep-draft') as HTMLButtonElement).disabled);
  assert.match(f.el('conflict-text').textContent!, /100\.00/);
  assert.equal((f.el('expense') as HTMLInputElement).value, '250.00');
  f.click('keep-draft'); assert.equal((f.el('save') as HTMLButtonElement).disabled, false);
  assert.equal(writes.length, 1, 'acknowledgement must not submit automatically');
  f.submit(); await settle(() => writes.length === 2 && f.el('form-status').textContent === '设置已保存。');
  assert.equal(writes[0].expectedRevision, 1); assert.equal(writes[1].monthlyExpenseAmount, '250.00'); assert.equal(writes[1].targetMonths, 9);
});

test('goal edit conflicts retain input and require explicit latest-version acknowledgement before saving',async()=>{
  const goal={id:A,revision:1,ledger:'personal',currency:'CNY',name:'原目标',targetAmount:'1000.00',targetMinor:'100000',currentMinor:'0',gapMinor:'100000',percent:0,deadline:'2027-01-01',accountIds:[A],daysRemaining:40,monthlyMinor:'10000',status:'active',archived:false,matchedAccountCount:1,missingCount:0,staleAccountCount:0};
  let current={...goal};const writes:Array<Record<string,unknown>>=[];
  const f=fixture(renderFinanceGoalsPage('alice'),'finance-goals','/finance/goals?ledger=personal&currency=CNY',async(path,options)=>{
    if(options?.method==='PATCH'){
      const body=JSON.parse(String(options.body));writes.push(body);
      if(writes.length===1){current={...current,name:'另一页面的新目标',revision:2};return Response.json({error:'目标已经更新',code:'FINANCE_METADATA_CONFLICT'},{status:409});}
      assert.equal(body.expectedRevision,2);current={...current,...body,revision:3};return Response.json({goal:current});
    }
    if(path==='/api/finance/goals/'+A)return Response.json({goal:current});
    if(path.startsWith('/api/finance?'))return Response.json({accounts:[account]});
    return Response.json({ledger:'personal',currency:'CNY',today:'2026-11-09',goals:[current],accounts:[account]});
  });
  await settle(()=>Boolean(f.document.querySelector('[data-goal-action="edit"]')));
  f.document.querySelector('[data-goal-action="edit"]')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  await settle(()=>!(f.el('save') as HTMLButtonElement).disabled);
  f.input('name','保留我的填写');f.submit();await settle(()=>writes.length===1&&!(f.el('form-error') as HTMLElement).hidden);
  assert.equal((f.el('name') as HTMLInputElement).value,'保留我的填写');assert.equal((f.el('save') as HTMLButtonElement).disabled,true);
  f.submit();assert.equal(writes.length,1);
  f.click('reload-latest');await settle(()=>!(f.el('save') as HTMLButtonElement).disabled);
  assert.equal((f.el('name') as HTMLInputElement).value,'保留我的填写');assert.match(f.el('current-info').textContent??'',/另一页面的新目标/);
  f.submit();await settle(()=>writes.length===2&&!f.el('dialog').hasAttribute('open'));
  assert.equal(writes[1].name,'保留我的填写');assert.equal(writes[1].expectedRevision,2);
});
