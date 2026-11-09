import { findSyncDevice, importHealth, SyncDeviceInvalidError } from '../../../../db/health-repository';
import { HealthValidationError, MAX_SYNC_BYTES, measurementDay } from '../../../../lib/health';
import { parseMobileSyncPayload } from '../../../../lib/mobile-sync';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../_shared';
import { hashSyncToken, isSyncToken } from '../../sync/devices/tokens';

export const dynamic = 'force-dynamic';

async function limitedBody(request: Request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_SYNC_BYTES) {
        await reader.cancel();
        throw new RangeError('Payload too large');
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json({ error: '请导入 JSON 格式的数据。' }, 415);
  }
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_SYNC_BYTES) return json({ error: '单次同步文件不能超过 512 KB，请分批同步。' }, 413);
  try {
    const token = request.headers.get('x-sync-device');
    let deviceId: string | null = null;
    if (token !== null) {
      if (!isSyncToken(token)) throw new SyncDeviceInvalidError();
      deviceId = await findSyncDevice(user.userId, await hashSyncToken(token));
      if (!deviceId) throw new SyncDeviceInvalidError();
    }
    const body = await limitedBody(request);
    const payload = parseMobileSyncPayload(body);
    const parsedBody = JSON.parse(body);
    const requestedSleep = Object.hasOwn(parsedBody, 'sleepReport');
    const sleepReportDay = requestedSleep ? parsedBody.sleepReport.day : null;
    if (Date.parse(payload.exportedAt) > Date.now() + 5 * 60000) {
      return json({ error: '导出时间晚于当前时间，请检查 iPhone 的日期与时区。' }, 400);
    }
    const result = await importHealth(user.userId, payload, deviceId);
    if (requestedSleep && !payload.measurements.some((record) => record.metric === 'sleep' && measurementDay(record) === sleepReportDay)) {
      return json({ ...result, sleepStatus: 'no-asleep-data', message: '已接收记录，但本次睡眠窗口没有可计入的入睡片段。卧床与清醒不会计作睡眠，睡眠时长仍保留为空。' });
    }
    return json({ ...result, ...(requestedSleep ? { sleepStatus: 'recorded' } : {}) });
  } catch (error) {
    if (error instanceof SyncDeviceInvalidError) return json({ error: '同步设备密钥无效或已撤销，请重新连接设备。', code: 'SYNC_DEVICE_INVALID' }, 403);
    if (error instanceof RangeError) return json({ error: '单次同步文件不能超过 512 KB，请分批同步。' }, 413);
    if (error instanceof HealthValidationError) {
      return json({ error: '同步数据格式不正确，请检查数据类型、单位、日期和每日汇总设置。', code: error.code, issues: error.issues }, 400);
    }
    return unavailable();
  }
}
