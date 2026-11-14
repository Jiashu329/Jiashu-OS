import { requireChatGPTUser } from '../../../chatgpt-auth';
import { withPageAccount } from '../../../../lib/page-account';
import { renderManagedFoodPage } from '../../../../managed-food-page';

export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await requireChatGPTUser('/health/foods/manage');
  if (user.isOwner !== true) return new Response('只有管理员可以维护公共食物库。', { status:403, headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'} });
  return new Response(withPageAccount(renderManagedFoodPage(),user.userId),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
}
