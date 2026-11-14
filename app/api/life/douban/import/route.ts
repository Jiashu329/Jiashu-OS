import { commitDoubanImport, previewDoubanImport } from '../../../../../db/douban-store';
import { parseDoubanProfile, parseDoubanRecord } from '../../../../../lib/douban';
import { DoubanSyncError } from '../../../../../lib/douban-sync';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';

export const dynamic = 'force-dynamic';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const body = await doubanBody(request, 4 * 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DoubanSyncError('请先选择并预览本人导出的豆瓣资料。');
    const raw = body as Record<string, unknown>;
    const fields = raw.action === 'preview' ? ['action', 'profile', 'items'] : raw.action === 'commit'
      ? ['action', 'profile', 'items', 'expectedSnapshotHash', 'requestId', 'confirmed'] : [];
    if (!fields.length || Object.keys(raw).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(raw, key))
      || typeof raw.profile !== 'string' || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 500) {
      throw new DoubanSyncError('导入操作字段不正确，每次可提交 1–500 条已预览明细。');
    }
    const { profileId, profileUrl } = parseDoubanProfile(raw.profile), items = raw.items.map(parseDoubanRecord);
    if (items.some(item => item.source !== 'import')) throw new DoubanSyncError('文件导入只接收明确标为本人导入的规范化条目。');
    if (raw.action === 'preview') {
      const preview = await previewDoubanImport(doubanDatabase(), user.userId, { profileId, items });
      return json({ preview: { ...preview, profileUrl } });
    }
    if (raw.confirmed !== true || typeof raw.expectedSnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.expectedSnapshotHash)
      || typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId)) {
      throw new DoubanSyncError('请核对导入预览、勾选确认，并使用原提交标识保存。');
    }
    const receipt = await commitDoubanImport(doubanDatabase(), user.userId, { profileId, items,
      expectedSnapshotHash: raw.expectedSnapshotHash, requestId: raw.requestId.toLowerCase() });
    return json({ receipt });
  } catch (error) {
    if (error instanceof RangeError) return json({ error: '导入明细不能超过 4 MiB，请分批预览后导入。', code: 'DOUBAN_IMPORT_TOO_LARGE' }, 413);
    return doubanError(error);
  }
}
