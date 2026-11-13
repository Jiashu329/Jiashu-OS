import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import luckin from '../data/food-catalog-releases/luckin-cn-2026-11-13-v1.json' with { type: 'json' };
import current from '../data/food-catalog-releases/brands-2026-11-13-luckin-v1.json' with { type: 'json' };
import {
  ACTIVE_FOOD_CATALOG_RELEASE, MCD_ONLY_FOOD_CATALOG_RELEASE, FOOD_CATALOG_SOURCES,
  calculateFoodSelection, getFood, isServingFood, searchFoods, validateFoodSnapshot,
} from './food-catalog.ts';
import type { ServingFoodSnapshot } from './food-catalog.ts';
import { parseNutritionCreate } from './nutrition.ts';

void test('the combined release pins the added official data and retains the previous McDonald-only release', () => {
  assert.equal(current.id, ACTIVE_FOOD_CATALOG_RELEASE);
  assert.equal(current.parent, MCD_ONLY_FOOD_CATALOG_RELEASE);
  assert.equal(luckin.foods.length, 21);
  assert.equal(luckin.products.length, 7);
  assert.equal(new Set(current.foodIds).size, 158);
  for (const addition of current.additions) {
    const bytes = readFileSync(new URL('../' + addition.file, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), addition.sha256);
  }
  assert.equal(FOOD_CATALOG_SOURCES.length, 2);
  const source = FOOD_CATALOG_SOURCES.find((value) => value.url === 'https://lkcoffee.com/products');
  assert.ok(source);
  assert.equal(Object.hasOwn(source, 'licenseUrl'), false);
  const prior = getFood('mcd-cn:49:28', MCD_ONLY_FOOD_CATALOG_RELEASE)!;
  const latest = getFood(prior.id)!;
  assert.notStrictEqual(prior, latest);
  assert.deepEqual(prior.source, latest.source);
  assert.deepEqual(prior.basis === 'perServing' ? prior.serving : null, latest.basis === 'perServing' ? latest.serving : null);
  assert.equal(getFood('luckin-cn:1', MCD_ONLY_FOOD_CATALOG_RELEASE), null);
});

void test('known Luckin calories retain exact official configurations and absent kJ or macros stay absent', () => {
  for (const row of luckin.foods) {
    const food = getFood(row.id);
    assert.ok(food && isServingFood(food));
    assert.equal(food.catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
    assert.equal(food.serving.energyKj, null);
    assert.equal(food.serving.energyBasis, 'officialKcal');
    assert.equal(food.serving.kcal, row.serving.kcal);
    assert.equal(food.serving.label, row.serving.label);
    assert.equal(food.name.startsWith('瑞幸'), true);
    assert.ok(food.name.length <= 100);
    assert.ok(food.aliases.every((value) => /瑞幸|luckin/i.test(value)), 'unbranded discovery terms cannot be exact-match identities');
    const selected = calculateFoodSelection({ id: food.id, amount: 1, unit: '份', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE });
    assert.equal(selected.caloriesTenth, row.serving.kcal * 10);
    for (const key of ['carbs', 'protein', 'fat'] as const) {
      if (!Object.hasOwn(row.serving, key)) assert.equal(Object.hasOwn(selected, `${key}Tenth`), false);
    }
    assert.deepEqual(validateFoodSnapshot(selected), selected);
  }
  const coconut = getFood('luckin-cn:1');
  assert.ok(coconut && isServingFood(coconut));
  assert.equal(coconut.serving.kcal, 179);
  assert.match(coconut.serving.label, /大杯.*冰.*不另外加糖/);
  assert.equal(coconut.grams, null);
  assert.equal(coconut.kcalPer100g, null);
  assert.equal(calculateFoodSelection({ id: coconut.id, amount: 0.5, unit: '份', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE }).caloriesTenth, 895);
});

void test('an unknown-calorie official product is never returned as a calculable nutritional record', () => {
  for (const product of luckin.products) {
    assert.equal(getFood(product.id), null);
    assert.ok(!searchFoods(product.name).some((food) => food.id === product.id));
    assert.throws(() => calculateFoodSelection({ id: product.id, amount: 1, unit: '份', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE }), /找不到/);
  }
});

void test('kcal-only serving snapshots reject inferred kJ, altered configurations and fabricated macros', () => {
  const snapshot = calculateFoodSelection({ id: 'luckin-cn:1', amount: 1, unit: '份', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE }) as ServingFoodSnapshot;
  for (const serving of [
    { ...snapshot.serving, energyKj: 0 },
    { ...snapshot.serving, energyKj: 749 },
    { ...snapshot.serving, energyBasis: undefined },
    { ...snapshot.serving, kcal: 180 },
    { ...snapshot.serving, label: '超大杯/热/标准甜' },
    { ...snapshot.serving, carbs: 0 },
  ]) assert.throws(() => validateFoodSnapshot({ ...snapshot, serving }));
  const { energyBasis: _basis, ...withoutBasis } = snapshot.serving;
  assert.throws(() => validateFoodSnapshot({ ...snapshot, serving: withoutBasis }));
  assert.throws(() => validateFoodSnapshot({ ...snapshot, caloriesTenth: 0 }));
  assert.throws(() => validateFoodSnapshot({ ...snapshot, proteinTenth: 0 }));
  const parsed = parseNutritionCreate({ date: '2026-11-13', meal: 'snack', name: '', portion: '', note: '', calories: null,
    food: { id: snapshot.foodId, amount: 0.5, unit: '份', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE } }, Date.parse('2026-11-13T12:00:00Z'));
  assert.equal(parsed.caloriesTenth, 895);
  assert.equal(parsed.food?.basis, 'perServing');
  assert.equal(parsed.food?.basis === 'perServing' ? parsed.food.serving.energyKj : undefined, null);
});
