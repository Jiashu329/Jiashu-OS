import { emptyGoalSettings } from '../lib/health-goals.ts';
import type { GoalSettings, GoalTargets } from '../lib/health-goals.ts';

/** Independent of Worker globals for SQLite-backed persistence tests. */
export type HealthGoalsDatabase = Pick<D1Database, 'prepare'>;
interface GoalSettingsRow {
  steps: number | null;
  sleep: number | null;
  activeEnergy: number | null;
  updatedAt: string;
}
const columns = 'steps_target AS steps, sleep_target AS sleep, active_energy_target AS activeEnergy, updated_at AS updatedAt';

function settings(row: GoalSettingsRow): GoalSettings {
  return { targets: { steps: row.steps, sleep: row.sleep, active_energy: row.activeEnergy }, updatedAt: row.updatedAt };
}

export async function readGoalSettings(db: HealthGoalsDatabase, userId: string): Promise<GoalSettings> {
  const row = await db.prepare('SELECT ' + columns + ' FROM health_goal_settings WHERE user_id = ?')
    .bind(userId).first<GoalSettingsRow>();
  return row ? settings(row) : emptyGoalSettings();
}

export async function writeGoalSettings(db: HealthGoalsDatabase, userId: string, targets: GoalTargets, now = new Date().toISOString()): Promise<GoalSettings> {
  const row = await db.prepare(`
    INSERT INTO health_goal_settings (user_id, steps_target, sleep_target, active_energy_target, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET steps_target = excluded.steps_target,
      sleep_target = excluded.sleep_target, active_energy_target = excluded.active_energy_target,
      updated_at = excluded.updated_at
    RETURNING ${columns}
  `).bind(userId, targets.steps, targets.sleep, targets.active_energy, now).first<GoalSettingsRow>();
  if (!row) throw new Error('Health goal settings were not saved');
  return settings(row);
}
