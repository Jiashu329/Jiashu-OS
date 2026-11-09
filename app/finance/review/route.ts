import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderFinanceReviewPage } from '../../../finance-review-page';
import { CURRENCIES, todayShanghai } from '../../../lib/finance';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams;
  const ledger = source.get('ledger') === 'family' ? 'family' : 'personal';
  const requestedCurrency = source.get('currency') ?? 'CNY';
  const currency = Object.hasOwn(CURRENCIES, requestedCurrency) ? requestedCurrency : 'CNY';
  const query = new URLSearchParams({ ledger, currency });
  const month = source.get('month');
  if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= '1970-01' && month <= todayShanghai().slice(0, 7)) query.set('month', month);
  await requireChatGPTUser('/finance/review?' + query);
  return new Response(renderFinanceReviewPage(), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
