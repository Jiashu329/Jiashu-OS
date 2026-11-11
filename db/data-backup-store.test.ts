import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { BACKUP_TABLE_NAMES, BACKUP_V1_TABLE_NAMES, BackupValidationError, comparableBackupRow, parseDataBackup } from '../lib/data-backup.ts';
import { BackupConflictError, exportDataBackup, previewDataRestore, restoreDataBackup } from './data-backup-store.ts';
import { previewHealthImport, writeHealthImport } from './health-import-store.ts';
import { parseSyncPayload } from '../lib/health.ts';
import { writeHealthRecord } from './health-records-store.ts';
import { parseHealthRecordCreate } from '../lib/health-records.ts';
import { changeFinanceBalance, FinanceBalanceChangeConflictError, previewFinanceBalanceChange } from './finance-balance-changes-store.ts';
import { readGoalSettings, writeGoalSettings, HealthGoalConflictError } from './health-goals-store.ts';
import { readWeightPlanSettings, writeWeightPlanSettings, WeightPlanConflictError } from './weight-plan-store.ts';
import { readFinanceRunwaySettings, writeFinanceRunwaySettings, FinanceRunwayConflictError } from './finance-runway-store.ts';
import { createNutritionEntry } from './nutrition-store.ts';
import { saveNutritionFavorite, previewNutritionCopy, copyNutritionMeal } from './nutrition-reuse-store.ts';
import { recordSyncAttempt } from './sync-attempts-store.ts';
import { goalTargetsForDay } from '../lib/health-goals.ts';
import type { DataBackup } from '../lib/data-backup.ts';

