import { requireChatGPTUser } from '../../chatgpt-auth';
import { renderHealthRecordsPage } from '../../../health-records-page';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ['from', 'to']) {
    const value = source.get(key);
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) query.set(key, value);
  }
  const metric = source.get('metric');
  if (metric && ['steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass'].includes(metric)) query.set('metric', metric);
  if (source.get('includeDeleted') === '1') query.set('includeDeleted', '1');
  if (source.get('compose') === '1') query.set('compose', '1');
  const suffix = query.size ? '?' + query : '';
  const user = await requireChatGPTUser('/health/records' + suffix);
  return new Response(renderHealthRecordsPage(user.userId), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
