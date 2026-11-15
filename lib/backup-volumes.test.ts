import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKUP_MAX_BYTES, BACKUP_TABLE_NAMES, BACKUP_PRE_DOUBAN_V2_TABLE_NAMES, BACKUP_PREVIOUS_V2_TABLE_NAMES, BackupValidationError, backupDigest, parseDataBackup } from './data-backup.ts';
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

void test('a complete set exceeds the old row ceiling while each volume remains bounded and may be selected out of order',async()=>{
  assert.throws(()=>parseDataBackup(large),BackupValidationError);
  const set=await fixture();assert.equal(set.volumes.length,2);assert.equal(set.manifest.totalRows,20001);
  for(const part of set.volumes)assert.ok(new TextEncoder().encode(JSON.stringify(part)).byteLength<=BACKUP_MAX_BYTES);
  const parsed=await parseBackupInput({...set,volumes:[...set.volumes].reverse()});
  assert.equal(parsed.backup.tables.health_measurements.length,20001);assert.equal(parsed.limits.maxRows,40000);
  assert.equal(await backupDigest(parsed.backup),set.manifest.setId);
  assert.equal(parsed.backup.tables.health_measurements.find((row)=>row.record_key==='weight:volume-20000')?.measurement_json,large.tables.health_measurements[20000].measurement_json);
});
void test('missing, duplicated, mixed and modified volumes fail before any database action',async()=>{
  const set=await fixture();
  await assert.rejects(parseBackupInput({...set,volumes:set.volumes.slice(0,1)}),BackupValidationError);
  await assert.rejects(parseBackupInput({...set,volumes:[set.volumes[0],set.volumes[0]]}),BackupValidationError);
  const mixed=structuredClone(set);mixed.volumes[1].setId='f'.repeat(64);await assert.rejects(parseBackupInput(mixed),BackupValidationError);
  const edited=structuredClone(set);edited.volumes[1].tables.health_measurements[0].day='2026-11-09';await assert.rejects(parseBackupInput(edited),BackupValidationError);
});
void test('manifest row counts, digests and unsupported fields cannot bypass logical backup validation',async()=>{
  const set=await fixture();
  const forged=structuredClone(set);forged.manifest.totalRows++;await assert.rejects(parseBackupInput(forged),BackupValidationError);
  const badDigest=structuredClone(set);badDigest.manifest.volumes[0].sha256='f'.repeat(64);await assert.rejects(parseBackupInput(badDigest),BackupValidationError);
  await assert.rejects(parseBackupInput({...set,extra:'unsupported'}),BackupValidationError);
});

void test('published 27-table volume digests are verified before adding the new empty action tables',async()=>{
  const tables=Object.fromEntries(BACKUP_PREVIOUS_V2_TABLE_NAMES.map((table)=>[table,table==='health_measurements'?large.tables.health_measurements.slice(0,1):[]]));
  const signed={kind:'jiashu-os-backup',version:2,exportedAt:EXPORTED,tables},setId=await backupDigest(signed);
  const volume={kind:'jiashu-os-backup-volume',version:1,setId,exportedAt:EXPORTED,partIndex:1,totalParts:1,tables};
  const descriptor={partIndex:1,rowCount:1,byteLength:new TextEncoder().encode(JSON.stringify(volume)).byteLength,sha256:await backupDigest(volume)};
  const set={kind:'jiashu-os-backup-set',version:1,manifest:{kind:'jiashu-os-backup-manifest',version:1,backupVersion:2,setId,exportedAt:EXPORTED,totalRows:1,volumes:[descriptor]},volumes:[volume]};
  const parsed=await parseBackupInput(set);
  assert.equal(parsed.backup.tables.health_measurements.length,1);
  assert.equal(Object.keys(parsed.backup.tables).length,31);
  assert.deepEqual(parsed.backup.tables.health_weekly_actions,[]);assert.deepEqual(parsed.backup.tables.finance_month_closes,[]);
  assert.deepEqual(parsed.backup.tables.douban_items,[]);
  const changed=structuredClone(set);changed.volumes[0].tables.health_measurements[0].received_at='2026-11-11T00:00:00.000Z';
  await assert.rejects(parseBackupInput(changed),BackupValidationError);
});

async function signedSingleVolume(tables: Record<string, unknown[]>) {
  const signed={kind:'jiashu-os-backup',version:2,exportedAt:EXPORTED,tables},setId=await backupDigest(signed);
  const volume={kind:'jiashu-os-backup-volume',version:1,setId,exportedAt:EXPORTED,partIndex:1,totalParts:1,tables};
  const rowCount=Object.values(tables).reduce((sum,rows)=>sum+rows.length,0);
  const descriptor={partIndex:1,rowCount,byteLength:new TextEncoder().encode(JSON.stringify(volume)).byteLength,sha256:await backupDigest(volume)};
  return {kind:'jiashu-os-backup-set',version:1,manifest:{kind:'jiashu-os-backup-manifest',version:1,backupVersion:2,setId,exportedAt:EXPORTED,totalRows:rowCount,volumes:[descriptor]},volumes:[volume]};
}

