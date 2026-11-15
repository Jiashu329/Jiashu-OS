import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { BACKUP_MAX_BYTES, BACKUP_MAX_ROWS, BACKUP_TABLE_NAMES, BACKUP_TABLES, BACKUP_V1_TABLE_NAMES, VOLUME_BACKUP_LIMITS, BackupCapacityError, BackupValidationError, backupDigest, comparableBackupRow, parseDataBackup } from '../lib/data-backup.ts';
import { splitBackupVolumes } from '../lib/backup-volumes.ts';
import { parseNutritionTemplate } from '../lib/nutrition-templates.ts';
import { createNutritionTemplate, replaceNutritionTemplate, archiveNutritionTemplate } from './nutrition-templates-store.ts';
import { readWeightCycleState, writeWeightCycle } from './weight-cycles-store.ts';
import { patchFinanceAccount } from './finance-store.ts';
import { BackupConflictError, exportDataBackup, previewDataRestore, restoreDataBackup } from './data-backup-store.ts';
import { previewHealthImport, writeHealthImport } from './health-import-store.ts';
import { parseSyncPayload } from '../lib/health.ts';
import { writeHealthRecord } from './health-records-store.ts';
import { parseHealthRecordCreate } from '../lib/health-records.ts';
import { parseNutritionCreate } from '../lib/nutrition.ts';
import { getFood, LEGACY_FOOD_CATALOG_RELEASE } from '../lib/food-catalog.ts';
import { createNutritionEntry, createNutritionBatch, addNutritionFavorite, readNutritionDayStatus, writeNutritionDayStatus, replaceNutritionEntry, restoreNutritionRevision, readNutritionHistory } from './nutrition-store.ts';
import { readNutritionGoals, writeNutritionGoals } from './nutrition-goals-store.ts';
import { changeFinanceBalance, FinanceBalanceChangeConflictError, previewFinanceBalanceChange } from './finance-balance-changes-store.ts';
import { readGoalSettings, writeGoalSettings, HealthGoalConflictError } from './health-goals-store.ts';
import { readWeightPlanSettings, writeWeightPlanSettings, WeightPlanConflictError } from './weight-plan-store.ts';
import { readFinanceRunwaySettings, writeFinanceRunwaySettings, FinanceRunwayConflictError } from './finance-runway-store.ts';
import { previewNutritionCopy, copyNutritionMeal } from './nutrition-reuse-store.ts';
import { recordSyncAttempt } from './sync-attempts-store.ts';
import { goalTargetsForDay } from '../lib/health-goals.ts';
import { buildFinanceReview, parseFinanceReviewQuery } from '../lib/finance-review.ts';
import type { DataBackup } from '../lib/data-backup.ts';
import { parseDoubanDetails } from '../lib/douban-details.ts';
import { classifyDoubanLibrary } from './douban-library-store.ts';

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
  sqlite.prepare('INSERT INTO nutrition_entries (id,user_id,date,meal,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(B,owner,'2026-11-09','breakfast','synthetic oats','one bowl','',null,HASH,1,NOW,NOW,NOW);
  sqlite.prepare('INSERT INTO finance_accounts (id,user_id,ledger,name,type,currency,creation_hash,note,created_at,updated_at,archived_at,balance_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(C,owner,'personal','synthetic cash','bank','CNY',HASH,'',NOW,NOW,null,1);
  sqlite.prepare('INSERT INTO finance_account_classifications (user_id,account_id,revision,effective_from,type,archived,origin,recorded_at) VALUES (?,?,?,?,?,?,?,?)').run(owner,C,1,'1970-01-01','bank',0,'baseline',NOW);
  sqlite.prepare('INSERT INTO finance_balance_entries (sequence,id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(20,'initial:'+C,owner,C,'9007199254740993','2026-11-08','initial',NOW);
  sqlite.prepare('INSERT INTO finance_balance_entries (sequence,id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(50,D,owner,C,'9007199254740994','2026-11-08','later',NOW);
  sqlite.prepare('INSERT INTO finance_balance_changes (sequence,id,user_id,account_id,entry_id,revision,action,amount_minor,as_of_date,note,reason,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(30,E,owner,C,D,1,'correct','9007199254740995','2026-11-07','','synthetic correction',HASH,NOW);
  sqlite.prepare('INSERT INTO finance_goal_plans (id,user_id,ledger,currency,name,target_minor,deadline,account_ids_json,creation_hash,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(A,owner,'personal','CNY','synthetic goal','100000','2026-12-31',JSON.stringify([C]),HASH,NOW,NOW,NOW);
  await writeFinanceRunwaySettings(db,owner,'personal','CNY',{monthlyExpenseMinor:'500000',targetMonths:6,accountIds:[C]},0,NOW);
  const batch=await createNutritionBatch(db,owner,[{date:'2026-11-08',meal:'breakfast',name:'synthetic rice',portion:'one bowl',note:'',caloriesTenth:0}],'66666666-6666-4666-8666-666666666666',NOW);
  const foodId=batch.entries[0].id;
  await addNutritionFavorite(db,owner,foodId,NOW);
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
  assert.equal(backup.version,2); assert.equal(BACKUP_TABLE_NAMES.length,31);
  for (const table of ['health_goal_versions','health_sync_attempts','nutrition_favorites','nutrition_copy_operations','nutrition_batches','nutrition_day_status'] as const) assert.ok(backup.tables[table].length>0);
  assert.equal(JSON.stringify(backup).includes('user_id'),false);assert.equal(JSON.stringify(backup).includes('synthetic-token-hash'),false);
  const target=fixture(t);let preview=await previewDataRestore(target.db,'restored-owner',backup);assert.equal(preview.canRestore,true);assert.ok(preview.total.added>0);
  const result=await restoreDataBackup(target.db,'restored-owner',backup,preview.previewHash);assert.equal(result.added,preview.total.added);
  const after=await exportDataBackup(target.db,'restored-owner',NOW);assert.deepEqual(semantic(after),semantic(backup));
  assert.deepEqual(target.sqlite.prepare('SELECT id FROM finance_balance_entries ORDER BY sequence').all().map((row)=>row.id),['initial:'+C,D]);
  assert.equal(target.sqlite.prepare('SELECT amount_minor FROM finance_balance_entries WHERE id=?').get(D)?.amount_minor,'9007199254740994');
  preview=await previewDataRestore(target.db,'restored-owner',backup);assert.equal(preview.total.added,0);assert.equal(preview.total.conflicts,0);const repeat=await restoreDataBackup(target.db,'restored-owner',backup,preview.previewHash);assert.equal(repeat.added,0);
});

function legacyV1(backup:DataBackup) {
  const tables=Object.fromEntries(BACKUP_V1_TABLE_NAMES.map((table)=>[table,backup.tables[table].map((row)=>Object.fromEntries(Object.entries(row).filter(([key])=>!((key==='revision'&&['health_goal_settings','health_weight_plan_settings','finance_runway_settings'].includes(table))||(table==='nutrition_entries'&&key==='food_json')))))]));
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
  const badLegacy=legacyV1(original);(badLegacy.tables as Record<string,unknown>).nutrition_copy_operations=[];assert.throws(()=>parseDataBackup(badLegacy),BackupValidationError);
});

void test('a favorite owned by another user blocks the whole restore without exposing or changing its content',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const backup=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);const favorite=backup.tables.nutrition_favorites[0];
  const privateTemplate={name:'private synthetic favorite',portion:'',calories:null,note:''};target.sqlite.prepare('INSERT INTO nutrition_favorites (id,user_id,template_hash,template_json,created_at) VALUES (?,?,?,?,?)').run(String(favorite.id),'bob',await backupDigest(privateTemplate),JSON.stringify(privateTemplate),NOW);
  const preview=await previewDataRestore(target.db,'alice',backup);assert.equal(preview.canRestore,false);assert.equal(preview.tables.find((v)=>v.table==='nutrition_favorites')?.conflicts,1);assert.equal(JSON.stringify(preview).includes('private synthetic favorite'),false);
  await assert.rejects(restoreDataBackup(target.db,'alice',backup,preview.previewHash),BackupConflictError);assert.equal(target.sqlite.prepare('SELECT count(*) n FROM finance_accounts').get()?.n,0);assert.equal(JSON.parse(target.sqlite.prepare('SELECT template_json FROM nutrition_favorites').get()?.template_json as string).name,'private synthetic favorite');
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
void test('bounded larger query chunks make a dense archive restorable without truncating its records',async(t)=>{
  const f=fixture(t);const insert=f.sqlite.prepare('INSERT INTO health_measurements VALUES (?,?,?,?,?,?,?)');
  f.sqlite.exec('BEGIN');for(let i=0;i<8000;i++){const id='x'+String(i).padStart(5,'0')+'a'.repeat(154);const measurement={id,metric:'weight',value:70,unit:'kg',startDate:OLD,source:'s'.repeat(120),aggregation:'sample'};insert.run('alice','weight:'+id,'weight','2024-01-01',JSON.stringify(measurement),NOW,NOW);}f.sqlite.exec('COMMIT');
  const backup=await exportDataBackup(f.db,'alice',NOW);assert.equal(backup.tables.health_measurements.length,8000);
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored',backup);await restoreDataBackup(target.db,'restored',backup,preview.previewHash);assert.equal(target.sqlite.prepare('SELECT count(*) n FROM health_measurements').get()?.n,8000);
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

async function seedCatalogNutrition(db:D1Database, owner='alice') {
  const selected=getFood('tfda:A0550601',LEGACY_FOOD_CATALOG_RELEASE)!;assert.ok(selected);
  const input=parseNutritionCreate({date:'2026-11-09',meal:'breakfast',food:{id:selected.id,amount:150,unit:'g'},note:'source-backed fixture'},Date.parse(NOW));
  const item=(await createNutritionEntry(db,owner,input,A,NOW)).entry;
  await addNutritionFavorite(db,owner,item.id,NOW);
  const current=await readNutritionDayStatus(db,owner,item.date);
  await writeNutritionDayStatus(db,owner,{date:item.date,complete:true,meals:{breakfast:'recorded',lunch:'skipped',dinner:'skipped',snack:'unrecorded'},expectedRevision:current.revision},NOW);
  return item;
}

void test('sourced foods, favorites and completed dates roundtrip despite insert triggers and replay without conflicts',async(t)=>{
  const source=fixture(t);const item=await seedCatalogNutrition(source.db);
  source.sqlite.prepare('INSERT INTO nutrition_batches (user_id,id,request_hash,entry_ids_json,created_at) VALUES (?,?,?,?,?)').run('alice',B,HASH,JSON.stringify([item.id]),NOW);
  const backup=await exportDataBackup(source.db,'alice',NOW);
  assert.ok(backup.tables.nutrition_entries[0].food_json);assert.equal(backup.tables.nutrition_favorites.length,1);assert.equal(backup.tables.nutrition_day_status[0].complete,1);
  assert.equal(backup.tables.nutrition_batches.length,1);
  const target=fixture(t);let preview=await previewDataRestore(target.db,'new-owner',backup);
  await restoreDataBackup(target.db,'new-owner',backup,preview.previewHash);
  const after=await exportDataBackup(target.db,'new-owner',NOW);assert.deepEqual(semantic(after),semantic(backup));
  assert.equal((await readNutritionDayStatus(target.db,'new-owner',item.date)).complete,true);
  assert.equal((await readNutritionDayStatus(target.db,'alice',item.date)).complete,false);
  assert.equal(target.sqlite.prepare('SELECT count(*) n FROM nutrition_batches').get()?.n,1);
  preview=await previewDataRestore(target.db,'new-owner',backup);assert.equal(preview.total.added,0);assert.equal(preview.total.conflicts,0);
});

void test('old v1 backups without nutrition extensions normalize to null sources and empty optional tables',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);const backup=await exportDataBackup(source.db,'alice',NOW);
  const legacy=legacyV1(backup) as unknown as {tables:Record<string,Array<Record<string,unknown>>>};
  delete legacy.tables.nutrition_favorites;delete legacy.tables.nutrition_day_status;
  for(const row of legacy.tables.nutrition_entries)delete row.food_json;
  const normalized=parseDataBackup(legacy);
  assert.equal(normalized.tables.nutrition_entries[0].food_json,null);assert.deepEqual(normalized.tables.nutrition_favorites,[]);assert.deepEqual(normalized.tables.nutrition_day_status,[]);
  const target=fixture(t);const preview=await previewDataRestore(target.db,'legacy-owner',legacy);
  await restoreDataBackup(target.db,'legacy-owner',legacy,preview.previewHash);
  const row=target.sqlite.prepare('SELECT name,food_json,deleted_at FROM nutrition_entries WHERE user_id=? AND id=?').get('legacy-owner',B);
  assert.equal(row?.name,'synthetic oats');assert.equal(row?.food_json,null);assert.equal(row?.deleted_at,NOW);
  const repeat=await previewDataRestore(target.db,'legacy-owner',legacy);assert.equal(repeat.total.added,0);assert.equal(repeat.total.conflicts,0);
});

void test('published nutrition v1 backups retain sourced food, canonical favorites and completed days',async(t)=>{
  const source=fixture(t);const item=await seedCatalogNutrition(source.db);const backup=await exportDataBackup(source.db,'alice',NOW);
  const legacy=legacyV1(backup) as {kind:string;version:number;exportedAt:string;tables:Record<string,Array<Record<string,unknown>>>};
  legacy.tables.nutrition_entries=backup.tables.nutrition_entries.map((row)=>({...row}));
  legacy.tables.nutrition_favorites=backup.tables.nutrition_favorites.map((row)=>({...row}));
  legacy.tables.nutrition_day_status=backup.tables.nutrition_day_status.map((row)=>({...row}));
  assert.equal(Object.keys(legacy.tables).length,15);
  const parsed=parseDataBackup(legacy);assert.equal(parsed.version,2);assert.ok(parsed.tables.nutrition_entries[0].food_json);assert.equal(parsed.tables.nutrition_batches.length,0);
  const target=fixture(t);const preview=await previewDataRestore(target.db,'alice',legacy);assert.equal(preview.canRestore,true);await restoreDataBackup(target.db,'alice',legacy,preview.previewHash);
  assert.equal((await readNutritionDayStatus(target.db,'alice',item.date)).complete,true);
  const repeated=await previewDataRestore(target.db,'alice',legacy);assert.equal(repeated.total.added,0);assert.equal(repeated.total.conflicts,0);
});

void test('same-content favorite with a different local ID is skipped and duplicate hashes inside a file fail',async(t)=>{
  const source=fixture(t);await seedCatalogNutrition(source.db);const backup=await exportDataBackup(source.db,'alice',NOW);const favorite=backup.tables.nutrition_favorites[0];const target=fixture(t);
  target.sqlite.prepare('INSERT INTO nutrition_favorites (id,user_id,template_hash,template_json,created_at) VALUES (?,?,?,?,?)').run(B,'alice',favorite.template_hash as string,favorite.template_json as string,NOW);
  const preview=await previewDataRestore(target.db,'alice',backup);assert.equal(preview.canRestore,true);assert.equal(preview.tables.find((row)=>row.table==='nutrition_favorites')?.skipped,1);assert.equal(preview.tables.find((row)=>row.table==='nutrition_favorites')?.added,0);
  await restoreDataBackup(target.db,'alice',backup,preview.previewHash);assert.equal(target.sqlite.prepare('SELECT id FROM nutrition_favorites WHERE user_id=?').get('alice')?.id,B);
  const duplicate=structuredClone(backup);duplicate.tables.nutrition_favorites.push({...favorite,id:C});await assert.rejects(previewDataRestore(fixture(t).db,'alice',duplicate),BackupValidationError);
});

void test('restored nutrition batch receipts acknowledge the original request without adding food or firing status triggers again',async(t)=>{
  const source=fixture(t);const input=parseNutritionCreate({date:'2026-11-09',meal:'breakfast',name:'batch food',calories:null},Date.parse(NOW));
  const original=await createNutritionBatch(source.db,'alice',[input],A,NOW);const backup=await exportDataBackup(source.db,'alice',NOW);assert.equal(backup.tables.nutrition_batches.length,1);
  const target=fixture(t);const preview=await previewDataRestore(target.db,'alice',backup);await restoreDataBackup(target.db,'alice',backup,preview.previewHash);
  const status=await readNutritionDayStatus(target.db,'alice','2026-11-09');const replay=await createNutritionBatch(target.db,'alice',[input],A,NOW);assert.equal(replay.replayed,true);assert.equal(replay.entries[0].id,original.entries[0].id);
  assert.equal(target.sqlite.prepare('SELECT count(*) n FROM nutrition_entries').get()?.n,1);assert.deepEqual(await readNutritionDayStatus(target.db,'alice','2026-11-09'),status);
});

void test('forged food math, source metadata, favorite digests and impossible completion states fail before writes',async(t)=>{
  const source=fixture(t);await seedCatalogNutrition(source.db);const original=await exportDataBackup(source.db,'alice',NOW);const target=fixture(t);
  const mutations=[
    (backup:DataBackup)=>{const row=backup.tables.nutrition_entries[0],food=JSON.parse(row.food_json as string);food.grams++;row.food_json=JSON.stringify(food);},
    (backup:DataBackup)=>{const row=backup.tables.nutrition_entries[0],food=JSON.parse(row.food_json as string);food.source.url='https://untrusted.example/food';row.food_json=JSON.stringify(food);},
    (backup:DataBackup)=>{const row=backup.tables.nutrition_entries[0],food=JSON.parse(row.food_json as string);food.kcalPer100g++;food.caloriesTenth=Math.round(food.grams*food.kcalPer100g/10);row.calories_tenth=food.caloriesTenth;row.food_json=JSON.stringify(food);},
    (backup:DataBackup)=>{const row=backup.tables.nutrition_favorites[0],template=JSON.parse(row.template_json as string);template.note='changed without matching digest';row.template_json=JSON.stringify(template);},
    (backup:DataBackup)=>{backup.tables.nutrition_day_status[0].meals_json=JSON.stringify({breakfast:'recorded',lunch:'unrecorded',dinner:'skipped',snack:'unrecorded'});},
    (backup:DataBackup)=>{backup.tables.nutrition_day_status[0].meals_json=JSON.stringify({breakfast:['recorded'],lunch:'skipped',dinner:'skipped'});},
    (backup:DataBackup)=>{backup.tables.nutrition_batches=[{id:B,request_hash:HASH,entry_ids_json:JSON.stringify(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']),created_at:NOW}];},
  ];
  for(const mutate of mutations){const backup=structuredClone(original);mutate(backup);await assert.rejects(previewDataRestore(target.db,'new-owner',backup),BackupValidationError);}
  for(const table of BACKUP_TABLE_NAMES)assert.equal(target.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()?.n,0);
});

void test('source completion flags never overwrite different target flags and concurrent target flags stop restoration',async(t)=>{
  const source=fixture(t);await seedCatalogNutrition(source.db);const backup=await exportDataBackup(source.db,'alice',NOW);
  const target=fixture(t);await writeNutritionDayStatus(target.db,'restored-owner',{date:'2026-11-09',complete:false,meals:{breakfast:'unrecorded',lunch:'skipped',dinner:'unrecorded',snack:'unrecorded'},expectedRevision:0},NOW);
  const before=await readNutritionDayStatus(target.db,'restored-owner','2026-11-09');const preview=await previewDataRestore(target.db,'restored-owner',backup);
  assert.equal(preview.canRestore,false);await assert.rejects(restoreDataBackup(target.db,'restored-owner',backup,preview.previewHash),BackupConflictError);
  assert.deepEqual(await readNutritionDayStatus(target.db,'restored-owner','2026-11-09'),before);assert.equal(target.sqlite.prepare('SELECT count(*) n FROM nutrition_entries').get()?.n,0);
  const empty=fixture(t);const valid=await previewDataRestore(empty.db,'restored-owner',backup);
  const prepare=empty.db.prepare.bind(empty.db);let armed=false;
  empty.db.prepare=((sql:string)=>{const statement=prepare(sql);if(sql.includes('user_id <>')&&!armed){armed=true;empty.mutateNextBatch(()=>empty.sqlite.prepare('INSERT INTO nutrition_day_status VALUES (?,?,?,?,?,?)').run('restored-owner','2026-11-09',0,'{}',1,NOW));}return statement;}) as typeof empty.db.prepare;
  await assert.rejects(restoreDataBackup(empty.db,'restored-owner',backup,valid.previewHash),BackupConflictError);
  assert.equal(empty.sqlite.prepare('SELECT count(*) n FROM nutrition_entries').get()?.n,0);assert.equal((await readNutritionDayStatus(empty.db,'restored-owner','2026-11-09')).complete,false);
});

void test('merging individually valid favorite sets beyond 100 refuses preview and restore without writes',async(t)=>{
  const target=fixture(t),tables=Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,[]])) as unknown as DataBackup['tables'];
  for(let index=0;index<100;index++) {
    const template={name:'incoming favorite '+index,portion:'',calories:null,note:''};
    tables.nutrition_favorites.push({id:crypto.randomUUID(),template_hash:await backupDigest(template),template_json:JSON.stringify(template),created_at:NOW});
  }
  const current={name:'existing target favorite',portion:'',calories:null,note:''};
  target.sqlite.prepare('INSERT INTO nutrition_favorites (id,user_id,template_hash,template_json,created_at) VALUES (?,?,?,?,?)').run(A,'alice',await backupDigest(current),JSON.stringify(current),NOW);
  const backup:DataBackup={kind:'jiashu-os-backup',version:2,exportedAt:NOW,tables};
  const exceedsFavorites=(error:unknown)=>error instanceof BackupCapacityError && /100/.test(error.message);
  await assert.rejects(previewDataRestore(target.db,'alice',backup),exceedsFavorites);
  await assert.rejects(restoreDataBackup(target.db,'alice',backup,HASH),exceedsFavorites);
  assert.equal(target.sqlite.prepare('SELECT count(*) n FROM nutrition_favorites').get()?.n,1);
  assert.equal(target.sqlite.prepare('SELECT template_json FROM nutrition_favorites WHERE id=?').get(A)?.template_json,JSON.stringify(current));
});

void test('old v1 nutrition inserts include trigger-created dates in final row capacity before any restore writes',async(t)=>{
  const source=fixture(t);await createNutritionEntry(source.db,'source',parseNutritionCreate({date:'2026-11-09',meal:'breakfast',name:'legacy meal',calories:null},Date.parse(NOW)),A,NOW);
  const backup=await exportDataBackup(source.db,'source',NOW);
  const legacy=legacyV1(backup) as unknown as {kind:string;version:number;exportedAt:string;tables:Record<string,Array<Record<string,unknown>>>};
  delete legacy.tables.nutrition_favorites;delete legacy.tables.nutrition_day_status;delete legacy.tables.nutrition_entries[0].food_json;
  const target=fixture(t);
  const rows=Array.from({length:BACKUP_MAX_ROWS-2},(_,index)=>{
    const id='c'+index.toString(36),measurement={id,metric:'weight',value:70,unit:'kg',startDate:OLD,source:'s',aggregation:'sample'};
    return {record_key:'weight:'+id,metric:'weight',day:'2024-01-01',measurement_json:JSON.stringify(measurement),exported_at:NOW,received_at:NOW};
  });
  target.sqlite.prepare(`INSERT INTO health_measurements (user_id,record_key,metric,day,measurement_json,exported_at,received_at)
    SELECT ?,json_extract(value,'$.record_key'),json_extract(value,'$.metric'),json_extract(value,'$.day'),json_extract(value,'$.measurement_json'),json_extract(value,'$.exported_at'),json_extract(value,'$.received_at') FROM json_each(?)`).run('alice',JSON.stringify(rows));
  const explicit={...parseDataBackup(legacy).tables,health_measurements:rows};
  assert.equal(Object.values(explicit).reduce((sum,list)=>sum+list.length,0),BACKUP_MAX_ROWS);
  assert.ok(new TextEncoder().encode(JSON.stringify({kind:'jiashu-os-backup',version:1,exportedAt:NOW,tables:explicit})).byteLength<BACKUP_MAX_BYTES,'Explicit rows alone fit the byte ceiling');
  const exceedsCapacity=(error:unknown)=>error instanceof BackupCapacityError && /恢复后的数据/.test(error.message);
  await assert.rejects(previewDataRestore(target.db,'alice',legacy),exceedsCapacity);
  await assert.rejects(restoreDataBackup(target.db,'alice',legacy,HASH),exceedsCapacity);
  assert.equal(target.sqlite.prepare('SELECT count(*) n FROM nutrition_entries').get()?.n,0);
  assert.equal(target.sqlite.prepare('SELECT count(*) n FROM nutrition_day_status').get()?.n,0);
  assert.equal(target.sqlite.prepare('SELECT count(*) n FROM health_measurements').get()?.n,BACKUP_MAX_ROWS-2);
});

void test('macronutrients including real zero survive backups, favorites and restoration for a different owner',async(t)=>{
  const source=fixture(t);
  const input=parseNutritionCreate({date:'2026-11-09',meal:'lunch',name:'合成营养食物',portion:'1份',note:'标签已核对',
    calories:'120',carbs:'15.2',protein:'0',fat:'4.5'},Date.parse(NOW));
  await createNutritionEntry(source.db,'alice',input,A,NOW);
  await addNutritionFavorite(source.db,'alice',A,NOW);
  const backup=await exportDataBackup(source.db,'alice',NOW);
  const row=backup.tables.nutrition_entries[0];
  assert.deepEqual([row.carbs_tenth,row.protein_tenth,row.fat_tenth],[152,0,45]);
  const template=JSON.parse(backup.tables.nutrition_favorites[0].template_json as string);
  assert.deepEqual([template.carbs,template.protein,template.fat],['15.2','0.0','4.5']);
  const target=fixture(t);const preview=await previewDataRestore(target.db,'restored-owner',backup);
  await restoreDataBackup(target.db,'restored-owner',backup,preview.previewHash);
  const saved=target.sqlite.prepare('SELECT carbs_tenth,protein_tenth,fat_tenth FROM nutrition_entries WHERE user_id=? AND id=?').get('restored-owner',A);
  assert.deepEqual([saved?.carbs_tenth,saved?.protein_tenth,saved?.fat_tenth],[152,0,45]);
  assert.deepEqual(semantic(await exportDataBackup(target.db,'restored-owner',NOW)),semantic(backup));
});

void test('published v1 and v2 nutrition backups without macro columns or source macros preserve unknown values',async(t)=>{
  const source=fixture(t);await seedCatalogNutrition(source.db);
  const current=await exportDataBackup(source.db,'alice',NOW);
  for(const version of [1,2]){
    const backup=structuredClone(current) as unknown as {version:number;tables:Record<string,Array<Record<string,unknown>>>};
    backup.version=version;
    for(const name of ['nutrition_entry_history','nutrition_goal_settings','nutrition_restore_operations','health_weight_plan_cycles','health_weight_plan_operations','nutrition_templates','nutrition_template_operations','finance_account_classifications','douban_items'])delete backup.tables[name];
    if(version===1){for(const name of ['health_goal_versions','health_sync_attempts','nutrition_copy_operations','health_sync_diagnostics','health_weekly_actions','finance_month_closes'])delete backup.tables[name];}
    for(const row of backup.tables.nutrition_entries){
      for(const key of ['carbs_tenth','protein_tenth','fat_tenth'])delete row[key];
      const food=JSON.parse(row.food_json as string);for(const key of ['carbsTenth','proteinTenth','fatTenth','carbsPer100g','proteinPer100g','fatPer100g'])delete food[key];row.food_json=JSON.stringify(food);
    }
    for(const row of backup.tables.nutrition_favorites){
      const template=JSON.parse(row.template_json as string);
      for(const key of ['carbs','protein','fat'])delete template[key];
      for(const key of ['carbsTenth','proteinTenth','fatTenth','carbsPer100g','proteinPer100g','fatPer100g'])delete template.food[key];
      row.template_json=JSON.stringify(template);row.template_hash=await backupDigest(template);
    }
    const parsed=parseDataBackup(backup);
    assert.deepEqual(['carbs_tenth','protein_tenth','fat_tenth'].map((key)=>parsed.tables.nutrition_entries[0][key]),[null,null,null]);
    const target=fixture(t);const preview=await previewDataRestore(target.db,'legacy-owner',backup);
    await restoreDataBackup(target.db,'legacy-owner',backup,preview.previewHash);
    const saved=target.sqlite.prepare('SELECT carbs_tenth,protein_tenth,fat_tenth FROM nutrition_entries WHERE id=?').get(A);
    assert.deepEqual([saved?.carbs_tenth,saved?.protein_tenth,saved?.fat_tenth],[null,null,null]);
  }
});

void test('source-backed favorites retain entered macro overrides while snapshots and compatible digests remain verifiable',async(t)=>{
  const source=fixture(t);const food=getFood('tfda:A0550601',LEGACY_FOOD_CATALOG_RELEASE)!;
  const input=parseNutritionCreate({date:'2026-11-09',meal:'lunch',food:{id:food.id,amount:150,unit:'g'},
    carbs:'30.5',protein:'0',fat:'1.2',note:'核对后的份量营养数据'},Date.parse(NOW));
  await createNutritionEntry(source.db,'alice',input,A,NOW);await addNutritionFavorite(source.db,'alice',A,NOW);
  const backup=await exportDataBackup(source.db,'alice',NOW);const template=JSON.parse(backup.tables.nutrition_favorites[0].template_json as string);
  assert.deepEqual([template.carbs,template.protein,template.fat],['30.5','0.0','1.2']);
  assert.equal(typeof template.food.carbsPer100g,'number');
  const target=fixture(t),preview=await previewDataRestore(target.db,'alice',backup);await restoreDataBackup(target.db,'alice',backup,preview.previewHash);
  assert.deepEqual(semantic(await exportDataBackup(target.db,'alice',NOW)),semantic(backup));
  const tampered=structuredClone(backup),favorite=tampered.tables.nutrition_favorites[0],modified=JSON.parse(favorite.template_json as string);
  modified.protein='1.0';favorite.template_json=JSON.stringify(modified);
  await assert.rejects(previewDataRestore(fixture(t).db,'alice',tampered),BackupValidationError);
});

void test('backup validation rejects malformed macro amounts and tampered catalog nutrient snapshots',async(t)=>{
  const source=fixture(t);await seedCatalogNutrition(source.db);const original=await exportDataBackup(source.db,'alice',NOW);
  for(const value of [-1,0.5,200001,'10',{}]){
    const backup=structuredClone(original);(backup.tables.nutrition_entries[0] as Record<string,unknown>).carbs_tenth=value;
    assert.throws(()=>parseDataBackup(backup),BackupValidationError);
  }
  const snapshot=structuredClone(original),row=snapshot.tables.nutrition_entries[0],food=JSON.parse(row.food_json as string);
  food.carbsTenth=(food.carbsTenth??0)+1;row.food_json=JSON.stringify(food);
  assert.throws(()=>parseDataBackup(snapshot),BackupValidationError);
});

void test('nutrition targets, structured sources and immutable restore receipts survive a complete backup',async(t)=>{
  const source=fixture(t);
  const first=parseNutritionCreate({date:'2026-11-09',meal:'lunch',name:'合成来源食物',portion:'1份',note:'',calories:'120',carbs:'10',protein:'4',fat:'3',
    provenance:{calories:{source:'ai',basis:'按测试份量估算',portion:'1份',originalValue:'120'},protein:{source:'label',basis:'合成包装标签'}}},Date.parse(NOW));
  await createNutritionEntry(source.db,'alice',first,A,NOW);
  const edited=parseNutritionCreate({date:'2026-11-09',meal:'lunch',name:'合成来源食物',portion:'1份',note:'已核对',calories:'130',carbs:'11',protein:'5',fat:'3',provenance:{calories:{source:'label',basis:'合成标签核对'}}},Date.parse(NOW));
  await replaceNutritionEntry(source.db,'alice',A,edited,1,NOW);
  await restoreNutritionRevision(source.db,'alice',A,1,2,B,NOW);
  await writeNutritionGoals(source.db,'alice',{calories:'2000.0',carbs:'200.0',protein:'100.0',fat:null},0,NOW);
  const backup=await exportDataBackup(source.db,'alice',NOW);
  assert.equal(backup.tables.nutrition_entry_history.length,3);assert.equal(backup.tables.nutrition_restore_operations.length,1);
  assert.equal(JSON.parse(backup.tables.nutrition_entries[0].provenance_json as string).calories.source,'ai');
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored-owner',backup);await restoreDataBackup(target.db,'restored-owner',backup,preview.previewHash);
  assert.deepEqual((await readNutritionHistory(target.db,'restored-owner',A))?.map((row)=>row.action),['restore','edit','create']);
  assert.equal((await readNutritionGoals(target.db,'restored-owner')).protein,'100.0');
  assert.equal((await restoreNutritionRevision(target.db,'restored-owner',A,1,2,B,NOW))?.replayed,true);
  assert.deepEqual(semantic(await exportDataBackup(target.db,'restored-owner',NOW)),semantic(backup));
  const forged=structuredClone(backup);forged.tables.nutrition_entry_history[0].after_json=JSON.stringify({...JSON.parse(forged.tables.nutrition_entry_history[0].after_json as string),proteinTenth:-1});
  assert.throws(()=>parseDataBackup(forged),BackupValidationError);
  const missing=structuredClone(backup);missing.tables.nutrition_entry_history=missing.tables.nutrition_entry_history.filter((row)=>row.revision!==2);
  assert.throws(()=>parseDataBackup(missing),BackupValidationError);
  const contradictory=structuredClone(backup),second=contradictory.tables.nutrition_entry_history.find((row)=>row.revision===2)!;
  second.before_json=JSON.stringify({...JSON.parse(second.before_json as string),note:'凭空出现的旧值'});
  assert.throws(()=>parseDataBackup(contradictory),BackupValidationError);
  const restarted=structuredClone(backup),restart=restarted.tables.nutrition_entry_history.find((row)=>row.revision===2)!;restart.action='baseline';restart.before_json=null;
  assert.throws(()=>parseDataBackup(restarted),BackupValidationError);
  const migrated=structuredClone(backup);migrated.tables.nutrition_restore_operations=[];migrated.tables.nutrition_entry_history=migrated.tables.nutrition_entry_history.filter((row)=>row.revision!==1);
  const baseline=migrated.tables.nutrition_entry_history.find((row)=>row.revision===2)!;baseline.action='baseline';baseline.before_json=null;
  assert.doesNotThrow(()=>parseDataBackup(migrated),'Migrated baselines may begin after revision one');
});

void test('P2 templates, cycle archives and dated finance classifications roundtrip with their original retry receipts',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);
  const definition=parseNutritionTemplate({kind:'recipe',name:'合成鸡胸饭',note:'配方说明',baseServings:'2',totalWeight:'400',components:[{name:'合成原料',portion:'400g',grams:'400',calories:'400',carbs:'40',protein:'30',fat:null}]});
  await createNutritionTemplate(source.db,'alice',definition,A,NOW);
  await replaceNutritionTemplate(source.db,'alice',A,{...definition,name:'修改后的合成鸡胸饭'},1,B,NOW);
  await archiveNutritionTemplate(source.db,'alice',A,2,C,NOW);
  await writeWeightCycle(source.db,'alice',{action:'archive',expectedRevision:1},D,[],NOW);
  const nextPlan={baselineWeight:70,targetWeight:67,startDate:'2026-11-10',deadline:'2026-12-31',enabled:true};
  await writeWeightCycle(source.db,'alice',{action:'start',expectedRevision:2,plan:nextPlan},E,[],NOW);
  await patchFinanceAccount(source.db,'alice',C,{type:'loan',expectedRevision:1},NOW);
  await patchFinanceAccount(source.db,'alice',C,{archived:true,expectedRevision:2},NOW);
  const backup=await exportDataBackup(source.db,'alice',NOW);
  assert.equal(backup.tables.nutrition_template_operations.length,3);assert.equal(backup.tables.health_weight_plan_cycles.length,1);assert.equal(backup.tables.finance_account_classifications.length,3);
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored',backup);assert.equal(preview.canRestore,true);
  await restoreDataBackup(target.db,'restored',backup,preview.previewHash);
  assert.deepEqual(semantic(await exportDataBackup(target.db,'restored',NOW)),semantic(backup));
  assert.equal((await createNutritionTemplate(target.db,'restored',definition,A,NOW)).replayed,true);
  assert.equal((await replaceNutritionTemplate(target.db,'restored',A,{...definition,name:'修改后的合成鸡胸饭'},1,B,NOW))?.replayed,true);
  assert.equal((await writeWeightCycle(target.db,'restored',{action:'archive',expectedRevision:1},D,[],NOW)).replayed,true);
  assert.equal((await readWeightCycleState(target.db,'restored')).cycles[0].settings.targetWeight,68);
  const forged=structuredClone(backup);forged.tables.nutrition_template_operations[0].request_hash='f'.repeat(64);
  await assert.rejects(previewDataRestore(fixture(t).db,'restored',forged),BackupValidationError);
  const orphan=structuredClone(backup);orphan.tables.health_weight_plan_cycles=[];assert.throws(()=>parseDataBackup(orphan),BackupValidationError);
  const contradictory=structuredClone(backup);contradictory.tables.finance_account_classifications.at(-1)!.type='bank';assert.throws(()=>parseDataBackup(contradictory),BackupValidationError);
});

void test('a complete volume set restores beyond the old row limit in one atomic operation and refuses incomplete sets',async(t)=>{
  const source=fixture(t);const rows=Array.from({length:20001},(_,index)=>{
    const id='large-'+index,measurement={id,metric:'weight',value:70,unit:'kg',startDate:OLD,source:'synthetic',aggregation:'sample'};
    return{record_key:'weight:'+id,metric:'weight',day:'2024-01-01',measurement_json:JSON.stringify(measurement),exported_at:NOW,received_at:NOW};
  });
  source.sqlite.prepare(`INSERT INTO health_measurements (user_id,record_key,metric,day,measurement_json,exported_at,received_at) SELECT ?,json_extract(value,'$.record_key'),json_extract(value,'$.metric'),json_extract(value,'$.day'),json_extract(value,'$.measurement_json'),json_extract(value,'$.exported_at'),json_extract(value,'$.received_at') FROM json_each(?)`).run('alice',JSON.stringify(rows));
  await assert.rejects(exportDataBackup(source.db,'alice',NOW),BackupCapacityError);
  const backup=await exportDataBackup(source.db,'alice',NOW,VOLUME_BACKUP_LIMITS),set=await splitBackupVolumes(backup),target=fixture(t);
  await assert.rejects(previewDataRestore(target.db,'restored',{...set,volumes:set.volumes.slice(0,1)}),BackupValidationError);
  assert.equal(target.sqlite.prepare('SELECT count(*) AS n FROM health_measurements').get()?.n,0);
  const preview=await previewDataRestore(target.db,'restored',set);assert.equal(preview.total.added,20001);
  await restoreDataBackup(target.db,'restored',set,preview.previewHash);
  assert.equal(target.sqlite.prepare('SELECT count(*) AS n FROM health_measurements').get()?.n,20001);
  assert.equal((await previewDataRestore(target.db,'restored',set)).total.added,0);
});

void test('JSON escaping cannot make an oversized single history binding pass preview or export',async(t)=>{
  const snapshots=Array.from({length:1000},(_,index)=>{
    const id='synthetic-'+String(index).padStart(5,'0')+'x'.repeat(45),measurement={id,metric:'weight',value:70,unit:'kg',startDate:OLD,source:'\\'.repeat(120),aggregation:'sample'};
    return{recordKey:'weight:'+id,metric:'weight',day:'2024-01-01',measurementJson:JSON.stringify(measurement),exportedAt:NOW,receivedAt:NOW};
  });
  const row={batch_id:HASH,payload_hash:HASH,operation_id:A,before_json:JSON.stringify(snapshots.map((item)=>({recordKey:item.recordKey,base:item}))),after_json:JSON.stringify(snapshots),receipt_json:JSON.stringify({ok:true,batchId:HASH,imported:1000,skipped:0,lastSync:NOW,summary:{from:'2024-01-01',to:'2024-01-01',metrics:['体重'],sourceChanges:0,manualOverrides:0},canRevert:true}),created_at:NOW,reverted_at:null,revert_reason:null,revert_id:null};
  const backup:DataBackup={kind:'jiashu-os-backup',version:2,exportedAt:NOW,tables:Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,[]])) as unknown as DataBackup['tables']};
  backup.tables.health_import_batches=[row];backup.tables.health_syncs=[{payload_hash:HASH,exported_at:NOW,received_at:NOW,measurement_count:1000}];
  assert.doesNotThrow(()=>parseDataBackup(backup));assert.ok(new TextEncoder().encode(JSON.stringify([row])).byteLength>2*1024*1024);
  const target=fixture(t);await assert.rejects(previewDataRestore(target.db,'alice',backup),BackupCapacityError);assert.equal(target.sqlite.prepare('SELECT count(*) AS n FROM health_import_batches').get()?.n,0);
  const source=fixture(t),spec=BACKUP_TABLES.health_import_batches;
  source.sqlite.prepare(`INSERT INTO health_import_batches (user_id,${spec.columns.join(',')}) VALUES (?,${spec.columns.map(()=>'?').join(',')})`).run('alice',...spec.columns.map((column)=>row[column as keyof typeof row]));
  source.sqlite.prepare('INSERT INTO health_syncs VALUES (?,?,?,?,?)').run('alice',HASH,NOW,NOW,1000);
  await assert.rejects(exportDataBackup(source.db,'alice',NOW),BackupCapacityError);
});

