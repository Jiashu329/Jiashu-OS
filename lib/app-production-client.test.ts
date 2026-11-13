import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import ts from 'typescript';
import { buildHomeOverview } from './home-overview.ts';
import { buildHealthSummary } from './health.ts';
import { ACCOUNT_TYPES, CURRENCIES, buildFinanceSummary } from './finance.ts';
import { buildNutritionReview, parseNutritionQuery } from './nutrition.ts';
import { buildNutritionInsight, parseNutritionInsightQuery } from './nutrition-review.ts';
import { EMPTY_NUTRITION_GOALS } from './nutrition-goals.ts';
import { FOOD_CATALOG_SOURCES, getFood } from './food-catalog.ts';
import { FOOD_LIBRARY_BRANDS, foodLibraryCategories, browseFoodLibrary, getLibraryFood } from './food-library-catalog.ts';
import { foodCatalogImages } from './food-catalog-images.ts';

// These are minified-output DOM checks. They exercise initialization and actions,
// not browser layout, CSS rendering, touch hit testing or iPhone integration.
const directory = resolve(import.meta.dirname, '../dist/server/_next/static');
const hasBuild = existsSync(directory);
// Node 22.13 supports asynchronous ESM loader registration; registerHooks is
// deliberately avoided so the release gate uses the supported Node baseline.
register(new URL('../scripts/worker-renderer-loader.mjs', import.meta.url), import.meta.url);
const htmlCache = new Map<string, Promise<string>>();
function rendererModule(original: string, path: string, marker: string): string | null {
  const tree = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map<string, ts.Node>();
  const responseBodies: ts.Expression[] = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer.body);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Response' && node.arguments?.[0]) responseBodies.push(node.arguments[0]);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.startsWith('.')) replacements.push({ start: node.moduleSpecifier.getStart(tree), end: node.moduleSpecifier.end,
        value: JSON.stringify(new URL(node.moduleSpecifier.text, pathToFileURL(path)).href) });
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const renderers = new Set<string>();
  for (const body of responseBodies) {
    // Response(withPageAccount(renderPage(owner), owner), options): follow the
    // HTML argument through wrappers and expose only the actual local renderer.
    // Looking at AST calls avoids matching serialized browser code in strings.
    let current = body;
    while (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)) {
        const name = current.expression.text;
        if (functions.get(name)?.getText(tree).includes(marker)) renderers.add(name);
      }
      if (!current.arguments[0]) break;
      current = current.arguments[0];
    }
  }
  if (!renderers.size) return null;
  // Resolve only real module specifiers. Renderer bodies and the browser source
  // inside their template literals remain byte-for-byte as built.
  let source = original;
  for (const change of replacements.sort((a, b) => b.start - a.start)) source = source.slice(0, change.start) + change.value + source.slice(change.end);
  return source + '\nexport {' + [...renderers].map((name, index) => name + ' as __renderer' + index).join(',') + '};';
}
function productionHtml(marker: string) {
  if (!htmlCache.has(marker)) htmlCache.set(marker, (async () => {
    const candidates = readdirSync(directory).filter((name) => name.endsWith('.js') && readFileSync(resolve(directory, name), 'utf8').includes(marker));
    for (const name of candidates) {
      const path = resolve(directory, name), original = readFileSync(path, 'utf8');
      const source = rendererModule(original, path, marker);
      if (!source) continue;
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
function storage(seed: Record<string,string> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  return { getItem(key: string) { return values.get(key) ?? null; }, setItem(key: string, value: string) { values.set(key, String(value)); }, removeItem(key: string) { values.delete(key); }, clear() { values.clear(); }, snapshot() { return Object.fromEntries(values); } };
}
async function fixture(marker: string, path: string, width = 1280, seedStorage: Record<string,string> = {}, catalog: { foods: readonly unknown[]; sources?: readonly unknown[]; aiCanManage?: boolean; aiConfigured?: boolean; financeBooks?: Array<Record<string, unknown>> } = { foods: [] }) {
  const html = await productionHtml(marker);
  const { window, document } = parseHTML(html);
  let current = new URL(path, 'https://synthetic-production.example');
  const location = {
    get origin() { return current.origin; }, get pathname() { return current.pathname; },
    get search() { return current.search; }, get hash() { return current.hash; }, get href() { return current.href; },
    replace(path: string) { current = new URL(path, current); },
  };
  const history = { state: null,
    replaceState(_data: unknown, _unused: string, path: string) { current = new URL(path, current); },
    pushState(_data: unknown, _unused: string, path: string) { current = new URL(path, current); } };
  document.querySelectorAll('dialog').forEach((dialog) => {
    Object.defineProperty(dialog,'open',{configurable:true,get(){return dialog.hasAttribute('open');}});
    Object.assign(dialog, {
      showModal() { dialog.setAttribute('open', ''); },
      close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); },
    });
  });
  // linkedom intentionally omits a browser select value setter.
  document.querySelectorAll('select').forEach((select) => Object.defineProperty(select, 'value', {
    configurable: true,
    get() { const option = select.querySelector('option[selected]') ?? select.querySelector('option'); return option?.getAttribute('value') ?? option?.textContent ?? ''; },
    set(value: string) { for (const option of select.querySelectorAll('option')) { if (option.getAttribute('value') === String(value)) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } },
  }));
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reset() {
    form.querySelectorAll('input,textarea,select').forEach((element) => {
      const field = element as unknown as HTMLInputElement;
      field.value = element.tagName === 'SELECT' ? element.querySelector('option')?.getAttribute('value') ?? '' : element.getAttribute('value') ?? '';
    });
  } }));
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  const sessionStorage = storage(seedStorage);
  Object.defineProperty(window, 'sessionStorage', { value: sessionStorage, configurable: true });
  const localStorage = storage();
  Object.defineProperty(window, 'localStorage', { value: localStorage, configurable: true });
  const requests: Array<{ path: string; method: string }> = [];
  const identityRequests: Array<{ path: string; method: string }> = [];
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const overview = buildHomeOverview({ health: { summary: buildHealthSummary([]), lastSync: null }, personal: { accounts: [] }, family: { accounts: [] }, nutrition: { entries: [], statuses: [], goals: EMPTY_NUTRITION_GOALS } });
  const fetch = async (url: string | URL, options?: RequestInit) => {
    const path = String(url), method = options?.method ?? 'GET';
    // Initializing any page must remain read-only, even when session storage
    // contains another signed-in owner's original pending requests.
    if (method !== 'GET') throw new Error('Unexpected automatic production write: ' + method + ' ' + path);
    // The account chrome now performs an independent identity read. Preserve
    // the business-call assertions below while also enforcing its read-only,
    // payload-free contract instead of counting it as a data/model operation.
    if (path === '/api/session') {
      assert.equal(options?.body, undefined, 'identity checks cannot send cached form or draft contents');
      identityRequests.push({ path, method });
      return Response.json({ userId: 'synthetic-production-owner', displayName: 'Synthetic account', email: 'synthetic@example.invalid', isOwner: false });
    }
    requests.push({ path, method });
    if (path === '/api/overview') return Response.json(overview);
    if (path === '/api/finance/books') return Response.json({ books: catalog.financeBooks ?? [{ id: 'own', name: '我的家庭账本', ownerName: 'Synthetic account', role: 'owner', accessRevision: 0, canManageMembers: true, canExport: true }], invitations: [] });
    if (path.startsWith('/api/finance?')) { const ledger = new URL(path, location.origin).searchParams.get('ledger') === 'family' ? 'family' : 'personal'; return Response.json({ ledger, accounts: [], summary: buildFinanceSummary([], ledger), meta: { today, accountTypes: ACCOUNT_TYPES, currencies: CURRENCIES } }); }
    if (path === '/api/ai/settings') return Response.json({ scope: 'site', canManage: catalog.aiCanManage !== false, settings: { configured: catalog.aiConfigured === true, model: 'MiniMax-M3', region: 'cn', revision: 0, updatedAt: null, lastTestStatus: null, lastTestAt: null }, storageReady: true });
    if (path === '/api/health/import') return Response.json({ checkedAt: new Date().toISOString(), attempts: [], batches: [], metricStatus: [] });
    const parsed = new URL(path, location.origin);
    const emptyMealStates = { breakfast:'unrecorded',lunch:'unrecorded',dinner:'unrecorded',snack:'unrecorded' } as const;
    if (parsed.pathname === '/api/health/nutrition') {
      const selection = parseNutritionQuery(parsed.searchParams);
      return Response.json({...buildNutritionReview([],selection),recentFoods:[],dayStatus:{date:selection.date,complete:false,revision:0,meals:emptyMealStates}});
    }
    if (parsed.pathname === '/api/health/foods') {
      const metadata={brands:FOOD_LIBRARY_BRANDS,categories:foodLibraryCategories(parsed.searchParams.get('brand')??''),sources:FOOD_CATALOG_SOURCES};
      if (parsed.searchParams.has('id')) {
        const food=getLibraryFood(parsed.searchParams.get('id')!);
        return food?Response.json({food,...metadata,images:foodCatalogImages([food])}):Response.json({code:'FOOD_NOT_FOUND',error:'当前食物库中没有这项食品。'}, {status:404});
      }
      const result=browseFoodLibrary({query:parsed.searchParams.get('q')??'',category:parsed.searchParams.get('category')??'',brand:parsed.searchParams.get('brand')??'',offset:Number(parsed.searchParams.get('offset')??0),limit:Number(parsed.searchParams.get('limit')??24)});
      return Response.json({...result,...metadata,images:foodCatalogImages(result.foods)});
    }
    if (parsed.pathname === '/api/health/nutrition/foods') {
      if (parsed.searchParams.has('id')) {
        const food = getFood(parsed.searchParams.get('id')!);
        return food ? Response.json({food}) : Response.json({code:'FOOD_NOT_FOUND',error:'当前食物库中没有这项食品。'}, {status:404});
      }
      return Response.json({foods:catalog.foods,...(catalog.sources?{sources:catalog.sources}:{})});
    }
    if (parsed.pathname === '/api/health/nutrition/goals') return Response.json({ goals: EMPTY_NUTRITION_GOALS, weightPlan: null });
    if (parsed.pathname === '/api/health/nutrition/templates') return Response.json({ templates: [] });
    if (parsed.pathname === '/api/health/nutrition/reuse') return Response.json({favorites:[],recent:[]});
    if (parsed.pathname === '/api/health/nutrition/favorites') return Response.json({favorites:[]});
    if (parsed.pathname === '/api/health/nutrition/status') return Response.json({dayStatus:{date:parsed.searchParams.get('date') ?? today,complete:false,revision:0,meals:emptyMealStates}});
    if (parsed.pathname === '/api/health/nutrition/review') return Response.json(buildNutritionInsight([],[],parseNutritionInsightQuery(parsed.searchParams)));
    if (path.startsWith('/api/health/assistant?')) return Response.json({ configuration: { ready: false, provider: 'MiniMax', model: 'MiniMax-M3', message: '请先设置连接' }, hasData: false,
      context: { version: 1, timezone: 'Asia/Shanghai', range: { from: today, to: today, today, days: 7 }, health: [], nutrition: { recordedDays: 0, days: [] }, limitations: ['暂无合成测试记录'] }, sources: [] });
    throw new Error('Unexpected production client request: ' + method + ' ' + path);
  };
  const context = { window, document, location, history, navigator: {}, sessionStorage, localStorage, fetch, URL, URLSearchParams, TextEncoder, AbortController,
    crypto: webcrypto, Intl, Date, Event: window.Event, Element: window.Element, innerWidth: width,
    Headers, setTimeout, clearTimeout, queueMicrotask, requestAnimationFrame: (callback: () => void) => { callback(); return 0; } };
  for (const [index, script] of [...document.querySelectorAll('script')].entries()) {
    if (script.getAttribute('src') || !script.textContent?.trim()) continue;
    runInNewContext(script.textContent, context, { timeout: 2000, filename: 'built-app-inline-' + index + '.js' });
  }
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  assert.ok(identityRequests.every((request) => request.path === '/api/session' && request.method === 'GET'));
  return { window, document, requests, identityRequests, html, sessionStorage, location };
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

test('minified shared family initialization keeps the selected book in reads and navigation without accepting invitations or writing', { skip: !hasBuild }, async () => {
  const book='11111111-1111-4111-8111-111111111111';
  const choices=[{id:'own',name:'我的家庭账本',ownerName:'Synthetic account',role:'owner',accessRevision:0,canManageMembers:true,canExport:true},
    {id:book,name:'家庭账本',ownerName:'另一位家庭拥有人',role:'editor',accessRevision:2,canManageMembers:false,canExport:false}];
  const f=await fixture('id="account-list"','/finance?ledger=family&currency=CNY&book='+book+'&bookRevision=2',1280,{}, {foods:[],financeBooks:choices});
  await settle(()=>Boolean(f.document.querySelector('[data-create]')));
  assert.equal((f.document.getElementById('finance-books-select') as unknown as HTMLSelectElement).value,book);
  assert.equal(f.document.getElementById('finance-books-manage')?.hidden,true);
  const read=f.requests.find(item=>item.path.startsWith('/api/finance?'))!;assert.ok(read);
  assert.equal(new URL(read.path,'https://synthetic.example').searchParams.get('book'),book);
  assert.equal(new URL(read.path,'https://synthetic.example').searchParams.get('bookRevision'),'2');
  for(const id of ['finance-review-link','balance-check-link','finance-goals-link','finance-runway-link']){
    const href=f.document.getElementById(id)?.getAttribute('href');assert.ok(href);
    assert.equal(new URL(href,'https://synthetic.example').searchParams.get('book'),book);
  }
  assert.ok(f.requests.every(item=>item.method==='GET'));
});

test('production AI settings reads metadata and keeps connection tests behind user action', { skip: !hasBuild }, async () => {
  const f = await fixture('id="ai-settings-page"', '/settings/ai');
  await settle(() => f.document.getElementById('ai-settings-page')?.getAttribute('aria-busy') === 'false');
  assert.equal(f.document.getElementById('ai-settings-configured')?.textContent, '未配置');
  assert.equal((f.document.getElementById('ai-settings-api-key') as HTMLInputElement)?.value, '');
  assert.deepEqual(f.requests, [{ path: '/api/ai/settings', method: 'GET' }]);
});

test('production members use shared AI status without exposing configuration controls or dispatching settings writes', { skip: !hasBuild }, async () => {
  const f = await fixture('id="ai-settings-page"', '/settings/ai', 390, {}, { foods: [], aiCanManage: false, aiConfigured: true });
  await settle(() => f.document.getElementById('ai-settings-page')?.getAttribute('aria-busy') === 'false');
  for (const id of ['manage-panel', 'test-panel', 'delete-panel']) {
    assert.equal(f.document.getElementById('ai-settings-' + id)?.hidden, true);
  }
  assert.match(f.document.getElementById('ai-settings-shared-note')?.textContent ?? '', /无需/);
  assert.match(f.document.getElementById('ai-settings-summary-model')?.textContent ?? '', /MiniMax-M3/);
  assert.equal((f.document.getElementById('ai-settings-api-key') as HTMLInputElement).disabled, true);
  f.document.getElementById('ai-settings-form')!.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  for (const id of ['test', 'delete-open', 'delete-submit']) f.document.getElementById('ai-settings-' + id)!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.deepEqual(f.requests, [{ path: '/api/ai/settings', method: 'GET' }]);
});

test('390px production assistant fixture preserves navigation and accessible lazy chat controls', { skip: !hasBuild }, async () => {
  const f = await fixture('ha-intro-cards', '/health/assistant', 390);
  assert.match(f.html, /name="viewport"/);
  assert.match(f.html, /@media\(max-width:760px\)/);
  assert.equal(f.document.querySelectorAll('.nav-link').length, 5);
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
  assert.equal(f.document.querySelectorAll('.nav-link').length, 5);
  assert.equal(f.document.querySelector('label[for="backup-file"]')?.textContent, '选择完整备份，或清单与全部分卷');
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
  assert.equal(f.document.getElementById('backup-file')?.hasAttribute('multiple'), true);
  assert.ok(f.document.getElementById('backup-export-volumes'));
  assert.equal((f.document.getElementById('backup-saved') as HTMLButtonElement).disabled, true);
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

test('minified personal food templates open their lazy list and typed source fields without writing or parsing AI',async()=>{
  const f=await fixture('id="nutrition-page"','/health/nutrition',390);
  await settle(()=>f.document.getElementById('nutrition-page')?.getAttribute('aria-busy')==='false');
  const panel=f.document.getElementById('nutrition-templates')!;
  panel.setAttribute('open','');Object.assign(panel,{open:true});panel.dispatchEvent(new f.window.Event('toggle'));
  await settle(()=>f.document.getElementById('nutrition-templates-status')?.textContent?.includes('还没有模板')===true);
  f.document.getElementById('nutrition-template-new')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.equal(f.document.getElementById('nutrition-template-dialog')?.hasAttribute('open'),true);
  assert.ok(f.document.getElementById('nutrition-template-components')?.querySelector('[data-template-field="calories"]'));
  assert.ok(f.requests.some((request)=>request.path==='/api/health/nutrition/templates'));
  assert.ok(f.requests.every((request)=>request.method==='GET'&&!request.path.includes('/parse')));
});

test('390px minified photo entry stays local until recognition and preserves the original text draft',async()=>{
  const f=await fixture('id="nutrition-page"','/health/nutrition',390);
  await settle(()=>f.document.getElementById('nutrition-page')?.getAttribute('aria-busy')==='false');
  const text=f.document.getElementById('nutrition-ai-text') as HTMLTextAreaElement;text.value='保留尚未使用的文字描述';
  f.document.getElementById('nutrition-method-photo')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.equal(f.document.getElementById('nutrition-entry-photo')?.hidden,false);
  assert.equal((f.document.getElementById('nutrition-photo-recognize') as HTMLButtonElement).disabled,true);
  const album=f.document.getElementById('nutrition-photo-file')! as HTMLInputElement;
  assert.match(album.getAttribute('accept')??'',/image\/png/);assert.equal(album.hasAttribute('capture'),false);
  assert.equal(f.document.getElementById('nutrition-photo-camera')?.getAttribute('capture'),'environment');
  Object.defineProperty(album,'files',{configurable:true,value:[new File([],'empty.jpg',{type:'image/jpeg'})]});
  album.dispatchEvent(new f.window.Event('change',{bubbles:true}));
  await settle(()=>f.document.getElementById('nutrition-photo-status')?.textContent?.includes('非空')===true);
  assert.equal(f.document.getElementById('nutrition-photo-preview')?.hidden,true);
  f.document.querySelector('[data-entry-method="ai"]')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.equal(text.value,'保留尚未使用的文字描述');
  assert.ok(f.requests.every((request)=>request.method==='GET'&&!request.path.includes('/photo')&&!request.path.includes('/parse')));
});

test('production shortcut installation page waits for user action before taking a server-clock baseline', async () => {
  const f = await fixture('id="template-check"', '/sync/templates', 390);
  assert.equal(f.document.querySelectorAll('.template-grid .template-card').length, 4);
  assert.equal(f.document.querySelector('[data-context-path="/sync/templates"]')?.getAttribute('aria-current'), 'page');
  assert.match(f.document.getElementById('template-install')?.getAttribute('href') ?? '', /^https:\/\/www\.icloud\.com\/shortcuts\/[a-f0-9]{32}$/);
  assert.equal((f.document.getElementById('template-check-now') as HTMLButtonElement).disabled, true);
  assert.equal((f.document.getElementById('template-confirm') as HTMLInputElement).disabled, true);
  assert.equal(f.requests.length, 0);
  f.document.getElementById('template-start')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => (f.document.getElementById('template-check-now') as HTMLButtonElement).disabled === false);
  assert.equal((f.document.getElementById('template-check-now') as HTMLButtonElement).disabled, false);
  assert.equal((f.document.getElementById('template-confirm') as HTMLInputElement).disabled, true);
  assert.deepEqual(f.requests, [{ path: '/api/health/import', method: 'GET' }]);
});

test('390px minified nutrition opens direct recording with lazy history and protected drafts without automatic writes',async()=>{
  const today=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10);
  const foreignOwner='another-synthetic-owner',operation='11111111-1111-4111-8111-111111111111';
  const foreignStorage={
    ['jiashu-nutrition-create:'+foreignOwner]:JSON.stringify({key:operation,body:{date:today,meal:'breakfast',name:'OTHER_OWNER_PRIVATE_DRAFT',portion:'one',note:'',calories:null}}),
    ['jiashu-nutrition-copy:'+foreignOwner]:JSON.stringify({key:operation,body:{action:'copy',fromDate:today,fromMeal:'breakfast',toDate:today,toMeal:'lunch',previewToken:'a'.repeat(64)}}),
    ['jiashu-nutrition-favorite:'+foreignOwner]:JSON.stringify({key:operation,body:{entryId:operation,expectedRevision:1}}),
  };
  const f=await fixture('id="nutrition-page"','/health/nutrition?compose=1',390,foreignStorage);
  await settle(()=>f.document.getElementById('nutrition-page')?.getAttribute('aria-busy')==='false'&&f.document.getElementById('nutrition-content')?.hidden===false);
  assert.match(f.html,/name="viewport"/);
  assert.equal(f.document.querySelectorAll('.nav-link').length,5);
  assert.equal(f.document.querySelector('[data-navigation-page="nutrition"]')?.getAttribute('aria-current'),'page');
  assert.equal(f.document.getElementById('nutrition-total')?.textContent,'—');
  const ids=[...f.document.querySelectorAll('[id]')].map((element)=>element.id);
  assert.equal(new Set(ids).size,ids.length);
  for(const key of ['carbs','protein','fat'])assert.equal(f.document.getElementById('nutrition-'+key)?.tagName,'INPUT');
  assert.equal(f.document.getElementById('nutrition-entry-ai')?.hidden,false);
  assert.equal(f.document.querySelector('[data-entry-method="ai"]')?.getAttribute('aria-selected'),'true');
  assert.equal(f.document.querySelectorAll('[data-nutrition-add-meal]').length,4);
  assert.equal(f.document.querySelectorAll('[data-nutrition-copy-meal]').length,4);
  assert.equal(f.document.querySelectorAll('[data-nutrition-skip-meal]').length,4);
  assert.ok(f.document.querySelector('label[for="nutrition-day"]'));
  assert.ok(f.document.querySelector('label[for="nutrition-ai-text"]'));
  const historyPanel=f.document.getElementById('nutrition-history')! as unknown as HTMLDetailsElement;
  assert.equal(historyPanel.hasAttribute('open'),false);
  assert.ok(!f.requests.some((request)=>request.path.includes('/nutrition/review')));
  historyPanel.open=true;historyPanel.setAttribute('open','');historyPanel.dispatchEvent(new f.window.Event('toggle'));
  await settle(()=>Boolean(f.document.getElementById('nutrition-review-status')?.textContent?.includes('已记录部分')));
  assert.equal(f.document.getElementById('nutrition-review-chart')?.querySelectorAll('.is-missing').length,7);
  assert.match(f.document.getElementById('nutrition-review-summary')?.textContent ?? '',/暂无可比较日期/);
  assert.equal(f.document.getElementById('nutrition-pending')?.hidden,true);
  assert.equal(f.document.getElementById('nutrition-copy-pending')?.hidden,true);
  assert.equal(f.document.getElementById('nutrition-favorite-pending')?.hidden,true);
  assert.equal((f.document.getElementById('nutrition-add') as HTMLButtonElement).disabled,false);
  assert.equal((f.document.getElementById('nutrition-copy-open') as HTMLButtonElement).disabled,false);
  assert.equal(f.document.getElementById('nutrition-batch-dialog')?.hasAttribute('open'),false);
  assert.equal(f.document.getElementById('nutrition-copy-dialog')?.hasAttribute('open'),false);
  // Opening the manual form exercises its minified helper references without
  // parsing a meal, saving, marking status or invoking the provider.
  f.document.querySelector('[data-entry-method="manual"]')!.dispatchEvent(new f.window.Event('click',{bubbles:true,cancelable:true}));
  assert.equal(f.document.getElementById('nutrition-dialog')?.hasAttribute('open'),true);
  assert.equal((f.document.getElementById('nutrition-name') as HTMLInputElement).value,'');
  assert.ok(f.document.getElementById('nutrition-food-search-button'));
  assert.equal((f.document.getElementById('nutrition-save') as HTMLButtonElement).disabled,false);
  f.document.getElementById('nutrition-dialog-close')!.dispatchEvent(new f.window.Event('click',{bubbles:true,cancelable:true}));
  assert.equal(f.document.getElementById('nutrition-dialog')?.hasAttribute('open'),false);
  assert.equal(f.document.getElementById('health-chat')?.getAttribute('data-initialized'),'true');
  assert.ok(f.requests.every((request)=>request.method==='GET'&&!request.path.includes('/parse')&&!request.path.includes('/assistant')));
  assert.deepEqual(f.requests.map((request)=>new URL(request.path,'https://synthetic-production.example').pathname).sort(),['/api/health/nutrition','/api/health/nutrition/favorites','/api/health/nutrition/goals','/api/health/nutrition/review']);
  for(const [key,value] of Object.entries(foreignStorage))assert.equal(f.sessionStorage.getItem(key),value);
  assert.ok(!f.document.body.textContent?.includes('OTHER_OWNER_PRIVATE_DRAFT'));
});

test('minified official McDonald serving selection keeps its published SKU, half/two serving calories and separate source metadata', { skip: !hasBuild }, async()=>{
  const burger=getFood('mcd-cn:49:28');assert.ok(burger);assert.equal(burger.basis,'perServing');
  const f=await fixture('id="nutrition-page"','/health/nutrition',390,{}, {foods:[burger],sources:FOOD_CATALOG_SOURCES});
  await settle(()=>f.document.getElementById('nutrition-page')?.getAttribute('aria-busy')==='false');
  f.document.getElementById('nutrition-add')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  const search=f.document.getElementById('nutrition-food-search') as HTMLInputElement;search.value='麦当劳';
  f.document.getElementById('nutrition-food-search-button')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  await settle(()=>Boolean(f.document.querySelector('#nutrition-food-results [data-food-id]')));
  const results=f.document.getElementById('nutrition-food-results')!,choice=results.querySelector('[data-food-id]')!;
  assert.match(choice.textContent??'',/巨无霸.*每份 513 kcal/);
  assert.equal(results.querySelectorAll('details').length,FOOD_CATALOG_SOURCES.length);
  for(const source of FOOD_CATALOG_SOURCES)assert.ok([...results.querySelectorAll('a')].some((link)=>link.getAttribute('href')===source.url),'each source retains its own official citation');
  const brandSource=[...results.querySelectorAll('details')].find((node)=>node.textContent?.includes('麦当劳中国官网'))!;assert.ok(brandSource);assert.match(brandSource.textContent??'',/未提供开放数据许可/);assert.equal(brandSource.querySelectorAll('a').length,1);
  choice.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  const quantity=f.document.getElementById('nutrition-food-quantity') as HTMLInputElement;
  const unit=f.document.getElementById('nutrition-food-unit') as unknown as HTMLSelectElement;
  const calories=f.document.getElementById('nutrition-calories') as HTMLInputElement;
  assert.equal(quantity.value,'1');assert.deepEqual([...unit.querySelectorAll('option')].map((option)=>option.getAttribute('value')),['份']);
  assert.equal(calories.value,'513.0');
  quantity.value='0.5';quantity.dispatchEvent(new f.window.Event('input',{bubbles:true}));assert.equal(calories.value,'256.5');
  quantity.value='2';quantity.dispatchEvent(new f.window.Event('input',{bubbles:true}));assert.equal(calories.value,'1026.0');
  const preview=f.document.getElementById('nutrition-food-preview')!.textContent??'';
  assert.match(preview,/2 份/);assert.match(preview,/未提供可靠克重/);assert.ok(!/NaN|100g|nullg|0g/.test(preview));
  assert.ok(f.requests.every((request)=>request.method==='GET'&&!request.path.includes('/parse')&&!request.path.includes('/photo')));
});

test('minified food library browses the current catalog, paginates and opens read-only official nutrition details', { skip: !hasBuild }, async () => {
  const f = await fixture('id="food-library-page"', '/health/foods', 390);
  const list = f.document.getElementById('food-library-list')!;
  await settle(() => list.getAttribute('aria-busy') === 'false');
  assert.equal(list.children.length, 24);
  assert.equal(list.querySelectorAll('.fl-product-photo').length, 24);
  assert.equal(list.querySelectorAll('.fl-ring').length, 0);
  const photo = list.querySelector('.fl-product-photo')!;
  assert.equal(photo.getAttribute('src'), '/food-images/mcd-cn/49.png');
  assert.equal(photo.getAttribute('loading'), 'lazy');
  assert.equal(photo.getAttribute('width'), '88');
  assert.equal(photo.getAttribute('height'), '80');
  assert.ok(photo.getAttribute('alt'));
  photo.dispatchEvent(new f.window.Event('error'));
  assert.equal((photo as unknown as HTMLImageElement).hidden, true);
  assert.equal((photo.parentElement!.querySelector('.fl-image-fallback') as unknown as HTMLElement).hidden, false);
  assert.match(f.document.getElementById('food-library-count')?.textContent ?? '', /共 165 个条目/);
  assert.equal(f.document.querySelector('[data-context-path="/health/foods"]')?.getAttribute('aria-current'), 'page');
  const firstName = list.querySelector('.fl-card-name')?.textContent;
  list.querySelector('[data-food-open]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(f.document.getElementById('food-library-dialog')?.hasAttribute('open'), true);
  assert.equal(f.document.getElementById('food-library-detail-title')?.textContent, firstName);
  assert.equal(f.document.querySelectorAll('#food-library-detail .fl-ring').length, 1);
  assert.match(f.document.getElementById('food-library-detail')?.textContent ?? '', /钠.*钙.*2026-11-12/);
  const record = new URL(f.document.getElementById('food-library-record')!.getAttribute('href')!, 'https://synthetic.example');
  assert.equal(record.pathname, '/health/nutrition');
  assert.ok(record.searchParams.get('food')?.startsWith('mcd-cn:'));
  f.document.getElementById('food-library-close')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  f.document.getElementById('food-library-next')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => list.getAttribute('aria-busy') === 'false' && f.document.getElementById('food-library-page-number')?.textContent === '第 2 / 7 页');
  assert.equal(list.children.length, 24);
  assert.notEqual(list.querySelector('.fl-card-name')?.textContent, firstName);
  assert.ok(f.requests.some((item) => new URL(item.path, 'https://synthetic.example').searchParams.get('offset') === '24'));
  const query = f.document.getElementById('food-library-query') as HTMLInputElement;
  query.value = '巨无霸';
  f.document.getElementById('food-library-filter')!.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => list.getAttribute('aria-busy') === 'false' && list.textContent?.includes('巨无霸') === true);
  assert.ok(list.children.length > 0 && list.children.length < 24);
  assert.equal(f.document.getElementById('food-library-pagination')?.hidden, true);
  assert.ok(!f.document.body.textContent?.includes('台湾'));
  assert.ok(f.requests.every((item) => item.method === 'GET' && item.path.startsWith('/api/health/foods?')));
});

