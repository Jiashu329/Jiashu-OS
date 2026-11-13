import { env } from 'cloudflare:workers';
import { listFinanceAccounts } from '../../../../db/finance-store';
import { buildFinanceGoalView, FinanceGoalValidationError } from '../../../../lib/finance-goals';
import { todayShanghai } from '../../../../lib/finance';
import type { FinanceGoalPlan } from '../../../../lib/finance-goals';
import { financeError, json } from '../_shared';

export function goalsDatabase() {
  if (!env.DB) throw new Error('Finance database unavailable');
  return env.DB;
}
export function goalsError(error: unknown) {
  if (error instanceof FinanceGoalValidationError) return json({ error: '请检查财务目标。', code: error.code, issues: error.issues }, 400);
  return financeError(error);
}
export function goalNotFound() { return json({ error: '找不到这个财务目标。', code: 'FINANCE_GOAL_NOT_FOUND' }, 404); }
export async function goalAccounts(userId: string, ledger: string, db: D1Database = goalsDatabase()) {
  // Progress needs archived/classification-changed links as well as selectable assets.
  return listFinanceAccounts(db, userId, ledger, true);
}
export async function presentGoal(plan: FinanceGoalPlan, db: D1Database = goalsDatabase()) {
  return buildFinanceGoalView(plan, await goalAccounts(plan.userId, plan.ledger, db), todayShanghai());
}
