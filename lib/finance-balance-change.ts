import { FinanceValidationError, parseBalanceEntry, type CurrencyCode } from './finance.ts';

export interface FinanceBalanceChangeInput {
  action: 'correct' | 'void'; expectedRevision: number; expectedAccountRevision: number; reason: string;
  amountMinor: string | null; asOfDate: string | null; note: string | null;
}

export function validBalanceEntryId(id: string) {
  const value = id.startsWith('initial:') ? id.slice(8) : id;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseFinanceBalanceChange(input: unknown, currency: CurrencyCode, today?: string): FinanceBalanceChangeInput {
  const fail = (path: string, message: string): never => { throw new FinanceValidationError([{ path, message }]); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('$', '请填写更正或作废内容。');
  const raw = input as Record<string, unknown>;
  if (raw.action !== 'correct' && raw.action !== 'void') return fail('action', '请选择更正或作废。');
  const allowed = raw.action === 'correct' ? ['action', 'expectedRevision', 'expectedAccountRevision', 'reason', 'amount', 'asOfDate', 'note'] : ['action', 'expectedRevision', 'expectedAccountRevision', 'reason'];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return fail('$', '更正内容包含不支持的字段。');
  if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0) return fail('expectedRevision', '请重新读取这条余额记录。');
  if (!Number.isSafeInteger(raw.expectedAccountRevision) || Number(raw.expectedAccountRevision) < 0) return fail('expectedAccountRevision', '请重新读取账户余额后再预览。');
  if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.trim().length > 300 || /[\u0000-\u001f\u007f]/.test(raw.reason)) return fail('reason', '请填写 1–300 字的更正或作废原因。');
  const base = { action: raw.action as 'correct' | 'void', expectedRevision: Number(raw.expectedRevision), expectedAccountRevision: Number(raw.expectedAccountRevision), reason: raw.reason.trim() };
  if (raw.action === 'void') return { ...base, amountMinor: null, asOfDate: null, note: null };
  const entry = parseBalanceEntry({ amount: raw.amount, asOfDate: raw.asOfDate, note: raw.note }, currency, { today });
  return { ...base, amountMinor: entry.amountMinor, asOfDate: entry.asOfDate, note: entry.note };
}
