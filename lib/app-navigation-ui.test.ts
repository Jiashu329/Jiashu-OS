import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderAppSidebar } from './app-sidebar.ts';
import { renderAppNavigationScript } from './app-navigation-ui.ts';

function fixture(pathname: string, search = '') {
  const { window, document } = parseHTML('<!doctype html><html><body><div class="app">' + renderAppSidebar('health', { healthNavigation: true }) + '<main></main></div></body></html>');
  const location = { pathname, search };
  const source = renderAppNavigationScript().replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  const run = () => runInNewContext(source, { window, document, location, Element: window.Element, URLSearchParams, queueMicrotask });
  run();
  return { window, document, location, run, sidebar: document.querySelector('[data-app-sidebar]')!,
    navigate(path: string, query = '') { location.pathname = path; location.search = query; window.dispatchEvent(new window.Event('jiashu-navigation')); } };
}

test('context navigation follows the actual secondary page and keeps the right module visible', () => {
  const f = fixture('/health/nutrition');
  assert.equal(f.sidebar.querySelector('[data-context-path="/health/nutrition"]')!.getAttribute('aria-current'), 'page');
  assert.equal(f.sidebar.querySelector('[data-navigation-group="health"]')!.hasAttribute('hidden'), false);
  assert.equal(f.sidebar.querySelector('[data-navigation-group="finance"]')!.hasAttribute('hidden'), true);
  f.navigate('/sync');
  assert.equal(f.sidebar.querySelector('[data-navigation-group="health"]')!.hasAttribute('hidden'), true);
  assert.equal(f.sidebar.querySelector('[data-navigation-group="sync"]')!.hasAttribute('hidden'), false);
  assert.equal(f.sidebar.querySelector('[data-navigation-page="sync"]')!.getAttribute('aria-current'), 'page');
  f.navigate('/');
  assert.equal(f.sidebar.querySelectorAll('[data-navigation-group]:not([hidden])').length, 0);
});

test('financial subnavigation carries ledger and currency but drops unrelated and untrusted parameters', () => {
  const f = fixture('/finance/goals', '?ledger=family&currency=USD&token=private-value&month=2026-11');
  assert.equal(f.sidebar.querySelector('[data-context-path="/finance/balances"]')!.getAttribute('href'), '/finance/balances?ledger=family&currency=USD');
  assert.equal(f.sidebar.querySelector('[data-context-path="/finance/goals"]')!.getAttribute('aria-current'), 'page');
  f.navigate('/finance', '?ledger=attacker&currency=javascript:alert(1)');
  assert.equal(f.sidebar.querySelector('[data-context-path="/finance/balances"]')!.getAttribute('href'), '/finance/balances');
});

test('guide and AI settings routes select their correct module, including browser back restoration', () => {
  const f = fixture('/connect-sleep');
  assert.equal(f.sidebar.querySelector('[data-context-path="/connect-sleep"]')!.getAttribute('aria-current'), 'page');
  f.location.pathname = '/settings/ai'; f.window.dispatchEvent(new f.window.Event('popstate'));
  assert.equal(f.sidebar.querySelector('[data-navigation-page="health"]')!.getAttribute('aria-current'), 'true');
  assert.equal(f.sidebar.querySelector('[data-context-path="/settings/ai"]')!.getAttribute('aria-current'), 'page');
  f.run();
  assert.equal(f.document.querySelectorAll('[data-app-sidebar]').length, 1);
  assert.equal(f.document.querySelectorAll('#health-chat').length, 1);
});

test('mouse and keyboard ledger changes on every financial subpage update contextual destinations', async () => {
  for (const [path, attribute] of [['/finance/goals', 'data-fg-ledger'], ['/finance/runway', 'data-runway-ledger'],
    ['/finance/review', 'data-review-ledger'], ['/finance/balances', 'data-check-ledger']]) {
    const f = fixture(path, '?ledger=personal&currency=USD');
    const tab = f.document.createElement('button'); tab.setAttribute(attribute, 'family');
    f.document.querySelector('main')!.appendChild(tab);
    tab.addEventListener('click', () => { f.location.search = '?ledger=family&currency=USD'; });
    tab.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(f.sidebar.querySelector('[data-context-path="/finance/goals"]')!.getAttribute('href'), '/finance/goals?ledger=family&currency=USD');
    tab.addEventListener('keydown', () => { f.location.search = '?ledger=personal&currency=USD'; });
    tab.dispatchEvent(new f.window.Event('keydown', { bubbles: true }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(f.sidebar.querySelector('[data-context-path="/finance/goals"]')!.getAttribute('href'), '/finance/goals?ledger=personal&currency=USD');
  }
});
