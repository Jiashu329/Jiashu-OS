import assert from 'node:assert/strict';
import test from 'node:test';
import catalogData from '../data/food-catalog.json' with { type: 'json' };
import sourceData from '../data/food-catalog-source.json' with { type: 'json' };
import { ACTIVE_FOOD_CATALOG_RELEASE, LEGACY_FOOD_CATALOG_RELEASE, FOOD_CATALOG_CATEGORIES, FOOD_CATALOG_SOURCES, browseFoods, calculateFoodSelection, FOOD_CATALOG_SOURCE, getFood, searchFoods } from './food-catalog.ts';

void test('the archived catalog retains a bounded attributable snapshot with stable source identities and measured nutrients', () => {
  assert.equal(catalogData.length, 2161);
  assert.equal(sourceData.count, catalogData.length);
  assert.equal(new Set(catalogData.map((food) => food.id)).size, catalogData.length);
  assert.equal(sourceData.mirror.commit, 'da3bd63ee385638c7c490bc7999507ad70572b70');
  assert.equal(sourceData.mirror.sha256, '4670ababc656e1136a8f10faff7e0a59c7700ff988e95ec471870132ea7c6d64');
  assert.equal(sourceData.url, 'https://data.gov.tw/dataset/8543');
  assert.equal(sourceData.licenseUrl, 'https://data.gov.tw/license');
  assert.equal(sourceData.upstreamRelease, null);
  assert.match(sourceData.description, /不代表2026年最新/);
  for (const food of catalogData) {
    assert.equal(food.id, 'tfda:' + food.source.recordId);
    assert.equal(food.source.version, sourceData.version);
    assert.ok(Number.isFinite(food.kcalPer100g) && food.kcalPer100g >= 0 && food.kcalPer100g <= 1000);
    for (const value of [food.proteinPer100g, food.fatPer100g, food.carbsPer100g]) {
      assert.ok(value === undefined || (Number.isFinite(value) && value >= 0));
    }
    for (const portion of food.portions) {
      assert.equal(portion.unit, '参考单位');
      assert.ok(portion.grams > 0);
      assert.equal(portion.estimated, true);
    }
  }
});

void test('current discovery and source attribution contain only the retained official specifications', () => {
  assert.equal(FOOD_CATALOG_SOURCE.count, 137);
  assert.equal(FOOD_CATALOG_SOURCE.url, 'https://www.mcdonalds.com.cn/nutrition_calculator');
  assert.equal(FOOD_CATALOG_SOURCE.upstreamRelease, '2025-04');
  assert.equal(FOOD_CATALOG_SOURCES.length, 1);
  assert.equal(Object.hasOwn(FOOD_CATALOG_SOURCE, 'licenseUrl'), false);
  const first = browseFoods({ limit: 50 }), second = browseFoods({ offset: 50, limit: 50 }), last = browseFoods({ offset: 100, limit: 50 });
  assert.deepEqual([first.total, second.total, last.total], [137, 137, 137]);
  assert.deepEqual([first.foods.length, second.foods.length, last.foods.length], [50, 50, 37]);
  const all = [...first.foods, ...second.foods, ...last.foods];
  assert.equal(new Set(all.map((food) => food.id)).size, 137);
  assert.ok(all.every((food) => food.id.startsWith('mcd-cn:') && food.catalogRelease === ACTIVE_FOOD_CATALOG_RELEASE));
  for (const query of ['米饭', '白飯', 'COOKED RICE', '西兰花', '冷冻火腿炒饭']) assert.deepEqual(searchFoods(query), []);
  assert.equal(searchFoods(' 巨无霸 ')[0].id, 'mcd-cn:49:28');
  assert.deepEqual(searchFoods('不存在的合成食物关键词'), []);
  assert.equal(getFood('tfda:A0550601'), null);
  assert.equal(searchFoods('', 5).length, 5);
  assert.throws(() => searchFoods('x'.repeat(101)), /100/);
  assert.throws(() => searchFoods('', 51), /50/);
});

void test('category filters, pagination and ranking operate on the same complete current catalog', () => {
  assert.equal(FOOD_CATALOG_CATEGORIES.length, 8);
  assert.equal(FOOD_CATALOG_CATEGORIES.reduce((sum, item) => sum + item.count, 0), 137);
  for (const category of FOOD_CATALOG_CATEGORIES) {
    const result = browseFoods({ category: category.name, limit: 50 });
    assert.equal(result.total, category.count);
    assert.ok(result.foods.every((food) => food.category === category.name));
  }
  assert.ok(browseFoods({ query: '薯条', category: '小食' }).foods.length > 0);
  assert.equal(browseFoods({ query: '巨无霸', category: '饮品' }).total, 0);
  assert.deepEqual(browseFoods({ offset: 500 }).foods, []);
  for (const options of [{ offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 51 }, { category: '不存在' }]) assert.throws(() => browseFoods(options));
});

