import { financeRequestScope, publicFinanceBook } from '../../_book';
import { findFinanceGoalPlan, patchFinanceGoalPlan } from '../../../../../db/finance-goals-store';
import { parseFinanceGoalPatchCommand } from '../../../../../lib/finance-goals';
import { apiUser, financeBody, financeUnauthenticated, guardFinanceWrite, json, validAccountId } from '../../_shared';
import { goalNotFound, goalsError, presentGoal } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const { id } = await context.params;
  if (!validAccountId(id)) return goalNotFound();
  try {
    const ctx = await financeRequestScope(request, user, { goalId: id });
    const goal = await findFinanceGoalPlan(ctx.db, ctx.scope.ownerUserId, id);
    return goal ? json({ goal: await presentGoal(goal, ctx.db), book: publicFinanceBook(ctx.scope) }) : goalNotFound();
  } catch (error) { return goalsError(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const { id } = await context.params;
  if (!validAccountId(id)) return goalNotFound();
  try {
    const readCtx = await financeRequestScope(request, user, { goalId: id });
    const existing = await findFinanceGoalPlan(readCtx.db, readCtx.scope.ownerUserId, id);
    if (!existing) return goalNotFound();
    const patch = parseFinanceGoalPatchCommand(await financeBody(request), existing.currency);
    const ctx = await financeRequestScope(request, user, { ledger: existing.ledger, goalId: id, write: { action: 'goal.update', input: patch, targetId: id } });
    const plan = await patchFinanceGoalPlan(ctx.db, ctx.scope.ownerUserId, id, patch);
    return plan ? json({ goal: await presentGoal(plan, ctx.db), book: publicFinanceBook(ctx.scope) }) : goalNotFound();
  } catch (error) { return goalsError(error); }
}
