import { readHealth } from '../../../db/health-repository';
import { financeOverview } from '../../../db/finance-repository';
import { buildHomeOverview } from '../../../lib/home-overview';
import { apiUser, json, storageDiagnostic } from '../_shared';
import { readWithDeadline } from '../../../lib/read-deadline';
import { env } from 'cloudflare:workers';
import { readNutritionRangeSnapshot } from '../../../db/nutrition-store';
import { readNutritionGoals } from '../../../db/nutrition-goals-store';
import { shanghaiDay } from '../../../lib/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return json({ error: '请先登录网站，再查看个人总览。', code: 'SIGN_IN_REQUIRED' }, 401);
  const today=shanghaiDay(new Date().toISOString());
  const [health, personal, family, nutrition] = await Promise.allSettled([
    readWithDeadline(readHealth(user.userId, 90)),
    readWithDeadline(financeOverview(user.userId, 'personal')),
    readWithDeadline(financeOverview(user.userId, 'family')),
    readWithDeadline((async()=>{
      if(!env.DB)throw new Error('Nutrition storage unavailable');
      const [snapshot,goals]=await Promise.all([readNutritionRangeSnapshot(env.DB,user.userId,{from:today,to:today}),readNutritionGoals(env.DB,user.userId)]);
      return {...snapshot,goals};
    })()),
  ]);
  const overview = buildHomeOverview({
    health: health.status === 'fulfilled' ? health.value : null,
    personal: personal.status === 'fulfilled' ? personal.value : null,
    family: family.status === 'fulfilled' ? family.value : null,
    nutrition: nutrition.status === 'fulfilled' ? nutrition.value : null,
  });
  const modules = Object.fromEntries(([['health', health], ['personal', personal], ['family', family],['nutrition',nutrition]] as const).map(([module, result]) => [module, {
    status: result.status === 'fulfilled' ? 'ready' : 'unavailable',
    checkedAt: overview.asOf,
    ...(result.status === 'rejected' ? { diagnosticId: storageDiagnostic(('overview-' + module) as 'overview-health' | 'overview-personal' | 'overview-family' | 'overview-nutrition',
      result.reason instanceof Error && result.reason.message === 'READ_DEADLINE_EXCEEDED' ? 'read_timeout' : 'storage_failure') } : {}),
  }]));
  return json({ ...overview, modules });
}
