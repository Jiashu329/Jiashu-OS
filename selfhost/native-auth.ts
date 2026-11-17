/* oxlint-disable no-control-regex -- Reject control bytes at the native authentication boundary. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { SelfhostAuthConfig, SelfhostGatewayOptions } from './auth.ts';
import type { LocalUser } from '../lib/local-users.ts';
import { normalizeLocalEmail } from '../lib/local-users.ts';
import { verifyPassword } from './password-hash.ts';

const MAX_LOGIN_BYTES = 16384;
const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
// Explicit method allowlist: each route retains its existing business authorization.
export const NATIVE_API_ROUTES: Readonly<Record<string, readonly string[]>> = {
  '/api/native/access': ['GET', 'POST'],
  '/api/native/admin/users': ['GET', 'POST'],
  '/api/native/ai/settings': ['DELETE', 'GET', 'PUT'],
  '/api/native/ai/settings/test': ['POST'],
  '/api/native/backup': ['GET', 'POST'],
  '/api/native/data/backup': ['GET', 'POST'],
  '/api/native/finance': ['GET'],
  '/api/native/finance/accounts': ['POST'],
  '/api/native/finance/books': ['GET'],
  '/api/native/finance/export': ['GET'],
  '/api/native/finance/goals': ['GET', 'POST'],
  '/api/native/finance/review': ['GET'],
  '/api/native/finance/review/close': ['POST'],
  '/api/native/finance/runway': ['GET', 'PUT'],
  '/api/native/health': ['GET'],
  '/api/native/health/actions': ['GET', 'PUT'],
  '/api/native/health/assistant': ['GET', 'POST'],
  '/api/native/health/export': ['GET'],
  '/api/native/health/foods': ['GET'],
  '/api/native/health/foods/manage': ['GET', 'POST'],
  '/api/native/health/goals': ['GET', 'PUT'],
  '/api/native/health/goals/progress': ['GET'],
  '/api/native/health/import': ['GET', 'POST'],
  '/api/native/health/import/preview': ['POST'],
  '/api/native/health/nutrition': ['GET', 'POST'],
  '/api/native/health/nutrition/batch': ['POST'],
  '/api/native/health/nutrition/copy': ['POST'],
  '/api/native/health/nutrition/favorites': ['DELETE', 'GET', 'POST'],
  '/api/native/health/nutrition/foods': ['GET'],
  '/api/native/health/nutrition/goals': ['GET', 'PUT'],
  '/api/native/health/nutrition/needs': ['POST'],
  '/api/native/health/nutrition/parse': ['POST'],
  '/api/native/health/nutrition/photo': ['POST'],
  '/api/native/health/nutrition/reuse': ['GET', 'POST'],
  '/api/native/health/nutrition/review': ['GET'],
  '/api/native/health/nutrition/status': ['GET', 'PATCH'],
  '/api/native/health/nutrition/templates': ['GET', 'POST'],
  '/api/native/health/records': ['GET', 'POST'],
  '/api/native/health/review': ['GET'],
  '/api/native/health/weight-plan': ['GET', 'PUT'],
  '/api/native/health/weight-plan/cycles': ['GET', 'POST'],
  '/api/native/life/douban': ['GET'],
  '/api/native/life/douban/classification': ['PUT'],
  '/api/native/life/douban/connection': ['PUT'],
  '/api/native/life/douban/cover': ['GET'],
  '/api/native/life/douban/cover-selection': ['PUT'],
  '/api/native/life/douban/imdb-ratings': ['POST'],
  '/api/native/life/douban/import': ['POST'],
  '/api/native/life/douban/library': ['POST', 'PUT'],
  '/api/native/life/douban/metadata': ['POST', 'PUT'],
  '/api/native/life/douban/reset': ['POST'],
  '/api/native/life/douban/sync': ['POST'],
  '/api/native/life/douban/tmdb': ['POST'],
  '/api/native/media/tmdb/settings': ['DELETE', 'GET', 'PUT'],
  '/api/native/media/tmdb/settings/test': ['POST'],
  '/api/native/notifications': ['GET', 'POST'],
  '/api/native/overview': ['GET'],
  '/api/native/session': ['GET'],
  '/api/native/sync/channel': ['DELETE', 'GET', 'PUT'],
  '/api/native/sync/config': ['GET'],
  '/api/native/sync/devices': ['GET', 'POST'],
  '/api/native/sync/status': ['GET'],
  '/api/native/sync/template': ['GET'],
};
const AUTH_PATHS = ['/api/native/auth/login', '/api/native/auth/refresh', '/api/native/auth/logout'];
type NativeParameter = 'id' | 'record' | 'hash';
const DYNAMIC_ROUTES: ReadonlyArray<{ pattern: RegExp; methods: readonly string[]; parameters: readonly NativeParameter[] }> = [
  { pattern: /^\/api\/native\/access\/([^/]+)$/, methods: ['PATCH'], parameters: ['id'] },
  { pattern: /^\/api\/native\/admin\/users\/([^/]+)$/, methods: ['PATCH'], parameters: ['id'] },
  { pattern: /^\/api\/native\/finance\/accounts\/([^/]+)$/, methods: ['GET', 'PATCH'], parameters: ['id'] },
  { pattern: /^\/api\/native\/finance\/accounts\/([^/]+)\/balances$/, methods: ['POST'], parameters: ['id'] },
  { pattern: /^\/api\/native\/finance\/accounts\/([^/]+)\/balances\/([^/]+)$/, methods: ['POST'], parameters: ['id', 'id'] },
  { pattern: /^\/api\/native\/finance\/accounts\/([^/]+)\/balances\/([^/]+)\/preview$/, methods: ['POST'], parameters: ['id', 'id'] },
  { pattern: /^\/api\/native\/finance\/books\/([^/]+)\/activity$/, methods: ['GET'], parameters: ['id'] },
  { pattern: /^\/api\/native\/finance\/books\/([^/]+)\/invitations$/, methods: ['POST'], parameters: ['id'] },
  { pattern: /^\/api\/native\/finance\/books\/([^/]+)\/members$/, methods: ['GET'], parameters: ['id'] },
  { pattern: /^\/api\/native\/finance\/books\/([^/]+)\/members\/([^/]+)$/, methods: ['POST'], parameters: ['id', 'id'] },
  { pattern: /^\/api\/native\/finance\/books\/invitations\/([^/]+)\/respond$/, methods: ['POST'], parameters: ['id'] },
  { pattern: /^\/api\/native\/finance\/goals\/([^/]+)$/, methods: ['GET', 'PATCH'], parameters: ['id'] },
  { pattern: /^\/api\/native\/health\/import\/([^/]+)\/revert$/, methods: ['POST'], parameters: ['hash'] },
  { pattern: /^\/api\/native\/health\/nutrition\/([^/]+)$/, methods: ['GET', 'PATCH'], parameters: ['id'] },
  { pattern: /^\/api\/native\/health\/nutrition\/([^/]+)\/history$/, methods: ['GET'], parameters: ['id'] },
  { pattern: /^\/api\/native\/health\/nutrition\/([^/]+)\/restore$/, methods: ['POST'], parameters: ['id'] },
  { pattern: /^\/api\/native\/health\/nutrition\/templates\/([^/]+)$/, methods: ['GET', 'PUT', 'DELETE'], parameters: ['id'] },
  { pattern: /^\/api\/native\/health\/nutrition\/templates\/([^/]+)\/preview$/, methods: ['POST'], parameters: ['id'] },
  { pattern: /^\/api\/native\/health\/records\/([^/]+)$/, methods: ['GET', 'PATCH'], parameters: ['record'] },
  { pattern: /^\/api\/native\/health\/records\/([^/]+)\/history$/, methods: ['GET'], parameters: ['record'] },
  { pattern: /^\/api\/native\/sync\/devices\/([^/]+)$/, methods: ['DELETE'], parameters: ['id'] },
];

function validParameter(raw: string, kind: NativeParameter): boolean {
  let value: string;
  try { value = decodeURIComponent(raw); } catch { return false; }
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f%\\?#]/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')) return false;
  if (kind === 'hash') return /^[a-f0-9]{64}$/.test(value);
  if (kind === 'record') return /^(steps|sleep|active_energy):\d{4}-\d{2}-\d{2}$/.test(value)
    || /^(weight|lean_body_mass):[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,159}$/.test(value);
  return !value.includes('/') && value === value.trim();
}

/** No wildcard proxy: new server routes require an explicit native review. */
export function nativeAPIMethods(path: string): readonly string[] | null {
  if (Object.hasOwn(NATIVE_API_ROUTES, path)) return NATIVE_API_ROUTES[path];
  for (const route of DYNAMIC_ROUTES) {
    const match = route.pattern.exec(path);
    if (match && route.parameters.every((kind, index) => validParameter(match[index + 1], kind))) return route.methods;
  }
  return null;
}
interface NativeClaims { sub: string; revision: number; issuedAt: number; expiresAt: number; nonce: string }
interface LoginLimiter { consume(peer: string, now: number): boolean; successful(peer: string, attemptedAt?: number): void }
type SanitizeHeaders = (headers: IncomingHttpHeaders, config: SelfhostAuthConfig, user: LocalUser) => IncomingHttpHeaders;

