import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildQuickStepsPayload } from './quick-steps.ts';
import { buildHealthSummary, MAX_SYNC_BYTES, measurementDay, measurementKey, parseSyncPayload } from './health.ts';
import { renderApp } from '../ui.ts';

const fields = { value: '8200', at: '2026-11-09T10:00:00+08:00', source: 'iPhone' };

void test('simple handoff becomes a valid daily upload without user-authored JSON', () => {
  const payload = parseSyncPayload(buildQuickStepsPayload(fields));
  assert.equal(payload.measurements[0].value, 8200);
  assert.equal(payload.measurements[0].startDate, '2026-11-08T16:00:00.000Z');
  assert.equal(payload.exportedAt, '2026-11-09T02:00:00.000Z');
});

void test('an unencoded positive ISO offset survives URLSearchParams conversion', () => {
  const params = new URLSearchParams('value=8200&at=2026-11-09T10:00:00+08:00&source=iPhone');
  const payload = parseSyncPayload(buildQuickStepsPayload({ value: params.get('value'), at: params.get('at'), source: params.get('source') }));
  assert.equal(payload.exportedAt, '2026-11-09T02:00:00.000Z');
});

void test('formatted numeric outputs are accepted without losing integer precision', () => {
  for (const value of ['8,200', '8，200', '8 200', '8\u202f200', '8200.0', '8,200.0']) {
    assert.equal(buildQuickStepsPayload({ ...fields, value }).measurements[0].value, 8200);
  }
});

void test('missing samples, variable names and malformed numbers do not become zero', () => {
  for (const value of [null, '', '健康样本详细信息', '8,20', 'NaN', '8200步', '-1', '200001']) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, value }));
  }
  assert.equal(buildQuickStepsPayload({ ...fields, value: '0' }).measurements[0].value, 0);
});

void test('date and source errors explain the missing configuration', () => {
  for (const at of [null, '格式化日期', '2026-02-30T12:00:00+08:00', '2026-11-09']) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, at }));
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, source: '' }));
  assert.throws(() => buildQuickStepsPayload({ ...fields, source: 'phone\n' + 'watch' }));
});

void test('the original capture time is preserved so replay cannot become a fresh export', () => {
  const first = buildQuickStepsPayload(fields);
  const later = buildQuickStepsPayload({ ...fields, value: '9000', at: '2026-11-09T11:00:00+08:00' });
  assert.equal(first.measurements[0].id, later.measurements[0].id);
  assert.ok(Date.parse(first.exportedAt) < Date.parse(later.exportedAt));
});

void test('active energy accepts decimal kcal and produces a standard valid energy upload', () => {
  for (const value of ['345.75', '1,234.5', '1\u202f234.5']) {
    const payload = parseSyncPayload(buildQuickStepsPayload({ ...fields, value, metric: 'active_energy', unit: 'kcal' }));
    const measurement = payload.measurements[0];
    assert.equal(measurement.metric, 'active_energy');
    assert.equal(measurement.unit, 'kcal');
    assert.equal(measurement.value, value === '345.75' ? 345.75 : 1234.5);
    assert.equal(payload.exportedAt, '2026-11-09T02:00:00.000Z');
  }
});

void test('kJ is explicitly converted to kcal with reasonable decimal precision', () => {
  const first = parseSyncPayload(buildQuickStepsPayload({ ...fields, value: '418.4', metric: 'active_energy', unit: 'kJ' }));
  assert.equal(first.measurements[0].value, 100);
  const second = buildQuickStepsPayload({ ...fields, value: '1', metric: 'active_energy', unit: 'kJ' });
  assert.equal(second.measurements[0].value, 0.239006);
  assert.equal(second.measurements[0].unit, 'kcal');
  assert.equal(buildQuickStepsPayload({ ...fields, value: '83,680', metric: 'active_energy', unit: 'kJ' }).measurements[0].value, 20000);
});

