import { env } from 'cloudflare:workers';
import { listFinanceAccounts } from '../../../../db/finance-store';
import { FinanceRunwayConflictError, readFinanceRunwaySettings, writeFinanceRunwaySettings } from '../../../../db/finance-runway-store';
import { buildFinanceRunwayView, FinanceRunwayValidationError, parseFinanceRunwayCommand } from '../../../../lib/finance-runway';
import { ACCOUNT_TYPES, CURRENCIES, parseCurrency, parseLedger, todayShanghai } from '../../../../lib/finance';
import type { AccountType, CurrencyCode, LedgerKind } from '../../../../lib/finance';
import type { FinanceRunwaySettings } from '../../../../lib/finance-runway';
import { apiUser, financeBody, financeError, financeUnauthenticated, guardFinanceWrite, json } from '../_shared';

export const dynamic = 'force-dynamic';

function database() {
  if (!env.DB) throw new Error('Finance database unavailable');
  return env.DB;
}
function scope(request: Request) {
  const params = new URL(request.url).searchParams;
  return { ledger: parseLedger(params.get('ledger') ?? 'personal'), currency: parseCurrency(params.get('currency') ?? 'CNY') };
}
function errorResponse(error: unknown) {
  if (error instanceof FinanceRunwayConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof FinanceRunwayValidationError) return json({ error: '请检查应急月数设置。', code: error.code, issues: error.issues }, 400);
  return financeError(error);
}
async function present(userId: string, ledger: LedgerKind, currency: CurrencyCode, settings: FinanceRunwaySettings | null) {
  const accounts = (await listFinanceAccounts(database(), userId, ledger)).filter((account) => account.currency === currency
    && Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type as AccountType].side === 'asset');
  return {
    ledger, currency, today: todayShanghai(), revision: settings?.revision ?? 0, ...buildFinanceRunwayView(settings, accounts),
    accounts: accounts.map(({ id, name, type, currency, ledger, balanceMinor, asOfDate }) => ({ id, name, type, currency, ledger, balanceMinor, asOfDate })),
    meta: { currencies: CURRENCIES },
  };
}

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  try {
    const { ledger, currency } = scope(request);
    const settings = await readFinanceRunwaySettings(database(), user.userId, ledger, currency);
    return json(await present(user.userId, ledger, currency, settings));
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  try {
    const { ledger, currency } = scope(request);
    const command = parseFinanceRunwayCommand(await financeBody(request), currency);
    const settings = await writeFinanceRunwaySettings(database(), user.userId, ledger, currency, command.input, command.expectedRevision);
    return json(await present(user.userId, ledger, currency, settings));
  } catch (error) { return errorResponse(error); }
}
