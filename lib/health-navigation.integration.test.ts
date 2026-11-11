import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderApp } from '../ui.ts';

async function settled(check: () => boolean) {
  for (let index = 0; index < 40; index++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'The synthetic health view did not settle');
}

function fixture(initialPath = '/health', rows: unknown[] = [], initialState: unknown = null) {
  const { window, document } = parseHTML(renderApp());
  const initial = new URL(initialPath, 'https://health-view.example');
  let url = initial;
  let cursor = 0;
  const entries: Array<{ url: string; state: unknown }> = [{ url: url.href, state: initialState }];
  const location = {
    get origin() { return url.origin; }, get pathname() { return url.pathname; },
    get search() { return url.search; }, get hash() { return url.hash; }, get href() { return url.href; },
  };
  const history = {
    get state() { return entries[cursor].state; },
    pushState(state: unknown, _title: string, path: string) { url = new URL(path, url); entries.splice(cursor + 1); entries.push({ url: url.href, state }); cursor++; },
    replaceState(state: unknown, _title: string, path: string) { url = new URL(path, url); entries[cursor] = { url: url.href, state }; },
    back() { if (cursor === 0) return; cursor--; restore(); },
    forward() { if (cursor === entries.length - 1) return; cursor++; restore(); },
  };
  function restore() {
    url = new URL(entries[cursor].url); const event = new window.Event('popstate');
    Object.defineProperty(event, 'state', { value: entries[cursor].state }); window.dispatchEvent(event);
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  }
  const requests: Array<{ url: string; method: string }> = [];
  const fetch = async (path: string, options?: RequestInit) => {
    requests.push({ url: path, method: options?.method ?? 'GET' });
    if (path.startsWith('/api/health?')) return Response.json({ measurements: rows, lastSync: null, bodyComposition: null });
    if (path === '/api/sync/devices') return Response.json({ devices: [] });
    if (path === '/api/health/import') return Response.json({ imported: 1 });
    throw new Error('Unexpected synthetic request: ' + path);
  };
  const source = [...document.querySelectorAll('script')].at(-1)!.textContent!;
  runInNewContext(source, { window, document, location, history, navigator: {}, fetch,
    URL, URLSearchParams, TextEncoder, AbortController, crypto: webcrypto, Intl, Date, Event: window.Event,
    setTimeout, clearTimeout, requestAnimationFrame: (callback: () => void) => { callback(); return 0; } });
  const el = (id: string) => document.getElementById(id)! as HTMLElement & { open: boolean; value: string };
  const click = (selector: string) => document.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  return { window, document, location, history, entries, requests, el, click,
    async ready() { await settled(() => el('banner-title').textContent !== '读取健康记录中'); },
  };
}

