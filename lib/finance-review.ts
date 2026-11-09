import { ACCOUNT_TYPES, FinanceValidationError, parseCurrency, parseLedger, todayShanghai } from './finance.ts';
import type { AccountType, CurrencyCode, LedgerKind } from './finance.ts';

export interface ReviewAccountRow {
  accountId: string;
  name: string;
  type: AccountType;
  ledger: LedgerKind;
  currency: CurrencyCode;
  archivedAt: string | null;
}
export interface ReviewBalanceRow {
  accountId: string;
  amountMinor: string;
  asOfDate: string;
  sequence: number;
}
export interface ReviewSelection {
  ledger: LedgerKind;
  currency: CurrencyCode;
  month: string;
  previousMonth: string;
  cutoffDay: string;
  previousCutoffDay: string;
  today: string;
}
export interface ReviewSnapshot {
  assetsMinor: string | null;
  liabilitiesMinor: string | null;
  netMinor: string | null;
  accountCount: number;
  oldestBalanceDate: string | null;
  latestBalanceDate: string | null;
  carriedAccountCount: number;
}
export interface ReviewAccountChange {
  accountId: string;
  name: string;
  type: AccountType;
  side: 'asset' | 'liability';
  kind: 'new' | 'existing';
  previousMinor: string | null;
  currentMinor: string;
  netChangeMinor: string | null;
  currentAsOfDate: string;
  previousAsOfDate: string | null;
  carried: boolean;
}
export interface FinanceReview extends ReviewSelection {
  availableCurrencies: string[];
  snapshot: ReviewSnapshot;
  previous: ReviewSnapshot;
  change: {
    assetsMinor: string | null;
    liabilitiesMinor: string | null;
    netMinor: string | null;
    comparableNetMinor: string | null;
    newNetMinor: string | null;
  };
  trend: Array<ReviewSnapshot & { month: string; cutoffDay: string }>;
  accounts: ReviewAccountChange[];
}

function monthIndex(month: string) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthFromIndex(index: number) {
  return String(Math.floor(index / 12)).padStart(4, '0') + '-' + String(index % 12 + 1).padStart(2, '0');
}

function monthEnd(month: string) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
}

export function parseFinanceReviewQuery(params: URLSearchParams, now: Date | number = Date.now()): ReviewSelection {
  const ledger = parseLedger(params.get('ledger') ?? 'personal');
  const currency = parseCurrency(params.get('currency') ?? 'CNY');
  const today = todayShanghai(now);
  const month = params.get('month') ?? today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1970-01' || month > today.slice(0, 7)) {
    throw new FinanceValidationError([{ path: 'month', message: '月份请使用 YYYY-MM，且需在 1970 年 1 月至当前月份之间。' }]);
  }
  const previousMonth = monthFromIndex(monthIndex(month) - 1);
  return {
    ledger, currency, month, previousMonth, today,
    cutoffDay: month === today.slice(0, 7) ? today : monthEnd(month),
    previousCutoffDay: monthEnd(previousMonth),
  };
}

function amount(input: string): bigint {
  if (typeof input !== 'string' || !/^\d{1,128}$/.test(input)) {
    throw new FinanceValidationError([{ path: 'amountMinor', message: '已保存的余额格式不正确。' }]);
  }
  return BigInt(input);
}

function signed(value: string, side: 'asset' | 'liability') {
  const minor = amount(value);
  return side === 'asset' ? minor : -minor;
}

function balancesAt(balances: readonly ReviewBalanceRow[], accountIds: ReadonlySet<string>, cutoff: string) {
  const latest = new Map<string, ReviewBalanceRow>();
  for (const row of balances) {
    if (!accountIds.has(row.accountId) || row.asOfDate > cutoff) continue;
    const previous = latest.get(row.accountId);
    if (!previous || row.asOfDate > previous.asOfDate || (row.asOfDate === previous.asOfDate && row.sequence > previous.sequence)) {
      latest.set(row.accountId, row);
    }
  }
  return latest;
}

