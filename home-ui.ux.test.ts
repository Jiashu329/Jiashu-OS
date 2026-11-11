import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderHomeApp } from './home-ui.ts';

const metricKeys = ['steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass', 'body_fat'];
const snapshot = () => ({
  asOf: '2026-11-11T12:00:00Z', today: '2026-11-11',
  health: { status: 'ready', lastSync: '2026-11-11T11:00:00Z', recordedMetricCount: 6,
    metrics: metricKeys.map((metric) => ({ metric, value: 0, day: '2026-11-11', freshness: 'current', points: [{ day: '2026-11-11', value: 0 }], average7: 0, observedDays7: 1 })) },
  finance: Object.fromEntries(['personal', 'family'].map((ledger) => [ledger, { status: 'ready', accountCount: 0, currencies: [], oldestBalanceDate: null, latestBalanceDate: null, staleAccountCount: 0 }])),
  priorities: [{ id: 'synthetic-priority', tone: 'attention', title: '核对最近记录', detail: '这是合成测试事项。', href: '/health', actionLabel: '查看记录' }],
});

async function fixture(data = snapshot()) {
  const { document, window } = parseHTML(renderHomeApp());
  const script = [...document.querySelectorAll('script[type="module"]')].find((node) => node.textContent?.includes('const metricLabels='))!.textContent!;
  runInNewContext(script, { document, window, Event: window.Event, fetch: async () => Response.json(data), AbortController, URLSearchParams, Intl, Date, setTimeout, clearTimeout });
  for (let index = 0; index < 25 && document.getElementById('refresh')!.hasAttribute('disabled'); index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(document.getElementById('refresh')!.hasAttribute('disabled'), false);
  return { document, window };
}

test('all home metric cards deep-link to the same metric and a useful persisted range', async () => {
  const { document } = await fixture();
  for (const metric of metricKeys) {
    const card = document.querySelector('.metric-card.' + metric)!;
    const url = new URL(card.getAttribute('href')!, 'https://synthetic-home.example');
    assert.equal(url.pathname, '/health');
    assert.equal(url.searchParams.get('metric'), metric);
    assert.equal(url.searchParams.get('days'), ['weight', 'lean_body_mass', 'body_fat'].includes(metric) ? '90' : '30');
    assert.match(card.querySelector('.metric-value strong')!.textContent!, /^0$/);
    assert.match(card.querySelector('.metric-date')!.textContent!, /2026-11-11/);
  }
});

test('home keeps priorities ahead of the overview while goals are progressively disclosed and independently available', async () => {
  const { document } = await fixture();
  assert.equal(document.querySelector('main h1')!.textContent, '今日总览');
  const mainChildren = [...document.querySelector('main')!.children];
  assert.ok(mainChildren.indexOf(document.getElementById('focus-section')!) < mainChildren.indexOf(document.getElementById('overview-content')!));
  const disclosure = document.getElementById('home-goals-disclosure')!;
  assert.equal(disclosure.hasAttribute('open'), false);
  assert.ok(disclosure.querySelector('[data-goal-open]'));
  assert.ok(disclosure.querySelector('a[href="/health#goals"]'));
  assert.equal(document.getElementById('overview-content')!.contains(disclosure), false);
});

test('a failed overview does not remove the separate goals entry or misrepresent missing health values as zero', async () => {
  const data = snapshot();
  data.health.status = 'unavailable';
  data.finance.personal.status = 'unavailable'; data.finance.family.status = 'unavailable';
  const { document } = await fixture(data);
  assert.equal(document.getElementById('overview-content')!.hasAttribute('hidden'), true);
  assert.equal(document.getElementById('home-goals-disclosure')!.hasAttribute('hidden'), false);
  assert.match(document.getElementById('status-title')!.textContent!, /读取失败/);
  assert.match(document.querySelector('.metric-card.sleep .metric-value')!.textContent!, /暂时无法读取/);
});
