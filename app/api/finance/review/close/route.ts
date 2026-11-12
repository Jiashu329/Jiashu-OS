import { env } from 'cloudflare:workers';
import { readFinanceReviewSnapshot } from '../../../../../db/finance-review-store';
import { readFinanceMonthCloseOperation, writeFinanceMonthClose } from '../../../../../db/finance-month-close-store';
import { buildFinanceReview } from '../../../../../lib/finance-review';
import { FinanceValidationError } from '../../../../../lib/finance';
import { financeReviewHash, FinanceCloseConflictError, parseFinanceCloseInput } from '../../../../../lib/finance-review-close';
import { apiUser, financeBody, financeError, financeIdempotencyKey, financeUnauthenticated, guardFinanceWrite, invalidFinanceIdempotencyKey, json } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  const guard = guardFinanceWrite(request);
  if (guard) return guard;
  const operationId = financeIdempotencyKey(request);
  if (!operationId) return invalidFinanceIdempotencyKey();
  try {
    const input = parseFinanceCloseInput(await financeBody(request));
    if (!env.DB) throw new Error('Finance database unavailable');
    const prior = await readFinanceMonthCloseOperation(env.DB, user.userId, operationId);
    if (prior && (prior.ledger !== input.selection.ledger || prior.currency !== input.selection.currency || prior.month !== input.selection.month
      || prior.version !== input.expectedVersion + 1 || prior.reason !== input.reason || prior.requestHash !== input.previewHash)) throw new FinanceCloseConflictError('这次提交标识已用于其他月结内容。请重新读取报表。');
    const report = prior?.report ?? await (async () => {
      const snapshot = await readFinanceReviewSnapshot(env.DB, user.userId, input.selection.ledger, input.selection.cutoffDay);
      return buildFinanceReview(snapshot.accounts, snapshot.balances, input.selection);
    })();
    if (!report.snapshot.accountCount) throw new FinanceValidationError([{ path: 'month', message: '本月暂无可结余额记录。' }]);
    if (!prior && await financeReviewHash(report) !== input.previewHash) throw new FinanceCloseConflictError();
    const closed = await writeFinanceMonthClose(env.DB, user.userId, { report, expectedVersion: input.expectedVersion, operationId, requestHash: input.previewHash, reason: input.reason });
    return json({ month: closed.month, ledger: closed.ledger, currency: closed.currency, version: closed.version, closedAt: closed.closedAt, reason: closed.reason }, prior ? 200 : 201);
  } catch (error) {
    if (error instanceof FinanceCloseConflictError) return json({ error: error.message, code: error.code }, 409);
    return financeError(error);
  }
}
