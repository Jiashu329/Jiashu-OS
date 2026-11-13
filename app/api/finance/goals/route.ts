import { financeRequestScope, publicFinanceBook } from '../_book';
import { createFinanceGoalPlan, readFinanceGoalPlans } from '../../../../db/finance-goals-store';
import { readFinanceRunwaySettings } from '../../../../db/finance-runway-store';
import { buildFinanceAllocationView } from '../../../../lib/finance-allocation';
import { buildFinanceGoalView, parseFinanceGoalCreate } from '../../../../lib/finance-goals';
import { ACCOUNT_TYPES, CURRENCIES, parseCurrency, parseLedger, todayShanghai } from '../../../../lib/finance';
import type { AccountType } from '../../../../lib/finance';
import { apiUser, financeBody, financeIdempotencyKey, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json } from '../_shared';
import { goalAccounts, goalsError, presentGoal } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  try {
    const query = new URL(request.url).searchParams;
    const ledger = parseLedger(query.get('ledger') ?? 'personal');
    const requestedCurrency = query.get('currency') ?? 'all';
    const currency = requestedCurrency === 'all' ? 'all' : parseCurrency(requestedCurrency);
    const ctx = await financeRequestScope(request, user, { ledger });
    const [plans, accounts] = await Promise.all([
      readFinanceGoalPlans(ctx.db, ctx.scope.ownerUserId, ledger, currency, query.get('includeArchived') === '1'),
      goalAccounts(ctx.scope.ownerUserId, ledger, ctx.db),
    ]);
    const runwayCurrencies = [...new Set(plans.filter((plan) => plan.archivedAt === null).map((plan) => plan.currency))];
    const runwaySettings = (await Promise.all(runwayCurrencies.map((code) => readFinanceRunwaySettings(ctx.db, ctx.scope.ownerUserId, ledger, code))))
      .filter((settings) => settings !== null);
    const sharing = buildFinanceAllocationView({ userId: ctx.scope.ownerUserId, ledger }, plans, accounts, runwaySettings);
    const today = todayShanghai();
    return json({ book: publicFinanceBook(ctx.scope), ledger, currency, today, sharing, goals: plans.map((plan) => ({ ...buildFinanceGoalView(plan, accounts, today), sharing: sharing.byGoal[plan.id] ?? null })),
      accounts: accounts.filter((account) => account.archivedAt === null && Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type as AccountType].side === 'asset')
        .map(({ id, name, type, currency, ledger, balanceMinor, asOfDate }) => ({ id, name, type, currency, ledger, balanceMinor, asOfDate })),
      meta: { currencies: CURRENCIES } });
  } catch (error) { return goalsError(error); }
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const key = financeIdempotencyKey(request);
  if (!key) return invalidFinanceIdempotencyKey();
  try {
    const input = parseFinanceGoalCreate(await financeBody(request));
    const ctx = await financeRequestScope(request, user, { ledger: input.ledger, write: { action: 'goal.create', input, operationId: key, targetId: key } });
    const plan = await createFinanceGoalPlan(ctx.db, ctx.scope.ownerUserId, input, key);
    return json({ goal: await presentGoal(plan, ctx.db), book: publicFinanceBook(ctx.scope) }, 201);
  } catch (error) { return goalsError(error); }
}
