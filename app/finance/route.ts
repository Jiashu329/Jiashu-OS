import { requireChatGPTUser } from '../chatgpt-auth';
import { renderFinanceApp } from '../../finance-ui';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ledger = new URL(request.url).searchParams.get('ledger') === 'family' ? 'family' : 'personal';
  await requireChatGPTUser('/finance?ledger=' + ledger);
  return new Response(renderFinanceApp(), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
