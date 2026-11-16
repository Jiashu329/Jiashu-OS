/* oxlint-disable no-control-regex -- Authentication boundaries intentionally reject control bytes in credentials, identity fields and request paths. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeLocalEmail } from '../lib/local-users.ts';
import type { LocalUser } from '../lib/local-users.ts';
import { isValidPasswordHash, verifyPassword } from './password-hash.ts';
import { renderSelfhostLoginPage } from './login-page.ts';
export { hashPassword, verifyPassword } from './password-hash.ts';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';

const FORM_LIMIT = 16384;
const SESSION_TTL = 30 * 24 * 60 * 60;
const SESSION_RENEW_INTERVAL = 24 * 60 * 60;
export interface SelfhostAuthConfig {
  origin: string; host: string; secure: boolean; passwordHash: string;
  sessionSecret: string; ownerId: string; ownerEmail: string; sessionTtl: number;
}
export class SelfhostAuthConfigurationError extends Error {
  constructor() { super('Self-hosted authentication configuration is incomplete or invalid.'); this.name = 'SelfhostAuthConfigurationError'; }
}
const bytesEqual = (left: Buffer, right: Buffer) => left.length === right.length && timingSafeEqual(left, right);
function decode(value: string, length?: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const result = Buffer.from(value, 'base64url');
  return result.toString('base64url') === value && (length === undefined || result.length === length) ? result : null;
}
function simple(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
export function loadSelfhostAuthConfig(source: Record<string, string | undefined> = process.env): SelfhostAuthConfig {
  try {
    const origin = new URL(source.SELFHOST_PUBLIC_ORIGIN ?? '');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    const httpTest = origin.protocol === 'http:' && loopback && source.SELFHOST_ALLOW_HTTP === '1' && source.CI === 'true';
    if (origin.protocol !== 'https:' && !httpTest || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    const passwordHash = source.SELFHOST_PASSWORD_HASH, sessionSecret = source.SELFHOST_SESSION_SECRET;
    const ownerId = source.APP_OWNER_USER_ID, ownerEmail = normalizeLocalEmail(source.APP_OWNER_EMAIL);
    const sessionTtl = source.SELFHOST_SESSION_TTL_SECONDS === undefined ? SESSION_TTL : Number(source.SELFHOST_SESSION_TTL_SECONDS);
    if (!isValidPasswordHash(passwordHash)
      || typeof sessionSecret !== 'string' || !decode(sessionSecret, 32) || !simple(ownerId, 200) || !simple(ownerEmail, 254)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || !Number.isInteger(sessionTtl) || sessionTtl < 300 || sessionTtl > SESSION_TTL) throw new Error();
    return Object.freeze({ origin: origin.origin, host: origin.host, secure: origin.protocol === 'https:', passwordHash: passwordHash!, sessionSecret, ownerId, ownerEmail, sessionTtl });
  } catch { throw new SelfhostAuthConfigurationError(); }
}
export function safeSelfhostReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 2000 || /[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  let url: URL;
  try { url = new URL(value, 'https://selfhost.invalid'); } catch { return '/'; }
  if (url.origin !== 'https://selfhost.invalid' || /%(?:2f|5c)/i.test(url.pathname)) return '/';
  const exact = ['/', '/account', '/notifications', '/data', '/backup', '/connect-steps', '/connect-sleep', '/connect-weight', '/sync-guide'];
  const groups = ['/health', '/life', '/finance', '/settings', '/sync'];
  const result = url.pathname + url.search + url.hash;
  return result.length <= 2000 && (exact.includes(url.pathname) || groups.some(path => url.pathname === path || url.pathname.startsWith(path + '/'))) ? result : '/';
}
type TokenPurpose = 'session' | 'form' | 'admin';
export interface SelfhostSubject { id: string; revision: number }
export interface SelfhostSession { sub: string; revision: number }
interface VerifiedToken extends SelfhostSession { issuedAt: number; expiresAt: number; nonce: string }
function key(config: SelfhostAuthConfig, purpose: TokenPurpose): Buffer {
  return createHmac('sha256', Buffer.from(config.sessionSecret, 'base64url'))
    .update(JSON.stringify(['jiashu-selfhost-v2', purpose, config.origin])).digest();
}
function sign(config: SelfhostAuthConfig, purpose: TokenPurpose, encoded: string): string {
  return createHmac('sha256', key(config, purpose)).update(encoded).digest('base64url');
}
function token(config: SelfhostAuthConfig, purpose: TokenPurpose, subject: SelfhostSubject | null, ttl: number, now: number, nonce = randomBytes(24).toString('base64url')): string {
  const iat = Math.floor(now / 1000), payload = { v: 2, sub: subject?.id ?? '', rev: subject?.revision ?? 0, iat, exp: iat + ttl, nonce };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + sign(config, purpose, encoded);
}
function validToken(config: SelfhostAuthConfig, purpose: TokenPurpose, value: unknown, now: number): VerifiedToken | null {
  if (typeof value !== 'string' || value.length > 1500 || !Number.isFinite(now)) return null;
  const fields = value.split('.'); if (fields.length !== 2) return null;
  const content = decode(fields[0]), signature = decode(fields[1], 32);
  if (!content || !signature || !bytesEqual(signature, Buffer.from(sign(config, purpose, fields[0]), 'base64url'))) return null;
  try {
    const payload = JSON.parse(content.toString('utf8')), at = Math.floor(now / 1000), ttl = purpose === 'session' ? config.sessionTtl : 600;
    if (!payload || Object.keys(payload).sort().join(',') !== 'exp,iat,nonce,rev,sub,v' || payload.v !== 2
      || typeof payload.sub !== 'string' || payload.sub.length > 200 || /[\u0000-\u001f\u007f]/.test(payload.sub)
      || !Number.isSafeInteger(payload.rev) || payload.rev < 0 || (purpose === 'session' && (!payload.sub || payload.rev < 1))
      || typeof payload.nonce !== 'string' || decode(payload.nonce, 24) === null || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat < 0 || payload.iat > at + 30 || payload.exp <= at || payload.exp <= payload.iat || payload.exp - payload.iat > ttl) return null;
    return { sub: payload.sub, revision: payload.rev, issuedAt: payload.iat, expiresAt: payload.exp, nonce: payload.nonce };
  } catch { return null; }
}
export const issueSelfhostSession = (config: SelfhostAuthConfig, subject: SelfhostSubject, now = Date.now()) => token(config, 'session', subject, config.sessionTtl, now);
export function verifySelfhostSession(config: SelfhostAuthConfig, value: unknown, now = Date.now()): SelfhostSession | null {
  const claims = validToken(config, 'session', value, now);
  return claims ? { sub: claims.sub, revision: claims.revision } : null;
}
export const issueSelfhostCsrf = (config: SelfhostAuthConfig, subject: SelfhostSubject | null, purpose: 'form' | 'admin', now = Date.now()) => token(config, purpose, subject, 600, now);
export function verifySelfhostCsrf(config: SelfhostAuthConfig, value: unknown, stored: unknown, subject: SelfhostSubject | null, purpose: 'form' | 'admin', now = Date.now()): boolean {
  if (typeof value !== 'string' || typeof stored !== 'string' || !bytesEqual(Buffer.from(value), Buffer.from(stored))) return false;
  const claims = validToken(config, purpose, value, now);
  return claims !== null && claims.sub === (subject?.id ?? '') && claims.revision === (subject?.revision ?? 0);
}
export function selfhostCookieNames(config: SelfhostAuthConfig) {
  return { session: config.secure ? '__Host-jso-session' : 'jso-test-session', csrf: config.secure ? '__Host-jso-csrf' : 'jso-test-csrf', adminCsrf: config.secure ? '__Host-jso-admin-csrf' : 'jso-test-admin-csrf' };
}
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header || header.length > 16384) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
export function selfhostCookie(config: SelfhostAuthConfig, name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
}
type ResponseHeaders = OutgoingHttpHeaders | OutgoingHttpHeader[];
const cookiesFrom = (value: OutgoingHttpHeader | undefined): string[] => value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
const cookieName = (value: string) => { const separator = value.indexOf('='); return (separator < 0 ? value : value.slice(0, separator)).trim(); };
/** Merge only when headers are actually committed, preserving application cookies
 * and giving an explicit session replacement/clear priority over background renewal. */
