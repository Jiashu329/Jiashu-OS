import assert from 'node:assert/strict';
import test from 'node:test';
import { healthViewPath, readHealthView, readInitialHealthView } from './health-navigation.ts';

test('health deep links restore valid metric and period while invalid filters fall back safely', () => {
  assert.deepEqual(readHealthView('?metric=sleep&days=180'), { metric: 'sleep', days: 180 });
  assert.deepEqual(readHealthView('?metric=weight'), { metric: 'weight', days: 90 });
  assert.deepEqual(readHealthView('?metric=unknown&days=15'), { metric: 'steps', days: 30 });
  assert.deepEqual(readHealthView('?metric=sleep&days=007'), { metric: 'sleep', days: 30 });
  assert.equal(healthViewPath('active_energy', 7), '/health?metric=active_energy&days=7');
  assert.equal(healthViewPath('weight', 90, true), '/health?metric=weight&days=90#goals');
});

test('sync restores only a complete valid filter snapshot and never copies arbitrary history data', () => {
  assert.deepEqual(readInitialHealthView('/sync', '', { healthView: { metric: 'sleep', days: 180 }, payload: 'private' }), { metric: 'sleep', days: 180 });
  for (const healthView of [null, [], { metric: 'sleep', days: '180' }, { metric: 'sleep', days: 15 },
    { metric: 'unknown', days: 180 }, { metric: 123, days: 180 }, { metric: 'sleep', days: 180, token: 'private' }]) {
    assert.deepEqual(readInitialHealthView('/sync', '', { healthView }), { metric: 'steps', days: 30 });
  }
  assert.deepEqual(readInitialHealthView('/health', '?metric=weight&days=7', { healthView: { metric: 'sleep', days: 180 } }), { metric: 'weight', days: 7 });
});
