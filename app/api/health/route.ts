import { readHealth } from '../../../db/health-repository';
import { apiUser, json, unauthenticated, unavailable } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const days = Number(new URL(request.url).searchParams.get('days') ?? '90');
  if (![7, 30, 90, 180, 360].includes(days)) return json({ error: '请选择 7、30、90、180 或 360 天范围。' }, 400);
  try { return json(await readHealth(user.userId, days)); }
  catch { return unavailable(); }
}
