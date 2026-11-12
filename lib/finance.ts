/** Exact money and validation rules for the two independent personal ledgers. */
export const LEDGERS = {
  personal: { label: '个人账本' },
  family: { label: '家庭账本' },
} as const;

export const CURRENCIES = {
  CNY: { label: '人民币', symbol: '¥', decimals: 2 },
  HKD: { label: '港币', symbol: 'HK$', decimals: 2 },
  USD: { label: '美元', symbol: '$', decimals: 2 },
  EUR: { label: '欧元', symbol: '€', decimals: 2 },
  GBP: { label: '英镑', symbol: '£', decimals: 2 },
  SGD: { label: '新加坡元', symbol: 'S$', decimals: 2 },
  AUD: { label: '澳元', symbol: 'A$', decimals: 2 },
  CAD: { label: '加元', symbol: 'C$', decimals: 2 },
  JPY: { label: '日元', symbol: '¥', decimals: 0 },
} as const;

export const ACCOUNT_TYPES = {
  cash: { label: '现金', side: 'asset' },
  bank: { label: '银行存款', side: 'asset' },
  investment: { label: '投资', side: 'asset' },
  property: { label: '房产', side: 'asset' },
  receivable: { label: '应收款', side: 'asset' },
  other_asset: { label: '其他资产', side: 'asset' },
  credit_card: { label: '信用卡欠款', side: 'liability' },
  loan: { label: '贷款', side: 'liability' },
  other_liability: { label: '其他负债', side: 'liability' },
} as const;

export const LIQUIDITY_KINDS = { liquid: '可随时动用', restricted: '部分可动用', illiquid: '暂不可动用', unreviewed: '尚未核对' } as const;
export type LiquidityKind = keyof typeof LIQUIDITY_KINDS;
export function defaultAccountLiquidity(type: string): { liquidityKind: LiquidityKind; usableBps: number } {
  if (type === 'cash' || type === 'bank') return { liquidityKind: 'liquid', usableBps: 10000 };
  if (type === 'property' || ['credit_card', 'loan', 'other_liability'].includes(type)) return { liquidityKind: 'illiquid', usableBps: 0 };
  return { liquidityKind: 'unreviewed', usableBps: 0 };
}
export function accountLiquidity(account: { type: string; liquidityKind?: string; usableBps?: number }) {
  const fallback = defaultAccountLiquidity(account.type);
  const kind = account.liquidityKind ?? fallback.liquidityKind;
  const bps = account.usableBps ?? fallback.usableBps;
  if (!Object.hasOwn(LIQUIDITY_KINDS, kind) || !Number.isSafeInteger(bps) || bps < 0 || bps > 10000 || (['illiquid', 'unreviewed'].includes(kind) && bps !== 0)) return { liquidityKind: 'unreviewed' as LiquidityKind, usableBps: 0 };
  return { liquidityKind: kind as LiquidityKind, usableBps: bps };
}

export type LedgerKind = keyof typeof LEDGERS;
export type CurrencyCode = keyof typeof CURRENCIES;
export type AccountType = keyof typeof ACCOUNT_TYPES;
export interface FinanceIssue { path: string; message: string }

export class FinanceValidationError extends Error {
  readonly status = 400;
  readonly code = 'INVALID_FINANCE_DATA';
  readonly issues: FinanceIssue[];
  constructor(issues: FinanceIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('；'));
    this.name = 'FinanceValidationError';
    this.issues = issues;
  }
}

const MAX_MINOR = BigInt('999999999999999999');
const ZERO = BigInt(0);

function fail(path: string, message: string): never {
  throw new FinanceValidationError([{ path, message }]);
}

function object(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
}

function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!object(input)) return fail('$', '请输入完整的账本数据。');
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new FinanceValidationError(unknown.map((path) => ({ path, message: '此字段不能修改或不受支持。' })));
  return input;
}

export function parseLedger(input: unknown): LedgerKind {
  if (typeof input !== 'string' || !Object.hasOwn(LEDGERS, input)) return fail('ledger', '请选择个人账本或家庭账本。');
  return input as LedgerKind;
}

export function parseCurrency(input: unknown): CurrencyCode {
  if (typeof input !== 'string' || !Object.hasOwn(CURRENCIES, input)) return fail('currency', '请选择支持的账户币种。');
  return input as CurrencyCode;
}

