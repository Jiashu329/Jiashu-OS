import { createFinanceGoalPlan, readFinanceGoalPlans } from '../../../../db/finance-goals-store';
import { readFinanceRunwaySettings } from '../../../../db/finance-runway-store';
import { buildFinanceAllocationView } from '../../../../lib/finance-allocation';
import { buildFinanceGoalView, parseFinanceGoalCreate } from '../../../../lib/finance-goals';
import { CURRENCIES, parseCurrency, parseLedger, todayShanghai } from '../../../../lib/finance';
import { apiUser, financeBody, financeIdempotencyKey, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json } from '../_shared';
import { goalAccounts, goalsDatabase, goalsError, presentGoal } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  try {
    const query = new URL(request.url).searchParams;
    const ledger = parseLedger(query.get('ledger') ?? 'personal');
    const requestedCurrency = query.get('currency') ?? 'all';
    const currency = requestedCurrency === 'all' ? 'all' : parseCurrency(requestedCurrency);
    const [plans, accounts] = await Promise.all([
      readFinanceGoalPlans(goalsDatabase(), user.userId, ledger, currency, query.get('includeArchived') === '1'),
      goalAccounts(user.userId, ledger),
    ]);
    const runwayCurrencies = [...new Set(plans.filter((plan) => plan.archivedAt === null).map((plan) => plan.currency))];
    const runwaySettings = (await Promise.all(runwayCurrencies.map((code) => readFinanceRunwaySettings(goalsDatabase(), user.userId, ledger, code))))
      .filter((settings) => settings !== null);
    const sharing = buildFinanceAllocationView({ userId: user.userId, ledger }, plans, accounts, runwaySettings);
    const today = todayShanghai();
    return json({ ledger, currency, today, sharing, goals: plans.map((plan) => ({ ...buildFinanceGoalView(plan, accounts, today), sharing: sharing.byGoal[plan.id] ?? null })),
      accounts: accounts.map(({ id, name, type, currency, ledger, balanceMinor, asOfDate }) => ({ id, name, type, currency, ledger, balanceMinor, asOfDate })),
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
    const plan = await createFinanceGoalPlan(goalsDatabase(), user.userId, input, key);
    return json({ goal: await presentGoal(plan) }, 201);
  } catch (error) { return goalsError(error); }
}
