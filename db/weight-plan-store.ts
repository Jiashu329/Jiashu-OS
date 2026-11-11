import type { WeightPlanInput, WeightPlanSettings } from '../lib/weight-plan.ts';

export type WeightPlanDatabase = Pick<D1Database, 'prepare'>;
interface WeightPlanRow extends Omit<WeightPlanSettings, 'enabled'> { enabled: number }
const columns = `baseline_weight AS baselineWeight, target_weight AS targetWeight,
  start_date AS startDate, deadline, enabled, created_at AS createdAt, updated_at AS updatedAt, revision`;
function settings(row: WeightPlanRow): WeightPlanSettings { return { ...row, enabled: row.enabled === 1 }; }
export class WeightPlanConflictError extends Error { readonly code='WEIGHT_PLAN_CONFLICT'; constructor(){super('体重计划已在另一页面更新。你的填写已保留，请载入最新版本后核对再保存。');this.name='WeightPlanConflictError';} }
export async function readWeightPlanSettings(db: WeightPlanDatabase, userId: string): Promise<WeightPlanSettings | null> {
  const row = await db.prepare(`SELECT ${columns} FROM health_weight_plan_settings WHERE user_id = ?`).bind(userId).first<WeightPlanRow>();
  return row ? settings(row) : null;
}
export async function writeWeightPlanSettings(db: WeightPlanDatabase, userId: string, input: WeightPlanInput, expectedRevision: number, now = new Date().toISOString()): Promise<WeightPlanSettings> {
  const row = await db.prepare(`INSERT INTO health_weight_plan_settings
    (user_id,baseline_weight,target_weight,start_date,deadline,enabled,revision,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT revision FROM health_weight_plan_settings WHERE user_id=?),0)=?
    ON CONFLICT(user_id) DO UPDATE SET baseline_weight=excluded.baseline_weight,target_weight=excluded.target_weight,
      start_date=excluded.start_date,deadline=excluded.deadline,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at
    WHERE health_weight_plan_settings.revision=? RETURNING ${columns}`)
    .bind(userId,input.baselineWeight,input.targetWeight,input.startDate,input.deadline,input.enabled?1:0,expectedRevision+1,now,now,userId,expectedRevision,expectedRevision).first<WeightPlanRow>();
  if (!row) throw new WeightPlanConflictError();
  return settings(row);
}