export function parseAccountType(input: unknown): AccountType {
  if (typeof input !== 'string' || !Object.hasOwn(ACCOUNT_TYPES, input)) return fail('type', '请选择账户的资产或负债类型。');
  return input as AccountType;
}

/** All public inputs are decimal strings; no financial value passes through Number. */
export function parseMoney(input: unknown, currencyInput: CurrencyCode | string, path = 'amount'): string {
  const currency = parseCurrency(currencyInput);
  const decimals = CURRENCIES[currency].decimals;
  if (typeof input !== 'string' || !input.trim()) return fail(path, '请输入金额，负债也填写正数金额。');
  if (input.length > 128 || /[\u0000-\u001f\u007f]/.test(input)) return fail(path, '金额格式不正确，请使用普通数字。');
  const value = input.trim();
  const pieces = value.split('.');
  if (pieces.length > 2) return fail(path, '金额格式不正确，请使用普通十进制数字。');
  const whole = pieces[0];
  const fraction = pieces[1];
  const grouped = /^\d{1,3}([,，\u00a0\u202f ])\d{3}(?:\1\d{3})*$/;
  if (!/^\d+$/.test(whole) && !grouped.test(whole)) return fail(path, '金额需为非负数字；千位分组应完整且使用同一种分隔符。');
  if (fraction !== undefined && (decimals === 0 || !/^\d+$/.test(fraction) || fraction.length > decimals)) {
    return fail(path, decimals === 0 ? `${currency} 金额不填写小数。` : `${currency} 金额最多保留 ${decimals} 位小数。`);
  }
  const digits = whole.replace(/[,，\u00a0\u202f ]/g, '') + (fraction ?? '').padEnd(decimals, '0');
  const minor = BigInt(digits);
  if (minor > MAX_MINOR) return fail(path, '单个账户金额过大，最多支持 18 位最小货币单位。');
  return minor.toString();
}

function minorValue(input: string | bigint): bigint {
  if (typeof input === 'bigint') return input;
  if (typeof input !== 'string' || input.length > 128 || input !== input.trim() || !/^-?\d+$/.test(input)) return fail('amountMinor', '已保存的金额格式不正确。');
  return BigInt(input);
}

export function decimalFromMinor(input: string | bigint, currencyInput: CurrencyCode | string): string {
  const currency = parseCurrency(currencyInput);
  const decimals = CURRENCIES[currency].decimals;
  const minor = minorValue(input);
  const negative = minor < ZERO;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const decimal = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
  return (negative ? '-' : '') + decimal;
}