test('health metric and range deep links survive interactions, Back, Forward and reload', async () => {
  const f = fixture('/health?metric=sleep&days=180'); await f.ready();
  assert.equal(f.el('chart-title').textContent, '睡眠趋势');
  assert.equal(f.document.querySelector('[data-days="180"]')!.getAttribute('aria-pressed'), 'true');
  f.click('[data-metric="weight"]'); f.click('[data-days="7"]');
  assert.equal(f.location.pathname + f.location.search, '/health?metric=weight&days=7');
  assert.equal(f.el('chart-title').textContent, '体重变化');
  f.history.back(); assert.equal(f.location.search, '?metric=weight&days=180');
  assert.equal(f.document.querySelector('[data-days="180"]')!.getAttribute('aria-pressed'), 'true');
  f.history.back(); assert.equal(f.location.search, '?metric=sleep&days=180');
  assert.equal(f.el('chart-title').textContent, '睡眠趋势');
  f.history.forward(); assert.equal(f.el('chart-title').textContent, '体重变化');
  const reloaded = fixture(f.location.pathname + f.location.search); await reloaded.ready();
  assert.equal(reloaded.el('chart-title').textContent, '体重变化');
  assert.equal(reloaded.document.querySelector('[data-days="180"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(f.requests.length, 1);
});

test('chart question entry shares the selected metric and range as a draft and computed body fat stays unsupported',async()=>{
  const f=fixture('/health?metric=sleep&days=180');await f.ready();
  const details:unknown[]=[];f.window.addEventListener('health-assistant-open',(event)=>details.push((event as unknown as CustomEvent).detail));
  f.click('#ask-health-chart');
  assert.equal(details.length,1);assert.equal((details[0] as {metric:string}).metric,'sleep');assert.equal((details[0] as {days:number}).days,180);
  assert.match((details[0] as {question:string}).question,/180.*睡眠/);
  assert.equal(f.requests.some((r)=>r.method==='POST'),false);
  f.click('[data-metric="body_fat"]');f.click('#ask-health-chart');assert.equal(details.length,1);
});

test('health and sync navigation create reversible entries and goals links expand the calendar', async () => {
  const f = fixture('/health?metric=active_energy&days=90#goals'); await f.ready();
  assert.equal(f.el('health-goals-disclosure').open, true);
  f.click('[data-page="sync"]'); assert.equal(f.location.pathname, '/sync');
  assert.equal(f.el('overview-page').hidden, true); assert.equal(f.el('sync-page').hidden, false);
  f.history.back(); assert.equal(f.el('overview-page').hidden, false);
  assert.equal(f.el('chart-title').textContent, '活动能量变化');
  f.history.forward(); assert.equal(f.el('sync-page').hidden, false);
  f.click('[data-page="overview"]'); assert.equal(f.location.search, '?metric=active_energy&days=90');
  assert.equal(f.requests.some((item) => item.method === 'POST'), false);
});

test('reloading sync preserves the selected health metric and range for the return to health', async () => {
  const f = fixture('/health?metric=sleep&days=180'); await f.ready();
  f.click('[data-page="sync"]');
  const reloaded = fixture('/sync', [], structuredClone(f.history.state)); await reloaded.ready();
  assert.equal(reloaded.el('sync-page').hidden, false);
  reloaded.click('[data-page="overview"]');
  assert.equal(reloaded.location.search, '?metric=sleep&days=180');
  assert.equal(reloaded.el('chart-title').textContent, '睡眠趋势');
  assert.equal(reloaded.document.querySelector('[data-days="180"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(reloaded.requests.some((item) => item.method === 'POST'), false);
});

test('manual shortcut handoff clears the sensitive fragment and does not auto-submit or add payload history', async () => {
  const payload = encodeURIComponent(JSON.stringify({ version: 1, measurements: [] }));
  const f = fixture('/sync#payload=' + payload); await f.ready();
  await settled(() => f.el('import-dialog').hasAttribute('open'));
  assert.equal(f.location.hash, ''); assert.equal(f.location.pathname, '/sync');
  assert.ok(f.entries.every((entry) => !entry.url.includes('payload') && !entry.url.includes('device')));
  assert.equal(f.entries.length, 1);
  assert.equal(f.requests.some((item) => item.method === 'POST'), false);
});

test('non-sleep trends retain a readable scrollable chart instead of shrinking labels to phone width', async () => {
  const f = fixture('/health?metric=steps&days=7', [{ metric: 'steps', value: 5000, day: '2026-11-11', startDate: '2026-11-11T00:00:00+08:00' }]);
  await f.ready();
  assert.equal(f.el('chart-wrap').querySelector('.metric-chart-scroll')?.getAttribute('tabindex'), '0');
  assert.match(f.el('chart-wrap').textContent ?? '', /横向滑动/);
});

test('expanding goals preserves the existing editable target dialog even when progress cannot load', async () => {
  const { window, document } = parseHTML(renderApp());
  const dialog = document.getElementById('goal-dialog')!;
  Object.defineProperty(dialog, 'open', { get: () => dialog.hasAttribute('open') });
  Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); } });
  const script = [...document.querySelectorAll('script')].find((node) => node.textContent?.includes("document.querySelector('[data-health-goals]')"))!.textContent!;
  const fetch = async (path: string) => path === '/api/health/goals'
    ? Response.json({ targets: { steps: 8000, sleep: 7.5, active_energy: 500 }, updatedAt: null })
    : Response.json({ error: '合成的读取失败' }, { status: 503 });
  runInNewContext(script, { window, document, fetch, location: { pathname: '/health', search: '', hash: '' },
    Intl, Date, URL, URLSearchParams, AbortController, Event: window.Event });
  (document.getElementById('health-goals-disclosure')! as unknown as { open: boolean }).open = true;
  document.querySelector('[data-goal-open]')!.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settled(() => !(document.getElementById('goal-save')! as unknown as { disabled: boolean }).disabled);
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal((document.getElementById('goal-input-steps')! as unknown as { value: string }).value, '8000');
  assert.equal((document.getElementById('goal-input-sleep')! as unknown as { value: string }).value, '7.5');
});
