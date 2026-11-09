import { createSyncDevice, listSyncDevices } from '../../../../db/health-repository';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../_shared';
import { createSyncToken, hashSyncToken } from './tokens';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try { return json({ devices: await listSyncDevices(user.userId) }); }
  catch { return unavailable(); }
}

async function readSmallBody(request: Request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 1024) {
        await reader.cancel();
        throw new RangeError('Device label request too large');
      }
      body += decoder.decode(result.value, { stream: true });
    }
    return body + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json({ error: '请从网站的连接设备入口创建同步配置。' }, 415);
  }
  try {
    const body: unknown = JSON.parse(await readSmallBody(request));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: '请输入设备名称。' }, 400);
    const label = (body as { label?: unknown }).label;
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(label)) {
      return json({ error: '设备名称需为 1–40 个字符。' }, 400);
    }
    const deviceToken = createSyncToken();
    const deviceId = await createSyncDevice(user.userId, label.trim(), await hashSyncToken(deviceToken));
    if (!deviceId) return json({ error: '最多连接 3 个设备，请先撤销不再使用的设备。', code: 'SYNC_DEVICE_LIMIT' }, 409);
    // This is the only response that contains the plaintext app-scoped token.
    return json({ deviceId, deviceToken }, 201);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '设备配置格式不正确。' }, 400);
    if (error instanceof RangeError) return json({ error: '设备名称请求过大。' }, 413);
    return unavailable();
  }
}
