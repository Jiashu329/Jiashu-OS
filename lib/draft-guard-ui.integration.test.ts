import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderFinanceApp } from '../finance-ui.ts';
import { renderHealthGoals } from './health-goals-ui.ts';
import { renderWeightPlanPage } from '../weight-plan-page.ts';
import { buildGoalProgress } from './health-goals.ts';
import { buildHealthSummary } from './health.ts';
import { buildWeightPlanReview } from './weight-plan.ts';
import { DRAFT_GUARD_SCRIPT } from './draft-guard.ts';

async function settle(check: () => boolean) { for (let i = 0; i < 80; i++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); } assert.ok(check(), 'Synthetic guarded page did not settle'); }
function fixture() {
  const { window, document } = parseHTML(renderFinanceApp('synthetic-draft-owner'));
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  Object.defineProperty(proto, 'open', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('open'); } });
  proto.showModal = function(this: HTMLElement) { this.setAttribute('open', ''); };
  proto.close = function(this: HTMLElement) { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  proto.getBoundingClientRect = () => ({ left: 10, top: 10, right: 400, bottom: 400 });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reset() {}, reportValidity() { return true; }, requestSubmit() { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); } }));
  const values = new Map<string, string>(); Object.defineProperty(window, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  const location = new URL('https://finance.example/finance'); const writes: Array<{ key: string; body: Record<string, string> }> = []; const accounts = new Map<string, object>();
  const state = { reject: false, loseResponse: false };
  const fetch = async (_path: string, options: RequestInit = {}) => {
    if (!options.method || options.method === 'GET') return Response.json({ accounts: [...accounts.values()], summary: { byCurrency: {} }, meta: { today: '2026-11-11' } });
    const key = new Headers(options.headers).get('Idempotency-Key')!; const body = JSON.parse(String(options.body)); writes.push({ key, body });
    if (state.reject) { state.reject = false; return Response.json({ error: '合成拒绝', code: 'INVALID_FINANCE_DATA' }, { status: 400 }); }
    const account = { id: key, ...body, archived: false, balanceMinor: '25000', amount: '250.00' }; accounts.set(key, account);
    if (state.loseResponse) { state.loseResponse = false; throw new Error('Synthetic committed response lost'); }
    return Response.json({ account, balances: [{ id: 'initial:' + key }] }, { status: 201 });
  };
  const timer = (callback: (...args: unknown[]) => void, duration: number) => { const result = setTimeout(callback, duration); result.unref(); return result; };
  const context = createContext({ window, document, location, history: { state: null, replaceState(_state: unknown, _title: string, path: string) { location.href = new URL(path, location).href; } }, fetch, URL, URLSearchParams, AbortController, Intl, Date, crypto, queueMicrotask, setTimeout: timer, clearTimeout, Event: window.Event });
  const scripts = [...document.querySelectorAll('script')].map((script) => script.textContent!);
  runInContext(scripts.find((source) => source.includes('window.JiashuDraftGuards=(()=>'))!, context);
  runInContext(scripts.find((source) => source.includes('const ledgerLabels='))!, context);
  const el = (id: string) => document.getElementById(id)!;
  const click = (element: Element) => { const event = new window.Event('click', { bubbles: true, cancelable: true }); Object.assign(event, { button: 0 }); element.dispatchEvent(event); };
  const field = (id: string, value: string) => { (el(id) as HTMLInputElement).value = value; el(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  const choose = (name: string) => click(document.querySelector('[data-draft-choice="' + name + '"]')!);
  const open = () => { click(el('add-account')); field('account-name', '合成编辑账户'); field('account-amount', '250.00'); field('account-date', '2026-11-11'); };
  const close = () => click(el('account-dialog').querySelector('[data-close]')!);
  return { window, document, state, el, click, field, choose, open, close, writes, accounts, values };
}

test('actual account form keeps an edited draft on close and continues through the original save handler', async () => {
  const f = fixture(); await settle(() => f.el('status-banner').hidden); f.open(); f.close();
  assert.equal(f.el('account-dialog').hasAttribute('open'), true); assert.equal(f.el('draft-guard-dialog').hasAttribute('open'), true);
  f.choose('continue'); assert.equal((f.el('account-name') as HTMLInputElement).value, '合成编辑账户');
  f.close(); f.choose('save'); await settle(() => f.accounts.size === 1 && !f.el('account-dialog').hasAttribute('open'));
  assert.equal(f.writes.length, 1); assert.equal(f.values.size, 0); assert.equal(f.el('draft-guard-dialog').hasAttribute('open'), false);
});

test('actual rejected account save retains draft protection until a confirmed successful save', async () => {
  const f = fixture(); await settle(() => f.el('status-banner').hidden); f.open(); f.state.reject = true; f.close(); f.choose('save');
  await settle(() => !f.el('account-error').hidden); assert.equal(f.accounts.size, 0); assert.equal((f.el('account-name') as HTMLInputElement).value, '合成编辑账户');
  f.close(); assert.equal(f.el('draft-guard-dialog').hasAttribute('open'), true); f.choose('save');
  await settle(() => f.accounts.size === 1 && !f.el('account-dialog').hasAttribute('open')); assert.equal(f.writes.length, 2);
});

test('actual uncertain account submission closes without a discard choice and confirms the original identity', async () => {
  const f = fixture(); await settle(() => f.el('status-banner').hidden); f.open(); f.state.loseResponse = true;
  f.click(f.el('account-submit')); (f.el('account-form') as HTMLFormElement).requestSubmit(); await settle(() => !f.el('account-error').hidden);
  assert.equal(f.values.size, 1); f.close(); assert.equal(f.el('account-dialog').hasAttribute('open'), false); assert.equal(f.document.getElementById('draft-guard-dialog'), null);
  f.click(f.el('finance-resume')); (f.el('account-form') as HTMLFormElement).requestSubmit(); await settle(() => f.values.size === 0);
  assert.equal(f.accounts.size, 1); assert.equal(f.writes[0].key, f.writes[1].key);
});

function component(html: string, marker: string, path: string, fetch: (path: string, options?: RequestInit) => Promise<Response>) {
  const { window, document } = parseHTML(html);
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  Object.defineProperty(proto, 'open', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('open'); } });
  proto.showModal = function(this: HTMLElement) { this.setAttribute('open', ''); };
  proto.close = function(this: HTMLElement) { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  proto.getBoundingClientRect = () => ({ left: 10, top: 10, right: 400, bottom: 400 });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { requestSubmit() { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); } }));
  document.querySelectorAll('input').forEach((input) => { Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: false } }); });
  const location = new URL(path, 'https://draft.example'); const navigated: string[] = [];
  Object.assign(location, { assign(url: string) { navigated.push(url); location.href = url; } });
  const context = createContext({ window, document, location, history: { state: null, replaceState(_state: unknown, _title: string, path: string) { location.href = new URL(path, location).href; } }, fetch, URL, URLSearchParams, AbortController, Intl, Date, crypto, queueMicrotask, setTimeout, clearTimeout, Event: window.Event });
  runInContext(DRAFT_GUARD_SCRIPT, context);
  runInContext([...document.querySelectorAll('script')].find((script) => script.textContent!.includes(marker))!.textContent!, context);
  const el = (id: string) => document.getElementById(id)!;
  const click = (element: Element) => { const event = new window.Event('click', { bubbles: true, cancelable: true }); Object.assign(event, { button: 0 }); element.dispatchEvent(event); };
  const input = (id: string, value: string) => { (el(id) as HTMLInputElement).value = value; el(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  const choose = (name: string) => click(document.querySelector('[data-draft-choice="' + name + '"]')!);
  return { window, document, el, click, input, choose, navigated };
}

test('actual health goal draft survives a version conflict and an explicit metadata refresh', async () => {
  const now = '2026-11-11T04:00:00.000Z'; let revision = 2; let target = 6000; let reject = true; const writes: object[] = [];
  const settings = () => ({ targets: { steps: target, sleep: 8, active_energy: 400 }, revision, effectiveFrom: '2026-11-01', updatedAt: now });
  const f = component('<html><head></head><body>' + renderHealthGoals('health') + '</body></html>', "const root=document.querySelector('[data-health-goals]')", '/health', async (path, options = {}) => {
    if (path.includes('/progress')) return Response.json(buildGoalProgress(settings(), buildHealthSummary([]), now));
    if (options.method === 'PUT') {
      const body = JSON.parse(String(options.body)); writes.push(body);
      if (reject) { reject = false; revision = 3; target = 7000; return Response.json({ error: '合成版本冲突' }, { status: 409 }); }
      assert.equal(body.expectedRevision, 3); target = body.targets.steps; revision = 4;
    }
    return Response.json(settings());
  });
  f.click(f.document.querySelector('[data-goal-open]')!); await settle(() => !(f.el('goal-save') as HTMLButtonElement).disabled);
  f.input('goal-input-steps', '8000'); f.click(f.document.querySelector('[data-goal-close]')!); f.choose('save');
  await settle(() => !f.el('goal-refresh-latest').hidden); assert.equal((f.el('goal-input-steps') as HTMLInputElement).value, '8000');
  f.click(f.el('goal-refresh-latest')); await settle(() => f.el('goal-refresh-latest').hidden);
  f.click(f.document.querySelector('[data-goal-close]')!); assert.equal(f.el('draft-guard-dialog').hasAttribute('open'), true);
  f.choose('save'); await settle(() => !f.el('goal-dialog').hasAttribute('open'));
  assert.equal(writes.length, 2); assert.equal(target, 8000);
});

test('actual weight plan save from a navigation prompt preserves the requested destination after hydration', async () => {
  const now = Date.parse('2026-11-11T04:00:00Z'); let revision = 1; let targetWeight = 65; let writes = 0;
  const data = () => buildWeightPlanReview({ baselineWeight: 70, targetWeight, startDate: '2026-11-01', deadline: '2026-12-31', enabled: false, revision, createdAt: '2026-11-01T04:00:00Z', updatedAt: '2026-11-11T04:00:00Z' }, [], now);
  const f = component(renderWeightPlanPage(), "document.getElementById('weight-plan-'", '/health/weight-plan', async (_path, options = {}) => {
    if (options.method === 'PUT') { const body = JSON.parse(String(options.body)); writes++; targetWeight = body.targetWeight; revision++; }
    return Response.json(data());
  });
  await settle(() => !(f.el('weight-plan-save') as HTMLButtonElement).disabled);
  f.input('weight-plan-target', '66');
  const link = f.document.createElement('a'); link.href = '/after-save'; link.textContent = '去下一页'; f.document.body.appendChild(link); f.click(link);
  assert.equal(f.el('draft-guard-dialog').hasAttribute('open'), true); f.choose('save');
  await settle(() => f.navigated.length === 1);
  assert.equal(writes, 1); assert.equal(targetWeight, 66); assert.deepEqual(f.navigated, ['https://draft.example/after-save']);
});
