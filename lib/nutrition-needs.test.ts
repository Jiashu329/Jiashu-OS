import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateNutritionNeeds, parseNutritionNeedsInput, type NutritionNeedsInput } from './nutrition-needs.ts';
import { NutritionValidationError } from './nutrition.ts';

const BASE: NutritionNeedsInput = { age: 30, heightCm: 175, weightKg: 70, sex: 'male', activity: 'sedentary', goal: 'maintain' };
const profile = (patch: Partial<NutritionNeedsInput> = {}): NutritionNeedsInput => ({ ...BASE, ...patch });
function invalid(patch: Record<string, unknown>, path?: string) {
  assert.throws(() => parseNutritionNeedsInput({ ...BASE, ...patch }), (error: unknown) => {
    assert.ok(error instanceof NutritionValidationError);
    if (path) assert.equal(error.issues[0].path, path);
    return true;
  });
}

void test('Mifflin rounded formula uses the selected sex coefficient and preserves raw values until output rounding', () => {
  const male = calculateNutritionNeeds(BASE);
  assert.equal(male.bmr, 1649); // raw 1648.75
  assert.equal(male.maintenanceCalories, 1979); // raw 1978.5, not rounded BMR * 1.2
  assert.equal(male.targets.calories, '1979.0');
  assert.equal(male.activityMultiplier, 1.2);
  assert.equal(male.bmi, 22.9);
  assert.equal(male.method, 'mifflin-st-jeor-rounded');
  const female = calculateNutritionNeeds(profile({ sex: 'female' }));
  assert.equal(female.bmr, 1483);
  assert.equal(female.maintenanceCalories, 1779);
  assert.equal(female.targets.calories, '1779.0');
});

void test('activity choices change maintenance expenditure without changing resting metabolism', () => {
  const expected = { sedentary: [1.2, 1979], light: [1.375, 2267], moderate: [1.55, 2556], active: [1.725, 2844], veryActive: [1.9, 3133] };
  for (const [activity, [multiplier, calories]] of Object.entries(expected)) {
    const result = calculateNutritionNeeds(profile({ activity: activity as NutritionNeedsInput['activity'] }));
    assert.equal(result.bmr, 1649);
    assert.equal(result.activityMultiplier, multiplier);
    assert.equal(result.maintenanceCalories, calories);
  }
});

void test('goal adjustments are conservative and all macros derive from the same target calories', () => {
  const loss = calculateNutritionNeeds(profile({ goal: 'lose' }));
  assert.equal(loss.goalAdjustmentPercent, -10);
  assert.equal(loss.effectiveAdjustmentPercent, -10);
  assert.equal(loss.targets.calories, '1781.0');
  assert.deepEqual(loss.targets, { calories: '1781.0', carbs: '222.6', protein: '89.1', fat: '59.4' });
  assert.equal(loss.floorApplied, false);
  assert.equal(calculateNutritionNeeds(profile({ goal: 'gain' })).targets.calories, '2077.0');
  assert.equal(calculateNutritionNeeds(profile({ goal: 'gain' })).goalAdjustmentPercent, 5);
  for (const sex of ['male', 'female'] as const) {
    for (const activity of ['sedentary', 'light', 'moderate', 'active', 'veryActive'] as const) {
      for (const goal of ['maintain', 'lose', 'gain'] as const) {
        const result = calculateNutritionNeeds(profile({ sex, activity, goal }));
        const { calories, carbs, protein, fat } = result.targets;
        const energy = Number(carbs) * 4 + Number(protein) * 4 + Number(fat) * 9;
        assert.ok(Math.abs(energy - Number(calories)) <= 0.85, 'only one-decimal gram rounding can separate macro energy and target');
        assert.deepEqual(result.macroEnergyPercent, { carbs: 50, protein: 20, fat: 30 });
        assert.ok(Number(calories) >= result.bmr);
        for (const value of Object.values(result.targets)) assert.match(value, /^\d+\.\d$/);
      }
    }
  }
});

