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
export interface AccountClassification {
  accountId: string; revision: number; effectiveFrom: string; type: AccountType;
  archived: number; origin: 'opening' | 'baseline' | 'change'; recordedAt: string;
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
  previousType?: AccountType; classificationChanged?: boolean; membershipChanged?: boolean; archived?: boolean;
  balanceChangeMinor?: string; classificationChangeMinor?: string; membershipChangeMinor?: string;
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
    reclassificationNetMinor: string | null; membershipNetMinor: string | null;
  };
  trend: Array<ReviewSnapshot & { month: string; cutoffDay: string }>;
  accounts: ReviewAccountChange[];
  historicalAssumptions: Array<{ accountId: string; name: string; knownFrom: string | null }>;
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

/** Classification is resolved at each cutoff, independently of the carried balance date. */
export function buildFinanceReview(accounts: readonly ReviewAccountRow[], balances: readonly ReviewBalanceRow[], selection: ReviewSelection, history: readonly AccountClassification[] = []): FinanceReview {
  const scoped = accounts.filter((account) => account.ledger === selection.ledger);
  const selected = scoped.filter((account) => account.currency === selection.currency);
  const ids = new Set(selected.map((account) => account.accountId));
  const byAccount = new Map<string, AccountClassification[]>();
  for (const row of history) { const rows = byAccount.get(row.accountId) ?? []; rows.push(row); byAccount.set(row.accountId, rows); }
  for (const rows of byAccount.values()) rows.sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.revision-b.revision);
  const classification = (account: ReviewAccountRow, cutoff: string) => {
    const row = byAccount.get(account.accountId)?.filter((row) => row.effectiveFrom <= cutoff).at(-1);
    return { ...account, type: row?.type ?? account.type, archivedAt: row ? row.archived ? row.recordedAt : null : account.archivedAt };
  };
  const eligible = (cutoff: string) => selected.map((account) => classification(account,cutoff)).filter((account) => account.archivedAt === null);
  const currentBalances = balancesAt(balances, ids, selection.cutoffDay);
  const previousBalances = balancesAt(balances, ids, selection.previousCutoffDay);
  const snapshotAt = (cutoff: string, month: string, values = balancesAt(balances,ids,cutoff)) => {
    const snapshot = summarize(eligible(cutoff),values,month);
    // An archived final account is a known empty book; no historical balances remains unknown.
    if (!snapshot.accountCount && values.size && history.length) return { ...snapshot, assetsMinor:'0',liabilitiesMinor:'0',netMinor:'0' };
    return snapshot;
  };
  const snapshot = snapshotAt(selection.cutoffDay,selection.month,currentBalances);
  const previous = snapshotAt(selection.previousCutoffDay,selection.previousMonth,previousBalances);
  const comparable = snapshot.netMinor !== null && previous.netMinor !== null;
  let comparableNet=BigInt(0),newNet=BigInt(0),reclassificationNet=BigInt(0),membershipNet=BigInt(0);
  const accountChanges: ReviewAccountChange[]=[];
  for (const account of selected) {
    const current=currentBalances.get(account.accountId),prior=previousBalances.get(account.accountId);
    if (!current) continue;
    const now=classification(account,selection.cutoffDay),before=classification(account,selection.previousCutoffDay);
    const active=now.archivedAt===null,wasActive=before.archivedAt===null;
    if ((!active&&!wasActive)||(!prior&&!active)) continue;
    const side=ACCOUNT_TYPES[now.type].side,previousSide=ACCOUNT_TYPES[before.type].side;
    const currentSigned=active?signed(current.amountMinor,side):BigInt(0),previousSigned=prior&&wasActive?signed(prior.amountMinor,previousSide):BigInt(0);
    const netChange=prior?currentSigned-previousSigned:null;
    let balanceChange=BigInt(0),classificationChange=BigInt(0),membershipChange=BigInt(0);
    if (!prior) newNet+=currentSigned;
    else if (active!==wasActive) { membershipChange=currentSigned-previousSigned; membershipNet+=membershipChange; }
    else { balanceChange=signed(current.amountMinor,previousSide)-signed(prior.amountMinor,previousSide);classificationChange=currentSigned-signed(current.amountMinor,previousSide);comparableNet+=balanceChange;reclassificationNet+=classificationChange; }
    accountChanges.push({accountId:account.accountId,name:account.name,type:now.type,side,kind:prior?'existing':'new',previousMinor:prior?.amountMinor??null,currentMinor:current.amountMinor,netChangeMinor:netChange?.toString()??null,currentAsOfDate:current.asOfDate,previousAsOfDate:prior?.asOfDate??null,carried:current.asOfDate<selection.month+'-01',
      previousType:before.type,classificationChanged:before.type!==now.type,membershipChanged:active!==wasActive,archived:!active,balanceChangeMinor:balanceChange.toString(),classificationChangeMinor:classificationChange.toString(),membershipChangeMinor:membershipChange.toString()});
  }
  accountChanges.sort((a,b)=>{if(a.kind!==b.kind)return a.kind==='existing'?-1:1;if(a.kind==='existing'){const x=BigInt(a.netChangeMinor!),y=BigInt(b.netChangeMinor!),ax=x<BigInt(0)?-x:x,ay=y<BigInt(0)?-y:y;if(ax!==ay)return ax>ay?-1:1;}return a.name.localeCompare(b.name,'zh-CN')||a.accountId.localeCompare(b.accountId);});
  const trend:FinanceReview['trend']=[],endMonth=monthIndex(selection.month);
  for(let index=Math.max(monthIndex('1970-01'),endMonth-11);index<=endMonth;index++){const month=monthFromIndex(index),cutoffDay=month===selection.today.slice(0,7)?selection.today:monthEnd(month);trend.push({month,cutoffDay,...snapshotAt(cutoffDay,month)});}
  const historicalAssumptions=selected.flatMap((account)=>{const baseline=byAccount.get(account.accountId)?.[0];const knownFrom=baseline?.recordedAt?todayShanghai(new Date(baseline.recordedAt)):null;return (!baseline&&balances.some((row)=>row.accountId===account.accountId&&row.asOfDate<=selection.cutoffDay)||baseline?.origin==='baseline'&&trend.some((point)=>point.cutoffDay<(knownFrom??'9999')&&balances.some((row)=>row.accountId===account.accountId&&row.asOfDate<=point.cutoffDay)))?[{accountId:account.accountId,name:account.name,knownFrom}]:[];}).sort((a,b)=>a.accountId.localeCompare(b.accountId));
  const delta=(key:'assetsMinor'|'liabilitiesMinor'|'netMinor')=>comparable?(BigInt(snapshot[key]!)-BigInt(previous[key]!)).toString():null;
  return {...selection,availableCurrencies:[...new Set(scoped.map((account)=>account.currency))].sort(),snapshot,previous,change:{assetsMinor:delta('assetsMinor'),liabilitiesMinor:delta('liabilitiesMinor'),netMinor:delta('netMinor'),comparableNetMinor:comparable?comparableNet.toString():null,newNetMinor:snapshot.netMinor!==null?newNet.toString():null,reclassificationNetMinor:comparable?reclassificationNet.toString():null,membershipNetMinor:comparable?membershipNet.toString():null},trend,accounts:accountChanges,historicalAssumptions};
}
