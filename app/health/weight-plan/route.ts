import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderWeightPlanPage } from '../../../weight-plan-page';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get('days');
  const days = requested && ['30', '90', '360'].includes(requested) ? requested : '90';
  const pageUser = await requireChatGPTUser('/health/weight-plan?days=' + days);
  return new Response(withPageAccount(renderWeightPlanPage(), pageUser.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
