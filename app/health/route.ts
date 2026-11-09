import { requireChatGPTUser } from '../chatgpt-auth';
import { renderApp } from '../../ui';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const metric = new URL(request.url).searchParams.get('metric');
  const returnTo = metric && ['steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass', 'body_fat'].includes(metric)
    ? '/health?metric=' + metric : '/health';
  await requireChatGPTUser(returnTo);
  return new Response(renderApp(), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
