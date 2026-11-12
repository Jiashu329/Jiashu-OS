import { env } from 'cloudflare:workers';
import { readGoalSettings } from '../../../../db/health-goals-store';
import { readHealthRange } from '../../../../db/health-repository';
import { readWeightPlanSettings } from '../../../../db/weight-plan-store';
import { listNutritionEntries } from '../../../../db/nutrition-store';
import { readWeeklyActions } from '../../../../db/health-weekly-actions-store';
import { shiftWeekDay } from '../../../../lib/health-weekly-actions';
import { buildHealthWeeklyReview, HealthWeekValidationError, parseHealthWeekQuery } from '../../../../lib/health-weekly';
import { apiUser, json, unauthenticated, unavailable } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const now = Date.now();
    const selection = parseHealthWeekQuery(new URL(request.url).searchParams, now);
    if (!env.DB) throw new Error('Health database is not configured');
    const [health, settings, nutrition, weightPlan, actions] = await Promise.all([
      readHealthRange(user.userId, selection.previousStart, selection.cutoffDay),
      readGoalSettings(env.DB, user.userId),
      listNutritionEntries(env.DB, user.userId, { from: selection.previousStart, to: selection.cutoffDay }),
      readWeightPlanSettings(env.DB, user.userId),
      readWeeklyActions(env.DB, user.userId, [selection.previousStart, selection.weekStart, shiftWeekDay(selection.weekStart, 7)]),
    ]);
    return json(buildHealthWeeklyReview(health.measurements, settings, selection, now, {
      nutrition, weightPlan, actions: { previous: actions[0], current: actions[1], next: actions[2] },
    }));
  } catch (error) {
    if (error instanceof HealthWeekValidationError) return json({ error: error.message, code: error.code }, 400);
    return unavailable();
  }
}