void test('old backups reuse an existing finance baseline without resetting its recorded boundary or edit epoch',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);source.sqlite.prepare("UPDATE finance_accounts SET liquidity_kind='liquid',usable_bps=10000").run();
  const current=await exportDataBackup(source.db,'alice',NOW),target=fixture(t),first=await previewDataRestore(target.db,'restored',current);await restoreDataBackup(target.db,'restored',current,first.previewHash);
  const boundary='2026-11-11T04:00:00.000Z';target.sqlite.prepare('UPDATE finance_account_classifications SET recorded_at=?').run(boundary);target.sqlite.prepare('UPDATE finance_accounts SET metadata_revision=9').run();
  const legacy=structuredClone(current) as unknown as {tables:Record<string,Array<Record<string,unknown>>>};
  for(const table of ['health_weight_plan_cycles','health_weight_plan_operations','nutrition_templates','nutrition_template_operations','finance_account_classifications'])delete legacy.tables[table];
  for(const row of legacy.tables.finance_accounts){delete row.liquidity_kind;delete row.usable_bps;}
  for(const row of legacy.tables.health_weight_plan_settings){delete row.cycle_id;delete row.archived_at;}
  const preview=await previewDataRestore(target.db,'restored',legacy);assert.equal(preview.canRestore,true);assert.equal(preview.total.added,0);
  await restoreDataBackup(target.db,'restored',legacy,preview.previewHash);assert.equal(target.sqlite.prepare('SELECT recorded_at FROM finance_account_classifications').get()?.recorded_at,boundary);assert.equal(target.sqlite.prepare('SELECT metadata_revision FROM finance_accounts').get()?.metadata_revision,9);
});

