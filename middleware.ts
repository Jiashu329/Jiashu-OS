import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { accountAccess } from './app/account-access';
import { pageAccountFailure } from './lib/account-identity';

/** Apply to every API route, including future routes, before a handler can read or write. */
export async function middleware(request: NextRequest) {
  const access = await accountAccess(request.headers);
  if (!access.identity) return NextResponse.json({ error: '请先登录网站。', code: 'SIGN_IN_REQUIRED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  if (!access.allowed) return access.reason === 'unavailable'
    ? NextResponse.json({ error: '暂时无法核对网站使用权限，请保留当前页面并稍后重试。', code: 'ACCOUNT_ACCESS_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } })
    : NextResponse.json({ error: '当前账号尚未获得使用权限，或权限已停用。请联系网站管理员。', code: 'ACCOUNT_NOT_ALLOWED' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  const failure = pageAccountFailure(request, access.identity.userId);
  const sessionRead = new URL(request.url).pathname === '/api/session' && ['GET', 'HEAD'].includes(request.method);
  if (failure && !sessionRead) return NextResponse.json(failure, { status: 401, headers: { 'Cache-Control': 'no-store', 'X-Account-Owner': access.identity.userId } });
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Account-Owner', access.identity.userId);
  return response;
}

export const config = { matcher: '/api/:path*' };
