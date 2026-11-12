import { requireChatGPTUser } from '../chatgpt-auth';
import { renderApp } from '../../ui';
import { readHealthView, healthViewPath } from '../../lib/health-navigation';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url=new URL(request.url),view=readHealthView(url.search);
  const returnTo=url.search?healthViewPath(view.metric,view.days,false,view):'/health';
  await requireChatGPTUser(returnTo);
  return new Response(renderApp(), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