void test('the canonical complete backup includes per-metric checks, weekly feedback and immutable month-close versions',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);
  source.sqlite.prepare('INSERT OR REPLACE INTO health_sync_diagnostics VALUES (?,?,?,?,?,?,?,?,?)').run('alice','weight',NOW,NOW,1,1,0,'2024-01-01','2024-01-01');
  source.sqlite.prepare('INSERT INTO health_weekly_actions VALUES (?,?,?,?,?,?,?,?)').run('alice','2026-11-09','晚饭后散步','completed','本周完成',1,NOW,NOW);
  const review=buildFinanceReview([{accountId:C,name:'synthetic cash',type:'bank',ledger:'personal',currency:'CNY',archivedAt:null}],[{accountId:C,amountMinor:'9007199254740993',asOfDate:'2026-10-31',sequence:1}],parseFinanceReviewQuery(new URLSearchParams({ledger:'personal',currency:'CNY',month:'2026-10'}),new Date(NOW)));
  source.sqlite.prepare('INSERT INTO finance_month_closes VALUES (?,?,?,?,?,?,?,?,?,?)').run('alice','personal','CNY','2026-10',1,A,HASH,JSON.stringify(review),'',NOW);
  const backup=await exportDataBackup(source.db,'alice',NOW);
  for(const table of ['health_sync_diagnostics','health_weekly_actions','finance_month_closes'] as const)assert.ok(backup.tables[table].length>=1);
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored',backup);assert.equal(preview.canRestore,true);
  await restoreDataBackup(target.db,'restored',backup,preview.previewHash);
  assert.deepEqual(semantic(await exportDataBackup(target.db,'restored',NOW)),semantic(backup));
  assert.equal((await previewDataRestore(target.db,'restored',backup)).total.added,0);
  const before=await exportDataBackup(source.db,'alice',NOW),collision=await previewDataRestore(source.db,'another-owner',backup);
  assert.equal(collision.canRestore,false);assert.ok(collision.tables.some((table)=>table.conflictExamples.some((row)=>row.reason.includes('标识已被占用'))));
  await assert.rejects(restoreDataBackup(source.db,'another-owner',backup,collision.previewHash),BackupConflictError);
  assert.deepEqual(semantic(await exportDataBackup(source.db,'alice',NOW)),semantic(before));
  const malformed=structuredClone(backup);malformed.tables.finance_month_closes[0].snapshot_json='{}';assert.throws(()=>parseDataBackup(malformed),BackupValidationError);
  const gap=structuredClone(backup);gap.tables.finance_month_closes[0].version=2;assert.throws(()=>parseDataBackup(gap),BackupValidationError);
  const orphan=structuredClone(backup);const snapshot=JSON.parse(orphan.tables.finance_month_closes[0].snapshot_json as string);snapshot.accounts[0].accountId='99999999-9999-4999-8999-999999999999';orphan.tables.finance_month_closes[0].snapshot_json=JSON.stringify(snapshot);assert.throws(()=>parseDataBackup(orphan),BackupValidationError);
  const invalidAction=structuredClone(backup);invalidAction.tables.health_weekly_actions[0].week_start='2026-11-10';assert.throws(()=>parseDataBackup(invalidAction),BackupValidationError);
});

