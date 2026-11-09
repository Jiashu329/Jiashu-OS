import { apiUser, json, unauthenticated } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  return json({
    version: 1,
    source: 'apple-health-shortcuts',
    timezone: 'Asia/Shanghai',
    exportedAt: new Date().toISOString(),
    measurements: [],
  }, 200, { 'Content-Disposition': 'attachment; filename="jiashu-health-sync-template.json"' });
}
