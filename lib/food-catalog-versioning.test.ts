import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import manifest from '../data/food-catalog-releases.json' with { type: 'json' };
import overlay from '../data/food-catalog-releases/tfda-2024-03-29-cn2.json' with { type: 'json' };
import { ACTIVE_FOOD_CATALOG_RELEASE, LEGACY_FOOD_CATALOG_RELEASE, CHINESE_FOOD_CATALOG_RELEASE, FOOD_CATALOG_RELEASES,
  calculateFoodSelection, foodSelectionFromSnapshot, getFood, searchFoods, validateFoodSnapshot } from './food-catalog.ts';
import { parseNutritionCreate, NutritionValidationError } from './nutrition.ts';
import { creationFingerprint } from '../db/nutrition-store.ts';
import { buildNutritionDrafts } from './nutrition-parser.ts';

const id = 'tfda:A0550601';
const now = Date.parse('2026-11-10T12:00:00Z');
const body = { date: '2026-11-10', meal: 'lunch', name: '', portion: '', note: '', calories: null };
const legacySelection = { id, amount: 150, unit: 'g' };

void test('released catalogs have immutable source-file checksums and independent record objects', () => {
  assert.notEqual(ACTIVE_FOOD_CATALOG_RELEASE, LEGACY_FOOD_CATALOG_RELEASE);
  assert.equal(overlay.id, CHINESE_FOOD_CATALOG_RELEASE);
  assert.equal(overlay.parent, LEGACY_FOOD_CATALOG_RELEASE);
  assert.equal(FOOD_CATALOG_RELEASES.filter((release) => release.active).length, 1);
  for (const release of manifest.releases) {
    const bytes = readFileSync(new URL('../' + release.file, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), release.sha256);
  }
  for (const foodId of [...Object.keys(overlay.aliases), ...overlay.referencePortionFoodIds]) {
    assert.ok(getFood(foodId, LEGACY_FOOD_CATALOG_RELEASE), 'Overlay cannot silently invent source records');
  }
  const legacy = getFood(id, LEGACY_FOOD_CATALOG_RELEASE)!;
  const current = getFood(id)!;
  assert.notStrictEqual(legacy, current);
  assert.notStrictEqual(legacy.portions, current.portions);
  assert.throws(() => { current.kcalPer100g = 1; }, TypeError);
  assert.throws(() => { legacy.source.version = 'changed'; }, TypeError);
  assert.throws(() => { current.portions.push({ unit: '碗', grams: 1, estimated: false }); }, TypeError);
});

void test('active release retrieves dishes faithfully and only adds the pinned official brand specifications', () => {
  const dishes = searchFoods('炒饭');
  assert.ok(dishes.length >= 2);
  assert.ok(dishes.every((food) => food.name.includes('冷冻') && food.state.includes('冷冻')));
  assert.ok(searchFoods('饺子').length >= 2);
  const brand = searchFoods('麦当劳巨无霸');
  assert.ok(brand.some((food) => food.id === 'mcd-cn:49:28'));
  assert.equal(getFood('mcd-cn:49:28', CHINESE_FOOD_CATALOG_RELEASE), null);
  const current = getFood(id)!;
  assert.ok(current.portions.some((portion) => portion.unit === '参考100g' && /非固定一份/.test(portion.label ?? '')));
  assert.ok(!getFood(id, LEGACY_FOOD_CATALOG_RELEASE)!.portions.some((portion) => portion.unit === '参考100g'));
  assert.throws(() => calculateFoodSelection({ id, amount: 1, unit: '参考100g' }), /可靠克重/);
  const selected = calculateFoodSelection({ id, amount: 1, unit: '参考100g', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE });
  assert.equal(selected.grams, 100); assert.equal(selected.caloriesTenth, 1830);
  assert.equal(selected.estimated, true);
  assert.deepEqual(validateFoodSnapshot(selected), selected);
  assert.throws(() => validateFoodSnapshot({ ...selected, catalogRelease: LEGACY_FOOD_CATALOG_RELEASE }), /可靠克重/);
});

void test('old snapshots retain their exact field shape while every supplied source field is verified', () => {
  const explicit = calculateFoodSelection(legacySelection);
  const { catalogRelease: _release, carbsPer100g: _c, proteinPer100g: _p, fatPer100g: _f,
    carbsTenth: _ct, proteinTenth: _pt, fatTenth: _ft, ...old } = explicit;
  assert.deepEqual(validateFoodSnapshot(old), old);
  assert.equal(Object.hasOwn(validateFoodSnapshot(old), 'catalogRelease'), false);
  assert.equal(Object.hasOwn(validateFoodSnapshot(old), 'proteinTenth'), false);
  assert.deepEqual(foodSelectionFromSnapshot(old), { ...legacySelection, catalogRelease: LEGACY_FOOD_CATALOG_RELEASE });
  for (const forged of [{ ...old, caloriesTenth: 1 }, { ...old, grams: 1 },
    { ...old, source: { ...old.source, version: 'future source' } }, { ...old, catalogRelease: 'missing-release' },
    { ...old, proteinTenth: 0 }, { ...old, fabricated: true }, { ...old, catalogRelease: null }]) {
    assert.throws(() => validateFoodSnapshot(forged));
  }
});

void test('legacy queued submissions keep their pre-versioning fingerprint; new submissions bind their release', async () => {
  const legacy = parseNutritionCreate({ ...body, food: legacySelection }, now);
  assert.equal(Object.hasOwn(legacy.food!, 'catalogRelease'), false);
  assert.equal(await creationFingerprint(legacy), '80e42ed93700527669be4dfde14b1eb784af66e33c3538339aed3ff4df0bc07b');
  const current = parseNutritionCreate({ ...body, food: { ...legacySelection, catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE } }, now);
  assert.equal(current.food!.catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
  assert.notEqual(await creationFingerprint(current), await creationFingerprint(legacy));
  assert.equal(current.caloriesTenth, legacy.caloriesTenth);
  for (const catalogRelease of ['', null, 1, 'future', 'x'.repeat(101)]) {
    assert.throws(() => parseNutritionCreate({ ...body, food: { ...legacySelection, catalogRelease } }, now), NutritionValidationError);
  }
});

void test('AI food matches emit the active release so confirming later cannot silently upgrade their source', () => {
  const result = buildNutritionDrafts(JSON.stringify({ items: [{ name: '白饭', amount: 150, unit: 'g',
    meal: 'lunch', dateText: null, sourceText: '150g白饭' }] }),
  { text: '吃了150g白饭', date: '2026-11-10', today: '2026-11-10', meal: 'lunch' });
  assert.equal(result.drafts[0].food?.catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
  assert.equal(result.drafts[0].candidates[0].catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
  const generic = buildNutritionDrafts(JSON.stringify({ items: [{ name: '火腿炒饭', amount: 150, unit: 'g',
    meal: 'lunch', dateText: null, sourceText: '150g火腿炒饭' }] }),
  { text: '吃了150g火腿炒饭', date: '2026-11-10', today: '2026-11-10', meal: 'lunch' });
  assert.ok(generic.drafts[0].candidates.some((food) => food.name === '冷冻火腿炒饭'));
  assert.equal(generic.drafts[0].food, null, 'Broader discovery names must not automatically select a frozen packaged dish');
});