void test('energy requires its source unit and rejects unsupported metrics and inconsistent units', () => {
  for (const unit of [undefined, null, '', 'cal', 'kj', 'count']) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit }));
  }
  for (const metric of ['', 'sleep', 'energy', 'constructor']) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, metric, unit: 'kcal' }));
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'steps', unit: 'kcal' }));
  assert.equal(buildQuickStepsPayload({ ...fields, metric: 'steps', unit: 'count' }).measurements[0].value, 8200);
});

void test('energy rejects empty readings, decimal commas, mixed grouping and out-of-range values', () => {
  for (const value of [null, '', '123,4', '1.234,5', '1,234 567', '1e3', '-1', '20000.0001', '9'.repeat(400)]) {
    assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kcal', value }));
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kJ', value: '83680.0001' }));
  assert.throws(() => buildQuickStepsPayload({ ...fields, value: '123.4' }));
  assert.equal(buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kcal', value: '0' }).measurements[0].value, 0);
});

void test('steps and energy on the same day retain separate stable identities and export times', () => {
  const steps = parseSyncPayload(buildQuickStepsPayload(fields));
  const energy = parseSyncPayload(buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kcal', value: '450.25' }));
  assert.equal(steps.measurements[0].id, 'quick-steps:2026-11-09');
  assert.equal(energy.measurements[0].id, 'quick-active_energy:2026-11-09');
  assert.notEqual(measurementKey(steps.measurements[0]), measurementKey(energy.measurements[0]));
  assert.equal(steps.exportedAt, energy.exportedAt);
  const combined = parseSyncPayload({ ...steps, measurements: [...steps.measurements, ...energy.measurements] });
  assert.equal(combined.measurements.length, 2);
});

void test('the serialized helper runs without module imports or captured constants', () => {
  const embedded = runInNewContext('(' + buildQuickStepsPayload.toString() + ')', { TextEncoder });
  const output = embedded({ ...fields, metric: 'active_energy', unit: 'kJ', value: '418.4' });
  const accepted = parseSyncPayload(JSON.stringify(output));
  assert.equal(accepted.measurements[0].metric, 'active_energy');
  assert.equal(accepted.measurements[0].value, 100);
});

const batch = { values: '8200\n6000\n0', dates: '2026-11-09\n2026-11-07\n2026-11-08', at: fields.at, source: fields.source };

void test('multiple daily totals retain their dates, gaps, explicit zero and complete historical intervals', () => {
  const payload = parseSyncPayload(buildQuickStepsPayload(batch));
  assert.deepEqual(payload.measurements.map((row) => [measurementDay(row), row.value, row.startDate, row.endDate]), [
    ['2026-11-07', 6000, '2026-11-06T16:00:00.000Z', '2026-11-07T16:00:00.000Z'],
    ['2026-11-08', 0, '2026-11-07T16:00:00.000Z', '2026-11-08T16:00:00.000Z'],
    ['2026-11-09', 8200, '2026-11-08T16:00:00.000Z', '2026-11-09T02:00:00.000Z'],
  ]);
  const gap = parseSyncPayload(buildQuickStepsPayload({ ...batch, values: '6000\n8200', dates: '2026-11-07\n2026-11-09' }));
  assert.deepEqual(buildHealthSummary(gap.measurements).metrics.steps.points.map((row) => row.day), ['2026-11-07', '2026-11-09']);
  assert.equal(payload.exportedAt, '2026-11-09T02:00:00.000Z');
});

void test('ISO sample dates use Shanghai days across UTC, year, month and leap-day boundaries', () => {
  const result = parseSyncPayload(buildQuickStepsPayload({
    ...batch, at: '2028-03-01T01:00:00+08:00', values: '1000\n2000\n3000\n4000',
    dates: '2027-12-31T15:59:59Z\n2027-12-31T16:00:00Z\n2028-02-29T00:30:00+08:00\n2028-02-29T16:00:00Z',
  }));
  assert.deepEqual(result.measurements.map(measurementDay), ['2027-12-31', '2028-01-01', '2028-02-29', '2028-03-01']);
  assert.equal(result.measurements[2].endDate, '2028-02-29T16:00:00.000Z');
  assert.equal(result.measurements[3].endDate, '2028-02-29T17:00:00.000Z');
});

void test('daily intervals also respect historical Shanghai daylight-saving boundaries', () => {
  const payload = parseSyncPayload(buildQuickStepsPayload({
    ...batch, at: '1991-10-01T12:00:00+08:00', values: '1000\n2000', dates: '1991-04-14\n1991-09-15',
  }));
  const lengths = payload.measurements.map((row) => (Date.parse(row.endDate!) - Date.parse(row.startDate)) / 3600000);
  assert.deepEqual(lengths, [23, 25]);
});

void test('same-day duplicates are coalesced and conflicting totals are rejected instead of added', () => {
  const output = parseSyncPayload(buildQuickStepsPayload({ ...batch, values: '8,200\n8200', dates: '2026-11-09\n2026-11-08T16:00:00Z' }));
  assert.equal(output.measurements.length, 1);
  assert.equal(output.measurements[0].value, 8200);
  assert.throws(() => buildQuickStepsPayload({ ...batch, values: '8200\n8000', dates: '2026-11-09\n2026-11-09' }), /同一天/);
  const single = parseSyncPayload(buildQuickStepsPayload(fields));
  assert.equal(output.measurements[0].id, single.measurements[0].id);
  assert.equal(measurementKey(output.measurements[0]), measurementKey(single.measurements[0]));
});

void test('columns must be complete, paired and unambiguous without silently dropping rows', () => {
  for (const values of [null, '', '8200\n', '\n8200', '8200\n\n6000', '8200\r6000']) {
    assert.throws(() => buildQuickStepsPayload({ ...batch, values }));
  }
  for (const dates of [null, '', '2026-11-09', '\n2026-11-09', '2026-11-09\n', '2026-11-09\r2026-11-08']) {
    assert.throws(() => buildQuickStepsPayload({ ...batch, dates }));
  }
  assert.throws(() => buildQuickStepsPayload({ ...batch, value: '8200' }), /同时包含单日和多日/);
  assert.throws(() => buildQuickStepsPayload({ ...fields, dates: batch.dates }));
  assert.throws(() => buildQuickStepsPayload({ ...batch, dates: undefined }));
  const windows = parseSyncPayload(buildQuickStepsPayload({ ...batch, values: '8200\r\n6000', dates: '2026-11-09\r\n2026-11-08' }));
  assert.equal(windows.measurements.length, 2);
});

void test('impossible, incomplete, future and zero-duration daily dates fail before submission', () => {
  for (const dates of ['2026-02-30', '2026-2-3', '每日日期', '2026-11-08T12:00:00',
    '2026-11-08T24:00:00+08:00', '2026-11-08T12:00:00+14:01', '2026-11-10', '2026-11-09T11:00:00+08:00']) {
    assert.throws(() => buildQuickStepsPayload({ ...batch, values: '8200', dates }));
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, at: '2026-11-09T00:00:00+08:00' }), /午夜/);
  const midnight = parseSyncPayload(buildQuickStepsPayload({ ...batch, values: '8200', dates: '2026-11-08', at: '2026-11-09T00:00:00+08:00' }));
  assert.equal(midnight.measurements[0].endDate, '2026-11-08T16:00:00.000Z');
});

void test('replay preserves capture time while newer partial totals keep the original daily identity', () => {
  const first = parseSyncPayload(buildQuickStepsPayload(batch));
  const replay = parseSyncPayload(buildQuickStepsPayload(batch));
  assert.deepEqual(replay, first);
  const next = parseSyncPayload(buildQuickStepsPayload({ ...batch, at: '2026-11-09T12:00:00+08:00', values: '9000\n6000\n0' }));
  assert.equal(first.measurements[2].id, next.measurements[2].id);
  assert.equal(next.measurements[2].value, 9000);
  assert.ok(Date.parse(next.exportedAt) > Date.parse(first.exportedAt));
  assert.deepEqual(first.measurements.slice(0, 2), next.measurements.slice(0, 2));
});

void test('batch row and byte limits are enforced before processing oversized input', () => {
  const dates = Array.from({ length: 1000 }, (_, index) => new Date(Date.parse('2026-11-08T12:00:00Z') - index * 86400000).toISOString().slice(0, 10));
  assert.equal(parseSyncPayload(buildQuickStepsPayload({ ...batch, values: dates.map(() => '1000').join('\n'), dates: dates.join('\n') })).measurements.length, 1000);
  assert.throws(() => buildQuickStepsPayload({ ...batch, values: Array(1001).fill('1000').join('\n'), dates: [...dates, dates[0]].join('\n') }), /1000 条/);
  assert.throws(() => buildQuickStepsPayload({ ...batch, values: '1'.repeat(MAX_SYNC_BYTES + 1) }), /512 KB/);
  assert.throws(() => buildQuickStepsPayload({ ...batch, dates: '日'.repeat(180000) }), /512 KB/);
});

void test('an expanded rolling query excludes only dates before the requested Shanghai window', () => {
  const output = parseSyncPayload(buildQuickStepsPayload({
    ...batch, days: '7', values: '123\n4000\n6000\n8200',
    dates: '2026-11-01\n2026-11-03\n2026-11-07\n2026-11-09',
  }));
  assert.deepEqual(output.measurements.map((row) => [measurementDay(row), row.value]), [
    ['2026-11-03', 4000], ['2026-11-07', 6000], ['2026-11-09', 8200],
  ]);
  // A missing extra day must not make us discard the first valid day's total.
  const missing = parseSyncPayload(buildQuickStepsPayload({ ...batch, days: '7', values: '4000\n8200', dates: '2026-11-03\n2026-11-09' }));
  assert.equal(missing.measurements[0].value, 4000);
  assert.equal(missing.measurements.length, 2);
  // Without the new range field existing multi-day shortcuts retain all dates.
  assert.equal(parseSyncPayload(buildQuickStepsPayload({ ...batch, values: '123\n8200', dates: '2026-11-01\n2026-11-09' })).measurements.length, 2);
});

void test('range clipping respects Shanghai midnight, month boundaries and replay time', () => {
  const inputs = { ...batch, days: '1', at: '2028-02-29T16:30:00Z', values: '1000\n2000', dates: '2028-02-29T15:59:59Z\n2028-02-29T16:00:00Z' };
  const output = parseSyncPayload(buildQuickStepsPayload(inputs));
  assert.equal(output.measurements.length, 1);
  assert.equal(measurementDay(output.measurements[0]), '2028-03-01');
  assert.equal(output.measurements[0].value, 2000);
  assert.equal(output.exportedAt, '2028-02-29T16:30:00.000Z');
  assert.deepEqual(parseSyncPayload(buildQuickStepsPayload(inputs)), output);
  for (const days of ['30', '90']) assert.equal(buildQuickStepsPayload({ ...batch, days }).measurements.length, 3);
});

void test('range mode rejects bad configuration, empty retained results and malformed paired columns', () => {
  for (const days of ['', '0', '91', '-1', '7.5', '07', 'NaN', 'constructor']) {
    assert.throws(() => buildQuickStepsPayload({ ...batch, days }), /同步天数/);
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, days: '7' }), /同步天数/);
  assert.throws(() => buildQuickStepsPayload({ ...batch, metric: 'active_energy', unit: 'kcal', days: '31' }), /活动能量同步天数/);
  assert.throws(() => buildQuickStepsPayload({ ...batch, days: '7', values: '123', dates: '2026-11-01' }), /没有所选日期范围/);
  assert.throws(() => buildQuickStepsPayload({ ...batch, days: '7', values: '123\n8200', dates: '2026-11-01' }), /条数不一致/);
  assert.throws(() => buildQuickStepsPayload({ ...batch, days: '7', values: '不是数值\n8200', dates: '2026-11-01\n2026-11-09' }), /不是数字/);
});

