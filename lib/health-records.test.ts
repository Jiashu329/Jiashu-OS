import assert from 'node:assert/strict';
import test from 'node:test';
import { measurementDay, measurementKey, parseSyncPayload } from './health.ts';
import { buildHealthWeeklyReview, parseHealthWeekQuery } from './health-weekly.ts';
import { emptyGoalSettings } from './health-goals.ts';
import { HealthRecordValidationError, parseHealthRecordCreate, parseHealthRecordKey, parseHealthRecordPatch, parseHealthRecordsQuery, validHealthRecordRequestId } from './health-records.ts';
import type { HealthRecordView } from './health-records.ts';

const KEY = '11111111-1111-4111-8111-111111111111';
const CAPTURE = '2026-11-09T10:30:00+08:00';
const NOW = new Date(CAPTURE);
function input(patch: Record<string, unknown> = {}) {
  return { metric: 'steps', value: 0, date: '2026-11-09', capturedAt: CAPTURE, ...patch };
}
function record(): HealthRecordView {
  const measurement = parseHealthRecordCreate(input({ value: 8000 }), KEY, NOW).measurement;
  return { recordKey: measurementKey(measurement), metric: measurement.metric, day: measurementDay(measurement),
    base: { measurement, exportedAt: NOW.toISOString(), receivedAt: NOW.toISOString() }, effective: measurement,
    override: null, deleted: false, revision: 0, updatedAt: null, manual: false };
}
function patch(fields: Record<string, unknown> = {}) {
  return { action: 'correct', value: 0, expectedRevision: 0, expectedBaseExportedAt: NOW.toISOString(), ...fields };
}

void test('manual daily records retain a real zero and today ends at capturedAt so the weekly review can count it', () => {
  const command = parseHealthRecordCreate(input(), KEY, NOW);
  assert.equal(command.measurement.value, 0);
  assert.equal(command.measurement.startDate, '2026-11-08T16:00:00.000Z');
  assert.equal(command.measurement.endDate, '2026-11-09T02:30:00.000Z');
  assert.equal(command.measurement.unit, 'count');
  assert.equal(measurementKey(command.measurement), 'steps:2026-11-09');
  assert.equal(command.measurement.aggregation, 'daily');
  const weekly = buildHealthWeeklyReview([command.measurement], emptyGoalSettings(), parseHealthWeekQuery(new URLSearchParams(), NOW), NOW);
  assert.equal(weekly.metrics[0].currentAverage, 0);
  assert.equal(weekly.metrics[0].currentRecordedDays, 1);
  const historical = parseHealthRecordCreate(input({ date: '2026-11-08', value: 123 }), KEY, NOW).measurement;
  assert.equal(historical.endDate, '2026-11-08T16:00:00.000Z');
  assert.equal(measurementDay(historical), '2026-11-08');
});

void test('sleep belongs to its chosen ending day and historical Shanghai daylight saving keeps daily boundaries valid', () => {
  const sleep = parseHealthRecordCreate(input({ metric: 'sleep', value: 8 }), KEY, NOW).measurement;
  assert.equal(sleep.unit, 'hours');
  assert.equal(measurementDay(sleep), '2026-11-09');
  assert.equal(sleep.endDate, '2026-11-08T16:00:00.000Z');
  const summer = parseHealthRecordCreate(input({ date: '1986-07-01', value: 100 }), KEY, NOW).measurement;
  assert.equal(summer.startDate, '1986-06-30T15:00:00.000Z');
  assert.equal(summer.endDate, '1986-07-01T15:00:00.000Z');
  assert.equal(measurementDay(summer), '1986-07-01');
  const summerSample = parseHealthRecordCreate(input({ metric: 'weight', date: '1986-07-01', time: '23:30', value: 70 }), KEY, NOW).measurement;
  assert.equal(summerSample.startDate, '1986-07-01T14:30:00.000Z');
  assert.equal(measurementDay(summerSample), '1986-07-01');
});