void test('gram and kilogram selections use catalog energy and exact decimal rounding rather than model calories', () => {
  const rice = getFood('tfda:A0550601', LEGACY_FOOD_CATALOG_RELEASE)!;
  // Pinned source A0550601 explicitly contains 183 kcal per 100g cooked rice.
  assert.equal(rice.source.recordId, 'A0550601'); assert.equal(rice.kcalPer100g, 183);
  const gram = calculateFoodSelection({ id: rice.id, amount: 150, unit: '克' });
  assert.equal(gram.caloriesTenth, 2745); assert.equal(gram.grams, 150); assert.equal(gram.unit, 'g');
  assert.equal(gram.estimated, false); assert.deepEqual(gram.source, rice.source);
  assert.equal(calculateFoodSelection({ id: rice.id, amount: 0.15, unit: '公斤' }).caloriesTenth, gram.caloriesTenth);
  assert.equal(calculateFoodSelection({ id: rice.id, amount: 1.25, unit: '公克' }).caloriesTenth, 23);
  assert.equal(calculateFoodSelection({ id: rice.id, amount: 0.05, unit: 'g' }).caloriesTenth, 1);
  assert.equal(getFood(' ' + rice.id.toUpperCase() + ' ', LEGACY_FOOD_CATALOG_RELEASE)?.id, rice.id);
  assert.equal(getFood('tfda:missing'), null);
});

void test('serving macros are calculated independently from known source grams with stable decimal rounding', () => {
  const rice = getFood('tfda:A0550601', LEGACY_FOOD_CATALOG_RELEASE)!;
  const serving = calculateFoodSelection({ id: rice.id, amount: 150, unit: 'g' });
  for (const key of ['carbs', 'protein', 'fat'] as const) {
    const source = rice[`${key}Per100g`];
    assert.equal(serving[`${key}Tenth`], source === undefined ? undefined : Math.round(source * 15));
    assert.equal(serving[`${key}Per100g`], source);
  }
  assert.deepEqual(calculateFoodSelection({ id: rice.id, amount: 0.15, unit: 'kg' }), { ...serving, amount: 0.15, unit: 'kg' });
  const missing = catalogData.find((food) => food.proteinPer100g === undefined)!;
  assert.equal(Object.hasOwn(calculateFoodSelection({ id: missing.id, amount: 100, unit: 'g' }), 'proteinTenth'), false);
  const zero = catalogData.find((food) => food.fatPer100g === 0)!;
  assert.equal(calculateFoodSelection({ id: zero.id, amount: 100, unit: 'g' }).fatTenth, 0);
});

void test('a source unit weight is usable as an explicit estimate and never silently relabelled as pieces or bowls', () => {
  const egg = getFood(catalogData.find((food) => food.category.includes('蛋') && food.portions.length > 0)!.id, LEGACY_FOOD_CATALOG_RELEASE)!;
  assert.ok(egg.portions.length);
  const portion = egg.portions[0];
  const result = calculateFoodSelection({ id: egg.id, amount: 2, unit: portion.unit });
  assert.equal(result.grams, portion.grams * 2);
  assert.equal(result.estimated, true);
  for (const unit of ['个', '碗', '份', 'ml', '毫升']) {
    assert.throws(() => calculateFoodSelection({ id: egg.id, amount: 2, unit }), /可靠克重/);
  }
});

void test('invalid weights, precision, calorie overflow and unknown identities fail before persistence', () => {
  const rice = getFood('tfda:A0550601', LEGACY_FOOD_CATALOG_RELEASE)!;
  for (const amount of [0, -1, NaN, Infinity, 0.0001, 20001]) {
    assert.throws(() => calculateFoodSelection({ id: rice.id, amount, unit: 'g' }));
  }
  assert.throws(() => calculateFoodSelection({ id: 'tfda:invalid', amount: 100, unit: 'g' }), /找不到/);
  const oil = catalogData.find((food) => food.kcalPer100g > 800)!;
  assert.throws(() => calculateFoodSelection({ id: oil.id, amount: 10000, unit: 'g' }), /20,000 kcal/);
});
