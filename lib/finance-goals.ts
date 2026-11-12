import { ACCOUNT_TYPES, decimalFromMinor, FinanceValidationError, parseCurrency, parseLedger, parseMoney, todayShanghai } from './finance.ts';
import type { AccountType, CurrencyCode, FinanceIssue, LedgerKind } from './finance.ts';

export interface FinanceGoalCreate {
  ledger: LedgerKind;
  currency: CurrencyCode;
  name: string;
  targetMinor: string;
  deadline: string;
  accountIds: string[];
}
export interface FinanceGoalPatch {
  name?: string;
  targetMinor?: string;
  deadline?: string;
  accountIds?: string[];
  archived?: boolean;
}
export interface FinanceGoalPatchCommand extends FinanceGoalPatch { expectedRevision: number }
export interface FinanceGoalPlan extends FinanceGoalCreate {
  id: string;
  userId: string;
  creationHash: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  revision: number;
}
export interface FinanceGoalAccount {
  id: string;
  name: string;
  ledger: string;
  currency: string;
  type: string;
  balanceMinor: string;
  asOfDate: string;
  archivedAt: string | null;
}
export interface FinanceGoalView {
  id: string;
  ledger: LedgerKind;
  currency: CurrencyCode;
  name: string;
  targetMinor: string;
  targetAmount: string;
  deadline: string;
  accountIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archived: boolean;
  revision: number;
  currentMinor: string;
  gapMinor: string;
  percent: number;
  daysRemaining: number;
  monthsRemaining: number;
  monthlyMinor: string | null;
  missingCount: number;
  matchedAccountCount: number;
  missingAccountCount: number;
  archivedAccountCount: number;
  unavailableAccountCount: number;
  staleAccountCount: number;
  oldestBalanceDate: string | null;
  latestBalanceDate: string | null;
  balanceFreshnessDays: number;
  status: 'active' | 'achieved' | 'overdue';
}

export class FinanceGoalValidationError extends Error {
  readonly code = 'INVALID_FINANCE_GOAL';
  readonly issues: FinanceIssue[];
  constructor(issues: FinanceIssue[]) {
    super(issues.map((issue) => issue.message).join('；'));
    this.name = 'FinanceGoalValidationError';
    this.issues = issues;
  }
}

function fail(path: string, message: string): never { throw new FinanceGoalValidationError([{ path, message }]); }
function fields(input: unknown, allowed: readonly string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return fail('$', '请提交完整的财务目标。');
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new FinanceGoalValidationError(unknown.map((path) => ({ path, message: '此目标字段不能修改或不受支持。' })));
  return raw;
}
function name(input: unknown) {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > 60) return fail('name', '目标名称需为 1–60 个字符。');
  for (const character of input) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return fail('name', '目标名称包含不支持的控制字符。');
  return input.trim();
}
function target(input: unknown, currency: CurrencyCode) {
  let minor: string;
  try { minor = parseMoney(input, currency, 'targetAmount'); }
  catch (error) {
    if (error instanceof FinanceValidationError) throw new FinanceGoalValidationError(error.issues);
    throw error;
  }
  if (BigInt(minor) <= BigInt(0)) return fail('targetAmount', '目标金额需大于 0。');
  return minor;
}
function deadline(input: unknown) {
  if (typeof input !== 'string' || input.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return fail('deadline', '目标期限请使用 YYYY-MM-DD 格式。');
  const year = Number(input.slice(0, 4));
  const month = Number(input.slice(5, 7));
  const day = Number(input.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return fail('deadline', '目标期限需为 1970–2100 年之间的有效日期。');
  return input;
}
function accountIds(input: unknown) {
  if (!Array.isArray(input) || input.length === 0) return fail('accountIds', '请至少关联一个资产账户。');
  const ids = new Set<string>();
  for (const id of input) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return fail('accountIds', '关联账户标识不正确，请重新选择。');
    ids.add(id.toLowerCase());
  }
  return [...ids].sort();
}

export function parseFinanceGoalCreate(input: unknown): FinanceGoalCreate {
  const raw = fields(input, ['ledger', 'currency', 'name', 'targetAmount', 'deadline', 'accountIds']);
  const currency = parseCurrency(raw.currency);
  return { ledger: parseLedger(raw.ledger), currency, name: name(raw.name), targetMinor: target(raw.targetAmount, currency), deadline: deadline(raw.deadline), accountIds: accountIds(raw.accountIds) };
}

export function parseFinanceGoalPatch(input: unknown, currency: CurrencyCode): FinanceGoalPatch {
  const raw = fields(input, ['name', 'targetAmount', 'deadline', 'accountIds', 'archived']);
  if (!Object.keys(raw).length) return fail('$', '请至少修改一个目标字段。');
  const patch: FinanceGoalPatch = {};
  if (Object.hasOwn(raw, 'name')) patch.name = name(raw.name);
  if (Object.hasOwn(raw, 'targetAmount')) patch.targetMinor = target(raw.targetAmount, currency);
  if (Object.hasOwn(raw, 'deadline')) patch.deadline = deadline(raw.deadline);
  if (Object.hasOwn(raw, 'accountIds')) patch.accountIds = accountIds(raw.accountIds);
  if (Object.hasOwn(raw, 'archived')) {
    if (typeof raw.archived !== 'boolean') return fail('archived', '归档状态需为是或否。');
    patch.archived = raw.archived;
  }
  return patch;
}

export function parseFinanceGoalPatchCommand(input: unknown, currency: CurrencyCode): FinanceGoalPatchCommand {
  const raw = fields(input, ['name', 'targetAmount', 'deadline', 'accountIds', 'archived', 'expectedRevision']);
  if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1) return fail('expectedRevision', '请先读取最新目标版本，再保存修改。');
  const { expectedRevision, ...patch } = raw;
  return { ...parseFinanceGoalPatch(patch, currency), expectedRevision: expectedRevision as number };
}

