import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderDoubanPage } from '../../../douban-page';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireChatGPTUser('/life/douban');
  return new Response(withPageAccount(renderDoubanPage(), user.userId, user), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
