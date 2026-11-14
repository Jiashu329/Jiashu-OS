import { DoubanStoreError, listDoubanRecords, readDoubanConnection, readDoubanDataEpoch, readDoubanRun } from '../../../../db/douban-store';
import { DoubanSyncError, presentDoubanRun } from '../../../../lib/douban-sync';
import type { DoubanKind } from '../../../../lib/douban';
import { apiUser, json, unauthenticated } from '../../_shared';
import { doubanDatabase, doubanError, presentDoubanConnection } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['kind', 'q', 'offset', 'limit', 'profile'].includes(key))
      || [...new Set(params.keys())].some(key => params.getAll(key).length > 1)) throw new DoubanSyncError('豆瓣筛选参数不正确。');
    const kind = params.get('kind') || 'all', query = (params.get('q') ?? '').trim(), profile = params.get('profile') || 'all';
    const offsetText = params.get('offset') ?? '0', limitText = params.get('limit') ?? '24';
    if (!['all', 'screen', 'movie', 'series', 'book', 'music'].includes(kind) || !['all', 'current'].includes(profile)
      || query.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(query)
      || !/^(0|[1-9]\d*)$/.test(offsetText) || Number(offsetText) > 100000
      || !/^[1-9]\d?$/.test(limitText) || Number(limitText) > 50) throw new DoubanSyncError('请核对豆瓣记录的分类、搜索或分页参数。');
    const db = doubanDatabase(), dataEpoch = await readDoubanDataEpoch(db, user.userId), connection = await readDoubanConnection(db, user.userId);
    const [records, lastRun] = await Promise.all([
      profile === 'current' && connection.profileId === null
        ? Promise.resolve({ items: [], total: 0, counts: { all: 0, screen: 0, movie: 0, series: 0, book: 0, music: 0 }, offset: Number(offsetText), limit: Number(limitText), hasMore: false })
        : listDoubanRecords(db, user.userId, { kind: kind as DoubanKind | 'all', query, offset: Number(offsetText), limit: Number(limitText),
          ...(profile === 'current' && connection.profileId !== null ? { profileId: connection.profileId } : {}) }),
      readDoubanRun(db, user.userId),
    ]);
    if (await readDoubanDataEpoch(db, user.userId) !== dataEpoch) throw new DoubanStoreError('豆瓣资料已清空或重置，请重新读取当前记录。', 'DOUBAN_DATA_EPOCH_CONFLICT');
    return json({ dataEpoch, connection: presentDoubanConnection(connection), ...records, lastRun: lastRun ? presentDoubanRun(lastRun) : null });
  } catch (error) { return doubanError(error); }
}
