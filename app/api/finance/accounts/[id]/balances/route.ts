import { financeAccountDetails, newFinanceBalance } from '../../../../../../db/finance-repository';
import { parseBalanceEntry } from '../../../../../../lib/finance';
import { apiUser, financeBody, financeError, financeIdempotencyKey, financeNotFound, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json, validAccountId } from '../../../_shared';

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
    const details = await financeAccountDetails(user.userId, id);
    if (!details) return financeNotFound();
    const result = await newFinanceBalance(user.userId, id, parseBalanceEntry(await financeBody(request), details.account.currency), key);
    if (result) return json(result, 201);
    if (details.account.archived) return json({ error: '请先恢复这个账户，再更新余额。', code: 'FINANCE_ACCOUNT_ARCHIVED' }, 409);
    return json({ error: '账户状态已经变化，请刷新后重试。', code: 'FINANCE_ACCOUNT_CHANGED' }, 409);
  } catch (error) { return financeError(error); }
}
