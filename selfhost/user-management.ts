import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLocalUser, listLocalUsers, updateLocalUser } from '../db/local-users-store.ts';
import type { LocalUsersDatabase } from '../db/local-users-store.ts';
import { LocalUserError, normalizeLocalEmail } from '../lib/local-users.ts';
import type { LocalUser, LocalUserUpdate } from '../lib/local-users.ts';
import { hashPassword, validSelfhostPassword } from './password-hash.ts';
import { issueSelfhostCsrf, readCookie, selfhostCookie, selfhostCookieNames, verifySelfhostCsrf } from './auth.ts';
import type { SelfhostAuthConfig } from './auth.ts';

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
function failure(res: ServerResponse, status: number, code: string, error: string) { json(res, status, { error, code }); }
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' || Number(req.headers['content-length'] ?? 0) > 8192) return Promise.reject(new LocalUserError('LOCAL_USER_INVALID'));
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', fail); req.removeListener('aborted', fail); };
    const fail = () => { cleanup(); reject(new LocalUserError('LOCAL_USER_INVALID')); };
    const data = (value: Buffer | string) => { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); size += chunk.length; if (size > 8192) fail(); else chunks.push(chunk); };
    const end = () => { cleanup(); try {
      const body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      resolve(body);
    } catch { reject(new LocalUserError('LOCAL_USER_INVALID')); } };
    const timer = setTimeout(fail, 10000); req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', fail);
  });
}

/** Native gateway endpoint; the Sites runtime never installs this handler. */
export function createSelfhostUserManagement(config: SelfhostAuthConfig, db: LocalUsersDatabase, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  return async function manage(req: IncomingMessage, res: ServerResponse, user: LocalUser | null): Promise<void> {
    try {
      if (!user) { failure(res, 401, 'SIGN_IN_REQUIRED', '请重新登录。'); return; }
      if (user.id !== config.ownerId) { failure(res, 403, 'LOCAL_USER_FORBIDDEN', '只有管理员可以管理用户。'); return; }
      if (req.headers['x-page-owner'] !== user.id) { failure(res, 409, 'ACCOUNT_CHANGED', '账户已切换，请刷新页面。'); return; }
      // The gateway strips caller-provided markers and only adds this after a
      // revocable native bearer is verified. Browser traffic keeps double-CSRF.
      const native = req.headers['x-jso-native-client'] === 'healthkit-v1';
      const url = new URL(req.url ?? '/', config.origin), base = url.pathname === '/api/admin/users';
      const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (!base && !match) { failure(res, 404, 'NOT_FOUND', '找不到该接口。'); return; }
      const names = selfhostCookieNames(config), stored = readCookie(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined, names.adminCsrf);
      if (req.method === 'GET' && base) {
        if (native) { json(res, 200, { users: await listLocalUsers(db, config.ownerId), currentUserId: user.id }, { 'X-Account-Owner': user.id }); return; }
        const csrfToken = stored && verifySelfhostCsrf(config, stored, stored, user, 'admin', now()) ? stored : issueSelfhostCsrf(config, user, 'admin', now());
        json(res, 200, { users: await listLocalUsers(db, config.ownerId), currentUserId: user.id, csrfToken },
          { 'Set-Cookie': selfhostCookie(config, names.adminCsrf, csrfToken, 600), 'X-Account-Owner': user.id }); return;
      }
      if (!(base && req.method === 'POST') && !(match && req.method === 'PATCH')) {
        failure(res, 405, 'METHOD_NOT_ALLOWED', '该操作不受支持。'); return;
      }
      if (req.headers.origin !== config.origin || !native && !verifySelfhostCsrf(config, req.headers['x-csrf-token'], stored, user, 'admin', now())) {
        failure(res, 403, 'LOCAL_USER_CSRF_INVALID', '页面验证已过期，请刷新用户列表后重试。'); return;
      }
      const body = await readJson(req), at = new Date(now()).toISOString();
      if (base) {
        if (Object.keys(body).length !== 2 || Object.keys(body).some(key => !['email', 'password'].includes(key)) || !validSelfhostPassword(body.password)) throw new LocalUserError('LOCAL_USER_INVALID');
        const created = await createLocalUser(db, { id: randomUUID(), email: normalizeLocalEmail(body.email), passwordHash: await hashPassword(body.password) }, at);
        json(res, 201, { user: created }, { 'X-Account-Owner': user.id }); return;
      }
      let id: string;
      try { id = decodeURIComponent(match![1]); } catch { throw new LocalUserError('LOCAL_USER_INVALID'); }
      const keys = Object.keys(body);
      if (keys.length < 2 || keys.some(key => !['expectedRevision', 'email', 'password', 'status'].includes(key)) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new LocalUserError('LOCAL_USER_INVALID');
      const patch: LocalUserUpdate = { expectedRevision: Number(body.expectedRevision) };
      if (Object.hasOwn(body, 'email')) patch.email = normalizeLocalEmail(body.email);
      if (Object.hasOwn(body, 'password')) {
        if (!validSelfhostPassword(body.password)) throw new LocalUserError('LOCAL_USER_INVALID');
        patch.passwordHash = await hashPassword(body.password);
      }
      if (Object.hasOwn(body, 'status')) {
        if (body.status !== 'active' && body.status !== 'disabled') throw new LocalUserError('LOCAL_USER_INVALID');
        patch.status = body.status;
      }
      const updated = await updateLocalUser(db, config.ownerId, id, patch, at);
      const reauthRequired = updated.id === user.id && updated.revision !== user.revision;
      json(res, 200, { user: updated, ...(reauthRequired ? { reauthRequired: true } : {}) }, { 'X-Account-Owner': user.id });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof LocalUserError) { failure(res, error.status, error.code, error.message); return; }
      failure(res, 503, 'LOCAL_USERS_UNAVAILABLE', '账户服务暂时不可用，请稍后重试。');
    }
  };
}
