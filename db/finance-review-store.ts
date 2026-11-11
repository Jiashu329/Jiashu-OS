import type { LedgerKind } from '../lib/finance.ts';
import type { ReviewAccountRow, ReviewBalanceRow } from '../lib/finance-review.ts';
import { EFFECTIVE_FINANCE_BALANCES } from './finance-effective-balances.ts';

export type FinanceReviewDatabase = Pick<D1Database, 'prepare' | 'batch'>;

/** Both reads share one D1 transaction; only current active accounts are included. */
export async function readFinanceReviewSnapshot(db: FinanceReviewDatabase, userId: string, ledger: LedgerKind, cutoffDay: string): Promise<{ accounts: ReviewAccountRow[]; balances: ReviewBalanceRow[] }> {
  const result = await db.batch<ReviewAccountRow | ReviewBalanceRow>([
    db.prepare(`SELECT id AS accountId, name, type, ledger, currency, archived_at AS archivedAt
      FROM finance_accounts WHERE user_id = ? AND ledger = ? AND archived_at IS NULL
      ORDER BY id`).bind(userId, ledger),
    db.prepare(`SELECT b.account_id AS accountId, b.amount_minor AS amountMinor,
      b.as_of_date AS asOfDate, b.sequence
      FROM (${EFFECTIVE_FINANCE_BALANCES}) b JOIN finance_accounts a ON a.id = b.account_id AND a.user_id = b.user_id
      WHERE a.user_id = ? AND a.ledger = ? AND a.archived_at IS NULL AND b.as_of_date <= ?
      ORDER BY b.account_id, b.as_of_date, b.sequence`).bind(userId, ledger, cutoffDay),
  ]);
  return { accounts: result[0].results as ReviewAccountRow[], balances: result[1].results as ReviewBalanceRow[] };
}
