import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildHomeOverview } from './home-overview.ts';
import { buildHealthSummary } from './health.ts';
import { ACCOUNT_TYPES, CURRENCIES, buildFinanceSummary } from './finance.ts';

// These are minified-output DOM checks. They exercise initialization and actions,
// not browser layout, CSS rendering, touch hit testing or iPhone integration.
const directory = resolve(import.meta.dirname, '../dist/server/_next/static');
const hasBuild = existsSync(directory);
const htmlCache = new Map<string, Promise<string>>();
function productionHtml(marker: string) {
  if (!htmlCache.has(marker)) htmlCache.set(marker, (async () => {
    const candidates = readdirSync(directory).filter((name) => name.endsWith('.js') && readFileSync(resolve(directory, name), 'utf8').includes(marker));
    for (const name of candidates) {
      const path = resolve(directory, name), original = readFileSync(path, 'utf8');
      // Vinext inlines these private renderers into route chunks. Expose the
      // exact function passed to Response without executing the authenticated
      // GET handler or changing any renderer/client bytes.
      const renderers = [...original.matchAll(/new Response\(([$A-Z_a-z][$\w]*)\([^)]*\),/g)].map((match) => match[1]);
      if (!renderers.length) continue;
      const source = original.replace(/\bfrom\s*(["'`])(\.[^"'`]+)\1/g, (_match, _quote: string, specifier: string) => 'from ' + JSON.stringify(new URL(specifier, pathToFileURL(path)).href))
        + '\nexport {' + [...new Set(renderers)].map((name, index) => name + ' as __renderer' + index).join(',') + '};';
      const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')) as Record<string, unknown>;
      for (const [name, value] of Object.entries(module)) {
        if (!name.startsWith('__renderer') || typeof value !== 'function') continue;
        const html: unknown = value('synthetic-production-owner');
        if (typeof html === 'string' && html.startsWith('<!doctype html>') && html.includes(marker)) return html;
      }
    }
    throw new Error('No minified production renderer for ' + marker);
  })());
  return htmlCache.get(marker)!;
}
async function settle(check: () => boolean) {
  for (let count = 0; count < 60; count++) {
    if (check()) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  assert.ok(check(), 'The built client must finish initialization');
}
function storage() {
  const values = new Map<string, string>();
  return { getItem(key: string) { return values.get(key) ?? null; }, setItem(key: string, value: string) { values.set(key, String(value)); }, removeItem(key: string) { values.delete(key); }, clear() { values.clear(); } };
}
async function fixture(marker: string, path: string, width = 1280) {
  const html = await productionHtml(marker);
  const { window, document } = parseHTML(html);
  let current = new URL(path, 'https://synthetic-production.example');
  const location = {
    get origin() { return current.origin; }, get pathname() { return current.pathname; },
    get search() { return current.search; }, get hash() { return current.hash; }, get href() { return current.href; },
    replace(path: string) { current = new URL(path, current); },
  };
  const history = { state: null, replaceState(_data: unknown, _unused: string, path: string) { current = new URL(path, current); } };
  document.querySelectorAll('dialog').forEach((dialog) => Object.assign(dialog, {
    showModal() { dialog.setAttribute('open', ''); },
    close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); },
  }));
  // linkedom intentionally omits a browser select value setter.
  document.querySelectorAll('select').forEach((select) => Object.defineProperty(select, 'value', { writable: true, value: select.getAttribute('value') || select.querySelector('option')?.getAttribute('value') || '' }));
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  const sessionStorage = storage();
  Object.defineProperty(window, 'sessionStorage', { value: sessionStorage, configurable: true });
  const requests: Array<{ path: string; method: string }> = [];
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const overview = buildHomeOverview({ health: { summary: buildHealthSummary([]), lastSync: null }, personal: { accounts: [] }, family: { accounts: [] } });
  const fetch = async (url: string | URL, options?: RequestInit) => {
    const path = String(url), method = options?.method ?? 'GET';
    requests.push({ path, method });
    if (path === '/api/overview') return Response.json(overview);
    if (path.startsWith('/api/finance?')) return Response.json({ accounts: [], summary: buildFinanceSummary([], 'personal'), meta: { today, accountTypes: ACCOUNT_TYPES, currencies: CURRENCIES } });
    if (path === '/api/ai/settings') return Response.json({ settings: { configured: false, model: 'MiniMax-M3', region: 'cn', revision: 0, updatedAt: null, lastTestStatus: null, lastTestAt: null }, storageReady: true });
    if (path.startsWith('/api/health/assistant?')) return Response.json({ configuration: { ready: false, provider: 'MiniMax', model: 'MiniMax-M3', message: '请先设置连接' }, hasData: false,
      context: { version: 1, timezone: 'Asia/Shanghai', range: { from: today, to: today, today, days: 7 }, health: [], nutrition: { recordedDays: 0, days: [] }, limitations: ['暂无合成测试记录'] }, sources: [] });
    throw new Error('Unexpected production client request: ' + method + ' ' + path);
  };
  const context = { window, document, location, history, navigator: {}, sessionStorage, fetch, URL, URLSearchParams, TextEncoder, AbortController,
    crypto: webcrypto, Intl, Date, Event: window.Event, Element: window.Element, innerWidth: width,
    setTimeout, clearTimeout, queueMicrotask, requestAnimationFrame: (callback: () => void) => { callback(); return 0; } };
  for (const [index, script] of [...document.querySelectorAll('script')].entries()) {
    if (script.getAttribute('src') || !script.textContent?.trim()) continue;
    runInNewContext(script.textContent, context, { timeout: 2000, filename: 'built-app-inline-' + index + '.js' });
  }
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { window, document, requests, html };
}

test('production home initializes and displays an empty but available overview without model calls', { skip: !hasBuild }, async () => {
  const f = await fixture('overview-content', '/');
  await settle(() => f.document.getElementById('refresh')?.getAttribute('disabled') === null);
  assert.equal(f.document.getElementById('overview-content')?.getAttribute('aria-busy'), 'false');
  assert.equal(f.document.getElementById('overview-content')?.hidden, false);
  assert.equal(f.requests.filter((item) => item.path === '/api/overview').length, 1);
  assert.ok(f.requests.every((item) => item.method === 'GET' && !item.path.includes('assistant')));
});

test('production finance initializes its selected ledger and finishes rendering the empty-account action', { skip: !hasBuild }, async () => {
  const f = await fixture('id="account-list"', '/finance?ledger=personal&currency=CNY');
  await settle(() => Boolean(f.document.querySelector('[data-create]')));
  assert.equal(f.document.getElementById('status-banner')?.hidden, true);
  assert.equal(f.requests.filter((item) => item.path.startsWith('/api/finance?')).length, 1);
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});

test('production AI settings reads metadata and keeps connection tests behind user action', { skip: !hasBuild }, async () => {
  const f = await fixture('id="ai-settings-page"', '/settings/ai');
  await settle(() => f.document.getElementById('ai-settings-page')?.getAttribute('aria-busy') === 'false');
  assert.equal(f.document.getElementById('ai-settings-configured')?.textContent, '未配置');
  assert.equal((f.document.getElementById('ai-settings-api-key') as HTMLInputElement)?.value, '');
  assert.deepEqual(f.requests, [{ path: '/api/ai/settings', method: 'GET' }]);
});

test('390px production assistant fixture preserves navigation and accessible lazy chat controls', { skip: !hasBuild }, async () => {
  const f = await fixture('ha-intro-cards', '/health/assistant', 390);
  assert.match(f.html, /name="viewport"/);
  assert.match(f.html, /@media\(max-width:760px\)/);
  assert.equal(f.document.querySelectorAll('.nav-link').length, 4);
  assert.equal(f.document.getElementById('health-chat')?.getAttribute('data-initialized'), 'true');
  await settle(() => f.requests.length === 1 && f.document.getElementById('health-chat-context')?.hidden === false);
  assert.equal(f.document.getElementById('health-chat-panel')?.hidden, false);
  f.document.getElementById('health-chat-minimize')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(f.document.getElementById('health-chat-panel')?.hidden, true);
  const launcher = f.document.getElementById('health-chat-launcher')!;
  launcher.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => f.requests.length === 1 && f.document.getElementById('health-chat-context')?.hidden === false);
  assert.equal(launcher.getAttribute('aria-expanded'), 'true');
  assert.equal(f.document.getElementById('health-chat-panel')?.getAttribute('role'), 'dialog');
  assert.equal(f.document.getElementById('health-chat-panel')?.hidden, false);
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});

test('390px production backup page initializes every inline script and gates restore behind file preview and confirmation', async () => {
  const f = await fixture('id="backup-file"', '/data', 390);
  assert.match(f.html, /name="viewport"/);
  assert.match(f.html, /@media\(max-width:700px\)/);
  assert.equal(f.document.querySelectorAll('.nav-link').length, 4);
  assert.equal(f.document.querySelector('label[for="backup-file"]')?.textContent, '选择 Jiashu OS 完整备份 v1');
  const file = f.document.getElementById('backup-file')! as HTMLInputElement;
  const preview = f.document.getElementById('backup-preview')! as HTMLButtonElement;
  const restore = f.document.getElementById('backup-restore')! as HTMLButtonElement;
  const confirm = f.document.getElementById('backup-confirm')! as HTMLInputElement;
  assert.equal(file.disabled, false);
  assert.equal(preview.disabled, true);
  assert.equal(restore.disabled, true);
  assert.equal(Boolean(confirm.checked), false);
  assert.equal(f.document.getElementById('backup-summary')?.hidden, true);
  assert.equal(f.document.getElementById('backup-status')?.getAttribute('role'), 'status');
  assert.equal(f.document.getElementById('backup-status')?.getAttribute('aria-live'), 'polite');
  const download = f.document.getElementById('backup-export') as HTMLButtonElement;
  assert.ok(download, 'bounded backup export control is present');
  assert.equal(download.tagName, 'BUTTON');
  assert.equal(download.disabled, false);
  assert.equal(download.textContent, '下载完整备份 JSON');
  assert.equal(f.document.querySelector('.backup-table-wrap th[scope="col"]')?.textContent, '数据范围');
  assert.equal(f.document.querySelectorAll('.backup-table-wrap th[scope="col"]').length, 5);
  // No data is read or restored just by opening the page. Even synthetic click
  // dispatches on gated controls cannot start a request before a file/preview.
  preview.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  restore.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  confirm.checked = true;
  confirm.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  assert.equal(restore.disabled, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.document.getElementById('health-chat')?.getAttribute('data-initialized'), 'true');
});
