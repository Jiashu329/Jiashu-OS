import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderFinanceRunwayPage } from '../../../finance-runway-page';
import { CURRENCIES } from '../../../lib/finance';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams;
  const ledger = source.get('ledger') === 'family' ? 'family' : 'personal';
  const rawCurrency = source.get('currency') ?? 'CNY';
  const currency = Object.hasOwn(CURRENCIES, rawCurrency) ? rawCurrency : 'CNY';
  const query = new URLSearchParams({ ledger, currency });
  const user = await requireChatGPTUser('/finance/runway?' + query);
  return new Response(renderFinanceRunwayPage(user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
