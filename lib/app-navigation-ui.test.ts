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

void test('nutrition exposes its food library, and health/sync contexts restore independently', () => {
  const f = fixture('/health/nutrition');
  assert.equal(f.sidebar.querySelector('[data-navigation-page="nutrition"]')!.getAttribute('aria-current'), 'page');
  assert.equal(f.sidebar.querySelector('[data-navigation-page="nutrition"]')!.getAttribute('href'), '/health/nutrition');
  assert.equal(f.sidebar.querySelector('[data-navigation-page="health"]')!.hasAttribute('aria-current'), false);
  assert.equal(f.sidebar.querySelectorAll('[data-navigation-group]:not([hidden])').length, 1);
  assert.equal(f.sidebar.querySelector('[data-navigation-group="nutrition"]')!.hasAttribute('hidden'), false);
  assert.equal(f.sidebar.querySelector('[data-context-path="/health/foods"]')!.getAttribute('href'), '/health/foods');
  assert.equal(f.sidebar.querySelector('[data-navigation-group="finance"]')!.hasAttribute('hidden'), true);
  f.navigate('/health/weight-plan');
  assert.equal(f.sidebar.querySelector('[data-navigation-page="health"]')!.getAttribute('aria-current'), 'true');
  assert.equal(f.sidebar.querySelector('[data-navigation-group="health"]')!.hasAttribute('hidden'), false);
  assert.equal(f.sidebar.querySelector('[data-navigation-page="nutrition"]')!.hasAttribute('aria-current'), false);
  f.navigate('/sync');
  assert.equal(f.sidebar.querySelector('[data-navigation-group="health"]')!.hasAttribute('hidden'), true);
  assert.equal(f.sidebar.querySelector('[data-navigation-group="sync"]')!.hasAttribute('hidden'), false);
  assert.equal(f.sidebar.querySelector('[data-navigation-page="sync"]')!.getAttribute('aria-current'), 'page');
  f.navigate('/');
  assert.equal(f.sidebar.querySelectorAll('[data-navigation-group]:not([hidden])').length, 0);
});

void test('the food library has a direct contextual entry and retains the nutrition module through navigation', () => {
  const { document } = parseHTML(renderAppSidebar('foods'));
  assert.equal(document.querySelector('[data-navigation-page="nutrition"]')!.getAttribute('aria-current'), 'true');
  assert.equal(document.querySelector('[data-context-path="/health/foods"]')!.getAttribute('aria-current'), 'page');
  assert.equal(document.querySelector('[data-navigation-group="nutrition"]')!.hasAttribute('hidden'), false);
  const f = fixture('/health/foods', '?q=巨无霸&category=汉堡');
  assert.equal(f.sidebar.querySelector('[data-navigation-page="nutrition"]')!.getAttribute('aria-current'), 'true');
  assert.equal(f.sidebar.querySelector('[data-context-path="/health/foods"]')!.getAttribute('aria-current'), 'page');
  f.navigate('/health/nutrition');
  assert.equal(f.sidebar.querySelector('[data-context-path="/health/nutrition"]')!.getAttribute('aria-current'), 'page');
  assert.equal(f.sidebar.querySelector('[data-context-path="/health/foods"]')!.hasAttribute('aria-current'), false);
});

void test('every application shell offers six direct primary destinations including media before scripts run', () => {
  for (const page of ['home','health','nutrition','douban','finance','sync'] as const) {
    const { document } = parseHTML(renderAppSidebar(page, {healthNavigation: page === 'health'}));
    const main = document.querySelector('nav[aria-label="主要页面"]')!;
    assert.equal(main.children.length, 6);
    assert.deepEqual([...main.querySelectorAll('[data-navigation-page]')].map(link => link.getAttribute('data-navigation-page')), ['home','health','nutrition','douban','finance','sync']);
    const nutrition = main.querySelector('[data-navigation-page="nutrition"]')!;
    assert.equal(nutrition.tagName, 'A');
    assert.equal(nutrition.getAttribute('href'), '/health/nutrition');
    assert.equal(nutrition.textContent, '饮食');
    assert.equal(nutrition.getAttribute('aria-current'), page === 'nutrition' ? 'page' : null);
    const media = main.querySelector('[data-navigation-page="douban"]')!;
    assert.equal(media.tagName, 'A'); assert.equal(media.getAttribute('href'), '/life/douban'); assert.equal(media.textContent, '书影音');
    assert.equal(media.getAttribute('aria-current'), page === 'douban' ? 'page' : null);
    assert.equal(document.querySelector('.sidebar-utilities a[href="/life/douban"]'), null);
    assert.equal(main.querySelectorAll('[aria-current="page"]').length, 1);
  }
});

void test('media renders one initial category and supports an explicit category before navigation scripts run', () => {
  for (const kind of ['all', 'movie', 'series', 'book', 'music', 'screen']) {
    const { document } = parseHTML(renderAppSidebar('douban', { doubanKind: kind }));
    const context = document.querySelector('[data-navigation-group="douban"]')!;
    assert.equal(context.hasAttribute('hidden'), false);
    assert.equal(context.querySelectorAll('[aria-current="page"]').length, 1);
    assert.equal(context.querySelector('[aria-current="page"]')!.getAttribute('data-context-kind'), kind);
    assert.equal(context.querySelector('[data-context-kind="book"]')!.getAttribute('href'), '/life/douban?kind=book');
  }
  const { document } = parseHTML(renderAppSidebar('douban'));
  assert.equal(document.querySelector('[data-context-kind="all"]')!.getAttribute('aria-current'), 'page');
});