/** Currency codes deliberately disambiguate CNY/JPY and the dollar currencies. */
export function formatMoney(input: string | bigint, currencyInput: CurrencyCode | string): string {
  const currency = parseCurrency(currencyInput);
  const decimal = decimalFromMinor(input, currency);
  const negative = decimal.startsWith('-');
  const pieces = (negative ? decimal.slice(1) : decimal).split('.');
  const grouped = pieces[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${negative ? '-' : ''}${grouped}${pieces.length > 1 ? '.' + pieces[1] : ''}`;
}

export function todayShanghai(date: Date | number = Date.now()): string {
  const input = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(input.getTime())) return fail('today', '当前日期无效。');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(input);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function calendarDay(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return fail(path, '日期请使用 YYYY-MM-DD 格式。');
  const [year, month, day] = input.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return fail(path, '日期不是有效的日历日期。');
  }
  return input;
}

export function parseAsOfDate(input: unknown, today = todayShanghai()): string {
  const day = calendarDay(input, 'asOfDate');
  const maximum = calendarDay(today, 'today');
  if (day > maximum) return fail('asOfDate', '余额记录日期不能晚于今天。');
  return day;
}

function text(input: unknown, path: string, maximum: number, optional = false): string {
  if (input === undefined && optional) return '';
  if (typeof input !== 'string') return fail(path, path === 'name' ? '请输入账户名称。' : '备注请使用文字。');
  const invalidControls = path === 'note' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (invalidControls.test(input)) return fail(path, '文字中包含不支持的控制字符。');
  const result = input.trim();
  if ((!optional && !result) || result.length > maximum) return fail(path, path === 'name' ? `账户名称需为 1–${maximum} 个字符。` : `备注最多 ${maximum} 个字符。`);
  return result;
}

export interface CreateAccountInput {
  ledger: LedgerKind;
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  amount: string;
  amountMinor: string;
  asOfDate: string;
  note: string;
}

export function parseCreateAccount(input: unknown, options: { today?: string } = {}): CreateAccountInput {
  const raw = fields(input, ['ledger', 'name', 'type', 'currency', 'amount', 'asOfDate', 'note']);
  const currency = parseCurrency(raw.currency);
  const amountMinor = parseMoney(raw.amount, currency);
  return {
    ledger: parseLedger(raw.ledger),
    name: text(raw.name, 'name', 60),
    type: parseAccountType(raw.type),
    currency,
    amount: decimalFromMinor(amountMinor, currency),
    amountMinor,
    asOfDate: parseAsOfDate(raw.asOfDate, options.today),
    note: text(raw.note, 'note', 500, true),
  };
}

export interface AccountPatch { name?: string; type?: AccountType; note?: string; archived?: boolean; liquidityKind?: LiquidityKind; usableBps?: number }

export function parseAccountPatch(input: unknown): AccountPatch {
  const raw = fields(input, ['name', 'type', 'note', 'archived', 'liquidityKind', 'usableBps']);
  if (!Object.keys(raw).length) return fail('$', '请至少修改一个账户字段。');
  const patch: AccountPatch = {};
  if (Object.hasOwn(raw, 'name')) patch.name = text(raw.name, 'name', 60);
  if (Object.hasOwn(raw, 'type')) patch.type = parseAccountType(raw.type);
  if (Object.hasOwn(raw, 'note')) patch.note = text(raw.note, 'note', 500, true);
  if (Object.hasOwn(raw, 'archived')) {
    if (typeof raw.archived !== 'boolean') return fail('archived', '归档状态需为是或否。');
    patch.archived = raw.archived;
  }
  if (Object.hasOwn(raw, 'liquidityKind') || Object.hasOwn(raw, 'usableBps')) {
    if (typeof raw.liquidityKind !== 'string' || !Object.hasOwn(LIQUIDITY_KINDS, raw.liquidityKind)) return fail('liquidityKind', '请选择资金可动用程度。');
    if (!Number.isSafeInteger(raw.usableBps) || Number(raw.usableBps) < 0 || Number(raw.usableBps) > 10000) return fail('usableBps', '可动用比例需为0至100%，最多两位小数。');
    if (['illiquid', 'unreviewed'].includes(raw.liquidityKind) && raw.usableBps !== 0) return fail('usableBps', '未核对或暂不可动用的账户比例需为0。');
    patch.liquidityKind = raw.liquidityKind as LiquidityKind; patch.usableBps = raw.usableBps as number;
  }
  return patch;
}

export const parseAccountUpdate = parseAccountPatch;

export interface AccountPatchCommand extends AccountPatch { expectedRevision: number }
/** Writes require the version the editor actually read; bare patch parsing is also used by backup validation. */
export function parseAccountPatchCommand(input: unknown): AccountPatchCommand {
  const raw = fields(input, ['name', 'type', 'note', 'archived', 'liquidityKind', 'usableBps', 'expectedRevision']);
  if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1) return fail('expectedRevision', '请先读取最新账户版本，再保存修改。');
  const { expectedRevision, ...patch } = raw;
  return { ...parseAccountPatch(patch), expectedRevision: expectedRevision as number };
}

export interface BalanceEntryInput { amount: string; amountMinor: string; asOfDate: string; note: string }

export function parseBalanceEntry(input: unknown, currency: CurrencyCode | string, options: { today?: string } = {}): BalanceEntryInput {
  const raw = fields(input, ['amount', 'asOfDate', 'note']);
  const code = parseCurrency(currency);
  const amountMinor = parseMoney(raw.amount, code);
  return { amountMinor, amount: decimalFromMinor(amountMinor, code), asOfDate: parseAsOfDate(raw.asOfDate, options.today), note: text(raw.note, 'note', 500, true) };
}

export interface FinanceSummaryAccount {
  id?: string;
  ledger: LedgerKind;
  type: AccountType;
  currency: CurrencyCode;
  balanceMinor: string;
  archived?: boolean;
}

export interface FinanceCurrencySummary {
  currency: CurrencyCode;
  accountCount: number;
  assetCount: number;
  liabilityCount: number;
  assetsMinor: string;
  liabilitiesMinor: string;
  netMinor: string;
  assetsAmount: string;
  liabilitiesAmount: string;
  netAmount: string;
  assetsFormatted: string;
  liabilitiesFormatted: string;
  netFormatted: string;
}

export interface FinanceSummary {
  ledger: LedgerKind;
  accountCount: number;
  currencies: FinanceCurrencySummary[];
  byCurrency: Partial<Record<CurrencyCode, FinanceCurrencySummary>>;
}

export function summarizeAccounts(accounts: readonly FinanceSummaryAccount[], ledgerInput: LedgerKind | string): FinanceSummary {
  const ledger = parseLedger(ledgerInput);
  const totals = new Map<CurrencyCode, { assets: bigint; liabilities: bigint; accountCount: number; assetCount: number; liabilityCount: number }>();
  const ids = new Set<string>();
  let accountCount = 0;
  for (const [position, account] of accounts.entries()) {
    if (parseLedger(account.ledger) !== ledger || account.archived === true) continue;
    if (account.archived !== undefined && typeof account.archived !== 'boolean') return fail(`accounts[${position}].archived`, '账户归档状态不正确。');
    if (account.id !== undefined) {
      if (ids.has(account.id)) return fail(`accounts[${position}].id`, '账户重复，请检查账户记录后再汇总。');
      ids.add(account.id);
    }
    const currency = parseCurrency(account.currency);
    const type = parseAccountType(account.type);
    const amount = minorValue(account.balanceMinor);
    if (amount < ZERO || amount > MAX_MINOR) return fail(`accounts[${position}].balanceMinor`, '账户余额需为有效的非负金额。');
    const value = totals.get(currency) ?? { assets: ZERO, liabilities: ZERO, accountCount: 0, assetCount: 0, liabilityCount: 0 };
    if (ACCOUNT_TYPES[type].side === 'asset') { value.assets += amount; value.assetCount++; }
    else { value.liabilities += amount; value.liabilityCount++; }
    value.accountCount++;
    totals.set(currency, value);
    accountCount++;
  }
  const currencies: FinanceCurrencySummary[] = [];
  const byCurrency: FinanceSummary['byCurrency'] = {};
  for (const currency of Object.keys(CURRENCIES) as CurrencyCode[]) {
    const value = totals.get(currency);
    if (!value) continue;
    const net = value.assets - value.liabilities;
    const summary: FinanceCurrencySummary = {
      currency, accountCount: value.accountCount, assetCount: value.assetCount, liabilityCount: value.liabilityCount,
      assetsMinor: value.assets.toString(), liabilitiesMinor: value.liabilities.toString(), netMinor: net.toString(),
      assetsAmount: decimalFromMinor(value.assets, currency), liabilitiesAmount: decimalFromMinor(value.liabilities, currency), netAmount: decimalFromMinor(net, currency),
      assetsFormatted: formatMoney(value.assets, currency), liabilitiesFormatted: formatMoney(value.liabilities, currency), netFormatted: formatMoney(net, currency),
    };
    currencies.push(summary);
    byCurrency[currency] = summary;
  }
  return { ledger, accountCount, currencies, byCurrency };
}

export const buildFinanceSummary = summarizeAccounts;

export interface BalanceEntryOrder { asOfDate: string; createdAt: string; id: string }

/** Ascending order: an older backdated record never replaces a newer balance. */
export function compareBalanceEntries(left: BalanceEntryOrder, right: BalanceEntryOrder): number {
  const leftDay = calendarDay(left.asOfDate, 'asOfDate');
  const rightDay = calendarDay(right.asOfDate, 'asOfDate');
  if (leftDay !== rightDay) return leftDay < rightDay ? -1 : 1;
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return fail('createdAt', '余额记录时间不正确。');
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

export function latestBalanceEntry<T extends BalanceEntryOrder>(entries: readonly T[]): T | null {
  let latest: T | null = null;
  for (const entry of entries) {
    compareBalanceEntries(entry, entry);
    if (!latest || compareBalanceEntries(latest, entry) < 0) latest = entry;
  }
  return latest;
}