void test('published 27-table v2 single files remain valid and gain empty action tables without losing existing business fields',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);
  const backup=await exportDataBackup(source.db,'alice',NOW),legacy=structuredClone(backup) as unknown as {tables:Record<string,unknown>};
  for(const table of ['health_sync_diagnostics','health_weekly_actions','finance_month_closes','douban_items'])delete legacy.tables[table];
  assert.equal(Object.keys(legacy.tables).length,27);
  const parsed=parseDataBackup(legacy);for(const table of ['health_sync_diagnostics','health_weekly_actions','finance_month_closes'] as const)assert.deepEqual(parsed.tables[table],[]);
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored',legacy);assert.equal(preview.canRestore,true);await restoreDataBackup(target.db,'restored',legacy,preview.previewHash);
  assert.deepEqual(semantic(await exportDataBackup(target.db,'restored',NOW)),semantic(parsed));
});

const doubanRow = (overrides: Record<string,string|number|null> = {}) => ({
  profile_id:'synthetic-profile',domain:'screen',subject_id:'1292052',kind:'series',title:'合成豆瓣剧集',
  url:'https://movie.douban.com/subject/1292052/',cover_url:null,rating:5,marked_date:'2026-11-09',
  comment:'本人标记的合成短评',published_at:null,source:'collection',details_json:'{}',observed_at:NOW,created_at:NOW,updated_at:NOW,...overrides,
});
function seedDouban(sqlite: DatabaseSync, owner: string, row = doubanRow(), checkedRun: string | null = null) {
  const columns=Object.keys(row);
  sqlite.prepare(`INSERT INTO douban_items (user_id,${columns.join(',')},metadata_checked_run_id) VALUES (${Array(columns.length+2).fill('?').join(',')})`)
    .run(owner,...columns.map(column=>row[column as keyof typeof row]),checkedRun);
}

