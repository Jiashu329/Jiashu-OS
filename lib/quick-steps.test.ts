import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildQuickStepsPayload } from './quick-steps.ts';
import { measurementKey, parseSyncPayload } from './health.ts';

const fields = { value: '8200', at: '2026-11-09T10:00:00+08:00', source: 'iPhone' };

test('simple handoff becomes a valid daily upload without user-authored JSON', () => {
  const payload = parseSyncPayload(buildQuickStepsPayload(fields));
  assert.equal(payload.measurements[0].value, 8200);
  assert.equal(payload.measurements[0].startDate, '2026-11-08T16:00:00.000Z');
  assert.equal(payload.exportedAt, '2026-11-09T02:00:00.000Z');
});

test('an unencoded positive ISO offset survives URLSearchParams conversion', () => {
  const params = new URLSearchParams('value=8200&at=2026-11-09T10:00:00+08:00&source=iPhone');
  const payload = parseSyncPayload(buildQuickStepsPayload({ value: params.get('value'), at: params.get('at'), source: params.get('source') }));
  assert.equal(payload.exportedAt, '2026-11-09T02:00:00.000Z');
});

test('formatted numeric outputs are accepted without losing integer precision', () => {
  for (const value of ['8,200', '8，200', '8 200', '8\u202f200', '8200.0', '8,200.0']) {
    assert.equal(buildQuickStepsPayload({ ...fields, value }).measurements[0].value, 8200);
  }
});

test('missing samples, variable names and malformed numbers do not become zero', () => {
  for (const value of [null, '', '健康样本详细信息', '8,20', 'NaN', '8200步', '-1', '200001']) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, value }));
  }
  assert.equal(buildQuickStepsPayload({ ...fields, value: '0' }).measurements[0].value, 0);
});

test('date and source errors explain the missing configuration', () => {
  for (const at of [null, '格式化日期', '2026-02-30T12:00:00+08:00', '2026-11-09']) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, at }));
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, source: '' }));
  assert.throws(() => buildQuickStepsPayload({ ...fields, source: 'phone\n' + 'watch' }));
});

test('the original capture time is preserved so replay cannot become a fresh export', () => {
  const first = buildQuickStepsPayload(fields);
  const later = buildQuickStepsPayload({ ...fields, value: '9000', at: '2026-11-09T11:00:00+08:00' });
  assert.equal(first.measurements[0].id, later.measurements[0].id);
  assert.ok(Date.parse(first.exportedAt) < Date.parse(later.exportedAt));
});

test('active energy accepts decimal kcal and produces a standard valid energy upload', () => {
  for (const value of ['345.75', '1,234.5', '1\u202f234.5']) {
    const payload = parseSyncPayload(buildQuickStepsPayload({ ...fields, value, metric: 'active_energy', unit: 'kcal' }));
    const measurement = payload.measurements[0];
    assert.equal(measurement.metric, 'active_energy');
    assert.equal(measurement.unit, 'kcal');
    assert.equal(measurement.value, value === '345.75' ? 345.75 : 1234.5);
    assert.equal(payload.exportedAt, '2026-11-09T02:00:00.000Z');
  }
});

test('kJ is explicitly converted to kcal with reasonable decimal precision', () => {
  const first = parseSyncPayload(buildQuickStepsPayload({ ...fields, value: '418.4', metric: 'active_energy', unit: 'kJ' }));
  assert.equal(first.measurements[0].value, 100);
  const second = buildQuickStepsPayload({ ...fields, value: '1', metric: 'active_energy', unit: 'kJ' });
  assert.equal(second.measurements[0].value, 0.239006);
  assert.equal(second.measurements[0].unit, 'kcal');
  assert.equal(buildQuickStepsPayload({ ...fields, value: '83,680', metric: 'active_energy', unit: 'kJ' }).measurements[0].value, 20000);
});

test('energy requires its source unit and rejects unsupported metrics and inconsistent units', () => {
  for (const unit of [undefined, null, '', 'cal', 'kj', 'count']) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit }));
  }
  for (const metric of ['', 'sleep', 'energy', 'constructor']) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, metric, unit: 'kcal' }));
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'steps', unit: 'kcal' }));
  assert.equal(buildQuickStepsPayload({ ...fields, metric: 'steps', unit: 'count' }).measurements[0].value, 8200);
});

test('energy rejects empty readings, decimal commas, mixed grouping and out-of-range values', () => {
  for (const value of [null, '', '123,4', '1.234,5', '1,234 567', '1e3', '-1', '20000.0001', '9'.repeat(400)]) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kcal', value }));
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kJ', value: '83680.0001' }));
  assert.throws(() => buildQuickStepsPayload({ ...fields, value: '123.4' }));
  assert.equal(buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kcal', value: '0' }).measurements[0].value, 0);
});

test('steps and energy on the same day retain separate stable identities and export times', () => {
  const steps = parseSyncPayload(buildQuickStepsPayload(fields));
  const energy = parseSyncPayload(buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kcal', value: '450.25' }));
  assert.equal(steps.measurements[0].id, 'quick-steps:2026-11-09');
  assert.equal(energy.measurements[0].id, 'quick-active_energy:2026-11-09');
  assert.notEqual(measurementKey(steps.measurements[0]), measurementKey(energy.measurements[0]));
  assert.equal(steps.exportedAt, energy.exportedAt);
  const combined = parseSyncPayload({ ...steps, measurements: [...steps.measurements, ...energy.measurements] });
  assert.equal(combined.measurements.length, 2);
});

test('the serialized helper runs without module imports or captured constants', () => {
  const embedded = runInNewContext('(' + buildQuickStepsPayload.toString() + ')');
  const output = embedded({ ...fields, metric: 'active_energy', unit: 'kJ', value: '418.4' });
  const accepted = parseSyncPayload(JSON.stringify(output));
  assert.equal(accepted.measurements[0].metric, 'active_energy');
  assert.equal(accepted.measurements[0].value, 100);
});
