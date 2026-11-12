import { readSyncStatus } from '../../../../db/health-repository';
import { apiUser, json, unauthenticated, unavailable } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try { return json(await readSyncStatus(user.userId)); }
  catch { return unavailable(); }
}