void test('body-mass samples require explicit time and retain separate stable identities for the two raw metrics', () => {
  const weight = parseHealthRecordCreate(input({ metric: 'weight', value: 70.5, time: '08:15' }), KEY, NOW).measurement;
  const lean = parseHealthRecordCreate(input({ metric: 'lean_body_mass', value: 55, time: '08:15:00' }), KEY, NOW).measurement;
  assert.equal(weight.startDate, '2026-11-09T00:15:00.000Z');
  assert.equal(weight.unit, 'kg');
  assert.equal(weight.aggregation, 'sample');
  assert.equal(weight.endDate, undefined);
  assert.equal(weight.id, 'manual:' + KEY);
  assert.notEqual(measurementKey(weight), measurementKey(lean));
  assert.deepEqual(parseHealthRecordCreate(input({ metric: 'weight', value: 70.5, time: '08:15:00' }), KEY, NOW).measurement, weight);
  assert.throws(() => parseHealthRecordCreate(input({ metric: 'weight', value: 70.5 }), KEY, NOW), HealthRecordValidationError);
});

void test('retries normalize capture offsets, reason whitespace and request key casing without generating fresh record times', () => {
  const original = parseHealthRecordCreate(input({ reason: '  手动核对  ' }), KEY, NOW);
  const retried = parseHealthRecordCreate(input({ capturedAt: NOW.toISOString(), reason: '手动核对' }), KEY.toUpperCase(), new Date('2026-11-10T00:00:00Z'));
  assert.deepEqual(retried, original);
  assert.equal(original.reason, '手动核对');
  const other = parseHealthRecordCreate(input(), crypto.randomUUID(), NOW);
  assert.equal(other.measurement.id, original.measurement.id, 'daily identity remains the metric/day across new request keys');
});

void test('all five metrics reuse original unit, finite-number and range validation without accepting derived body fat', () => {
  for (const item of [
    { metric: 'steps', value: 200001 }, { metric: 'steps', value: 1.5 }, { metric: 'active_energy', value: 20001 },
    { metric: 'sleep', value: 24.01 }, { metric: 'weight', value: 9, time: '08:00' },
    { metric: 'lean_body_mass', value: 0, time: '08:00' }, { metric: 'body_fat', value: 20 },
    { value: '0' }, { value: Infinity }, { value: NaN }, { value: null }, { unit: 'lb' },
  ]) assert.throws(() => parseHealthRecordCreate(input(item), KEY, NOW), HealthRecordValidationError);
  const energy = parseHealthRecordCreate(input({ metric: 'active_energy', value: 500.25 }), KEY, NOW).measurement;
  assert.equal(energy.unit, 'kcal');
  assert.equal(parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: CAPTURE, measurements: [energy] }).measurements[0].value, 500.25);
});

void test('new records reject impossible or future dates, missing capture times and ambiguous sample times', () => {
  for (const item of [
    { date: '2026-02-30' }, { date: '2026-11-09\n' }, { date: '2026-11-10' },
    { capturedAt: undefined }, { capturedAt: '2026-11-09' }, { capturedAt: '2026-11-09T10:30:01+08:00' },
    { metric: 'weight', value: 70, time: '24:00' }, { metric: 'weight', value: 70, time: '8:00' },
    { metric: 'weight', value: 70, time: '11:00' }, { time: '08:00' },
  ]) assert.throws(() => parseHealthRecordCreate(input(item), KEY, NOW), HealthRecordValidationError);
});

void test('corrections retain immutable record identity and parse numeric values through the original health contract', () => {
  const original = record();
  const before = structuredClone(original);
  assert.deepEqual(parseHealthRecordPatch(patch(), original, NOW), {
    action: 'correct', recordKey: original.recordKey, expectedRevision: 0, expectedBaseExportedAt: NOW.toISOString(), reason: '', value: 0,
  });
  assert.deepEqual(original, before);
  for (const item of [{ value: -1 }, { value: '100' }, { value: 200001 }, { value: undefined },
    { metric: 'sleep' }, { id: 'different' }, { startDate: CAPTURE }, { expectedRevision: -1 },
    { expectedRevision: 1.5 }, { expectedRevision: '0' }, { expectedBaseExportedAt: undefined }]) {
    assert.throws(() => parseHealthRecordPatch(patch(item), original, NOW), HealthRecordValidationError);
  }
  const manual = { ...original, base: null, manual: true };
  assert.equal(parseHealthRecordPatch(patch({ expectedBaseExportedAt: null }), manual, NOW).expectedBaseExportedAt, null);
});

