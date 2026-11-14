import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as library from '../../../../lib/food-library-catalog.ts';
import * as service from '../../../../lib/food-library-service.ts';
import { FOOD_CATALOG_SOURCES } from '../../../../lib/food-catalog.ts';
import { foodCatalogImages } from '../../../../lib/food-catalog-images.ts';

function fixture() {
  let authenticated = true;
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const publicFoods = [0,50,100,150].flatMap((offset) => library.browseFoodLibrary({offset,limit:50}).foods);
  const bindings = { ...library, ...service, FOOD_CATALOG_SOURCES, foodCatalogImages, nutritionDatabase:()=>({}),
    readFoodLibrarySnapshot:async()=>({publicFoods,personalFoods:[],overrides:[],canManage:false}),
    unavailable:()=>Response.json({code:'STORAGE_UNAVAILABLE'},{status:503}),
    apiUser: async () => authenticated ? { userId: 'synthetic-user' } : null,
    json: (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }),
    unauthenticated: () => Response.json({ code: 'SIGN_IN_REQUIRED' }, { status: 401 }) };
  const handler = new Function(...Object.keys(bindings), source + '\nreturn GET;')(...Object.values(bindings)) as (request: Request) => Promise<Response>;
  return { signOut() { authenticated = false; }, get(query = '') { return handler(new Request('https://synthetic.example/api/health/foods' + query)); } };
}

test('authenticated library browsing exposes brand filters, only page images, and explicit unknown energy', async () => {
  const f = fixture();
  const response = await f.get('?brand=luckin-cn&limit=50');
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json() as { foods: library.LibraryFood[]; total: number; images: Record<string, { src: string }>; sources: unknown[] };
  assert.equal(data.total, 28); assert.equal(data.foods.length, 28);
  assert.equal(data.foods.filter((food) => food.basis === 'catalogOnly').length, 7);
  assert.equal(data.sources.length, 2);
  assert.deepEqual(Object.keys(data.images).sort(), data.foods.map((food) => food.id).sort());
  assert.ok(Object.values(data.images).every((image) => /^\/food-images\/luckin-cn\/\d+\.(png|jpe?g)$/.test(image.src)));
  const single = await (await f.get('?id=luckin-cn:7')).json() as { food: library.CatalogOnlyProduct; images: object };
  assert.equal(single.food.basis, 'catalogOnly'); assert.equal(Object.hasOwn(single.food, 'serving'), false);
  assert.deepEqual(Object.keys(single.images), ['luckin-cn:7']);
});

test('the library rejects duplicate, malformed, unknown and mixed-id query fields and requires login', async () => {
  const f = fixture();
  for (const query of ['?brand=unknown', '?q=a&q=b', '?brand=luckin-cn&brand=mcd-cn', '?category=missing', '?offset=-1', '?offset=1.2', '?offset=9007199254740992', '?limit=0', '?limit=51', '?id=luckin-cn:7&brand=luckin-cn', '?id=', '?token=secret', '?q=' + 'a'.repeat(101)]) assert.equal((await f.get(query)).status, 400, query);
  assert.equal((await f.get('?id=tfda:A0550601')).status, 404);
  f.signOut(); assert.equal((await f.get('?brand=luckin-cn')).status, 401);
});

test('category options and counts follow the selected brand independently of query, category or page', async () => {
  const f = fixture();
  for (const [brand, count, length] of [['mcd-cn', 137, 8], ['luckin-cn', 28, 7]] as const) {
    const base = await (await f.get('?brand=' + brand)).json() as { categories: Array<{ name: string; count: number }> };
    assert.equal(base.categories.length, length);
    assert.equal(base.categories.reduce((sum, category) => sum + category.count, 0), count);
    for (const extra of ['&q=NO_MATCHING_PRODUCT', '&offset=24', '&category=' + encodeURIComponent(base.categories[0].name)]) {
      const data = await (await f.get('?brand=' + brand + extra)).json() as { categories: typeof base.categories };
      assert.deepEqual(data.categories, base.categories);
    }
  }
  const all = await (await f.get()).json() as { categories: unknown[] };
  assert.equal(all.categories.length, 15);
});

test('a restored cross-brand category resets its response state without returning a false empty result', async () => {
  const response = await fixture().get('?' + new URLSearchParams({ brand: 'luckin-cn', category: '汉堡和卷', offset: '24' }));
  assert.equal(response.status, 200);
  const data = await response.json() as { category: string; offset: number; total: number; foods: library.LibraryFood[]; categories: Array<{ name: string }> };
  assert.equal(data.category, ''); assert.equal(data.offset, 0); assert.equal(data.total, 28);
  assert.equal(data.categories.some((category) => category.name === '汉堡和卷'), false);
  assert.ok(data.foods.length > 0 && data.foods.every((food) => food.id.startsWith('luckin-cn:')));
});

test('a restored private filter is cleared in public scope without reading or exposing private templates', async () => {
  const response=await fixture().get('?scope=public&brand=mine&category='+encodeURIComponent('自建食物')+'&offset=24');
  assert.equal(response.status,200);
  const data=await response.json() as {scope:string;brand:string;category:string;offset:number;total:number};
  assert.equal(data.scope,'public');assert.equal(data.brand,'');assert.equal(data.category,'');assert.equal(data.offset,0);assert.equal(data.total,165);
});
