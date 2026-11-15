import { getChatGPTAccess, getChatGPTUser } from '../chatgpt-auth';

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

export async function unauthenticated(signInMessage = '请先在此浏览器中登录网站，再重试。') {
  // A handler can lose access storage after middleware has already authorized
  // this request. Recheck only this rejected path, without cross-request state.
  const access = await getChatGPTAccess();
  if (!access.identity) return json({ error: signInMessage, code: 'SIGN_IN_REQUIRED' }, 401);
  if (!access.allowed && access.reason !== 'unavailable') {
    return json({ error: '当前账号尚未获得使用权限，或权限已停用。请联系网站管理员。', code: 'ACCOUNT_NOT_ALLOWED' }, 403);
  }
  // Even if storage recovered during the recheck, the original handler has no
  // authorized actor and must not execute its business operation in this turn.
  return json({ error: '暂时无法核对网站使用权限，请保留当前页面并稍后重试。', code: 'ACCOUNT_ACCESS_UNAVAILABLE' }, 503, { 'Retry-After': '3' });
}

export function storageDiagnostic(module: 'health' | 'overview-health' | 'overview-personal' | 'overview-family' | 'overview-nutrition' | 'data-backup', reason: 'read_timeout' | 'storage_failure' = 'storage_failure') {
  const diagnosticId = crypto.randomUUID().replaceAll('-', '');
  // Deliberately omit exception text, user IDs, records and request bodies.
  console.error(JSON.stringify({ event: 'storage_unavailable', module, reason, diagnosticId }));
  return diagnosticId;
}

export function unavailable(reason: 'read_timeout' | 'storage_failure' = 'storage_failure') {
  const diagnosticId = storageDiagnostic('health', reason);
  return json({ error: '健康数据暂时不可用，请稍后重试。', code: 'HEALTH_STORAGE_UNAVAILABLE', diagnosticId }, 503, { 'X-Diagnostic-ID': diagnosticId });
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !!origin && origin === new URL(request.url).origin;
}

export function invalidOrigin() {
  return json({ error: '请从已登录的网站页面执行此操作。', code: 'INVALID_ORIGIN' }, 403);
}
