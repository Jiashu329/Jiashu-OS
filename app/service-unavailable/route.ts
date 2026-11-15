import { safeAccountRetryPath } from '../../lib/account-retry';
import { APP_BRAND_HEAD } from '../../lib/branding';
import { APP_THEME_CSS } from '../../lib/app-theme';

export const dynamic = 'force-dynamic';

/** Public failure page: never authorize again or read any account/business data. */
export async function GET(request: Request) {
  const retry = safeAccountRetryPath(new URL(request.url).searchParams.get('returnTo'));
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${APP_BRAND_HEAD}<title>暂时无法核对权限 · Jiashu OS</title><style>${APP_THEME_CSS}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.8 system-ui,sans-serif}main{max-width:520px;margin:12vh auto;padding:28px;border:1px solid var(--line);border-radius:12px;background:var(--paper)}h1{font-size:24px;line-height:1.5;margin:0 0 16px}p{overflow-wrap:anywhere;color:var(--muted)}a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:12px;padding:9px 18px;border-radius:8px;background:var(--primary);color:var(--paper);text-decoration:none}a:focus-visible{outline:2px solid var(--primary);outline-offset:4px}@media(max-width:600px){main{margin:48px 16px;padding:24px}}</style></head><body><main><h1>暂时无法核对使用权限</h1><p>权限服务暂时不可用，请稍后重试。无需退出账号。</p><a href="${escape(retry)}">重试原页面</a></main></body></html>`, { status: 503, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Retry-After': '3',
  } });
}
