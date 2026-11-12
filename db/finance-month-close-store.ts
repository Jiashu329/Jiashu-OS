import { FinanceCloseConflictError, parseStoredFinanceReview } from '../lib/finance-review-close.ts';
import type { FinanceReview } from '../lib/finance-review.ts';
import type { CurrencyCode, LedgerKind } from '../lib/finance.ts';

export type FinanceMonthCloseDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export interface FinanceMonthCloseScope { ledger: LedgerKind; currency: CurrencyCode; month: string }
export interface FinanceMonthCloseVersion { version: number; closedAt: string; reason: string }
export interface FinanceMonthClose extends FinanceMonthCloseScope, FinanceMonthCloseVersion {
  operationId: string; requestHash: string; report: FinanceReview;
}
interface StoredClose extends FinanceMonthCloseScope, FinanceMonthCloseVersion {
  operationId: string; requestHash: string; snapshotJson: string;
}
const columns = 'ledger, currency, month, version, operation_id AS operationId, request_hash AS requestHash, snapshot_json AS snapshotJson, reason, closed_at AS closedAt';
function present(row: StoredClose): FinanceMonthClose {
  const { snapshotJson, ...metadata } = row;
  const report = parseStoredFinanceReview(JSON.parse(snapshotJson), row);
  return { ...metadata, report };
}

export async function readFinanceMonthClose(db: FinanceMonthCloseDatabase, userId: string, scope: FinanceMonthCloseScope, version?: number): Promise<FinanceMonthClose | null> {
  const statement = db.prepare(`SELECT ${columns} FROM finance_month_closes WHERE user_id = ? AND ledger = ? AND currency = ? AND month = ?${version === undefined ? '' : ' AND version = ?'} ORDER BY version DESC LIMIT 1`);
  const values: (string | number)[] = [userId, scope.ledger, scope.currency, scope.month];
  if (version !== undefined) values.push(version);
  const row = await statement.bind(...values).first<StoredClose>();
  return row ? present(row) : null;
}

export async function listFinanceMonthCloseVersions(db: FinanceMonthCloseDatabase, userId: string, scope: FinanceMonthCloseScope): Promise<FinanceMonthCloseVersion[]> {
  const rows = await db.prepare(`SELECT version, reason, closed_at AS closedAt FROM finance_month_closes WHERE user_id = ? AND ledger = ? AND currency = ? AND month = ? ORDER BY version DESC`)
    .bind(userId, scope.ledger, scope.currency, scope.month).all<FinanceMonthCloseVersion>();
  return rows.results;
}

/** The selected report and version selector reflect a single database snapshot. */
export async function readFinanceMonthCloseBundle(db: FinanceMonthCloseDatabase, userId: string, scope: FinanceMonthCloseScope, version?: number): Promise<{ closed: FinanceMonthClose | null; versions: FinanceMonthCloseVersion[] }> {
  const values: (string | number)[] = [userId, scope.ledger, scope.currency, scope.month];
  if (version !== undefined) values.push(version);
  const results = await db.batch<StoredClose | FinanceMonthCloseVersion>([
    db.prepare(`SELECT ${columns} FROM finance_month_closes WHERE user_id = ? AND ledger = ? AND currency = ? AND month = ?${version === undefined ? '' : ' AND version = ?'} ORDER BY version DESC LIMIT 1`).bind(...values),
    db.prepare('SELECT version, reason, closed_at AS closedAt FROM finance_month_closes WHERE user_id = ? AND ledger = ? AND currency = ? AND month = ? ORDER BY version DESC')
      .bind(userId, scope.ledger, scope.currency, scope.month),
  ]);
  const selected = results[0].results[0] as StoredClose | undefined;
  return { closed: selected ? present(selected) : null, versions: results[1].results as FinanceMonthCloseVersion[] };
}

export async function readFinanceMonthCloseOperation(db: FinanceMonthCloseDatabase, userId: string, operationId: string): Promise<FinanceMonthClose | null> {
  const row = await db.prepare(`SELECT ${columns} FROM finance_month_closes WHERE user_id = ? AND operation_id = ?`).bind(userId, operationId).first<StoredClose>();
  return row ? present(row) : null;
}

/** A retry returns its immutable version; conditional insertion rejects stale concurrent confirmations. */
export async function writeFinanceMonthClose(db: FinanceMonthCloseDatabase, userId: string, input: {
  report: FinanceReview; expectedVersion: number; operationId: string; requestHash: string; reason: string;
}, now = new Date().toISOString()): Promise<FinanceMonthClose> {
  const { report, expectedVersion, operationId, requestHash, reason } = input;
  const existing = async () => db.prepare(`SELECT ${columns} FROM finance_month_closes WHERE user_id = ? AND operation_id = ?`).bind(userId, operationId).first<StoredClose>();
  const replay = (row: StoredClose) => {
    if (row.ledger !== report.ledger || row.currency !== report.currency || row.month !== report.month || row.requestHash !== requestHash || row.reason !== reason || row.version !== expectedVersion + 1) throw new FinanceCloseConflictError('这次提交标识已用于其他月结内容。请重新读取报表。');
    return present(row);
  };
  const prior = await existing();
  if (prior) return replay(prior);
  await db.batch([db.prepare(`INSERT INTO finance_month_closes
    (user_id, ledger, currency, month, version, operation_id, request_hash, snapshot_json, reason, closed_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE
    (SELECT COALESCE(MAX(version), 0) FROM finance_month_closes WHERE user_id = ? AND ledger = ? AND currency = ? AND month = ?) = ?
    ON CONFLICT DO NOTHING`).bind(userId, report.ledger, report.currency, report.month, expectedVersion + 1, operationId, requestHash, JSON.stringify(report), reason, now,
      userId, report.ledger, report.currency, report.month, expectedVersion)]);
  const completed = await existing();
  if (!completed) throw new FinanceCloseConflictError();
  return replay(completed);
}
