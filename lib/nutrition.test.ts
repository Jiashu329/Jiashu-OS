import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNutritionQuickEntry, buildNutritionReview, NutritionValidationError, parseNutritionCreate, parseNutritionMealCreate, parseNutritionPatch, parseNutritionQuery, presentNutritionEntry, summarizeNutrition, validNutritionId } from './nutrition.ts';
import type { NutritionEntry } from './nutrition.ts';

const NOW = new Date('2026-11-10T08:00:00Z');
function input(patch: Record<string, unknown> = {}) {
  return { date: '2026-11-10', meal: 'breakfast', name: '合成食物', portion: '1份', calories: '12.3', note: '', ...patch };
}
function entry(patch: Partial<NutritionEntry> = {}): NutritionEntry {
  return { ...parseNutritionCreate(input(), NOW), id: crypto.randomUUID(), revision: 1,
    createdAt: '2026-11-10T01:00:00Z', updatedAt: '2026-11-10T01:00:00Z', deletedAt: null, ...patch };
}

void test('food input normalizes text and exact calorie tenths while distinguishing unknown from a real zero', () => {
  const parsed = parseNutritionCreate(input({ name: '  苹果  ', portion: ' 1个 ', calories: '0012.3', note: ' 核对标签 ' }), NOW);
  assert.deepEqual(parsed, { date: '2026-11-10', meal: 'breakfast', name: '苹果', portion: '1个', note: '核对标签', caloriesTenth: 123 });
  for (const calories of [undefined, null, '', '  ']) assert.equal(parseNutritionCreate(input({ calories }), NOW).caloriesTenth, null);
  for (const calories of ['0', '0.0', '000.0']) assert.equal(parseNutritionCreate(input({ calories }), NOW).caloriesTenth, 0);
  assert.equal(parseNutritionCreate(input({ calories: '20000.0' }), NOW).caloriesTenth, 200000);
  assert.deepEqual(parseNutritionCreate({ date: '2026-11-10', meal: 'snack', name: '未知热量食物' }, NOW), {
    date: '2026-11-10', meal: 'snack', name: '未知热量食物', portion: '', note: '', caloriesTenth: null,
  });
});

void test('calorie input rejects coercion, scientific notation, extra decimals, unsupported units and out-of-range values', () => {
  for (const calories of [0, 1.2, true, {}, [], '-1', '+1', '1e3', '1E3', 'NaN', 'Infinity', '.5', '1.', '1.00', '20000.1',
    '100kcal', '1,234.5', '1\n', '\t1', '0'.repeat(129)]) {
    assert.throws(() => parseNutritionCreate(input({ calories }), NOW), NutritionValidationError);
  }
});

void test('food descriptions and dates validate against strict limits, supported meals and the current Shanghai day', () => {
  assert.equal(parseNutritionCreate(input({ name: '食'.repeat(100), portion: '份'.repeat(100), note: '记'.repeat(500) }), NOW).name.length, 100);
  for (const patch of [
    { name: '' }, { name: '食'.repeat(101) }, { portion: '份'.repeat(101) }, { note: '记'.repeat(501) },
    { name: '食物\n名称' }, { portion: '1\u0000份' }, { note: '\u007f' }, { meal: 'other' },
    { date: '2026-11-11' }, { date: '2026-02-30' }, { date: '2025-02-29' }, { date: '2026-11-10\n' },
    { date: '1969-12-31' }, { date: '2101-01-01' }, { owner: 'someone-else' },
  ]) assert.throws(() => parseNutritionCreate(input(patch), NOW), NutritionValidationError);
  assert.equal(parseNutritionCreate(input({ note: '标签\n备注\t保留' }), NOW).note, '标签\n备注\t保留');
  assert.throws(() => parseNutritionCreate(input(), new Date('2026-11-09T15:59:59Z')), NutritionValidationError);
  assert.equal(parseNutritionCreate(input(), new Date('2026-11-09T16:00:00Z')).date, '2026-11-10');
});

void test('edits require complete normalized fields and a positive revision while delete/restore only carry state and revision', () => {
  const edited = parseNutritionPatch({ ...input({ date: '2026-11-09', meal: 'dinner', calories: null }), expectedRevision: 1 }, NOW);
  assert.equal(edited.kind, 'edit');
  if (edited.kind === 'edit') {
    assert.equal(edited.input.date, '2026-11-09');
    assert.equal(edited.input.caloriesTenth, null);
    assert.equal(edited.expectedRevision, 1);
  }
  assert.deepEqual(parseNutritionPatch({ deleted: true, expectedRevision: 2 }, NOW), { kind: 'deleted', deleted: true, expectedRevision: 2 });
  assert.deepEqual(parseNutritionPatch({ deleted: false, expectedRevision: 3 }, NOW), { kind: 'deleted', deleted: false, expectedRevision: 3 });
  for (const key of ['date', 'meal', 'name', 'portion', 'calories', 'note']) {
    const partial: Record<string, unknown> = { ...input(), expectedRevision: 1 };
    delete partial[key];
    assert.throws(() => parseNutritionPatch(partial, NOW), NutritionValidationError);
  }
  for (const expectedRevision of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseNutritionPatch({ ...input(), expectedRevision }, NOW), NutritionValidationError);
  }
  assert.throws(() => parseNutritionPatch({ deleted: true, expectedRevision: 1, name: '新名称' }, NOW), NutritionValidationError);
  assert.throws(() => parseNutritionPatch({ deleted: 'true', expectedRevision: 1 }, NOW), NutritionValidationError);
});

