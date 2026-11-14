import { readDoubanMetadataRecord, saveDoubanSubjectMetadata } from '../../../../../db/douban-metadata-store';
import { doubanSubjectUrl, parseDoubanProfile, type DoubanDomain } from '../../../../../lib/douban';
import { fetchDoubanSubjectMetadata } from '../../../../../lib/douban-metadata';
import { DoubanSourceError } from '../../../../../lib/douban-source';
import { DoubanSyncError } from '../../../../../lib/douban-sync';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';

export const dynamic = 'force-dynamic';
const UNAVAILABLE = '暂时无法从豆瓣补全这条记录，已有封面、分类和个人资料均已保留。';

export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const raw = await doubanBody(request), fields = ['profileId', 'domain', 'subjectId', 'expectedUpdatedAt', 'confirmed'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(field => !fields.includes(field))
      || fields.some(field => !Object.hasOwn(raw, field))) throw new DoubanSyncError('请从收藏中选择需要补全的记录，并确认读取豆瓣公开详情。');
    const body = raw as Record<string, unknown>;
    if (body.confirmed !== true || typeof body.profileId !== 'string' || parseDoubanProfile(body.profileId).profileId !== body.profileId
      || !['screen', 'book', 'music'].includes(String(body.domain)) || typeof body.subjectId !== 'string' || typeof body.expectedUpdatedAt !== 'string') {
      throw new DoubanSyncError('请核对条目信息，并确认读取豆瓣公开详情。');
    }
    const command = { profileId: body.profileId, domain: body.domain as DoubanDomain, subjectId: body.subjectId, expectedUpdatedAt: body.expectedUpdatedAt };
    doubanSubjectUrl(command.domain, command.subjectId);
    const db = doubanDatabase(), old = await readDoubanMetadataRecord(db, user.userId, command);
    let metadata;
    try { metadata = await fetchDoubanSubjectMetadata(command.domain, command.subjectId); }
    catch (error) {
      if (!(error instanceof DoubanSourceError)) throw error;
      if (error.code === 'DOUBAN_SOURCE_RATE_LIMITED') return json({ error: '豆瓣暂时限制请求频率，请稍后再补全。', code: 'DOUBAN_METADATA_RATE_LIMITED' }, 429, { 'Retry-After': '60' });
      return json({ item: old, changed: false, metadata: { status: 'unavailable', message: UNAVAILABLE } });
    }
    if (metadata.kind === null && metadata.coverUrl === null) return json({ item: old, changed: false, metadata: { status: 'unavailable', message: UNAVAILABLE } });
    const result = await saveDoubanSubjectMetadata(db, user.userId, old, metadata);
    return json({ ...result, metadata: { status: 'complete' } });
  } catch (error) { return doubanError(error); }
}
