import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import mcd from '../data/food-catalog-releases/mcd-cn-2025-04-v1.json' with { type: 'json' };
import { renderFoodLibraryPage } from '../food-library-page.ts';
import { FOOD_LIBRARY_CSS, FOOD_LIBRARY_SCRIPT } from './food-library-ui.ts';

const foods = mcd.foods;
const categories = [...new Set(foods.map((food) => food.category))].map((name) => ({ name, count: foods.filter((food) => food.category === name).length }));
type Reply = { foods: unknown[]; categories: typeof categories; total: number; images?: Record<string, {src:string;alt:string}> };
type Responder = (url: URL) => Response | Promise<Response>;
async function settled(check: () => boolean) {
  for (let count = 0; count < 80; count++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'Food library operation did not settle');
}
function fixture(options: { search?: string; responder?: Responder } = {}) {
  const { window, document } = parseHTML(renderFoodLibraryPage());
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? this.querySelector('option')?.getAttribute('value') ?? ''; },
    set(value: string) { for (const option of this.querySelectorAll('option')) { if (option.getAttribute('value') === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } },
  });
  const event = (name: string) => new window.Event(name, { bubbles: true, cancelable: true });
  const dialog = document.getElementById('food-library-dialog')!;
  Object.defineProperty(dialog, 'open', { configurable: true, get() { return dialog.hasAttribute('open'); } });
  Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(event('close')); } });
  let focused: Element | null = null;
  Object.defineProperty(window.HTMLElement.prototype, 'focus', { configurable: true, value() { focused = this; } });
  const location = { origin: 'https://food.test', pathname: '/health/foods', search: options.search ?? '' };
  const visited: string[] = [];
  const updateLocation = (path: string) => { const url = new URL(path, location.origin); location.pathname = url.pathname; location.search = url.search; visited.push(path); };
  const history = { pushState(_state: unknown, _title: string, path: string) { updateLocation(path); }, replaceState(_state: unknown, _title: string, path: string) { updateLocation(path); } };
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  let next: Responder | null = options.responder ?? null;
  const session = { document, changed: false, async request(input: string, init: RequestInit) {
    const url = new URL(input, location.origin); requests.push({ url, init });
    const responder = next; next = null; if (responder) return responder(url);
    const query = url.searchParams.get('q') || '', category = url.searchParams.get('category') || '', offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit'));
    const matches = foods.filter((food) => (!category || food.category === category) && (!query || food.name.includes(query) || food.aliases.some((alias) => alias.includes(query))));
    return Response.json({ foods: matches.slice(offset, offset + limit), categories, total: matches.length, images: Object.fromEntries(matches.map((food) => [food.id, {src:'/food-images/mcd-cn/'+food.id.split(':')[1]+'.png',alt:food.name}])) } satisfies Reply);
  } };
  Object.assign(window, { JiashuAccountSession: session });
  runInNewContext(FOOD_LIBRARY_SCRIPT, { window, document, location, history, URL, URLSearchParams, Element: window.Element, AbortController, setTimeout, clearTimeout });
  const el = (id: string) => document.getElementById('food-library-' + id)! as unknown as HTMLElement & { value: string; hidden: boolean; disabled: boolean; open: boolean };
  const click = (target: string | Element) => (typeof target === 'string' ? el(target) : target).dispatchEvent(event('click'));
  return { window, document, session, requests, visited, location, el, click,
    submit() { el('filter').dispatchEvent(event('submit')); },
    changeCategory(category: string) { el('category').value = category; el('category').dispatchEvent(event('change')); },
    next(responder: Responder) { next = responder; },
    ready() { return settled(() => el('list').getAttribute('aria-busy') === 'false'); },
    get focused() { return focused; },
  };
}

test('food library restores shareable search/category/page URL state and uses identity-aware read transport', async () => {
  const app = fixture({ search: '?q=&category=' + encodeURIComponent('汉堡和卷') + '&offset=24&ignored=1' });
  await app.ready();
  assert.equal(app.requests[0].url.pathname, '/api/health/nutrition/foods');
  assert.equal(app.requests[0].url.searchParams.get('limit'), '24');
  assert.equal(app.requests[0].url.searchParams.get('category'), '汉堡和卷');
  assert.equal(app.requests.every((request) => request.init.method === 'GET' && request.init.cache === 'no-store'), true);
  assert.equal(new URLSearchParams(app.location.search).has('ignored'), false);
  assert.equal(app.el('category').value, '汉堡和卷');
  assert.equal(app.document.querySelectorAll('#food-library-category option').length, 9);
  app.click('clear'); await app.ready();
  assert.equal(app.document.querySelectorAll('.fl-card').length, 24);
  assert.equal(app.el('count').textContent, '共 137 个规格 · 显示 1–24');
  app.click('next'); await app.ready();
  assert.equal(new URLSearchParams(app.location.search).get('offset'), '24');
  assert.equal(app.el('page-number').textContent, '第 2 / 6 页');
  app.click('previous'); await app.ready();
  assert.equal(new URLSearchParams(app.location.search).has('offset'), false);
});

