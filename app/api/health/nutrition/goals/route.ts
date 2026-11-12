import { readNutritionGoals, writeNutritionGoals } from '../../../../../db/nutrition-goals-store';
import { readWeightPlanSettings } from '../../../../../db/weight-plan-store';
import { parseNutritionGoals } from '../../../../../lib/nutrition-goals';
import { shanghaiDay } from '../../../../../lib/health';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { nutritionBody, nutritionDatabase, nutritionError, nutritionGuard } from '../_shared';

export const dynamic = 'force-dynamic';
async function context(userId: string) {
  const db = nutritionDatabase();
  const [goals, plan] = await Promise.all([readNutritionGoals(db, userId), readWeightPlanSettings(db, userId)]);
  const today = shanghaiDay(new Date().toISOString());
  return { goals, weightPlan: plan?.enabled && plan.deadline >= today ? plan : null };
}
export async function GET() {
  const user = await apiUser(); if (!user) return unauthenticated();
  try { return json(await context(user.userId)); } catch (error) { return nutritionError(error); }
}
export async function PUT(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = nutritionGuard(request); if (guard) return guard;
  try {
    const { targets, expectedRevision } = parseNutritionGoals(await nutritionBody(request));
    const goals = await writeNutritionGoals(nutritionDatabase(), user.userId, targets, expectedRevision);
    const current = await context(user.userId);
    return json({ ...current, goals });
  } catch (error) { return nutritionError(error); }
}
