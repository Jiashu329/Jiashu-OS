import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBodyComposition } from './body-composition.ts';
import type { HealthMeasurement } from './health.ts';

let nextId = 0;
function sample(metric: 'weight' | 'lean_body_mass', value: number, startDate = '2026-11-09T07:30:00+08:00', source = 'selected-scale'): HealthMeasurement {
  return { id: 'composition-fixture-' + (++nextId), metric, value, unit: 'kg', aggregation: 'sample', startDate, source };
}
function pair(weight = 70, lean = 56, at = '2026-11-09T07:30:00+08:00', source = 'selected-scale') {
  return [sample('weight', weight, at, source), sample('lean_body_mass', lean, at, source)];
}

test('a same-source same-instant pair produces a read-only percentage, not another raw measurement', () => {
  const input = pair();
  const before = JSON.stringify(input);
  const result = buildBodyComposition(input);
  assert.deepEqual(result.latest, {
    day: '2026-11-09', value: 20, measuredAt: '2026-11-08T23:30:00.000Z',
    source: 'selected-scale', weight: 70, leanBodyMass: 56,
  });
  assert.deepEqual(result.points, [result.latest]);
  assert.equal(result.unmatchedWeightCount, 0);
  assert.equal(result.unmatchedLeanCount, 0);
  assert.equal(result.invalidPairCount, 0);
  assert.equal(JSON.stringify(input), before);
});

test('empty data and a missing side remain unknown rather than becoming a zero percentage', () => {
  assert.deepEqual(buildBodyComposition([]), {
    points: [], latest: null, unmatchedWeightCount: 0, unmatchedLeanCount: 0, invalidPairCount: 0,
  });
  const weightOnly = buildBodyComposition([sample('weight', 70)]);
  assert.equal(weightOnly.latest, null);
  assert.deepEqual(weightOnly.points, []);
  assert.equal(weightOnly.unmatchedWeightCount, 1);
  assert.equal(weightOnly.unmatchedLeanCount, 0);
  const leanOnly = buildBodyComposition([sample('lean_body_mass', 56)]);
  assert.equal(leanOnly.latest, null);
  assert.equal(leanOnly.unmatchedWeightCount, 0);
  assert.equal(leanOnly.unmatchedLeanCount, 1);
});

test('same-day, nearly simultaneous and different-source readings cannot be silently paired', () => {
  for (const input of [
    [sample('weight', 70), sample('lean_body_mass', 56, '2026-11-09T20:00:00+08:00')],
    [sample('weight', 70), sample('lean_body_mass', 56, '2026-11-09T07:30:00.001+08:00')],
    [sample('weight', 70), sample('lean_body_mass', 56, undefined, 'other-scale')],
    [sample('weight', 70), sample('lean_body_mass', 56, undefined, 'Selected-Scale')],
  ]) {
    const result = buildBodyComposition(input);
    assert.equal(result.latest, null);
    assert.deepEqual(result.points, []);
    assert.equal(result.unmatchedWeightCount, 1);
    assert.equal(result.unmatchedLeanCount, 1);
  }
});

test('different UTC offsets for the same instant pair and the reporting day uses Shanghai time', () => {
  const result = buildBodyComposition([
    sample('weight', 70, '2026-11-08T16:01:00Z'),
    sample('lean_body_mass', 56, '2026-11-09T00:01:00+08:00'),
    ...pair(80, 60, '2026-11-08T23:59:00+08:00'),
  ]);
  assert.deepEqual(result.points.map(({ day, value }) => ({ day, value })), [
    { day: '2026-11-08', value: 25 }, { day: '2026-11-09', value: 20 },
  ]);
  assert.equal(result.latest?.measuredAt, '2026-11-08T16:01:00.000Z');
});

