import { withPageAccount } from '../../../lib/page-account';
import { renderMediaSettingsPage } from '../../../media-settings-page';
import { requireChatGPTUser } from '../../chatgpt-auth';
export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await requireChatGPTUser('/settings/media');
  return new Response(withPageAccount(renderMediaSettingsPage(), user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
