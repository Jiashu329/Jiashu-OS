import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import manifest from '../data/food-catalog-releases.json' with { type: 'json' };
import overlay from '../data/food-catalog-releases/tfda-2024-03-29-cn2.json' with { type: 'json' };
import { ACTIVE_FOOD_CATALOG_RELEASE, LEGACY_FOOD_CATALOG_RELEASE, CHINESE_FOOD_CATALOG_RELEASE, MCD_FOOD_CATALOG_RELEASE, FOOD_CATALOG_RELEASES,
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
  const current = getFood(id, CHINESE_FOOD_CATALOG_RELEASE)!;
  assert.notStrictEqual(legacy, current);
  assert.notStrictEqual(legacy.portions, current.portions);
  assert.throws(() => { current.kcalPer100g = 1; }, TypeError);
  assert.throws(() => { legacy.source.version = 'changed'; }, TypeError);
  assert.throws(() => { current.portions.push({ unit: '碗', grams: 1, estimated: false }); }, TypeError);
});

void test('withdrawing a source removes it from discovery while preserving all historical reference portions', () => {
  assert.deepEqual(searchFoods('炒饭'), []);
  assert.deepEqual(searchFoods('饺子'), []);
  assert.ok(searchFoods('麦当劳巨无霸').some((food) => food.id === 'mcd-cn:49:28'));
  assert.equal(getFood(id), null);
  assert.equal(getFood('mcd-cn:49:28', CHINESE_FOOD_CATALOG_RELEASE), null);
  const chinese = getFood(id, CHINESE_FOOD_CATALOG_RELEASE)!;
  assert.ok(chinese.portions.some((portion) => portion.unit === '参考100g' && /非固定一份/.test(portion.label ?? '')));
  assert.ok(!getFood(id, LEGACY_FOOD_CATALOG_RELEASE)!.portions.some((portion) => portion.unit === '参考100g'));
  assert.throws(() => calculateFoodSelection({ id, amount: 1, unit: '参考100g' }), /可靠克重/);
  assert.throws(() => calculateFoodSelection({ id, amount: 1, unit: 'g', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE }), /找不到/);
  for (const catalogRelease of [CHINESE_FOOD_CATALOG_RELEASE, MCD_FOOD_CATALOG_RELEASE]) {
    const selected = calculateFoodSelection({ id, amount: 1, unit: '参考100g', catalogRelease });
    assert.equal(selected.grams, 100); assert.equal(selected.caloriesTenth, 1830);
    assert.equal(selected.estimated, true);
    assert.deepEqual(validateFoodSnapshot(selected), selected);
    assert.throws(() => validateFoodSnapshot({ ...selected, catalogRelease: LEGACY_FOOD_CATALOG_RELEASE }), /可靠克重/);
  }
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

void test('legacy queued submissions keep their pre-versioning fingerprint and explicit historical release', async () => {
  const legacy = parseNutritionCreate({ ...body, food: legacySelection }, now);
  assert.equal(Object.hasOwn(legacy.food!, 'catalogRelease'), false);
  assert.equal(await creationFingerprint(legacy), '80e42ed93700527669be4dfde14b1eb784af66e33c3538339aed3ff4df0bc07b');
  const current = parseNutritionCreate({ ...body, food: { ...legacySelection, catalogRelease: MCD_FOOD_CATALOG_RELEASE } }, now);
  assert.equal(current.food!.catalogRelease, MCD_FOOD_CATALOG_RELEASE);
  assert.notEqual(await creationFingerprint(current), await creationFingerprint(legacy));
  assert.equal(current.caloriesTenth, legacy.caloriesTenth);
  for (const catalogRelease of ['', null, 1, 'future', 'x'.repeat(101)]) {
    assert.throws(() => parseNutritionCreate({ ...body, food: { ...legacySelection, catalogRelease } }, now), NutritionValidationError);
  }
});

void test('previous brand submissions retain their fingerprint while new selections bind the active release', async () => {
  const selection = { id: 'mcd-cn:49:28', amount: 1, unit: '份' };
  const previous = parseNutritionCreate({ ...body, food: { ...selection, catalogRelease: MCD_FOOD_CATALOG_RELEASE } }, now);
  const current = parseNutritionCreate({ ...body, food: { ...selection, catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE } }, now);
  assert.equal(await creationFingerprint(previous), '26380175cd2bc82cb7436f1527e4a6abd5af62d4f8989ff4bfb3fc314d8ee1e6');
  assert.equal(current.food!.catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
  assert.equal(current.caloriesTenth, previous.caloriesTenth);
  assert.notEqual(await creationFingerprint(current), await creationFingerprint(previous));
});

void test('AI matches only current retained food candidates, and withdrawn foods fall back to user review', () => {
  const result = buildNutritionDrafts(JSON.stringify({ items: [{ name: '巨无霸', amount: 1, unit: '份',
    meal: 'lunch', dateText: null, sourceText: '1份巨无霸' }] }),
  { text: '吃了1份巨无霸', date: '2026-11-10', today: '2026-11-10', meal: 'lunch' });
  assert.equal(result.drafts[0].food?.catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
  assert.equal(result.drafts[0].candidates[0].catalogRelease, ACTIVE_FOOD_CATALOG_RELEASE);
  for (const name of ['白饭', '火腿炒饭']) {
    const generic = buildNutritionDrafts(JSON.stringify({ items: [{ name, amount: 150, unit: 'g',
      meal: 'lunch', dateText: null, sourceText: '150g' + name }] }),
    { text: '吃了150g' + name, date: '2026-11-10', today: '2026-11-10', meal: 'lunch' });
    assert.deepEqual(generic.drafts[0].candidates, []);
    assert.equal(generic.drafts[0].food, null);
  }
});
