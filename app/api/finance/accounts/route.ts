import { newFinanceAccount } from '../../../../db/finance-repository';
import { parseCreateAccount } from '../../../../lib/finance';
import { apiUser, financeBody, financeError, financeIdempotencyKey, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json } from '../_shared';
import { financeRequestScope, publicFinanceBook } from '../_book';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const key = financeIdempotencyKey(request);
  if (!key) return invalidFinanceIdempotencyKey();
  try {
    const input = parseCreateAccount(await financeBody(request));
    const ctx = await financeRequestScope(request, user, { ledger: input.ledger, write: { action: 'account.create', input, operationId: key, targetId: key } });
    const result = await newFinanceAccount(ctx.scope.ownerUserId, input, key, ctx.db);
    return json({ ...result, book: publicFinanceBook(ctx.scope) }, 201);
  }
  catch (error) { return financeError(error); }
}
