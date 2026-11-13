import { financeRequestScope, publicFinanceBook, assertFinanceBookExport } from '../_book';
import { financeExport } from '../../../../db/finance-repository';
import { apiUser, financeError, financeUnauthenticated, json, ledgerFromRequest } from '../_shared';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const ledger = ledgerFromRequest(request);
  if (!ledger) return json({ error: '请选择个人账本或家庭账本。' }, 400);
  try {
    const ctx = await financeRequestScope(request, user, { ledger });
    assertFinanceBookExport(ctx.scope);
    return json({ ...await financeExport(ctx.scope.ownerUserId, ledger, ctx.db), book: publicFinanceBook(ctx.scope) }, 200, { 'Content-Disposition': `attachment; filename="jiashu-finance-${ledger}.json"` });
  } catch (error) { return financeError(error); }
}
