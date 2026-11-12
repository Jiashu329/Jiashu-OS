export interface SiteIdentity { userId: string; displayName: string; email: string; fullName: string | null }

/** Sites dispatch owns and replaces these identity headers; client input is not an identity provider. */
export function identityFromHeaders(requestHeaders: Pick<Headers, 'get'>): SiteIdentity | null {
  const userId = requestHeaders.get('oai-authenticated-user-id');
  const email = requestHeaders.get('oai-authenticated-user-email');
  if (!userId || !email || userId.length > 200 || Array.from(userId).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  const encoded = requestHeaders.get('oai-authenticated-user-full-name');
  let fullName: string | null = null;
  if (encoded && requestHeaders.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try { fullName = decodeURIComponent(encoded); } catch { /* Invalid display metadata never becomes identity. */ }
  }
  return { userId, email, fullName, displayName: fullName ?? email };
}

export function pageAccountFailure(request: Request, userId: string): { error: string; code: 'ACCOUNT_CHANGED' } | null {
  const expected = request.headers.get('X-Page-Owner');
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if ((expected && expected !== userId) || (mutation && !expected)) return {
    code: 'ACCOUNT_CHANGED', error: '登录账号已变化或页面身份尚未核对。请刷新后继续；原账号的草稿和待确认操作会保留。',
  };
  return null;
}
