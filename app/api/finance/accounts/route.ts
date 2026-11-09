import { newFinanceAccount } from '../../../../db/finance-repository';
import { parseCreateAccount } from '../../../../lib/finance';
import { apiUser, financeBody, financeError, financeIdempotencyKey, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json } from '../_shared';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const key = financeIdempotencyKey(request);
  if (!key) return invalidFinanceIdempotencyKey();
  try { return json(await newFinanceAccount(user.userId, parseCreateAccount(await financeBody(request)), key), 201); }
  catch (error) { return financeError(error); }
}
