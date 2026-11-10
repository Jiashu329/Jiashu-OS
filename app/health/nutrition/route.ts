import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderNutritionPage } from '../../../nutrition-page';
import { normalizeTimestamp, shanghaiDay } from '../../../lib/health';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams;
  const today = shanghaiDay(new Date().toISOString());
  const requested = source.get('date');
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)
    && normalizeTimestamp(requested + 'T12:00:00+08:00') && requested <= today ? requested : today;
  const query = new URLSearchParams({ date });
  if (source.get('includeDeleted') === '1') query.set('includeDeleted', '1');
  const user = await requireChatGPTUser('/health/nutrition?' + query);
  return new Response(renderNutritionPage(user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
