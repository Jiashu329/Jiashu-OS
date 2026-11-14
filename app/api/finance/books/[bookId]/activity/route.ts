import { env } from 'cloudflare:workers';
import { listFinanceBookActivity } from '../../../../../../db/finance-book-activity-store';
import { apiUser, json, financeError, financeUnauthenticated } from '../../../_shared';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ bookId: string }> }) {
  const user = await apiUser(); if (!user) return financeUnauthenticated();
  const pageOwner = request.headers.get('X-Page-Owner');
  if (pageOwner && pageOwner !== user.userId) return json({ code: 'ACCOUNT_CHANGED', error: '登录账号已变化，请刷新页面后继续。' }, 401);
  const params = new URL(request.url).searchParams;
  const invalid = () => json({ code: 'FINANCE_BOOK_INVALID', error: '请提交有效的活动分页与账本版本。' }, 400);
  if ([...params.keys()].some((key) => !['offset', 'limit', 'bookRevision'].includes(key) || params.getAll(key).length !== 1)) return invalid();
  const offset = params.get('offset'), limit = params.get('limit'), revision = params.get('bookRevision');
  if ([offset, revision].some((value) => value !== null && (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))))
    || limit !== null && !/^[1-9]\d?$/.test(limit)) return invalid();
  try {
    if (!env.DB) throw new Error('Finance database unavailable');
    const { bookId } = await context.params;
    return json(await listFinanceBookActivity(env.DB, user, bookId, { offset: offset === null ? 0 : Number(offset),
      limit: limit === null ? 30 : Number(limit), ...(revision === null ? {} : { accessRevision: Number(revision) }) }));
  } catch (error) { return financeError(error); }
}