void test('actual page fragment parser forwards encoded daily columns into the embedded helper', () => {
  const script = [...renderApp().matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).find((script) => script.includes('function parseSyncFragment('))!;
  const start = script.indexOf('function parseSyncFragment(');
  const end = script.indexOf('function handoffNotice(', start);
  const parseFragment = runInNewContext('(' + script.slice(start, end).trim() + ')', {
    URLSearchParams, TextEncoder, quickStepsPayload: buildQuickStepsPayload,
  });
  const params = new URLSearchParams({ quick: 'steps', device: 'jso_sync_' + 'a'.repeat(43), source: fields.source, days: '7',
    values: '8,200\n6000\n123', dates: '2026-11-09T00:00:00+08:00\n2026-11-08T00:00:00+08:00\n2026-11-01', at: fields.at });
  const result = parseFragment('#' + params.toString());
  assert.equal(result.deviceToken, 'jso_sync_' + 'a'.repeat(43));
  const accepted = parseSyncPayload(result.payloadText);
  assert.deepEqual(accepted.measurements.map((row) => [measurementDay(row), row.value]), [['2026-11-08', 6000], ['2026-11-09', 8200]]);
  assert.equal(parseSyncPayload(parseFragment('#quick=steps&source=iPhone&value=8200&at=2026-11-09T10:00:00+08:00').payloadText).measurements[0].value, 8200);
  assert.equal(parseSyncPayload(parseFragment('#quick=active_energy&unit=kJ&source=iPhone&value=418.4&at=2026-11-09T10:00:00+08:00').payloadText).measurements[0].value, 100);
  assert.throws(() => parseFragment('#' + params.toString() + '&padding=' + 'x'.repeat(32768)), /32 KB/);
  const embedded = runInNewContext('(' + buildQuickStepsPayload.toString() + ')', { TextEncoder });
  assert.equal(parseSyncPayload(JSON.stringify(embedded({ ...batch, days: '1' }))).measurements.length, 1);
});

