import { buildFinanceAllocationView } from '../lib/finance-allocation.ts';
import { buildFinanceGoalView } from '../lib/finance-goals.ts';
import { buildFinanceRunwayView } from '../lib/finance-runway.ts';
import { todayShanghai } from '../lib/finance.ts';
import type { CurrencyCode, LedgerKind } from '../lib/finance.ts';
import { readFinanceGoalPlans } from './finance-goals-store.ts';
import { readFinanceRunwaySettings } from './finance-runway-store.ts';
import { listFinanceAccounts } from './finance-store.ts';

/** Current planning state, deliberately separate from a historical month-close. */
export async function readFinanceDecisionSummary(
  db: Pick<D1Database, 'prepare' | 'batch'>,
  userId: string,
  ledger: LedgerKind,
  currency: CurrencyCode,
  today = todayShanghai(),
) {
  const [plans, accounts, runway] = await Promise.all([
    readFinanceGoalPlans(db, userId, ledger, currency),
    listFinanceAccounts(db, userId, ledger, true),
    readFinanceRunwaySettings(db, userId, ledger, currency),
  ]);
  return {
    basis: 'current' as const, asOfDate: today, ledger, currency,
    goals: plans.map((plan) => {
      const { id, name, status, gapMinor, monthlyMinor, deadline, percent } = buildFinanceGoalView(plan, accounts, today);
      return { id, name, status, gapMinor, monthlyMinor, deadline, percent };
    }),
    runway: buildFinanceRunwayView(runway, accounts, today).progress,
    sharing: buildFinanceAllocationView({ userId, ledger }, plans, accounts, runway ? [runway] : []),
  };
}

export type FinanceDecisionSummary = Awaited<ReturnType<typeof readFinanceDecisionSummary>>;
