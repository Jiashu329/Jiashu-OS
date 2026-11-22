import { readHealth } from '../../../db/health-repository';
import { financeOverview } from '../../../db/finance-repository';
import { buildHomeOverview } from '../../../lib/home-overview';
import { apiUser, json, storageDiagnostic, unauthenticated } from '../_shared';
import { readWithDeadline } from '../../../lib/read-deadline';
import { env } from 'cloudflare:workers';
import { readNutritionRangeSnapshot } from '../../../db/nutrition-store';
import { readNutritionGoals } from '../../../db/nutrition-goals-store';
import { readHomeActions } from '../../../db/home-actions-store';
import { readAppleActivityDaily } from '../../../db/apple-health-activity-store';
import { buildHomeAppleActivity, homeAppleActivityRange, type HomeAppleActivity } from '../../../lib/apple-activity-supplements';
import { shanghaiDay } from '../../../lib/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated('请先登录网站，再查看个人总览。');
  const now = new Date();
  const today=shanghaiDay(now.toISOString());
  const activityRange = homeAppleActivityRange(today);
  const [health, personal, family, nutrition, actions, activity] = await Promise.allSettled([
    readWithDeadline(readHealth(user.userId, 90)),
    readWithDeadline(financeOverview(user.userId, 'personal')),
    readWithDeadline(financeOverview(user.userId, 'family')),
    readWithDeadline((async()=>{
      if(!env.DB)throw new Error('Nutrition storage unavailable');
      const [snapshot,goals]=await Promise.all([readNutritionRangeSnapshot(env.DB,user.userId,{from:today,to:today}),readNutritionGoals(env.DB,user.userId)]);
      return {...snapshot,goals};
    })()),
    readWithDeadline((async () => {
      if (!env.DB) throw new Error('Action storage unavailable');
      return readHomeActions(env.DB, user.userId);
    })()),
    readWithDeadline((async () => {
      if (!env.DB) throw new Error('Apple Health storage unavailable');
      const data = await readAppleActivityDaily(env.DB, user.userId, activityRange, { from: today, to: today });
      return buildHomeAppleActivity(data, activityRange);
    })()),
  ]);
  const overview = buildHomeOverview({
    health: health.status === 'fulfilled' ? health.value : null,
    personal: personal.status === 'fulfilled' ? personal.value : null,
    family: family.status === 'fulfilled' ? family.value : null,
    nutrition: nutrition.status === 'fulfilled' ? nutrition.value : null,
    actions: actions.status === 'fulfilled' ? actions.value : null,
  }, now);
  const modules = Object.fromEntries(([['health', health], ['personal', personal], ['family', family],['nutrition',nutrition]] as const).map(([module, result]) => [module, {
    status: result.status === 'fulfilled' ? 'ready' : 'unavailable',
    checkedAt: overview.asOf,
    ...(result.status === 'rejected' ? { diagnosticId: storageDiagnostic(('overview-' + module) as 'overview-health' | 'overview-personal' | 'overview-family' | 'overview-nutrition',
      result.reason instanceof Error && result.reason.message === 'READ_DEADLINE_EXCEEDED' ? 'read_timeout' : 'storage_failure') } : {}),
  }]));
  const appleActivity: HomeAppleActivity = activity.status === 'fulfilled' ? activity.value : { status: 'unavailable' };
  return json({ ...overview, modules, appleActivity });
}
