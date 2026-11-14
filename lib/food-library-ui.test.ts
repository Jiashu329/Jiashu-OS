import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import mcd from '../data/food-catalog-releases/mcd-cn-2025-04-v1.json' with { type: 'json' };
import mcdSource from '../data/food-catalog-sources/mcd-cn-2025-04.json' with { type: 'json' };
import { renderFoodLibraryPage } from '../food-library-page.ts';
import { FOOD_LIBRARY_CSS, FOOD_LIBRARY_SCRIPT } from './food-library-ui.ts';

const foods = mcd.foods;
const categories = [...new Set(foods.map((food) => food.category))].map((name) => ({ name, count: foods.filter((food) => food.category === name).length }));
type Reply = { foods: unknown[]; categories: typeof categories; total: number; images?: Record<string, {src:string;alt:string}>; brands?: Array<{id:string;name:string;count:number}>; sources?: unknown[] };
type Responder = (url: URL) => Response | Promise<Response>;
async function settled(check: () => boolean) {
  for (let count = 0; count < 80; count++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'Food library operation did not settle');
}
function fixture(options: { search?: string; responder?: Responder; catalog?: Array<{id:string;name:string;aliases:string[];category:string}> } = {}) {
  const catalog = options.catalog ?? foods;
  const brands = [{id:'mcd-cn',name:'麦当劳中国',count:catalog.filter(food=>food.id.startsWith('mcd-cn:')).length},{id:'luckin-cn',name:'瑞幸咖啡',count:catalog.filter(food=>food.id.startsWith('luckin-cn:')).length}];
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
    const query = url.searchParams.get('q') || '', brand=url.searchParams.get('brand')||'', category = url.searchParams.get('category') || '', offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit'));
    const brandCatalog = catalog.filter((food) => !brand || food.id.startsWith(brand+':'));
    const catalogCategories = [...new Set(brandCatalog.map((food) => food.category))].map((name) => ({name,count:brandCatalog.filter((food)=>food.category===name).length}));
    const matches = brandCatalog.filter((food) => (!category || food.category === category) && (!query || food.name.includes(query) || food.aliases.some((alias) => alias.includes(query))));
    return Response.json({ foods: matches.slice(offset, offset + limit), categories:catalogCategories, brands, sources:[mcdSource], total: matches.length, images: Object.fromEntries(matches.map((food) => [food.id, {src:'/food-images/'+food.id.split(':')[0]+'/'+food.id.split(':')[1]+'.png',alt:food.name}])) } satisfies Reply);
  } };
  Object.assign(window, { JiashuAccountSession: session });
  runInNewContext(FOOD_LIBRARY_SCRIPT, { window, document, location, history, URL, URLSearchParams, Element: window.Element, AbortController, setTimeout, clearTimeout });
  const el = (id: string) => document.getElementById('food-library-' + id)! as unknown as HTMLElement & { value: string; hidden: boolean; disabled: boolean; open: boolean };
  const click = (target: string | Element) => (typeof target === 'string' ? el(target) : target).dispatchEvent(event('click'));
  return { window, document, session, requests, visited, location, el, click,
    submit() { el('filter').dispatchEvent(event('submit')); },
    changeBrand(brand: string) { el('brand').value = brand; el('brand').dispatchEvent(event('change')); },
    changeCategory(category: string) { el('category').value = category; el('category').dispatchEvent(event('change')); },
    next(responder: Responder) { next = responder; },
    ready() { return settled(() => el('list').getAttribute('aria-busy') === 'false'); },
    get focused() { return focused; },
  };
}

