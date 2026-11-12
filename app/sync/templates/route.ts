import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderShortcutTemplatesPage } from '../../../shortcut-templates-page';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  await requireChatGPTUser('/sync/templates');
  const templateId = new URL(request.url).searchParams.get('template');
  return new Response(renderShortcutTemplatesPage(templateId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
