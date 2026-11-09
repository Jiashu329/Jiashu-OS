import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuickStepsPayload } from './quick-steps.ts';
import { parseSyncPayload } from './health.ts';

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
  for (const value of ['8,200', '8，200', '8 200', '8\u202f200', '8200.0']) {
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
