import { FinanceRunwayValidationError } from '../lib/finance-runway.ts';
import type { FinanceRunwayInput, FinanceRunwaySettings } from '../lib/finance-runway.ts';
import type { CurrencyCode, LedgerKind } from '../lib/finance.ts';

export type FinanceRunwayDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface SettingsRow {
  userId: string; ledger: LedgerKind; currency: CurrencyCode; monthlyExpenseMinor: string;
  targetMonths: number; accountIdsJson: string; createdAt: string; updatedAt: string; revision: number;
}
const columns = `user_id AS userId, ledger, currency, monthly_expense_minor AS monthlyExpenseMinor,
  target_months AS targetMonths, account_ids_json AS accountIdsJson, created_at AS createdAt, updated_at AS updatedAt, revision`;
const validAccounts = `SELECT COUNT(*) FROM finance_accounts WHERE user_id = ? AND ledger = ? AND currency = ?
  AND archived_at IS NULL AND type IN ('cash','bank','investment','property','receivable','other_asset')
  AND id IN (SELECT value FROM json_each(?))`;
function settings(row: SettingsRow): FinanceRunwaySettings {
  const { accountIdsJson, ...rest } = row;
  return { ...rest, accountIds: JSON.parse(accountIdsJson) as string[] };
}
function invalidAccounts(): never {
  throw new FinanceRunwayValidationError([{ path: 'accountIds', message: '首次设置或更换关联时，请选择你在同一账本、同一币种下的未归档资产账户。' }]);
}
export class FinanceRunwayConflictError extends Error {
  readonly code = 'FINANCE_RUNWAY_CONFLICT';
  constructor() { super('应急设置已在其他页面更新。你的填写已保留，请读取最新设置并核对后再保存。'); this.name = 'FinanceRunwayConflictError'; }
}

export async function readFinanceRunwaySettings(db: FinanceRunwayDatabase, userId: string, ledger: LedgerKind, currency: CurrencyCode): Promise<FinanceRunwaySettings | null> {
  const row = await db.prepare(`SELECT ${columns} FROM finance_runway_settings WHERE user_id = ? AND ledger = ? AND currency = ?`)
    .bind(userId, ledger, currency).first<SettingsRow>();
  return row ? settings(row) : null;
}

export async function writeFinanceRunwaySettings(db: FinanceRunwayDatabase, userId: string, ledger: LedgerKind, currency: CurrencyCode, input: FinanceRunwayInput, expectedRevision: number, now = new Date().toISOString()): Promise<FinanceRunwaySettings> {
  const existing = await readFinanceRunwaySettings(db, userId, ledger, currency);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (existing?.revision ?? 0) !== expectedRevision) throw new FinanceRunwayConflictError();
  const ids = JSON.stringify(input.accountIds);
  if (!existing || JSON.stringify(existing.accountIds) !== ids) {
    const count = await db.prepare(`SELECT (${validAccounts}) AS total`).bind(userId, ledger, currency, ids).first<{ total: number }>();
    if (count?.total !== input.accountIds.length) return invalidAccounts();
  }
  const result = await db.batch<SettingsRow>([
    db.prepare(`INSERT INTO finance_runway_settings
      (user_id, ledger, currency, monthly_expense_minor, target_months, account_ids_json, created_at, updated_at, revision)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1 WHERE ((${validAccounts}) = ? OR EXISTS (
        SELECT 1 FROM finance_runway_settings WHERE user_id = ? AND ledger = ? AND currency = ? AND account_ids_json = ? AND revision = ?
      )) AND (? = 0 OR EXISTS (SELECT 1 FROM finance_runway_settings WHERE user_id = ? AND ledger = ? AND currency = ? AND revision = ?))
      ON CONFLICT(user_id, ledger, currency) DO UPDATE SET
        monthly_expense_minor = excluded.monthly_expense_minor, target_months = excluded.target_months,
        account_ids_json = excluded.account_ids_json, updated_at = excluded.updated_at,
        revision = finance_runway_settings.revision + 1 WHERE finance_runway_settings.revision = ?`)
      .bind(userId, ledger, currency, input.monthlyExpenseMinor, input.targetMonths, ids, now, now,
        userId, ledger, currency, ids, input.accountIds.length, userId, ledger, currency, ids, expectedRevision,
        expectedRevision, userId, ledger, currency, expectedRevision, expectedRevision),
    db.prepare(`SELECT ${columns} FROM finance_runway_settings WHERE user_id = ? AND ledger = ? AND currency = ?`)
      .bind(userId, ledger, currency),
  ]);
  const row = result[1].results[0];
  if (result[0].meta.changes !== 1 || !row) {
    if ((row && row.revision !== expectedRevision) || (!row && existing)) throw new FinanceRunwayConflictError();
    return invalidAccounts();
  }
  return settings(row);
}
