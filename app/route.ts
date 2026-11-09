import { requireChatGPTUser } from './chatgpt-auth';
import { renderHomeApp } from '../home-ui';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requireChatGPTUser('/');
  return new Response(renderHomeApp(), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