const NOW='2026-11-10T04:00:00.000Z'; const OLD='2024-01-01T04:00:00.000Z';
const A='11111111-1111-4111-8111-111111111111'; const B='22222222-2222-4222-8222-222222222222'; const C='33333333-3333-4333-8333-333333333333'; const D='44444444-4444-4444-8444-444444444444'; const E='55555555-5555-4555-8555-555555555555'; const HASH='a'.repeat(64);
interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T|null>; all<T>(): Promise<{results:T[]}>; execute(): {results:unknown[];meta:{changes:number}} }
function fixture(t: TestContext) {
  const sqlite=new DatabaseSync(':memory:'); const directory=new URL('../drizzle/',import.meta.url);
  for (const name of readdirSync(directory).filter((n)=>/^\d+.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(name,directory),'utf8'));
  t.after(()=>sqlite.close()); let beforeBatch:(()=>void)|null=null; let mutate=false;
  const db={prepare(sql:string){const query=sqlite.prepare(sql);let values:SQLInputValue[]=[]; const statement:Statement={bind(...args){values=args as SQLInputValue[];return statement;},async first<T>(){return(query.get(...values) as T|undefined)??null;},async all<T>(){return{results:query.all(...values) as T[]};},execute(){if(query.columns().length)return{results:query.all(...values),meta:{changes:0}};return{results:[],meta:{changes:Number(query.run(...values).changes)}};}};return statement;},async batch(statements:Statement[]){if(mutate){mutate=false;beforeBatch?.();}sqlite.exec('BEGIN');try{const result=statements.map((s)=>s.execute());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as D1Database;
  return{sqlite,db,mutateNextBatch(fn:()=>void){beforeBatch=fn;mutate=true;}};
}
async function seed(db:D1Database,sqlite:DatabaseSync,owner='alice') {
  const payload=parseSyncPayload({version:1,source:'apple-health-shortcuts',timezone:'Asia/Shanghai',exportedAt:NOW,measurements:[{id:'old-weight',metric:'weight',value:70,unit:'kg',startDate:OLD,source:'synthetic scale',aggregation:'sample'}]});
  let preview=await previewHealthImport(db,owner,payload); await writeHealthImport(db,owner,payload,null,{previewToken:preview.token},NOW);
  const newer={...payload,exportedAt:'2026-11-10T05:00:00.000Z'}; preview=await previewHealthImport(db,owner,newer);await writeHealthImport(db,owner,newer,null,{previewToken:preview.token},'2026-11-10T05:00:00.000Z');
  const command=parseHealthRecordCreate({metric:'steps',value:1234,date:'2026-11-09',capturedAt:NOW,reason:'synthetic'},A,Date.parse(NOW));await writeHealthRecord(db,owner,command,A,NOW);
  await writeGoalSettings(db,owner,{steps:6000,sleep:8,active_energy:400},0,'2026-11-10',NOW);
  await writeWeightPlanSettings(db,owner,{baselineWeight:70,targetWeight:68,startDate:'2026-11-01',deadline:'2026-12-31',enabled:true},0,NOW);
  sqlite.prepare('INSERT INTO nutrition_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(B,owner,'2026-11-09','breakfast','synthetic oats','one bowl','',null,HASH,1,NOW,NOW,NOW);
  sqlite.prepare('INSERT INTO finance_accounts (id,user_id,ledger,name,type,currency,creation_hash,note,created_at,updated_at,archived_at,balance_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(C,owner,'personal','synthetic cash','bank','CNY',HASH,'',NOW,NOW,null,1);
  sqlite.prepare('INSERT INTO finance_balance_entries (sequence,id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(20,'initial:'+C,owner,C,'9007199254740993','2026-11-08','initial',NOW);
  sqlite.prepare('INSERT INTO finance_balance_entries (sequence,id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(50,D,owner,C,'9007199254740994','2026-11-08','later',NOW);
  sqlite.prepare('INSERT INTO finance_balance_changes (sequence,id,user_id,account_id,entry_id,revision,action,amount_minor,as_of_date,note,reason,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(30,E,owner,C,D,1,'correct','9007199254740995','2026-11-07','','synthetic correction',HASH,NOW);
  sqlite.prepare('INSERT INTO finance_goal_plans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(A,owner,'personal','CNY','synthetic goal','100000','2026-12-31',JSON.stringify([C]),HASH,NOW,NOW,NOW);
  await writeFinanceRunwaySettings(db,owner,'personal','CNY',{monthlyExpenseMinor:'500000',targetMonths:6,accountIds:[C]},0,NOW);
  const foodId='66666666-6666-4666-8666-666666666666';
  await createNutritionEntry(db,owner,{date:'2026-11-08',meal:'breakfast',name:'synthetic rice',portion:'one bowl',note:'',caloriesTenth:0},foodId,NOW);
  await saveNutritionFavorite(db,owner,{entryId:foodId,expectedRevision:1},'77777777-7777-4777-8777-777777777777',NOW);
  const selection={fromDate:'2026-11-08',fromMeal:'breakfast' as const,toDate:'2026-11-09',toMeal:'lunch' as const};
  const copied=await previewNutritionCopy(db,owner,selection);
  await copyNutritionMeal(db,owner,selection,copied.previewToken,'88888888-8888-4888-8888-888888888888',NOW);
  await recordSyncAttempt(db,owner,{channel:'manual',status:'failed',errorCode:'SYNC_INVALID_FORMAT'},NOW,'99999999-9999-4999-8999-999999999999');
  sqlite.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?,?)').run('device',owner,'synthetic device','synthetic-token-hash',NOW,null,null);
}
function semantic(backup:DataBackup){return Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,backup.tables[table].map((row)=>comparableBackupRow(table,row))]));}

void test('complete backup roundtrips old records, real import receipts, edits, deleted nutrition and exact ordered finance history',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite); const backup=await exportDataBackup(source.db,'alice',NOW);
  assert.equal(backup.tables.health_measurements[0].day,'2024-01-01');assert.equal(backup.tables.health_import_batches.length,2);assert.equal(JSON.parse(backup.tables.health_import_batches[1].receipt_json as string).imported,0);
  assert.equal(backup.version,2); assert.equal(BACKUP_TABLE_NAMES.length,17);
  for (const table of ['health_goal_versions','health_sync_attempts','nutrition_favorites','nutrition_copy_operations'] as const) assert.ok(backup.tables[table].length>0);
  assert.equal(JSON.stringify(backup).includes('user_id'),false);assert.equal(JSON.stringify(backup).includes('synthetic-token-hash'),false);
  const target=fixture(t);let preview=await previewDataRestore(target.db,'restored-owner',backup);assert.equal(preview.canRestore,true);assert.ok(preview.total.added>0);
  const result=await restoreDataBackup(target.db,'restored-owner',backup,preview.previewHash);assert.equal(result.added,preview.total.added);
  const after=await exportDataBackup(target.db,'restored-owner',NOW);assert.deepEqual(semantic(after),semantic(backup));
  assert.deepEqual(target.sqlite.prepare('SELECT id FROM finance_balance_entries ORDER BY sequence').all().map((row)=>row.id),['initial:'+C,D]);
  assert.equal(target.sqlite.prepare('SELECT amount_minor FROM finance_balance_entries WHERE id=?').get(D)?.amount_minor,'9007199254740994');
  preview=await previewDataRestore(target.db,'restored-owner',backup);assert.equal(preview.total.added,0);assert.equal(preview.total.conflicts,0);const repeat=await restoreDataBackup(target.db,'restored-owner',backup,preview.previewHash);assert.equal(repeat.added,0);
});

function legacyV1(backup:DataBackup) {
  const tables=Object.fromEntries(BACKUP_V1_TABLE_NAMES.map((table)=>[table,backup.tables[table].map((row)=>Object.fromEntries(Object.entries(row).filter(([key])=>!(key==='revision'&&['health_goal_settings','health_weight_plan_settings','finance_runway_settings'].includes(table)))))]));
  return {kind:'jiashu-os-backup',version:1,exportedAt:backup.exportedAt,tables};
}
void test('v45 v1 backups remain restorable and upgrade zero revisions without allowing old empty-page writes',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const current=await exportDataBackup(source.db,'alice',NOW);const legacy=legacyV1(current);const target=fixture(t);
  const normalized=parseDataBackup(legacy);assert.equal(normalized.version,2);assert.equal(normalized.tables.health_goal_settings[0].revision,0);assert.deepEqual(normalized.tables.nutrition_favorites,[]);
  const preview=await previewDataRestore(target.db,'alice',legacy);assert.equal(preview.generatedGoalHistoryRows,2);
  const result=await restoreDataBackup(target.db,'alice',legacy,preview.previewHash);assert.equal(result.generatedGoalHistoryRows,2);
  const goals=await readGoalSettings(target.db,'alice');assert.equal(goals.revision,1);assert.deepEqual(goals.history?.map((v)=>[v.revision,v.effectiveFrom]),[[0,'1970-01-01'],[1,'1970-01-01']]);
  assert.equal(goalTargetsForDay(goals,'2026-01-01').targets.steps,6000);
  assert.equal((await readWeightPlanSettings(target.db,'alice'))?.revision,1);assert.equal((await readFinanceRunwaySettings(target.db,'alice','personal','CNY'))?.revision,1);
  await assert.rejects(writeGoalSettings(target.db,'alice',{steps:9999,sleep:8,active_energy:400},0,'2026-11-10'),HealthGoalConflictError);
  await assert.rejects(writeWeightPlanSettings(target.db,'alice',{baselineWeight:70,targetWeight:60,startDate:'2026-11-01',deadline:'2026-12-31',enabled:true},0),WeightPlanConflictError);
  await assert.rejects(writeFinanceRunwaySettings(target.db,'alice','personal','CNY',{monthlyExpenseMinor:'100',targetMonths:1,accountIds:[C]},0),FinanceRunwayConflictError);
  const repeat=await previewDataRestore(target.db,'alice',legacy);assert.equal(repeat.canRestore,true);assert.equal(repeat.total.added,0);assert.equal(repeat.total.conflicts,0);assert.equal((await restoreDataBackup(target.db,'alice',legacy,repeat.previewHash)).added,0);
  const before=target.sqlite.prepare('SELECT count(*) n FROM health_goal_versions').get()?.n;
  assert.equal(before,2);assert.equal((await readGoalSettings(target.db,'alice')).targets.steps,6000);
});

void test('new backup tables reject invalid receipts, references and goal history before any write',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const original=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);
  const mutations:Array<(b:DataBackup)=>void>=[
    (b)=>{b.tables.nutrition_favorites[0].calories_tenth=200001;},
    (b)=>{b.tables.nutrition_copy_operations[0].entry_ids_json=JSON.stringify(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);},
    (b)=>{b.tables.health_sync_attempts[0].error_code='raw request text';},
    (b)=>{const summary=JSON.parse(b.tables.health_sync_attempts[0].summary_json as string);summary.rawPayload='not allowed';b.tables.health_sync_attempts[0].summary_json=JSON.stringify(summary);},
    (b)=>{b.tables.health_goal_versions[1].effective_from='2099-01-01';},
    (b)=>{b.tables.health_goal_settings[0].revision=2;},
    (b)=>{b.tables.health_goal_settings=[];},
    (b)=>{b.tables.health_goal_versions[1].steps_target=9999;},
  ];
  for (const mutate of mutations){const backup=structuredClone(original);mutate(backup);await assert.rejects(previewDataRestore(target.db,'alice',backup),BackupValidationError);}
  for(const table of BACKUP_TABLE_NAMES)assert.equal(target.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()?.n,0);
  const badLegacy=legacyV1(original);(badLegacy.tables as Record<string,unknown>).nutrition_favorites=[];assert.throws(()=>parseDataBackup(badLegacy),BackupValidationError);
});

