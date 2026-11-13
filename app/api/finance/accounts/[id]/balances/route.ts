import { financeAccountDetails, newFinanceBalance } from '../../../../../../db/finance-repository';
import { parseBalanceEntry } from '../../../../../../lib/finance';
import { apiUser, financeBody, financeError, financeIdempotencyKey, financeNotFound, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json, validAccountId } from '../../../_shared';
import { financeRequestScope, publicFinanceBook } from '../../../_book';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const key = financeIdempotencyKey(request);
  if (!key) return invalidFinanceIdempotencyKey();
  const { id } = await context.params;
  if (!validAccountId(id)) return financeNotFound();
  try {
    const readCtx = await financeRequestScope(request, user, { accountId: id });
    const details = await financeAccountDetails(readCtx.scope.ownerUserId, id, readCtx.db);
    if (!details) return financeNotFound();
    const input = parseBalanceEntry(await financeBody(request), details.account.currency);
    const ctx = await financeRequestScope(request, user, { accountId: id, write: { action: 'balance.append', input, operationId: key, targetId: id } });
    const result = await newFinanceBalance(ctx.scope.ownerUserId, id, input, key, ctx.db);
    if (result) return json({ ...result, book: publicFinanceBook(ctx.scope) }, 201);
    if (details.account.archived) return json({ error: '请先恢复这个账户，再更新余额。', code: 'FINANCE_ACCOUNT_ARCHIVED' }, 409);
    return json({ error: '账户状态已经变化，请刷新后重试。', code: 'FINANCE_ACCOUNT_CHANGED' }, 409);
  } catch (error) { return financeError(error); }
}
