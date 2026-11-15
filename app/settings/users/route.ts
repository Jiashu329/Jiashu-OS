import { env } from 'cloudflare:workers';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { withPageAccount } from '../../../lib/page-account';
import { renderUsersSettingsPage } from '../../../users-settings-page';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (env.SELFHOST_AUTH_PROVIDER !== 'local') return new Response('页面不存在。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const user = await requireChatGPTUser('/settings/users');
  if (!user.isOwner) return new Response('只有管理员可以管理用户。', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  return new Response(withPageAccount(renderUsersSettingsPage(user.userId), user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
  } });
}
