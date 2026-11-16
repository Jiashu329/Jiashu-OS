import { withPageAccount } from '../../lib/page-account';
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
  for (const key of ['book', 'bookRevision']) for (const value of source.getAll(key)) query.append(key, value);
  const user = await requireChatGPTUser('/finance?' + query);
  return new Response(withPageAccount(renderFinanceApp(user.userId), user.userId, user), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
