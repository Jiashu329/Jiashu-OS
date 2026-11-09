import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildQuickWeightPayload } from './quick-weight.ts';
import { buildHealthSummary, measurementDay, measurementKey, parseSyncPayload } from './health.ts';
import { parseMobileSyncPayload } from './mobile-sync.ts';

const base = {
  values: '72.5', dates: '2026-11-08T07:30:00+08:00',
  at: '2026-11-09T12:00:00+08:00', source: '我的体脂秤', unit: 'kg',
};

test('historical weight samples preserve their real instants and the latest daily point drives the trend', () => {
  const payload = buildQuickWeightPayload({
    ...base,
    values: '72.1\n73.2\n72.8',
    dates: '2026-11-08T18:00:00+08:00\n2026-10-10T08:00:00+08:00\n2026-11-08T07:00:00+08:00',
  });
  const accepted = parseMobileSyncPayload(payload);
  assert.equal(payload.exportedAt, base.at);
  assert.equal(accepted.measurements.length, 3);
  assert.deepEqual(accepted.measurements.map((row) => [row.value, row.startDate, row.aggregation]), [
    [73.2, '2026-10-10T00:00:00.000Z', 'sample'],
    [72.8, '2026-11-07T23:00:00.000Z', 'sample'],
    [72.1, '2026-11-08T10:00:00.000Z', 'sample'],
  ]);
  assert.equal(measurementDay(accepted.measurements[1]), '2026-11-08');
  const summary = buildHealthSummary(accepted.measurements);
  assert.deepEqual(summary.metrics.weight.points.map(({ day, value }) => ({ day, value })), [
    { day: '2026-10-10', value: 73.2 }, { day: '2026-11-08', value: 72.1 },
  ]);
  assert.equal(summary.metrics.weight.latestValue, 72.1);
});

test('explicit source units convert to kilograms and conventional grouping is accepted', () => {
  assert.equal(parseSyncPayload(buildQuickWeightPayload({ ...base, unit: 'lb', values: '140' })).measurements[0].value, 63.502932);
  assert.equal(parseSyncPayload(buildQuickWeightPayload({ ...base, unit: 'jin', values: '140.5' })).measurements[0].value, 70.25);
  for (const values of ['1,200', '1，200', '1\u00a0200', '1\u202f200', '1 200']) {
    const record = buildQuickWeightPayload({ ...base, values, unit: 'lb' }).measurements[0];
    assert.equal(record.value, 544.310844);
    assert.equal(record.unit, 'kg');
  }
  for (const values of ['10', '600']) assert.equal(buildQuickWeightPayload({ ...base, values }).measurements[0].value, Number(values));
});

test('no sample, zero, misleading units and ambiguous numeric formats never fabricate a weight', () => {
  for (const values of [null, '', ' ', '\n', '0', '-70', 'NaN', 'Infinity', '70kg', '健康样本详细信息', '70,5', '1.200,5', '1,200 000', '7e1', '9.99999999', '600.00000001', '9'.repeat(400)]) {
    assert.throws(() => buildQuickWeightPayload({ ...base, values }));
  }
  for (const unit of [null, '', 'g', '斤', 'lbs', 'KG', 'constructor']) {
    assert.throws(() => buildQuickWeightPayload({ ...base, unit }), /单位/);
  }
  assert.throws(() => buildQuickWeightPayload({ ...base, values: '10', unit: 'lb' }), /10 至 600/);
});

test('parallel columns must retain the same count and every original row', () => {
  assert.throws(() => buildQuickWeightPayload({ ...base, values: '70\n71' }), /条数不一致/);
  for (const values of ['70\n\n71', '\n70', '70\n']) assert.throws(() => buildQuickWeightPayload({ ...base, values }), /行为空/);
  for (const dates of [null, '', '\n', base.dates + '\n', '\n' + base.dates]) assert.throws(() => buildQuickWeightPayload({ ...base, dates }));
  assert.throws(() => buildQuickWeightPayload({ ...base, values: '70\r71' }), /分行格式/);
  assert.throws(() => buildQuickWeightPayload({ ...base, dates: base.dates + '\r' + base.dates }), /分行格式/);
  const accepted = parseSyncPayload(buildQuickWeightPayload({ ...base, values: '70\r\n71', dates: base.dates + '\r\n2026-11-09T07:00:00+08:00' }));
  assert.equal(accepted.measurements.length, 2);
});

