import assert from 'node:assert/strict';
import test from 'node:test';
import { CHINESE_FOOD_CATALOG_RELEASE, getFood, calculateFoodSelection, foodSelectionFromSnapshot, searchFoods } from './food-catalog.ts';
import { NutritionValidationError, parseNutritionCreate } from './nutrition.ts';
import { parseNutritionTemplate, parseNutritionTemplateEdit, parseNutritionTemplatePreview, parseNutritionTemplateRevision, previewNutritionTemplate, type NutritionTemplate } from './nutrition-templates.ts';
const ID = '11111111-1111-4111-8111-111111111111';
const component = (patch: Record<string, unknown> = {}) => ({ name: 'synthetic oats', portion: 'one bowl', grams: '100', calories: '10.1', carbs: '0', protein: null, fat: '2.3', provenance: { calories: { source: 'label' }, carbs: { source: 'manual' } }, ...patch });
const definition = (patch: Record<string, unknown> = {}) => ({ kind: 'food', name: 'my oats', note: 'personal serving', baseServings: '1', totalWeight: '100', components: [component()], ...patch });
function template(patch: Record<string, unknown> = {}): NutritionTemplate { return { ...parseNutritionTemplate(definition(patch)), id: ID, revision: 1, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', archivedAt: null }; }
const preview = (patch: Record<string, unknown> = {}) => parseNutritionTemplatePreview({ mode: 'servings', amount: '1', date: '2026-11-10', meal: 'lunch', expectedRevision: 1, ...patch });

void test('template normalization keeps unknown and real zero separate with source metadata', () => {
  const value = parseNutritionTemplate(definition({ baseServings: '01.200', totalWeight: '100.000' }));
  assert.equal(value.baseServings, '1.2'); assert.equal(value.totalWeight, '100');
  assert.deepEqual([value.components[0].calories, value.components[0].carbs, value.components[0].protein], ['10.1', '0.0', null]);
  assert.equal(value.components[0].provenance.calories?.source, 'label');
  assert.equal(value.components[0].provenance.protein?.source, 'unknown');
});
void test('three-decimal scaling uses immutable base values and stable half-up nutrient rounding', () => {
  const item = template(); const result = previewNutritionTemplate(item, preview({ amount: '0.5' }));
  assert.equal(result.rows[0].calories, '5.1'); assert.equal(result.rows[0].fat, '1.2'); assert.equal(result.rows[0].protein, null);
  assert.equal(result.rows[0].portion, '50g'); assert.equal(result.rows[0].provenance.calories?.source, 'label');
  assert.equal(previewNutritionTemplate(item, preview({ amount: '0.5' })).rows[0].calories, '5.1');
  assert.equal(item.components[0].calories, '10.1'); parseNutritionCreate(result.rows[0]);
});
void test('weight scaling requires declared yield weight and supports cooked recipe yield independent of ingredient weights', () => {
  const item = template({ kind: 'recipe', baseServings: '2', totalWeight: '200', components: [component({ grams: '150' })] });
  const result = previewNutritionTemplate(item, preview({ mode: 'weight', amount: '50' }));
  assert.equal(result.rows[0].calories, '2.5'); assert.equal(result.rows[0].portion, '50g');
  assert.throws(() => previewNutritionTemplate(template({ totalWeight: null }), preview({ mode: 'weight', amount: '50' })), NutritionValidationError);
});
void test('recipe aggregate leaves incomplete nutrients unknown while reporting observed subtotal and sources', () => {
  const item = template({ kind: 'recipe', name: 'my recipe', components: [component({provenance:{calories:{source:'label',basis:'carton per serving'},carbs:{source:'manual'}}}), component({ name: 'milk', calories: null, protein: '2', carbs: '3', fat: '0' })] });
  const result = previewNutritionTemplate(item, preview());
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].name, 'my recipe');
  assert.equal(result.rows[0].calories, null); assert.equal(result.nutrients.calories.total, '10.1');
  assert.equal(result.nutrients.calories.unknownCount, 1); assert.equal(result.rows[0].carbs, '3.0');
  assert.equal(result.rows[0].provenance.carbs?.source, 'unknown'); assert.match(result.rows[0].provenance.carbs?.basis ?? '', /manual/);
  assert.match(result.rows[0].provenance.calories?.basis ?? '', /carton per serving/); assert.match(result.rows[0].provenance.calories?.basis ?? '', /版本1/);
  parseNutritionCreate(result.rows[0]);
});
void test('meal templates retain separate foods and packaging/AI provenance after scaling', () => {
  const item = template({ kind: 'meal', components: [component(), component({ name: 'soup', calories: '50', provenance: { calories: { source: 'ai', basis: 'one small bowl', originalValue: '50' } } })] });
  const result = previewNutritionTemplate(item, preview({ amount: '2' }));
  assert.equal(result.rows.length, 2); assert.equal(result.rows[1].calories, '100.0');
  assert.deepEqual(result.rows[1].provenance.calories, { source: 'ai', basis: 'one small bowl', originalValue: '100.0', portion: '200g' });
  for (const row of result.rows) parseNutritionCreate(row);
});
void test('withdrawn catalog components retain their historical release and scaled rows validate against that immutable release', () => {
  const food = getFood('tfda:A0550601', CHINESE_FOOD_CATALOG_RELEASE)!; const snapshot = calculateFoodSelection({ id: food.id, amount: 100, unit: 'g', catalogRelease: CHINESE_FOOD_CATALOG_RELEASE });
  const value = template({ components: [component({ name: food.name, food: foodSelectionFromSnapshot(snapshot), calories: null, carbs: null, protein: null, fat: null, provenance: { calories: { source: 'catalog' } } })] });
  assert.equal(value.components[0].food?.catalogRelease, CHINESE_FOOD_CATALOG_RELEASE);
  const result = previewNutritionTemplate(value, preview({ amount: '1.333' }));
  assert.equal(result.rows[0].food?.amount, 133.3); assert.equal(result.rows[0].food?.catalogRelease, CHINESE_FOOD_CATALOG_RELEASE);
  assert.equal(result.foods.length, 1); assert.equal(result.foods[0].catalogRelease, CHINESE_FOOD_CATALOG_RELEASE); assert.equal(result.foods[0].id, food.id);
  assert.equal(result.rows[0].provenance.calories?.source, 'catalog'); parseNutritionCreate(result.rows[0]);
});
void test('validation rejects unknown fields, fabricated catalog/AI sources, unsafe shapes and unsupported amounts', () => {
  for (const patch of [{ sneaky: true }, { baseServings: '0' }, { totalWeight: '-1' }, { baseServings: '1e3' }, { components: [] }, { components: [component(), component()] }, { kind: 'dish' }]) assert.throws(() => parseNutritionTemplate(definition(patch)), NutritionValidationError);
  assert.throws(() => parseNutritionTemplate(definition({ components: [component({ provenance: { calories: { source: 'catalog' } } })] })), NutritionValidationError);
  assert.throws(() => parseNutritionTemplate(definition({ components: [component({ provenance: { calories: { source: 'ai' } } })] })), NutritionValidationError);
  assert.throws(() => parseNutritionTemplateEdit({ ...definition(), expectedRevision: 0 }), NutritionValidationError);
  assert.throws(() => parseNutritionTemplateRevision({ expectedRevision: 1, extra: true }), NutritionValidationError);
  assert.throws(() => parseNutritionTemplatePreview({ ...preview(), date: '2099-01-01' }), NutritionValidationError);
});
void test('oversized aggregate nutrients and archived templates cannot become a batch draft', () => {
  assert.throws(() => previewNutritionTemplate(template({ kind: 'recipe', components: [component({ calories: '15000' }), component({ calories: '15000' })] }), preview()), NutritionValidationError);
  assert.throws(() => previewNutritionTemplate({ ...template(), archivedAt: '2026-11-11T00:00:00Z' }, preview()), NutritionValidationError);
});

