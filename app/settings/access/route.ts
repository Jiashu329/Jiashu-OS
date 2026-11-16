import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderAccessSettingsPage } from '../../../access-settings-page';
import { withPageAccount } from '../../../lib/page-account';

export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await requireChatGPTUser('/settings/access');
  if (!user.isOwner) return new Response('只有创建者可以管理成员名单。', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  return new Response(withPageAccount(renderAccessSettingsPage(user.userId), user.userId, user), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