void test('Douban collection backups restore only personal source records without connections, run state or another owner’s data',async(t)=>{
  const source=fixture(t);
  seedDouban(source.sqlite,'alice',doubanRow(),A);
  seedDouban(source.sqlite,'alice',doubanRow({domain:'book',subject_id:'1234567',kind:'book',title:'合成书籍',url:'https://book.douban.com/subject/1234567/',rating:null,marked_date:null,comment:null,published_at:'2026-11-09T04:00:00.000Z',source:'rss'}),B);
  seedDouban(source.sqlite,'bob',doubanRow({comment:'BOB-PRIVATE-COMMENT'}));
  const backup=await exportDataBackup(source.db,'alice',NOW);
  assert.equal(backup.tables.douban_items.length,2);
  assert.doesNotMatch(JSON.stringify(backup),/BOB-PRIVATE-COMMENT|metadata_checked_run_id|douban_connections|douban_sync_runs|user_id/);
  assert.deepEqual(backup.tables.douban_items.find(row=>row.domain==='book')?.rating,null);
  const target=fixture(t);
  seedDouban(target.sqlite,'bob',doubanRow({comment:'BOB-PRIVATE-COMMENT'}));
  const preview=await previewDataRestore(target.db,'restored',backup);
  assert.equal(preview.canRestore,true);assert.equal(preview.total.added,2);
  await restoreDataBackup(target.db,'restored',backup,preview.previewHash);
  const restored=await exportDataBackup(target.db,'restored',NOW);
  assert.deepEqual(restored.tables.douban_items,backup.tables.douban_items);
  assert.equal(target.sqlite.prepare('SELECT comment FROM douban_items WHERE user_id=?').get('bob')?.comment,'BOB-PRIVATE-COMMENT');
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM douban_connections').get()?.n,0);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM douban_sync_runs').get()?.n,0);
  assert.deepEqual(target.sqlite.prepare('SELECT domain,metadata_checked_run_id FROM douban_items WHERE user_id=? ORDER BY domain').all('restored').map(row=>({...row})),[
    {domain:'book',metadata_checked_run_id:null},{domain:'screen',metadata_checked_run_id:'manual-kind'},
  ]);
  const repeat=await previewDataRestore(target.db,'restored',backup);assert.equal(repeat.total.added,0);assert.equal(repeat.total.conflicts,0);
});