void test('a favorite owned by another user blocks the whole restore without exposing or changing its content',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const backup=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);const favorite=backup.tables.nutrition_favorites[0];
  target.sqlite.prepare('INSERT INTO nutrition_favorites (id,user_id,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(String(favorite.id),'bob','private synthetic favorite','','',null,HASH,1,NOW,NOW,null);
  const preview=await previewDataRestore(target.db,'alice',backup);assert.equal(preview.canRestore,false);assert.equal(preview.tables.find((v)=>v.table==='nutrition_favorites')?.conflicts,1);assert.equal(JSON.stringify(preview).includes('private synthetic favorite'),false);
  await assert.rejects(restoreDataBackup(target.db,'alice',backup,preview.previewHash),BackupConflictError);assert.equal(target.sqlite.prepare('SELECT count(*) n FROM finance_accounts').get()?.n,0);assert.equal(target.sqlite.prepare('SELECT name FROM nutrition_favorites').get()?.name,'private synthetic favorite');
});

void test('existing goal history is never supplemented while its old revision remains valid',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const backup=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);
  await writeGoalSettings(target.db,'alice',{steps:6000,sleep:8,active_energy:400},0,'2026-11-10',NOW);
  target.sqlite.prepare('DELETE FROM health_goal_versions WHERE user_id=? AND revision=0').run('alice');
  const preview=await previewDataRestore(target.db,'alice',backup);assert.equal(preview.canRestore,false);assert.equal(preview.tables.find((v)=>v.table==='health_goal_versions')?.conflicts,1);
  await assert.rejects(restoreDataBackup(target.db,'alice',backup,preview.previewHash),BackupConflictError);assert.equal((await readGoalSettings(target.db,'alice')).revision,1);assert.equal(target.sqlite.prepare('SELECT count(*) n FROM finance_accounts').get()?.n,0);
});
void test('invalid nested health values, unknown fields, missing relations and duplicate keys fail before writes',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const original=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);
  for(const mutate of [(b:DataBackup)=>{b.tables.health_measurements[0].measurement_json=JSON.stringify({metric:'weight',value:9000});},(b:DataBackup)=>{b.tables.finance_accounts[0].user_id='mallory';},(b:DataBackup)=>{b.tables.finance_accounts=[];},(b:DataBackup)=>{b.tables.nutrition_entries.push({...b.tables.nutrition_entries[0]});},(b:DataBackup)=>{b.tables.health_record_changes[0].after_state_json=JSON.stringify({recordKey:'forged'});}]){
    const backup=structuredClone(original);mutate(backup);await assert.rejects(previewDataRestore(target.db,'alice',backup),BackupValidationError);
  }
  for(const table of BACKUP_TABLE_NAMES)assert.equal(target.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n,0);
});
void test('foreign global IDs are conflicts and neither user data nor other tables are modified',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const backup=await exportDataBackup(source.db,'alice',NOW);const preview=await previewDataRestore(source.db,'bob',backup);assert.equal(preview.canRestore,false);assert.ok(preview.total.conflicts>0);
  await assert.rejects(restoreDataBackup(source.db,'bob',backup,preview.previewHash),BackupConflictError);assert.equal(source.sqlite.prepare('SELECT count(*) n FROM health_measurements WHERE user_id=?').get('bob')?.n,0);
  assert.equal(source.sqlite.prepare('SELECT name FROM finance_accounts WHERE id=?').get(C)?.name,'synthetic cash');
});
void test('changed existing rows conflict without overwriting and stale preview refuses additions',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const backup=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);
  const preview=await previewDataRestore(target.db,'alice',backup);target.sqlite.prepare('INSERT INTO health_goal_settings (user_id,steps_target,sleep_target,active_energy_target,updated_at) VALUES (?,?,?,?,?)').run('alice',8000,null,null,NOW);
  await assert.rejects(restoreDataBackup(target.db,'alice',backup,preview.previewHash),BackupConflictError);assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM finance_accounts').get()?.n,0);
  const conflict=await previewDataRestore(target.db,'alice',backup);assert.equal(conflict.canRestore,false);assert.equal(conflict.tables.find((v)=>v.table==='health_goal_settings')?.conflicts,1);
});
void test('transaction snapshot guard detects a change after planning and rolls back every table',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const backup=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);const preview=await previewDataRestore(target.db,'alice',backup);
  // The next batch is the snapshot read. Install the hook after that read, when
  // the first foreign-ID query executes, so it runs just before transaction guards.
  const original=target.db.prepare.bind(target.db);let armed=false;
  target.db.prepare=((sql:string)=>{const statement=original(sql);if(sql.includes('user_id <>')&&!armed){armed=true;target.mutateNextBatch(()=>target.sqlite.prepare('INSERT INTO health_goal_settings (user_id,steps_target,sleep_target,active_energy_target,updated_at) VALUES (?,?,?,?,?)').run('alice',9999,null,null,NOW));}return statement;}) as typeof target.db.prepare;
  await assert.rejects(restoreDataBackup(target.db,'alice',backup,preview.previewHash),BackupConflictError);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM finance_accounts').get()?.n,0);assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM health_measurements').get()?.n,0);assert.equal(target.sqlite.prepare('SELECT steps_target FROM health_goal_settings').get()?.steps_target,9999);
});
void test('unknown tables and secrets cannot be accepted as a backup',()=>{
  const backup={kind:'jiashu-os-backup',version:2,exportedAt:NOW,tables:Object.fromEntries(BACKUP_TABLE_NAMES.map((t)=>[t,[]]))};
  assert.doesNotThrow(()=>parseDataBackup(backup));assert.throws(()=>parseDataBackup({...backup,tables:{...backup.tables,ai_user_settings:[]}}),BackupValidationError);
});
void test('future facts, orphan accounts, all-void balances and inconsistent audit state are rejected without writes',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const original=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);
  const mutations=[
    (b:DataBackup)=>{b.tables.finance_balance_entries[0].as_of_date='2099-01-01';},
    (b:DataBackup)=>{b.tables.nutrition_entries[0].date='2099-01-01';},
    (b:DataBackup)=>{b.tables.finance_balance_entries=[];b.tables.finance_balance_changes=[];},
    (b:DataBackup)=>{b.tables.finance_balance_entries=[b.tables.finance_balance_entries[1]];Object.assign(b.tables.finance_balance_changes[0],{action:'void',amount_minor:null,as_of_date:null,note:null});},
    (b:DataBackup)=>{const row=b.tables.health_measurements[0];const measurement=JSON.parse(row.measurement_json as string);measurement.startDate='2099-01-01T04:00:00.000Z';row.day='2099-01-01';row.exported_at='2099-01-01T04:00:00.000Z';row.measurement_json=JSON.stringify(measurement);},
    (b:DataBackup)=>{b.tables.health_record_overrides[0].deleted=1;},
    (b:DataBackup)=>{const r=b.tables.health_record_overrides[0];const measurement=JSON.parse(r.override_json as string);measurement.startDate='2099-01-01T00:00:00.000Z';measurement.endDate='2099-01-01T01:00:00.000Z';r.override_json=JSON.stringify(measurement);},
  ];
  for(const mutate of mutations){const backup=structuredClone(original);mutate(backup);await assert.rejects(previewDataRestore(target.db,'alice',backup),BackupValidationError);}
  for(const table of BACKUP_TABLE_NAMES)assert.equal(target.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n,0);
});
void test('export refuses an oversized restore-query budget rather than offering a silently unrestorable file',async(t)=>{
  const f=fixture(t);const insert=f.sqlite.prepare('INSERT INTO health_measurements VALUES (?,?,?,?,?,?,?)');
  f.sqlite.exec('BEGIN');for(let i=0;i<8000;i++){const id='x'+String(i).padStart(5,'0')+'a'.repeat(154);const measurement={id,metric:'weight',value:70,unit:'kg',startDate:OLD,source:'s'.repeat(120),aggregation:'sample'};insert.run('alice','weight:'+id,'weight','2024-01-01',JSON.stringify(measurement),NOW,NOW);}f.sqlite.exec('COMMIT');
  await assert.rejects(exportDataBackup(f.db,'alice',NOW),(error:unknown)=>error instanceof RangeError && /查询预算/.test(error.message));
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM health_measurements').get()?.n,8000);
});
void test('restoring missing finance history invalidates old account previews and remains idempotent',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const full=await exportDataBackup(source.db,'alice',NOW);const initial=structuredClone(full);initial.tables.finance_balance_entries=[initial.tables.finance_balance_entries[0]];initial.tables.finance_balance_changes=[];initial.tables.finance_accounts[0].balance_revision=10;
  const target=fixture(t);let preview=await previewDataRestore(target.db,'alice',initial);await restoreDataBackup(target.db,'alice',initial,preview.previewHash);
  const input={action:'correct' as const,expectedRevision:0,expectedAccountRevision:10,amountMinor:'7000',asOfDate:'2026-11-08',note:'',reason:'synthetic old preview'};
  assert.ok(await previewFinanceBalanceChange(target.db,'alice',C,'initial:'+C,input));
  preview=await previewDataRestore(target.db,'alice',full);assert.equal(preview.canRestore,true);await restoreDataBackup(target.db,'alice',full,preview.previewHash);
  assert.equal(target.sqlite.prepare('SELECT balance_revision FROM finance_accounts WHERE id=?').get(C)?.balance_revision,11);
  await assert.rejects(changeFinanceBalance(target.db,'alice',C,'initial:'+C,input,B,NOW),FinanceBalanceChangeConflictError);
  preview=await previewDataRestore(target.db,'alice',full);assert.equal(preview.total.added,0);assert.equal(preview.total.conflicts,0);assert.equal((await restoreDataBackup(target.db,'alice',full,preview.previewHash)).added,0);
});
