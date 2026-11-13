import { withPageAccount } from '../../../lib/page-account';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderFoodLibraryPage } from '../../../food-library-page';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  const text = source.get('q')?.trim().slice(0, 100);
  const category = source.get('category')?.slice(0, 100);
  const offset = source.get('offset');
  if (text) query.set('q', text);
  if (category) query.set('category', category);
  if (offset && /^(?:0|[1-9]\d*)$/.test(offset) && Number.isSafeInteger(Number(offset))) query.set('offset', String(Math.floor(Number(offset) / 24) * 24));
  const user = await requireChatGPTUser('/health/foods' + (query.size ? '?' + query : ''));
  return new Response(withPageAccount(renderFoodLibraryPage(), user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
