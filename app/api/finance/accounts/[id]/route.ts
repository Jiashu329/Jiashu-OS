import { financeAccountDetails, updateFinanceAccount } from '../../../../../db/finance-repository';
import { parseAccountPatchCommand } from '../../../../../lib/finance';
import { apiUser, financeBody, financeError, financeNotFound, financeUnauthenticated, guardFinanceWrite, json, validAccountId } from '../../_shared';
import { financeRequestScope, publicFinanceBook } from '../../_book';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const { id } = await context.params;
  if (!validAccountId(id)) return financeNotFound();
  try {
    const ctx = await financeRequestScope(request, user, { accountId: id });
    const result = await financeAccountDetails(ctx.scope.ownerUserId, id, ctx.db);
    return result ? json({ ...result, book: publicFinanceBook(ctx.scope) }) : financeNotFound();
  }
  catch (error) { return financeError(error); }
}
export async function PATCH(request: Request, context: Context) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const { id } = await context.params;
  if (!validAccountId(id)) return financeNotFound();
  try {
    const input = parseAccountPatchCommand(await financeBody(request));
    const ctx = await financeRequestScope(request, user, { accountId: id, write: { action: 'account.update', input, targetId: id } });
    const result = await updateFinanceAccount(ctx.scope.ownerUserId, id, input, ctx.db);
    return result ? json({ ...result, book: publicFinanceBook(ctx.scope) }) : financeNotFound();
  }
  catch (error) { return financeError(error); }
}
