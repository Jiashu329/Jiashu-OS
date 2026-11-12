import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderAISettingsPage } from '../../../ai-settings-page';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requireChatGPTUser('/settings/ai');
  return new Response(renderAISettingsPage(), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
