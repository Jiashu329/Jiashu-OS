import assert from 'node:assert/strict';
import test from 'node:test';
import type { HealthMeasurement, SleepStages } from './health.ts';
import type { NutritionEntry } from './nutrition.ts';
import { assistantRange, buildHealthAssistantContext, HealthAssistantContextError, MAX_HEALTH_ASSISTANT_CONTEXT_BYTES } from './health-assistant-context.ts';

const NOW = Date.parse('2026-11-11T10:00:00+08:00');
const privateSource = 'PRIVATE_DEVICE_owner@example.com';
const stages: SleepStages = { unspecified: 1, core: 4, deep: 1, rem: 2, awake: 0.5, inBed: 9 };
const shift = (day: string, offset: number) => new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
function daily(metric: 'steps' | 'active_energy' | 'sleep', day = '2026-11-10', value = metric === 'steps' ? 8000 : metric === 'sleep' ? 8 : 400): HealthMeasurement {
  return {
    id: 'PRIVATE_SAMPLE_' + metric + ':' + day, metric, value, unit: metric === 'steps' ? 'count' : metric === 'sleep' ? 'hours' : 'kcal',
    startDate: metric === 'sleep' ? shift(day, -1) + 'T12:00:00+08:00' : day + 'T00:00:00+08:00',
    endDate: metric === 'sleep' ? day + 'T12:00:00+08:00' : shift(day, 1) + 'T00:00:00+08:00',
    source: privateSource, aggregation: 'daily',
  };
}
function mass(metric: 'weight' | 'lean_body_mass', day = '2026-11-10', value = metric === 'weight' ? 70 : 56, time = '08:00:00'): HealthMeasurement {
  return { id: 'PRIVATE_SAMPLE_' + metric + day + time, metric, value, unit: 'kg', startDate: `${day}T${time}+08:00`, source: privateSource, aggregation: 'sample' };
}
function food(date = '2026-11-10', caloriesTenth: number | null = 1001, deleted = false): NutritionEntry {
  return {
    id: 'PRIVATE_FOOD_ID', date, meal: 'lunch', name: 'PRIVATE_FOOD_NAME', portion: 'PRIVATE_PORTION', note: 'PRIVATE_NOTE',
    caloriesTenth, revision: 1, createdAt: date + 'T09:00:00+08:00', updatedAt: date + 'T09:00:00+08:00',
    deletedAt: deleted ? date + 'T09:30:00+08:00' : null,
  };
}

void test('ranges use Shanghai calendar dates, including UTC midnight, leap days and year boundaries', () => {
  assert.deepEqual(assistantRange(7, Date.parse('2026-11-10T16:30:00Z')), { days: 7, from: '2026-11-05', to: '2026-11-11', today: '2026-11-11' });
  assert.deepEqual(assistantRange(30, Date.parse('2024-03-01T12:00:00+08:00')), { days: 30, from: '2024-02-01', to: '2024-03-01', today: '2024-03-01' });
  assert.equal(assistantRange(7, Date.parse('2026-01-01T08:00:00+08:00')).from, '2025-12-26');
  for (const [days, now] of [[90, NOW], [7, NaN], [30, Infinity], [7, 9e99], [7, Date.parse('2101-01-01T12:00:00Z')]]) {
    assert.throws(() => assistantRange(days as 7 | 30, now), HealthAssistantContextError);
  }
});

void test('empty inputs preserve missingness with no invented zeroes or citations', () => {
  const result = buildHealthAssistantContext({ measurements: [], nutrition: [], days: 7, now: NOW });
  assert.equal(result.hasData, false);
  assert.deepEqual(result.sources, []);
  assert.equal(result.context.version, 1);
  assert.equal(result.context.timezone, 'Asia/Shanghai');
  assert.equal(result.context.health.length, 5);
  for (const metric of result.context.health) {
    assert.equal(metric.recordedDays, 0);
    assert.deepEqual(metric.points, []);
  }
  assert.deepEqual(result.context.nutrition, { recordedDays: 0, days: [] });
});

