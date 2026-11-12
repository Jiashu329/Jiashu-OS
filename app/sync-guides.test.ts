import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Script, runInNewContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { APP_THEME_CSS } from '../lib/app-theme.ts';
import { APP_BRAND_HEAD } from '../lib/branding.ts';
import { APP_SIDEBAR_CSS, renderAppSidebar } from '../lib/app-sidebar.ts';
import { multiDayStepsGuide } from '../lib/steps-guide.ts';
import { renderShortcutInstallCard, withShortcutInstallCard } from '../lib/shortcut-templates.ts';
import { withPageAccount } from '../lib/page-account.ts';

const ORIGIN = 'https://synthetic-sync-guide.example';
const pages = ['sync-guide', 'connect-steps', 'connect-sleep', 'connect-weight'] as const;

async function render(name: typeof pages[number], query = '') {
  const source = stripTypeScriptTypes(readFileSync(new URL('./' + name + '/route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const authorized: string[] = [];
  const bindings = { APP_THEME_CSS, APP_BRAND_HEAD, APP_SIDEBAR_CSS, renderAppSidebar, multiDayStepsGuide, renderShortcutInstallCard, withShortcutInstallCard, withPageAccount,
    requireChatGPTUser: async (path: string) => { authorized.push(path); return { userId: 'synthetic-guide-owner' }; } };
  const handler = new Function(...Object.keys(bindings), source + '\nreturn GET;')(...Object.values(bindings)) as (request: Request) => Promise<Response>;
  const response = await handler(new Request(ORIGIN + '/' + name + query));
  const html = await response.text();
  const { window, document } = parseHTML(html);
  return { response, html, authorized, window, document };
}

test('all synchronization guides use the shared navigation and exactly one health chat without losing the guide body', async () => {
  for (const name of pages) {
    const page = await render(name);
    assert.equal(page.response.status, 200);
    assert.equal(page.response.headers.get('cache-control'), 'no-store');
    assert.equal(page.authorized.length, 1);
    assert.equal(page.document.querySelectorAll('.app > aside.sidebar').length, 1);
    assert.equal(page.document.querySelectorAll('.app > main.sync-guide-main').length, 1);
    assert.equal(page.document.querySelectorAll('#health-chat').length, 1);
    assert.equal(page.document.querySelectorAll('.guide-breadcrumb [aria-current="page"]').length, 1);
    assert.equal(page.document.querySelectorAll('main .brand').length, 0);
    assert.ok(page.document.querySelector('main h1')?.textContent?.includes('同步'));
    for (const script of page.document.querySelectorAll('script')) new Script(script.textContent ?? '');
  }
});

test('daily steps and energy retain their distinct complete configuration and privacy controls', async () => {
  for (const metric of ['steps', 'active_energy'] as const) {
    const page = await render('connect-steps', metric === 'active_energy' ? '?metric=active_energy' : '');
    assert.equal(page.document.querySelectorAll('[data-step]').length, 9);
    assert.deepEqual(Array.from(page.document.querySelectorAll('#range option')).map((item) => item.getAttribute('value')),
      metric === 'active_energy' ? ['7', '30'] : ['7', '30', '90']);
    assert.equal(Boolean(page.document.getElementById('energy-unit')), metric === 'active_energy');
    assert.equal(page.document.getElementById('address')?.getAttribute('type'), 'password');
    assert.equal(page.document.getElementById('address')?.getAttribute('autocomplete'), 'off');
    assert.match(page.document.querySelector('.guide-breadcrumb')?.textContent ?? '', metric === 'active_energy' ? /活动能量配置/ : /步数配置/);
    assert.equal(page.authorized[0], metric === 'active_energy' ? '/connect-steps?metric=active_energy' : '/connect-steps');
    assert.match(page.html, /deviceToken=''/);
  }
});

test('sleep, body-composition and file-import guide safeguards remain accessible', async () => {
  const sleep = await render('connect-sleep');
  assert.equal(sleep.document.querySelectorAll('[data-step]').length, 9);
  for (const id of ['confirm-samples', 'source', 'sleep-days', 'navigation-status', 'address-status']) assert.ok(sleep.document.getElementById(id));
  assert.match(sleep.html, /next>1&&!samplesConfirmed/);
  const weight = await render('connect-weight');
  assert.equal(weight.document.querySelectorAll('[data-step]').length, 10);
  for (const id of ['confirm-samples', 'unit', 'lean-unit', 'reuse-connection', 'composition-instructions']) assert.ok(weight.document.getElementById(id));
  const file = await render('sync-guide', '?sleep=1#sleep-file-import');
  assert.ok(file.document.querySelector('.advanced-reference')?.hasAttribute('open'));
  assert.ok(file.document.getElementById('sleep-file-import'));
  assert.ok(file.document.getElementById('sleep-files'));
});

test('the shared shell preserves step navigation and does not generate a synchronization credential on load', async () => {
  const page = await render('connect-steps');
  const guideScript = Array.from(page.document.querySelectorAll('script')).at(-1)?.textContent ?? '';
  const assign: string[] = [];
  let requests = 0;
  for (const [id, value] of [['range', '7'], ['source', 'iPhone']] as const) {
    Object.defineProperty(page.document.getElementById(id), 'value', { configurable: true, writable: true, value });
  }
  page.window.HTMLElement.prototype.scrollIntoView = () => {};
  runInNewContext(guideScript, { document: page.document, location: { origin: ORIGIN, assign: (path: string) => assign.push(path) },
    navigator: {}, fetch: async () => { requests++; throw new Error('Unexpected network request'); } });
  const click = (id: string) => page.document.getElementById(id)!.dispatchEvent(new page.window.Event('click'));
  assert.equal(page.document.querySelector('[data-step="0"]')?.hasAttribute('hidden'), false);
  click('next');
  assert.equal(page.document.querySelector('[data-step="1"]')?.hasAttribute('hidden'), false);
  click('previous');
  assert.equal(page.document.querySelector('[data-step="0"]')?.hasAttribute('hidden'), false);
  for (let index = 0; index < 9; index++) click('next');
  assert.deepEqual(assign, ['/sync']); assert.equal(requests, 0);
});
