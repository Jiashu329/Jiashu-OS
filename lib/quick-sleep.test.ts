import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildQuickSleepPayload } from './quick-sleep.ts';
import { parseMobileSyncPayload } from './mobile-sync.ts';

const base = {
  states: '1',
  starts: '2026-11-08T23:00:00+08:00',
  ends: '2026-11-09T07:00:00+08:00',
  at: '2026-11-09T14:00:00+08:00',
  source: 'selected-watch',
};

test('parallel columns become a valid sleep report and overlapping stages count once', () => {
  const payload = buildQuickSleepPayload({
    ...base,
    states: '1\r\n核心睡眠\r\n深度睡眠\r\nREM',
    starts: ['2026-11-08T23:00:00+08:00', '2026-11-08T23:00:00+08:00', '2026-11-09T02:00:00+08:00', '2026-11-09T04:00:00+08:00'].join('\r\n'),
    ends: ['2026-11-09T07:00:00+08:00', '2026-11-09T03:00:00+08:00', '2026-11-09T04:00:00+08:00', '2026-11-09T07:00:00+08:00'].join('\r\n'),
  });
  assert.equal(payload.sleepReport.segments.length, 4);
  const result = parseMobileSyncPayload(payload);
  assert.equal(result.measurements[0].value, 8);
  assert.equal(result.measurements[0].unit, 'hours');
});

test('in-bed and awake categories are not mistaken for sleep hours', () => {
  const result = parseMobileSyncPayload(buildQuickSleepPayload({
    ...base,
    states: '0\n清醒\n3',
    starts: '2026-11-08T22:00:00+08:00\n2026-11-09T07:00:00+08:00\n2026-11-08T23:00:00+08:00',
    ends: '2026-11-09T08:00:00+08:00\n2026-11-09T08:00:00+08:00\n2026-11-09T07:00:00+08:00',
  }));
  assert.equal(result.measurements[0].value, 8);
  assert.deepEqual(parseMobileSyncPayload(buildQuickSleepPayload({ ...base, states: '卧床' })).measurements, []);
});

test('missing columns and empty internal slots fail without shifting parallel records', () => {
  assert.throws(() => buildQuickSleepPayload({ ...base, states: '1\n3' }), /条数不一致/);
  for (const states of ['1\n\n3', '\n1', '1\n']) {
    assert.throws(() => buildQuickSleepPayload({ ...base, states }), /行为空/);
  }
  assert.throws(() => buildQuickSleepPayload({ ...base, starts: '\n' }), /没有收到/);
  assert.throws(() => buildQuickSleepPayload({ ...base, states: '1\r3' }), /分行格式/);
});

test('no sample does not become a zero-hour measurement', () => {
  for (const states of [null, '', ' ', '\r\n']) {
    assert.throws(() => buildQuickSleepPayload({ ...base, states }), /没有收到睡眠状态/);
  }
});

test('unencoded positive ISO offsets are repaired for all timestamp columns', () => {
  const params = new URLSearchParams('states=1&starts=2026-11-08T23:00:00+08:00&ends=2026-11-09T07:00:00+08:00&at=2026-11-09T14:00:00+08:00&source=watch');
  const payload = buildQuickSleepPayload({ states: params.get('states'), starts: params.get('starts'), ends: params.get('ends'), at: params.get('at'), source: params.get('source') });
  assert.equal(payload.exportedAt, base.at);
  assert.equal(payload.sleepReport.segments[0].startDate, base.starts);
  assert.equal(parseMobileSyncPayload(payload).measurements[0].value, 8);
});

test('invalid dates, timezone omissions, impossible offsets and reversed columns fail', () => {
  for (const starts of ['2026-02-30T23:00:00+08:00', '2026-11-08T23:00:00', '2026-11-08T24:00:00+08:00', '2026-11-08T23:00:00+14:01', '2026-11-09T07:00:00+08:00']) {
    assert.throws(() => buildQuickSleepPayload({ ...base, starts }));
  }
  assert.throws(() => buildQuickSleepPayload({ ...base, at: '2026-11-09' }));
  assert.throws(() => buildQuickSleepPayload({ ...base, ends: '2026-11-08T22:00:00+08:00' }));
});

test('capture time is preserved and reporting day follows Shanghai even across UTC midnight', () => {
  const payload = buildQuickSleepPayload({ ...base, at: '2026-11-08T23:00:00Z' });
  assert.equal(payload.exportedAt, '2026-11-08T23:00:00Z');
  assert.equal(payload.sleepReport.day, '2026-11-09');
  assert.equal(parseMobileSyncPayload(payload).measurements[0].value, 8);
});

