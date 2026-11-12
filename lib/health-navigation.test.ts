import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { HEALTH_NAVIGATION_SCRIPT, healthViewPath, readHealthView, readInitialHealthView } from './health-navigation.ts';

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

test('custom dates persist exact bounds through page and sync history without changing legacy days links',()=>{
  const view=readHealthView('?metric=sleep&from=2024-02-28&to=2024-03-01');
  assert.deepEqual(view,{metric:'sleep',days:3,from:'2024-02-28',to:'2024-03-01'});
  assert.equal(healthViewPath(view.metric,view.days,false,view),'/health?metric=sleep&from=2024-02-28&to=2024-03-01');
  assert.deepEqual(readInitialHealthView('/sync','',{healthView:view}),view);
  assert.match(readHealthView('?metric=sleep&from=2024-02-30&to=2024-03-01').rangeError!,/有效/);
});

test('literal browser navigation stays equivalent to typed helpers without captured server names', () => {
  const browser = runInNewContext(HEALTH_NAVIGATION_SCRIPT + '\n({readHealthView,healthViewPath,readInitialHealthView})', { URLSearchParams }) as {
    readHealthView: typeof readHealthView; healthViewPath: typeof healthViewPath; readInitialHealthView: typeof readInitialHealthView;
  };
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  for (const search of ['', '?metric=sleep&days=180', '?metric=weight', '?metric=bad&days=007', '?metric=active_energy&days=7']) {
    assert.deepEqual(plain(browser.readHealthView(search)), readHealthView(search));
  }
  for (const saved of [null, { healthView: { metric: 'sleep', days: 180 } }, { healthView: { metric: 'sleep', days: '180' } },
    { healthView: { metric: 'bad', days: 7 } }, { healthView: { metric: 'weight', days: 90, token: 'private' } }]) {
    assert.deepEqual(plain(browser.readInitialHealthView('/sync', '', saved)), readInitialHealthView('/sync', '', saved));
  }
  assert.equal(browser.healthViewPath('weight', 90, true), healthViewPath('weight', 90, true));
});