void test('restoring confirmed movie and series classifications protects them while unknown screen records remain eligible for metadata',async(t)=>{
  const source=fixture(t);
  for(const [index,kind] of ['movie','series','screen'].entries())seedDouban(source.sqlite,'alice',doubanRow({subject_id:String(index+1),kind,url:`https://movie.douban.com/subject/${index+1}/`}),A);
  const backup=await exportDataBackup(source.db,'alice',NOW),target=fixture(t),preview=await previewDataRestore(target.db,'restored',backup);
  await restoreDataBackup(target.db,'restored',backup,preview.previewHash);
  assert.deepEqual(target.sqlite.prepare('SELECT kind,metadata_checked_run_id FROM douban_items WHERE user_id=? ORDER BY subject_id').all('restored').map(row=>({...row})),[
    {kind:'movie',metadata_checked_run_id:'manual-kind'},{kind:'series',metadata_checked_run_id:'manual-kind'},{kind:'screen',metadata_checked_run_id:null},
  ]);
  assert.deepEqual((await exportDataBackup(target.db,'restored',NOW)).tables.douban_items,backup.tables.douban_items);
});

void test('browser provenance with a retained imported classification backs up without internal markers and restores the confirmed kind',async(t)=>{
  const source=fixture(t);
  seedDouban(source.sqlite,'alice',doubanRow({kind:'movie',source:'browser',rating:null,comment:null}),'import-kind');
  const backup=await exportDataBackup(source.db,'alice',NOW);
  assert.equal(backup.tables.douban_items[0].source,'browser');
  assert.doesNotMatch(JSON.stringify(backup),/import-kind|metadata_checked_run_id/);
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored',backup);
  await restoreDataBackup(target.db,'restored',backup,preview.previewHash);
  assert.deepEqual({...target.sqlite.prepare('SELECT kind,source,rating,comment,metadata_checked_run_id FROM douban_items WHERE user_id=?').get('restored')},
    {kind:'movie',source:'browser',rating:null,comment:null,metadata_checked_run_id:'manual-kind'});
  assert.deepEqual((await exportDataBackup(target.db,'restored',NOW)).tables.douban_items,backup.tables.douban_items);
});

void test('Douban business changes are previewed as conflicts while a newer unchanged observation is retained',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');const backup=await exportDataBackup(source.db,'alice',NOW);
  const target=fixture(t);seedDouban(target.sqlite,'alice',doubanRow({comment:'较新的本人短评',rating:4}));
  const conflict=await previewDataRestore(target.db,'alice',backup);
  assert.equal(conflict.canRestore,false);assert.equal(conflict.total.conflicts,1);
  const example=conflict.tables.find(table=>table.table==='douban_items')?.conflictExamples[0];
  assert.equal(example?.record,'合成豆瓣剧集');assert.ok(example?.differences?.some(field=>field.field==='comment'));
  await assert.rejects(restoreDataBackup(target.db,'alice',backup,conflict.previewHash),BackupConflictError);
  assert.equal(target.sqlite.prepare('SELECT comment FROM douban_items WHERE user_id=?').get('alice')?.comment,'较新的本人短评');
  target.sqlite.prepare('UPDATE douban_items SET comment=?,rating=?,observed_at=? WHERE user_id=?').run('本人标记的合成短评',5,'2026-11-11T04:00:00.000Z','alice');
  const unchanged=await previewDataRestore(target.db,'alice',backup);
  assert.equal(unchanged.canRestore,true);assert.equal(unchanged.total.added,0);assert.equal(unchanged.total.skipped,1);
  await restoreDataBackup(target.db,'alice',backup,unchanged.previewHash);
  assert.equal(target.sqlite.prepare('SELECT observed_at FROM douban_items WHERE user_id=?').get('alice')?.observed_at,'2026-11-11T04:00:00.000Z');
});

void test('a concurrent Douban edit during restoration aborts the complete batch and preserves the latest comment',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');seedDouban(source.sqlite,'alice',doubanRow({subject_id:'1234567',title:'另一合成影视',url:'https://movie.douban.com/subject/1234567/'}));
  const backup=await exportDataBackup(source.db,'alice',NOW),target=fixture(t);seedDouban(target.sqlite,'alice');
  const preview=await previewDataRestore(target.db,'alice',backup);assert.equal(preview.total.added,1);
  target.mutateNextBatch(()=>target.sqlite.prepare('UPDATE douban_items SET comment=? WHERE user_id=?').run('恢复预览后刚修改的短评','alice'));
  await assert.rejects(restoreDataBackup(target.db,'alice',backup,preview.previewHash),BackupConflictError);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM douban_items WHERE user_id=?').get('alice')?.n,1);
  assert.equal(target.sqlite.prepare('SELECT comment FROM douban_items WHERE user_id=?').get('alice')?.comment,'恢复预览后刚修改的短评');
});

