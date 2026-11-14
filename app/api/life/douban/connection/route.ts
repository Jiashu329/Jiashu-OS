import { writeDoubanConnection } from '../../../../../db/douban-store';
import { parseDoubanProfile } from '../../../../../lib/douban';
import { DoubanSyncError } from '../../../../../lib/douban-sync';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard, presentDoubanConnection } from '../_shared';

export const dynamic = 'force-dynamic';

export async function PUT(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const body = await doubanBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DoubanSyncError('请填写豆瓣主页和最新配置版本。');
    const raw = body as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['profile', 'expectedRevision'].includes(key)) || !Object.hasOwn(raw, 'profile')
      || !Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0 || raw.profile !== null && typeof raw.profile !== 'string') {
      throw new DoubanSyncError('豆瓣配置字段不正确，请读取最新配置后再保存。');
    }
    const profileId = raw.profile === null ? null : parseDoubanProfile(raw.profile).profileId;
    const connection = await writeDoubanConnection(doubanDatabase(), user.userId, profileId, Number(raw.expectedRevision));
    return json({ connection: presentDoubanConnection(connection) });
  } catch (error) { return doubanError(error); }
}
