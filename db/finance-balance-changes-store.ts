import { EFFECTIVE_FINANCE_BALANCES } from './finance-effective-balances.ts';
import { FinanceIdempotencyConflictError, findFinanceAccountSnapshot, type FinanceDatabase, type FinanceBalanceRow } from './finance-store.ts';
import type { FinanceBalanceChangeInput } from '../lib/finance-balance-change.ts';

export class FinanceBalanceChangeConflictError extends Error {
  constructor() { super('这条余额记录已变化，请重新查看并预览。'); this.name = 'FinanceBalanceChangeConflictError'; }
}
export class FinanceLastBalanceError extends Error {
  constructor() { super('这是账户最后一条有效余额，请更正金额或日期；如不再使用账户，可将账户归档。'); this.name = 'FinanceLastBalanceError'; }
}
export interface FinanceBalanceChangeRow {
  id: string; accountId: string; entryId: string; revision: number; action: 'correct' | 'void';
  amountMinor: string | null; asOfDate: string | null; note: string | null; reason: string; createdAt: string;
}

export async function financeBalanceChangeHistory(db: FinanceDatabase, userId: string, accountId: string): Promise<FinanceBalanceChangeRow[]> {
  const rows = await db.prepare(`SELECT c.id, c.account_id AS accountId, c.entry_id AS entryId, c.revision, c.action,
    c.amount_minor AS amountMinor, c.as_of_date AS asOfDate, c.note, c.reason, c.created_at AS createdAt
    FROM finance_balance_changes c JOIN finance_accounts a ON a.id=c.account_id AND a.user_id=c.user_id
    WHERE c.user_id=? AND c.account_id=? ORDER BY c.sequence DESC`).bind(userId, accountId).all<FinanceBalanceChangeRow>();
  return rows.results;
}

export async function previewFinanceBalanceChange(db: FinanceDatabase, userId: string, accountId: string, entryId: string, input: FinanceBalanceChangeInput) {
  const snapshot = await findFinanceAccountSnapshot(db, userId, accountId);
  const target = snapshot.balances.find((row) => row.id === entryId);
  if (!snapshot.account || !target) return null;
  if (snapshot.account.archivedAt !== null || snapshot.account.balanceRevision !== input.expectedAccountRevision || (target.revision ?? 0) !== input.expectedRevision || (input.action === 'void' && target.status === 'void')) throw new FinanceBalanceChangeConflictError();
  const active = snapshot.balances.filter((row) => row.status !== 'void');
  if (input.action === 'void' && active.length <= 1) throw new FinanceLastBalanceError();
  const projected = active.filter((row) => row.id !== entryId);
  if (input.action === 'correct') projected.push({ ...target, amountMinor: input.amountMinor!, asOfDate: input.asOfDate!, note: input.note!, status: 'corrected' });
  projected.sort((a, b) => b.asOfDate.localeCompare(a.asOfDate) || Number(b.sequence ?? 0) - Number(a.sequence ?? 0));
  const after = projected[0];
  const summary = (row: FinanceBalanceRow) => ({ entryId: row.id, amountMinor: row.amountMinor, asOfDate: row.asOfDate });
  return {
    action: input.action, entryId, expectedRevision: input.expectedRevision, expectedAccountRevision: input.expectedAccountRevision, currency: snapshot.account.currency,
    before: { amountMinor: target.amountMinor, asOfDate: target.asOfDate, status: target.status ?? 'active' },
    after: input.action === 'void' ? null : { amountMinor: input.amountMinor, asOfDate: input.asOfDate },
    currentBefore: { amountMinor: snapshot.account.balanceMinor, asOfDate: snapshot.account.asOfDate },
    currentAfter: summary(after),
    changesCurrentBalance: snapshot.account.balanceMinor !== after.amountMinor || snapshot.account.asOfDate !== after.asOfDate,
  };
}

export async function changeFinanceBalance(db: FinanceDatabase, userId: string, accountId: string, entryId: string, input: FinanceBalanceChangeInput, operationId: string, now = new Date().toISOString()): Promise<string | null> {
  const canonical = JSON.stringify([userId, accountId, entryId, input.action, input.expectedRevision, input.expectedAccountRevision, input.reason, input.amountMinor, input.asOfDate, input.note]);
  const requestHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))].map((v) => v.toString(16).padStart(2, '0')).join('');
  const operation = () => db.prepare('SELECT user_id AS userId, request_hash AS requestHash FROM finance_balance_changes WHERE id=?').bind(operationId).first<{ userId: string; requestHash: string }>();
  const replayed = async () => {
    const existing = await operation();
    if (!existing) return false;
    if (existing.userId === userId && existing.requestHash === requestHash) return true;
    throw new FinanceIdempotencyConflictError();
  };
  if (await replayed()) return operationId;
  try {
    if (!await previewFinanceBalanceChange(db, userId, accountId, entryId, input)) return await replayed() ? operationId : null;
  } catch (error) {
    // An identical request can commit after our first idempotency read but
    // before the snapshot read. Its old revision is then a successful replay.
    if (await replayed()) return operationId;
    throw error;
  }
  const result = await db.batch([
    db.prepare(`INSERT INTO finance_balance_changes
      (id,user_id,account_id,entry_id,revision,action,amount_minor,as_of_date,note,reason,request_hash,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? FROM finance_balance_entries b JOIN finance_accounts a ON a.id=b.account_id AND a.user_id=b.user_id
      WHERE b.user_id=? AND b.account_id=? AND b.id=? AND a.archived_at IS NULL AND a.balance_revision=?
      AND COALESCE((SELECT MAX(revision) FROM finance_balance_changes WHERE user_id=b.user_id AND entry_id=b.id),0)=?
      AND (? <> 'void' OR (
        (SELECT COUNT(*) FROM (${EFFECTIVE_FINANCE_BALANCES}) active WHERE active.user_id=b.user_id AND active.account_id=b.account_id)>1
        AND EXISTS (SELECT 1 FROM (${EFFECTIVE_FINANCE_BALANCES}) active WHERE active.user_id=b.user_id AND active.id=b.id)
      )) ON CONFLICT DO NOTHING`)
      .bind(operationId,userId,accountId,entryId,input.expectedRevision+1,input.action,input.amountMinor,input.asOfDate,input.note,input.reason,requestHash,now,userId,accountId,entryId,input.expectedAccountRevision,input.expectedRevision,input.action),
    db.prepare(`UPDATE finance_accounts SET updated_at=?, balance_revision=balance_revision+1 WHERE user_id=? AND id=? AND changes()=1
      AND EXISTS (SELECT 1 FROM finance_balance_changes WHERE id=? AND user_id=? AND account_id=?)`)
      .bind(now,userId,accountId,operationId,userId,accountId),
  ]);
  const completed = await operation();
  if (completed) {
    if (completed.userId === userId && completed.requestHash === requestHash) return operationId;
    throw new FinanceIdempotencyConflictError();
  }
  if (result[0].meta.changes !== 1) throw new FinanceBalanceChangeConflictError();
  return operationId;
}
