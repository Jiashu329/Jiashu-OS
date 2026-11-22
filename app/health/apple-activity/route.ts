import { readAppleActivityRedirect } from '../../../lib/health-navigation';
import { requireChatGPTUser } from '../../chatgpt-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const target = readAppleActivityRedirect(new URL(request.url).search);
  await requireChatGPTUser(target);
  return new Response(null, { status: 307, headers: {
    Location: target,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
