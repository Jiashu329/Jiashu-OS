import { syncDoubanIMDbRatings, parseIMDbRatingsCommand, IMDbRatingsRefreshBusyError } from '../../../../../db/douban-imdb-ratings-store';
import { IMDbRatingsProviderError } from '../../../../../lib/imdb-ratings-provider';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try { const command = parseIMDbRatingsCommand(await doubanBody(request, 32768)); return json(await syncDoubanIMDbRatings(doubanDatabase(), user.userId, command)); }
  catch (error) {
    if (error instanceof IMDbRatingsProviderError || error instanceof IMDbRatingsRefreshBusyError) return json({ error: error.message, code: error.code }, error.status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined);
    if (error instanceof RangeError) return json({ error: 'IMDb 评分批次不能超过 32 KB。', code: 'DOUBAN_REQUEST_TOO_LARGE' }, 413);
    return doubanError(error);
  }
}
