import { requireChatGPTUser } from '../chatgpt-auth';
import { renderBackupPage } from '../../backup-page';

export const dynamic = 'force-dynamic';
export async function GET() {
  await requireChatGPTUser('/backup');
  return new Response(renderBackupPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
