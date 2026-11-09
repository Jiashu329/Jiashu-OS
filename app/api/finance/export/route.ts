import { financeExport } from '../../../../db/finance-repository';
import { apiUser, financeError, financeUnauthenticated, json, ledgerFromRequest } from '../_shared';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const ledger = ledgerFromRequest(request);
  if (!ledger) return json({ error: '请选择个人账本或家庭账本。' }, 400);
  try {
    return json(await financeExport(user.userId, ledger), 200, { 'Content-Disposition': `attachment; filename="jiashu-finance-${ledger}.json"` });
  } catch (error) { return financeError(error); }
}
