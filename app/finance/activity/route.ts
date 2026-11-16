import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderFinanceActivityPage } from '../../../finance-activity-page';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const source = new URL(request.url).searchParams, query = new URLSearchParams({ledger:'family'});
  for (const key of ['book','bookRevision','offset']) for (const value of source.getAll(key)) query.append(key,value);
  const destination='/finance/activity?'+query;
  if (source.get('ledger')!=='family') return Response.redirect(new URL(destination,request.url),302);
  const user=await requireChatGPTUser(destination);
  return new Response(withPageAccount(renderFinanceActivityPage(user.userId), user.userId, user),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
}
