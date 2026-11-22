import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { parseDateRangeQuery } from './date-range.ts';

// Source-level DOM tests cannot detect identifier renaming inside Function#toString.
// Exercise the exact HTML emitted by the minified production module after build.
const directory = resolve(import.meta.dirname, '../dist/server/_next/static');
const hasBuild = existsSync(directory);
let htmlPromise: Promise<string> | undefined;

async function productionHtml(): Promise<string> {
  htmlPromise ??= (async () => {
    assert.ok(hasBuild, 'Run npm run build before the production-client regression check');
    const candidates = readdirSync(directory).filter((name) => name.endsWith('.js')
      && readFileSync(resolve(directory, name), 'utf8').includes('读取健康记录中')
      && readFileSync(resolve(directory, name), 'utf8').includes('overview-page'));
    assert.ok(candidates.length, 'Production output must contain the health page module');
    for (const name of candidates) {
      const module = await import(pathToFileURL(resolve(directory, name)).href) as Record<string, unknown>;
      for (const exported of Object.values(module)) {
        if (typeof exported !== 'function') continue;
        const html: unknown = exported();
        if (typeof html === 'string' && html.includes('id="overview-page"') && html.includes('id="chart-wrap"')) return html;
      }
    }
    throw new Error('No production health page renderer was found');
  })();
  return htmlPromise;
}

async function settle(check: () => boolean) {
  for (let count = 0; count < 50; count++) {
    if (check()) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  assert.ok(check(), 'The production health page must leave its initial loading state');
}

async function fixture(path: string, savedState: unknown = null) {
  const { window, document } = parseHTML(await productionHtml());
  let url = new URL(path, 'https://production-health-check.example');
  const location = {
    get origin() { return url.origin; }, get pathname() { return url.pathname; },
    get search() { return url.search; }, get hash() { return url.hash; }, get href() { return url.href; },
  };
  const history = {
    state: savedState,
    replaceState(value: unknown, _unused: string, path: string) { this.state = value; url = new URL(path, url); },
    pushState(value: unknown, _unused: string, path: string) { this.state = value; url = new URL(path, url); },
  };
  document.querySelectorAll('dialog').forEach((dialog) => Object.assign(dialog, {
    showModal() { dialog.setAttribute('open', ''); },
    close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); },
  }));
  const requests: Array<{ url: string; method: string }> = [];
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const measurements = [
    { metric: 'steps', value: 5000, unit: 'count' },
    { metric: 'sleep', value: 7.5, unit: 'hours' },
  ].map((item) => ({ ...item, day: today, aggregation: 'daily', source: 'synthetic-production-check',
    startDate: today + 'T00:00:00+08:00', endDate: today + 'T08:00:00+08:00' }));
  const fetch = async (path: string, options?: RequestInit) => {
    requests.push({ url: path, method: options?.method ?? 'GET' });
    if (path.startsWith('/api/health?')) return Response.json({ measurements, lastSync: null, bodyComposition: null });
    if (path.startsWith('/api/health/apple-activity?')) {
      const { from, to } = parseDateRangeQuery(new URL(path, url.origin).searchParams, Date.now(), 30);
      return Response.json({ from, to, vitals: [], workouts: [] });
    }
    if (path === '/api/health/goals/progress') return Response.json({ error: 'Synthetic goal failure' }, { status: 503 });
    if (path === '/api/sync/devices') return Response.json({ devices: [] });
    throw new Error('Unexpected production-client request: ' + path);
  };
  const context = { window, document, location, history, navigator: {}, fetch, URL, URLSearchParams,
    TextEncoder, AbortController, crypto: webcrypto, Intl, Date, Event: window.Event, Element: window.Element,
    setTimeout, clearTimeout, queueMicrotask, requestAnimationFrame: (callback: () => void) => { callback(); return 0; } };
  for (const [index, script] of [...document.querySelectorAll('script')].entries()) {
    if (script.getAttribute('src') || !script.textContent?.trim()) continue;
    runInNewContext(script.textContent, context, { timeout: 2000, filename: 'built-health-inline-' + index + '.js' });
  }
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await settle(() => document.getElementById('banner-title')!.textContent !== '读取健康记录中');
  return { window, document, location, requests };
}

test('minified production health scripts initialize, request records and finish loading independently of goal errors', { skip: !hasBuild }, async () => {
  const f = await fixture('/health?metric=sleep&days=180');
  assert.equal(f.document.getElementById('banner-title')!.textContent, '记录已加载');
  assert.equal(f.document.getElementById('data-banner')!.hidden, true);
  assert.equal(f.document.getElementById('chart-title')!.textContent, '睡眠趋势');
  assert.equal(f.document.querySelector('[data-days="180"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(f.requests.filter((item) => item.url === '/api/health?days=360').length, 1);
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});

test('minified production sync initialization restores the saved health filters before returning to health', { skip: !hasBuild }, async () => {
  const f = await fixture('/sync', { healthView: { metric: 'sleep', days: 180 } });
  assert.equal(f.document.getElementById('sync-page')!.hidden, false);
  f.document.querySelector('[data-page="overview"]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(f.location.pathname + f.location.search, '/health?metric=sleep&days=180');
  assert.equal(f.document.getElementById('chart-title')!.textContent, '睡眠趋势');
  assert.equal(f.document.getElementById('banner-title')!.textContent, '记录已加载');
});
