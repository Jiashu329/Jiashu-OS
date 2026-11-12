import { ACCOUNT_TYPES, accountLiquidity, decimalFromMinor, FinanceValidationError, parseMoney, todayShanghai } from './finance.ts';
import type { AccountType, CurrencyCode, FinanceIssue, LedgerKind } from './finance.ts';
import type { FinanceGoalAccount } from './finance-goals.ts';

export type FinanceRunwayAccount = FinanceGoalAccount & { liquidityKind?: string; usableBps?: number };
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
  revision: number;
}
export interface FinanceRunwayProgress {
  currentMinor: string; nominalMinor: string; excludedMinor: string; unreviewedMinor: string;
  unreviewedAccountCount: number; usableAccountCount: number; staleAccountCount: number;
  accounts: Array<{ accountId: string; nominalMinor: string; usableMinor: string; liquidityKind: string; usableBps: number; stale: boolean }>;

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
  settings: (FinanceRunwayInput & { monthlyExpenseAmount: string; createdAt: string; updatedAt: string; revision: number }) | null;
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

export function parseFinanceRunwayCommand(input: unknown, currency: CurrencyCode): { input: FinanceRunwayInput; expectedRevision: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('$', '请提交完整的应急设置和读取版本。');
  const { expectedRevision, ...value } = input as Record<string, unknown>;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) return fail('expectedRevision', '请先读取当前应急设置，再保存修改。');
  return { input: parseFinanceRunwayInput(value, currency), expectedRevision: Number(expectedRevision) };
}

/** Decimal display is truncated; whole-month quotient and remainder retain the exact ratio. */
export function buildFinanceRunwayView(settings: FinanceRunwaySettings | null, accounts: readonly FinanceRunwayAccount[], today = todayShanghai()): FinanceRunwayView {
  if (!settings) return { settings: null, progress: null };
  const linked = new Set(settings.accountIds);
  const matched = new Map(accounts.filter((account) => linked.has(account.id) && account.ledger === settings.ledger
    && account.currency === settings.currency && account.archivedAt === null
    && Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type as AccountType].side === 'asset')
    .map((account) => [account.id, account]));
  const cutoff = new Date(Date.parse(today+'T12:00:00Z')-30*86400000).toISOString().slice(0,10);
  const liquidityAccounts = [...matched.values()].map((account) => {
    const liquidity=accountLiquidity(account),nominal=BigInt(account.balanceMinor);
    return {accountId:account.id,nominalMinor:account.balanceMinor,usableMinor:(nominal*BigInt(liquidity.usableBps)/BigInt(10000)).toString(),...liquidity,stale:account.asOfDate<cutoff};
  });
  const current=liquidityAccounts.reduce((sum,account)=>sum+BigInt(account.usableMinor),BigInt(0));
  const nominal=liquidityAccounts.reduce((sum,account)=>sum+BigInt(account.nominalMinor),BigInt(0));
  const unreviewed=liquidityAccounts.filter((account)=>account.liquidityKind==='unreviewed');
  const expense = BigInt(settings.monthlyExpenseMinor);
  const target = expense * BigInt(settings.targetMonths);
  const gap = current >= target ? BigInt(0) : target - current;
  const scaled = (current * BigInt(100) / expense).toString().padStart(3, '0');
  const dates = [...matched.values()].map((account) => account.asOfDate).sort();
  return {
    settings: {
      monthlyExpenseMinor: settings.monthlyExpenseMinor, monthlyExpenseAmount: decimalFromMinor(settings.monthlyExpenseMinor, settings.currency),
      targetMonths: settings.targetMonths, accountIds: [...settings.accountIds], createdAt: settings.createdAt, updatedAt: settings.updatedAt, revision: settings.revision,
    },
    progress: {
      currentMinor: current.toString(),nominalMinor:nominal.toString(),excludedMinor:(nominal-current).toString(),unreviewedMinor:unreviewed.reduce((sum,account)=>sum+BigInt(account.nominalMinor),BigInt(0)).toString(),
      unreviewedAccountCount:unreviewed.length,usableAccountCount:liquidityAccounts.filter((account)=>account.usableBps>0).length,staleAccountCount:liquidityAccounts.filter((account)=>account.stale).length,accounts:liquidityAccounts, runwayMonths: scaled.slice(0, -2) + '.' + scaled.slice(-2),
      runwayWholeMonths: (current / expense).toString(), runwayRemainderMinor: (current % expense).toString(),
      targetMinor: target.toString(), gapMinor: gap.toString(),
      percent: current >= target ? 100 : Number(current * BigInt(10000) / target) / 100,
      missingCount: linked.size - matched.size, matchedAccountCount: matched.size,
      oldestBalanceDate: dates[0] ?? null, latestBalanceDate: dates.at(-1) ?? null,
      status: current >= target ? 'covered' : 'short',
    },
  };
}
