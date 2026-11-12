import { emptyGoalSettings } from '../lib/health-goals.ts';
import type { GoalSettings, GoalTargets, GoalVersion } from '../lib/health-goals.ts';

export type HealthGoalsDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface GoalSettingsRow { steps: number | null; sleep: number | null; activeEnergy: number | null; updatedAt: string; revision: number }
const columns = 'steps_target AS steps, sleep_target AS sleep, active_energy_target AS activeEnergy, updated_at AS updatedAt, revision';
export class HealthGoalConflictError extends Error {
  readonly code = 'HEALTH_GOAL_CONFLICT';
  constructor() { super('目标已在另一页面更新，或生效日期早于已有版本。你的填写已保留，请载入最新目标后核对再保存。'); this.name = 'HealthGoalConflictError'; }
}
export async function readGoalSettings(db: HealthGoalsDatabase, userId: string): Promise<GoalSettings> {
  const results = await db.batch([
    db.prepare('SELECT ' + columns + ' FROM health_goal_settings WHERE user_id = ?').bind(userId),
    db.prepare(`SELECT effective_from AS effectiveFrom, revision, steps_target AS steps, sleep_target AS sleep,
      active_energy_target AS activeEnergy, created_at AS createdAt FROM health_goal_versions WHERE user_id = ? ORDER BY effective_from,revision`).bind(userId),
  ]);
  const row = results[0].results[0] as unknown as GoalSettingsRow | undefined;
  if (!row) return emptyGoalSettings();
  const history = (results[1].results as unknown as Array<Omit<GoalVersion,'targets'> & { steps: number | null; sleep: number | null; activeEnergy: number | null }>).map((item) => ({ effectiveFrom:item.effectiveFrom,revision:item.revision,createdAt:item.createdAt,targets:{ steps:item.steps,sleep:item.sleep,active_energy:item.activeEnergy } }));
  return { targets:{ steps:row.steps,sleep:row.sleep,active_energy:row.activeEnergy },updatedAt:row.updatedAt,revision:row.revision,effectiveFrom:history.at(-1)?.effectiveFrom ?? null,history };
}
export async function writeGoalSettings(db: HealthGoalsDatabase, userId: string, targets: GoalTargets, expectedRevision: number, effectiveFrom: string, now = new Date().toISOString()): Promise<GoalSettings> {
  const allowed = `COALESCE((SELECT revision FROM health_goal_settings WHERE user_id=?),0)=?
    AND COALESCE((SELECT MAX(effective_from) FROM health_goal_versions WHERE user_id=?),'1970-01-01')<=?`;
  const result = await db.batch([
    // Capture pre-versioning settings (or the genuinely unset baseline) before
    // the first change. The whole operation is one D1 transaction.
    db.prepare(`INSERT INTO health_goal_versions (user_id,revision,effective_from,steps_target,sleep_target,active_energy_target,created_at)
      SELECT ?,0,'1970-01-01',g.steps_target,g.sleep_target,g.active_energy_target,COALESCE(g.updated_at,?)
      FROM (SELECT 1) seed LEFT JOIN health_goal_settings g ON g.user_id=?
      WHERE NOT EXISTS (SELECT 1 FROM health_goal_versions WHERE user_id=?) AND ${allowed}
      ON CONFLICT(user_id,revision) DO NOTHING`).bind(userId,now,userId,userId,userId,expectedRevision,userId,effectiveFrom),
    db.prepare(`INSERT INTO health_goal_settings (user_id,steps_target,sleep_target,active_energy_target,revision,updated_at)
      SELECT ?,?,?,?,?,? WHERE ${allowed}
      ON CONFLICT(user_id) DO UPDATE SET steps_target=excluded.steps_target,sleep_target=excluded.sleep_target,
      active_energy_target=excluded.active_energy_target,revision=excluded.revision,updated_at=excluded.updated_at
      WHERE health_goal_settings.revision=?`).bind(userId,targets.steps,targets.sleep,targets.active_energy,expectedRevision+1,now,userId,expectedRevision,userId,effectiveFrom,expectedRevision),
    db.prepare(`INSERT INTO health_goal_versions (user_id,revision,effective_from,steps_target,sleep_target,active_energy_target,created_at)
      SELECT user_id,revision,?,steps_target,sleep_target,active_energy_target,updated_at FROM health_goal_settings
      WHERE user_id=? AND revision=? AND changes()=1`).bind(effectiveFrom,userId,expectedRevision+1),
  ]);
  if (result[1].meta.changes !== 1) throw new HealthGoalConflictError();
  return readGoalSettings(db,userId);
}