test('search and category filtering reset pagination and browser back restores the view', async () => {
  const app = fixture(); await app.ready();
  app.click('next'); await app.ready();
  app.el('query').value = '巨无霸'; app.submit(); await app.ready();
  assert.equal(app.document.querySelectorAll('.fl-card').length, 1);
  assert.equal(new URLSearchParams(app.location.search).get('q'), '巨无霸');
  assert.equal(new URLSearchParams(app.location.search).has('offset'), false);
  assert.equal(app.el('pagination').hidden, true);
  app.location.search = '?category=' + encodeURIComponent('饮品');
  app.window.dispatchEvent(new app.window.Event('popstate')); await app.ready();
  assert.equal(app.el('category').value, '饮品');
  assert.ok(app.el('list').textContent?.includes('可口可乐'));
});

test('cards and three-dot menu open read-only official serving details and an explicit recording link', async () => {
  const app = fixture(); await app.ready();
  const trigger = app.document.querySelector('[data-food-open="0"]')!;
  app.click(trigger);
  assert.equal(app.el('dialog').open, true);
  assert.match(app.el('detail-title').textContent || '', /巨无霸/);
  assert.match(app.el('detail').textContent || '', /513/);
  assert.match(app.el('detail').textContent || '', /961 mg/);
  assert.match(app.el('detail').textContent || '', /2025-04/);
  assert.match(app.el('detail').textContent || '', /没有可靠克重/);
  assert.equal(app.el('record').getAttribute('href'), '/health/nutrition?food=mcd-cn%3A49%3A28');
  assert.equal(app.document.querySelector('.fl-menu a')?.getAttribute('href'), app.el('record').getAttribute('href'));
  assert.equal(app.requests.length, 1);
  assert.equal(app.focused, app.el('close'));
  app.click('detail-done'); assert.equal(app.el('dialog').open, false); assert.equal(app.focused, trigger);
  app.click(app.document.querySelector('.fl-menu button')!); assert.equal(app.el('dialog').open, true);
  assert.equal(app.requests.every((request) => request.init.method === 'GET'), true);
});

test('zero and missing macros remain distinct in details, card labels are escaped, and detail rings show energy proportions', async () => {
  const base = foods[0];
  const app = fixture({ responder: () => Response.json({ foods: [
    { ...base, name: '<img onerror="bad()">', serving: { ...base.serving, carbs: 0, protein: 0, fat: 0, kcal: 0, energyKj: 0 } },
    { ...base, name: '缺少脂肪值', serving: { ...base.serving, fat: undefined } },
    base,
  ], total: 3, categories }) }); await app.ready();
  assert.equal(app.el('list').querySelector('img'), null);
  assert.match(app.el('list').textContent || '', /<img onerror="bad\(\)">/);
  const cards = [...app.document.querySelectorAll('.fl-card')];
  assert.equal(app.el('list').querySelectorAll('.fl-ring').length, 0);
  app.click(cards[0].querySelector('[data-food-open]')!);
  assert.equal(app.el('detail').querySelector('.fl-ring-missing'), null);
  assert.match(app.el('detail').textContent || '', /三项营养素均为0/);
  app.click('detail-done');
  app.click(cards[1].querySelector('[data-food-open]')!);
  assert.ok(app.el('detail').querySelector('.fl-ring-missing'));
  assert.equal(app.el('detail').querySelectorAll('.fl-ring-carbs,.fl-ring-protein,.fl-ring-fat').length, 0);
  app.click('detail-done');
  app.click(cards[2].querySelector('[data-food-open]')!);
  const arcs = [...app.el('detail').querySelectorAll('.fl-ring-carbs,.fl-ring-protein,.fl-ring-fat')];
  assert.equal(arcs.length, 3);
  const expected = base.serving.carbs * 4 / (base.serving.carbs * 4 + base.serving.protein * 4 + base.serving.fat * 9) * 100;
  assert.ok(Math.abs(Number(arcs[0].getAttribute('stroke-dasharray')?.split(' ')[0]) - expected) < .001);
});

test('cards render local official photos with stable dimensions and keep nutrition rings in details', async () => {
  const app = fixture(); await app.ready();
  const image = app.el('list').querySelector('img[data-food-image]')!;
  assert.equal(image.getAttribute('src'), '/food-images/mcd-cn/49.png');
  assert.match(image.getAttribute('alt') ?? '', /巨无霸/);
  assert.equal(image.getAttribute('width'), '88');
  assert.equal(image.getAttribute('height'), '80');
  assert.equal(image.getAttribute('loading'), 'lazy');
  assert.equal(image.getAttribute('decoding'), 'async');
  assert.equal(image.hasAttribute('onerror'), false);
  assert.equal(image.closest('.fl-product-image')?.querySelector('.fl-image-fallback')?.hasAttribute('hidden'), true);
  assert.equal(app.el('list').querySelectorAll('.fl-ring').length, 0);
  assert.equal(app.document.querySelector('.fl-legend'), null);
  assert.match(app.document.querySelector('.fl-sources')?.textContent ?? '', /图片为官方餐品示意，份量以文字规格为准/);
  app.click(image);
  assert.equal(app.el('dialog').open, true);
  assert.equal(app.el('detail').querySelectorAll('.fl-ring').length, 1);
  assert.match(app.el('detail').textContent ?? '', /961 mg/);
});

