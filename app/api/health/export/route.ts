import { exportHealth } from '../../../../db/health-repository';
import { apiUser, json, unauthenticated, unavailable } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    return json(await exportHealth(user.userId), 200, {
      'Content-Disposition': 'attachment; filename="jiashu-health-last-90-days.json"',
      'X-Export-Range-Days': '90',
    });
  } catch { return unavailable(); }
}
