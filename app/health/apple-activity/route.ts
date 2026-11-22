import { renderAppleActivityPage } from '../../../apple-activity-page';
import { parseDateRangeQuery } from '../../../lib/date-range';
import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  let returnTo = '/health/apple-activity';
  try {
    const range = parseDateRangeQuery(query, Date.now(), 30);
    if (query.has('from')) returnTo += '?' + new URLSearchParams({ from: range.from, to: range.to });
    else if (query.has('days')) returnTo += '?' + new URLSearchParams({ days: String(range.days) });
  } catch {
    // Invalid deep links fall back to this page after sign-in.
  }
  const user = await requireChatGPTUser(returnTo);
  return new Response(withPageAccount(renderAppleActivityPage(), user.userId, user), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
