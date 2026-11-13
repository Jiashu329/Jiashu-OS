import { financeOverview } from '../../../db/finance-repository';
import { apiUser, financeError, financeUnauthenticated, json, ledgerFromRequest } from './_shared';
import { readWithDeadline } from '../../../lib/read-deadline';
import { financeRequestScope, publicFinanceBook } from './_book';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const ledger = ledgerFromRequest(request);
  if (!ledger) return json({ error: '请选择个人账本或家庭账本。' }, 400);
  const includeArchived = new URL(request.url).searchParams.get('includeArchived') === '1';
  try {
    const ctx = await financeRequestScope(request, user, { ledger });
    const overview = await readWithDeadline(financeOverview(ctx.scope.ownerUserId, ledger, includeArchived, ctx.db));
    return json({ ...overview, book: publicFinanceBook(ctx.scope) });
  }
  catch (error) { return financeError(error); }
}