const energyBatch = { metric: 'active_energy', unit: 'kcal', days: '30', at: fields.at, source: 'Apple Watch',
  values: '123\n450.25\n0\n300.5', dates: '2026-10-10\n2026-11-09\n2026-10-20\n2026-10-11' };

void test('energy rolling range retains Shanghai today and the preceding 29 days by paired dates without inventing missing days', () => {
  const output = parseSyncPayload(buildQuickStepsPayload(energyBatch));
  assert.deepEqual(output.measurements.map((row) => [measurementDay(row), row.value]), [
    ['2026-10-11', 300.5], ['2026-10-20', 0], ['2026-11-09', 450.25],
  ]);
  assert.equal(output.measurements[0].startDate, '2026-10-10T16:00:00.000Z');
  assert.equal(output.measurements[0].endDate, '2026-10-11T16:00:00.000Z');
  assert.equal(output.measurements[2].endDate, output.exportedAt, 'today remains a partial total ending at the capture instant');
  assert.equal(buildHealthSummary(output.measurements).metrics.active_energy.points.length, 3);
  const withoutExtra = parseSyncPayload(buildQuickStepsPayload({ ...energyBatch, values: '300.5\n450.25', dates: '2026-10-11\n2026-11-09' }));
  assert.deepEqual(withoutExtra.measurements.map(measurementDay), ['2026-10-11', '2026-11-09'], 'a missing queried extra day never discards the first retained day');
});