void test('active summaries preserve null, zero and exact decimals and include meal-specific known and unknown counts', () => {
  assert.equal(summarizeNutrition([]).knownCalories, null);
  const unknown = summarizeNutrition([entry({ caloriesTenth: null })]);
  assert.equal(unknown.knownCalories, null);
  assert.equal(unknown.knownCount, 0);
  assert.equal(unknown.unknownCount, 1);
  const zero = summarizeNutrition([entry({ caloriesTenth: 0 })]);
  assert.equal(zero.knownCalories, '0.0');
  assert.equal(zero.knownCount, 1);
  const mixed = summarizeNutrition([
    entry({ caloriesTenth: 1 }), entry({ caloriesTenth: 2 }), entry({ meal: 'lunch', caloriesTenth: null }),
    entry({ meal: 'dinner', caloriesTenth: 200000, deletedAt: '2026-11-10T03:00:00Z' }),
  ]);
  assert.equal(mixed.knownCalories, '0.3');
  assert.equal(mixed.entryCount, 3);
  assert.equal(mixed.knownCount, 2);
  assert.equal(mixed.unknownCount, 1);
  assert.deepEqual(mixed.meals[0], { meal: 'breakfast', label: '早餐', entryCount: 2, knownCount: 2, unknownCount: 0, knownCalories: '0.3' });
  assert.equal(mixed.meals[1].unknownCount, 1);
  assert.equal(mixed.meals[2].entryCount, 0);
  assert.equal(mixed.meals[3].knownCalories, null);
});

void test('the same food can be logged multiple times and summaries do not truncate a large daily diary', () => {
  const many = Array.from({ length: 1001 }, () => entry({ name: '同名食物', caloriesTenth: 200000 }));
  const result = buildNutritionReview(many, parseNutritionQuery(new URLSearchParams(), NOW));
  assert.equal(result.entries.length, 1001);
  assert.equal(result.summary.entryCount, 1001);
  assert.equal(result.summary.knownCalories, '20020000.0');
});

void test('selected-day visibility and summaries differ intentionally for deleted entries and recent seven days follow the selected historical date', () => {
  const selection = parseNutritionQuery(new URLSearchParams({ date: '2026-11-05' }), NOW);
  assert.equal(selection.recentFrom, '2026-10-30');
  assert.equal(selection.recentTo, '2026-11-05');
  const rows = [
    entry({ date: '2026-11-04', caloriesTenth: 100 }), entry({ date: '2026-11-05', caloriesTenth: null }),
    entry({ date: '2026-11-05', caloriesTenth: 0 }), entry({ date: '2026-11-05', caloriesTenth: 200, deletedAt: '2026-11-05T03:00:00Z' }),
    entry({ date: '2026-11-10', caloriesTenth: 999 }),
  ];
  const review = buildNutritionReview(rows, selection);
  assert.equal(review.entries.length, 2);
  assert.equal(review.summary.knownCalories, '0.0');
  assert.equal(review.summary.unknownCount, 1);
  assert.equal(review.recent7days.length, 7);
  assert.equal(review.recent7days[0].date, '2026-10-30');
  assert.equal(review.recent7days[0].summary.knownCalories, null);
  assert.equal(review.recent7days[5].summary.knownCalories, '10.0');
  assert.equal(review.recent7days[6].date, '2026-11-05');
  const deletedVisible = buildNutritionReview(rows, { ...selection, includeDeleted: true });
  assert.equal(deletedVisible.entries.length, 3);
  assert.deepEqual(deletedVisible.summary, review.summary);
  assert.deepEqual(deletedVisible.recent7days, review.recent7days);
});

void test('entry display and query validation retain exact zero and strict UUID/date behavior', () => {
  assert.equal(presentNutritionEntry(entry({ caloriesTenth: null })).calories, null);
  assert.equal(presentNutritionEntry(entry({ caloriesTenth: 0 })).calories, '0.0');
  assert.equal(presentNutritionEntry(entry({ caloriesTenth: 123 })).calories, '12.3');
  assert.equal(presentNutritionEntry(entry({ deletedAt: '2026-11-10T03:00:00Z' })).deleted, true);
  const id = crypto.randomUUID();
  assert.equal(validNutritionId(id), true);
  assert.equal(validNutritionId(id.toUpperCase()), true);
  assert.equal(validNutritionId(id + '\n'), false);
  for (const query of ['date=', 'date=2026-11-11', 'date=2026-02-30']) assert.throws(() => parseNutritionQuery(new URLSearchParams(query), NOW), NutritionValidationError);
});