test('missing or untrusted photos use a placeholder and a failed local photo never retries an external image', async () => {
  const first = foods[0], second = foods[1];
  const app = fixture({ responder: () => Response.json({foods:[first, second],total:2,categories,images:{[first.id]:{src:'https://untrusted.example/food.png',alt:'untrusted'}}}) }); await app.ready();
  assert.equal(app.el('list').querySelectorAll('img').length, 0);
  assert.equal(app.el('list').querySelectorAll('.fl-image-fallback:not([hidden])').length, 2);
  assert.equal(app.el('list').querySelectorAll('.fl-ring').length, 0);
  app.click('clear'); await app.ready();
  const image = app.el('list').querySelector('img[data-food-image]')!;
  image.dispatchEvent(new app.window.Event('error'));
  assert.equal(image.hasAttribute('hidden'), true);
  assert.equal(image.hasAttribute('src'), false);
  assert.equal(image.closest('.fl-product-image')?.querySelector('.fl-image-fallback')?.hasAttribute('hidden'), false);
  assert.equal(app.el('list').querySelectorAll('img[src^="http"]').length, 0);
  assert.equal(app.requests.length, 2);
});

test('a late response cannot replace a newer search and failed reads can be retried', async () => {
  let resolve!: (response: Response) => void;
  const app = fixture({ responder: () => new Promise<Response>((done) => { resolve = done; }) });
  app.el('query').value = '巨无霸'; app.submit(); await app.ready();
  assert.equal(app.document.querySelectorAll('.fl-card').length, 1);
  resolve(Response.json({ foods: foods.slice(0, 24), total: 137, categories }));
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(app.document.querySelectorAll('.fl-card').length, 1);
  assert.equal(app.el('query').value, '巨无霸');
  app.next(() => Response.json({ error: '暂时不可用' }, { status: 503 }));
  app.click('clear'); await app.ready();
  assert.equal(app.document.querySelectorAll('.fl-card').length, 0);
  assert.equal(app.el('retry').hidden, false);
  assert.equal(app.el('message').textContent, '暂时不可用');
  app.click('retry'); await app.ready();
  assert.equal(app.document.querySelectorAll('.fl-card').length, 24);
  assert.equal(app.el('status').hidden, true);
});

test('unauthenticated reads reveal a sign-in message and identity changes clear open content', async () => {
  const unauthorized = fixture({ responder: () => Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }) }); await unauthorized.ready();
  assert.match(unauthorized.el('message').textContent || '', /重新登录/);
  assert.equal(unauthorized.el('retry').hidden, true);
  assert.equal(unauthorized.document.querySelectorAll('.fl-card').length, 0);
  const app = fixture(); await app.ready(); app.click(app.document.querySelector('[data-food-open="0"]')!);
  app.session.changed = true;
  app.document.dispatchEvent(new app.window.Event('jiashu-account-changed'));
  assert.equal(app.el('dialog').open, false);
  assert.equal(app.el('list').textContent, '');
  assert.equal(app.el('detail').textContent, '');
  assert.equal(app.el('record').hasAttribute('href'), false);
});

test('the page uses three responsive columns with bounded main width and source-safe links', () => {
  const html = renderFoodLibraryPage();
  assert.match(FOOD_LIBRARY_CSS, /body \.app>main#food-library-page\{max-width:1160px/);
  assert.match(FOOD_LIBRARY_CSS, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(FOOD_LIBRARY_CSS, /@media\(max-width:500px\)\{\.fl-grid\{grid-template-columns:1fr/);
  assert.match(html, /营养数据更新于 2025 年 4 月/);
  assert.match(FOOD_LIBRARY_CSS, /object-fit:contain/);
  assert.match(html, /target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/);
  assert.doesNotMatch(html, /台湾|食药署|data\.gov\.tw/);
});

test('food library route authenticates its canonical URL and marks the document private to its render account', async () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('../app/health/foods/route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  let returnTo = '';
  const get = new Function('requireChatGPTUser', 'withPageAccount', 'renderFoodLibraryPage', source + '\nreturn GET;')(
    async (path: string) => { returnTo = path; return { userId: 'alice' }; },
    (html: string, userId: string) => html + '<!-- owner=' + userId + ' -->',
    renderFoodLibraryPage,
  ) as (request: Request) => Promise<Response>;
  const response = await get(new Request('https://food.test/health/foods?q=巨无霸&offset=25&ignored=1'));
  assert.equal(returnTo, '/health/foods?q=%E5%B7%A8%E6%97%A0%E9%9C%B8&offset=24');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await response.text(), /<!-- owner=alice -->/);
});
