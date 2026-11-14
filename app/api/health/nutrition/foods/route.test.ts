import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as catalog from '../../../../../lib/food-catalog.ts';
import { foodCatalogImages } from '../../../../../lib/food-catalog-images.ts';
import { currentNutritionFoods } from '../../../../../lib/food-library-service.ts';

function fixture() {
  let user: string | null = 'alice';
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const bindings = { ...catalog, foodCatalogImages, currentNutritionFoods, nutritionDatabase: () => ({}), listManagedFoodLibrary: async () => ({foods: [], overrides: []}), unavailable: () => Response.json({code:'STORAGE_UNAVAILABLE'},{status:503}), apiUser: async () => user,
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    unauthenticated: () => Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }) };
  const get = new Function(...Object.keys(bindings), source + '\nreturn GET;')(...Object.values(bindings)) as (request: Request) => Promise<Response>;
  return { signOut() { user = null; }, get(query = '') { return get(new Request('https://food.test/api/health/nutrition/foods' + query)); } };
}

test('food search returns bounded active records with distinct catalog and upstream source versions', async () => {
  const f = fixture();
  const response = await f.get('?q=' + encodeURIComponent('麦当劳'));
  assert.equal(response.status, 200);
  const result = await response.json() as { foods: catalog.FoodItem[]; source: typeof catalog.FOOD_CATALOG_SOURCE; releases: typeof catalog.FOOD_CATALOG_RELEASES };
  assert.ok(result.foods.length > 0 && result.foods.length <= 20);
  assert.ok(result.foods.every((food) => food.catalogRelease === catalog.ACTIVE_FOOD_CATALOG_RELEASE));
  assert.equal(result.source.catalogRelease, catalog.ACTIVE_FOOD_CATALOG_RELEASE);
  assert.equal(result.releases.filter((release) => release.active).length, 1);
  assert.equal(result.source.url, 'https://www.mcdonalds.com.cn/nutrition_calculator');
  assert.equal(result.releases.length, 1);
  assert.equal(JSON.stringify(result.releases).includes('tfda'), false);
});

test('food search enforces authentication and rejects duplicate or unsupported query fields', async () => {
  const f = fixture();
  for (const query of ['?q=rice&q=egg', '?q=rice&release=unknown', '?q=' + 'x'.repeat(101), '?category=饮品&category=小食', '?offset=0&offset=1', '?limit=20&limit=50', '?offset=-1', '?offset=0.5', '?offset=01', '?offset=9007199254740992', '?limit=0', '?limit=51', '?limit=1.5', '?category=not-a-category', '?id=mcd-cn:49:28&q=', '?id=', '?id=mcd-cn:49:28&id=mcd-cn:49:28']) {
    assert.equal((await f.get(query)).status, 400);
  }
  f.signOut(); assert.equal((await f.get('?q=rice')).status, 401);
});

void test('official brand results retain serving units and separate source attribution', async () => {
  const response = await fixture().get('?q=' + encodeURIComponent('麦当劳巨无霸'));
  assert.equal(response.status, 200);
  const data = await response.json() as { foods: catalog.FoodItem[]; sources: Array<Record<string, unknown>> };
  const food = data.foods.find((item) => item.id === 'mcd-cn:49:28');
  assert.ok(food && catalog.isServingFood(food));
  assert.equal(food.serving.kcal, 513);
  assert.equal(food.grams, null);
  assert.equal(food.kcalPer100g, null);
  assert.equal(food.catalogRelease, catalog.ACTIVE_FOOD_CATALOG_RELEASE);
  const official = data.sources.find((source) => source.url === 'https://www.mcdonalds.com.cn/nutrition_calculator');
  assert.ok(official);
  assert.equal(official.count, 137);
  assert.notEqual(official.licenseUrl, 'https://data.gov.tw/license');
});


void test('the browsing API pages through all retained specifications and exposes only current source metadata', async () => {
  const f = fixture();
  const ids: string[] = [];
  for (const offset of [0, 50, 100, 150]) {
    const response = await f.get(`?offset=${offset}&limit=50`);
    assert.equal(response.status, 200);
    const data = await response.json() as catalog.FoodBrowseResult & { sources: unknown[]; categories: Array<{ name: string; count: number }>; images: Record<string, { src: string; alt: string }> };
    assert.equal(data.total, 158); assert.equal(data.offset, offset); assert.equal(data.limit, 50);
    assert.equal(data.sources.length, 2);
    assert.equal(data.categories.length, 15);
    assert.equal(data.categories.reduce((sum, category) => sum + category.count, 0), 158);
    assert.ok(data.foods.every((food) => /^(?:mcd-cn|luckin-cn):/.test(food.id)));
    assert.deepEqual(Object.keys(data.images).sort(), data.foods.map((food) => food.id).sort());
    assert.ok(Object.values(data.images).every((image) => /^\/food-images\/(?:mcd-cn|luckin-cn)\/\d+\.(?:png|jpe?g)$/.test(image.src) && image.alt.length > 0));
    ids.push(...data.foods.map((food) => food.id));
  }
  assert.equal(new Set(ids).size, 158);
  const withdrawn = await (await f.get('?q=' + encodeURIComponent('白饭'))).json() as catalog.FoodBrowseResult & { images: object };
  assert.deepEqual(withdrawn.foods, []); assert.equal(withdrawn.total, 0);
  assert.deepEqual(withdrawn.images, {});
  const filtered = await (await f.get('?' + new URLSearchParams({ q: '薯条', category: '小食' }))).json() as catalog.FoodBrowseResult;
  assert.ok(filtered.foods.length > 0 && filtered.foods.every((food) => food.category === '小食'));
  assert.equal(filtered.total, filtered.foods.length);
});

void test('single-food lookups expose current specifications and refuse historical source browsing', async () => {
  const f = fixture();
  const response = await f.get('?id=mcd-cn:49:28');
  assert.equal(response.status, 200);
  const data = await response.json() as { food: catalog.FoodItem; images: Record<string, { src: string; alt: string }> };
  assert.equal(data.food.id, 'mcd-cn:49:28');
  assert.equal(data.food.catalogRelease, catalog.ACTIVE_FOOD_CATALOG_RELEASE);
  assert.equal(data.images[data.food.id].src, '/food-images/mcd-cn/49.png');
  assert.deepEqual(Object.keys(data.images), [data.food.id]);
  assert.equal(Object.hasOwn(data.food, 'image'), false, 'presentation metadata must not change immutable food records');
  for (const id of ['tfda:A0550601', 'mcd-cn:missing']) {
    const missing = await f.get('?id=' + id);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { code: string }).code, 'FOOD_NOT_FOUND');
  }
  f.signOut(); assert.equal((await f.get('?id=mcd-cn:49:28')).status, 401);
});