void test('a low but applicable maintenance estimate can reduce the loss deficit without reversing the goal', () => {
  const result = calculateNutritionNeeds(profile({ sex: 'female', age: 50, heightCm: 150, weightKg: 50, goal: 'lose' }));
  assert.equal(result.maintenanceCalories, 1232);
  assert.equal(result.targets.calories, '1200.0');
  assert.equal(result.minimumCalories, 1200);
  assert.equal(result.floorApplied, true);
  assert.equal(result.effectiveAdjustmentPercent, -2.6);
  assert.ok(Number(result.targets.calories) <= result.maintenanceCalories);
  assert.ok(result.warnings.some((warning) => warning.includes('护栏')));
});

void test('unsupported low-maintenance combinations reject rather than invent a maintain or loss target', () => {
  for (const goal of ['maintain', 'lose', 'gain'] as const) {
    assert.throws(() => calculateNutritionNeeds(profile({ age: 70, heightCm: 150, weightKg: 60, goal })), /适用下限/);
  }
  assert.throws(() => calculateNutritionNeeds(profile({ sex: 'female', age: 80, heightCm: 120, weightKg: 30 })), /适用下限/);
});

void test('underweight loss is rejected using unrounded BMI while maintain/gain stay labelled estimates', () => {
  assert.throws(() => calculateNutritionNeeds(profile({ heightCm: 180, weightKg: 59.9, goal: 'lose' })), /BMI低于18.5/);
  const maintain = calculateNutritionNeeds(profile({ heightCm: 180, weightKg: 59.9 }));
  assert.equal(maintain.bmi, 18.5, 'display rounding must not let a below-cutoff loss through');
  assert.ok(maintain.warnings.some((warning) => warning.includes('BMI低于18.5')));
  assert.doesNotThrow(() => calculateNutritionNeeds(profile({ heightCm: 180, weightKg: 60, goal: 'lose' })));
});

void test('strict schema rejects absent, extra, coerced, nonfinite and overprecision inputs', () => {
  for (const value of [null, [], 'profile', new Date(), Object.create({})]) assert.throws(() => parseNutritionNeedsInput(value), NutritionValidationError);
  invalid({ unused: 'arbitrary prompt' }, '$');
  invalid({ expectedRevision: 0 }, '$');
  for (const age of [undefined, '30', 17, 81, 30.1, NaN, Infinity]) invalid({ age }, 'age');
  for (const heightCm of [undefined, '175', 119.9, 230.1, NaN, Infinity, 175.01, 175.00000000000003]) invalid({ heightCm }, 'heightCm');
  for (const weightKg of [undefined, '70', 29.9, 250.1, NaN, -Infinity, 70.01]) invalid({ weightKg }, 'weightKg');
  for (const sex of [undefined, 'other', 'MALE', 1]) invalid({ sex }, 'sex');
  for (const activity of [undefined, 'high', 'toString', '__proto__']) invalid({ activity }, 'activity');
  for (const goal of [undefined, 'diet', 'constructor', '__proto__']) invalid({ goal }, 'goal');
});

void test('boundary profiles parse without coercion and runtime calculation independently validates its input', () => {
  assert.deepEqual(parseNutritionNeedsInput(BASE), BASE);
  assert.deepEqual(parseNutritionNeedsInput(Object.assign(Object.create(null), BASE)), BASE);
  for (const patch of [{ age: 18, heightCm: 120, weightKg: 30 }, { age: 80, heightCm: 230, weightKg: 250 }, { heightCm: 174.9, weightKg: 70.1 }]) {
    assert.deepEqual(parseNutritionNeedsInput({ ...BASE, ...patch }), { ...BASE, ...patch });
  }
  assert.throws(() => calculateNutritionNeeds({ ...BASE, activity: '__proto__' } as unknown as NutritionNeedsInput), NutritionValidationError);
  for (const age of [18, 79, 80]) assert.ok(calculateNutritionNeeds(profile({ age, weightKg: 80 })).warnings.some((warning) => warning.includes('19–78岁')));
});

void test('calculation does not mutate profile or shared provenance across users/requests', () => {
  const input = Object.freeze({ ...BASE });
  const first = calculateNutritionNeeds(input);
  first.sources[0].title = 'changed';
  first.warnings.push('changed');
  first.targets.calories = '0.0';
  const second = calculateNutritionNeeds(input);
  assert.equal(second.targets.calories, '1979.0');
  assert.ok(!second.sources.some((source) => source.title === 'changed'));
  assert.ok(!second.warnings.includes('changed'));
  assert.deepEqual(input, BASE);
});
