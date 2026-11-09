import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderBalanceCheckPage } from '../../../finance-balance-check-page';
import { CURRENCIES } from '../../../lib/finance';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams;
  const ledger = source.get('ledger') === 'family' ? 'family' : 'personal';
  const requestedCurrency = source.get('currency') ?? 'all';
  const currency = requestedCurrency === 'all' || Object.hasOwn(CURRENCIES, requestedCurrency) ? requestedCurrency : 'all';
  const query = new URLSearchParams({ ledger, currency });
  const user = await requireChatGPTUser('/finance/balances?' + query);
  return new Response(renderBalanceCheckPage(user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
