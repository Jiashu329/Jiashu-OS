import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderFinanceGoalsPage } from '../../../finance-goals-page';
import { CURRENCIES } from '../../../lib/finance';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams;
  const ledger = source.get('ledger') === 'family' ? 'family' : 'personal';
  const rawCurrency = source.get('currency') ?? 'all';
  const currency = rawCurrency === 'all' || Object.hasOwn(CURRENCIES, rawCurrency) ? rawCurrency : 'all';
  const query = new URLSearchParams({ ledger, currency });
  if (source.get('includeArchived') === '1') query.set('includeArchived', '1');
  const user = await requireChatGPTUser('/finance/goals?' + query);
  return new Response(withPageAccount(renderFinanceGoalsPage(user.userId), user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
