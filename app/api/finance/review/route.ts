import { env } from 'cloudflare:workers';
import { readFinanceReviewSnapshot } from '../../../../db/finance-review-store';
import { buildFinanceReview, parseFinanceReviewQuery } from '../../../../lib/finance-review';
import { apiUser, financeError, financeUnauthenticated, json } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return financeUnauthenticated();
  try {
    const selection = parseFinanceReviewQuery(new URL(request.url).searchParams);
    if (!env.DB) throw new Error('Finance database unavailable');
    const snapshot = await readFinanceReviewSnapshot(env.DB, user.userId, selection.ledger, selection.cutoffDay);
    return json(buildFinanceReview(snapshot.accounts, snapshot.balances, selection, snapshot.classifications));
  } catch (error) { return financeError(error); }
}
