import { withPageAccount } from '../../../lib/page-account';
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
  if (source.get('compose') === '1') query.set('compose', '1');
  const food = source.get('food');
  if (source.getAll('food').length === 1 && food && food.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(food)) query.set('food', food);
  const template = source.get('template'), templateRevision = source.get('templateRevision');
  if (source.getAll('template').length === 1 && source.getAll('templateRevision').length === 1
    && template && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(template)
    && templateRevision && /^[1-9]\d*$/.test(templateRevision) && Number.isSafeInteger(Number(templateRevision))) {
    query.set('template', template.toLowerCase()); query.set('templateRevision', templateRevision);
  }
  const configurationKeys = ['cup', 'temperature', 'sweetness'];
  if (query.has('food') && (source.get('configurationInvalid') === '1' || configurationKeys.some((key) => source.has(key)))) {
    if (source.get('configurationInvalid') !== '1' && configurationKeys.every((key) => source.getAll(key).length === 1
      && (source.get(key)?.length ?? 0) <= 40 && !/[\u0000-\u001f\u007f]/.test(source.get(key)!))) {
      for (const key of configurationKeys) query.set(key, source.get(key)!);
    } else query.set('configurationInvalid', '1');
  }
  const user = await requireChatGPTUser('/health/nutrition?' + query);
  return new Response(withPageAccount(renderNutritionPage(user.userId), user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
