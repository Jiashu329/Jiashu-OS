import { withPageAccount } from '../lib/page-account';
import { requireChatGPTUser } from './chatgpt-auth';
import { renderHomeApp } from '../home-ui';

export const dynamic = 'force-dynamic';

export async function GET() {
  const pageUser = await requireChatGPTUser('/');
  return new Response(withPageAccount(renderHomeApp(), pageUser.userId, pageUser), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
