import { getChatGPTUser } from '../chatgpt-auth';

export const noStoreHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { ...noStoreHeaders, ...extraHeaders } });
}

export async function apiUser() {
  return getChatGPTUser();
}

export function unauthenticated() {
  return json({ error: '请先在此浏览器中登录网站，再重试。', code: 'SIGN_IN_REQUIRED' }, 401);
}

export function unavailable() {
  return json({ error: '健康数据暂时不可用，请稍后重试。', code: 'HEALTH_STORAGE_UNAVAILABLE' }, 503);
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !!origin && origin === new URL(request.url).origin;
}

export function invalidOrigin() {
  return json({ error: '请从已登录的网站页面执行此操作。', code: 'INVALID_ORIGIN' }, 403);
}
