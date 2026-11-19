import { withPageAccount } from '../../../../lib/page-account';
import { renderRecipesPage } from '../../../../recipes-page';
import { requireChatGPTUser } from '../../../chatgpt-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireChatGPTUser('/health/nutrition/recipes');
  return new Response(withPageAccount(renderRecipesPage(), user.userId, user), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
