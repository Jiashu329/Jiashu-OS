import { env } from 'cloudflare:workers';
import { readGoalSettings } from '../../../../db/health-goals-store';
import { readHealthRange } from '../../../../db/health-repository';
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
    const [health, settings] = await Promise.all([
      readHealthRange(user.userId, selection.previousStart, selection.cutoffDay),
      readGoalSettings(env.DB, user.userId),
    ]);
    return json(buildHealthWeeklyReview(health.measurements, settings, selection, now));
  } catch (error) {
    if (error instanceof HealthWeekValidationError) return json({ error: error.message, code: error.code }, 400);
    return unavailable();
  }
}
