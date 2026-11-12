import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import test,{type TestContext} from 'node:test';
import {readWeightPlanSettings,writeWeightPlanSettings,WeightPlanConflictError} from './weight-plan-store.ts';
import {readWeightCycleState,writeWeightCycle} from './weight-cycles-store.ts';
import {validateWeightCycleArchive} from '../lib/weight-cycles.ts';
import type{WeightPlanInput}from'../lib/weight-plan.ts';
const NOW='2026-11-12T04:00:00.000Z',LATER='2026-11-13T04:00:00.000Z',A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const plan:WeightPlanInput={baselineWeight:80,targetWeight:70,startDate:'2026-11-01',deadline:'2026-12-01',enabled:true};
interface Statement{bind(...values:unknown[]):Statement;first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>;execute():{results:unknown[]}}
function fixture(t:TestContext){const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter((file)=>/^\d.*\.sql$/.test(file)).sort())sqlite.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));t.after(()=>sqlite.close());let before:(()=>void)|null=null;
  const db={prepare(sql:string){const query=sqlite.prepare(sql);let args:SQLInputValue[]=[];const bound:Statement={bind(...values){args=values as SQLInputValue[];return bound;},async first<T>(){return(query.get(...args)as T|undefined)??null;},async all<T>(){return{results:query.all(...args)as T[]};},execute(){return{results:query.columns().length?query.all(...args):(query.run(...args),[])};}};return bound;},async batch(statements:Statement[]){before?.();before=null;sqlite.exec('BEGIN');try{const rows=statements.map((statement)=>statement.execute());sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}}}as unknown as D1Database;return{db,sqlite,race(fn:()=>void){before=fn;}};}
test('archive freezes the existing baseline cycle and exact retries cannot change its summary',async(t)=>{
  const f=fixture(t);await writeWeightPlanSettings(f.db,'alice',plan,0,NOW);
  const measurements=[{id:'weight:a',metric:'weight' as const,value:75,unit:'kg' as const,aggregation:'sample' as const,startDate:'2026-11-12T00:00:00Z',source:'synthetic'}];
  const original=await writeWeightCycle(f.db,'alice',{action:'archive',expectedRevision:1},A,measurements,NOW);assert.equal(original.replayed,false);
  const state=await readWeightCycleState(f.db,'alice');assert.equal(state.cycle?.id,'legacy');assert.equal(state.cycle?.archivedAt,NOW);assert.equal(state.cycles[0].summary.average7,75);assert.equal(state.cycles[0].settings.enabled,true);assert.equal((await readWeightPlanSettings(f.db,'alice'))?.enabled,false);assert.doesNotThrow(()=>validateWeightCycleArchive(state.cycles[0],Date.parse(NOW)));
  await assert.rejects(writeWeightPlanSettings(f.db,'alice',plan,2,LATER),WeightPlanConflictError);
  assert.equal((await writeWeightCycle(f.db,'alice',{action:'archive',expectedRevision:1},A,[],LATER)).replayed,true);assert.deepEqual((await readWeightCycleState(f.db,'alice')).cycles,state.cycles);
});
test('new cycle requires an archived or empty current plan and keeps old summaries and global CAS epoch',async(t)=>{
  const f=fixture(t);await writeWeightPlanSettings(f.db,'alice',plan,0,NOW);
  await assert.rejects(writeWeightCycle(f.db,'alice',{action:'start',expectedRevision:1,plan},B,[],NOW),WeightPlanConflictError);
  await writeWeightCycle(f.db,'alice',{action:'archive',expectedRevision:1},A,[],NOW);
  const next={...plan,baselineWeight:75,targetWeight:72,startDate:'2026-11-13'};
  await writeWeightCycle(f.db,'alice',{action:'start',expectedRevision:2,plan:next},B,[],LATER);
  const state=await readWeightCycleState(f.db,'alice');assert.deepEqual(state.cycle,{id:B,archivedAt:null});assert.equal(state.cycles.length,1);assert.equal(state.cycles[0].settings.targetWeight,70);assert.equal((await readWeightPlanSettings(f.db,'alice'))?.revision,3);assert.equal((await readWeightPlanSettings(f.db,'alice'))?.createdAt,LATER);
  assert.equal((await writeWeightCycle(f.db,'alice',{action:'start',expectedRevision:2,plan:next},B,[],LATER)).replayed,true);
  await assert.rejects(writeWeightCycle(f.db,'alice',{action:'start',expectedRevision:2,plan:{...next,targetWeight:60}},B,[],LATER),WeightPlanConflictError);
  await writeWeightCycle(f.db,'bob',{action:'start',expectedRevision:0,plan},B,[],NOW);assert.equal((await readWeightPlanSettings(f.db,'bob'))?.revision,1);assert.equal((await readWeightCycleState(f.db,'bob')).cycles.length,0);
});
test('a concurrent edit cannot leave an orphan archive or receipt and a database failure rolls back the whole operation',async(t)=>{
  const f=fixture(t);await writeWeightPlanSettings(f.db,'alice',plan,0,NOW);
  f.race(()=>{f.sqlite.prepare('UPDATE health_weight_plan_settings SET target_weight=65,revision=2 WHERE user_id=?').run('alice');});
  await assert.rejects(writeWeightCycle(f.db,'alice',{action:'archive',expectedRevision:1},A,[],NOW),WeightPlanConflictError);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM health_weight_plan_operations').get()?.n,0);assert.equal((await readWeightCycleState(f.db,'alice')).cycles.length,0);
  f.sqlite.exec("CREATE TRIGGER reject_cycle_archive BEFORE UPDATE ON health_weight_plan_settings BEGIN SELECT RAISE(ABORT,'synthetic failure');END;");
  await assert.rejects(writeWeightCycle(f.db,'alice',{action:'archive',expectedRevision:2},A,[],NOW),/synthetic failure/);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM health_weight_plan_operations').get()?.n,0);assert.equal((await readWeightCycleState(f.db,'alice')).cycles.length,0);assert.equal((await readWeightPlanSettings(f.db,'alice'))?.targetWeight,65);
});
test('a migrated revision-zero baseline can be archived without inventing a new version in its immutable snapshot',async(t)=>{
  const f=fixture(t);await writeWeightPlanSettings(f.db,'alice',plan,0,NOW);f.sqlite.prepare('UPDATE health_weight_plan_settings SET revision=0 WHERE user_id=?').run('alice');
  await writeWeightCycle(f.db,'alice',{action:'archive',expectedRevision:0},A,[],NOW);const cycle=(await readWeightCycleState(f.db,'alice')).cycles[0];
  assert.equal(cycle.settings.revision,0);assert.equal((await readWeightPlanSettings(f.db,'alice'))?.revision,1);assert.doesNotThrow(()=>validateWeightCycleArchive(cycle,Date.parse(NOW)));
});
