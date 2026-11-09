import type { WeightPlanInput, WeightPlanSettings } from '../lib/weight-plan.ts';

export type WeightPlanDatabase = Pick<D1Database, 'prepare'>;
interface WeightPlanRow extends Omit<WeightPlanSettings, 'enabled'> { enabled: number }
const columns = `baseline_weight AS baselineWeight, target_weight AS targetWeight,
  start_date AS startDate, deadline, enabled, created_at AS createdAt, updated_at AS updatedAt`;
function settings(row: WeightPlanRow): WeightPlanSettings { return { ...row, enabled: row.enabled === 1 }; }

export async function readWeightPlanSettings(db: WeightPlanDatabase, userId: string): Promise<WeightPlanSettings | null> {
  const row = await db.prepare(`SELECT ${columns} FROM health_weight_plan_settings WHERE user_id = ?`).bind(userId).first<WeightPlanRow>();
  return row ? settings(row) : null;
}

export async function writeWeightPlanSettings(db: WeightPlanDatabase, userId: string, input: WeightPlanInput, now = new Date().toISOString()): Promise<WeightPlanSettings> {
  const row = await db.prepare(`INSERT INTO health_weight_plan_settings
    (user_id, baseline_weight, target_weight, start_date, deadline, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET baseline_weight = excluded.baseline_weight,
      target_weight = excluded.target_weight, start_date = excluded.start_date,
      deadline = excluded.deadline, enabled = excluded.enabled, updated_at = excluded.updated_at
    RETURNING ${columns}`)
    .bind(userId, input.baselineWeight, input.targetWeight, input.startDate, input.deadline, input.enabled ? 1 : 0, now, now).first<WeightPlanRow>();
  if (!row) throw new Error('Weight plan settings were not saved');
  return settings(row);
}
