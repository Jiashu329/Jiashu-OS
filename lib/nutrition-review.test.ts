import assert from 'node:assert/strict';
import test from 'node:test';
import type { NutritionDayStatus, NutritionEntry } from './nutrition.ts';
import { NutritionValidationError } from './nutrition.ts';
import { buildNutritionInsight, nutritionDayCompleteness, parseNutritionInsightQuery } from './nutrition-review.ts';

const NOW = Date.parse('2026-11-11T18:00:00+08:00');
function entry(date: string, caloriesTenth: number | null, patch: Partial<NutritionEntry> = {}): NutritionEntry {
  return { id: 'synthetic', date, meal: 'lunch', name: 'Synthetic food', portion: '', note: '', caloriesTenth,
    revision: 1, createdAt: date + 'T12:00:00+08:00', updatedAt: date + 'T12:00:00+08:00', deletedAt: null, ...patch };
}
function complete(date: string): NutritionDayStatus {
  return { date, complete: true, revision: 1, meals: { breakfast: 'skipped', lunch: 'recorded', dinner: 'skipped', snack: 'unrecorded' } };
}

test('nutrition insight ranges validate exact query values and use Shanghai dates', () => {
  assert.deepEqual(parseNutritionInsightQuery(new URLSearchParams(), Date.parse('2026-11-10T16:30:00Z')),
    { from: '2026-11-05', to: '2026-11-11', days: 7 });
  assert.deepEqual(parseNutritionInsightQuery(new URLSearchParams('date=2024-03-01&days=30'), NOW),
    { from: '2024-02-01', to: '2024-03-01', days: 30 });
  assert.deepEqual(parseNutritionInsightQuery(new URLSearchParams('date=1970-01-02&days=30'), NOW),
    { from: '1970-01-01', to: '1970-01-02', days: 30 });
  for (const query of ['days=90', 'days=7e0', 'days=', 'days=7&days=30', 'date=2026-11-12', 'date=2026-02-30',
    'date=1969-12-31', 'date=2101-01-01', 'date=2026-11-10&date=2026-11-11', 'userId=bob']) {
    assert.throws(() => parseNutritionInsightQuery(new URLSearchParams(query), NOW), NutritionValidationError, query);
  }
});

test('missing, unknown and true zero remain distinct and averages use only comparable complete days', () => {
  const rows = [entry('2026-11-04', 9000), entry('2026-11-05', null), entry('2026-11-06', 0),
    entry('2026-11-07', 1001), entry('2026-11-07', 2002), entry('2026-11-08', 3000), entry('2026-11-08', null),
    entry('2026-11-09', 5000, { deletedAt: '2026-11-09T12:01:00+08:00' }), entry('2026-11-12', 9000)];
  const range = parseNutritionInsightQuery(new URLSearchParams(), NOW);
  const review = buildNutritionInsight(rows, ['2026-11-06', '2026-11-07', '2026-11-08'].map(complete), range);
  assert.equal(review.days.length, 7);
  assert.deepEqual(review.days.map((day) => [day.date, day.knownCalories, day.unknownCount]), [
    ['2026-11-05', null, 1], ['2026-11-06', '0.0', 0], ['2026-11-07', '300.3', 0],
    ['2026-11-08', '300.0', 1], ['2026-11-09', null, 0], ['2026-11-10', null, 0], ['2026-11-11', null, 0],
  ]);
  const {nutrients,nutrientAverages,...legacySummary}=review.summary;
  assert.deepEqual(legacySummary, { recordedDays: 4, completeDays: 3, comparableDays: 2,
    knownCalories: '600.3', averageCompleteKcal: '150.2', unknownCount: 2 });
  const {nutrients:lunchNutrients,...lunch}=review.meals.find((meal)=>meal.meal==='lunch')!;
  assert.deepEqual(lunch, { meal: 'lunch', label: '午餐', knownCalories: '600.3', entryCount: 6 });
  assert.equal(review.meals.find((meal) => meal.meal === 'breakfast')!.knownCalories, null);
});

test('completion reconciles contradictory labels with current effective food records', () => {
  const date = '2026-11-10';
  const stale = complete(date);
  stale.meals.lunch = 'skipped';
  assert.deepEqual(nutritionDayCompleteness([entry(date, 100)], stale), {
    complete: true, meals: { breakfast: 'skipped', lunch: 'recorded', dinner: 'skipped', snack: 'unrecorded' },
  });
  stale.meals.breakfast = 'recorded';
  assert.equal(nutritionDayCompleteness([entry(date, 100)], stale).complete, false);
  const allSkipped: NutritionDayStatus = { date, complete: true, revision: 2,
    meals: { breakfast: 'skipped', lunch: 'skipped', dinner: 'skipped', snack: 'unrecorded' } };
  const review = buildNutritionInsight([], [allSkipped], parseNutritionInsightQuery(new URLSearchParams(), NOW));
  assert.equal(review.summary.completeDays, 1);
  assert.equal(review.summary.comparableDays, 0);
  assert.equal(review.summary.averageCompleteKcal, null);
  assert.equal(review.days.find((day) => day.date === date)!.knownCalories, null);
});

test('empty reviews keep all dates missing and invalid stored energy does not become a chart value', () => {
  const range = parseNutritionInsightQuery(new URLSearchParams(), NOW);
  const review = buildNutritionInsight([], [], range);
  assert.equal(review.summary.knownCalories, null);
  assert.equal(review.summary.averageCompleteKcal, null);
  assert.ok(review.days.every((day) => day.knownCalories === null && !day.complete));
  for (const value of [NaN, -1, 0.5, 200001]) assert.throws(() => buildNutritionInsight([entry('2026-11-10', value)], [], range));
  assert.match(review.limitations.join(' '), /不是全天总消耗/);
});

test('macro review compares each nutrient on its own complete observed days and includes meal totals',()=>{
  const range=parseNutritionInsightQuery(new URLSearchParams(),NOW);
  const rows=[entry('2026-11-10',1000,{carbsTenth:0,proteinTenth:101,fatTenth:null}),entry('2026-11-11',null,{carbsTenth:200,proteinTenth:null,fatTenth:50})];
  const result=buildNutritionInsight(rows,rows.map((row)=>complete(row.date)),range);
  assert.deepEqual(result.summary.nutrients.carbs,{total:'20.0',knownCount:2,unknownCount:0});
  assert.deepEqual(result.summary.nutrientAverages.carbs,{average:'10.0',comparableDays:2});
  assert.deepEqual(result.summary.nutrientAverages.protein,{average:'10.1',comparableDays:1});
  assert.deepEqual(result.summary.nutrientAverages.fat,{average:'5.0',comparableDays:1});
  assert.equal(result.meals.find((meal)=>meal.meal==='lunch')?.nutrients.protein.total,'10.1');
  assert.equal(result.days.find((day)=>day.date==='2026-11-10')?.nutrients.carbs.total,'0.0');
});