test('minified food-library handoff prepares a one-serving confirmation without saving', { skip: !hasBuild }, async () => {
  const f = await fixture('id="nutrition-page"', '/health/nutrition?food=mcd-cn%3A49%3A28', 390);
  await settle(() => f.document.getElementById('nutrition-dialog')?.hasAttribute('open') === true);
  assert.match((f.document.getElementById('nutrition-name') as HTMLInputElement).value, /巨无霸/);
  assert.equal((f.document.getElementById('nutrition-food-quantity') as HTMLInputElement).value, '1');
  assert.equal((f.document.getElementById('nutrition-food-unit') as unknown as HTMLSelectElement).value, '份');
  assert.equal((f.document.getElementById('nutrition-calories') as HTMLInputElement).value, '513.0');
  assert.ok(f.requests.some((item) => item.path.includes('/foods?id=')));
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});

test('minified Luckin library restores its brand, shows unknown energy and opens product details without inventing a serving', { skip: !hasBuild }, async () => {
  const f=await fixture('id="food-library-page"','/health/foods?brand=luckin-cn&q='+encodeURIComponent('小黄油拿铁'),390);
  const list=f.document.getElementById('food-library-list')!;
  await settle(()=>list.getAttribute('aria-busy')==='false');
  assert.equal((f.document.getElementById('food-library-brand') as unknown as HTMLSelectElement).value,'luckin-cn');
  const category=f.document.getElementById('food-library-category') as unknown as HTMLSelectElement;
  assert.equal(category.querySelectorAll('option').length,8);
  assert.ok(!category.textContent?.includes('汉堡和卷'));
  assert.equal(list.children.length,1);
  assert.match(list.textContent??'',/热量未公布/);
  assert.ok(list.querySelector('img')?.getAttribute('src')?.startsWith('/food-images/luckin-cn/'));
  list.querySelector('[data-food-open]')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.match(f.document.getElementById('food-library-detail')?.textContent??'',/官网未公布此产品的热量/);
  assert.equal(f.document.getElementById('food-library-record')?.textContent,'带入手工核对');
  const brand=f.document.getElementById('food-library-brand') as unknown as HTMLSelectElement;
  brand.value='mcd-cn';brand.dispatchEvent(new f.window.Event('change',{bubbles:true}));
  assert.equal(category.disabled,true);
  assert.equal(category.querySelectorAll('option').length,1);
  await settle(()=>list.getAttribute('aria-busy')==='false');
  assert.equal(category.disabled,false);
  assert.equal(category.querySelectorAll('option').length,9);
  assert.ok(category.textContent?.includes('汉堡和卷'));
  assert.ok(!category.textContent?.includes('拿铁类'));
  assert.equal(list.children.length,0,'the retained search can be empty while the brand category list stays complete');
  assert.ok(f.requests.every((item)=>item.method==='GET'&&item.path.startsWith('/api/health/foods?')));
});