void test('provider projection excludes identifiers, sample timestamps and free text while local sources remain traceable', () => {
  const input = {
    measurements: [Object.assign(mass('weight'), { userId: 'PRIVATE_USER', email: 'PRIVATE_EMAIL', note: 'PRIVATE_HEALTH_NOTE', rawSamples: ['PRIVATE_RAW'] })],
    nutrition: [Object.assign(food(), { userId: 'PRIVATE_USER', email: 'PRIVATE_EMAIL' })], days: 7 as const, now: NOW,
  };
  const before = structuredClone(input);
  const result = buildHealthAssistantContext(input);
  assert.deepEqual(input, before);
  const providerJson = JSON.stringify(result.context);
  for (const secret of ['PRIVATE_', privateSource, 'userId', 'email', 'createdAt', 'updatedAt', 'startDate', 'endDate', 'portion', 'note', 'rawSamples']) {
    assert.ok(!providerJson.includes(secret), 'unexpected provider field/value: ' + secret);
  }
  assert.deepEqual(result.sources.map((source) => source.id), ['H1', 'N1']);
  assert.deepEqual(result.sources[0].sources, [privateSource]);
  assert.equal(result.sources[0].url, '/health/records?metric=weight&from=2026-11-05&to=2026-11-11');
  assert.equal(result.sources[1].url, '/health/nutrition?date=2026-11-10');
  assert.equal(result.context.health[0].points[0].sourceRef, 'H1');
  assert.equal(result.context.nutrition.days[0].sourceRef, 'N1');
});

void test('all five raw metrics retain fixed citations and daily totals replace rather than sum', () => {
  const steps = daily('steps', '2026-11-10', 1000);
  const result = buildHealthAssistantContext({
    measurements: [mass('weight'), mass('lean_body_mass'), steps, { ...steps, id: 'revised', value: 2000 }, daily('active_energy'), daily('sleep')],
    nutrition: [], days: 7, now: NOW,
  });
  assert.equal(result.hasData, true);
  assert.deepEqual(result.context.health.map((metric) => [metric.metric, metric.points[0].sourceRef, metric.recordedDays]), [
    ['weight', 'H1', 1], ['lean_body_mass', 'H2', 1], ['steps', 'H3', 1], ['active_energy', 'H4', 1], ['sleep', 'H5', 1],
  ]);
  assert.equal(result.context.health.find((metric) => metric.metric === 'steps')!.points[0].value, 2000);
  assert.ok(!result.context.health.some((metric) => String(metric.metric) === 'body_fat'));
});

void test('health range and future-instant filters run before selecting the last mass sample of a day', () => {
  const earlier = mass('weight', '2026-11-11', 70, '08:00:00');
  const result = buildHealthAssistantContext({ measurements: [
    mass('weight', '2026-11-04', 69), { ...earlier, endDate: '2026-11-12T00:00:00+08:00' },
    mass('weight', '2026-11-11', 72, '11:00:00'), mass('weight', '2026-11-12', 74),
    daily('steps', '2026-11-05', 0), daily('steps', '2026-11-07', 5000), daily('steps', '2026-11-11', 2000),
    daily('sleep', '2026-11-05'),
  ], nutrition: [], days: 7, now: NOW });
  assert.deepEqual(result.context.health[0].points, [{ date: '2026-11-11', value: 70, sourceRef: 'H1' }]);
  assert.deepEqual(result.context.health.find((metric) => metric.metric === 'steps')!.points.map((point) => [point.date, point.value]), [['2026-11-05', 0], ['2026-11-07', 5000]]);
  assert.deepEqual(result.context.health.find((metric) => metric.metric === 'sleep')!.points.map((point) => point.date), ['2026-11-05']);
  assert.equal(result.sources.find((source) => source.id === 'H3')!.recordedDays, 2);
});

void test('invalid health values and timestamps do not become usable context', () => {
  const result = buildHealthAssistantContext({ measurements: [
    { ...daily('steps'), value: NaN }, { ...daily('steps'), value: 0.5 },
    { ...mass('weight'), unit: 'hours' }, { ...mass('weight'), startDate: '2026-02-30T08:00:00+08:00' },
    { ...daily('sleep'), endDate: undefined }, { ...daily('sleep'), endDate: '2026-11-08T10:00:00+08:00' },
  ], nutrition: [], days: 7, now: NOW });
  assert.equal(result.hasData, false);
});