test('category interpretation stays server-owned and no duration is fabricated', () => {
  const payload = buildQuickSleepPayload({ ...base, states: 'an unknown stage' });
  assert.equal(payload.sleepReport.segments[0].state, 'an unknown stage');
  assert.equal(payload.measurements.length, 0);
  assert.throws(() => parseMobileSyncPayload(payload));
});

test('source, number of segments and request size are bounded', () => {
  for (const source of [null, '', 'x'.repeat(121), 'watch\n']) assert.throws(() => buildQuickSleepPayload({ ...base, source }));
  assert.throws(() => buildQuickSleepPayload({ ...base, states: Array(3001).fill('1').join('\n') }), /3000/);
  assert.throws(() => buildQuickSleepPayload({ ...base, states: 'x'.repeat(512 * 1024 + 1) }), /512 KB/);
  const expanded = {
    ...base,
    states: Array(300).fill('x'.repeat(1660)).join('\n'),
    starts: Array(300).fill(base.starts).join('\n'),
    ends: Array(300).fill(base.ends).join('\n'),
  };
  assert.ok(new TextEncoder().encode(Object.values(expanded).join('\n')).byteLength < 512 * 1024);
  assert.throws(() => buildQuickSleepPayload(expanded), /组装后的睡眠数据超过/);
});

test('the serialized function works in isolation with no captured imports', () => {
  const build = vm.runInNewContext('(' + buildQuickSleepPayload.toString() + ')', { TextEncoder, Intl, Date, JSON, Error });
  const payload = build(base);
  // JSON erases the other vm realm's object prototype before backend parsing.
  assert.equal(parseMobileSyncPayload(JSON.parse(JSON.stringify(payload))).measurements[0].value, 8);
});

test('multi-day shortcut columns stay paired in original order and become separate daily totals', () => {
  const fields = {
    ...base, days: '7', states: '深度睡眠\n3\nREM',
    starts: '2026-11-08T23:00:00+08:00\n2026-11-06T23:00:00+08:00\n2026-11-07T23:00:00+08:00',
    ends: '2026-11-09T07:00:00+08:00\n2026-11-07T06:00:00+08:00\n2026-11-08T05:00:00+08:00',
  };
  const before = structuredClone(fields);
  const payload = buildQuickSleepPayload(fields);
  assert.equal(payload.sleepReport.days, 7);
  assert.deepEqual(payload.sleepReport.segments.map((segment) => segment.state), ['深度睡眠', '3', 'REM']);
  assert.deepEqual(payload.sleepReport.segments.map((segment) => segment.startDate), fields.starts.split('\n'));
  const parsed = parseMobileSyncPayload(payload);
  assert.deepEqual(parsed.measurements.map((record) => [record.id, record.value]), [
    ['sleep-report:2026-11-07', 7], ['sleep-report:2026-11-08', 6], ['sleep-report:2026-11-09', 8],
  ]);
  assert.deepEqual(fields, before);
});

test('range is explicit and bounded while old shortcuts retain a single day', () => {
  assert.ok(!Object.hasOwn(buildQuickSleepPayload(base).sleepReport, 'days'));
  assert.ok(!Object.hasOwn(buildQuickSleepPayload({ ...base, days: null }).sleepReport, 'days'));
  for (const days of ['1', '7', '30']) assert.equal(buildQuickSleepPayload({ ...base, days }).sleepReport.days, Number(days));
  for (const days of ['', '0', '31', '1.5', '-1', '7days', ' 7', '01']) {
    assert.throws(() => buildQuickSleepPayload({ ...base, days }), /1 至 30 天/);
  }
  const build = vm.runInNewContext('(' + buildQuickSleepPayload.toString() + ')', { TextEncoder, Intl, Date, JSON, Error });
  assert.equal(build({ ...base, days: '30' }).sleepReport.days, 30);
});

test('larger multi-day batches remain bounded independently of URL transport', () => {
  const payload = buildQuickSleepPayload({ ...base, days: '30',
    states: Array(3000).fill('1').join('\n'),
    starts: Array(3000).fill(base.starts).join('\n'),
    ends: Array(3000).fill(base.ends).join('\n'),
  });
  assert.equal(payload.sleepReport.segments.length, 3000);
  assert.equal(parseMobileSyncPayload(payload).measurements[0].value, 8);
});
