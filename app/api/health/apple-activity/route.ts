import { env } from 'cloudflare:workers';
import { AppleActivityDeviceError, readAppleActivity, writeAppleActivity } from '../../../../db/apple-health-activity-store';
import { AppleActivityValidationError, parseAppleActivityPayload } from '../../../../lib/apple-health-activity';
import { DateRangeError, parseDateRangeQuery } from '../../../../lib/date-range';
import { MAX_SYNC_BYTES } from '../../../../lib/health';
import { readWithDeadline } from '../../../../lib/read-deadline';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../_shared';
import { hashSyncToken, isSyncToken } from '../../sync/devices/tokens';

export const dynamic = 'force-dynamic';

function database() {
  if (!env.DB) throw new Error('Health database unavailable');
  return env.DB;
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new AppleActivityValidationError('数据格式');
  if (Number(request.headers.get('content-length')) > MAX_SYNC_BYTES) throw new RangeError('Payload too large');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SYNC_BYTES) {
        await reader.cancel();
        throw new RangeError('Payload too large');
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new AppleActivityValidationError('数据格式');
    throw error;
  } finally { reader.releaseLock(); }
}

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const { from, to } = parseDateRangeQuery(new URL(request.url).searchParams, Date.now(), 30);
    return json(await readWithDeadline(readAppleActivity(database(), user.userId, from, to)));
  } catch (error) {
    if (error instanceof DateRangeError) return json({ error: error.message, code: 'INVALID_DATE_RANGE' }, 400);
    return unavailable(error instanceof Error && error.message === 'READ_DEADLINE_EXCEEDED' ? 'read_timeout' : 'storage_failure');
  }
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (env.SELFHOST_AUTH_PROVIDER !== 'local' || request.headers.get('x-jso-native-client') !== 'healthkit-v1') {
    return json({ error: '请在 iPhone App 中同步 Apple 健康数据。', code: 'NATIVE_REQUEST_REQUIRED' }, 403);
  }
  const token = request.headers.get('x-sync-device');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请提交 JSON 格式的 Apple 健康数据。', code: 'INVALID_APPLE_HEALTH_ACTIVITY' }, 415);
  }
  let payload;
  try {
    if (!isSyncToken(token)) throw new AppleActivityDeviceError();
    payload = parseAppleActivityPayload(await readBody(request));
    if (Date.parse(payload.exportedAt) > Date.now() + 5 * 60_000) throw new AppleActivityValidationError('导出时间');
  } catch (error) {
    if (error instanceof AppleActivityDeviceError) return json({ error: error.message, code: 'HEALTH_SYNC_CHANNEL_REQUIRED' }, 403);
    if (error instanceof RangeError) return json({ error: '单次同步文件不能超过 512 KB，请分批同步。', code: 'APPLE_HEALTH_ACTIVITY_TOO_LARGE' }, 413);
    if (error instanceof AppleActivityValidationError) return json({ error: error.message, code: 'INVALID_APPLE_HEALTH_ACTIVITY' }, 400);
    return unavailable();
  }
  try {
    return json(await writeAppleActivity(database(), user.userId, await hashSyncToken(token), payload));
  } catch (error) {
    if (error instanceof AppleActivityDeviceError) return json({ error: error.message, code: 'HEALTH_SYNC_CHANNEL_REQUIRED' }, 403);
    return unavailable();
  }
}
