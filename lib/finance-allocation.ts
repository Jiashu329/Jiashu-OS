import { ACCOUNT_TYPES } from './finance.ts';
import type { AccountType, CurrencyCode, LedgerKind } from './finance.ts';
import type { FinanceGoalAccount, FinanceGoalPlan } from './finance-goals.ts';
import type { FinanceRunwaySettings } from './finance-runway.ts';

export interface SharedFinanceAccount {
  accountId: string;
  name: string;
  currency: CurrencyCode;
  balanceMinor: string;
  goals: { id: string; name: string }[];
  includesRunway: boolean;
}
export interface GoalFundSharing {
  sharedBalanceMinor: string;
  accounts: SharedFinanceAccount[];
  otherGoals: { id: string; name: string }[];
  includesRunway: boolean;
}
export interface FinanceAllocationView {
  accounts: SharedFinanceAccount[];
  byGoal: Record<string, GoalFundSharing>;
}

/** References only: shared balances are never reserved, deducted or transferred.
 * Accounts must be read for the owner; an optional owner field is checked too.
 */
export function buildFinanceAllocationView(
  scope: { userId: string; ledger: LedgerKind },
  plans: readonly FinanceGoalPlan[],
  accounts: readonly (FinanceGoalAccount & { userId?: string })[],
  runways: readonly FinanceRunwaySettings[],
): FinanceAllocationView {
  const eligible = new Map(accounts.filter((account) => account.ledger === scope.ledger
    && (account.userId === undefined || account.userId === scope.userId)
    && account.archivedAt === null && Object.hasOwn(ACCOUNT_TYPES, account.type)
    && ACCOUNT_TYPES[account.type as AccountType].side === 'asset')
    .map((account) => [account.id, account]));
  const activePlans = new Map(plans.filter((plan) => plan.userId === scope.userId
    && plan.ledger === scope.ledger && plan.archivedAt === null).map((plan) => [plan.id, plan]));
  const references = new Map<string, SharedFinanceAccount>();
  for (const plan of activePlans.values()) {
    for (const id of new Set(plan.accountIds)) {
      const account = eligible.get(id);
      if (!account || account.currency !== plan.currency) continue;
      let shared = references.get(id);
      if (!shared) {
        shared = { accountId: id, name: account.name, currency: plan.currency,
          balanceMinor: account.balanceMinor, goals: [], includesRunway: false };
        references.set(id, shared);
      }
      shared.goals.push({ id: plan.id, name: plan.name });
    }
  }
  for (const runway of runways) {
    if (runway.userId !== scope.userId || runway.ledger !== scope.ledger) continue;
    for (const id of new Set(runway.accountIds)) {
      const account = eligible.get(id);
      const shared = references.get(id);
      if (account?.currency === runway.currency && shared) shared.includesRunway = true;
    }
  }
  const sharedAccounts = [...references.values()].filter((account) => account.goals.length > 1 || account.includesRunway)
    .sort((left, right) => left.currency.localeCompare(right.currency) || left.accountId.localeCompare(right.accountId));
  const byGoal: Record<string, GoalFundSharing> = Object.create(null) as Record<string, GoalFundSharing>;
  for (const plan of activePlans.values()) {
    const linked = sharedAccounts.filter((account) => account.goals.some((goal) => goal.id === plan.id));
    const otherGoals = new Map(linked.flatMap((account) => account.goals).filter((goal) => goal.id !== plan.id)
      .map((goal) => [goal.id, goal]));
    byGoal[plan.id] = { sharedBalanceMinor: linked.reduce((total, account) => total + BigInt(account.balanceMinor), BigInt(0)).toString(),
      accounts: linked, otherGoals: [...otherGoals.values()], includesRunway: linked.some((account) => account.includesRunway) };
  }
  return { accounts: sharedAccounts, byGoal };
}
