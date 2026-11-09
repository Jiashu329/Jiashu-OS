import { ACCOUNT_TYPES, decimalFromMinor, FinanceValidationError, parseMoney } from './finance.ts';
import type { AccountType, CurrencyCode, FinanceIssue, LedgerKind } from './finance.ts';
import type { FinanceGoalAccount } from './finance-goals.ts';

export type FinanceRunwayAccount = FinanceGoalAccount;
export interface FinanceRunwayInput {
  monthlyExpenseMinor: string;
  targetMonths: number;
  accountIds: string[];
}
export interface FinanceRunwaySettings extends FinanceRunwayInput {
  userId: string;
  ledger: LedgerKind;
  currency: CurrencyCode;
  createdAt: string;
  updatedAt: string;
}
export interface FinanceRunwayProgress {
  currentMinor: string;
  runwayMonths: string;
  runwayWholeMonths: string;
  runwayRemainderMinor: string;
  targetMinor: string;
  gapMinor: string;
  percent: number;
  missingCount: number;
  matchedAccountCount: number;
  oldestBalanceDate: string | null;
  latestBalanceDate: string | null;
  status: 'covered' | 'short';
}
export interface FinanceRunwayView {
  settings: (FinanceRunwayInput & { monthlyExpenseAmount: string; createdAt: string; updatedAt: string }) | null;
  progress: FinanceRunwayProgress | null;
}
export class FinanceRunwayValidationError extends Error {
  readonly code = 'INVALID_FINANCE_RUNWAY';
  readonly issues: FinanceIssue[];
  constructor(issues: FinanceIssue[]) {
    super(issues.map((issue) => issue.message).join('；'));
    this.name = 'FinanceRunwayValidationError';
    this.issues = issues;
  }
}
function fail(path: string, message: string): never { throw new FinanceRunwayValidationError([{ path, message }]); }

/** Complete replacement; no default monthly expense or coverage target is inferred. */
export function parseFinanceRunwayInput(input: unknown, currency: CurrencyCode): FinanceRunwayInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return fail('$', '请提交完整的应急月数设置。');
  const raw = input as Record<string, unknown>;
  const allowed = ['monthlyExpenseAmount', 'targetMonths', 'accountIds'];
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new FinanceRunwayValidationError(unknown.map((path) => ({ path, message: '此字段不受支持。' })));
  let monthlyExpenseMinor: string;
  try { monthlyExpenseMinor = parseMoney(raw.monthlyExpenseAmount, currency, 'monthlyExpenseAmount'); }
  catch (error) {
    if (error instanceof FinanceValidationError) throw new FinanceRunwayValidationError(error.issues);
    throw error;
  }
  if (BigInt(monthlyExpenseMinor) <= BigInt(0)) return fail('monthlyExpenseAmount', '每月必要开支需大于 0。');
  if (typeof raw.targetMonths !== 'number' || !Number.isSafeInteger(raw.targetMonths) || raw.targetMonths <= 0) return fail('targetMonths', '目标月数需为大于 0 的安全整数。');
  if (!Array.isArray(raw.accountIds) || raw.accountIds.length === 0) return fail('accountIds', '请至少选择一个资产账户。');
  const ids = new Set<string>();
  for (const id of raw.accountIds) {
    if (typeof id !== 'string' || id.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return fail('accountIds', '账户标识不正确，请重新选择。');
    ids.add(id.toLowerCase());
  }
  return { monthlyExpenseMinor, targetMonths: raw.targetMonths, accountIds: [...ids].sort() };
}

/** Decimal display is truncated; whole-month quotient and remainder retain the exact ratio. */
export function buildFinanceRunwayView(settings: FinanceRunwaySettings | null, accounts: readonly FinanceRunwayAccount[]): FinanceRunwayView {
  if (!settings) return { settings: null, progress: null };
  const linked = new Set(settings.accountIds);
  const matched = new Map(accounts.filter((account) => linked.has(account.id) && account.ledger === settings.ledger
    && account.currency === settings.currency && account.archivedAt === null
    && Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type as AccountType].side === 'asset')
    .map((account) => [account.id, account]));
  let current = BigInt(0);
  for (const account of matched.values()) current += BigInt(account.balanceMinor);
  const expense = BigInt(settings.monthlyExpenseMinor);
  const target = expense * BigInt(settings.targetMonths);
  const gap = current >= target ? BigInt(0) : target - current;
  const scaled = (current * BigInt(100) / expense).toString().padStart(3, '0');
  const dates = [...matched.values()].map((account) => account.asOfDate).sort();
  return {
    settings: {
      monthlyExpenseMinor: settings.monthlyExpenseMinor, monthlyExpenseAmount: decimalFromMinor(settings.monthlyExpenseMinor, settings.currency),
      targetMonths: settings.targetMonths, accountIds: [...settings.accountIds], createdAt: settings.createdAt, updatedAt: settings.updatedAt,
    },
    progress: {
      currentMinor: current.toString(), runwayMonths: scaled.slice(0, -2) + '.' + scaled.slice(-2),
      runwayWholeMonths: (current / expense).toString(), runwayRemainderMinor: (current % expense).toString(),
      targetMinor: target.toString(), gapMinor: gap.toString(),
      percent: current >= target ? 100 : Number(current * BigInt(10000) / target) / 100,
      missingCount: linked.size - matched.size, matchedAccountCount: matched.size,
      oldestBalanceDate: dates[0] ?? null, latestBalanceDate: dates.at(-1) ?? null,
      status: current >= target ? 'covered' : 'short',
    },
  };
}
