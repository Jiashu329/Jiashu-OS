import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderApp } from '../ui.ts';
import { renderHomeApp } from '../home-ui.ts';
import { renderFinanceApp } from '../finance-ui.ts';

const finance = { status: 'ready', accountCount: 0, currencies: [], accounts: [], summary: { byCurrency: {} }, meta: { today: '2026-11-11' } };
const overview = { asOf: '2026-11-11T12:00:00Z', today: '2026-11-11',
  health: { status: 'ready', metrics: [], lastSync: null, recordedMetricCount: 0 }, finance: { personal: finance, family: finance }, priorities: [] };
const pages = [
  { key: 'health', html: () => renderApp(), marker: 'function parseSyncFragment(', path: '/health', request: '/api/health?', retry: 'retry-load', title: 'banner-title', error: '暂时没有读取成功', success: '暂无健康记录', payload: { measurements: [], lastSync: null, bodyComposition: null }, detail: 'banner-description' },
  { key: 'finance', html: () => renderFinanceApp(), marker: 'const ledgerLabels=', path: '/finance', request: '/api/finance?', retry: 'retry', title: 'status-title', error: '账本读取失败', success: '账本已更新', payload: finance, detail: 'status-detail' },
  { key: 'home', html: () => renderHomeApp(), marker: 'const metricLabels=', path: '/', request: '/api/overview', retry: 'refresh', title: 'status-title', error: '加载失败', success: '部分数据读取失败', payload: overview, detail: 'status-detail' },
];

function fixture(page: typeof pages[number], fetchMain: () => Promise<unknown>) {
  const { window, document } = parseHTML(page.html());
  const location = new URL(page.path, 'https://synthetic-read.example');
  const history = { state: null as unknown, replaceState(value: unknown) { this.state = value; }, pushState(value: unknown) { this.state = value; } };
  document.querySelectorAll('dialog').forEach((dialog) => Object.assign(dialog, {
    showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); },
  }));
  const source = [...document.querySelectorAll('script')].find((script) => script.textContent?.includes(page.marker))!.textContent!;
  const fetch = async (url: string) => url.startsWith(page.request) ? fetchMain() : Response.json({ devices: [] });
  const context = { window, document, location, history, navigator: {}, fetch, URL, URLSearchParams, TextEncoder,
    crypto, AbortController, Intl, Date, Event: window.Event, Element: window.Element, queueMicrotask,
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay >= 20000 ? 10 : delay), clearTimeout,
    requestAnimationFrame: (callback: () => void) => { callback(); return 0; } };
  runInNewContext(source, context);
  const el = (id: string) => document.getElementById(id)!;
  return { document, window, el, retry: () => el(page.retry).dispatchEvent(new window.Event('click', { bubbles: true })) };
}
async function settled(check: () => boolean) {
  for (let count = 0; count < 100; count++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.ok(check(), 'The real page must leave its loading state');
}

for (const page of pages) {
  test(page.key + ' exits a hanging request and user retry reloads the page data', async () => {
    let calls = 0;
    const f = fixture(page, async () => ++calls === 1 ? new Promise(() => {}) : Response.json(page.payload));
    await settled(() => f.el(page.title).textContent === page.error);
    assert.match(f.el(page.detail).textContent!, /超时/); assert.equal(f.el(page.retry).hasAttribute('disabled'), false);
    f.retry(); await settled(() => calls === 2 && f.el(page.title).textContent === page.success);
    assert.equal(calls, 2);
    if (page.key === 'home') assert.equal(f.el('overview-content').getAttribute('aria-busy'), 'false');
  });
  test(page.key + ' exposes safe server diagnostics and permits retry after 503', async () => {
    const f = fixture(page, async () => Response.json({ error: '合成存储失败', diagnosticId: 'b'.repeat(32) }, { status: 503 }));
    await settled(() => f.el(page.title).textContent === page.error);
    assert.match(f.el(page.detail).textContent!, /诊断编号：b{32}/);
    assert.equal(f.el(page.retry).hasAttribute('disabled'), false);
  });
}

test('home partial failure identifies its module and the last success observed on this page', async () => {
  let calls = 0;
  const f = fixture(pages[2], async () => Response.json(++calls === 1 ? overview : {
    ...overview, health: { status: 'unavailable', metrics: [] }, modules: { health: { status: 'unavailable', diagnosticId: 'c'.repeat(32) } },
  }));
  await settled(() => calls === 1 && f.el('refresh').hasAttribute('disabled') === false);
  f.retry(); await settled(() => f.el('status-detail').textContent?.includes('诊断编号：' + 'c'.repeat(32)) === true);
  assert.match(f.el('status-detail').textContent!, /健康暂不可用/); assert.match(f.el('status-detail').textContent!, /上次成功读取/);
  assert.equal(f.el('overview-content').hasAttribute('hidden'), false);
});