test('food library restores shareable search/category/page URL state and uses identity-aware read transport', async () => {
  const app = fixture({ search: '?q=&category=' + encodeURIComponent('汉堡和卷') + '&offset=24&ignored=1' });
  await app.ready();
  assert.equal(app.requests[0].url.pathname, '/api/health/foods');
  assert.equal(app.requests[0].url.searchParams.get('limit'), '24');
  assert.equal(app.requests[0].url.searchParams.get('category'), '汉堡和卷');
  assert.equal(app.requests.every((request) => request.init.method === 'GET' && request.init.cache === 'no-store'), true);
  assert.equal(new URLSearchParams(app.location.search).has('ignored'), false);
  assert.equal(app.el('category').value, '汉堡和卷');
  assert.equal(app.document.querySelectorAll('#food-library-category option').length, 9);
  app.click('clear'); await app.ready();
  assert.equal(app.document.querySelectorAll('.fl-card').length, 24);
  assert.equal(app.el('count').textContent, '共 137 个条目 · 显示 1–24');
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

const luckinKnown = {
  ...foods[0], id:'luckin-cn:1', name:'瑞幸生椰拿铁', aliases:['瑞幸生椰拿铁'], category:'拿铁类', description:'官网热量适用于指定配置。',
  source:{name:'瑞幸咖啡官网产品信息',url:'https://lkcoffee.com/products/coconut-latte',recordId:'1',version:'2026-11-13官网快照（未注明营养更新日期）'},
  serving:{unit:'份',label:'大杯/冰/埃塞金烘/默认浓度/不另外加糖',originalLabel:null,kcal:179,energyKj:null,energyBasis:'officialKcal'},
};
const luckinUnknown = {
  basis:'catalogOnly', id:'luckin-cn:44', name:'瑞幸泰奶鸳鸯拿铁', aliases:['瑞幸泰奶鸳鸯拿铁'], category:'拿铁类',
  description:'官网仅公布部分营养信息。',source:{...luckinKnown.source,url:'https://lkcoffee.com/products/thai-yuen-yeung-latte',recordId:'44'},
  reference:{label:null,protein:6.5,caffeineMg:143.1},
};

test('brand changes reset pagination and category while preserving search and browser URL restoration', async () => {
  const app = fixture({catalog:[...foods,luckinKnown,luckinUnknown]});await app.ready();
  assert.equal(app.document.querySelectorAll('#food-library-brand option').length,3);
  app.click('next');await app.ready();
  app.changeCategory('汉堡和卷');await app.ready();
  app.changeBrand('luckin-cn');
  assert.equal(app.el('category').disabled,true);assert.equal(app.el('category').children.length,1);
  await app.ready();
  assert.equal(app.el('brand').value,'luckin-cn');assert.equal(app.el('category').value,'');
  assert.equal(app.el('category').disabled,false);assert.equal(app.el('category').children.length,2);
  assert.match(app.el('category').textContent??'',/拿铁类（2）/);assert.ok(!app.el('category').textContent?.includes('汉堡和卷'));
  assert.equal(app.el('list').children.length,2);assert.equal(app.el('pagination').hidden,true);
  assert.equal(new URLSearchParams(app.location.search).get('brand'),'luckin-cn');
  assert.equal(new URLSearchParams(app.location.search).has('category'),false);
  assert.equal(new URLSearchParams(app.location.search).has('offset'),false);
  assert.equal(app.requests.at(-1)?.url.searchParams.get('brand'),'luckin-cn');
  app.location.search='?brand=mcd-cn&offset=24';app.window.dispatchEvent(new app.window.Event('popstate'));await app.ready();
  assert.equal(app.el('brand').value,'mcd-cn');assert.equal(app.el('list').children.length,24);
  assert.equal(app.el('category').children.length,9);assert.ok(!app.el('category').textContent?.includes('拿铁类'));
  assert.equal(app.el('page-number').textContent,'第 2 / 6 页');
  app.click('clear');await app.ready();assert.equal(app.el('brand').value,'');assert.equal(app.el('count').textContent,'共 139 个条目 · 显示 1–24');
});

test('Luckin calories retain their exact official configuration and missing kJ or macros stay unpublished', async () => {
  const app=fixture({responder:()=>Response.json({foods:[luckinKnown],total:1,categories:[{name:'拿铁类',count:1}],brands:[{id:'luckin-cn',name:'瑞幸咖啡',count:1}],sources:[{name:luckinKnown.source.name,snapshotDate:'2026-11-13'}],images:{[luckinKnown.id]:{src:'/food-images/luckin-cn/1.jpeg',alt:'生椰拿铁'}}})});await app.ready();
  assert.equal(app.el('list').querySelector('img')?.getAttribute('src'),'/food-images/luckin-cn/1.jpeg');
  assert.match(app.el('list').textContent??'',/179/);assert.match(app.el('list').textContent??'',/大杯\/冰\/埃塞金烘\/默认浓度\/不另外加糖/);
  app.click(app.document.querySelector('[data-food-open]')!);
  const text=app.el('detail').textContent??'';assert.match(text,/179/);assert.match(text,/2026-11-13/);assert.doesNotMatch(text,/2026-11-12|2025-04/);
  const energyRow=[...app.el('detail').querySelectorAll('dl>div')].find(row=>row.querySelector('dt')?.textContent==='能量');
  assert.equal(energyRow?.querySelector('dd')?.textContent,'未公布');
  assert.equal(app.el('detail').querySelectorAll('.fl-ring-carbs,.fl-ring-protein,.fl-ring-fat').length,0);
  assert.ok(app.el('detail').querySelector('.fl-ring-missing'));assert.match(text,/修改杯型、冰热、糖度或配料后需重新核对/);
});

test('a catalog-only product displays unknown heat without inventing serving weight and offers manual confirmation', async () => {
  const app=fixture({catalog:[luckinUnknown]});await app.ready();
  assert.match(app.el('list').textContent??'',/热量未公布/);assert.match(app.el('list').textContent??'',/官网未注明固定规格/);
  assert.doesNotMatch(app.el('list').textContent??'',/0 kcal|null|NaN|每 100 克/);
  app.click(app.document.querySelector('[data-food-open]')!);
  const text=app.el('detail').textContent??'';
  assert.match(text,/蛋白质6.5 g/);assert.match(text,/咖啡因143.1 mg/);assert.match(text,/官网未公布此产品的热量/);
  assert.doesNotMatch(text,/0 kcal|null|NaN|每 100 克/);
  assert.equal(app.el('record').textContent,'带入手工核对');assert.equal(app.el('record').getAttribute('href'),'/health/nutrition?food=luckin-cn%3A44');
  assert.equal(app.requests.length,1);assert.ok(app.requests.every(item=>item.init.method==='GET'));
});


test('a stale cross-brand category link adopts the normalized category and first page without retaining a foreign option', async () => {
  const app=fixture({search:'?brand=luckin-cn&category='+encodeURIComponent('汉堡和卷')+'&offset=24',responder:()=>Response.json({foods:[luckinKnown,luckinUnknown],category:'',offset:0,total:2,categories:[{name:'拿铁类',count:2}],brands:[{id:'luckin-cn',name:'瑞幸',count:2}]})});
  await app.ready();
  assert.equal(app.el('brand').value,'luckin-cn');assert.equal(app.el('category').value,'');
  assert.equal(app.el('category').children.length,2);assert.ok(!app.el('category').textContent?.includes('汉堡和卷'));
  assert.equal(new URLSearchParams(app.location.search).has('category'),false);
  assert.equal(new URLSearchParams(app.location.search).has('offset'),false);
  assert.equal(app.el('list').children.length,2);assert.equal(app.requests.length,1);
});

const privateTemplate={basis:'template',id:'template:11111111-1111-4111-8111-111111111111:2',templateId:'11111111-1111-4111-8111-111111111111',revision:2,kind:'meal',name:'我的午餐',aliases:[],category:'整餐',state:'仅自己可见',brand:{id:'mine',name:'我的食物'},source:{name:'我的食物',url:'',recordId:'11111111-1111-4111-8111-111111111111',version:'版本2'},reference:{label:'1份',calories:320,protein:20,carbs:40,fat:10}};
const managedReference={basis:'managed',id:'managed:22222222-2222-4222-8222-222222222222:3',itemId:'22222222-2222-4222-8222-222222222222',revision:3,name:'管理员维护酸奶',aliases:[],category:'乳制品',state:'网站维护',brand:{id:'custom-yogurt',name:'酸奶品牌'},source:{name:'包装营养标签',url:'https://label.example/yogurt',recordId:'yogurt',version:'网站修订3'},reference:{label:'一杯200g',calories:120,protein:8,carbs:14,fat:0}};

test('all, public and personal scopes share one search while private templates keep their own use flow',async()=>{
  const metadata={brands:[{id:'mine',name:'我的食物',count:1},{id:'custom-yogurt',name:'酸奶品牌',count:1}],categories:[{name:'整餐',count:1},{name:'乳制品',count:1}]};
  const app=fixture({responder:()=>Response.json({...metadata,foods:[privateTemplate,managedReference],total:2,scope:'all',category:'',brand:'',offset:0,canManage:true,images:{[managedReference.id]:{src:'https://image.example/yogurt.png',alt:'酸奶'}}})});await app.ready();
  assert.equal(app.el('scope').value,'all');assert.equal(app.el('manage').hidden,false);
  assert.match(app.el('list').textContent??'',/仅自己可见/);
  app.click(app.el('list').querySelector('[data-food-open="0"]')!);
  assert.equal(app.el('record').textContent,'使用模板');assert.equal(app.el('record').getAttribute('href'),'/health/nutrition?template=11111111-1111-4111-8111-111111111111&templateRevision=2');
  assert.match(app.el('detail').textContent??'',/仅自己可见/);
  app.click('detail-done');
  app.next(()=>Response.json({...metadata,brands:[metadata.brands[0]],categories:[metadata.categories[0]],foods:[privateTemplate],total:1,scope:'mine',category:'',brand:'',offset:0,canManage:true}));
  app.el('scope').value='mine';app.el('scope').dispatchEvent(new app.window.Event('change',{bubbles:true}));await app.ready();
  assert.equal(app.requests.at(-1)?.url.searchParams.get('scope'),'mine');assert.equal(new URLSearchParams(app.location.search).get('scope'),'mine');assert.equal(app.el('list').children.length,1);
  app.next(()=>Response.json({...metadata,brands:[metadata.brands[1]],categories:[metadata.categories[1]],foods:[managedReference],total:1,scope:'public',category:'',brand:'',offset:0,canManage:false,images:{[managedReference.id]:{src:'https://image.example/yogurt.png',alt:'酸奶'}}}));
  app.el('scope').value='public';app.el('scope').dispatchEvent(new app.window.Event('change',{bubbles:true}));await app.ready();
  assert.equal(app.el('manage').hidden,true);assert.doesNotMatch(app.el('list').textContent??'',/我的午餐/);
  assert.equal(app.el('brand').querySelectorAll('option').length,2);assert.ok(app.el('brand').textContent?.includes('酸奶品牌'));
  assert.equal(app.el('list').querySelector('img')?.getAttribute('src'),'https://image.example/yogurt.png');
  assert.equal(app.el('list').querySelector('img')?.getAttribute('referrerpolicy'),'no-referrer');
  app.click(app.el('list').querySelector('[data-food-open]')!);assert.match(app.el('detail').textContent??'',/管理员维护的来源参考值/);assert.match(app.el('detail').textContent??'',/脂肪0 g/);
  assert.equal(app.el('record').textContent,'带入手工核对');assert.ok(app.requests.every(item=>item.init.method==='GET'));
});

test('changing a drink configuration removes official heat and macros until the exact official selection is restored',async()=>{
  const app=fixture({catalog:[luckinKnown]});await app.ready();app.click(app.el('list').querySelector('[data-food-open]')!);
  const temperature=app.el('detail').querySelector('[data-drink-field="temperature"]')! as unknown as HTMLSelectElement;
  const sweetness=app.el('detail').querySelector('[data-drink-field="sweetness"]')! as unknown as HTMLSelectElement;
  assert.match(app.el('detail').textContent??'',/179/);
  temperature.value='热';temperature.dispatchEvent(new app.window.Event('change',{bubbles:true}));
  assert.match(app.el('detail').textContent??'',/热量未公布/);assert.doesNotMatch(app.el('detail-nutrition').textContent??'',/179|0 kcal/);
  let query=new URL(app.el('record').getAttribute('href')!,'https://food.test').searchParams;
  assert.equal(query.get('temperature'),'热');assert.equal(query.get('cup'),'大杯');assert.equal(app.el('record').textContent,'带入手工核对');
  temperature.value='冰';temperature.dispatchEvent(new app.window.Event('change',{bubbles:true}));assert.match(app.el('detail-nutrition').textContent??'',/179/);
  sweetness.value='半糖';sweetness.dispatchEvent(new app.window.Event('change',{bubbles:true}));assert.match(app.el('detail-nutrition').textContent??'',/热量未公布/);
  sweetness.value='不另外加糖';sweetness.dispatchEvent(new app.window.Event('change',{bubbles:true}));assert.match(app.el('detail-nutrition').textContent??'',/179/);assert.equal(app.el('record').textContent,'记录此配置');
  assert.equal(app.requests.length,1);assert.equal(app.requests[0].init.method,'GET');
});
