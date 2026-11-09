import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWeightPlanReview, parseWeightPlanInput, WeightPlanValidationError } from './weight-plan.ts';
import type { WeightPlanSettings } from './weight-plan.ts';
import type { HealthMeasurement } from './health.ts';

const NOW = new Date('2026-11-11T08:00:00Z');
function input(patch: Record<string, unknown> = {}) {
  return { baselineWeight: 80, targetWeight: 70, startDate: '2026-11-01', deadline: '2026-11-21', enabled: true, ...patch };
}
function settings(patch: Partial<WeightPlanSettings> = {}): WeightPlanSettings {
  return { ...parseWeightPlanInput(input(), NOW), createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...patch };
}
function weight(id: string, at: string, value: number): HealthMeasurement {
  return { id, metric: 'weight', value, unit: 'kg', startDate: at, aggregation: 'sample', source: 'synthetic-scale' };
}
const observed = [weight('a', '2026-11-09T07:00:00+08:00', 76), weight('b', '2026-11-10T07:00:00+08:00', 74)];

void test('observations remain available with no configured plan and while a saved plan is disabled', () => {
  const unset = buildWeightPlanReview(null, observed, NOW);
  assert.equal(unset.settings, null);
  assert.equal(unset.progress, null);
  assert.equal(unset.observations.latestWeight, 74);
  assert.equal(unset.observations.latestDate, '2026-11-10');
  assert.equal(unset.observations.average7, 75);
  const disabled = buildWeightPlanReview(settings({ enabled: false }), observed, NOW);
  assert.equal(disabled.progress, null);
  assert.equal(disabled.settings!.enabled, false);
  assert.deepEqual(disabled.observations, unset.observations);
});

void test('seven-day means count actual daily last observations rather than samples or missing days', () => {
  const output = buildWeightPlanReview(settings(), [
    weight('morning', '2026-11-09T07:00:00+08:00', 60),
    ...observed, weight('window-start', '2026-11-05T07:00:00+08:00', 75),
    weight('outside-seven', '2026-11-04T07:00:00+08:00', 100),
  ], NOW);
  assert.equal(output.observations.recordedDays7, 3);
  assert.equal(output.observations.average7, 75);
  assert.deepEqual(output.observations.points.map((point) => point.value), [100, 75, 76, 74]);
  assert.equal(output.progress!.progressPercent, 50);
  assert.equal(output.progress!.gapKg, 5);
});

void test('future samples are filtered before choosing the last daily value and Shanghai days determine the rolling window', () => {
  const output = buildWeightPlanReview(settings(), [
    weight('valid-today', '2026-11-11T07:00:00+08:00', 75),
    weight('future-tonight', '2026-11-11T23:00:00+08:00', 99),
    weight('tomorrow', '2026-11-12T07:00:00+08:00', 100),
    weight('before-utc-boundary', '2026-11-09T15:59:00Z', 74),
    weight('after-utc-boundary', '2026-11-09T16:01:00Z', 76),
  ], NOW);
  assert.deepEqual(output.observations.points, [
    { day: '2026-11-09', value: 74 }, { day: '2026-11-10', value: 76 }, { day: '2026-11-11', value: 75 },
  ]);
  assert.equal(output.observations.latestWeight, 75);
  assert.equal(output.observations.average7, 75);
  assert.equal(buildWeightPlanReview(null, [], new Date('2026-11-09T16:00:00Z')).today, '2026-11-10');
});

void test('older latest observations keep their dates but cannot substitute for an empty recent mean', () => {
  const result = buildWeightPlanReview(settings(), [weight('old', '2026-10-20T07:00:00+08:00', 75)], NOW);
  assert.equal(result.observations.latestWeight, 75);
  assert.equal(result.observations.latestDate, '2026-10-20');
  assert.equal(result.observations.average7, null);
  assert.equal(result.observations.recordedDays7, 0);
  assert.equal(result.progress!.gapKg, null);
  assert.equal(result.progress!.progressPercent, null);
  assert.equal(result.progress!.status, 'missing');
  assert.equal(result.progress!.referenceWeight, 75, 'plan reference remains a calendar guide, independent of observations');
  const tooOld = buildWeightPlanReview(null, [weight('very-old', '2025-01-01T07:00:00+08:00', 75)], NOW);
  assert.equal(tooOld.observations.latestWeight, null);
  assert.deepEqual(tooOld.observations.points, []);
});

