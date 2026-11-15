import { classifyDoubanLibrary, writeDoubanLocalRecord, type DoubanBatchClassification } from '../../../../../db/douban-library-store';
import { DoubanSyncError } from '../../../../../lib/douban-sync';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';

export const dynamic = 'force-dynamic';
function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(field => !fields.includes(field))
    || fields.some(field => !Object.hasOwn(raw, field))) throw new DoubanSyncError('请从当前收藏选择需要整理的记录。');
  return raw as Record<string, unknown>;
}
export async function PUT(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const body = object(await doubanBody(request, 32768), ['profileId', 'domain', 'subjectId', 'expectedDataEpoch', 'expectedLocalRevision', 'note', 'tags', 'hidden']);
    const item = await writeDoubanLocalRecord(doubanDatabase(), user.userId, body as unknown as Parameters<typeof writeDoubanLocalRecord>[2]);
    return json({ item, dataEpoch: body.expectedDataEpoch });
  } catch (error) { return doubanError(error); }
}
export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const body = object(await doubanBody(request, 16384), ['action', 'kind', 'expectedDataEpoch', 'items']);
    if (body.action !== 'classify' || !Array.isArray(body.items)) throw new DoubanSyncError('请选择需要分类的影视记录。');
    for (const item of body.items) object(item, ['profileId', 'domain', 'subjectId', 'expectedUpdatedAt']);
    const items = await classifyDoubanLibrary(doubanDatabase(), user.userId, body as unknown as DoubanBatchClassification);
    return json({ items, dataEpoch: body.expectedDataEpoch });
  } catch (error) { return doubanError(error); }
}
