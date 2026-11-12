import { requireChatGPTUser } from '../chatgpt-auth';
import { renderFinanceApp } from '../../finance-ui';
import { CURRENCIES } from '../../lib/finance';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams;
  const ledger = source.get('ledger') === 'family' ? 'family' : 'personal';
  const query = new URLSearchParams({ ledger });
  const currency = source.get('currency');
  if (currency && Object.hasOwn(CURRENCIES, currency)) query.set('currency', currency);
  const user = await requireChatGPTUser('/finance?' + query);
  return new Response(renderFinanceApp(user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
