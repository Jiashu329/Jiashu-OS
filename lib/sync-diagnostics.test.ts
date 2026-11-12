import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSyncDiagnostics, summarizeSyncMeasurements } from './sync-diagnostics.ts';
import type { HealthMeasurement } from './health.ts';
import type { SyncImportDiagnostic } from './sync-diagnostics.ts';

const NOW = '2026-11-12T02:00:00.000Z';
function record(metric: HealthMeasurement['metric'], day: string, id = day): HealthMeasurement {
  return { id, metric, value: metric === 'steps' ? 1234 : 65, unit: metric === 'steps' ? 'count' : 'kg', startDate: day + 'T01:00:00.000Z' };
}

void test('coverage counts distinct observed days, includes Shanghai today and excludes future dates', () => {
  const view = buildSyncDiagnostics([
    record('weight', '2026-11-12', 'first'), record('weight', '2026-11-12', 'second'),
    record('weight', '2026-11-06'), record('weight', '2026-10-14'), record('weight', '2026-10-13'),
    record('weight', '2026-11-13'),
  ], [], NOW);
  const weight = view.metrics.find((row) => row.metric === 'weight')!;
  assert.equal(weight.latestDay, '2026-11-12');
  assert.equal(weight.observedDays7, 2);
  assert.equal(weight.observedDays30, 3);
  assert.equal(weight.lastImport, null);
  assert.equal(view.metrics.length, 5);
});

void test('a recent step or empty batch receipt does not refresh other metrics', () => {
  const receipt: SyncImportDiagnostic = { scope: 'batch', receivedAt: NOW, exportedAt: NOW, submittedCount: 0,
    importedCount: 0, skippedCount: 0, firstDay: null, lastDay: null };
  const view = buildSyncDiagnostics([record('steps', '2026-11-12'), record('weight', '2026-10-01')], [receipt], NOW);
  assert.equal(view.lastImport?.submittedCount, 0);
  assert.equal(view.metrics.find((row) => row.metric === 'steps')!.freshness, 'current');
  const weight = view.metrics.find((row) => row.metric === 'weight')!;
  assert.equal(weight.freshness, 'stale');
  assert.equal(weight.latestDay, '2026-10-01');
  assert.equal(weight.observedDays30, 0);
  assert.equal(weight.lastImport, null);
  assert.equal(view.metrics.find((row) => row.metric === 'sleep')!.freshness, 'missing');
});

void test('import summaries retain sample counts while ranges use measurement dates', () => {
  assert.deepEqual(summarizeSyncMeasurements([
    record('weight', '2026-11-12', 'a'), record('weight', '2026-11-12', 'b'), record('steps', '2026-11-10'),
  ]), [
    { metric: 'weight', submittedCount: 2, firstDay: '2026-11-12', lastDay: '2026-11-12' },
    { metric: 'steps', submittedCount: 1, firstDay: '2026-11-10', lastDay: '2026-11-10' },
  ]);
  assert.deepEqual(summarizeSyncMeasurements([]), []);
});
