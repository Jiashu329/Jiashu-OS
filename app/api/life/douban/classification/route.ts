import { classifyDoubanRecord } from '../../../../../db/douban-metadata-store';
import { doubanSubjectUrl, parseDoubanProfile } from '../../../../../lib/douban';
import { DoubanSyncError } from '../../../../../lib/douban-sync';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';

export const dynamic = 'force-dynamic';

export async function PUT(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const raw = await doubanBody(request), fields = ['profileId', 'domain', 'subjectId', 'kind', 'expectedUpdatedAt'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(field => !fields.includes(field))
      || fields.some(field => !Object.hasOwn(raw, field))) throw new DoubanSyncError('请从收藏中选择需要分类的影视记录。');
    const body = raw as Record<string, unknown>;
    if (typeof body.profileId !== 'string' || parseDoubanProfile(body.profileId).profileId !== body.profileId || body.domain !== 'screen'
      || typeof body.subjectId !== 'string' || !['movie', 'series'].includes(String(body.kind)) || typeof body.expectedUpdatedAt !== 'string') {
      throw new DoubanSyncError('请选择电影或电视剧，并使用这条记录的最新版本。');
    }
    doubanSubjectUrl('screen', body.subjectId);
    const item = await classifyDoubanRecord(doubanDatabase(), user.userId, { profileId: body.profileId, domain: 'screen', subjectId: body.subjectId,
      kind: body.kind as 'movie' | 'series', expectedUpdatedAt: body.expectedUpdatedAt });
    return json({ item });
  } catch (error) { return doubanError(error); }
}