void test('media context is query-aware and keeps exactly one active category through URL and browser history changes', () => {
  const f = fixture('/life/douban', '?kind=book');
  const context = f.sidebar.querySelector('[data-navigation-group="douban"]')!;
  assert.equal(f.sidebar.querySelector('[data-navigation-page="douban"]')!.getAttribute('aria-current'), 'page');
  for (const kind of ['book', 'movie', 'series', 'music', 'screen', 'all']) {
    f.navigate('/life/douban', kind === 'all' ? '' : '?kind=' + kind);
    assert.equal(context.querySelectorAll('[aria-current="page"]').length, 1);
    assert.equal(context.querySelectorAll('.active').length, 1);
    assert.equal(context.querySelector('[aria-current="page"]')!.getAttribute('data-context-kind'), kind);
    assert.equal(context.querySelector('[data-context-kind="movie"]')!.getAttribute('href'), '/life/douban?kind=movie');
  }
  f.location.search = '?kind=series'; f.window.dispatchEvent(new f.window.Event('popstate'));
  assert.equal(context.querySelector('[aria-current="page"]')!.getAttribute('data-context-kind'), 'series');
  f.navigate('/health'); assert.equal(context.hasAttribute('hidden'), true); assert.equal(context.querySelectorAll('[aria-current]').length, 0);
  f.navigate('/life/douban', '?kind=unknown'); assert.equal(context.querySelector('[aria-current="page"]')!.getAttribute('data-context-kind'), 'all');
  f.navigate('/life/douban', '?kind=movie&kind=book'); assert.equal(context.querySelector('[aria-current="page"]')!.getAttribute('data-context-kind'), 'movie');
});

void test('switching media categories preserves only valid search and source filters and resets pagination', () => {
  const f = fixture('/life/douban', '?kind=movie&q=%20%E7%8E%B0%E4%BB%A3%20&profile=current&offset=48&token=private&ledger=family');
  for (const kind of ['all','movie','series','book','music','screen']) {
    const link = f.sidebar.querySelector('[data-context-kind="' + kind + '"]')!;
    const target = new URL(link.getAttribute('href')!, 'https://synthetic.example');
    assert.equal(target.pathname, '/life/douban'); assert.equal(target.searchParams.get('kind'), kind === 'all' ? null : kind);
    assert.equal(target.searchParams.get('q'), '现代'); assert.equal(target.searchParams.get('profile'), 'current');
    assert.equal(target.searchParams.get('offset'), null); assert.equal(target.searchParams.get('token'), null); assert.equal(target.searchParams.get('ledger'), null);
    assert.equal(target.searchParams.size, kind === 'all' ? 2 : 3);
  }
  for (const search of ['?q=one&q=two&profile=current&profile=all', '?q=%00private&profile=other', '?q=' + 'x'.repeat(101)]) {
    f.navigate('/life/douban', search);
    assert.equal(f.sidebar.querySelector('[data-context-kind="book"]')!.getAttribute('href'), '/life/douban?kind=book');
  }
  f.navigate('/life/douban', '?q=legit&profile=all');
  assert.equal(f.sidebar.querySelector('[data-context-kind="all"]')!.getAttribute('href'), '/life/douban?q=legit&profile=all');
});

void test('financial subnavigation carries ledger and currency but drops unrelated and untrusted parameters', () => {
  const f = fixture('/finance/goals', '?ledger=family&currency=USD&token=private-value&month=2026-11');
  assert.equal(f.sidebar.querySelector('[data-context-path="/finance/balances"]')!.getAttribute('href'), '/finance/balances?ledger=family&currency=USD');
  assert.equal(f.sidebar.querySelector('[data-context-path="/finance/goals"]')!.getAttribute('aria-current'), 'page');
  f.navigate('/finance', '?ledger=attacker&currency=javascript:alert(1)');
  assert.equal(f.sidebar.querySelector('[data-context-path="/finance/balances"]')!.getAttribute('href'), '/finance/balances');
});

void test('guide and AI settings routes select their correct module, including browser back restoration', () => {
  const f = fixture('/connect-sleep');
  assert.equal(f.sidebar.querySelector('[data-context-path="/connect-sleep"]')!.getAttribute('aria-current'), 'page');
  f.location.pathname = '/settings/ai'; f.window.dispatchEvent(new f.window.Event('popstate'));
  assert.equal(f.sidebar.querySelector('[data-navigation-page="health"]')!.getAttribute('aria-current'), 'true');
  assert.equal(f.sidebar.querySelector('[data-context-path="/settings/ai"]')!.getAttribute('aria-current'), 'page');
  f.run();
  assert.equal(f.document.querySelectorAll('[data-app-sidebar]').length, 1);
  assert.equal(f.document.querySelectorAll('#health-chat').length, 1);
});

void test('mouse and keyboard ledger changes on every financial subpage update contextual destinations', async () => {
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

void test('family navigation retains an authorized book and generation while personal navigation drops both', () => {
  const book = '11111111-1111-4111-8111-111111111111';
  const f = fixture('/finance/goals', '?ledger=family&currency=USD&book='+book+'&bookRevision=2&token=private');
  const href = f.sidebar.querySelector('[data-context-path="/finance/runway"]')!.getAttribute('href')!;
  const target = new URL(href, 'https://synthetic.example');
  assert.equal(target.searchParams.get('book'), book);
  assert.equal(target.searchParams.get('bookRevision'), '2');
  assert.equal(target.searchParams.get('token'), null);
  f.navigate('/finance', '?ledger=personal&currency=CNY&book='+book+'&bookRevision=2');
  assert.equal(f.sidebar.querySelector('[data-context-path="/finance/goals"]')!.getAttribute('href'), '/finance/goals?ledger=personal&currency=CNY');
});
