import { financeRequestScope, publicFinanceBook } from '../_book';
import { listFinanceAccounts } from '../../../../db/finance-store';
import { FinanceRunwayConflictError, readFinanceRunwaySettings, writeFinanceRunwaySettings } from '../../../../db/finance-runway-store';
import { buildFinanceRunwayView, FinanceRunwayValidationError, parseFinanceRunwayCommand } from '../../../../lib/finance-runway';
import { ACCOUNT_TYPES, CURRENCIES, parseCurrency, parseLedger, todayShanghai } from '../../../../lib/finance';
import type { AccountType, CurrencyCode, LedgerKind } from '../../../../lib/finance';
import type { FinanceRunwaySettings } from '../../../../lib/finance-runway';
import { apiUser, financeBody, financeError, financeUnauthenticated, guardFinanceWrite, json } from '../_shared';

export const dynamic = 'force-dynamic';

function scope(request: Request) {
  const params = new URL(request.url).searchParams;
  return { ledger: parseLedger(params.get('ledger') ?? 'personal'), currency: parseCurrency(params.get('currency') ?? 'CNY') };
}
function errorResponse(error: unknown) {
  if (error instanceof FinanceRunwayConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof FinanceRunwayValidationError) return json({ error: '请检查应急月数设置。', code: error.code, issues: error.issues }, 400);
  return financeError(error);
}
async function present(userId: string, ledger: LedgerKind, currency: CurrencyCode, settings: FinanceRunwaySettings | null, db: D1Database) {
  const accounts = (await listFinanceAccounts(db, userId, ledger)).filter((account) => account.currency === currency
    && Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type as AccountType].side === 'asset');
  return {
    ledger, currency, today: todayShanghai(), revision: settings?.revision ?? 0, ...buildFinanceRunwayView(settings, accounts),
    accounts: accounts.map(({ id, name, type, currency, ledger, balanceMinor, asOfDate, liquidityKind, usableBps, metadataRevision }) => ({ id, name, type, currency, ledger, balanceMinor, asOfDate, liquidityKind, usableBps, metadataRevision })),
    meta: { currencies: CURRENCIES },
  };
}

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  try {
    const { ledger, currency } = scope(request);
    const ctx = await financeRequestScope(request, user, { ledger });
    const settings = await readFinanceRunwaySettings(ctx.db, ctx.scope.ownerUserId, ledger, currency);
    return json({ ...await present(ctx.scope.ownerUserId, ledger, currency, settings, ctx.db), book: publicFinanceBook(ctx.scope) });
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
    const ctx = await financeRequestScope(request, user, { ledger, write: { action: 'runway.update', input: command } });
    const settings = await writeFinanceRunwaySettings(ctx.db, ctx.scope.ownerUserId, ledger, currency, command.input, command.expectedRevision);
    return json({ ...await present(ctx.scope.ownerUserId, ledger, currency, settings, ctx.db), book: publicFinanceBook(ctx.scope) });
  } catch (error) { return errorResponse(error); }
}
