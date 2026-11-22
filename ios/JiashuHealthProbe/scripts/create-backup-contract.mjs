import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_TABLE_NAMES } from '../../../lib/data-backup.ts';
import { splitBackupVolumes, parseBackupInput } from '../../../lib/backup-volumes.ts';

assert.ok(process.argv[2], 'Pass a synthetic fixture output directory');
const directory = process.argv[2];
mkdirSync(directory, { recursive: true });
const exportedAt = '2026-11-16T04:00:00.000Z';
const backup = { kind: 'jiashu-os-backup', version: 2, exportedAt,
  tables: Object.fromEntries(BACKUP_TABLE_NAMES.map(table => [table, []])) };
// 20,001 legitimate point samples force two production volumes by row limit.
// The Chinese/source punctuation and original property order exercise the raw
// JSON path rather than a sorted Swift re-encoding of the signed documents.
backup.tables.health_measurements = Array.from({ length: 20_001 }, (_, index) => {
  const id = 'swift-backup-contract-' + index;
  const measurement = { id, metric: 'weight', value: 70.125, unit: 'kg', startDate: exportedAt,
    source: 'synthetic / 合成 "scale"', aggregation: 'sample' };
  return { record_key: 'weight:' + id, metric: 'weight', day: '2026-11-16',
    measurement_json: JSON.stringify(measurement), exported_at: exportedAt, received_at: exportedAt };
});
backup.tables.health_apple_vitals = [{ day: '2026-11-16', metric: 'oxygenSaturation',
  value_json: JSON.stringify({ average: 97.1, min: 96, max: 98.2, latest: 96, count: 2, measuredAt: exportedAt }),
  exported_at: exportedAt, received_at: exportedAt }];
const workout = { id: '11111111-1111-4111-8111-111111111111', activityType: 37,
  startDate: '2026-11-16T03:00:00.000Z', endDate: exportedAt, durationSeconds: 3480, energyKcal: 335.5 };
backup.tables.health_apple_workouts = [{ workout_id: workout.id, day: '2026-11-16', start_date: workout.startDate,
  workout_json: JSON.stringify(workout), exported_at: exportedAt, received_at: exportedAt }];
const set = await splitBackupVolumes(backup);
assert.equal(set.volumes.length, 2);
assert.equal(set.manifest.totalRows, 20_003);
assert.equal((await parseBackupInput(set)).backup.tables.health_measurements.length, 20_001);
writeFileSync(join(directory, 'server-backup-set.json'), JSON.stringify(set));
process.stdout.write('Created production-signed synthetic backup: 20,003 rows, 2 volumes.\n');
