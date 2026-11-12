import type { LedgerKind } from '../lib/finance.ts';
import type { AccountClassification, ReviewAccountRow, ReviewBalanceRow } from '../lib/finance-review.ts';
import { EFFECTIVE_FINANCE_BALANCES } from './finance-effective-balances.ts';

export type FinanceReviewDatabase = Pick<D1Database, 'prepare' | 'batch'>;

/** Both reads share one D1 transaction; classification history and all accounts share the same snapshot. */
export async function readFinanceReviewSnapshot(db: FinanceReviewDatabase, userId: string, ledger: LedgerKind, cutoffDay: string): Promise<{ accounts: ReviewAccountRow[]; balances: ReviewBalanceRow[]; classifications: AccountClassification[] }> {
  const result = await db.batch<ReviewAccountRow | ReviewBalanceRow | AccountClassification>([
    db.prepare(`SELECT id AS accountId, name, type, ledger, currency, archived_at AS archivedAt
      FROM finance_accounts WHERE user_id = ? AND ledger = ?
      ORDER BY id`).bind(userId, ledger),
    db.prepare(`SELECT b.account_id AS accountId, b.amount_minor AS amountMinor,
      b.as_of_date AS asOfDate, b.sequence
      FROM (${EFFECTIVE_FINANCE_BALANCES}) b JOIN finance_accounts a ON a.id = b.account_id AND a.user_id = b.user_id
      WHERE a.user_id = ? AND a.ledger = ? AND b.as_of_date <= ?
      ORDER BY b.account_id, b.as_of_date, b.sequence`).bind(userId, ledger, cutoffDay),
    db.prepare(`SELECT c.account_id AS accountId,c.revision,c.effective_from AS effectiveFrom,c.type,c.archived,c.origin,c.recorded_at AS recordedAt
      FROM finance_account_classifications c JOIN finance_accounts a ON a.id=c.account_id AND a.user_id=c.user_id
      WHERE c.user_id=? AND a.ledger=? ORDER BY c.account_id,c.effective_from,c.revision`).bind(userId,ledger),
  ]);
  return { accounts: result[0].results as ReviewAccountRow[], balances: result[1].results as ReviewBalanceRow[], classifications: result[2].results as AccountClassification[] };
}