void test('official per-serving template components scale servings without inventing grams or a per-100g energy', () => {
  const food = searchFoods('巨无霸', 50).find((item) => item.basis === 'perServing');assert.ok(food);
  const selection = { id: food.id, amount: 1, unit: '份', catalogRelease: food.catalogRelease };
  const item = template({ totalWeight: null, components: [component({ name: food.name, portion: '1份', grams: null, calories: null, carbs: null, protein: null, fat: null, food: selection, provenance: { calories: { source: 'catalog' } } })] });
  assert.equal(item.components[0].grams, null);
  const result = previewNutritionTemplate(item, preview({ amount: '0.5' }));
  assert.equal(result.rows[0].portion, '0.5份');assert.equal(result.rows[0].calories, '256.5');assert.equal(result.rows[0].food?.unit, '份');
  const parsed = parseNutritionCreate(result.rows[0]);
  assert.equal(parsed.food?.basis, 'perServing');assert.equal(parsed.food?.grams, null);assert.equal(parsed.food?.kcalPer100g, null);
  assert.equal(result.rows[0].provenance.calories?.portion, '0.5份');
  assert.equal(result.foods.length, 1);assert.equal(result.foods[0].id, food.id);
  assert.throws(() => previewNutritionTemplate(item, preview({ mode: 'weight', amount: '100' })), /成品总重量/);
});

void test('user-declared template yield may scale a serving source while its archived official grams stay unknown', () => {
  const food = searchFoods('巨无霸', 50).find((item) => item.basis === 'perServing');assert.ok(food);
  const item = template({ totalWeight: '300', components: [component({ name: food.name, grams: null, calories: null, carbs: null, protein: null, fat: null, food: { id: food.id, amount: 1, unit: '份', catalogRelease: food.catalogRelease }, provenance: { calories: { source: 'catalog' } } })] });
  const result = previewNutritionTemplate(item, preview({ mode: 'weight', amount: '150' }));
  assert.equal(result.scale.ratio, '150/300');assert.equal(result.rows[0].food?.amount, 0.5);assert.equal(result.rows[0].portion, '0.5份');
  assert.equal(parseNutritionCreate(result.rows[0]).food?.grams, null);
});
