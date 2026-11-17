import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupDigest, BackupValidationError } from '../../../lib/data-backup.ts';
import { parseBackupInput } from '../../../lib/backup-volumes.ts';

assert.ok(process.argv[2] && process.argv[3], 'Pass server fixture path and actual Swift output directory');
const original = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const output = process.argv[3];
const assembled = JSON.parse(readFileSync(join(output, 'assembled.json'), 'utf8'));
const preview = JSON.parse(readFileSync(join(output, 'preview-request.json'), 'utf8'));
const restore = JSON.parse(readFileSync(join(output, 'restore-request.json'), 'utf8'));
assert.equal(preview.action, 'preview');
assert.equal(restore.action, 'restore');
assert.equal(restore.previewHash, 'f'.repeat(64));
for (const value of [assembled, preview.backup, restore.backup]) {
  const parsed = await parseBackupInput(value);
  assert.equal(parsed.backup.tables.health_measurements.length, 20_001);
  assert.equal(await backupDigest(parsed.backup), original.manifest.setId);
  const boundary = parsed.backup.tables.health_measurements.find(row => row.record_key === 'weight:swift-backup-contract-20000');
  assert.ok(boundary, 'The record beyond the single-file row ceiling must survive');
  assert.equal(JSON.parse(boundary.measurement_json).source, 'synthetic / 合成 \"scale\"');
}
assert.equal(readFileSync(join(output, 'manifest.json'), 'utf8'), JSON.stringify(original.manifest), 'Manifest JSON property order must survive Swift transport');
for (let index = 0; index < original.volumes.length; index++) {
  const raw = readFileSync(join(output, 'part-' + (index + 1) + '.json'));
  assert.equal(raw.toString('utf8'), JSON.stringify(original.volumes[index]), 'Every signed volume must survive byte-for-byte');
  assert.equal(createHash('sha256').update(raw).digest('hex'), original.manifest.volumes[index].sha256);
  assert.equal(raw.byteLength, original.manifest.volumes[index].byteLength);
}
for (const mutate of [
  value => { value.volumes.pop(); },
  value => { value.volumes[1] = value.volumes[0]; },
  value => { value.volumes[1].setId = 'e'.repeat(64); },
  value => { value.volumes[1].tables.health_measurements[0].day = '2026-11-15'; },
]) {
  const modified = structuredClone(assembled); mutate(modified);
  await assert.rejects(parseBackupInput(modified), BackupValidationError, 'Damaged Swift-restored groups must fail before database work');
}
process.stdout.write('Node → Swift → Node backup contract: 20,001 rows and 2 real signed volumes verified.\n');
