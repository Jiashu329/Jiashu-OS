import { FinanceBookError, parseFinanceBookId, parseFinanceBookInvite, parseFinanceBookMemberAction } from './finance-books.ts';
import type { FinanceBookActor } from './finance-books.ts';
import { changeFinanceBookMember, inviteFinanceBookMember, listFinanceBookMembers, listFinanceBooks, respondFinanceBookInvitation } from '../db/finance-books-store.ts';
import type { FinanceBooksDatabase } from '../db/finance-books-store.ts';

interface Dependencies {
  unauthenticated?(message?: string): Response | Promise<Response>;
  user(): Promise<FinanceBookActor | null>;
  database(): FinanceBooksDatabase;
  json(value: unknown, status?: number): Response;
}
async function body(request: Request): Promise<unknown> {
  const maximum = 8192;
  if (Number(request.headers.get('content-length')) > maximum) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new RangeError(); }
      text += decoder.decode(item.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { reader.releaseLock(); }
}

/** Site entry and book editing are separate permissions. This never creates a
 * site access grant, sends email, or accepts an invitation on a GET request. */
export function createFinanceBookHandlers(deps: Dependencies) {
  const failure = (error: unknown): Response => {
    if (error instanceof FinanceBookError) return deps.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof SyntaxError) return deps.json({ error: '邀请内容不是有效的 JSON。', code: 'FINANCE_BOOK_INVALID' }, 400);
    if (error instanceof RangeError) return deps.json({ error: '单次邀请请求不能超过 8 KB。', code: 'FINANCE_BOOK_REQUEST_TOO_LARGE' }, 413);
    return deps.json({ error: '暂时无法确认家庭协作操作，请重新读取后核对原操作。', code: 'FINANCE_BOOK_UNAVAILABLE' }, 503);
  };
  async function actor(request: Request): Promise<FinanceBookActor | Response> {
    const user = await deps.user();
    if (!user) return deps.unauthenticated ? deps.unauthenticated('请先登录网站，再查看家庭邀请。') : deps.json({ error: '请先登录网站，再查看家庭邀请。', code: 'SIGN_IN_REQUIRED' }, 401);
    const pageOwner = request.headers.get('X-Page-Owner');
    if (pageOwner && pageOwner !== user.userId) return deps.json({ error: '登录账号已变化，请刷新页面后继续。', code: 'ACCOUNT_CHANGED' }, 401);
    return user;
  }
  function guard(request: Request): Response | null {
    if (request.headers.get('origin') !== new URL(request.url).origin) return deps.json({ error: '请从已登录的网站管理家庭协作。', code: 'INVALID_ORIGIN' }, 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return deps.json({ error: '请通过网站提交 JSON 邀请。', code: 'INVALID_CONTENT_TYPE' }, 415);
    return null;
  }
  async function mutation(request: Request, run: (user: FinanceBookActor, input: unknown, operationId: string) => Promise<unknown>): Promise<Response> {
    try {
      const user = await actor(request); if (user instanceof Response) return user;
      const blocked = guard(request); if (blocked) return blocked;
      const operationId = parseFinanceBookId(request.headers.get('Idempotency-Key'), false);
      const input = await body(request);
      return deps.json(await run(user, input, operationId));
    } catch (error) { return failure(error); }
  }
  return {
    async GET(request: Request) {
      try { const user = await actor(request); return user instanceof Response ? user : deps.json(await listFinanceBooks(deps.database(), user)); }
      catch (error) { return failure(error); }
    },
    async MEMBERS(request: Request, bookId: string) {
      try {
        const user = await actor(request); if (user instanceof Response) return user;
        return deps.json(await listFinanceBookMembers(deps.database(), user, parseFinanceBookId(bookId)));
      } catch (error) { return failure(error); }
    },
    INVITE(request: Request, bookId: string) {
      return mutation(request, async (user, input, operationId) => inviteFinanceBookMember(deps.database(), user, parseFinanceBookId(bookId), parseFinanceBookInvite(input), operationId));
    },
    REVOKE(request: Request, bookId: string, memberId: string) {
      return mutation(request, async (user, input, operationId) => {
        const change = parseFinanceBookMemberAction(input, ['revoke', 'role']) as { action: 'revoke' | 'role'; expectedRevision: number; role?: 'editor' | 'viewer' };
        return changeFinanceBookMember(deps.database(), user, parseFinanceBookId(bookId), parseFinanceBookId(memberId, false), change, operationId);
      });
    },
    RESPOND(request: Request, invitationId: string) {
      return mutation(request, async (user, input, operationId) => {
        const response = parseFinanceBookMemberAction(input, ['accept', 'decline']) as { action: 'accept' | 'decline'; expectedRevision: number };
        return respondFinanceBookInvitation(deps.database(), user, parseFinanceBookId(invitationId, false), response, operationId);
      });
    },
  };
}