void test('Douban backup validation rejects spoofed sources, malformed records, owner fields and sync-control metadata',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');const backup=await exportDataBackup(source.db,'alice',NOW);
  const changes:Array<(row:Record<string,string|number|null>)=>void>=[
    row=>{row.profile_id='https://elsewhere.invalid/people/example/';},row=>{row.domain='book';},row=>{row.kind='book';},
    row=>{row.url='https://movie.douban.com.evil.invalid/subject/1292052/';},row=>{row.subject_id='7654321';},
    row=>{row.rating=0;},row=>{row.rating=6;},row=>{row.marked_date='2026-02-30';},row=>{row.published_at='not a timestamp';},
    row=>{row.source='official-api';},row=>{row.user_id='bob';},row=>{row.metadata_checked_run_id=A;},
    row=>{row.updated_at=OLD;},row=>{row.observed_at=OLD;},row=>{row.title=' ';},row=>{row.comment='invalid\u0000comment';},
  ];
  for(const change of changes){const invalid=structuredClone(backup);change(invalid.tables.douban_items[0]);assert.throws(()=>parseDataBackup(invalid),BackupValidationError);}
  const duplicate=structuredClone(backup);duplicate.tables.douban_items.push({...duplicate.tables.douban_items[0]});assert.throws(()=>parseDataBackup(duplicate),BackupValidationError);
});

void test('published 30-table single backups gain empty Douban records and never implicitly restore a connection',async(t)=>{
  const source=fixture(t);await seed(source.db,source.sqlite);
  const current=await exportDataBackup(source.db,'alice',NOW);
  const old=structuredClone(current) as unknown as {tables:Record<string,unknown>};delete old.tables.douban_items;
  assert.equal(Object.keys(old.tables).length,30);
  const parsed=parseDataBackup(old);assert.deepEqual(parsed.tables.douban_items,[]);
  const target=fixture(t);const preview=await previewDataRestore(target.db,'restored',old);
  assert.equal(preview.canRestore,true);await restoreDataBackup(target.db,'restored',old,preview.previewHash);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM douban_items').get()?.n,0);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM douban_connections').get()?.n,0);
});

void test('the same 31 backup tables roundtrip rich Douban details and keep personal and site ratings independent',async(t)=>{
  const source=fixture(t),details={summary:'合成内容简介\n第二段',doubanRating:8.8,ratingCount:123,authors:['合成作者'],translators:['合成译者'],publisher:'合成出版社',publicationDate:'2001-09',isbn:'9780000000001',pages:321,price:'39.00元',binding:'平装',seriesTitle:'合成丛书'};
  seedDouban(source.sqlite,'alice',doubanRow({domain:'book',kind:'book',subject_id:'1234567',url:'https://book.douban.com/subject/1234567/',rating:4,details_json:JSON.stringify(parseDoubanDetails(details))}));
  const backup=await exportDataBackup(source.db,'alice',NOW);assert.equal(BACKUP_TABLE_NAMES.length,31);
  assert.equal(backup.tables.douban_items[0].rating,4);assert.deepEqual(JSON.parse(String(backup.tables.douban_items[0].details_json)),details);
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored',backup);assert.equal(preview.canRestore,true);
  await restoreDataBackup(target.db,'restored',backup,preview.previewHash);
  assert.deepEqual((await exportDataBackup(target.db,'restored',NOW)).tables.douban_items,backup.tables.douban_items);
  const volumes=await splitBackupVolumes(backup),volumeTarget=fixture(t),volumePreview=await previewDataRestore(volumeTarget.db,'restored',volumes);
  await restoreDataBackup(volumeTarget.db,'restored',volumes,volumePreview.previewHash);
  assert.deepEqual((await exportDataBackup(volumeTarget.db,'restored',NOW)).tables.douban_items,backup.tables.douban_items);
});

void test('published Douban backups without details_json normalize to empty details and retain richer current records',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');
  const backup=await exportDataBackup(source.db,'alice',NOW),legacy=structuredClone(backup);
  delete legacy.tables.douban_items[0].details_json;
  assert.equal(parseDataBackup(legacy).tables.douban_items[0].details_json,'{}');
  const empty=fixture(t),restore=await previewDataRestore(empty.db,'restored',legacy);
  await restoreDataBackup(empty.db,'restored',legacy,restore.previewHash);
  assert.equal(empty.sqlite.prepare('SELECT details_json FROM douban_items').get()?.details_json,'{}');
  const setId=await backupDigest(legacy),volume={kind:'jiashu-os-backup-volume',version:1,setId,exportedAt:NOW,partIndex:1,totalParts:1,tables:legacy.tables};
  const descriptor={partIndex:1,rowCount:1,byteLength:new TextEncoder().encode(JSON.stringify(volume)).byteLength,sha256:await backupDigest(volume)};
  const signed={kind:'jiashu-os-backup-set',version:1,manifest:{kind:'jiashu-os-backup-manifest',version:1,backupVersion:2,setId,exportedAt:NOW,totalRows:1,volumes:[descriptor]},volumes:[volume]};
  const volumeTarget=fixture(t),volumePreview=await previewDataRestore(volumeTarget.db,'restored',signed);
  await restoreDataBackup(volumeTarget.db,'restored',signed,volumePreview.previewHash);
  assert.equal(volumeTarget.sqlite.prepare('SELECT details_json FROM douban_items').get()?.details_json,'{}');
  const target=fixture(t),rich=JSON.stringify(parseDoubanDetails({directors:['合成导演'],summary:'已补全的作品介绍',doubanRating:9.1}));
  seedDouban(target.sqlite,'restored',doubanRow({details_json:rich}));
  const preview=await previewDataRestore(target.db,'restored',legacy);assert.equal(preview.canRestore,true);assert.equal(preview.total.skipped,1);assert.equal(preview.total.added,0);
  await restoreDataBackup(target.db,'restored',legacy,preview.previewHash);
  assert.equal(target.sqlite.prepare('SELECT details_json FROM douban_items').get()?.details_json,rich);
});

void test('detail changes affect preview fingerprints and conflicting rich values never overwrite current details',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice',doubanRow({details_json:JSON.stringify(parseDoubanDetails({summary:'备份中的介绍'}))}));
  const backup=await exportDataBackup(source.db,'alice',NOW),target=fixture(t);
  seedDouban(target.sqlite,'restored',doubanRow({details_json:JSON.stringify(parseDoubanDetails({summary:'当前较新的介绍'}))}));
  const first=await previewDataRestore(target.db,'restored',backup);assert.equal(first.canRestore,false);assert.equal(first.total.conflicts,1);
  assert.ok(first.tables.find(table=>table.table==='douban_items')?.conflictExamples[0]?.differences?.some(item=>item.field==='details_json'));
  await assert.rejects(restoreDataBackup(target.db,'restored',backup,first.previewHash),BackupConflictError);
  target.sqlite.prepare('UPDATE douban_items SET details_json=?').run(JSON.stringify(parseDoubanDetails({summary:'随后更新的介绍'})));
  const second=await previewDataRestore(target.db,'restored',backup);assert.notEqual(first.previewHash,second.previewHash);
  assert.equal(JSON.parse(String(target.sqlite.prepare('SELECT details_json FROM douban_items').get()?.details_json)).summary,'随后更新的介绍');
  const changed=structuredClone(backup);changed.tables.douban_items[0].details_json=JSON.stringify(parseDoubanDetails({summary:'另一份备份介绍'}));
  assert.notEqual((await previewDataRestore(target.db,'restored',changed)).backupHash,second.backupHash);
});

void test('a concurrent detail enrichment invalidates restore guards and aborts all additions',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');seedDouban(source.sqlite,'alice',doubanRow({subject_id:'1234567',url:'https://movie.douban.com/subject/1234567/'}));
  const backup=await exportDataBackup(source.db,'alice',NOW),target=fixture(t);seedDouban(target.sqlite,'restored');
  const preview=await previewDataRestore(target.db,'restored',backup);assert.equal(preview.total.added,1);
  target.mutateNextBatch(()=>target.sqlite.prepare('UPDATE douban_items SET details_json=?').run(JSON.stringify(parseDoubanDetails({directors:['刚补全的导演']}))));
  await assert.rejects(restoreDataBackup(target.db,'restored',backup,preview.previewHash),BackupConflictError);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM douban_items').get()?.n,1);
  assert.deepEqual(JSON.parse(String(target.sqlite.prepare('SELECT details_json FROM douban_items').get()?.details_json)).directors,['刚补全的导演']);
});

void test('backup details strictly reject unknown fields, wrong types, markup, credentials and oversized data',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');const backup=await exportDataBackup(source.db,'alice',NOW);
  const bad:unknown[]=[null,'[]','broken JSON',JSON.stringify({cookie:'PRIVATE'}),JSON.stringify({tags:['不支持']}),JSON.stringify({authors:'应为数组'}),JSON.stringify({doubanRating:11}),JSON.stringify({summary:'<script>PRIVATE</script>'}),JSON.stringify({summary:'字'.repeat(6000)})];
  for(const value of bad){const invalid=structuredClone(backup);invalid.tables.douban_items[0].details_json=value as string|null;assert.throws(()=>parseDataBackup(invalid),BackupValidationError);}
});

