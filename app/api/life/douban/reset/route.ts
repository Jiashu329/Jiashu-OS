import { commitDoubanReset, DoubanResetStoreError, previewDoubanReset } from '../../../../../db/douban-reset-store';
import { DoubanSyncError } from '../../../../../lib/douban-sync';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';

export const dynamic = 'force-dynamic';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const body = await doubanBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DoubanSyncError('请先预览并核对本次清空范围。');
    const raw = body as Record<string, unknown>;
    const fields = raw.action === 'preview' ? ['action'] : raw.action === 'commit'
      ? ['action', 'expectedEpoch', 'expectedPreviewHash', 'requestId', 'confirmed'] : [];
    if (!fields.length || Object.keys(raw).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(raw, key))) {
      throw new DoubanSyncError('清空操作字段不正确，请重新预览本人的豆瓣资料。');
    }
    if (raw.action === 'preview') return json({ preview: await previewDoubanReset(doubanDatabase(), user.userId) });
    if (!Number.isSafeInteger(raw.expectedEpoch) || Number(raw.expectedEpoch) < 0 || typeof raw.expectedPreviewHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(raw.expectedPreviewHash) || typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId) || raw.confirmed !== true) {
      throw new DoubanSyncError('请核对清空预览、明确确认，并使用原提交标识执行。');
    }
    const receipt = await commitDoubanReset(doubanDatabase(), user.userId, { expectedEpoch: raw.expectedEpoch as number,
      expectedPreviewHash: raw.expectedPreviewHash, requestId: raw.requestId.toLowerCase(), confirmed: true });
    return json({ receipt });
  } catch (error) {
    if (error instanceof DoubanResetStoreError) return json({ error: error.message, code: error.code }, error.status);
    return doubanError(error);
  }
}
