import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKUP_MAX_BYTES, BACKUP_TABLE_NAMES, BackupValidationError, backupDigest, parseDataBackup } from './data-backup.ts';
import type { DataBackup } from './data-backup.ts';
import { parseBackupInput, splitBackupVolumes } from './backup-volumes.ts';

const EXPORTED='2026-11-10T04:00:00.000Z';
const large:DataBackup={kind:'jiashu-os-backup',version:2,exportedAt:EXPORTED,tables:Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,[]])) as unknown as DataBackup['tables']};
large.tables.health_measurements=Array.from({length:20001},(_,index)=>{
  const id='volume-'+index,measurement={id,metric:'weight',value:70,unit:'kg',startDate:EXPORTED,source:'synthetic',aggregation:'sample'};
  return{record_key:'weight:'+id,metric:'weight',day:'2026-11-10',measurement_json:JSON.stringify(measurement),exported_at:EXPORTED,received_at:EXPORTED};
});
let prepared:ReturnType<typeof splitBackupVolumes>|undefined;
const fixture=()=>prepared??=splitBackupVolumes(large);

test('a complete set exceeds the old row ceiling while each volume remains bounded and may be selected out of order',async()=>{
  assert.throws(()=>parseDataBackup(large),BackupValidationError);
  const set=await fixture();assert.equal(set.volumes.length,2);assert.equal(set.manifest.totalRows,20001);
  for(const part of set.volumes)assert.ok(new TextEncoder().encode(JSON.stringify(part)).byteLength<=BACKUP_MAX_BYTES);
  const parsed=await parseBackupInput({...set,volumes:[...set.volumes].reverse()});
  assert.equal(parsed.backup.tables.health_measurements.length,20001);assert.equal(parsed.limits.maxRows,40000);
  assert.equal(await backupDigest(parsed.backup),set.manifest.setId);
  assert.equal(parsed.backup.tables.health_measurements.find((row)=>row.record_key==='weight:volume-20000')?.measurement_json,large.tables.health_measurements[20000].measurement_json);
});
test('missing, duplicated, mixed and modified volumes fail before any database action',async()=>{
  const set=await fixture();
  await assert.rejects(parseBackupInput({...set,volumes:set.volumes.slice(0,1)}),BackupValidationError);
  await assert.rejects(parseBackupInput({...set,volumes:[set.volumes[0],set.volumes[0]]}),BackupValidationError);
  const mixed=structuredClone(set);mixed.volumes[1].setId='f'.repeat(64);await assert.rejects(parseBackupInput(mixed),BackupValidationError);
  const edited=structuredClone(set);edited.volumes[1].tables.health_measurements[0].day='2026-11-09';await assert.rejects(parseBackupInput(edited),BackupValidationError);
});
test('manifest row counts, digests and unsupported fields cannot bypass logical backup validation',async()=>{
  const set=await fixture();
  const forged=structuredClone(set);forged.manifest.totalRows++;await assert.rejects(parseBackupInput(forged),BackupValidationError);
  const badDigest=structuredClone(set);badDigest.manifest.volumes[0].sha256='f'.repeat(64);await assert.rejects(parseBackupInput(badDigest),BackupValidationError);
  await assert.rejects(parseBackupInput({...set,extra:'unsupported'}),BackupValidationError);
});