void test('personal Douban notes, tags, visibility and local versions roundtrip in the same 31 backup tables',async(t)=>{
  const source=fixture(t);
  seedDouban(source.sqlite,'alice',doubanRow({local_note:'重看后的感受\n下次推荐给家人',local_tags_json:JSON.stringify(['值得重看','家庭']),local_hidden:1,local_revision:3}));
  seedDouban(source.sqlite,'bob',doubanRow({local_note:'BOB-PRIVATE-NOTE',local_tags_json:'["BOB-PRIVATE-TAG"]',local_hidden:1,local_revision:1}));
  const backup=await exportDataBackup(source.db,'alice',NOW);
  assert.equal(BACKUP_TABLE_NAMES.length,31);assert.doesNotMatch(JSON.stringify(backup),/BOB-PRIVATE/);
  assert.equal(backup.tables.douban_items[0].local_hidden,1);
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored',backup);
  await restoreDataBackup(target.db,'restored',backup,preview.previewHash);
  assert.deepEqual((await exportDataBackup(target.db,'restored',NOW)).tables.douban_items,backup.tables.douban_items);
  const volumes=await splitBackupVolumes(backup),volumeTarget=fixture(t),volumePreview=await previewDataRestore(volumeTarget.db,'restored',volumes);
  await restoreDataBackup(volumeTarget.db,'restored',volumes,volumePreview.previewHash);
  assert.deepEqual((await exportDataBackup(volumeTarget.db,'restored',NOW)).tables.douban_items,backup.tables.douban_items);
});

void test('published Douban files without local fields keep later personal organization and richer details',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');
  const legacy=await exportDataBackup(source.db,'alice',NOW);
  for(const key of ['local_note','local_tags_json','local_hidden','local_revision'])delete legacy.tables.douban_items[0][key];
  const empty=fixture(t),emptyPreview=await previewDataRestore(empty.db,'restored',legacy);
  await restoreDataBackup(empty.db,'restored',legacy,emptyPreview.previewHash);
  assert.deepEqual(empty.sqlite.prepare('SELECT local_note,local_tags_json,local_hidden,local_revision FROM douban_items').get(),Object.assign(Object.create(null),{local_note:'',local_tags_json:'[]',local_hidden:0,local_revision:0}));
  const target=fixture(t),details=JSON.stringify(parseDoubanDetails({summary:'后续补全的简介'}));
  seedDouban(target.sqlite,'restored',doubanRow({details_json:details,local_note:'新的本地备注',local_tags_json:'["收藏"]',local_hidden:1,local_revision:4}));
  const preview=await previewDataRestore(target.db,'restored',legacy);
  assert.equal(preview.canRestore,true);assert.equal(preview.total.skipped,1);
  await restoreDataBackup(target.db,'restored',legacy,preview.previewHash);
  assert.equal(target.sqlite.prepare('SELECT local_note FROM douban_items').get()?.local_note,'新的本地备注');
  assert.equal(target.sqlite.prepare('SELECT details_json FROM douban_items').get()?.details_json,details);
});

void test('local versions alone do not conflict but different personal organization must be reviewed',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice',doubanRow({local_note:'相同备注',local_tags_json:'["重看"]',local_revision:1}));
  const backup=await exportDataBackup(source.db,'alice',NOW),target=fixture(t);
  seedDouban(target.sqlite,'restored',doubanRow({local_note:'相同备注',local_tags_json:'["重看"]',local_revision:9}));
  const same=await previewDataRestore(target.db,'restored',backup);assert.equal(same.canRestore,true);assert.equal(same.total.skipped,1);
  await restoreDataBackup(target.db,'restored',backup,same.previewHash);
  assert.equal(target.sqlite.prepare('SELECT local_revision FROM douban_items').get()?.local_revision,9);
  target.sqlite.prepare('UPDATE douban_items SET local_note=?').run('当前更新的备注');
  const conflict=await previewDataRestore(target.db,'restored',backup);assert.equal(conflict.canRestore,false);
  assert.ok(conflict.tables.find(row=>row.table==='douban_items')?.conflictExamples[0]?.differences?.some(field=>field.field==='local_note'));
  await assert.rejects(restoreDataBackup(target.db,'restored',backup,conflict.previewHash),BackupConflictError);
});

void test('a concurrent local edit invalidates the preview and aborts restoration atomically',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');seedDouban(source.sqlite,'alice',doubanRow({subject_id:'1234567',url:'https://movie.douban.com/subject/1234567/'}));
  const backup=await exportDataBackup(source.db,'alice',NOW),target=fixture(t);seedDouban(target.sqlite,'restored');
  const preview=await previewDataRestore(target.db,'restored',backup);
  target.mutateNextBatch(()=>target.sqlite.prepare('UPDATE douban_items SET local_note=?,local_revision=local_revision+1').run('并发保存的备注'));
  await assert.rejects(restoreDataBackup(target.db,'restored',backup,preview.previewHash),BackupConflictError);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM douban_items').get()?.n,1);
  assert.equal(target.sqlite.prepare('SELECT local_note FROM douban_items').get()?.local_note,'并发保存的备注');
  const changed=await previewDataRestore(target.db,'restored',backup);assert.notEqual(changed.previewHash,preview.previewHash);
});

void test('backup local fields reject invalid tags, notes, visibility and revisions',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice');const backup=await exportDataBackup(source.db,'alice',NOW);
  const changes:Array<(row:Record<string,string|number|null>)=>void>=[
    row=>{row.local_note='字'.repeat(4001);},row=>{row.local_note='坏\u0085备注';},
    row=>{row.local_tags_json='null';},row=>{row.local_tags_json='["重复","重复"]';},row=>{row.local_tags_json='[" 标签"]';},
    row=>{row.local_tags_json=JSON.stringify(['坏\n标签']);},row=>{row.local_tags_json=JSON.stringify(['字'.repeat(31)]);},
    row=>{row.local_tags_json=JSON.stringify(Array.from({length:13},(_,index)=>String(index)));},row=>{row.local_hidden=2;},row=>{row.local_revision=-1;},row=>{row.local_revision=1.5;},
  ];
  for(const change of changes){const invalid=structuredClone(backup);change(invalid.tables.douban_items[0]);assert.throws(()=>parseDataBackup(invalid),BackupValidationError);}
});

void test('browser collections remain fully restorable after batch classification advances their observation time',async(t)=>{
  const source=fixture(t),classifiedAt='2026-11-10T05:00:00.000Z';
  seedDouban(source.sqlite,'alice',doubanRow({source:'browser',kind:'screen',local_note:'独立备注',local_tags_json:'["待重看","家人推荐"]',local_hidden:1,local_revision:2}));
  seedDouban(source.sqlite,'alice',doubanRow({source:'browser',subject_id:'1234567',url:'https://movie.douban.com/subject/1234567/',kind:'movie',local_note:'另一条备注',local_tags_json:'["收藏"]',local_revision:1}));
  const classified=await classifyDoubanLibrary(source.db,'alice',{kind:'series',expectedDataEpoch:0,items:[
    {profileId:'synthetic-profile',domain:'screen',subjectId:'1292052',expectedUpdatedAt:NOW},
    {profileId:'synthetic-profile',domain:'screen',subjectId:'1234567',expectedUpdatedAt:NOW},
  ]},classifiedAt);
  assert.equal(classified.length,2);
  for(const item of classified){assert.equal(item.kind,'series');assert.equal(item.source,'browser');assert.equal(item.updatedAt,classifiedAt);assert.equal(item.observedAt,classifiedAt);}
  const backup=await exportDataBackup(source.db,'alice',classifiedAt);
  for(const row of backup.tables.douban_items){assert.equal(row.source,'browser');assert.equal(row.kind,'series');assert.ok(String(row.created_at)<=String(row.updated_at));assert.ok(String(row.updated_at)<=String(row.observed_at));}
  const hidden=backup.tables.douban_items.find(row=>row.subject_id==='1292052');
  assert.equal(hidden?.local_note,'独立备注');assert.equal(hidden?.local_tags_json,'["待重看","家人推荐"]');assert.equal(hidden?.local_hidden,1);assert.equal(hidden?.local_revision,2);
  const target=fixture(t),preview=await previewDataRestore(target.db,'restored',backup);
  assert.equal(preview.canRestore,true);assert.equal(preview.total.added,2);
  await restoreDataBackup(target.db,'restored',backup,preview.previewHash);
  assert.deepEqual((await exportDataBackup(target.db,'restored',classifiedAt)).tables.douban_items,backup.tables.douban_items);
});

void test('an older import-source snapshot conflicts with a current browser-source collection without overwriting it',async(t)=>{
  const source=fixture(t);seedDouban(source.sqlite,'alice',doubanRow({source:'import',local_note:'自己的备注',local_tags_json:'["珍藏"]',local_hidden:1,local_revision:2}));
  const backup=await exportDataBackup(source.db,'alice',NOW),target=fixture(t);
  seedDouban(target.sqlite,'restored',doubanRow({source:'browser',local_note:'自己的备注',local_tags_json:'["珍藏"]',local_hidden:1,local_revision:2}));
  const before=await exportDataBackup(target.db,'restored',NOW),preview=await previewDataRestore(target.db,'restored',backup);
  assert.equal(preview.canRestore,false);assert.equal(preview.total.conflicts,1);
  assert.deepEqual(preview.tables.find(row=>row.table==='douban_items')?.conflictExamples[0]?.differences,[{field:'source',current:'browser',incoming:'import'}]);
  await assert.rejects(restoreDataBackup(target.db,'restored',backup,preview.previewHash),BackupConflictError);
  assert.deepEqual((await exportDataBackup(target.db,'restored',NOW)).tables.douban_items,before.tables.douban_items);
});