void test('the published 30-table signed shape remains frozen and verifies before adding empty Douban records',async()=>{
  assert.equal(BACKUP_PRE_DOUBAN_V2_TABLE_NAMES.length,30);
  assert.equal(BACKUP_PREVIOUS_V2_TABLE_NAMES.length,27);
  assert.equal(BACKUP_TABLE_NAMES.length,31);
  assert.equal((BACKUP_PRE_DOUBAN_V2_TABLE_NAMES as readonly string[]).includes('douban_items'),false);
  const tables=Object.fromEntries(BACKUP_PRE_DOUBAN_V2_TABLE_NAMES.map(table=>[table,table==='health_measurements'?large.tables.health_measurements.slice(0,1):[]]));
  const set=await signedSingleVolume(tables);
  const parsed=await parseBackupInput(set);
  assert.equal(parsed.backup.tables.health_measurements.length,1);
  assert.deepEqual(parsed.backup.tables.douban_items,[]);
  assert.notEqual(await backupDigest(parsed.backup),set.manifest.setId,'normalising a prior signed shape must not pretend its original digest covered a new table');
});

void test('valid hashes cannot turn same-length unknown table sets into a supported signed shape',async()=>{
  for(const names of [BACKUP_TABLE_NAMES,BACKUP_PRE_DOUBAN_V2_TABLE_NAMES,BACKUP_PREVIOUS_V2_TABLE_NAMES]){
    const tables=Object.fromEntries(names.map(table=>[table,[]]));
    delete tables.health_syncs;tables.unsupported_table=[];
    await assert.rejects(parseBackupInput(await signedSingleVolume(tables)),BackupValidationError);
  }
});

void test('new signed sets include canonical personal Douban records and preserve nullable fields',async()=>{
  const backup:DataBackup={kind:'jiashu-os-backup',version:2,exportedAt:EXPORTED,tables:Object.fromEntries(BACKUP_TABLE_NAMES.map(table=>[table,[]])) as unknown as DataBackup['tables']};
  backup.tables.douban_items.push({profile_id:'synthetic-owner',domain:'music',subject_id:'1234567',kind:'music',title:'合成音乐条目',url:'https://music.douban.com/subject/1234567/',cover_url:null,rating:null,marked_date:null,comment:null,published_at:'2026-11-09T04:00:00.000Z',source:'rss',details_json:'{}',local_note:'',local_tags_json:'[]',local_hidden:0,local_revision:0,local_cover_url:null,tmdb_cover_json:'{}',observed_at:EXPORTED,created_at:EXPORTED,updated_at:EXPORTED});
  const set=await splitBackupVolumes(backup);
  assert.equal(Object.keys(set.volumes[0].tables).length,31);
  assert.equal(set.manifest.totalRows,1);
  const parsed=await parseBackupInput(set);
  assert.deepEqual(parsed.backup.tables.douban_items,backup.tables.douban_items);
  assert.equal(await backupDigest(parsed.backup),set.manifest.setId);
});

void test('published 31-table volume rows without details verify their original signature before normalization',async()=>{
  const row={profile_id:'synthetic-owner',domain:'book',subject_id:'1234567',kind:'book',title:'合成旧书籍条目',url:'https://book.douban.com/subject/1234567/',cover_url:null,rating:4,marked_date:'2026-11-09',comment:null,published_at:null,source:'import',observed_at:EXPORTED,created_at:EXPORTED,updated_at:EXPORTED};
  const tables=Object.fromEntries(BACKUP_TABLE_NAMES.map(table=>[table,table==='douban_items'?[row]:[]]));
  const set=await signedSingleVolume(tables),parsed=await parseBackupInput(set);
  assert.equal(Object.keys(parsed.backup.tables).length,31);
  assert.deepEqual(parsed.backup.tables.douban_items,[{details_json:'{}',local_note:'',local_tags_json:'[]',local_hidden:0,local_revision:0,local_cover_url:null,tmdb_cover_json:'{}',...row}]);
  assert.notEqual(await backupDigest(parsed.backup),set.manifest.setId);
  const edited=structuredClone(set);(edited.volumes[0].tables.douban_items[0] as Record<string,unknown>).title='被修改的旧记录';
  await assert.rejects(parseBackupInput(edited),BackupValidationError);
});
