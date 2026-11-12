import { requireChatGPTUser } from '../chatgpt-auth';

export const dynamic = 'force-dynamic';
export async function GET() {
  await requireChatGPTUser('/data');
  return new Response(null, { status: 307, headers: { Location: '/data', 'Cache-Control': 'no-store' } });
}
