import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as catalog from '../../../../../lib/food-catalog.ts';

function fixture() {
  let user: string | null = 'alice';
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const bindings = { ...catalog, apiUser: async () => user,
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    unauthenticated: () => Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }) };
  const get = new Function(...Object.keys(bindings), source + '\nreturn GET;')(...Object.values(bindings)) as (request: Request) => Promise<Response>;
  return { signOut() { user = null; }, get(query = '') { return get(new Request('https://food.test/api/health/nutrition/foods' + query)); } };
}

test('food search returns bounded active records with distinct catalog and upstream source versions', async () => {
  const f = fixture();
  const response = await f.get('?q=' + encodeURIComponent('炒饭'));
  assert.equal(response.status, 200);
  const result = await response.json() as { foods: catalog.FoodItem[]; source: typeof catalog.FOOD_CATALOG_SOURCE; releases: typeof catalog.FOOD_CATALOG_RELEASES };
  assert.ok(result.foods.length > 0 && result.foods.length <= 20);
  assert.ok(result.foods.every((food) => food.catalogRelease === catalog.ACTIVE_FOOD_CATALOG_RELEASE));
  assert.equal(result.source.catalogRelease, catalog.ACTIVE_FOOD_CATALOG_RELEASE);
  assert.equal(result.releases.filter((release) => release.active).length, 1);
  assert.match(result.source.description, /不改变每100g营养值/);
});

test('food search enforces authentication and rejects duplicate or unsupported query fields', async () => {
  const f = fixture();
  for (const query of ['?q=rice&q=egg', '?q=rice&release=unknown', '?q=' + 'x'.repeat(101)]) {
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
