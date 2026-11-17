import { findSyncDevice, previewImport, saveSyncAttempt, SyncDeviceInvalidError } from '../../../../../db/health-repository';
import { HealthImportConflictError } from '../../../../../db/health-import-store';
import { HealthValidationError, MAX_SYNC_BYTES, type HealthSyncPayload } from '../../../../../lib/health';
import { emptySyncSummary, syncPayloadSummary, SYNC_FAILURES, type SyncFailureCode } from '../../../../../lib/sync-diagnostics';
import { parseMobileSyncPayload } from '../../../../../lib/mobile-sync';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../../_shared';
import { hashSyncToken, isSyncToken } from '../../../sync/devices/tokens';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  const channel = request.headers.has('x-sync-device') ? 'device' as const : 'manual' as const;
  let deviceId: string | null = null;
  let parsedPayload: HealthSyncPayload | null = null;
  const failure = async (errorCode: SyncFailureCode) => {
    try { await saveSyncAttempt(user.userId, { channel, deviceId, status: 'failed', errorCode, summary: parsedPayload ? syncPayloadSummary(parsedPayload) : emptySyncSummary() }); }
    catch { console.error(JSON.stringify({ event: 'sync_receipt_unavailable', reason: 'diagnostic_write_failed' })); }
  };
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) { await failure('SYNC_INVALID_FORMAT'); return json({ error: '请提交 JSON 格式的数据。' }, 415); }
  if (Number(request.headers.get('content-length')) > MAX_SYNC_BYTES) { await failure('SYNC_TOO_LARGE'); return json({ error: '单次同步文件不能超过 512 KB。' }, 413); }
  const reader = request.body?.getReader();
  if (!reader) { await failure('SYNC_INVALID_FORMAT'); return json({ error: '请选择文件或粘贴 JSON 内容。' }, 400); }
  try {
    const token = request.headers.get('x-sync-device');
    if (token !== null) {
      if (!isSyncToken(token)) throw new SyncDeviceInvalidError();
      deviceId = await findSyncDevice(user.userId, await hashSyncToken(token));
      if (!deviceId) throw new SyncDeviceInvalidError();
    }
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_SYNC_BYTES) { await reader.cancel(); await failure('SYNC_TOO_LARGE'); return json({ error: '单次同步文件不能超过 512 KB。' }, 413); }
      text += decoder.decode(next.value, { stream: true });
    }
    const payload = parseMobileSyncPayload(text + decoder.decode());
    parsedPayload = payload;
    if (Date.parse(payload.exportedAt) > Date.now() + 5 * 60000) { await failure('SYNC_FUTURE_EXPORT'); return json({ error: '导出时间晚于当前时间，请检查 iPhone 的日期与时区。' }, 400); }
    return json({ preview: await previewImport(user.userId, payload, deviceId) });
  } catch (error) {
    const code: SyncFailureCode = error instanceof SyncDeviceInvalidError ? 'SYNC_DEVICE_INVALID'
      : error instanceof HealthValidationError ? 'SYNC_INVALID_FORMAT'
      : error instanceof HealthImportConflictError && Object.hasOwn(SYNC_FAILURES, error.code) ? error.code as SyncFailureCode : 'SYNC_STORAGE_UNAVAILABLE';
    await failure(code);
    if (error instanceof SyncDeviceInvalidError) return json({ error: '同步设备密钥无效或已撤销，请重新连接设备。', code: 'SYNC_DEVICE_INVALID' }, 403);
    if (error instanceof HealthImportConflictError) return json({ error: error.message, code: error.code }, error.code === 'HEALTH_IMPORT_NOT_FOUND' ? 404 : 409);
    if (error instanceof HealthValidationError) return json({ error: '数据格式不正确，请检查指标、来源、单位与日期。', code: error.code, issues: error.issues }, 400);
    return unavailable();
  } finally { reader.releaseLock(); }
}
