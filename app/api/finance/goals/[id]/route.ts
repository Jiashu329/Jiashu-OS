import { findFinanceGoalPlan, patchFinanceGoalPlan } from '../../../../../db/finance-goals-store';
import { parseFinanceGoalPatch } from '../../../../../lib/finance-goals';
import { apiUser, financeBody, financeUnauthenticated, guardFinanceWrite, json, validAccountId } from '../../_shared';
import { goalNotFound, goalsDatabase, goalsError, presentGoal } from '../_shared';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const { id } = await context.params;
  if (!validAccountId(id)) return goalNotFound();
  try {
    const existing = await findFinanceGoalPlan(goalsDatabase(), user.userId, id);
    if (!existing) return goalNotFound();
    const patch = parseFinanceGoalPatch(await financeBody(request), existing.currency);
    const plan = await patchFinanceGoalPlan(goalsDatabase(), user.userId, id, patch);
    return plan ? json({ goal: await presentGoal(plan) }) : goalNotFound();
  } catch (error) { return goalsError(error); }
}
