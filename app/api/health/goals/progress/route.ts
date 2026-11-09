import { env } from 'cloudflare:workers';
import { readGoalSettings } from '../../../../../db/health-goals-store';
import { readHealth } from '../../../../../db/health-repository';
import { buildGoalProgress } from '../../../../../lib/health-goals';
import { apiUser, json, unauthenticated, unavailable } from '../../../_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    if (!env.DB) throw new Error('Health database is not configured');
    const [settings, health] = await Promise.all([readGoalSettings(env.DB, user.userId), readHealth(user.userId, 30)]);
    return json(buildGoalProgress(settings, health.summary));
  } catch { return unavailable(); }
}
