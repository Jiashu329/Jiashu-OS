import { EMPTY_NUTRITION_GOALS, type NutritionGoals, type NutritionGoalTargets } from '../lib/nutrition-goals.ts';
import { NUTRIENT_KEYS, nutrientDecimal } from '../lib/nutrition-nutrients.ts';
import { NutritionConflictError } from './nutrition-store.ts';

export type NutritionGoalsDatabase = Pick<D1Database, 'prepare'>;
interface GoalRow { caloriesTenth: number | null; carbsTenth: number | null; proteinTenth: number | null; fatTenth: number | null; revision: number; createdAt: string; updatedAt: string }
const columns = 'calories_tenth AS caloriesTenth,carbs_tenth AS carbsTenth,protein_tenth AS proteinTenth,fat_tenth AS fatTenth,revision,created_at AS createdAt,updated_at AS updatedAt';
function goals(row: GoalRow): NutritionGoals {
  return { ...Object.fromEntries(NUTRIENT_KEYS.map((key) => { const value = row[`${key}Tenth`]; return [key, value === null ? null : nutrientDecimal(value)]; })) as NutritionGoalTargets,
    revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export async function readNutritionGoals(db: NutritionGoalsDatabase, userId: string): Promise<NutritionGoals> {
  const row = await db.prepare(`SELECT ${columns} FROM nutrition_goal_settings WHERE user_id=?`).bind(userId).first<GoalRow>();
  return row ? goals(row) : { ...EMPTY_NUTRITION_GOALS };
}
export async function writeNutritionGoals(db: NutritionGoalsDatabase, userId: string, targets: NutritionGoalTargets, expectedRevision: number, now = new Date().toISOString()): Promise<NutritionGoals> {
  const values = NUTRIENT_KEYS.map((key) => targets[key] === null ? null : Number(BigInt(targets[key]!.replace('.', ''))));
  const row = await db.prepare(`INSERT INTO nutrition_goal_settings(user_id,calories_tenth,carbs_tenth,protein_tenth,fat_tenth,revision,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,? WHERE COALESCE((SELECT revision FROM nutrition_goal_settings WHERE user_id=?),0)=?
    ON CONFLICT(user_id) DO UPDATE SET calories_tenth=excluded.calories_tenth,carbs_tenth=excluded.carbs_tenth,protein_tenth=excluded.protein_tenth,
      fat_tenth=excluded.fat_tenth,revision=excluded.revision,updated_at=excluded.updated_at
    WHERE nutrition_goal_settings.revision=? RETURNING ${columns}`)
    .bind(userId,...values,expectedRevision+1,now,now,userId,expectedRevision,expectedRevision).first<GoalRow>();
  if (!row) throw new NutritionConflictError('饮食目标已在另一页面更新，填写内容已保留，请读取最新目标后核对。');
  return goals(row);
}
