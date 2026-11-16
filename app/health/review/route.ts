import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderHealthWeeklyPage } from '../../../health-weekly-page';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const week = new URL(request.url).searchParams.get('week');
  const query = new URLSearchParams();
  if (week && /^\d{4}-\d{2}-\d{2}$/.test(week)) query.set('week', week);
  const pageUser = await requireChatGPTUser('/health/review' + (query.size ? '?' + query : ''));
  return new Response(withPageAccount(renderHealthWeeklyPage(), pageUser.userId, pageUser), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
