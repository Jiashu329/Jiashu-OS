import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measurementDay, parseSyncPayload } from '../../../lib/health.ts';
import { parseAppleActivityPayload } from '../../../lib/apple-health-activity.ts';

// This script uses the production TypeScript parser directly, without npm
// dependencies. Its input must be the real Swift exporter's synthetic output.
assert.ok(process.argv[2], 'Pass the NDJSON file produced by ExportContractFixtures');
const expected = {
  'submillisecond-0004': { count: 5, exportedAt: '2026-11-16T00:00:00.000Z', days: ['2026-11-15', '2026-11-16'], sleepHours: 20 },
  'submillisecond-0006': { count: 5, exportedAt: '2026-11-16T00:00:00.000Z', days: ['2026-11-15', '2026-11-16'], sleepHours: 20 },
  'before-midnight-9998': { count: 5, exportedAt: '2026-11-15T15:59:59.999Z', days: ['2026-11-14', '2026-11-15'], sleepHours: 24 },
  'after-midnight-0002': { count: 3, exportedAt: '2026-11-15T16:00:00.000Z', days: ['2026-11-15'], sleepHours: 24 },
  'normal-five-metrics': { count: 5, exportedAt: '2026-11-16T07:00:00.000Z', days: ['2026-11-16'], sleepHours: 8 },
};
const lines = readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
assert.equal(lines.length, Object.keys(expected).length + 1, 'All boundary fixtures must reach the backend parser');
const seen = new Set();
for (const line of lines) {
  const fixture = JSON.parse(line);
  assert.ok(!seen.has(fixture.fixture), 'Duplicate fixture');
  seen.add(fixture.fixture);
  if (fixture.fixture === 'apple-activity-batches') {
    assert.ok(fixture.batches.length > 1, 'Workout history is split into batches');
    const batches = fixture.batches.map(parseAppleActivityPayload);
    assert.deepEqual(batches, fixture.batches, 'Parser accepts all fields in the real Apple activity payload');
    assert.ok(batches.every(batch => batch.exportedAt === '2026-11-16T02:00:00.000Z'));
    const vitals = batches.flatMap(batch => batch.vitals);
    const workouts = batches.flatMap(batch => batch.workouts);
    assert.equal(vitals.length, 1, 'Daily summaries are uploaded once per snapshot');
    assert.equal(vitals[0].day, '2026-11-16', 'A sample past Shanghai midnight belongs to the new day');
    assert.equal(vitals[0].oxygenSaturation.latest, 98, 'Blood oxygen uses percentage points');
    assert.equal(new Set(workouts.map(workout => workout.id)).size, 1_001);
    assert.equal(workouts.length, 1_001, 'Batching preserves all workouts');
    assert.equal(workouts[0].durationSeconds, 1_740, 'Active time survives independent of elapsed time');
    assert.equal(workouts[0].distanceMeters, 4_000);
    assert.ok(!('distanceMeters' in workouts[1] || 'energyKcal' in workouts[1]), 'Unavailable workout values stay absent');
    continue;
  }
  const specification = expected[fixture.fixture];
  assert.ok(specification, 'Unexpected fixture');
  const parsed = parseSyncPayload(fixture.payload);
  assert.deepEqual(parsed, fixture.payload, fixture.fixture + ': parser must accept the complete export without dropping records');
  assert.equal(parsed.measurements.length, specification.count, fixture.fixture + ': record count');
  assert.equal(parsed.exportedAt, specification.exportedAt, fixture.fixture + ': millisecond cutoff');
  assert.ok(Date.parse(parsed.exportedAt) <= fixture.captureEpochMilliseconds, fixture.fixture + ': cutoff must never advance past capture');
  const kinds = new Set(parsed.measurements.map(row => row.metric));
  assert.deepEqual(kinds, new Set(fixture.fixture === 'normal-five-metrics'
    ? ['steps', 'active_energy', 'sleep', 'weight', 'lean_body_mass'] : ['steps', 'active_energy', 'sleep']));
  for (const metric of ['steps', 'active_energy']) {
    const rows = parsed.measurements.filter(row => row.metric === metric);
    assert.deepEqual(rows.map(measurementDay), specification.days, fixture.fixture + ': real elapsed ' + metric + ' days');
    assert.ok(rows.every(row => Date.parse(row.endDate) <= Date.parse(parsed.exportedAt)), fixture.fixture + ': no future day boundary');
  }
  assert.equal(parsed.measurements.find(row => row.metric === 'steps').value, 0, 'A real zero remains a record');
  const sleep = parsed.measurements.find(row => row.metric === 'sleep');
  assert.equal(sleep.value, specification.sleepHours, fixture.fixture + ': sleep is computed from the exported interval');
  assert.equal(measurementDay(sleep), specification.days.at(-1), fixture.fixture + ': sleep report day');
  assert.equal(sleep.sleepTiming.clipped, fixture.fixture !== 'normal-five-metrics');
  assert.ok(Date.parse(sleep.sleepTiming.wake) <= Date.parse(sleep.endDate), fixture.fixture + ': sleep timing stays inside the report');
  if (fixture.fixture === 'normal-five-metrics') {
    assert.equal(sleep.sleepStages.deep, 2, 'Overlapping generic and deep sleep are not added twice');
    assert.equal(sleep.sleepStages.inBed, 10);
  }
}
process.stdout.write('Swift → TypeScript health export contract: ' + seen.size + ' boundary fixtures passed.\n');