/** Linked balances are a view of savings, never a reservation or a transfer. */
export function buildFinanceGoalView(plan: FinanceGoalPlan, accounts: readonly FinanceGoalAccount[], today = todayShanghai()): FinanceGoalView {
  const linked = new Set(plan.accountIds);
  const available = new Map(accounts.filter((account) => linked.has(account.id)).map((account) => [account.id, account]));
  const matched = new Map(accounts.filter((account) => linked.has(account.id)
    && account.ledger === plan.ledger && account.currency === plan.currency && account.archivedAt === null
    && Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type as AccountType].side === 'asset')
    .map((account) => [account.id, account]));
  let current = BigInt(0);
  for (const account of matched.values()) current += BigInt(account.balanceMinor);
  const target = BigInt(plan.targetMinor);
  const gap = current >= target ? BigInt(0) : target - current;
  const expired = plan.deadline < today;
  const months = expired ? 0 : (Number(plan.deadline.slice(0, 4)) - Number(today.slice(0, 4))) * 12
    + Number(plan.deadline.slice(5, 7)) - Number(today.slice(5, 7)) + 1;
  const days = Math.round((Date.parse(plan.deadline + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
  const percent = current >= target ? 100 : Number(current * BigInt(10000) / target) / 100;
  const monthly = gap === BigInt(0) ? '0' : expired ? null : ((gap + BigInt(months) - BigInt(1)) / BigInt(months)).toString();
  const balanceFreshnessDays = 30;
  const cutoff = new Date(Date.parse(today + 'T12:00:00Z') - balanceFreshnessDays * 86400000).toISOString().slice(0, 10);
  const dates = [...matched.values()].map((account) => account.asOfDate).sort();
  const archivedAccountCount = [...available.values()].filter((account) => account.archivedAt !== null).length;
  const missingAccountCount = linked.size - available.size;
  return {
    id: plan.id, ledger: plan.ledger, currency: plan.currency, name: plan.name,
    targetMinor: plan.targetMinor, targetAmount: decimalFromMinor(plan.targetMinor, plan.currency),
    deadline: plan.deadline, accountIds: [...plan.accountIds], createdAt: plan.createdAt, updatedAt: plan.updatedAt,
    archivedAt: plan.archivedAt, archived: plan.archivedAt !== null, revision: plan.revision,
    currentMinor: current.toString(), gapMinor: gap.toString(), percent,
    daysRemaining: Math.max(0, days), monthsRemaining: months, monthlyMinor: monthly,
    missingCount: linked.size - matched.size, matchedAccountCount: matched.size,
    missingAccountCount, archivedAccountCount,
    unavailableAccountCount: available.size - matched.size - archivedAccountCount,
    staleAccountCount: [...matched.values()].filter((account) => account.asOfDate < cutoff).length,
    oldestBalanceDate: dates[0] ?? null, latestBalanceDate: dates.at(-1) ?? null, balanceFreshnessDays,
    status: gap === BigInt(0) ? 'achieved' : expired ? 'overdue' : 'active',
  };
}
