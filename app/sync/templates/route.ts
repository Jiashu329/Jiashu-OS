import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderShortcutTemplatesPage } from '../../../shortcut-templates-page';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const pageUser = await requireChatGPTUser('/sync/templates');
  const templateId = new URL(request.url).searchParams.get('template');
  return new Response(withPageAccount(renderShortcutTemplatesPage(templateId), pageUser.userId, pageUser), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
