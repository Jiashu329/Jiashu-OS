import { ACCOUNT_TYPES, CURRENCIES, LEDGERS, FinanceValidationError } from './finance.ts';
import { parseFinanceReviewQuery } from './finance-review.ts';
import type { FinanceReview, ReviewSelection } from './finance-review.ts';

export interface FinanceCloseInput {
  selection: ReviewSelection;
  expectedVersion: number;
  previewHash: string;
  reason: string;
}

function hasControl(value: string): boolean {
  for (const character of value) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true;
  return false;
}

export class FinanceCloseConflictError extends Error {
  readonly code = 'FINANCE_CLOSE_CONFLICT';
  constructor(message = '报表或月结版本已经变化，请重新读取未结报表再确认。') { super(message); this.name = 'FinanceCloseConflictError'; }
}

export function parseFinanceCloseInput(input: unknown, now: Date | number = Date.now()): FinanceCloseInput {
  const fail = (path: string, message: string): never => { throw new FinanceValidationError([{ path, message }]); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('$', '请提交完整的月结确认。');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['ledger', 'currency', 'month', 'expectedVersion', 'previewHash', 'reason'].includes(key))) return fail('$', '月结包含不支持的字段。');
  if (typeof raw.ledger !== 'string' || typeof raw.currency !== 'string' || typeof raw.month !== 'string') return fail('$', '请选择账本、币种和月份。');
  const selection = parseFinanceReviewQuery(new URLSearchParams({ ledger: raw.ledger, currency: raw.currency, month: raw.month }), now);
  if (selection.month >= selection.today.slice(0, 7)) return fail('month', '只能确认已经结束的月份；本月可先查看回顾。');
  if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 0) return fail('expectedVersion', '月结版本不正确，请重新读取报表。');
  if (typeof raw.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.previewHash)) return fail('previewHash', '请先读取未结报表，再确认月结。');
  if (raw.reason !== undefined && typeof raw.reason !== 'string') return fail('reason', '月结说明请使用文字。');
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length > 500 || hasControl(reason)) return fail('reason', '月结说明最多500个字符，不能包含控制字符。');
  if ((raw.expectedVersion as number) > 0 && !reason) return fail('reason', '重新月结需填写原因；此前版本会保留。');
  return { selection, expectedVersion: raw.expectedVersion as number, previewHash: raw.previewHash, reason };
}

export async function financeReviewHash(review: FinanceReview): Promise<string> {
  // An ended month's accounting is independent of the day on which it is viewed.
  const { today: _today, ...accounting } = review;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(accounting)));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

/** Validate durable/backup payloads before any immutable report is restored or rendered. */
export function parseStoredFinanceReview(input: unknown, scope?: { ledger: string; currency: string; month: string }): FinanceReview {
  const fail = (): never => { throw new FinanceValidationError([{ path: 'snapshot', message: '月结快照内容不完整或格式不正确。' }]); };
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !hasControl(value);
  const day = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '1969-12-01' && value <= '2100-12-31';
  };
  const month = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= '1969-12' && value <= '2100-12';
  const amount = (value: unknown, signed = true): value is string => typeof value === 'string' && (signed ? /^-?\d{1,128}$/ : /^\d{1,128}$/).test(value);
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  const snapshot = (value: unknown) => {
    if (!object(value) || !count(value.accountCount) || !count(value.carriedAccountCount) || value.carriedAccountCount > value.accountCount) return false;
    if (value.accountCount === 0) return value.assetsMinor === null && value.liabilitiesMinor === null && value.netMinor === null && value.oldestBalanceDate === null && value.latestBalanceDate === null;
    return amount(value.assetsMinor, false) && amount(value.liabilitiesMinor, false) && amount(value.netMinor)
      && BigInt(value.assetsMinor) - BigInt(value.liabilitiesMinor) === BigInt(value.netMinor)
      && day(value.oldestBalanceDate) && day(value.latestBalanceDate) && value.oldestBalanceDate <= value.latestBalanceDate;
  };
  if (!object(input) || typeof input.ledger !== 'string' || !Object.hasOwn(LEDGERS, input.ledger) || typeof input.currency !== 'string' || !Object.hasOwn(CURRENCIES, input.currency)
    || !month(input.month) || !month(input.previousMonth) || !day(input.today) || !day(input.cutoffDay) || !day(input.previousCutoffDay)
    || !snapshot(input.snapshot) || !snapshot(input.previous) || !object(input.change)) return fail();
  if (scope && (input.ledger !== scope.ledger || input.currency !== scope.currency || input.month !== scope.month)) return fail();
  const selection = parseFinanceReviewQuery(new URLSearchParams({ ledger: input.ledger, currency: input.currency, month: input.month }), new Date(input.today + 'T04:00:00Z'));
  if (input.previousMonth !== selection.previousMonth || input.cutoffDay !== selection.cutoffDay || input.previousCutoffDay !== selection.previousCutoffDay) return fail();
  for (const key of ['assetsMinor', 'liabilitiesMinor', 'netMinor', 'comparableNetMinor', 'newNetMinor']) if (input.change[key] !== null && !amount(input.change[key])) return fail();
  if (!Array.isArray(input.availableCurrencies) || input.availableCurrencies.some((value) => typeof value !== 'string' || !Object.hasOwn(CURRENCIES, value))) return fail();
  if (!Array.isArray(input.trend) || input.trend.length < 1 || input.trend.length > 12 || input.trend.some((row) => !object(row) || !month(row.month) || !day(row.cutoffDay) || !snapshot(row)) || input.trend.at(-1)?.month !== input.month) return fail();
  if (!Array.isArray(input.accounts) || input.accounts.length > 100000) return fail();
  const seen = new Set<string>();
  for (const row of input.accounts) {
    if (!object(row) || !text(row.accountId) || !text(row.name) || typeof row.type !== 'string' || !Object.hasOwn(ACCOUNT_TYPES, row.type)
      || (row.side !== 'asset' && row.side !== 'liability') || ACCOUNT_TYPES[row.type as keyof typeof ACCOUNT_TYPES].side !== row.side
      || !['new', 'existing'].includes(String(row.kind)) || !amount(row.currentMinor, false) || !day(row.currentAsOfDate) || typeof row.carried !== 'boolean') return fail();
    if (seen.has(row.accountId as string)) return fail();
    seen.add(row.accountId as string);
    if (row.kind === 'new' ? row.previousMinor !== null || row.previousAsOfDate !== null || row.netChangeMinor !== null
      : !amount(row.previousMinor, false) || !day(row.previousAsOfDate) || !amount(row.netChangeMinor)) return fail();
  }
  return input as unknown as FinanceReview;
}