function summarize(accounts: readonly ReviewAccountRow[], balances: ReadonlyMap<string, ReviewBalanceRow>, month: string): ReviewSnapshot {
  let assets = BigInt(0);
  let liabilities = BigInt(0);
  let accountCount = 0;
  let carriedAccountCount = 0;
  let oldestBalanceDate: string | null = null;
  let latestBalanceDate: string | null = null;
  for (const account of accounts) {
    const balance = balances.get(account.accountId);
    if (!balance) continue;
    const value = amount(balance.amountMinor);
    if (ACCOUNT_TYPES[account.type].side === 'asset') assets += value;
    else liabilities += value;
    accountCount++;
    if (balance.asOfDate < month + '-01') carriedAccountCount++;
    if (oldestBalanceDate === null || balance.asOfDate < oldestBalanceDate) oldestBalanceDate = balance.asOfDate;
    if (latestBalanceDate === null || balance.asOfDate > latestBalanceDate) latestBalanceDate = balance.asOfDate;
  }
  return {
    assetsMinor: accountCount ? assets.toString() : null,
    liabilitiesMinor: accountCount ? liabilities.toString() : null,
    netMinor: accountCount ? (assets - liabilities).toString() : null,
    accountCount, oldestBalanceDate, latestBalanceDate, carriedAccountCount,
  };
}

/** Current account metadata is deliberately applied to each historical cutoff. */
export function buildFinanceReview(accounts: readonly ReviewAccountRow[], balances: readonly ReviewBalanceRow[], selection: ReviewSelection): FinanceReview {
  const active = accounts.filter((account) => account.ledger === selection.ledger && account.archivedAt === null);
  const selected = active.filter((account) => account.currency === selection.currency);
  const ids = new Set(selected.map((account) => account.accountId));
  const currentBalances = balancesAt(balances, ids, selection.cutoffDay);
  const previousBalances = balancesAt(balances, ids, selection.previousCutoffDay);
  const snapshot = summarize(selected, currentBalances, selection.month);
  const previous = summarize(selected, previousBalances, selection.previousMonth);
  const comparable = snapshot.accountCount > 0 && previous.accountCount > 0;
  let comparableNet = BigInt(0);
  let newNet = BigInt(0);
  const accountChanges: ReviewAccountChange[] = [];
  for (const account of selected) {
    const current = currentBalances.get(account.accountId);
    if (!current) continue;
    const prior = previousBalances.get(account.accountId);
    const side = ACCOUNT_TYPES[account.type].side;
    const currentSigned = signed(current.amountMinor, side);
    const netChange = prior ? currentSigned - signed(prior.amountMinor, side) : null;
    if (netChange === null) newNet += currentSigned;
    else comparableNet += netChange;
    accountChanges.push({
      accountId: account.accountId, name: account.name, type: account.type, side,
      kind: prior ? 'existing' : 'new', previousMinor: prior?.amountMinor ?? null,
      currentMinor: current.amountMinor, netChangeMinor: netChange?.toString() ?? null,
      currentAsOfDate: current.asOfDate, previousAsOfDate: prior?.asOfDate ?? null,
      carried: current.asOfDate < selection.month + '-01',
    });
  }
  accountChanges.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'existing' ? -1 : 1;
    if (a.kind === 'existing') {
      const aDelta = BigInt(a.netChangeMinor!);
      const bDelta = BigInt(b.netChangeMinor!);
      const aAbs = aDelta < BigInt(0) ? -aDelta : aDelta;
      const bAbs = bDelta < BigInt(0) ? -bDelta : bDelta;
      if (aAbs !== bAbs) return aAbs > bAbs ? -1 : 1;
    }
    const nameOrder = a.name.localeCompare(b.name, 'zh-CN');
    return nameOrder || (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
  });
  const endMonth = monthIndex(selection.month);
  const trend: FinanceReview['trend'] = [];
  for (let index = Math.max(monthIndex('1970-01'), endMonth - 11); index <= endMonth; index++) {
    const month = monthFromIndex(index);
    const cutoffDay = month === selection.today.slice(0, 7) ? selection.today : monthEnd(month);
    trend.push({ month, cutoffDay, ...summarize(selected, balancesAt(balances, ids, cutoffDay), month) });
  }
  const delta = (key: 'assetsMinor' | 'liabilitiesMinor' | 'netMinor') => comparable
    ? (BigInt(snapshot[key]!) - BigInt(previous[key]!)).toString() : null;
  return {
    ...selection, availableCurrencies: [...new Set(active.map((account) => account.currency))].sort(),
    snapshot, previous,
    change: {
      assetsMinor: delta('assetsMinor'), liabilitiesMinor: delta('liabilitiesMinor'), netMinor: delta('netMinor'),
      comparableNetMinor: comparable ? comparableNet.toString() : null,
      newNetMinor: snapshot.accountCount ? newNet.toString() : null,
    },
    trend, accounts: accountChanges,
  };
}