test('original ISO timestamps remain strict and measuring cannot happen after export', () => {
  for (const dates of ['2026-02-30T07:00:00+08:00', '2026-11-08', '2026-11-08T07:00:00', '2026-11-08T24:00:00+08:00', '2026-11-08T07:60:00+08:00', '2026-11-08T07:00:60+08:00', '2026-11-08T07:00:00+14:01', '2026-11-08T07:00:00+08:60', '1969-12-31T12:00:00Z', '2100-12-31T23:00:00-14:00']) {
    assert.throws(() => buildQuickWeightPayload({ ...base, dates }));
  }
  for (const at of [null, '', '日期', '2026-02-30T12:00:00+08:00', '2026-11-09T12:00:00', '1970-01-01T00:00:00+14:00']) {
    assert.throws(() => buildQuickWeightPayload({ ...base, at }));
  }
  assert.throws(() => buildQuickWeightPayload({ ...base, dates: '2026-11-09T12:05:01+08:00' }), /晚于本次同步时间/);
  const boundary = parseSyncPayload(buildQuickWeightPayload({ ...base, dates: '2026-11-09T12:05:00+08:00' }));
  assert.equal(boundary.measurements[0].startDate, '2026-11-09T04:05:00.000Z');
});

test('unencoded positive timezone offsets are repaired without replacing capture or measurement times', () => {
  const params = new URLSearchParams('values=72.5&dates=2026-11-08T07:30:00+08:00&at=2026-11-09T12:00:00+08:00&source=scale&unit=kg');
  const payload = buildQuickWeightPayload({ values: params.get('values'), dates: params.get('dates'), at: params.get('at'), source: params.get('source'), unit: params.get('unit') });
  assert.equal(payload.exportedAt, base.at);
  assert.equal(payload.measurements[0].startDate, '2026-11-07T23:30:00.000Z');
  assert.equal(measurementDay(parseSyncPayload(payload).measurements[0]), '2026-11-08');
});

test('replays, reordering and equivalent offsets preserve identities; conflicting same-instant weights fail', () => {
  const first = buildQuickWeightPayload({ ...base, values: '72.5\n73', dates: base.dates + '\n2026-11-07T07:00:00+08:00' });
  const rerun = buildQuickWeightPayload({ ...base, at: '2026-11-10T12:00:00+08:00', values: '73\n72.5', dates: '2026-11-07T07:00:00+08:00\n2026-11-07T23:30:00Z' });
  assert.deepEqual(first.measurements, rerun.measurements);
  assert.notEqual(first.exportedAt, rerun.exportedAt);
  const duplicate = buildQuickWeightPayload({ ...base, values: '72.5\n72.500000', dates: base.dates + '\n2026-11-07T23:30:00.000Z' });
  assert.equal(duplicate.measurements.length, 1);
  assert.throws(() => buildQuickWeightPayload({ ...base, values: '72.5\n73', dates: base.dates + '\n2026-11-07T23:30:00Z' }), /同一个测量时刻/);
  const corrected = buildQuickWeightPayload({ ...base, values: '72.6', at: rerun.exportedAt });
  assert.equal(measurementKey(parseSyncPayload(first).measurements[1]), measurementKey(parseSyncPayload(corrected).measurements[0]));
});

test('source selection and payload capacity are bounded before accepting rows', () => {
  for (const source of [null, '', ' ', 'scale\n', 'scale\t', 'x'.repeat(121)]) assert.throws(() => buildQuickWeightPayload({ ...base, source }));
  assert.equal(buildQuickWeightPayload({ ...base, source: '  我的体脂秤  ' }).measurements[0].source, base.source);
  const dates = Array.from({ length: 300 }, (_, index) => new Date(Date.parse('2026-11-08T00:00:00Z') + index * 60000).toISOString());
  const accepted = parseMobileSyncPayload(buildQuickWeightPayload({ ...base, values: Array(300).fill('70').join('\n'), dates: dates.join('\n') }));
  assert.equal(accepted.measurements.length, 300);
  assert.throws(() => buildQuickWeightPayload({ ...base, values: Array(301).fill('70').join('\n'), dates: [...dates, dates[0]].join('\n') }), /300 条/);
  assert.throws(() => buildQuickWeightPayload({ ...base, values: '1'.repeat(512 * 1024 + 1) }), /512 KB/);
  assert.throws(() => buildQuickWeightPayload({ ...base, values: '重'.repeat(180000) }), /512 KB/);
});

test('serialized browser helper runs in isolation and produces a standard backend payload', () => {
  const embedded = runInNewContext('(' + buildQuickWeightPayload.toString() + ')', { TextEncoder });
  const payload = embedded({ ...base, unit: 'jin', values: '145' });
  const accepted = parseMobileSyncPayload(JSON.stringify(payload));
  assert.equal(accepted.measurements[0].value, 72.5);
  assert.equal(accepted.measurements[0].id, 'quick-weight:2026-11-07T23:30:00.000Z');
});
