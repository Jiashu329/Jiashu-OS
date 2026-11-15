/* oxlint-disable no-control-regex -- Authentication boundaries intentionally reject control bytes in credentials, identity fields and request paths. */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

const HASH_PREFIX = 'scrypt-v1';
const SCRYPT_N = 32768, SCRYPT_R = 8, SCRYPT_P = 1, HASH_BYTES = 64;
const FORM_LIMIT = 4096;
const SESSION_TTL = 12 * 60 * 60;
export interface SelfhostAuthConfig {
  origin: string; host: string; secure: boolean; username: string; passwordHash: string;
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
function parsedHash(value: unknown): { salt: Buffer; hash: Buffer } | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const fields = value.split('$');
  if (fields.length !== 6 || fields[0] !== HASH_PREFIX || fields[1] !== String(SCRYPT_N) || fields[2] !== String(SCRYPT_R) || fields[3] !== String(SCRYPT_P)) return null;
  const salt = decode(fields[4], 16), hash = decode(fields[5], HASH_BYTES);
  return salt && hash ? { salt, hash } : null;
}
function passwordValid(password: unknown): password is string {
  return typeof password === 'string' && Array.from(password).length >= 12 && Array.from(password).length <= 256
    && Buffer.byteLength(password, 'utf8') <= 1024 && !/[\u0000\r\n]/.test(password);
}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, HASH_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
/** Passwords are never logged or written by this helper. Bootstrap supplies its own private files. */
export async function hashPassword(password: string): Promise<string> {
  if (!passwordValid(password)) throw new Error('Password must contain 12–256 characters without NUL or line breaks.');
  const salt = randomBytes(16), hash = await derive(password, salt);
  return [HASH_PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}
export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  const parsed = parsedHash(encoded);
  if (!parsed || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024 || /[\u0000\r\n]/.test(password)) return false;
  return bytesEqual(await derive(password, parsed.salt), parsed.hash);
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
    const username = source.SELFHOST_USERNAME, passwordHash = source.SELFHOST_PASSWORD_HASH, sessionSecret = source.SELFHOST_SESSION_SECRET;
    const ownerId = source.APP_OWNER_USER_ID, ownerEmail = source.APP_OWNER_EMAIL;
    const sessionTtl = source.SELFHOST_SESSION_TTL_SECONDS === undefined ? SESSION_TTL : Number(source.SELFHOST_SESSION_TTL_SECONDS);
    if (!simple(username, 80) || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{2,79}$/.test(username) || !parsedHash(passwordHash)
      || typeof sessionSecret !== 'string' || !decode(sessionSecret, 32) || !simple(ownerId, 200) || !simple(ownerEmail, 254)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || !Number.isInteger(sessionTtl) || sessionTtl < 300 || sessionTtl > 86400) throw new Error();
    return Object.freeze({ origin: origin.origin, host: origin.host, secure: origin.protocol === 'https:', username, passwordHash: passwordHash!, sessionSecret, ownerId, ownerEmail, sessionTtl });
  } catch { throw new SelfhostAuthConfigurationError(); }
}
export function safeSelfhostReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 2000 || /[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  let url: URL;
  try { url = new URL(value, 'https://selfhost.invalid'); } catch { return '/'; }
  if (url.origin !== 'https://selfhost.invalid' || /%(?:2f|5c)/i.test(url.pathname)) return '/';
  const exact = ['/', '/account', '/notifications', '/data', '/backup', '/connect-steps', '/connect-sleep', '/connect-weight', '/sync-guide'];
  const groups = ['/health', '/life', '/finance', '/settings', '/sync'];
  return exact.includes(url.pathname) || groups.some(path => url.pathname === path || url.pathname.startsWith(path + '/')) ? url.pathname + url.search + url.hash : '/';
}
function key(config: SelfhostAuthConfig, purpose: 'session' | 'csrf'): Buffer {
  return createHmac('sha256', Buffer.from(config.sessionSecret, 'base64url'))
    .update(JSON.stringify(['jiashu-selfhost-v1', purpose, config.origin, config.username, config.passwordHash, config.ownerId, config.ownerEmail])).digest();
}
function sign(config: SelfhostAuthConfig, purpose: 'session' | 'csrf', encoded: string): string {
  return createHmac('sha256', key(config, purpose)).update(encoded).digest('base64url');
}
function token(config: SelfhostAuthConfig, purpose: 'session' | 'csrf', ttl: number, now: number): string {
  const iat = Math.floor(now / 1000), payload = { v: 1, sub: config.ownerId, iat, exp: iat + ttl, nonce: randomBytes(24).toString('base64url') };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + sign(config, purpose, encoded);
}
function validToken(config: SelfhostAuthConfig, purpose: 'session' | 'csrf', value: unknown, now: number): boolean {
  if (typeof value !== 'string' || value.length > 1500 || !Number.isFinite(now)) return false;
  const fields = value.split('.'); if (fields.length !== 2) return false;
  const content = decode(fields[0]), signature = decode(fields[1], 32);
  if (!content || !signature || !bytesEqual(signature, Buffer.from(sign(config, purpose, fields[0]), 'base64url'))) return false;
  try {
    const payload = JSON.parse(content.toString('utf8')), at = Math.floor(now / 1000), ttl = purpose === 'session' ? config.sessionTtl : 600;
    return payload && Object.keys(payload).sort().join(',') === 'exp,iat,nonce,sub,v' && payload.v === 1 && payload.sub === config.ownerId
      && typeof payload.nonce === 'string' && decode(payload.nonce, 24) !== null && Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp)
      && payload.iat >= 0 && payload.iat <= at + 30 && payload.exp > at && payload.exp > payload.iat && payload.exp - payload.iat <= ttl;
  } catch { return false; }
}
export const issueSelfhostSession = (config: SelfhostAuthConfig, now = Date.now()) => token(config, 'session', config.sessionTtl, now);
export const verifySelfhostSession = (config: SelfhostAuthConfig, value: unknown, now = Date.now()) => validToken(config, 'session', value, now);
export function selfhostCookieNames(config: SelfhostAuthConfig) {
  return { session: config.secure ? '__Host-jso-session' : 'jso-test-session', csrf: config.secure ? '__Host-jso-csrf' : 'jso-test-csrf' };
}
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header || header.length > 16384) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
function cookie(config: SelfhostAuthConfig, name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
}
export function sanitizedSelfhostHeaders(headers: IncomingHttpHeaders, config: SelfhostAuthConfig, authenticated: boolean): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('oai-') || lower.startsWith('x-auth') || lower.startsWith('x-forwarded-') || lower.startsWith('x-middleware-') || lower.startsWith('x-vinext-')
      || ['forwarded', 'host', 'x-real-ip', 'proxy-authorization', 'proxy-authenticate'].includes(lower)) continue;
    result[lower] = value;
  }
  result.host = config.host; result['x-forwarded-host'] = config.host; result['x-forwarded-proto'] = config.secure ? 'https' : 'http';
  if (authenticated) {
    result['oai-authenticated-user-id'] = config.ownerId;
    result['oai-authenticated-user-email'] = config.ownerEmail;
    result['oai-authenticated-user-full-name'] = encodeURIComponent(config.username);
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
  successful(peer: string) { this.entries.delete(peer); }
}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function page(config: SelfhostAuthConfig, action: 'login' | 'logout', csrf: string, returnTo: string, error = ''): string {
  const login = action === 'login', endpoint = login ? '/signin-with-chatgpt' : '/signout-with-chatgpt';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${login ? '登录' : '退出'} · Jiashu OS</title><style>body{margin:0;background:#f3f5f8;color:#1d2738;font:15px/1.7 system-ui,sans-serif}main{max-width:420px;margin:10vh auto;padding:28px;background:white;border:1px solid #dfe5ee;border-radius:14px}h1{font-size:25px;margin:0 0 8px}p{color:#627089}label{display:grid;gap:5px;margin-top:16px}input,button{font:inherit;min-height:44px;border:1px solid #dfe5ee;border-radius:8px;padding:8px 12px;box-sizing:border-box;width:100%}button{margin-top:22px;background:#4267a8;color:white;cursor:pointer}a{color:#4267a8}input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #4267a8;outline-offset:3px}.error{color:#aa263d}@media(max-width:500px){main{margin:40px 16px;padding:22px}}</style></head><body><main><h1>${login ? '登录测试站' : '退出当前登录'}</h1><p>${login ? '使用服务器管理员提供的独立测试账号。' : '退出后，需要重新输入账号和密码。'}</p>${error ? '<p class="error" role="alert">' + escape(error) + '</p>' : ''}<form action="${endpoint}" method="post"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="return_to" value="${escape(returnTo)}">${login ? '<label>账号<input name="username" autocomplete="username" maxlength="80" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="256" required></label>' : ''}<button type="submit">${login ? '登录' : '确认退出'}</button></form><p><a href="${login ? '/' : escape(returnTo)}">${login ? '返回首页' : '继续使用'}</a></p></main></body></html>`;
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
}
/** The downstream listener only receives gateway-owned identity and canonical origin headers. */
export function createSelfhostGateway(config: SelfhostAuthConfig, downstream: (req: IncomingMessage, res: ServerResponse) => unknown, options: SelfhostGatewayOptions) {
  const now = options.now ?? Date.now, limiter = options.limiter ?? new SelfhostLoginLimiter(); let verifications = 0;
  return async function gateway(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const raw = req.url ?? '/';
      if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 16384 || /[\u0000-\u001f\u007f\\]/.test(raw)) { respond(res, 400, '请求地址无效。'); return; }
      const url = new URL(raw, config.origin), names = selfhostCookieNames(config), cookies = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
      const authenticated = verifySelfhostSession(config, readCookie(cookies, names.session), now());
      req.headers = sanitizedSelfhostHeaders(req.headers, config, authenticated);
      req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) => Array.isArray(value) ? value.flatMap(item => [name, item]) : value === undefined ? [] : [name, value]);
      if (url.pathname === '/_selfhost/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { respond(res, 405, '', { Allow: 'GET, HEAD' }); return; }
        try {
          const schema = options.readiness(); if (!schema.schemaReady || !/^[a-f0-9]{40}$/.test(options.commitSha)) throw new Error();
          respond(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({ ok: true, commitSha: options.commitSha, schema }), { 'Content-Type': 'application/json; charset=utf-8' });
        } catch { respond(res, 503, req.method === 'HEAD' ? '' : JSON.stringify({ ok: false }), { 'Content-Type': 'application/json; charset=utf-8' }); }
        return;
      }
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
      if (unsafe && req.headers.origin !== config.origin) { respond(res, 403, '请从本站页面提交。'); return; }
      const login = url.pathname === '/signin-with-chatgpt', logout = url.pathname === '/signout-with-chatgpt';
      if (!login && !logout) { await downstream(req, res); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const returnTo = safeSelfhostReturnTo(url.searchParams.get('return_to'));
        if (login && authenticated) { respond(res, 303, '', { Location: returnTo }); return; }
        const csrf = token(config, 'csrf', 600, now());
        respond(res, 200, req.method === 'HEAD' ? '' : page(config, login ? 'login' : 'logout', csrf, returnTo), { 'Set-Cookie': cookie(config, names.csrf, csrf, 600) }); return;
      }
      if (req.method !== 'POST') { respond(res, 405, '', { Allow: 'GET, HEAD, POST' }); return; }
      const body = await formBody(req), expected = login ? ['username', 'password', 'csrf', 'return_to'] : ['csrf', 'return_to'];
      const csrf = body.get('csrf'), storedCsrf = readCookie(cookies, names.csrf);
      if ([...body.keys()].some(name => !expected.includes(name) || body.getAll(name).length !== 1) || expected.some(name => !body.has(name))
        || !csrf || !storedCsrf || !bytesEqual(Buffer.from(csrf), Buffer.from(storedCsrf)) || !validToken(config, 'csrf', csrf, now())) { respond(res, 403, '登录页面已过期，请重新打开后重试。'); return; }
      const returnTo = safeSelfhostReturnTo(body.get('return_to'));
      if (logout) { respond(res, 303, '', { Location: returnTo, 'Set-Cookie': [cookie(config, names.session, '', 0), cookie(config, names.csrf, '', 0)] }); return; }
      const peer = req.socket.remoteAddress ?? 'unknown';
      if (!limiter.consume(peer, now()) || verifications >= 2) { respond(res, 429, '尝试次数较多，请稍后重新打开登录页面。', { 'Retry-After': '900' }); return; }
      const suppliedUsername = body.get('username') ?? '', suppliedPassword = body.get('password') ?? '';
      const usernameMatches = bytesEqual(createHash('sha256').update(suppliedUsername).digest(), createHash('sha256').update(config.username).digest());
      verifications++; let passwordMatches: boolean;
      try { passwordMatches = await verifyPassword(suppliedPassword, config.passwordHash); } finally { verifications--; }
      if (!usernameMatches || !passwordMatches) { const nextCsrf = token(config, 'csrf', 600, now()); respond(res, 401, page(config, 'login', nextCsrf, returnTo, '账号或密码不正确。'), { 'Set-Cookie': cookie(config, names.csrf, nextCsrf, 600) }); return; }
      limiter.successful(peer);
      respond(res, 303, '', { Location: returnTo, 'Set-Cookie': [cookie(config, names.session, issueSelfhostSession(config, now()), config.sessionTtl), cookie(config, names.csrf, '', 0)] });
    } catch {
      if (!res.headersSent) respond(res, 400, '请求未完成，请重新打开页面后重试。'); else res.end();
    }
  };
}
