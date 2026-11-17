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
const set = await splitBackupVolumes(backup);
assert.equal(set.volumes.length, 2);
assert.equal(set.manifest.totalRows, 20_001);
assert.equal((await parseBackupInput(set)).backup.tables.health_measurements.length, 20_001);
writeFileSync(join(directory, 'server-backup-set.json'), JSON.stringify(set));
process.stdout.write('Created production-signed synthetic backup: 20,001 rows, 2 volumes.\n');