function signingKey(config: SelfhostAuthConfig): Buffer {
  return createHmac('sha256', Buffer.from(config.sessionSecret, 'base64url'))
    .update(JSON.stringify(['jiashu-native-session-v1', config.origin])).digest();
}
function signature(config: SelfhostAuthConfig, value: string): Buffer {
  return createHmac('sha256', signingKey(config)).update(value).digest();
}
function decode(value: string, length?: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const result = Buffer.from(value, 'base64url');
  return result.toString('base64url') === value && (length === undefined || result.length === length) ? result : null;
}
function issue(config: SelfhostAuthConfig, user: LocalUser, now: number, nonce = randomBytes(24).toString('base64url')) {
  const issuedAt = Math.floor(now / 1000), expiresAt = issuedAt + config.sessionTtl;
  const encoded = Buffer.from(JSON.stringify({ v: 1, sub: user.id, rev: user.revision, iat: issuedAt, exp: expiresAt, nonce })).toString('base64url');
  return { accessToken: encoded + '.' + signature(config, encoded).toString('base64url'),
    expiresAt: new Date(expiresAt * 1000).toISOString(), user: { id: user.id, email: user.email } };
}
function verify(config: SelfhostAuthConfig, header: unknown, now: number): NativeClaims | null {
  if (typeof header !== 'string' || header.length > 1600 || !header.startsWith('Bearer ')) return null;
  const parts = header.slice(7).split('.');
  if (parts.length !== 2) return null;
  const data = decode(parts[0]), suppliedSignature = decode(parts[1], 32);
  if (!data || !suppliedSignature || !timingSafeEqual(suppliedSignature, signature(config, parts[0]))) return null;
  try {
    const value = JSON.parse(data.toString('utf8')), at = Math.floor(now / 1000);
    if (!value || Object.keys(value).sort().join(',') !== 'exp,iat,nonce,rev,sub,v' || value.v !== 1
      || typeof value.sub !== 'string' || !value.sub || value.sub.length > 200 || /[\u0000-\u001f\u007f]/.test(value.sub)
      || !Number.isSafeInteger(value.rev) || value.rev < 1 || !Number.isSafeInteger(value.iat) || value.iat < 0 || value.iat > at + 30
      || !Number.isSafeInteger(value.exp) || value.exp <= at || value.exp <= value.iat || value.exp - value.iat > config.sessionTtl
      || typeof value.nonce !== 'string' || !decode(value.nonce, 24)) return null;
    return { sub: value.sub, revision: value.rev, issuedAt: value.iat, expiresAt: value.exp, nonce: value.nonce };
  } catch { return null; }
}
function family(claims: NativeClaims): string {
  return createHash('sha256').update(JSON.stringify(['native-v1', claims.sub, claims.nonce])).digest('hex');
}
function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(JSON.stringify(body));
}
function rejected(res: ServerResponse) { json(res, 401, { error: 'App 登录已失效，请重新登录。', code: 'NATIVE_SIGN_IN_REQUIRED' }); }
function unavailable(res: ServerResponse) { json(res, 503, { error: '账户服务暂时不可用，请稍后重试。', code: 'LOCAL_USERS_UNAVAILABLE' }, { 'Retry-After': '3' }); }

