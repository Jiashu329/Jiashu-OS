import { AccessConfigurationError, AccessConflictError, AccessForbiddenError, AccessNotFoundError, AccessValidationError, assertAccessOwner, parseAccessInvite, parseAccessOperationId, parseAccessStatus, presentAccessGrant } from './access-control.ts';
import { changeAccessGrant, inviteAccessGrant, listAccessGrants } from '../db/access-grants-store.ts';
import type { AccessOwnerContext } from './access-control.ts';
import type { AccessDatabase } from '../db/access-grants-store.ts';

interface AccessUser { userId: string; email: string; isOwner: boolean }
interface Dependencies {
  user(): Promise<AccessUser | null>;
  ownerId(user: AccessUser): string | undefined;
  database(): AccessDatabase;
  json(value: unknown, status?: number, headers?: Record<string, string>): Response;
}
export const ACCESS_REQUEST_MAX_BYTES = 8192;
async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > ACCESS_REQUEST_MAX_BYTES) throw new RangeError('Access request too large');
  if (!request.body) throw new SyntaxError('Missing body');
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let size = 0, content = '';
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > ACCESS_REQUEST_MAX_BYTES) { await reader.cancel(); throw new RangeError('Access request too large'); }
      content += decoder.decode(item.value, { stream: true });
    }
    return JSON.parse(content + decoder.decode()) as unknown;
  } finally { reader.releaseLock(); }
}
export function createAccessHandlers(deps: Dependencies) {
  const errorResponse = (error: unknown) => {
    if (error instanceof AccessValidationError || error instanceof AccessConfigurationError || error instanceof AccessConflictError || error instanceof AccessForbiddenError || error instanceof AccessNotFoundError) return deps.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof SyntaxError) return deps.json({ error: '成员配置不是有效的 JSON。', code: 'INVALID_ACCESS_REQUEST' }, 400);
    if (error instanceof RangeError) return deps.json({ error: '成员配置不能超过 8 KB。', code: 'ACCESS_REQUEST_TOO_LARGE' }, 413);
    return deps.json({ error: '暂时无法确认成员配置，请稍后继续确认原操作。', code: 'ACCESS_STORAGE_UNAVAILABLE' }, 503);
  };
  async function context(request: Request): Promise<AccessOwnerContext | Response> {
    const user = await deps.user();
    if (!user) return deps.json({ error: '请先登录网站。', code: 'SIGN_IN_REQUIRED' }, 401);
    if (user.isOwner !== true) return deps.json({ error: '只有创建者可以管理允许访问的成员。', code: 'ACCESS_OWNER_REQUIRED' }, 403);
    const ownerUserId = deps.ownerId(user);
    assertAccessOwner(user.userId, ownerUserId);
    const pageOwner = request.headers.get('X-Page-Owner');
    if (pageOwner && pageOwner !== user.userId) return deps.json({ error: '登录账号已变化，请刷新成员设置页面后继续。', code: 'ACCOUNT_CHANGED' }, 401);
    return { actorUserId: user.userId, ownerUserId, ownerEmail: user.email };
  }
  const guard = (request: Request) => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return deps.json({ error: '请从已登录的成员设置页面提交。', code: 'INVALID_ORIGIN' }, 403);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return deps.json({ error: '请通过网站提交 JSON 成员配置。', code: 'INVALID_ACCESS_REQUEST' }, 415);
    return null;
  };
  return {
    async GET(request: Request) {
      try {
        const owner = await context(request); if (owner instanceof Response) return owner;
        const grants = await listAccessGrants(deps.database(), owner);
        return deps.json({ owner: { email: owner.ownerEmail, automaticAccess: true }, grants: grants.map(presentAccessGrant) });
      } catch (error) { return errorResponse(error); }
    },
    async POST(request: Request) {
      try {
        const owner = await context(request); if (owner instanceof Response) return owner;
        const blocked = guard(request); if (blocked) return blocked;
        const operationId = parseAccessOperationId(request.headers.get('Idempotency-Key'));
        const input = parseAccessInvite(await body(request));
        const result = await inviteAccessGrant(deps.database(), owner, input, operationId);
        return deps.json({ grant: presentAccessGrant(result.grant), replayed: result.replayed }, result.replayed ? 200 : 201);
      } catch (error) { return errorResponse(error); }
    },
    async PATCH(request: Request, grantId: string) {
      try {
        const owner = await context(request); if (owner instanceof Response) return owner;
        const blocked = guard(request); if (blocked) return blocked;
        const operationId = parseAccessOperationId(request.headers.get('Idempotency-Key'));
        parseAccessOperationId(grantId);
        const input = parseAccessStatus(await body(request));
        const result = await changeAccessGrant(deps.database(), owner, grantId, input, operationId);
        return deps.json({ grant: presentAccessGrant(result.grant), replayed: result.replayed });
      } catch (error) { return errorResponse(error); }
    },
  };
}
