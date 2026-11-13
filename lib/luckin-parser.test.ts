import assert from 'node:assert/strict';
import test from 'node:test';
import { getFood, searchFoods } from './food-catalog.ts';
import { buildNutritionDrafts } from './nutrition-parser.ts';
import { buildNutritionPhotoDrafts, parseNutritionPhotoRequest } from './nutrition-photo.ts';
import { TINY_JPEG_DATA_URL } from '../tests/fixtures/nutrition-photo.ts';

const estimate = { calories: 220, carbs: 25, protein: 2, fat: 12, portion: '一杯，杯型与糖度待核对', basis: '根据描述估计，不能确认官网的对应配置' };
function textDraft(name: string, configuration: string) {
  const sourceText = `1份${name}${configuration}`;
  return buildNutritionDrafts(JSON.stringify({ items: [{ name, amount: 1, unit: '份', meal: 'breakfast', dateText: null, sourceText, estimate }] }), {
    text: `早餐喝了${sourceText}`, date: '2026-11-13', today: '2026-11-13', meal: 'breakfast',
  }).drafts[0];
}

test('Luckin text drafts preserve candidates but require explicit configuration selection before using official calories', () => {
  const coconut = getFood('luckin-cn:1');
  assert.ok(coconut);
  for (const [name, configuration] of [['瑞幸生椰拿铁', ''], ['瑞幸生椰拿铁', '（热/加糖）'], [coconut.name, '']] as const) {
    const draft = textDraft(name, configuration);
    assert.equal(draft.food, null);
    assert.equal(draft.calories, '220.0');
    assert.equal(draft.calorieSource, 'ai');
    assert.equal(draft.provenance.calories?.source, 'ai');
    assert.ok(draft.candidates.some((food) => food.id === coconut.id));
    assert.match(draft.warnings.join(' '), /杯型、冰热和糖度.*主动选择/);
  }
});

test('a Luckin photo keeps the AI estimate and known candidates without inferring cup or sweetness configuration', () => {
  const request = parseNutritionPhotoRequest({ image: { dataUrl: TINY_JPEG_DATA_URL }, text: '热的，加了糖', date: '2026-11-13', meal: 'breakfast' }, Date.parse('2026-11-13T04:00:00Z'));
  const answer = JSON.stringify({ items: [{ name: '瑞幸生椰拿铁', evidence: '带瑞幸标识的咖啡杯，标签看不清', confidence: 'high', estimate }] });
  const draft = buildNutritionPhotoDrafts(answer, request).drafts[0];
  assert.equal(draft.food, null);
  assert.equal(draft.calories, '220.0');
  assert.equal(draft.calorieSource, 'ai');
  assert.equal(draft.provenance.calories?.source, 'ai');
  assert.ok(draft.candidates.some((food) => food.id === 'luckin-cn:1'));
  assert.match(draft.warnings.join(' '), /图片不能确认.*主动选择/);
});

test('Luckin products without official calories never enter the calculable text or photo candidate list', () => {
  assert.equal(getFood('luckin-cn:7'), null);
  assert.deepEqual(searchFoods('瑞幸小黄油拿铁'), []);
  const draft = textDraft('瑞幸小黄油拿铁', '');
  assert.equal(draft.food, null);
  assert.equal(draft.calorieSource, 'ai');
  assert.deepEqual(draft.candidates, []);
});