void test('the first supported days clamp both the recent range and visible cards to valid selectable dates', () => {
  for (const [selected, count] of [['1970-01-01', 1], ['1970-01-05', 5], ['1970-01-07', 7]] as const) {
    const selection = parseNutritionQuery(new URLSearchParams({ date: selected }), NOW);
    assert.equal(selection.recentFrom, '1970-01-01');
    assert.equal(selection.recentTo, selected);
    const review = buildNutritionReview([], selection);
    assert.equal(review.recent7days.length, count);
    assert.equal(review.recent7days[0].date, '1970-01-01');
    assert.equal(review.recent7days.at(-1)!.date, selected);
    for (const point of review.recent7days) assert.equal(parseNutritionQuery(new URLSearchParams({ date: point.date }), NOW).date, point.date);
  }
});

void test('quick suggestions preserve distinct portions and unknown calories, ignore deleted and future rows, and rank repeated observations', () => {
  const rows = [
    entry({ id: 'older-oats', date: '2026-10-20', name: '燕麦', portion: '一碗', caloriesTenth: 2000 }),
    entry({ id: 'recent-oats', date: '2026-11-09', name: '燕麦', portion: '一碗', caloriesTenth: 2000, meal: 'lunch' }),
    entry({ id: 'different-portion', date: '2026-11-10', name: '燕麦', portion: '半碗', caloriesTenth: 1000 }),
    entry({ id: 'unknown', date: '2026-11-09', name: '未知热量', caloriesTenth: null }),
    entry({ id: 'zero', date: '2026-11-09', name: '零热量', caloriesTenth: 0 }),
    entry({ id: 'deleted', date: '2026-11-09', name: '已删除', deletedAt: '2026-11-09T01:00:00Z' }),
    entry({ id: 'future', date: '2026-11-11', name: '未来食物' }),
    entry({ id: 'too-old', date: '2026-10-11', name: '过早食物' }),
  ];
  const quick = buildNutritionQuickEntry(rows, '2026-11-10');
  assert.equal(quick.from, '2026-10-12'); assert.equal(quick.previousDate, '2026-11-09');
  assert.equal(quick.recent[0].id, 'different-portion');
  assert.equal(quick.frequent.length, 1); assert.equal(quick.frequent[0].id, 'recent-oats'); assert.equal(quick.frequent[0].uses, 2);
  assert.equal(quick.recent.find((row) => row.id === 'unknown')?.calories, null);
  assert.equal(quick.recent.find((row) => row.id === 'zero')?.calories, '0.0');
  assert.deepEqual(quick.previousMeals.find((meal) => meal.meal === 'lunch')?.entries.map((row) => row.id), ['recent-oats']);
  assert.equal(quick.previousMeals.reduce((sum, meal) => sum + meal.entries.length, 0), 3);
  assert.ok(quick.recent.every((row) => !['deleted', 'future', 'too-old'].includes(row.id)));
  const historical = buildNutritionQuickEntry(rows, '2026-11-09');
  assert.ok(historical.recent.every((row) => row.date <= '2026-11-09'));
  assert.equal(buildNutritionQuickEntry([], '1970-01-01').previousDate, null);
});

void test('whole-meal snapshots validate all rows and apply only the chosen target date and meal', () => {
  const parsed = parseNutritionMealCreate({ date: '2026-11-10', meal: 'lunch', entries: [
    { name: ' 饭 ', portion: ' 一碗 ', calories: '000.0', note: '' }, { name: '菜', calories: null },
  ] }, NOW);
  assert.equal(parsed.entries.length, 2); assert.ok(parsed.entries.every((row) => row.date === parsed.date && row.meal === parsed.meal));
  assert.equal(parsed.entries[0].caloriesTenth, 0); assert.equal(parsed.entries[1].caloriesTenth, null);
  for (const body of [
    { date: '2026-11-11', meal: 'lunch', entries: [{ name: '饭' }] },
    { date: '2026-11-10', meal: 'other', entries: [{ name: '饭' }] },
    { date: '2026-11-10', meal: 'lunch', entries: [] },
    { date: '2026-11-10', meal: 'lunch', entries: Array.from({ length: 41 }, () => ({ name: '饭' })) },
    { date: '2026-11-10', meal: 'lunch', entries: [{ name: '饭', date: '2026-11-09' }] },
    { date: '2026-11-10', meal: 'lunch', entries: [{ name: '饭', owner: 'bob' }] },
  ]) assert.throws(() => parseNutritionMealCreate(body, NOW), NutritionValidationError);
  assert.throws(() => parseNutritionMealCreate({ date: '2026-11-10', meal: 'lunch', entries: [{ name: '饭' }, { name: '', calories: '1' }] }, NOW), (error: unknown) => error instanceof NutritionValidationError && error.issues[0].path === 'entries[1].name');
});
