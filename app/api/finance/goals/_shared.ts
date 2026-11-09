import { env } from 'cloudflare:workers';
import { listFinanceAccounts } from '../../../../db/finance-store';
import { buildFinanceGoalView, FinanceGoalValidationError } from '../../../../lib/finance-goals';
import { ACCOUNT_TYPES, todayShanghai } from '../../../../lib/finance';
import type { AccountType } from '../../../../lib/finance';
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
export async function goalAccounts(userId: string, ledger: string) {
  return (await listFinanceAccounts(goalsDatabase(), userId, ledger)).filter((row) => Object.hasOwn(ACCOUNT_TYPES, row.type) && ACCOUNT_TYPES[row.type as AccountType].side === 'asset');
}
export async function presentGoal(plan: FinanceGoalPlan) {
  return buildFinanceGoalView(plan, await goalAccounts(plan.userId, plan.ledger), todayShanghai());
}
