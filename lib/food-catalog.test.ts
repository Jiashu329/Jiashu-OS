import assert from 'node:assert/strict';
import test from 'node:test';
import catalogData from '../data/food-catalog.json' with { type: 'json' };
import { calculateFoodSelection, FOOD_CATALOG_SOURCE, getFood, searchFoods } from './food-catalog.ts';

void test('the offline catalog contains a bounded attributable snapshot with stable source identities and measured nutrients', () => {
  assert.equal(catalogData.length, 2161);
  assert.equal(FOOD_CATALOG_SOURCE.count, catalogData.length);
  assert.equal(new Set(catalogData.map((food) => food.id)).size, catalogData.length);
  assert.equal(FOOD_CATALOG_SOURCE.mirror.commit, 'da3bd63ee385638c7c490bc7999507ad70572b70');
  assert.equal(FOOD_CATALOG_SOURCE.mirror.sha256, '4670ababc656e1136a8f10faff7e0a59c7700ff988e95ec471870132ea7c6d64');
  assert.equal(FOOD_CATALOG_SOURCE.url, 'https://data.gov.tw/dataset/8543');
  assert.equal(FOOD_CATALOG_SOURCE.licenseUrl, 'https://data.gov.tw/license');
  assert.equal(FOOD_CATALOG_SOURCE.upstreamRelease, null);
  assert.match(FOOD_CATALOG_SOURCE.description, /不代表2026年最新/);
  for (const food of catalogData) {
    assert.equal(food.id, 'tfda:' + food.source.recordId);
    assert.equal(food.source.version, FOOD_CATALOG_SOURCE.version);
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

void test('Chinese variants, everyday names and English aliases retrieve foods while preserving ambiguous food variants', () => {
  const rice = searchFoods(' 米饭 ')[0];
  assert.equal(rice.name, '白饭'); assert.equal(rice.state, '熟制');
  assert.equal(searchFoods('白飯')[0].id, rice.id);
  assert.equal(searchFoods('  COOKED RICE  ')[0].id, rice.id);
  assert.equal(searchFoods('水煮蛋')[0].name, '鸡水煮蛋');
  assert.ok(searchFoods('西红柿').some((food) => food.name.includes('番茄')));
  const broccoli = searchFoods('西兰花');
  assert.ok(broccoli.length >= 2);
  assert.ok(broccoli.every((food) => food.name.includes('青花菜')));
  assert.equal(new Set(broccoli.map((food) => food.id)).size, broccoli.length);
  const milk = searchFoods('牛奶', 6);
  assert.ok(milk.length > 1);
  assert.ok(milk.every((food) => food.name.includes('鲜乳')));
  assert.ok(searchFoods('全脂牛奶')[0].name.startsWith('全脂鲜乳'));
  assert.ok(searchFoods('脱脂牛奶')[0].name.startsWith('脱脂'));
  assert.ok(searchFoods('鸡蛋')[0].category.includes('蛋'));
  assert.equal(searchFoods('不存在的合成食物关键词').length, 0);
  assert.equal(searchFoods('', 5).length, 5);
  assert.throws(() => searchFoods('x'.repeat(101)), /100/);
  assert.throws(() => searchFoods('', 51), /50/);
});

void test('gram and kilogram selections use catalog energy and exact decimal rounding rather than model calories', () => {
  const rice = searchFoods('米饭')[0];
  // Pinned source A0550601 explicitly contains 183 kcal per 100g cooked rice.
  assert.equal(rice.source.recordId, 'A0550601'); assert.equal(rice.kcalPer100g, 183);
  const gram = calculateFoodSelection({ id: rice.id, amount: 150, unit: '克' });
  assert.equal(gram.caloriesTenth, 2745); assert.equal(gram.grams, 150); assert.equal(gram.unit, 'g');
  assert.equal(gram.estimated, false); assert.deepEqual(gram.source, rice.source);
  assert.equal(calculateFoodSelection({ id: rice.id, amount: 0.15, unit: '公斤' }).caloriesTenth, gram.caloriesTenth);
  assert.equal(calculateFoodSelection({ id: rice.id, amount: 1.25, unit: '公克' }).caloriesTenth, 23);
  assert.equal(calculateFoodSelection({ id: rice.id, amount: 0.05, unit: 'g' }).caloriesTenth, 1);
  assert.equal(getFood(' ' + rice.id.toUpperCase() + ' ')?.id, rice.id);
  assert.equal(getFood('tfda:missing'), null);
});

void test('serving macros are calculated independently from known source grams with stable decimal rounding', () => {
  const rice = searchFoods('米饭', 1)[0];
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
  const egg = searchFoods('鸡蛋')[0];
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
  const rice = searchFoods('米饭')[0];
  for (const amount of [0, -1, NaN, Infinity, 0.0001, 20001]) {
    assert.throws(() => calculateFoodSelection({ id: rice.id, amount, unit: 'g' }));
  }
  assert.throws(() => calculateFoodSelection({ id: 'tfda:invalid', amount: 100, unit: 'g' }), /找不到/);
  const oil = catalogData.find((food) => food.kcalPer100g > 800)!;
  assert.throws(() => calculateFoodSelection({ id: oil.id, amount: 10000, unit: 'g' }), /20,000 kcal/);
});
