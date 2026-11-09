import { readHealth } from '../../../db/health-repository';
import { financeOverview } from '../../../db/finance-repository';
import { buildHomeOverview } from '../../../lib/home-overview';
import { apiUser, json } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return json({ error: '请先登录网站，再查看个人总览。', code: 'SIGN_IN_REQUIRED' }, 401);
  const [health, personal, family] = await Promise.allSettled([
    readHealth(user.userId, 90),
    financeOverview(user.userId, 'personal'),
    financeOverview(user.userId, 'family'),
  ]);
  return json(buildHomeOverview({
    health: health.status === 'fulfilled' ? health.value : null,
    personal: personal.status === 'fulfilled' ? personal.value : null,
    family: family.status === 'fulfilled' ? family.value : null,
  }));
}