test('daily trend uses the last valid pair while later unpaired values cannot contaminate it', () => {
  const input = [
    ...pair(70, 56, '2026-11-08T07:00:00+08:00'),
    ...pair(80, 60, '2026-11-09T07:00:00+08:00'),
    ...pair(75, 60, '2026-11-09T18:00:00+08:00'),
    sample('weight', 90, '2026-11-09T21:00:00+08:00'),
    sample('lean_body_mass', 45, '2026-11-09T22:00:00+08:00'),
  ];
  const result = buildBodyComposition(input);
  assert.equal(result.points.length, 2);
  assert.equal(result.latest?.value, 20);
  assert.equal(result.latest?.weight, 75);
  assert.equal(result.latest?.leanBodyMass, 60);
  assert.equal(result.latest?.measuredAt, '2026-11-09T10:00:00.000Z');
  assert.equal(result.unmatchedWeightCount, 1);
  assert.equal(result.unmatchedLeanCount, 1);
  assert.deepEqual(buildBodyComposition([...input].reverse()), result);
});

test('physically inconsistent and nonpositive pairs never create negative or invalid percentages', () => {
  for (const [weight, lean] of [[70, 71], [70, 0], [70, 0.5], [70, -1], [0, 56], [9.9, 5], [-70, 56], [601, 56], [70, NaN], [Infinity, 56]]) {
    const result = buildBodyComposition(pair(weight, lean));
    assert.equal(result.latest, null);
    assert.deepEqual(result.points, []);
    assert.equal(result.invalidPairCount, 1);
  }
  // Equality is mathematically zero, which must stay distinct from missing data.
  const zero = buildBodyComposition(pair(70, 70));
  assert.equal(zero.latest?.value, 0);
  assert.equal(zero.points.length, 1);
  assert.equal(zero.invalidPairCount, 0);
});

test('identical duplicate observations deduplicate independently of ID and timestamp representation', () => {
  const input = [
    ...pair(),
    sample('weight', 70, '2026-11-08T23:30:00Z'),
    sample('lean_body_mass', 56, '2026-11-08T23:30:00.000Z'),
  ];
  const result = buildBodyComposition(input);
  assert.equal(result.points.length, 1);
  assert.equal(result.latest?.value, 20);
  assert.equal(result.invalidPairCount, 0);
  assert.equal(result.unmatchedWeightCount, 0);
  assert.equal(result.unmatchedLeanCount, 0);
});

test('conflicting values at the same source and instant invalidate the whole pair instead of choosing a row', () => {
  for (const conflict of [sample('weight', 71), sample('lean_body_mass', 55)]) {
    const input = [...pair(), conflict];
    const result = buildBodyComposition(input);
    assert.equal(result.latest, null);
    assert.deepEqual(result.points, []);
    assert.equal(result.invalidPairCount, 1);
    assert.deepEqual(buildBodyComposition([...input].reverse()), result);
  }
});

test('source-less samples stay unmatched, including duplicates, and never match each other', () => {
  const weight = { ...sample('weight', 70), source: undefined };
  const lean = { ...sample('lean_body_mass', 56), source: undefined };
  const result = buildBodyComposition([weight, { ...weight, id: 'weight-alias' }, lean]);
  assert.equal(result.latest, null);
  assert.equal(result.unmatchedWeightCount, 1);
  assert.equal(result.unmatchedLeanCount, 1);
  assert.equal(result.invalidPairCount, 0);
});

test('bad timestamps, wrong mass units and unrelated daily metrics do not yield an estimate or throw', () => {
  const input: HealthMeasurement[] = [
    { ...sample('weight', 70), startDate: '2026-02-30T07:30:00+08:00' },
    sample('lean_body_mass', 56),
    { ...sample('weight', 70), unit: 'count' },
    { id: 'steps', metric: 'steps', value: 7000, unit: 'count', startDate: '2026-11-09T00:00:00+08:00', endDate: '2026-11-09T08:00:00+08:00', source: 'phone', aggregation: 'daily' },
  ];
  assert.doesNotThrow(() => buildBodyComposition(input));
  assert.equal(buildBodyComposition(input).latest, null);
  assert.deepEqual(buildBodyComposition(input).points, []);
});