void test('sleep phases are copied through a whitelist only when they agree with the effective total', () => {
  const sleep = { ...daily('sleep'), sleepStages: Object.assign({ ...stages }, { note: 'PRIVATE_PHASE_NOTE' }) };
  const result = buildHealthAssistantContext({ measurements: [sleep], nutrition: [], days: 7, now: NOW });
  const point = result.context.health.find((metric) => metric.metric === 'sleep')!.points[0];
  assert.deepEqual(point.sleepStages, stages);
  assert.notEqual(point.sleepStages, sleep.sleepStages);
  for (const sleepStages of [undefined, { ...stages, core: 3 }, { ...stages, rem: NaN }, { ...stages, awake: -1 }, { ...stages, inBed: 25 }]) {
    const context = buildHealthAssistantContext({ measurements: [{ ...sleep, sleepStages }], nutrition: [], days: 7, now: NOW }).context;
    assert.ok(!Object.hasOwn(context.health.find((metric) => metric.metric === 'sleep')!.points[0], 'sleepStages'));
  }
  const corrected = buildHealthAssistantContext({ measurements: [{ ...sleep, value: 7 }], nutrition: [], days: 7, now: NOW });
  assert.equal(corrected.context.health.find((metric) => metric.metric === 'sleep')!.points[0].value, 7);
  assert.ok(!corrected.context.health.find((metric) => metric.metric === 'sleep')!.points[0].sleepStages);
});

void test('nutrition totals preserve true zero and unknown calories while excluding deleted and unselected days', () => {
  const result = buildHealthAssistantContext({ measurements: [], nutrition: [
    food('2026-11-04', 9999), food('2026-11-07', 0), food('2026-11-08', null),
    food('2026-11-09', 1001), food('2026-11-09', 2002), food('2026-11-09', null),
    food('2026-11-09', 5000, true), food('2026-11-12', 9999),
  ], days: 7, now: NOW });
  assert.equal(result.hasData, true);
  assert.deepEqual(result.context.nutrition, { recordedDays: 3, days: [
    { date: '2026-11-07', entryCount: 1, knownCalorieCount: 1, unknownCalorieCount: 0, recordedKnownKcal: '0.0', sourceRef: 'N1' },
    { date: '2026-11-08', entryCount: 1, knownCalorieCount: 0, unknownCalorieCount: 1, recordedKnownKcal: null, sourceRef: 'N1' },
    { date: '2026-11-09', entryCount: 3, knownCalorieCount: 2, unknownCalorieCount: 1, recordedKnownKcal: '300.3', sourceRef: 'N1' },
  ] });
  const unknownOnly = buildHealthAssistantContext({ measurements: [], nutrition: [food('2026-11-10', null)], days: 7, now: NOW });
  assert.equal(unknownOnly.hasData, true);
  assert.equal(unknownOnly.context.nutrition.days[0].recordedKnownKcal, null);
  assert.equal(buildHealthAssistantContext({ measurements: [], nutrition: [food('2026-11-10', 100, true)], days: 7, now: NOW }).hasData, false);
});

void test('invalid calorie storage produces a clear error instead of pretending the projection is complete', () => {
  for (const caloriesTenth of [NaN, -1, 0.5, 200001]) {
    assert.throws(() => buildHealthAssistantContext({ measurements: [], nutrition: [food('2026-11-10', caloriesTenth)], days: 7, now: NOW }),
      (error: unknown) => error instanceof HealthAssistantContextError && error.code === 'INVALID_HEALTH_ASSISTANT_CONTEXT' && error.message.includes('饮食热量'));
  }
});

void test('a complete 30-day context stays bounded without truncating records and states the operating limitations', () => {
  const measurements = Array.from({ length: 30 }, (_, index) => {
    const day = shift('2026-11-10', -index);
    return [mass('weight', day), mass('lean_body_mass', day),
      { ...daily('steps', day), endDate: day + 'T22:00:00+08:00' },
      { ...daily('active_energy', day), endDate: day + 'T22:00:00+08:00' },
      { ...daily('sleep', day), sleepStages: stages }];
  }).flat();
  const nutrition = Array.from({ length: 30 }, (_, index) => food(shift('2026-11-10', -index)));
  const result = buildHealthAssistantContext({ measurements, nutrition, days: 30, now: Date.parse('2026-11-10T23:00:00+08:00') });
  for (const metric of result.context.health) assert.equal(metric.recordedDays, 30);
  assert.equal(result.context.nutrition.recordedDays, 30);
  assert.ok(new TextEncoder().encode(JSON.stringify(result.context)).byteLength <= MAX_HEALTH_ASSISTANT_CONTEXT_BYTES);
  assert.equal(MAX_HEALTH_ASSISTANT_CONTEXT_BYTES, 50 * 1024);
  const limitations = result.context.limitations.join('；');
  for (const rule of ['缺失日期不补0', '今日尚未结束', '并非全天真实总摄入', '不是全天总能量消耗', '未知热量不按0计算']) assert.ok(limitations.includes(rule));
});
