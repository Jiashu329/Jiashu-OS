import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import luckin from '../data/food-catalog-releases/luckin-cn-2026-11-13-v1.json' with { type: 'json' };
import { createDrinkConfigurationRuntime, drinkConfiguration, readDrinkConfigurationQuery, resolveDrinkConfiguration, type DrinkConfigurationFood } from './drink-configuration.ts';

const latte = luckin.foods.find((food) => food.id === 'luckin-cn:1')!;

test('official drink configurations preserve each published cup, temperature, sugar and remaining source tokens', () => {
  for (const food of luckin.foods) {
    const model = drinkConfiguration(food);
    assert.equal(model.supported, true); assert.equal(model.completeOfficial, true, food.id);
    const result = resolveDrinkConfiguration(food, model.defaults);
    assert.equal(result.matchesOfficial, true, food.id); assert.equal(result.nutritionAvailable, true, food.id);
    assert.equal(result.label, food.serving.label);
    assert.equal(Object.hasOwn(result, 'kcal'), false, 'selection cannot invent or replace official energy values');
  }
  const selected = resolveDrinkConfiguration(latte, drinkConfiguration(latte).defaults);
  assert.match(selected.label, /埃塞金烘\/默认浓度/);
});

test('temperature and sugar changes lose official nutrition and an explicit empty choice never means the default', () => {
  const model = drinkConfiguration(latte);
  for (const change of [{ temperature: '热' }, { sweetness: '全糖' }, { cup: '超大杯' }, { sweetness: '' }]) {
    const result = resolveDrinkConfiguration(latte, { ...model.defaults, ...change });
    assert.equal(result.matchesOfficial, false); assert.equal(result.nutritionAvailable, false);
    assert.match(result.note, /暂无此配置官方营养/);
    assert.match(result.label, /埃塞金烘\/默认浓度/);
  }
});

test('16oz and full-ice-without-water remain exact official tokens rather than guessed large cold cups', () => {
  const special = luckin.foods.find((food) => food.id === 'luckin-cn:26')!;
  const model = drinkConfiguration(special);
  assert.equal(model.defaults.cup, '16oz'); assert.equal(model.defaults.temperature, '全冰去水');
  assert.equal(resolveDrinkConfiguration(special, model.defaults).nutritionAvailable, true);
  assert.equal(resolveDrinkConfiguration(special, { ...model.defaults, cup: '大杯' }).nutritionAvailable, false);
  assert.equal(resolveDrinkConfiguration(special, { ...model.defaults, temperature: '冰' }).nutritionAvailable, false);
  assert.match(resolveDrinkConfiguration(special, model.defaults).label, /意式拼配\/短萃浓缩/);
});

test('unknown energy, incomplete configuration and conflicting source fields remain unknown, while real zero is valid', () => {
  for (const product of luckin.products) {
    const model = drinkConfiguration(product);
    assert.equal(resolveDrinkConfiguration(product, model.defaults).nutritionAvailable, false);
  }
  const noLabel = luckin.products.find((food) => food.id === 'luckin-cn:49')!;
  const missing = drinkConfiguration(noLabel);
  assert.equal(missing.label, null); assert.equal(missing.completeOfficial, false);
  assert.deepEqual(missing.defaults, { cup: '', temperature: '', sweetness: '' });
  const incomplete: DrinkConfigurationFood = { ...latte, serving: { label: '大杯/冰/牛奶', kcal: 0 } };
  assert.equal(resolveDrinkConfiguration(incomplete, drinkConfiguration(incomplete).defaults).nutritionAvailable, false);
  const conflict: DrinkConfigurationFood = { ...latte, serving: { label: '大杯/冰/热/不另外加糖', kcal: 0 } };
  assert.equal(drinkConfiguration(conflict).completeOfficial, false);
  assert.equal(resolveDrinkConfiguration(conflict, { ...drinkConfiguration(conflict).defaults, temperature: '冰' }).label, '大杯/冰/不另外加糖');
  const zero = { ...latte, serving: { ...latte.serving, kcal: 0 } };
  assert.equal(resolveDrinkConfiguration(zero, drinkConfiguration(zero).defaults).nutritionAvailable, true);
});

test('URL choices require all three fields once and reject injected or unsupported values', () => {
  assert.equal(readDrinkConfigurationQuery(latte, new URLSearchParams('food=luckin-cn:1')), null);
  const selection = drinkConfiguration(latte).defaults;
  assert.deepEqual(readDrinkConfigurationQuery(latte, new URLSearchParams(Object.entries(selection))), selection);
  for (const query of ['cup=大杯', 'cup=大杯&temperature=冰&sweetness=全糖&cup=超大杯', 'cup=100L&temperature=冰&sweetness=全糖', 'cup=大杯&temperature=<script>&sweetness=全糖']) {
    assert.throws(() => readDrinkConfigurationQuery(latte, new URLSearchParams(query)));
  }
  assert.throws(() => resolveDrinkConfiguration(latte, { ...selection, extra: 'not-supported' }));
  assert.throws(() => resolveDrinkConfiguration({ id: 'mcd-cn:49:28' }, selection));
  assert.equal(drinkConfiguration({ id: 'luckin-cn:1:forged' }).supported, false);
});

test('the serialized runtime retains its exact rules without any module closure references', () => {
  const output = runInNewContext('const api=(' + createDrinkConfigurationRuntime.toString() + ')();JSON.stringify(api.resolve(food,{...api.model(food).defaults,temperature:"热"}));', { food: latte });
  const result = JSON.parse(output) as { nutritionAvailable: boolean; label: string };
  assert.equal(result.nutritionAvailable, false); assert.match(result.label, /热/);
});
