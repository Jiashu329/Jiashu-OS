import { apiUser, json, unauthenticated } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  return json({ mode: 'browser-handoff', endpoint: new URL('/sync', request.url).href, authorizationReady: true });
}
