import { applyBalanceChange, financeAccountDetails } from '../../../../../../../db/finance-repository';
import { parseFinanceBalanceChange, validBalanceEntryId } from '../../../../../../../lib/finance-balance-change';
import { apiUser, financeBody, financeError, financeIdempotencyKey, financeNotFound, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json, validAccountId } from '../../../../_shared';
import { financeRequestScope, publicFinanceBook } from '../../../../_book';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string; entryId: string }> }) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request); if (guard) return guard;
  const operationId = financeIdempotencyKey(request); if (!operationId) return invalidFinanceIdempotencyKey();
  const { id, entryId } = await context.params;
  if (!validAccountId(id) || !validBalanceEntryId(entryId)) return financeNotFound();
  try {
    const readCtx = await financeRequestScope(request, user, { accountId: id });
    const details = await financeAccountDetails(readCtx.scope.ownerUserId, id, readCtx.db);
    if (!details) return financeNotFound();
    const input = parseFinanceBalanceChange(await financeBody(request), details.account.currency);
    const ctx = await financeRequestScope(request, user, { accountId: id, write: { action: 'balance.' + input.action, input, operationId, targetId: entryId } });
    const result = await applyBalanceChange(ctx.scope.ownerUserId, id, entryId, input, operationId, ctx.db);
    return result ? json({ ...result, book: publicFinanceBook(ctx.scope) }) : financeNotFound();
  } catch (error) { return financeError(error); }
}

