import { requireChatGPTUser } from '../chatgpt-auth';
import { withPageAccount } from '../../lib/page-account';
import { renderNotificationsPage } from '../../notifications-page';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const source = new URL(request.url).searchParams, query = new URLSearchParams();
  if (source.get('unread') === '1') query.set('unread', '1');
  const offset = source.get('offset'); if (offset && /^(?:0|[1-9]\d*)$/.test(offset) && Number(offset) <= 1000) query.set('offset', String(Math.floor(Number(offset) / 20) * 20));
  const user = await requireChatGPTUser('/notifications' + (query.size ? '?' + query : ''));
  return new Response(withPageAccount(renderNotificationsPage(), user.userId), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