void test('loss and gain progress follows the chosen direction, clamps reverse movement and recognizes passing the target', () => {
  const loss = buildWeightPlanReview(settings(), observed, NOW).progress!;
  assert.equal(loss.direction, 'loss');
  assert.equal(loss.progressPercent, 50);
  assert.equal(loss.status, 'active');
  const gainSettings = settings({ baselineWeight: 60, targetWeight: 70 });
  const gain = buildWeightPlanReview(gainSettings, [weight('gain', '2026-11-10T07:00:00+08:00', 65)], NOW).progress!;
  assert.equal(gain.direction, 'gain');
  assert.equal(gain.progressPercent, 50);
  assert.equal(gain.gapKg, 5);
  for (const [plan, value, expectedPercent, expectedStatus] of [
    [settings(), 85, 0, 'active'], [settings(), 69, 100, 'achieved'],
    [gainSettings, 55, 0, 'active'], [gainSettings, 71, 100, 'achieved'],
  ] as const) {
    const result = buildWeightPlanReview(plan, [weight('test', '2026-11-10T07:00:00+08:00', value)], NOW).progress!;
    assert.equal(result.progressPercent, expectedPercent);
    assert.equal(result.status, expectedStatus);
    if (expectedStatus === 'achieved') assert.equal(result.gapKg, 0);
  }
});

void test('maintaining an equal baseline and target shows deviation without dividing by zero or claiming completion', () => {
  const result = buildWeightPlanReview(settings({ baselineWeight: 70, targetWeight: 70 }), [weight('maintain', '2026-11-10T07:00:00+08:00', 71)], NOW).progress!;
  assert.equal(result.direction, 'maintain');
  assert.equal(result.gapKg, 1);
  assert.equal(result.progressPercent, null);
  assert.equal(result.referenceWeight, 70);
  assert.equal(result.status, 'active');
});

void test('reference weights follow a clamped calendar line and completed deadlines show their end rather than a forecast', () => {
  const middle = buildWeightPlanReview(settings(), [], NOW).progress!;
  assert.equal(middle.referenceWeight, 75);
  assert.equal(middle.remainingDays, 10);
  assert.deepEqual(middle.referencePoints, [{ day: '2026-11-01', value: 80 }, { day: '2026-11-21', value: 70 }]);
  const start = buildWeightPlanReview(settings({ startDate: '2026-11-11' }), [], NOW).progress!;
  assert.equal(start.referenceWeight, 80);
  const ended = buildWeightPlanReview(settings({ deadline: '2026-11-10' }), observed, NOW).progress!;
  assert.equal(ended.referenceWeight, 70);
  assert.equal(ended.remainingDays, 0);
  assert.equal(ended.status, 'ended');
  const leap = buildWeightPlanReview(settings({ startDate: '2024-02-28', deadline: '2024-03-01' }), [], new Date('2024-02-29T08:00:00+08:00')).progress!;
  assert.equal(leap.referenceWeight, 75);
  assert.equal(leap.remainingDays, 1);
});

void test('settings require finite supported weights, full explicit fields and valid ordered dates without future starts', () => {
  assert.deepEqual(parseWeightPlanInput(input({ baselineWeight: 10, targetWeight: 600, enabled: false }), NOW), input({ baselineWeight: 10, targetWeight: 600, enabled: false }));
  assert.equal(parseWeightPlanInput(input({ deadline: '2026-11-02' }), NOW).deadline, '2026-11-02', 'a finished historical plan is valid');
  for (const patch of [
    { baselineWeight: 9.9 }, { targetWeight: 600.1 }, { baselineWeight: '80' }, { targetWeight: NaN }, { targetWeight: Infinity },
    { startDate: '2026-11-12' }, { deadline: '2026-11-01' }, { deadline: '2026-10-31' },
    { startDate: '2026-02-30' }, { deadline: '2100-02-29' }, { deadline: '2101-01-01' },
    { startDate: '2026-11-01\n' }, { enabled: undefined }, { enabled: 1 }, { unit: 'lb' },
  ]) assert.throws(() => parseWeightPlanInput(input(patch), NOW), WeightPlanValidationError);
  for (const raw of [null, [], {}, { baselineWeight: 80, targetWeight: 70 }]) assert.throws(() => parseWeightPlanInput(raw, NOW), WeightPlanValidationError);
});
