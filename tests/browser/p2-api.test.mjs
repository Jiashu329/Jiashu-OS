import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticState, DAY, ACCOUNT_ID } from './synthetic-api.mjs';
import { p2State, handleSyntheticP2, shiftDay } from './p2-api.mjs';
import { parseBackupInput } from '../../lib/backup-volumes.ts';

function fixture() {
  const state = syntheticState(), p2 = p2State(state);
  return { state, p2, async request(path, method = 'GET', body = null, key = null) {
    let result;
    const handled = await handleSyntheticP2({ state, url: new URL(path, 'http://127.0.0.1:4175'), method, body, key,
      route: { fulfill: async (value) => { result = value; } },
      send: async (value, status = 200) => { result = { status, body: value }; },
      fail: async (message, code, status = 409) => { result = { status, body: { error: message, code } }; } });
    assert.equal(handled, true, path);
    return result;
  } };
}

test('P2 browser DTOs use production range, timing, goal, runway and historical review builders', async () => {
  const f = fixture(), range = await f.request('/api/health?from=' + shiftDay(DAY,-5) + '&to=' + shiftDay(DAY,-1));
  assert.equal(range.body.range.days, 5);
  assert.equal(range.body.measurements.filter((row) => row.metric === 'sleep').length, 2);
  assert.equal(range.body.measurements.filter((row) => row.sleepTiming).length, 1);
  const goals = await f.request('/api/health/goals/progress');
  assert.equal(goals.body.metrics.length, 3); assert.equal(goals.body.metrics[0].days.length, 30);
  f.state.accounts[0].liquidityKind = 'restricted'; f.state.accounts[0].usableBps = 3750;
  f.state.accounts.push({ ...f.state.accounts[0], id: '22222222-2222-4222-8222-222222222222', type: 'investment', liquidityKind: 'unreviewed', usableBps: 0, balanceMinor: '100000' });
  const runway = await f.request('/api/finance/runway');
  assert.equal(runway.body.progress.currentMinor, '3750'); assert.equal(runway.body.progress.unreviewedAccountCount, 1);
  f.state.accounts = [f.state.accounts[0]]; f.state.accounts[0].type = 'loan';
  f.p2.reviewClassifications = [{ accountId: ACCOUNT_ID, revision: 1, effectiveFrom: '1970-01-01', type: 'bank', archived: 0, origin: 'baseline', recordedAt: DAY.slice(0,7) + '-01T00:00:00Z' }, { accountId: ACCOUNT_ID, revision: 2, effectiveFrom: DAY.slice(0,7) + '-01', type: 'loan', archived: 0, origin: 'change', recordedAt: DAY.slice(0,7) + '-01T01:00:00Z' }];
  const review = await f.request('/api/finance/review?month=' + DAY.slice(0,7));
  assert.equal(review.body.change.comparableNetMinor, '0'); assert.equal(review.body.change.reclassificationNetMinor, '-20000'); assert.equal(review.body.historicalAssumptions.length, 1);
});

test('synthetic weight-cycle receipts replay their original result and preserve frozen archives across a new cycle', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/health/weight-plan')).body.observations.recordedDays7, 7);
  const command = { action: 'archive', expectedRevision: 1 };
  const archive = await f.request('/api/health/weight-plan/cycles', 'POST', command, 'synthetic-archive');
  assert.equal(archive.body.settings.enabled, false); assert.equal(archive.body.settings.revision, 2); assert.equal(f.p2.cycles.length, 1);
  const frozen = structuredClone(f.p2.cycles[0]);
  const start = { action: 'start', expectedRevision: 2, plan: { baselineWeight: 74.9, targetWeight: 73, startDate: DAY, deadline: shiftDay(DAY,60), enabled: true } };
  await f.request('/api/health/weight-plan/cycles', 'POST', start, 'synthetic-start');
  assert.equal(f.p2.weightSettings.revision, 3); assert.deepEqual(f.p2.cycles[0], frozen);
  const replay = await f.request('/api/health/weight-plan/cycles', 'POST', command, 'synthetic-archive');
  assert.equal(replay.body.replayed, true); assert.equal(replay.body.settings.revision, 2); assert.equal(f.p2.weightSettings.revision, 3);
});

test('synthetic backup volumes round-trip through real digest validation and preview conflicts expose field comparisons', async () => {
  const f = fixture();
  f.p2.backup.tables.health_goal_settings.push({ steps_target: 10000, sleep_target: null, active_energy_target: null, updated_at: f.p2.backup.exportedAt, revision: 0 });
  const set = (await f.request('/api/data/backup?format=volumes')).body;
  assert.equal(set.volumes.length, 1); assert.equal((await parseBackupInput(set)).backup.tables.health_goal_settings.length, 1);
  f.p2.backupConflict = true;
  const preview = await f.request('/api/data/backup', 'POST', { action: 'preview', backup: set });
  assert.equal(preview.body.canRestore, false); assert.equal(preview.body.total.conflicts, 1); assert.deepEqual(preview.body.tables[0].conflictExamples[0].differences[0], { field: 'steps_target', current: '6000', incoming: '10000' });
  assert.equal((await f.request('/api/data/backup', 'POST', { action: 'preview', backup: { ...set, volumes: [] } })).status, 400);
  assert.equal((await f.request('/api/data/backup', 'POST', { action: 'restore', backup: set })).status, 403);
});
