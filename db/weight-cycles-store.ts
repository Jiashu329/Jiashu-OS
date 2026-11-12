import { WeightPlanConflictError, readWeightPlanSettings } from './weight-plan-store.ts';
import { buildWeightCycleSummary } from '../lib/weight-cycles.ts';
import type { WeightCycleArchive, WeightCycleCommand } from '../lib/weight-cycles.ts';
import type { HealthMeasurement } from '../lib/health.ts';

export type WeightCycleDatabase=Pick<D1Database,'prepare'|'batch'>;
interface Receipt{action:string;requestHash:string;cycleId:string}
interface ArchiveRow{id:string;settingsJson:string;summaryJson:string;startedAt:string;archivedAt:string}
const receiptSQL='SELECT action,request_hash AS requestHash,cycle_id AS cycleId FROM health_weight_plan_operations WHERE user_id=? AND id=?';
export async function readWeightCycleState(db:WeightCycleDatabase,userId:string){
  const row=await db.prepare('SELECT cycle_id AS id,archived_at AS archivedAt FROM health_weight_plan_settings WHERE user_id=?').bind(userId).first<{id:string;archivedAt:string|null}>();
  const count=await db.prepare('SELECT count(*) AS total FROM health_weight_plan_cycles WHERE user_id=?').bind(userId).first<{total:number}>();
  return{cycle:row?{...row}:null,cycleCount:Number(count?.total??0),cycles:await readWeightCycles(db,userId)};
}
export async function readWeightCycles(db:WeightCycleDatabase,userId:string,offset=0):Promise<WeightCycleArchive[]>{
  const rows=await db.prepare('SELECT id,settings_json AS settingsJson,summary_json AS summaryJson,started_at AS startedAt,archived_at AS archivedAt FROM health_weight_plan_cycles WHERE user_id=? ORDER BY archived_at DESC,id DESC LIMIT 50 OFFSET ?').bind(userId,offset).all<ArchiveRow>();
  return rows.results.map((row)=>({id:row.id,settings:JSON.parse(row.settingsJson),summary:JSON.parse(row.summaryJson),startedAt:row.startedAt,archivedAt:row.archivedAt}));
}
/** Receipt and CAS mutation share one D1 transaction. A retry never recalculates an archived summary. */
export async function writeWeightCycle(db:WeightCycleDatabase,userId:string,command:WeightCycleCommand,id:string,measurements:readonly HealthMeasurement[],now=new Date().toISOString()){
  const requestHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(command))))].map((value)=>value.toString(16).padStart(2,'0')).join('');
  const replay=async()=>{const prior=await db.prepare(receiptSQL).bind(userId,id).first<Receipt>();if(!prior)return null;if(prior.requestHash!==requestHash||prior.action!==command.action)throw new WeightPlanConflictError();return{cycleId:prior.cycleId,replayed:true};};
  const prior=await replay();if(prior)return prior;
  const current=await readWeightPlanSettings(db,userId);
  const context=await db.prepare('SELECT cycle_id AS id,archived_at AS archivedAt FROM health_weight_plan_settings WHERE user_id=?').bind(userId).first<{id:string;archivedAt:string|null}>();
  if((current?.revision??0)!==command.expectedRevision)throw new WeightPlanConflictError();
  let statements:D1PreparedStatement[];
  if(command.action==='archive'){
    if(!current||!context||context.archivedAt!==null)throw new WeightPlanConflictError();
    const summary=buildWeightCycleSummary(current,measurements,Date.parse(now));
    statements=[
      db.prepare('INSERT OR IGNORE INTO health_weight_plan_operations (user_id,id,action,request_hash,cycle_id,created_at) SELECT ?,?,?,?,?,? FROM health_weight_plan_settings WHERE user_id=? AND revision=? AND archived_at IS NULL AND cycle_id=?').bind(userId,id,'archive',requestHash,context.id,now,userId,command.expectedRevision,context.id),
      db.prepare('INSERT OR IGNORE INTO health_weight_plan_cycles (user_id,id,settings_json,summary_json,started_at,archived_at) SELECT ?,?,?,?,?,? FROM health_weight_plan_settings WHERE user_id=? AND revision=? AND archived_at IS NULL AND cycle_id=? AND EXISTS (SELECT 1 FROM health_weight_plan_operations WHERE user_id=? AND id=? AND request_hash=?)').bind(userId,context.id,JSON.stringify(current),JSON.stringify(summary),current.createdAt,now,userId,command.expectedRevision,context.id,userId,id,requestHash),
      db.prepare('UPDATE health_weight_plan_settings SET enabled=0,archived_at=?,updated_at=?,revision=revision+1 WHERE user_id=? AND revision=? AND archived_at IS NULL AND cycle_id=? AND EXISTS (SELECT 1 FROM health_weight_plan_operations WHERE user_id=? AND id=? AND request_hash=?)').bind(now,now,userId,command.expectedRevision,context.id,userId,id,requestHash),
    ];
  }else{
    if(current&&context?.archivedAt===null)throw new WeightPlanConflictError();
    const plan=command.plan;
    statements=[
      db.prepare('INSERT OR IGNORE INTO health_weight_plan_operations (user_id,id,action,request_hash,cycle_id,created_at) SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT revision FROM health_weight_plan_settings WHERE user_id=?),0)=? AND NOT EXISTS (SELECT 1 FROM health_weight_plan_settings WHERE user_id=? AND archived_at IS NULL)').bind(userId,id,'start',requestHash,id,now,userId,command.expectedRevision,userId),
      db.prepare(`INSERT INTO health_weight_plan_settings (user_id,baseline_weight,target_weight,start_date,deadline,enabled,revision,created_at,updated_at,cycle_id,archived_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,NULL WHERE COALESCE((SELECT revision FROM health_weight_plan_settings WHERE user_id=?),0)=? AND NOT EXISTS (SELECT 1 FROM health_weight_plan_settings WHERE user_id=? AND archived_at IS NULL) AND EXISTS (SELECT 1 FROM health_weight_plan_operations WHERE user_id=? AND id=? AND request_hash=?)
       ON CONFLICT(user_id) DO UPDATE SET baseline_weight=excluded.baseline_weight,target_weight=excluded.target_weight,start_date=excluded.start_date,deadline=excluded.deadline,enabled=excluded.enabled,revision=excluded.revision,created_at=excluded.created_at,updated_at=excluded.updated_at,cycle_id=excluded.cycle_id,archived_at=NULL WHERE health_weight_plan_settings.revision=? AND health_weight_plan_settings.archived_at IS NOT NULL`).bind(userId,plan.baselineWeight,plan.targetWeight,plan.startDate,plan.deadline,plan.enabled?1:0,command.expectedRevision+1,now,now,id,userId,command.expectedRevision,userId,userId,id,requestHash,command.expectedRevision),
    ];
  }
  await db.batch(statements);
  const completed=await replay();if(!completed)throw new WeightPlanConflictError();
  return{...completed,replayed:false};
}