void test('energy range limits and empty-window errors name energy while the steps 90-day contract remains supported', () => {
  for (const days of ['1', '7', '30']) {
    const output = parseSyncPayload(buildQuickStepsPayload({ ...energyBatch, days }));
    assert.ok(output.measurements.length > 0);
  }
  for (const days of ['', '0', '31', '90', '-1', '1.5', '01', '30.0', ' 7', '7\n', 'NaN', 'constructor']) {
    assert.throws(() => buildQuickStepsPayload({ ...energyBatch, days }), /活动能量同步天数需要为 1 至 30/);
  }
  assert.throws(() => buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kcal', days: '30' }), /多日活动能量地址/);
  assert.throws(() => buildQuickStepsPayload({ ...energyBatch, values: '123', dates: '2026-10-10' }), /日期范围内的活动能量/);
  assert.equal(parseSyncPayload(buildQuickStepsPayload({ ...batch, days: '90' })).measurements.length, 3);
  assert.throws(() => buildQuickStepsPayload({ ...batch, days: '91' }), /步数同步天数需要为 1 至 90/);
});

void test('legacy energy single-day and unrestricted batches still accept old links without days', () => {
  const single = parseSyncPayload(buildQuickStepsPayload({ ...fields, metric: 'active_energy', unit: 'kcal', value: '450.25' }));
  assert.equal(single.measurements[0].value, 450.25);
  const unrestricted = parseSyncPayload(buildQuickStepsPayload({ ...energyBatch, days: undefined }));
  assert.deepEqual(unrestricted.measurements.map(measurementDay), ['2026-10-10', '2026-10-11', '2026-10-20', '2026-11-09']);
  assert.equal(single.measurements[0].id, unrestricted.measurements.at(-1)!.id);
});

void test('multi-day energy explicitly converts kJ to kcal, retains zero and enforces duplicate-day totals without summing', () => {
  const input = { ...energyBatch, unit: 'kJ', values: '418.4\n0\n1\n83,680',
    dates: '2026-11-06\n2026-11-07\n2026-11-08\n2026-11-09' };
  const output = parseSyncPayload(buildQuickStepsPayload(input));
  assert.deepEqual(output.measurements.map((row) => row.value), [100, 0, 0.239006, 20000]);
  assert.ok(output.measurements.every((row) => row.unit === 'kcal' && row.metric === 'active_energy'));
  const duplicate = parseSyncPayload(buildQuickStepsPayload({ ...input, values: '418.4\n418.400000', dates: '2026-11-09\n2026-11-08T16:00:00Z' }));
  assert.equal(duplicate.measurements.length, 1);
  assert.equal(duplicate.measurements[0].value, 100);
  assert.throws(() => buildQuickStepsPayload({ ...input, values: '418.4\n836.8', dates: '2026-11-09\n2026-11-09' }), /同一天出现不同的活动能量总量/);
  assert.throws(() => buildQuickStepsPayload({ ...input, unit: null }), /选择手机读取值的能量单位/);
  assert.throws(() => buildQuickStepsPayload({ ...input, values: '1\n2', dates: '2026-11-09' }), /活动能量与日期条数不一致/);
});

void test('energy date clipping follows Shanghai midnight across leap months and year boundaries', () => {
  const output = parseSyncPayload(buildQuickStepsPayload({ ...energyBatch, at: '2028-02-29T16:30:00Z',
    values: '100\n200\n300\n400', dates: '2028-01-31T15:59:59Z\n2028-01-31T16:00:00Z\n2028-02-29T15:59:59Z\n2028-02-29T16:00:00Z' }));
  assert.deepEqual(output.measurements.map((row) => [measurementDay(row), row.value]), [
    ['2028-02-01', 200], ['2028-02-29', 300], ['2028-03-01', 400],
  ]);
  assert.equal(output.measurements[2].startDate, '2028-02-29T16:00:00.000Z');
  assert.equal(output.measurements[2].endDate, '2028-02-29T16:30:00.000Z');
  const newYear = parseSyncPayload(buildQuickStepsPayload({ ...energyBatch, at: '2027-01-01T01:00:00+08:00',
    values: '100\n200\n300', dates: '2026-12-02\n2026-12-03\n2027-01-01' }));
  assert.deepEqual(newYear.measurements.map(measurementDay), ['2026-12-03', '2027-01-01']);
});

void test('energy replay and later partial exports retain stable daily keys and original historical intervals', () => {
  const first = parseSyncPayload(buildQuickStepsPayload(energyBatch));
  assert.deepEqual(parseSyncPayload(buildQuickStepsPayload(energyBatch)), first);
  const later = parseSyncPayload(buildQuickStepsPayload({ ...energyBatch, at: '2026-11-09T12:00:00+08:00', values: '123\n500.75\n0\n300.5' }));
  assert.deepEqual(later.measurements.slice(0, -1), first.measurements.slice(0, -1));
  assert.equal(measurementKey(later.measurements.at(-1)!), measurementKey(first.measurements.at(-1)!));
  assert.equal(later.measurements.at(-1)!.id, 'quick-active_energy:2026-11-09');
  assert.equal(later.measurements.at(-1)!.value, 500.75);
  assert.ok(Date.parse(later.exportedAt) > Date.parse(first.exportedAt));
});

void test('energy range mode remains self-contained in the browser and is forwarded by the existing fragment parser', () => {
  const embedded = runInNewContext('(' + buildQuickStepsPayload.toString() + ')', { TextEncoder });
  const output = parseSyncPayload(JSON.stringify(embedded(energyBatch)));
  assert.deepEqual(output, parseSyncPayload(buildQuickStepsPayload(energyBatch)));
  const script = [...renderApp().matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).find((script) => script.includes('function parseSyncFragment('))!;
  const parseFragment = runInNewContext('(' + script.slice(script.indexOf('function parseSyncFragment('), script.indexOf('function handoffNotice(')).trim() + ')', {
    URLSearchParams, TextEncoder, quickStepsPayload: embedded,
  });
  const params = new URLSearchParams({ quick: 'active_energy', unit: 'kJ', days: '30', device: 'jso_sync_' + 'a'.repeat(43),
    source: 'Apple Watch', values: '123\n418.4\n0', dates: '2026-10-10\n2026-10-11T00:00:00+08:00\n2026-11-09', at: fields.at });
  const result = parseFragment('#' + params);
  assert.equal(result.deviceToken, 'jso_sync_' + 'a'.repeat(43));
  assert.deepEqual(parseSyncPayload(result.payloadText).measurements.map((row) => [measurementDay(row), row.value]), [['2026-10-11', 100], ['2026-11-09', 0]]);
});

void test('a synthetic 17-by-17 whole-list output reports actual counts and the Repeat Item fix without dropping rows', () => {
  const block = Array.from({ length: 17 }, (_, index) => String(100 + index));
  const dates = Array.from({ length: 17 }, (_, index) => new Date(Date.parse('2026-11-09T12:00:00Z') - index * 86400000).toISOString().slice(0, 10));
  const repeated = { ...energyBatch, values: Array.from({ length: 17 }, () => block.join('\n')).join('\n'), dates: dates.join('\n') };
  const assertDiagnosis = (error: unknown) => error instanceof Error
    && error.message.startsWith('每日活动能量与日期条数不一致。')
    && error.message.includes('收到数值 289 条，日期 17 条。')
    && error.message.includes('整组反复输出了 17 次')
    && error.message.includes('输入改为本循环的“重复项目”')
    && error.message.includes('本次未导入');
  assert.throws(() => buildQuickStepsPayload(repeated), assertDiagnosis);
  const embedded = runInNewContext('(' + buildQuickStepsPayload.toString() + ')', { TextEncoder });
  assert.throws(() => embedded(repeated), (error: unknown) => {
    const message = String((error as { message?: unknown }).message);
    return message.includes('数值 289 条，日期 17 条') && message.includes('整组反复输出') && message.includes('重复项目');
  });
  assert.equal(repeated.values.split('\n').length, 289, 'diagnosis must not alter the supplied columns');
});

void test('a nonidentical or incomplete repeated block gets counts without claiming the whole list was repeated', () => {
  const block = Array.from({ length: 17 }, (_, index) => String(100 + index));
  const dates = Array.from({ length: 17 }, (_, index) => new Date(Date.parse('2026-11-09T12:00:00Z') - index * 86400000).toISOString().slice(0, 10));
  for (const values of [[...block, ...block.slice(0, -1), '999'], [...block, ...block, '999']]) {
    assert.throws(() => buildQuickStepsPayload({ ...energyBatch, values: values.join('\n'), dates: dates.join('\n') }), (error: unknown) => {
      return error instanceof Error && error.message.includes('收到数值 ' + values.length + ' 条，日期 17 条。')
        && !error.message.includes('整组反复输出') && error.message.includes('本次未导入');
    });
  }
});

void test('single-column mismatches point to the correct loop and never guess dates or repeat one value', () => {
  assert.throws(() => buildQuickStepsPayload({ ...energyBatch, values: '100', dates: '2026-11-07\n2026-11-08\n2026-11-09' }), (error: unknown) => {
    return error instanceof Error && error.message.includes('数值 1 条，日期 3 条') && error.message.includes('数值列只有 1 项') && error.message.includes('整个数值循环的“重复结果”');
  });
  assert.throws(() => buildQuickStepsPayload({ ...energyBatch, values: '100\n100\n100', dates: '2026-11-09' }), (error: unknown) => {
    return error instanceof Error && error.message.includes('数值 3 条，日期 1 条') && error.message.includes('日期列只有 1 项')
      && error.message.includes('逐项取得开始日期') && !error.message.includes('整组反复输出');
  });
});

void test('residual encoded newlines identify the affected column and remain rejected instead of decoded again', () => {
  const cases = [
    { values: '100%0A200', dates: '2026-11-08\n2026-11-09', counts: '数值 1 条，日期 2 条', column: '数值列' },
    { values: '100\n200', dates: '2026-11-08%0D%0A2026-11-09', counts: '数值 2 条，日期 1 条', column: '日期列' },
    { values: '100%250A200', dates: '2026-11-08%250A2026-11-09', counts: '数值 1 条，日期 1 条', column: '数值列、日期列' },
  ];
  for (const item of cases) {
    assert.throws(() => buildQuickStepsPayload({ ...energyBatch, values: item.values, dates: item.dates }), (error: unknown) => {
      return error instanceof Error && error.message.includes(item.counts) && error.message.includes(item.column + '仍含编码换行')
        && error.message.includes('可能重复编码') && error.message.includes('只编码一次') && error.message.includes('本次未导入');
    });
  }
});

void test('equal-length repeated daily totals remain valid and steps reuse count diagnostics without changing the 90-day contract', () => {
  const valid = parseSyncPayload(buildQuickStepsPayload({ ...energyBatch, values: '100\n200\n100\n200',
    dates: '2026-11-08\n2026-11-09\n2026-11-08\n2026-11-09' }));
  assert.deepEqual(valid.measurements.map((row) => [measurementDay(row), row.value]), [['2026-11-08', 100], ['2026-11-09', 200]]);
  assert.throws(() => buildQuickStepsPayload({ ...batch, days: '90', values: '1000\n2000\n1000\n2000', dates: '2026-11-08\n2026-11-09' }), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('每日步数与日期条数不一致。')
      && error.message.includes('数值 4 条，日期 2 条') && error.message.includes('整组反复输出了 2 次');
  });
});
