import assert from 'node:assert/strict';
import test from 'node:test';
import { browseFoodLibrary, getLibraryFood, FOOD_LIBRARY_BRANDS } from './food-library-catalog.ts';
import { calculateFoodSelection, getFood, searchFoods } from './food-catalog.ts';

test('the library pages through both brands, including seven explicitly unknown nutrition products', () => {
  const all = [0, 50, 100, 150].flatMap((offset) => browseFoodLibrary({ offset, limit: 50 }).foods);
  assert.equal(all.length, 165);
  assert.equal(new Set(all.map((food) => food.id)).size, 165);
  assert.deepEqual(FOOD_LIBRARY_BRANDS.map((brand) => [brand.id, brand.count]), [['mcd-cn', 137], ['luckin-cn', 28]]);
  const luckin = browseFoodLibrary({ brand: 'luckin-cn', limit: 50 });
  assert.equal(luckin.total, 28);
  assert.ok(luckin.foods.every((food) => food.id.startsWith('luckin-cn:')));
  const unknown = luckin.foods.filter((food) => food.basis === 'catalogOnly');
  assert.equal(unknown.length, 7);
  for (const food of unknown) {
    assert.equal(Object.hasOwn(food, 'kcalPer100g'), false);
    assert.equal(Object.hasOwn(food, 'serving'), false);
    assert.equal(getFood(food.id), null);
    assert.equal(searchFoods(food.name).some((candidate) => candidate.id === food.id), false);
    assert.throws(() => calculateFoodSelection({ id: food.id, amount: 1, unit: '份' }));
  }
});

test('known Luckin energy retains official kcal without inferring kJ or gram weight', () => {
  const food = getLibraryFood('luckin-cn:1');
  assert.ok(food && food.basis === 'perServing');
  assert.equal(food.serving.kcal, 179);
  assert.equal(food.serving.energyKj, null);
  assert.equal(food.serving.energyBasis, 'officialKcal');
  assert.equal(food.grams, null);
  const half = calculateFoodSelection({ id: food.id, amount: 0.5, unit: '份', catalogRelease: food.catalogRelease });
  assert.equal(half.caloriesTenth, 895);
  assert.ok(half.basis === 'perServing');
  assert.equal(half.serving.energyKj, null);
  assert.match(half.serving.label, /冰/);
  assert.match(half.serving.label, /不另外加糖/);
});

test('library filtering discovers original product names and refuses withdrawn sources and invalid filters', () => {
  const butter = browseFoodLibrary({ query: '小黄油拿铁', brand: 'luckin-cn' });
  assert.equal(butter.total, 1); assert.equal(butter.foods[0].basis, 'catalogOnly');
  assert.equal(getLibraryFood('tfda:A0550601'), null);
  assert.equal(browseFoodLibrary({ query: '白饭' }).total, 0);
  for (const options of [{ brand: 'other' }, { category: 'other' }, { offset: -1 }, { limit: 51 }, { query: 'a'.repeat(101) }]) assert.throws(() => browseFoodLibrary(options));
});
