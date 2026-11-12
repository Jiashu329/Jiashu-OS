import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderHealthAssistantPage } from '../../../health-assistant-page';

export const dynamic = 'force-dynamic';

export async function GET() {
  const pageUser = await requireChatGPTUser('/health/assistant');
  return new Response(withPageAccount(renderHealthAssistantPage(), pageUser.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
