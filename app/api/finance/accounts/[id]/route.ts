import { financeAccountDetails, updateFinanceAccount } from '../../../../../db/finance-repository';
import { parseAccountPatchCommand } from '../../../../../lib/finance';
import { apiUser, financeBody, financeError, financeNotFound, financeUnauthenticated, guardFinanceWrite, json, validAccountId } from '../../_shared';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const { id } = await context.params;
  if (!validAccountId(id)) return financeNotFound();
  try { const result = await financeAccountDetails(user.userId, id); return result ? json(result) : financeNotFound(); }
  catch (error) { return financeError(error); }
}
export async function PATCH(request: Request, context: Context) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const { id } = await context.params;
  if (!validAccountId(id)) return financeNotFound();
  try { const result = await updateFinanceAccount(user.userId, id, parseAccountPatchCommand(await financeBody(request))); return result ? json(result) : financeNotFound(); }
  catch (error) { return financeError(error); }
}
