import { readDoubanLibraryRecords } from '../../../../../db/douban-library-store';
import { commitDoubanImport, previewDoubanImport, readDoubanImportRecords } from '../../../../../db/douban-store';
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
    if (!fields.length || Object.keys(raw).some(key => !fields.includes(key) && key !== 'expectedDataEpoch' && !(key === 'returnRecords' && raw.action === 'commit')) || fields.some(key => !Object.hasOwn(raw, key))
      || Object.hasOwn(raw, 'expectedDataEpoch') && (!Number.isSafeInteger(raw.expectedDataEpoch) || Number(raw.expectedDataEpoch) < 0)
      || typeof raw.profile !== 'string' || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 500) {
      throw new DoubanSyncError('导入操作字段不正确，每次可提交 1–500 条已预览明细。');
    }
    if (Object.hasOwn(raw, 'returnRecords') && (raw.returnRecords !== true || raw.items.length > 30)) throw new DoubanSyncError('只有每次不超过30条的导入提交可以请求当前已保存记录。');
    const { profileId, profileUrl } = parseDoubanProfile(raw.profile), items = raw.items.map(parseDoubanRecord);
    if (items.some(item => item.source !== 'import' && item.source !== 'browser')) throw new DoubanSyncError('资料保存只接收文件导入或本人浏览器同步的规范化条目。');
    if (raw.action === 'preview') {
      const preview = await previewDoubanImport(doubanDatabase(), user.userId, { profileId, items, expectedDataEpoch: raw.expectedDataEpoch as number | undefined });
      return json({ preview: { ...preview, profileUrl } });
    }
    if (raw.confirmed !== true || typeof raw.expectedSnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.expectedSnapshotHash)
      || typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId)) {
      throw new DoubanSyncError('请核对导入预览、勾选确认，并使用原提交标识保存。');
    }
    const db = doubanDatabase(), receipt = await commitDoubanImport(db, user.userId, { profileId, items,
      expectedSnapshotHash: raw.expectedSnapshotHash, requestId: raw.requestId.toLowerCase(), expectedDataEpoch: raw.expectedDataEpoch as number | undefined });
    if (raw.returnRecords === true) {
      const saved = await readDoubanImportRecords(db, user.userId, { profileId, items, expectedDataEpoch: receipt.dataEpoch });
      const records = await readDoubanLibraryRecords(db, user.userId, saved, receipt.dataEpoch ?? 0);
      if (records.length !== saved.length) throw new DoubanSyncError('导入后的作品已变化，请重新读取收藏。', 'DOUBAN_IMPORT_CONFLICT', 409);
      return json({ receipt, records });
    }
    return json({ receipt });
  } catch (error) {
    if (error instanceof RangeError) return json({ error: '导入明细不能超过 4 MiB，请分批预览后导入。', code: 'DOUBAN_IMPORT_TOO_LARGE' }, 413);
    return doubanError(error);
  }
}
