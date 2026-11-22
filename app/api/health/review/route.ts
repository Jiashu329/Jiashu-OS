import { env } from 'cloudflare:workers';
import { readGoalSettings } from '../../../../db/health-goals-store';
import { readHealthRange } from '../../../../db/health-repository';
import { readWeightPlanSettings } from '../../../../db/weight-plan-store';
import { listNutritionEntries } from '../../../../db/nutrition-store';
import { readWeeklyActions } from '../../../../db/health-weekly-actions-store';
import { readAppleActivityDaily } from '../../../../db/apple-health-activity-store';
import { buildWeeklyAppleActivity, type WeeklyAppleActivity } from '../../../../lib/apple-activity-supplements';
import { shiftWeekDay } from '../../../../lib/health-weekly-actions';
import { readWithDeadline } from '../../../../lib/read-deadline';
import { buildHealthWeeklyReview, HealthWeekValidationError, parseHealthWeekQuery } from '../../../../lib/health-weekly';
import { buildHealthWeeklyFocus } from '../../../../lib/health-weekly-focus';
import { apiUser, json, unauthenticated, unavailable } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const now = Date.now();
    const selection = parseHealthWeekQuery(new URL(request.url).searchParams, now);
    if (!env.DB) throw new Error('Health database is not configured');
    const [[health, settings], [nutrition, weightPlan, actions, activity]] = await Promise.all([
      Promise.all([
        readHealthRange(user.userId, selection.previousStart, selection.cutoffDay),
        readGoalSettings(env.DB, user.userId),
      ]),
      Promise.allSettled([
        readWithDeadline(listNutritionEntries(env.DB, user.userId, { from: selection.previousStart, to: selection.cutoffDay })),
        readWithDeadline(readWeightPlanSettings(env.DB, user.userId)),
        readWithDeadline(readWeeklyActions(env.DB, user.userId, [selection.previousStart, selection.weekStart, shiftWeekDay(selection.weekStart, 7)])),
        readWithDeadline(readAppleActivityDaily(env.DB, user.userId, { from: selection.previousStart, to: selection.cutoffDay })
          .then(data => buildWeeklyAppleActivity(data, selection))),
      ]),
    ]);
    const review = buildHealthWeeklyReview(health.measurements, settings, selection, now, {
      nutrition: nutrition.status === 'fulfilled' ? nutrition.value : [],
      weightPlan: weightPlan.status === 'fulfilled' ? weightPlan.value : null,
      actions: actions.status === 'fulfilled' ? { previous: actions.value[0], current: actions.value[1], next: actions.value[2] } : undefined,
      supplementalStatus: {
        nutrition: nutrition.status === 'fulfilled' ? 'ready' : 'unavailable',
        weightPlan: weightPlan.status === 'fulfilled' ? 'ready' : 'unavailable',
        actions: actions.status === 'fulfilled' ? 'ready' : 'unavailable',
      },
    });
    const appleActivity: WeeklyAppleActivity = activity.status === 'fulfilled' ? activity.value : { status: 'unavailable' };
    return json({ ...review, focus: buildHealthWeeklyFocus(review), appleActivity });
  } catch (error) {
    if (error instanceof HealthWeekValidationError) return json({ error: error.message, code: error.code }, 400);
    return unavailable();
  }
}
