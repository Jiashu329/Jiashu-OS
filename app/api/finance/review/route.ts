import { env } from 'cloudflare:workers';
import { readFinanceReviewSnapshot } from '../../../../db/finance-review-store';
import { buildFinanceReview, parseFinanceReviewQuery } from '../../../../lib/finance-review';
import { FinanceValidationError } from '../../../../lib/finance';
import { financeReviewHash } from '../../../../lib/finance-review-close';
import { readFinanceMonthCloseBundle } from '../../../../db/finance-month-close-store';
import { readFinanceDecisionSummary } from '../../../../db/finance-decision-summary';
import { apiUser, financeError, financeUnauthenticated, json } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  try {
    const selection = parseFinanceReviewQuery(new URL(request.url).searchParams);
    if (!env.DB) throw new Error('Finance database unavailable');
    const query = new URL(request.url).searchParams;
    const draft = query.get('draft') === '1';
    const rawVersion = query.get('version');
    if (rawVersion !== null && (!/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion)) || draft)) throw new FinanceValidationError([{ path: 'version', message: '请选择有效月结版本。' }]);
    const version = rawVersion === null ? undefined : Number(rawVersion);
    const { closed, versions } = await readFinanceMonthCloseBundle(env.DB, user.userId, selection, version);
    if (version !== undefined && !closed) return json({ error: '找不到这个月结版本。', code: 'FINANCE_CLOSE_NOT_FOUND' }, 404);
    const report = closed && !draft ? closed.report : await (async () => {
      const snapshot = await readFinanceReviewSnapshot(env.DB, user.userId, selection.ledger, selection.cutoffDay);
      return buildFinanceReview(snapshot.accounts, snapshot.balances, selection, snapshot.classifications);
    })();
    let decisions;
    try { decisions = await readFinanceDecisionSummary(env.DB, user.userId, selection.ledger, selection.currency, selection.today); }
    catch { decisions = null; }
    return json({ ...report, close: {
      state: closed && !draft ? 'closed' : 'draft', version: closed && !draft ? closed.version : 0,
      latestVersion: versions[0]?.version ?? 0, closedAt: closed && !draft ? closed.closedAt : null,
      reason: closed && !draft ? closed.reason : '', versions, canClose: selection.month < selection.today.slice(0, 7),
      currentToday: selection.today, previewHash: closed && !draft ? null : await financeReviewHash(report),
    }, decisions });
  } catch (error) { return financeError(error); }
}
