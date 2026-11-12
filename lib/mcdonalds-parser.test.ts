import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVE_FOOD_CATALOG_RELEASE, getFood, isServingFood } from './food-catalog.ts';
import { buildNutritionDrafts } from './nutrition-parser.ts';

const bigMac = getFood('mcd-cn:49:28');
assert.ok(bigMac && isServingFood(bigMac));
const name = bigMac.name;
function parse(amount: number, unit: string, foodName = name) {
  const sourceText = `${amount}${unit}${foodName}`;
  return buildNutritionDrafts(JSON.stringify({ items: [{ name: foodName, amount, unit, meal: 'lunch', dateText: null, sourceText }] }), {
    text: '午餐吃了' + sourceText, date: '2026-11-12', today: '2026-11-12', meal: 'lunch',
  }).drafts[0];
}

void test('official McDonald serving drafts use the published 513 kcal and macros without fabricating grams', () => {
  const half = parse(0.5, '份');
  assert.equal(half.food?.id, 'mcd-cn:49:28');
  assert.equal(half.food?.catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
  assert.equal(half.calorieSource, 'catalog');
  assert.equal(half.calories, '256.5');
  assert.equal(half.carbs, '21.0');
  assert.equal(half.protein, '13.5');
  assert.equal(half.fat, '13.0');
  assert.equal(half.portion, '0.5份');
  assert.equal(half.provenance.calories?.source, 'catalog');
  assert.doesNotMatch(half.portion, /NaN|null|g|100/);
  const twice = parse(2, '份');
  assert.equal(twice.calories, '1026.0');
  assert.equal(twice.portion, '2份');
});

void test('gram requests cannot silently treat an official serving as 100g', () => {
  const invalid = parse(100, 'g');
  assert.equal(invalid.food, null);
  assert.equal(invalid.calories, null);
  assert.match(invalid.warnings.join(' '), /官方每份.*无可靠克重/);
  assert.doesNotMatch(invalid.warnings.join(' '), /请改填克重/);
});

void test('a generic fries description does not automatically choose a McDonald size or brand', () => {
  const generic = parse(1, '份', '薯条');
  assert.equal(generic.food, null);
  assert.equal(generic.calorieSource, null);
});

void test('an unambiguous branded base name resolves but fries with unspecified size remain candidates', () => {
  const burger = parse(1, '份', '麦当劳巨无霸');
  assert.equal(burger.food?.id, 'mcd-cn:49:28');
  assert.equal(burger.calories, '513.0');
  const fries = parse(1, '份', '麦当劳薯条');
  assert.equal(fries.food, null);
  assert.equal(fries.calorieSource, null);
  assert.ok(fries.candidates.filter((food) => food.basis === 'perServing').length >= 4);
});
