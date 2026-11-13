import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import official from '../data/food-catalog-releases/mcd-cn-2025-04-v1.json' with { type: 'json' };
import source from '../data/food-catalog-sources/mcd-cn-2025-04.json' with { type: 'json' };
import {
  ACTIVE_FOOD_CATALOG_RELEASE, CHINESE_FOOD_CATALOG_RELEASE, FOOD_CATALOG_SOURCES, LEGACY_FOOD_CATALOG_RELEASE,
  MCD_FOOD_CATALOG_RELEASE, calculateFoodSelection, foodEnergyLabel, foodSelectionFromSnapshot, getFood, isServingFood,
  searchFoods, validateFoodSnapshot,
} from './food-catalog.ts';
import type { ServingFoodItem, ServingFoodSnapshot } from './food-catalog.ts';
import { parseNutritionCreate } from './nutrition.ts';
import { creationFingerprint } from '../db/nutrition-store.ts';

const id = 'mcd-cn:49:28';
const selection = (amount = 1) => ({ id, amount, unit: '份', catalogRelease: MCD_FOOD_CATALOG_RELEASE });

void test('current catalog retains every pinned official specification while historical releases remain immutable', () => {
  assert.notEqual(ACTIVE_FOOD_CATALOG_RELEASE, official.id);
  assert.equal(official.parent, CHINESE_FOOD_CATALOG_RELEASE);
  assert.equal(official.foods.length, 137);
  assert.equal(new Set(official.foods.map((food) => food.id)).size, 137);
  for (const row of official.foods) {
    const food = getFood(row.id);
    assert.ok(food && isServingFood(food));
    assert.equal(food.basis, 'perServing'); assert.equal(food.grams, null); assert.equal(food.kcalPer100g, null);
    assert.equal(food.catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
    assert.equal(food.source.recordId, row.id.slice('mcd-cn:'.length));
    assert.deepEqual(food.serving, row.serving);
    assert.equal(food.serving.kcal, Math.round(row.serving.energyKj / 4.184));
    assert.equal(getFood(row.id, LEGACY_FOOD_CATALOG_RELEASE), null);
    assert.equal(getFood(row.id, CHINESE_FOOD_CATALOG_RELEASE), null);
    assert.equal(validateFoodSnapshot(calculateFoodSelection({ id: row.id, amount: 1, unit: '份', catalogRelease: food.catalogRelease })).caloriesTenth, row.serving.kcal * 10);
  }
  const legacy = calculateFoodSelection({ id: 'tfda:A0550601', amount: 150, unit: 'g' });
  const chinese = calculateFoodSelection({ id: 'tfda:A0550601', amount: 1, unit: '参考100g', catalogRelease: CHINESE_FOOD_CATALOG_RELEASE });
  assert.equal(Object.hasOwn(legacy, 'basis'), false); assert.equal(legacy.caloriesTenth, 2745);
  assert.equal(Object.hasOwn(chinese, 'basis'), false); assert.equal(chinese.caloriesTenth, 1830);
  assert.equal(chinese.catalogRelease, CHINESE_FOOD_CATALOG_RELEASE);
  assert.deepEqual(validateFoodSnapshot(chinese), chinese);
});

void test('official source evidence stays independent from TFDA licensing and pins the acquired raw data and release', () => {
  const mcd = FOOD_CATALOG_SOURCES.find((item) => item.name === source.name);
  assert.ok(mcd); assert.equal(mcd.url, 'https://www.mcdonalds.com.cn/nutrition_calculator');
  assert.equal(Object.hasOwn(mcd, 'licenseUrl'), false);
  assert.match(source.rightsNotice, /未提供开放数据许可/);
  assert.equal(source.upstreamRelease, '2025-04'); assert.equal(source.count, 137);
  const bytes = readFileSync(new URL('../data/food-catalog-releases/mcd-cn-2025-04-v1.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.release.sha256);
});

void test('published individual and package sizes remain separate choices with unknown gram weights', () => {
  const fries = searchFoods('麦当劳薯条');
  for (const spec of ['mcd-cn:21:422', 'mcd-cn:21:11', 'mcd-cn:21:12', 'mcd-cn:21:14']) assert.ok(fries.some((food) => food.id === spec));
  assert.notEqual(getFood('mcd-cn:23:15')?.id, getFood('mcd-cn:121:63')?.id);
  const food = getFood(id) as ServingFoodItem;
  assert.equal(food.serving.originalLabel, '1个'); assert.equal(food.serving.unit, '份');
  assert.equal(food.portions.length, 0);
  assert.match(foodEnergyLabel(food), /每份 513 kcal.*1个/);
  const defaultSpec = official.foods.find((row) => row.serving.originalLabel === '默认')!;
  assert.ok(defaultSpec); assert.match(defaultSpec.serving.label, /官网默认规格/);
  assert.equal(defaultSpec.serving.originalLabel, '默认');
  assert.throws(() => { food.serving.kcal = 1; }, TypeError);
});

void test('fractions and multiples scale official per-serving calories and macros using exact decimal rounding', () => {
  const one = calculateFoodSelection(selection()) as ServingFoodSnapshot;
  const half = calculateFoodSelection(selection(0.5)) as ServingFoodSnapshot;
  const two = calculateFoodSelection(selection(2)) as ServingFoodSnapshot;
  assert.equal(one.caloriesTenth, 5130); assert.equal(half.caloriesTenth, 2565); assert.equal(two.caloriesTenth, 10260);
  assert.equal(half.proteinTenth, 135); assert.equal(half.fatTenth, 130); assert.equal(half.carbsTenth, 210);
  assert.equal(one.grams, null); assert.equal(two.kcalPer100g, null); assert.equal(two.estimated, false);
  assert.deepEqual(two.serving, one.serving); assert.equal(two.serving.energyKj, 2146);
  const odd = official.foods.find((row) => row.serving.kcal % 10 === 5)!;
  assert.ok(odd);
  const rounded = calculateFoodSelection({ ...selection(0.01), id: odd.id });
  assert.equal(rounded.caloriesTenth, Math.floor(odd.serving.kcal / 10) + 1);
  const zero = official.foods.find((row) => row.serving.kcal === 0)!;
  const zeros = calculateFoodSelection({ ...selection(0.5), id: zero.id });
  assert.equal(zeros.caloriesTenth, 0); assert.equal(zeros.carbsTenth, 0);
});

void test('serving foods reject guessed weight, volume, piece counts, missing releases and unsupported amounts', () => {
  for (const unit of ['g', 'kg', '克', '公斤', 'ml', '毫升', '个', '块', '中杯', '份 ']) assert.throws(() => calculateFoodSelection({ ...selection(), unit }), /仅公布官方规格每份营养/);
  for (const amount of [0, -1, Number.NaN, Infinity, 0.0001]) assert.throws(() => calculateFoodSelection(selection(amount)));
  const zero = official.foods.find((row) => row.serving.kcal === 0)!;
  assert.throws(() => calculateFoodSelection({ ...selection(1001), id: zero.id }), /1,000份/);
  assert.throws(() => calculateFoodSelection(selection(1000)), /超出支持范围/);
  assert.throws(() => calculateFoodSelection({ id, amount: 1, unit: '份' }), /找不到/);
  assert.throws(() => calculateFoodSelection({ ...selection(), catalogRelease: CHINESE_FOOD_CATALOG_RELEASE }), /找不到/);
});

void test('serving snapshot validation verifies the exact immutable source and rejects fabricated weights or hidden density', () => {
  const snapshot = calculateFoodSelection(selection(0.5)) as ServingFoodSnapshot;
  assert.deepEqual(validateFoodSnapshot(snapshot), snapshot);
  assert.deepEqual(foodSelectionFromSnapshot(snapshot), selection(0.5));
  for (const forged of [
    { ...snapshot, grams: 100 }, { ...snapshot, kcalPer100g: 513 }, { ...snapshot, unit: '个' },
    { ...snapshot, caloriesTenth: 1 }, { ...snapshot, proteinTenth: 0 }, { ...snapshot, estimated: true },
    { ...snapshot, basis: 'serving' }, { ...snapshot, catalogRelease: CHINESE_FOOD_CATALOG_RELEASE },
    { ...snapshot, serving: { ...snapshot.serving, kcal: 1 } }, { ...snapshot, serving: { ...snapshot.serving, energyKj: 0 } },
    { ...snapshot, serving: { ...snapshot.serving, fabricatedGrams: 100 } },
    { ...snapshot, source: { ...snapshot.source, version: 'newer' } }, { ...snapshot, carbsPer100g: 42 },
  ]) assert.throws(() => validateFoodSnapshot(forged));
  const { proteinTenth: _protein, ...withoutProtein } = snapshot;
  assert.deepEqual(validateFoodSnapshot(withoutProtein), withoutProtein, 'Absent optional totals stay absent rather than changing a captured payload');
});

void test('legacy queued request fingerprints remain unchanged after a new official serving source becomes active', async () => {
  const input = parseNutritionCreate({ date: '2026-11-10', meal: 'lunch', name: '', portion: '', note: '', calories: null,
    food: { id: 'tfda:A0550601', amount: 150, unit: 'g' } }, new Date('2026-11-10T12:00:00Z'));
  assert.equal(Object.hasOwn(input.food!, 'basis'), false); assert.equal(Object.hasOwn(input.food!, 'catalogRelease'), false);
  assert.equal(await creationFingerprint(input), '80e42ed93700527669be4dfde14b1eb784af66e33c3538339aed3ff4df0bc07b');
});