void test('hide, restore and reset require explicit CAS versions, accept reasons and reject unrelated values or fields', () => {
  const original = record();
  for (const action of ['hide', 'restore', 'reset']) {
    const command = parseHealthRecordPatch({ action, expectedRevision: 3, expectedBaseExportedAt: CAPTURE, reason: '  重新核对  ' }, original, NOW);
    assert.equal(command.action, action);
    assert.equal(command.expectedRevision, 3);
    assert.equal(command.expectedBaseExportedAt, NOW.toISOString());
    assert.equal(command.reason, '重新核对');
    assert.throws(() => parseHealthRecordPatch({ action, expectedRevision: 3, expectedBaseExportedAt: null, value: 0 }, original, NOW), HealthRecordValidationError);
  }
  for (const reason of ['x'.repeat(501), '\u0000', '\u007f', 1]) assert.throws(() => parseHealthRecordPatch(patch({ reason }), original, NOW), HealthRecordValidationError);
  assert.throws(() => parseHealthRecordPatch({ action: 'hide', expectedRevision: 0 }, original, NOW), HealthRecordValidationError);
});

void test('record keys and request identifiers reject unsafe inputs while retaining full sample IDs', () => {
  assert.equal(validHealthRecordRequestId(KEY), true);
  assert.equal(validHealthRecordRequestId(KEY + '\n'), false);
  assert.equal(validHealthRecordRequestId('not-a-uuid'), false);
  for (const key of ['steps:2026-11-09', 'sleep:2026-11-09', 'weight:manual:' + KEY, 'lean_body_mass:device/sample+id']) assert.equal(parseHealthRecordKey(key), key);
  for (const key of ['', 'body_fat:2026-11-09', 'steps:2026-02-30', 'steps:2026-11-09\n', 'weight:contains space', 'weight:' + 'x'.repeat(161)]) assert.throws(() => parseHealthRecordKey(key), HealthRecordValidationError);
});

void test('list filters use Shanghai dates, strict ranges and bounded validated cursor pagination', () => {
  assert.deepEqual(parseHealthRecordsQuery(new URLSearchParams(), NOW), {
    from: '2026-10-11', to: '2026-11-09', metric: null, includeDeleted: false, limit: 100, cursor: null,
  });
  const cursor = JSON.stringify(['2026-11-08', 'weight:manual:' + KEY]);
  const parsed = parseHealthRecordsQuery(new URLSearchParams({ metric: 'weight', from: '2026-11-01', to: '2026-11-08', limit: '25', includeDeleted: '1', cursor }), NOW);
  assert.deepEqual(parsed.cursor, ['2026-11-08', 'weight:manual:' + KEY]);
  assert.equal(parsed.metric, 'weight');
  assert.equal(parsed.includeDeleted, true);
  assert.equal(parsed.limit, 25);
  for (const query of ['from=2026-11-10', 'to=2026-11-10', 'from=2026-11-09&to=2026-11-08', 'metric=body_fat',
    'limit=0', 'limit=101', 'limit=2.5', 'cursor=garbage', 'cursor=%5B%5D',
    'cursor=' + encodeURIComponent(JSON.stringify(['2026-02-30', 'steps:2026-11-09'])),
  ]) assert.throws(() => parseHealthRecordsQuery(new URLSearchParams(query), NOW), HealthRecordValidationError);
  const afterMidnight = parseHealthRecordsQuery(new URLSearchParams(), new Date('2026-11-09T16:00:00Z'));
  assert.equal(afterMidnight.to, '2026-11-10');
});