async function credentials(req: IncomingMessage): Promise<{ email: string; password: string }> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('invalid_login');
  if (Number(req.headers['content-length'] ?? 0) > MAX_LOGIN_BYTES) throw new Error('invalid_login');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const cleanup = () => { clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end); req.removeListener('aborted', failed); req.removeListener('error', failed); };
    const failed = () => { cleanup(); reject(new Error('invalid_login')); };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
      if (bytes > MAX_LOGIN_BYTES) failed(); else chunks.push(buffer);
    };
    const end = () => {
      cleanup();
      try {
        const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'email,password'
          || typeof value.email !== 'string' || value.email.length > 254 || typeof value.password !== 'string'
          || !value.password || value.password.length > 1024 || /[\u0000-\u001f\u007f]/.test(value.password)) throw new Error();
        resolve({ email: value.email, password: value.password });
      } catch { reject(new Error('invalid_login')); }
    };
    const timer = setTimeout(failed, 10000); timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('aborted', failed); req.once('error', failed);
  });
}

/** Native credentials never become browser cookies. The gateway alone adapts a
 * verified native principal to the existing application request contract. */
export function createNativeGateway(config: SelfhostAuthConfig, downstream: (req: IncomingMessage, res: ServerResponse) => unknown,
  options: SelfhostGatewayOptions, limiter: LoginLimiter, sanitize: SanitizeHeaders) {
  const now = options.now ?? Date.now;
  let verifications = 0;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = req.url ?? '', rawPath = raw.split('?')[0];
    const url = new URL(raw, config.origin);
    // Origin-bearing requests are browser traffic. Native endpoints neither
    // accept cookies as credentials nor add CORS access to browser sessions.
    if (req.headers.origin !== undefined || req.headers.cookie !== undefined) {
      json(res, 403, { error: '请从原生 App 登录并访问。', code: 'NATIVE_REQUEST_REQUIRED' }); return;
    }
    if (rawPath !== url.pathname || /\/\/|\\/.test(rawPath) || url.hash || !rawPath.startsWith('/api/native/')) {
      json(res, 400, { error: 'App 请求地址无效。', code: 'NATIVE_INVALID_PATH' }); return;
    }
    const auth = AUTH_PATHS.includes(url.pathname), methods = auth ? ['POST'] : nativeAPIMethods(url.pathname);
    if (rawPath.includes('%') && !methods) { json(res, 400, { error: 'App 请求地址无效。', code: 'NATIVE_INVALID_PATH' }); return; }
    if (!methods) { json(res, 404, { error: '找不到这个 App 接口。', code: 'NATIVE_NOT_FOUND' }); return; }
    if (!methods.includes(req.method ?? 'GET')) { json(res, 405, { error: '请求方法不受支持。', code: 'NATIVE_METHOD_NOT_ALLOWED' }, { Allow: methods.join(', ') }); return; }
    if (auth && url.search) { json(res, 400, { error: '登录请求地址无效。', code: 'NATIVE_INVALID_PATH' }); return; }
    if (url.pathname === '/api/native/auth/login') {
      let supplied: { email: string; password: string };
      try { supplied = await credentials(req); }
      catch { json(res, 400, { error: '请填写有效的邮箱和密码。', code: 'NATIVE_INVALID_LOGIN' }); return; }
      const peer = req.socket.remoteAddress ?? 'unknown', attemptedAt = now();
      if (!limiter.consume(peer, attemptedAt) || verifications >= 2) {
        json(res, 429, { error: '尝试次数较多，请稍后再登录。', code: 'NATIVE_RATE_LIMITED' }, { 'Retry-After': '900' }); return;
      }
      verifications++;
      try {
        let email: string | null = null;
        try { email = normalizeLocalEmail(supplied.email); } catch { /* Keep failures generic. */ }
        let found: LocalUser | null;
        try { found = email ? await options.users.getByEmail(email) : null; }
        catch { unavailable(res); return; }
        const matches = await verifyPassword(supplied.password, found?.passwordHash ?? config.passwordHash);
        let fresh: LocalUser | null = null;
        if (found && matches) {
          try { fresh = await options.users.getById(found.id); }
          catch { unavailable(res); return; }
        }
        if (!found || !matches || fresh?.status !== 'active' || fresh.revision !== found.revision || fresh.email !== email) {
          json(res, 401, { error: '邮箱或密码不正确。', code: 'NATIVE_INVALID_CREDENTIALS' }); return;
        }
        try { await options.users.touchLogin(fresh.id, now()); }
        catch { unavailable(res); return; }
        limiter.successful(peer, attemptedAt);
        json(res, 200, issue(config, fresh, now()));
      } finally { verifications--; }
      return;
    }
    const checkedAt = now(), claims = verify(config, req.headers.authorization, checkedAt);
    if (!claims) { rejected(res); return; }
    let user: LocalUser | null;
    try {
      user = await options.users.getById(claims.sub);
      if (!user || user.status !== 'active' || user.revision !== claims.revision || await options.sessions.isRevoked(family(claims), checkedAt)) { rejected(res); return; }
    } catch { unavailable(res); return; }
    if (url.pathname === '/api/native/auth/logout') {
      const revokedAt = now();
      try { await options.sessions.revoke(family(claims), Math.max(revokedAt, checkedAt) + MAX_SESSION_SECONDS * 1000, revokedAt); }
      catch { unavailable(res); return; }
      json(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/api/native/auth/refresh') {
      // Preserve the family and bound issuance to the authentication snapshot.
      // A slow refresh racing logout must not outlive its revocation horizon.
      json(res, 200, issue(config, user, checkedAt, claims.nonce)); return;
    }
    const headers = sanitize(req.headers, config, user);
    delete headers.authorization; delete headers.cookie; delete headers.referer;
    headers.origin = config.origin;
    headers['x-page-owner'] = user.id;
    headers['x-jso-native-client'] = 'healthkit-v1';
    req.headers = headers;
    req.rawHeaders = Object.entries(headers).flatMap(([name, value]) => Array.isArray(value) ? value.flatMap(item => [name, item]) : value === undefined ? [] : [name, value]);
    req.url = url.pathname.replace('/api/native/', '/api/') + url.search;
    if (url.pathname === '/api/native/admin/users' || url.pathname.startsWith('/api/native/admin/users/')) {
      if (!options.manageUsers) { unavailable(res); return; }
      await options.manageUsers(req, res, user); return;
    }
    await downstream(req, res);
  };
}