test('minified food library normalizes a restored category from a different brand to its first page', { skip: !hasBuild }, async () => {
  const f=await fixture('id="food-library-page"','/health/foods?brand=luckin-cn&category='+encodeURIComponent('汉堡和卷')+'&offset=24',390);
  const list=f.document.getElementById('food-library-list')!;
  await settle(()=>list.getAttribute('aria-busy')==='false');
  const category=f.document.getElementById('food-library-category') as unknown as HTMLSelectElement;
  assert.equal(category.value,'');
  assert.equal(category.querySelectorAll('option').length,8);
  assert.equal(list.children.length,24);
  assert.equal(f.document.getElementById('food-library-page-number')?.textContent,'第 1 / 2 页');
  const query=new URLSearchParams(f.location.search);
  assert.equal(query.get('brand'),'luckin-cn');assert.equal(query.has('category'),false);assert.equal(query.has('offset'),false);
  assert.equal(f.requests.length,1);assert.ok(f.requests.every((item)=>item.method==='GET'));
});

test('minified Luckin handoffs preserve official kcal or unknown energy behind explicit manual confirmation', { skip: !hasBuild }, async () => {
  const known=await fixture('id="nutrition-page"','/health/nutrition?food=luckin-cn%3A1',390);
  await settle(()=>known.document.getElementById('nutrition-dialog')?.hasAttribute('open')===true);
  const quantity=known.document.getElementById('nutrition-food-quantity') as HTMLInputElement;
  assert.equal((known.document.getElementById('nutrition-calories') as HTMLInputElement).value,'179.0');
  quantity.value='0.5';quantity.dispatchEvent(new known.window.Event('input',{bubbles:true}));
  assert.equal((known.document.getElementById('nutrition-calories') as HTMLInputElement).value,'89.5');
  const unknown=await fixture('id="nutrition-page"','/health/nutrition?food=luckin-cn%3A49',390);
  await settle(()=>unknown.document.getElementById('nutrition-dialog')?.hasAttribute('open')===true);
  assert.equal((unknown.document.getElementById('nutrition-calories') as HTMLInputElement).value,'');
  assert.equal((unknown.document.getElementById('nutrition-portion') as HTMLInputElement).value,'');
  assert.match((unknown.document.getElementById('nutrition-name') as HTMLInputElement).value,/咸法酪泰奶/);
  assert.match((unknown.document.getElementById('nutrition-note') as HTMLTextAreaElement).value,/lkcoffee.com/);
  assert.ok([...known.requests,...unknown.requests].every((item)=>item.method==='GET'));
});
