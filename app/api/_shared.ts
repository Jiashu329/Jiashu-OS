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
