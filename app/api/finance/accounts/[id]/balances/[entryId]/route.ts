import { applyBalanceChange, financeAccountDetails } from '../../../../../../../db/finance-repository';
import { parseFinanceBalanceChange, validBalanceEntryId } from '../../../../../../../lib/finance-balance-change';
import { apiUser, financeBody, financeError, financeIdempotencyKey, financeNotFound, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json, validAccountId } from '../../../../_shared';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string; entryId: string }> }) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request); if (guard) return guard;
  const operationId = financeIdempotencyKey(request); if (!operationId) return invalidFinanceIdempotencyKey();
  const { id, entryId } = await context.params;
  if (!validAccountId(id) || !validBalanceEntryId(entryId)) return financeNotFound();
  try {
    const details = await financeAccountDetails(user.userId, id);
    if (!details) return financeNotFound();
    const input = parseFinanceBalanceChange(await financeBody(request), details.account.currency);
    const result = await applyBalanceChange(user.userId, id, entryId, input, operationId);
    return result ? json(result) : financeNotFound();
  } catch (error) { return financeError(error); }
}