function renewSessionOnResponse(res: ServerResponse, config: SelfhostAuthConfig, user: LocalUser, claims: VerifiedToken, now: number, mayRenew: () => boolean): void {
  const original = res.writeHead.bind(res), name = selfhostCookieNames(config).session;
  // A family nonce stays stable across renewal, so a logout revokes even tokens
  // from an older request that finishes after its clear-cookie response.
  const renewal = selfhostCookie(config, name, token(config, 'session', user, config.sessionTtl, now, claims.nonce), config.sessionTtl);
  res.writeHead = ((status: number, messageOrHeaders?: string | ResponseHeaders, optionalHeaders?: ResponseHeaders) => {
    const message = typeof messageOrHeaders === 'string' ? messageOrHeaders : undefined;
    const headers = typeof messageOrHeaders === 'string' ? optionalHeaders : messageOrHeaders ?? optionalHeaders;
    if (!mayRenew()) return message === undefined ? original(status, headers) : original(status, message, headers);
    let cacheControl = String(res.getHeader?.('cache-control') ?? '');
    if (Array.isArray(headers)) {
      for (let index = 0; index < headers.length; index += 2) if (String(headers[index]).toLowerCase() === 'cache-control') cacheControl = cookiesFrom(headers[index + 1]).join(',');
    } else if (headers) {
      for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === 'cache-control') cacheControl = cookiesFrom(value).join(',');
    }
    // Static/shared-cache responses must never acquire a visitor's session.
    if (status < 200 || status >= 400 || status === 304 || /\b(?:public|immutable|max-age|s-maxage)\b/i.test(cacheControl)) return message === undefined ? original(status, headers) : original(status, message, headers);
    const explicit: string[] = [];
    if (Array.isArray(headers)) {
      for (let index = 0; index < headers.length; index += 2) if (String(headers[index]).toLowerCase() === 'set-cookie') explicit.push(...cookiesFrom(headers[index + 1]));
    } else if (headers) {
      for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === 'set-cookie') explicit.push(...cookiesFrom(value));
    }
    const replaced = new Set(explicit.map(cookieName));
    const existing = cookiesFrom(res.getHeader?.('set-cookie')).filter(cookie => !replaced.has(cookieName(cookie)));
    const merged = [...existing, ...explicit];
    const renewing = !merged.some(cookie => cookieName(cookie) === name);
    if (renewing) merged.push(renewal);
    let combined: ResponseHeaders;
    if (Array.isArray(headers)) {
      combined = [];
      for (let index = 0; index < headers.length; index += 2) if (String(headers[index]).toLowerCase() !== 'set-cookie' && !(renewing && String(headers[index]).toLowerCase() === 'cache-control')) combined.push(headers[index], headers[index + 1]);
      for (const cookie of merged) combined.push('Set-Cookie', cookie);
      if (renewing) combined.push('Cache-Control', 'private, no-store');
    } else {
      combined = { ...headers };
      for (const key of Object.keys(combined)) if (key.toLowerCase() === 'set-cookie') delete combined[key];
      combined['Set-Cookie'] = merged;
      if (renewing) {
        for (const key of Object.keys(combined)) if (key.toLowerCase() === 'cache-control') delete combined[key];
        combined['Cache-Control'] = 'private, no-store';
      }
    }
    return message === undefined ? original(status, combined) : original(status, message, combined);
  }) as ServerResponse['writeHead'];
}
function renewalDue(config: SelfhostAuthConfig, claims: VerifiedToken, now: number): boolean {
  // Existing valid 12-hour v2 sessions transparently adopt the new lifetime.
  return claims.expiresAt - claims.issuedAt < config.sessionTtl
    || Math.floor(now / 1000) - claims.issuedAt >= Math.min(SESSION_RENEW_INTERVAL, config.sessionTtl / 2);
}
function sessionFamily(claims: VerifiedToken): string {
  return createHash('sha256').update(JSON.stringify([claims.sub, claims.nonce])).digest('hex');
}
function renewableRead(path: string, method: string | undefined): boolean {
  return ['GET', 'HEAD'].includes(method ?? 'GET') && !['/signin-with-chatgpt', '/signout-with-chatgpt', '/_selfhost/healthz'].includes(path)
    && !path.startsWith('/_next/') && !path.startsWith('/downloads/') && !/\.(?:css|js|mjs|map|json|webmanifest|txt|xml|pdf|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|zip|mp4|webm|mp3|ogg)$/i.test(path);
}
export function sanitizedSelfhostHeaders(headers: IncomingHttpHeaders, config: SelfhostAuthConfig, user: Pick<LocalUser, 'id' | 'email'> | null): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('oai-') || lower.startsWith('x-auth') || lower.startsWith('x-forwarded-') || lower.startsWith('x-middleware-') || lower.startsWith('x-vinext-')
      || ['forwarded', 'host', 'x-real-ip', 'proxy-authorization', 'proxy-authenticate'].includes(lower)) continue;
    result[lower] = value;
  }
  result.host = config.host; result['x-forwarded-host'] = config.host; result['x-forwarded-proto'] = config.secure ? 'https' : 'http';
  if (user) {
    result['oai-authenticated-user-id'] = user.id;
    result['oai-authenticated-user-email'] = user.email;
    result['oai-authenticated-user-full-name'] = encodeURIComponent(user.email);
    result['oai-authenticated-user-full-name-encoding'] = 'percent-encoded-utf-8';
  }
  return result;
}
export class SelfhostLoginLimiter {
  private entries = new Map<string, { count: number; expires: number }>();
  private total = { count: 0, expires: 0 };
  consume(peer: string, now: number): boolean {
    if (this.total.expires <= now) this.total = { count: 0, expires: now + 15 * 60 * 1000 };
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
    if (this.entries.size >= 1024 && !this.entries.has(peer)) return false;
    const entry = this.entries.get(peer) ?? { count: 0, expires: now + 15 * 60 * 1000 };
    if (entry.count >= 10 || this.total.count >= 30) return false;
    entry.count++; this.total.count++; this.entries.set(peer, entry); return true;
  }
  successful(peer: string, attemptedAt?: number) {
    this.entries.delete(peer);
    if (attemptedAt === undefined || attemptedAt >= this.total.expires - 15 * 60 * 1000 && attemptedAt < this.total.expires) this.total.count = Math.max(0, this.total.count - 1);
  }
}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function page(config: SelfhostAuthConfig, action: 'login' | 'logout', csrf: string, returnTo: string, error = ''): string {
  const login = action === 'login', endpoint = login ? '/signin-with-chatgpt' : '/signout-with-chatgpt';
  if (login) return renderSelfhostLoginPage({ csrf, returnTo, error });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${login ? '登录' : '退出'} · Jiashu OS</title><style>body{margin:0;background:#f3f5f8;color:#1d2738;font:15px/1.7 system-ui,sans-serif}main{max-width:420px;margin:10vh auto;padding:28px;background:white;border:1px solid #dfe5ee;border-radius:14px}h1{font-size:25px;margin:0 0 8px}p{color:#627089}label{display:grid;gap:5px;margin-top:16px}input,button{font:inherit;min-height:44px;border:1px solid #dfe5ee;border-radius:8px;padding:8px 12px;box-sizing:border-box;width:100%}button{margin-top:22px;background:#4267a8;color:white;cursor:pointer}a{color:#4267a8}input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #4267a8;outline-offset:3px}.error{color:#aa263d}@media(max-width:500px){main{margin:40px 16px;padding:22px}}</style></head><body><main><h1>${login ? '登录测试站' : '退出当前登录'}</h1><p>${login ? '使用管理员为你开通的邮箱和密码。' : '退出后，需要重新输入账号和密码。'}</p>${error ? '<p class="error" role="alert">' + escape(error) + '</p>' : ''}<form action="${endpoint}" method="post"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="return_to" value="${escape(returnTo)}">${login ? '<label>邮箱<input type="email" name="email" autocomplete="username" maxlength="254" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label>' : ''}<button type="submit">${login ? '登录' : '确认退出'}</button></form><p><a href="${login ? '/' : escape(returnTo)}">${login ? '返回首页' : '继续使用'}</a></p></main></body></html>`;
}
function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
}
function respond(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { ...authHeaders(), ...headers }); res.end(body);
}
async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded' || Number(req.headers['content-length'] ?? 0) > FORM_LIMIT) throw new Error('invalid_form');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let count = 0;
    const cleanup = () => { clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end); req.removeListener('aborted', failed); req.removeListener('error', failed); };
    const failed = () => { cleanup(); reject(new Error('invalid_form')); };
    const data = (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); count += value.length; if (count > FORM_LIMIT) failed(); else chunks.push(value); };
    const end = () => { cleanup(); try { resolve(new URLSearchParams(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)))); } catch { reject(new Error('invalid_form')); } };
    const timer = setTimeout(failed, 10000); req.on('data', data); req.on('end', end); req.on('aborted', failed); req.on('error', failed);
  });
}
export interface SelfhostGatewayOptions {
  now?: () => number;
  readiness: () => { schemaReady: boolean; applied: number; total: number; pending: number };
  commitSha: string;
  limiter?: SelfhostLoginLimiter;
  users: {
    getById(id: string): Promise<LocalUser | null>;
    getByEmail(email: string): Promise<LocalUser | null>;
    touchLogin(id: string, now: number): Promise<void>;
  };
  sessions: {
    isRevoked(familyHash: string, now: number): Promise<boolean>;
    revoke(familyHash: string, expiresAt: number, now: number): Promise<void>;
  };
  manageUsers?: (req: IncomingMessage, res: ServerResponse, user: LocalUser | null) => Promise<void>;
}
/** The downstream listener only receives gateway-owned identity and canonical origin headers. */
export function createSelfhostGateway(config: SelfhostAuthConfig, downstream: (req: IncomingMessage, res: ServerResponse) => unknown, options: SelfhostGatewayOptions) {
  const now = options.now ?? Date.now, limiter = options.limiter ?? new SelfhostLoginLimiter(); let verifications = 0, authenticationGeneration = 0;
  return async function gateway(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const raw = req.url ?? '/';
      if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 16384 || /[\u0000-\u001f\u007f\\]/.test(raw)) { respond(res, 400, '请求地址无效。'); return; }
      const url = new URL(raw, config.origin), names = selfhostCookieNames(config), cookies = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
      const checkedAt = now(), requestGeneration = authenticationGeneration, claims = validToken(config, 'session', readCookie(cookies, names.session), checkedAt);
      let user: LocalUser | null = null;
      if (claims) {
        try { const found = await options.users.getById(claims.sub); if (found?.status === 'active' && found.revision === claims.revision && !await options.sessions.isRevoked(sessionFamily(claims), checkedAt)) user = found; }
        catch { respond(res, 503, url.pathname.startsWith('/api/admin/users') ? JSON.stringify({ error: '账户服务暂时不可用。', code: 'LOCAL_USERS_UNAVAILABLE' }) : '账户服务暂时不可用，请稍后重试。', url.pathname.startsWith('/api/admin/users') ? { 'Content-Type': 'application/json; charset=utf-8' } : {}); return; }
      }
      const authenticated = user !== null;
      if (user && claims && renewableRead(url.pathname, req.method) && renewalDue(config, claims, checkedAt)) renewSessionOnResponse(res, config, user, claims, checkedAt, () => authenticationGeneration === requestGeneration);
      req.headers = sanitizedSelfhostHeaders(req.headers, config, user);
      req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) => Array.isArray(value) ? value.flatMap(item => [name, item]) : value === undefined ? [] : [name, value]);
      if (url.pathname === '/_selfhost/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { respond(res, 405, '', { Allow: 'GET, HEAD' }); return; }
        try {
          const schema = options.readiness(); if (!schema.schemaReady || !/^[a-f0-9]{40}$/.test(options.commitSha)) throw new Error();
          respond(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({ ok: true, commitSha: options.commitSha, schema }), { 'Content-Type': 'application/json; charset=utf-8' });
        } catch { respond(res, 503, req.method === 'HEAD' ? '' : JSON.stringify({ ok: false }), { 'Content-Type': 'application/json; charset=utf-8' }); }
        return;
      }
      if (url.pathname === '/api/admin/users' || url.pathname.startsWith('/api/admin/users/')) {
        if (!options.manageUsers) { respond(res, 503, JSON.stringify({ error: '账户服务暂时不可用。', code: 'LOCAL_USERS_UNAVAILABLE' }), { 'Content-Type': 'application/json; charset=utf-8' }); return; }
        await options.manageUsers(req, res, user); return;
      }
      if (url.pathname === '/settings/access' && ['GET', 'HEAD'].includes(req.method ?? 'GET')) { respond(res, 303, '', { Location: '/settings/users' }); return; }
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
      if (unsafe && req.headers.origin !== config.origin) { respond(res, 403, '请从本站页面提交。'); return; }
      const login = url.pathname === '/signin-with-chatgpt', logout = url.pathname === '/signout-with-chatgpt';
      if (!login && !logout) { await downstream(req, res); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const returnTo = safeSelfhostReturnTo(url.searchParams.get('return_to'));
        if (login && authenticated) { respond(res, 303, '', { Location: returnTo }); return; }
        const csrf = issueSelfhostCsrf(config, login ? null : user, 'form', now());
        respond(res, 200, req.method === 'HEAD' ? '' : page(config, login ? 'login' : 'logout', csrf, returnTo), { 'Set-Cookie': selfhostCookie(config, names.csrf, csrf, 600) }); return;
      }
      if (req.method !== 'POST') { respond(res, 405, '', { Allow: 'GET, HEAD, POST' }); return; }
      const body = await formBody(req), expected = login ? ['email', 'password', 'csrf', 'return_to'] : ['csrf', 'return_to'];
      const csrf = body.get('csrf'), storedCsrf = readCookie(cookies, names.csrf);
      if ([...body.keys()].some(name => !expected.includes(name) || body.getAll(name).length !== 1) || expected.some(name => !body.has(name))
        || !verifySelfhostCsrf(config, csrf, storedCsrf, login ? null : user, 'form', now())) { respond(res, 403, '登录页面已过期，请重新打开后重试。'); return; }
      const returnTo = safeSelfhostReturnTo(body.get('return_to'));
      if (logout) {
        if (claims) {
          const revokedAt = now();
          try { await options.sessions.revoke(sessionFamily(claims), Math.max(revokedAt, checkedAt) + SESSION_TTL * 1000, revokedAt); }
          catch { respond(res, 503, '暂时无法安全退出，请稍后重试。'); return; }
        }
        authenticationGeneration++;
        respond(res, 303, '', { Location: returnTo, 'Set-Cookie': [selfhostCookie(config, names.session, '', 0), selfhostCookie(config, names.csrf, '', 0), selfhostCookie(config, names.adminCsrf, '', 0)] }); return;
      }
      const peer = req.socket.remoteAddress ?? 'unknown';
      const attemptedAt = now();
      if (!limiter.consume(peer, attemptedAt) || verifications >= 2) { respond(res, 429, '尝试次数较多，请稍后重新打开登录页面。', { 'Retry-After': '900' }); return; }
      verifications++;
      try {
      const suppliedPassword = body.get('password') ?? '';
      let email: string | null = null;
      try { email = normalizeLocalEmail(body.get('email')); } catch { /* Invalid addresses use the same password work and generic failure. */ }
      let found: LocalUser | null;
      try { found = email ? await options.users.getByEmail(email) : null; }
      catch { respond(res, 503, '账户服务暂时不可用，请稍后重试。'); return; }
      const passwordMatches = await verifyPassword(suppliedPassword, found?.passwordHash ?? config.passwordHash);
      let fresh: LocalUser | null = null;
      if (found && passwordMatches) {
        try { fresh = await options.users.getById(found.id); }
        catch { respond(res, 503, '账户服务暂时不可用，请稍后重试。'); return; }
      }
      if (!found || !passwordMatches || fresh?.status !== 'active' || fresh.revision !== found.revision || fresh.email !== email) {
        const nextCsrf = issueSelfhostCsrf(config, null, 'form', now()); respond(res, 401, page(config, 'login', nextCsrf, returnTo, '邮箱或密码不正确。'), { 'Set-Cookie': selfhostCookie(config, names.csrf, nextCsrf, 600) }); return;
      }
      try {
        if (claims) {
          const revokedAt = now();
          await options.sessions.revoke(sessionFamily(claims), Math.max(revokedAt, checkedAt) + SESSION_TTL * 1000, revokedAt);
        }
        await options.users.touchLogin(fresh.id, now());
      }
      catch { respond(res, 503, '账户服务暂时不可用，请稍后重试。'); return; }
      authenticationGeneration++;
      limiter.successful(peer, attemptedAt);
      respond(res, 303, '', { Location: returnTo, 'Set-Cookie': [selfhostCookie(config, names.session, issueSelfhostSession(config, fresh, now()), config.sessionTtl), selfhostCookie(config, names.csrf, '', 0), selfhostCookie(config, names.adminCsrf, '', 0)] });
      } finally { verifications--; }
    } catch {
      if (!res.headersSent) respond(res, 400, '请求未完成，请重新打开页面后重试。'); else res.end();
    }
  };
}
