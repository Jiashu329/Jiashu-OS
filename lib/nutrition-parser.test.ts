import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { validAssistantText } from './health-assistant-chat.ts';
import { shanghaiDay } from './health.ts';
import type { FoodItem } from './food-catalog.ts';
import type { NutritionDraft, NutritionParserRequest } from './nutrition-parser.ts';

function fixture(foods: FoodItem[] = []) {
  const calculations: Array<{ id: string; amount: number; unit: string }> = [];
  const source = stripTypeScriptTypes(readFileSync(new URL('./nutrition-parser.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const rules = new Function('searchFoods', 'calculateFoodSelection', 'validAssistantText', 'shanghaiDay', source + '\nreturn {parseNutritionParserRequest,buildNutritionDrafts,NutritionParserError};')(
    () => foods,
    (selection: { id: string; amount: number; unit: string }) => {
      calculations.push(selection);
      if (!['g', '克', '公克'].includes(selection.unit)) throw new Error('Unsupported portion');
      const food = foods.find((food) => food.id === selection.id)!;
      if (typeof food.kcalPer100g !== 'number') throw new Error('This fixture accepts weighed food only');
      return { caloriesTenth: Math.round(food.kcalPer100g * selection.amount / 10), grams: selection.amount, estimated: false,
        ...Object.fromEntries((['carbs', 'protein', 'fat'] as const).filter((key) => food[`${key}Per100g`] !== undefined)
          .map((key) => [`${key}Tenth`, Math.round(food[`${key}Per100g`]! * selection.amount / 10)])) };
    }, validAssistantText, shanghaiDay,
  ) as {
    parseNutritionParserRequest(raw: unknown, now?: number): NutritionParserRequest;
    buildNutritionDrafts(answer: string, request: NutritionParserRequest): { drafts: NutritionDraft[]; warnings: string[] };
  };
  return { ...rules, calculations };
}
const now = Date.parse('2026-11-11T16:01:00Z'); // Shanghai is already November 12.
const base = { text: '昨天午饭吃了150克熟米饭', date: '2026-11-10', today: '2026-11-12', meal: null } satisfies NutritionParserRequest;
const item = (patch: Record<string, unknown> = {}) => ({ name: '熟米饭', amount: 150, unit: '克', meal: 'lunch', dateText: '昨天', sourceText: '150克熟米饭', ...patch });
const answer = (...items: Record<string, unknown>[]) => JSON.stringify({ items });
const cooked = { id: 'synthetic-cooked-rice', name: '熟米饭', aliases: ['白饭'], category: '谷物', state: '熟制', kcalPer100g: 100,
  source: { name: 'Synthetic fixture', url: 'https://food-fixture.example', recordId: '1', version: 'test' }, portions: [] } satisfies FoodItem;

test('requests validate the entire input, use Shanghai today and preserve explicit defaults', () => {
  const f = fixture();
  assert.deepEqual(f.parseNutritionParserRequest({ text: '  吃了一个苹果  ', date: '2026-11-11', meal: 'snack' }, now),
    { text: '吃了一个苹果', date: '2026-11-11', today: '2026-11-12', meal: 'snack' });
  assert.equal(f.parseNutritionParserRequest({ text: '苹果', date: '2026-11-12' }, now).meal, null);
  for (const bad of [null, [], {}, { text: '鸡蛋', date: '2026-02-30' }, { text: '鸡蛋', date: '2026-11-13' },
    { text: 'x'.repeat(2001), date: '2026-11-11' }, { text: '鸡蛋', date: '2026-11-11', meal: 'other' },
    { text: '鸡蛋', date: '2026-11-11', userId: 'someone-else' }, { text: 'x\u0000', date: '2026-11-11' }]) {
    assert.throws(() => f.parseNutritionParserRequest(bad, now));
  }
});

test('an exact unique cooked-food match is calculated locally, and relative dates use Shanghai today', () => {
  const f = fixture([cooked]);
  const result = f.buildNutritionDrafts(answer(item()), base);
  assert.equal(result.drafts.length, 1);
  assert.deepEqual(result.drafts[0].food, { id: cooked.id, amount: 150, unit: '克' });
  assert.equal(result.drafts[0].calories, '150.0');
  assert.equal(result.drafts[0].date, '2026-11-11');
  assert.equal(result.drafts[0].meal, 'lunch');
  assert.deepEqual(f.calculations, [{ id: cooked.id, amount: 150, unit: '克' }]);
});

test('unknown food, missing amounts and unsupported bowls remain editable with unknown calories', () => {
  const unknown = fixture().buildNutritionDrafts(answer(item()), base).drafts[0];
  assert.equal(unknown.food, null); assert.equal(unknown.calories, null); assert.match(unknown.warnings.join(' '), /暂未找到/);
  assert.equal(unknown.amount, 150); assert.equal(unknown.unit, '克');
  const f = fixture([cooked]);
  const bowlRequest = { ...base, text: '昨天午饭吃了一碗熟米饭' };
  const bowl = f.buildNutritionDrafts(answer(item({ amount: 1, unit: '碗', sourceText: '一碗熟米饭' })), bowlRequest).drafts[0];
  assert.equal(bowl.food, null); assert.equal(bowl.calories, null); assert.match(bowl.warnings.join(' '), /改填克重/);
  assert.equal(bowl.amount, 1); assert.equal(bowl.unit, '碗');
  const noAmount = f.buildNutritionDrafts(answer(item({ amount: null, unit: null, meal: null, dateText: null, sourceText: '熟米饭' })), { ...base, text: '吃了熟米饭' }).drafts[0];
  assert.equal(noAmount.food, null); assert.equal(noAmount.meal, null); assert.equal(noAmount.date, base.date);
  assert.equal(noAmount.amount, null); assert.equal(noAmount.unit, null);
  assert.match(noAmount.warnings.join(' '), /餐次/); assert.match(noAmount.warnings.join(' '), /份量/);
});

test('unknown foods and unsupported portions get editable AI estimates with persistent assumptions', () => {
  const estimate = { calories: 420, portion: '2个中等肉包子（按每个约80g估算）', basis: '按常见猪肉包子的面皮、肉馅和用油估算' };
  const request = { ...base, text: '今天早上吃了2个肉包子' };
  const draft = fixture().buildNutritionDrafts(answer(item({ name: '肉包子', amount: 2, unit: '个',
    meal: 'breakfast', dateText: '今天早上', sourceText: '2个肉包子', estimate })), request).drafts[0];
  assert.equal(draft.calories, '420.0'); assert.equal(draft.calorieSource, 'ai'); assert.equal(draft.food, null);
  assert.equal(draft.portion, estimate.portion); assert.equal(draft.amount, 2); assert.equal(draft.unit, '个');
  assert.match(draft.note, /^AI 估算：/); assert.ok(draft.note.includes(estimate.basis));
  assert.match(draft.warnings.join(' '), /核对后保存/);
  const bowl = fixture([cooked]).buildNutritionDrafts(answer(item({ amount: 1, unit: '碗', sourceText: '一碗熟米饭',
    estimate: { calories: 180, portion: '1碗（按熟米饭180g估算）', basis: '按普通饭碗估算' } })),
  { ...base, text: '昨天午饭吃了一碗熟米饭' }).drafts[0];
  assert.equal(bowl.calories, '180.0'); assert.equal(bowl.calorieSource, 'ai'); assert.equal(bowl.food, null);
});

test('catalog calculations take precedence and inferred portions never become measured quantities', () => {
  const f = fixture([cooked]);
  const exact = f.buildNutritionDrafts(answer(item({ estimate: { calories: 999, portion: '150克', basis: '模型参考估算' } })), base).drafts[0];
  assert.equal(exact.calories, '150.0'); assert.equal(exact.calorieSource, 'catalog'); assert.equal(exact.note, '');
  const inferred = f.buildNutritionDrafts(answer(item({ amount: null, unit: null, dateText: null, sourceText: '熟米饭',
    estimate: { calories: 180, portion: '按1碗熟米饭180g估算', basis: '未提供份量，按普通饭碗估算' } })),
  { ...base, text: '吃了熟米饭' }).drafts[0];
  assert.equal(inferred.amount, null); assert.equal(inferred.unit, null); assert.equal(inferred.food, null);
  assert.equal(inferred.calories, '180.0'); assert.match(inferred.note, /未提供份量/);
});

test('estimate boundaries preserve real zero and unknown while rejecting malformed or unsafe values', () => {
  const f = fixture();
  const estimate = { calories: 0, portion: '1杯白水', basis: '无热量饮水' };
  assert.equal(f.buildNutritionDrafts(answer(item({ estimate })), base).drafts[0].calories, '0.0');
  assert.equal(f.buildNutritionDrafts(answer(item({ estimate: { ...estimate, calories: 20000 } })), base).drafts[0].calories, '20000.0');
  const unknown = f.buildNutritionDrafts(answer(item({ estimate: null })), base).drafts[0];
  assert.equal(unknown.calories, null); assert.equal(unknown.calorieSource, null);
  assert.match(unknown.warnings.join(' '), /重新识别/);
  for (const value of [-1, 20000.1, '120', null, {}, true]) {
    assert.throws(() => f.buildNutritionDrafts(answer(item({ estimate: { ...estimate, calories: value } })), base));
  }
  for (const value of [[], {}, { ...estimate, portion: '' }, { ...estimate, basis: 'x'.repeat(201) },
    { ...estimate, portion: '1\u0000份' }, { ...estimate, foodId: 'forged' }]) {
    assert.throws(() => f.buildNutritionDrafts(answer(item({ estimate: value })), base));
  }
});

test('AI drafts expose total-portion carbohydrate, protein and fat grams with explicit source attribution', () => {
  const estimate = { calories: 420, carbs: 50.5, protein: 22, fat: 14.3,
    portion: '2个肉包子（每个约80g）', basis: '按常见面皮和肉馅估算，实际用油未知' };
  const draft = fixture().buildNutritionDrafts(answer(item({ estimate })), base).drafts[0];
  assert.equal(draft.carbs, '50.5'); assert.equal(draft.protein, '22.0'); assert.equal(draft.fat, '14.3');
  assert.deepEqual(draft.macroSources, { carbs: 'ai', protein: 'ai', fat: 'ai' });
  assert.equal(draft.calories, '420.0'); assert.equal(draft.calorieSource, 'ai');
  assert.match(draft.note, /碳水化合物、蛋白质、脂肪也为 AI 估算/);
  assert.match(draft.warnings.join(' '), /当前食用份量的合计克数/);
});

test('catalog macros override estimates individually while absent source fields retain labeled AI fallbacks', () => {
  const estimate = { calories: 420, carbs: 999, protein: 18, fat: 999, portion: '150克熟米饭', basis: '按描述份量估算' };
  const f = fixture([{ ...cooked, carbsPer100g: 24, fatPer100g: 0 }]);
  const draft = f.buildNutritionDrafts(answer(item({ estimate })), base).drafts[0];
  assert.equal(draft.carbs, '36.0'); assert.equal(draft.protein, '18.0'); assert.equal(draft.fat, '0.0');
  assert.deepEqual(draft.macroSources, { carbs: 'catalog', protein: 'ai', fat: 'catalog' });
  assert.equal(draft.calories, '150.0'); assert.equal(draft.calorieSource, 'catalog');
  assert.match(draft.note, /^AI 营养估算：蛋白质；/);
  assert.equal(draft.note.includes('碳水化合物'), false); assert.equal(draft.note.includes('脂肪'), false);
  const catalogOnly = f.buildNutritionDrafts(answer(item()), base).drafts[0];
  assert.equal(catalogOnly.protein, null); assert.equal(catalogOnly.macroSources.protein, null);
  assert.equal(catalogOnly.note, '');
});

test('unknown macro fields remain null, real zeros survive and malformed gram estimates are rejected', () => {
  const f = fixture();
  const estimate = { calories: 0, carbs: 0, protein: null, fat: 20000, portion: '按原文份量', basis: '合成边界测试' };
  const draft = f.buildNutritionDrafts(answer(item({ estimate })), base).drafts[0];
  assert.equal(draft.carbs, '0.0'); assert.equal(draft.protein, null); assert.equal(draft.fat, '20000.0');
  assert.equal(draft.macroSources.protein, null); assert.match(draft.warnings.join(' '), /蛋白质暂未提供/);
  const legacy = f.buildNutritionDrafts(answer(item({ estimate: { calories: 120, portion: '150克', basis: '旧模型估算' } })), base).drafts[0];
  assert.equal(legacy.carbs, null); assert.equal(legacy.protein, null); assert.equal(legacy.fat, null);
  assert.deepEqual(legacy.macroSources, { carbs: null, protein: null, fat: null });
  for (const key of ['carbs', 'protein', 'fat']) {
    for (const value of [-0.1, 20000.1, '12', true, [], {}]) {
      assert.throws(() => f.buildNutritionDrafts(answer(item({ estimate: { ...estimate, [key]: value } })), base), key + ':' + String(value));
    }
    const nonfinite = answer(item({ estimate: { ...estimate, [key]: 'NONFINITE' } })).replace('"NONFINITE"', '1e1000');
    assert.throws(() => f.buildNutritionDrafts(nonfinite, base), key + ':infinity');
  }
});

test('natural date phrases accept grounded time-of-day suffixes and preserve Shanghai-relative dates', () => {
  const f = fixture([cooked]);
  const cases = [
    ['今天早上', '2026-11-12', 'breakfast'], ['今日上午', '2026-11-12', 'breakfast'],
    ['今儿的早晨', '2026-11-12', 'breakfast'], ['今晚', '2026-11-12', 'dinner'],
    ['昨天中午', '2026-11-11', 'lunch'], ['昨日下午', '2026-11-11', null],
    ['前天晚上', '2026-11-10', 'dinner'], ['大前天的早餐', '2026-11-09', 'breakfast'],
    ['2026年11月11日早上', '2026-11-11', 'breakfast'], ['2026/11/11中午', '2026-11-11', 'lunch'],
    ['2026-11-11晚上', '2026-11-11', 'dinner'], ['11月11日上午', '2026-11-11', 'breakfast'],
    ['11-11的晚餐', '2026-11-11', 'dinner'], ['2024年2月29日晚上', '2024-02-29', 'dinner'],
    ['早上', base.date, 'breakfast'],
  ] as const;
  for (const [dateText, date, meal] of cases) {
    const draft = f.buildNutritionDrafts(answer(item({ dateText, meal: null })), { ...base, text: dateText + '吃了150克熟米饭' }).drafts[0];
    assert.equal(draft.date, date, dateText); assert.equal(draft.meal, meal, dateText);
    assert.equal(draft.amount, 150); assert.equal(draft.calories, '150.0');
  }
  const beforeMidnight = f.parseNutritionParserRequest({ text: '今天早上吃了150克熟米饭', date: '2026-11-10' }, Date.parse('2026-11-11T15:59:00Z'));
  assert.equal(f.buildNutritionDrafts(answer(item({ dateText: '今天早上', meal: null })), beforeMidnight).drafts[0].date, '2026-11-11');
});

test('date normalization still rejects ambiguous, ungrounded, invalid-calendar and future dates', () => {
  const f = fixture();
  for (const dateText of ['昨天或今天早上', '今天以后', '2026年2月30日早上', '2026-13-01晚餐', '明天早上', '后天的午餐', '2026-11-13下午']) {
    assert.throws(() => f.buildNutritionDrafts(answer(item({ dateText })), { ...base, text: dateText + '吃了150克熟米饭' }), dateText);
  }
  assert.throws(() => f.buildNutritionDrafts(answer(item({ dateText: '2026-11-12' })), { ...base, text: '今天早上吃了150克熟米饭' }));
  assert.throws(() => f.buildNutritionDrafts(answer(item({ dateText: '昨天早上' })), { ...base, text: '今天早上吃了150克熟米饭' }));
});

test('meal inference uses item evidence and leaves a multiple-meal sentence ambiguous without it', () => {
  const f = fixture([cooked]);
  const text = '今天早上吃了150克熟米饭，中午吃了一个苹果';
  const ambiguous = f.buildNutritionDrafts(answer(item({ dateText: '今天', meal: null })), { ...base, text }).drafts[0];
  assert.equal(ambiguous.meal, null);
  const mixed = f.buildNutritionDrafts(answer(item({ dateText: '今天', meal: null })), { ...base, text: '今天早餐吃了150克熟米饭，中午吃了一个苹果' }).drafts[0];
  assert.equal(mixed.meal, null);
  const local = f.buildNutritionDrafts(answer(item({ dateText: '今天早上', meal: null, sourceText: '今天早上吃了150克熟米饭' })), { ...base, text }).drafts[0];
  assert.equal(local.meal, 'breakfast');
  const selected = f.buildNutritionDrafts(answer(item({ dateText: null, meal: null })), { ...base, text: '吃了150克熟米饭', meal: 'snack' }).drafts[0];
  assert.equal(selected.date, base.date); assert.equal(selected.meal, 'snack');
});

test('ambiguous aliases or discarded cooking methods never silently select a food', () => {
  const ambiguous = fixture([cooked, { ...cooked, id: 'other-rice' }]);
  assert.equal(ambiguous.buildNutritionDrafts(answer(item()), base).drafts[0].food, null);
  assert.equal(ambiguous.calculations.length, 0);
  const rawChicken = { ...cooked, id: 'raw-chicken', name: '鸡胸肉', aliases: [], state: '生鲜' };
  const f = fixture([rawChicken]);
  const request = { ...base, text: '午饭吃了150克煎鸡胸肉' };
  const discarded = f.buildNutritionDrafts(answer(item({ name: '鸡胸肉', sourceText: '150克煎鸡胸肉', dateText: null })), request).drafts[0];
  assert.equal(discarded.food, null); assert.equal(discarded.calories, null); assert.equal(f.calculations.length, 0);
});

test('model structure, count, dates and original evidence are strictly bounded, and calories cannot be supplied', () => {
  const f = fixture([cooked]);
  for (const raw of ['```json\n{"items":[]}\n```', JSON.stringify({ items: [], calories: 5 }), JSON.stringify({ items: Array(21).fill(item()) }),
    answer(item({ calories: 999 })), answer(item({ sourceText: '并未出现的食物' })), answer(item({ amount: -1 })),
    answer(item({ amount: '150' })), answer(item({ unit: '\u0000' })), answer(item({ dateText: '2025-01-01' })), answer(item({ meal: 'system' }))]) {
    assert.throws(() => f.buildNutritionDrafts(raw, base));
  }
  assert.throws(() => f.buildNutritionDrafts(answer(item({ dateText: '明天' })), { ...base, text: '明天吃150克熟米饭' }), /不能晚于今天/);
  assert.deepEqual(f.buildNutritionDrafts('{"items":[]}', base).drafts, []);
});
