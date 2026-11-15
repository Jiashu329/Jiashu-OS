import { env } from 'cloudflare:workers';
import { confirmDoubanTMDBItem, readDoubanTMDBItem, saveDoubanTMDBCover, type DoubanTMDBCommand } from '../../../../../db/douban-tmdb-store';
import { resolveTMDBConfiguration } from '../../../../../db/tmdb-settings-store';
import { DoubanStoreError } from '../../../../../db/douban-store';
import { findTMDBCover, TMDBProviderError } from '../../../../../lib/tmdb-provider';
import { validIMDbId } from '../../../../../lib/tmdb-cover';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';

export const dynamic = 'force-dynamic';
function command(raw: unknown): DoubanTMDBCommand {
  const fields = ['profileId', 'domain', 'subjectId', 'expectedUpdatedAt', 'expectedDataEpoch', 'confirmed'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length || fields.some(field => !Object.hasOwn(raw, field))
    || (raw as Record<string, unknown>).confirmed !== true) throw new DoubanStoreError('请从当前影视收藏确认查找 TMDB 封面。', 'INVALID_DOUBAN_INPUT', 400);
  const { confirmed: _confirmed, ...value } = raw as DoubanTMDBCommand & { confirmed: true };
  return value;
}
export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const value = command(await doubanBody(request)), db = doubanDatabase(), item = await readDoubanTMDBItem(db, user.userId, value), dataEpoch = value.expectedDataEpoch;
    const result = (current: typeof item, status: string, message?: string, statusCode = 200, retryAfter?: number) => json({ item: current, changed: false, dataEpoch,
      ...(statusCode >= 400 ? { error: message, code: status === 'rate_limited' ? 'TMDB_RATE_LIMITED' : 'TMDB_UNAVAILABLE' } : {}),
      tmdb: { status, ...(message ? { message } : {}), ...(retryAfter ? { retryAfter } : {}) } }, statusCode, retryAfter ? { 'Retry-After': String(retryAfter) } : undefined);
    if (item.tmdb) return result(item, 'matched');
    if (!validIMDbId(item.details?.imdbId)) return result(item, 'missing_imdb', '豆瓣详情未提供 IMDb 编号，已有封面已保留。');
    let configuration;
    try { configuration = await resolveTMDBConfiguration(db, env); }
    catch { return result(await confirmDoubanTMDBItem(db, user.userId, item, dataEpoch), 'unavailable', 'TMDB 配置暂时无法读取，请稍后重试。', 503); }
    if (!configuration.configured) return result(await confirmDoubanTMDBItem(db, user.userId, item, dataEpoch), 'not_configured', '尚未配置 TMDB，豆瓣同步已保留。');
    let lookup;
    try { lookup = await findTMDBCover(item.details.imdbId, item.kind as 'movie' | 'series' | 'screen', configuration.token); }
    catch (error) {
      if (!(error instanceof TMDBProviderError)) throw error;
      const current = await confirmDoubanTMDBItem(db, user.userId, item, dataEpoch);
      return result(current, error.code === 'TMDB_RATE_LIMITED' ? 'rate_limited' : 'unavailable', error.message,
        error.code === 'TMDB_RATE_LIMITED' ? 429 : 503, error.code === 'TMDB_RATE_LIMITED' ? error.retryAfter ?? 60 : undefined);
    }
    if (lookup.status !== 'matched') {
      const messages = { no_match: '没有找到与此 IMDb 编号一致的影视作品。', ambiguous: 'TMDB 返回多个或不同层级的匹配，未自动选择封面。',
        episode_only: '此 IMDb 编号只匹配到单集或季，未自动使用整部剧的封面。', no_poster: '已找到作品，但没有可用的中文、英文或无语言海报。' };
      return result(await confirmDoubanTMDBItem(db, user.userId, item, dataEpoch), lookup.status, messages[lookup.status]);
    }
    const saved = await saveDoubanTMDBCover(db, user.userId, item, lookup.cover, dataEpoch);
    return json({ ...saved, dataEpoch, tmdb: { status: 'matched' } });
  } catch (error) { return doubanError(error); }
}
