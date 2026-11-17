import { env } from 'cloudflare:workers';
import { NativeHealthChannelError, readNativeHealthChannel, selectNativeHealthChannel, clearNativeHealthChannel } from '../../../../db/native-health-channel-store';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../_shared';
import { hashSyncToken, isSyncToken } from '../devices/tokens';

export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 2048;

function database() {
  if (!env.DB) throw new Error('Health database unavailable');
  return env.DB;
}
function nativeMutation(request: Request): Response | null {
  if (!isSameOrigin(request)) return invalidOrigin();
  // Only the self-hosted gateway sets this marker after validating its independent
  // native bearer session. Browser headers are stripped, and Sites cannot opt in.
  if (env.SELFHOST_AUTH_PROVIDER !== 'local' || request.headers.get('x-jso-native-client') !== 'healthkit-v1') {
    return json({ error: '请在原生 App 中确认健康同步设备。', code: 'NATIVE_REQUEST_REQUIRED' }, 403);
  }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请提交 JSON 格式的同步设备设置。', code: 'NATIVE_HEALTH_CHANNEL_INVALID' }, 415);
  }
  return null;
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError(); }
      text += decoder.decode(result.value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError();
    return value as Record<string, unknown>;
  } finally { reader.releaseLock(); }
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function controls(value: string): boolean { return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function invalid() { return json({ error: '请核对同步设备名称、连接凭据和设置版本。', code: 'NATIVE_HEALTH_CHANNEL_INVALID' }, 400); }
function failure(error: unknown) {
  if (error instanceof NativeHealthChannelError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof RangeError) return json({ error: '同步设备设置不能超过 2 KB。', code: 'NATIVE_HEALTH_CHANNEL_TOO_LARGE' }, 413);
  if (error instanceof SyntaxError || error instanceof TypeError) return invalid();
  return unavailable();
}

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const token = request.headers.get('x-sync-device');
  if (token !== null && !isSyncToken(token)) return invalid();
  try { return json(await readNativeHealthChannel(database(), user.userId, token === null ? undefined : await hashSyncToken(token))); }
  catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const denied = nativeMutation(request);
  if (denied) return denied;
  try {
    const value = await readBody(request);
    if (!exact(value, ['deviceToken', 'label', 'expectedRevision']) || !isSyncToken(value.deviceToken)
      || typeof value.label !== 'string' || !value.label.trim() || value.label.trim().length > 40
      || controls(value.label) || !revision(value.expectedRevision)) return invalid();
    return json(await selectNativeHealthChannel(database(), user.userId, {
      deviceTokenHash: await hashSyncToken(value.deviceToken as string), label: value.label.trim(), expectedRevision: value.expectedRevision,
    }));
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const denied = nativeMutation(request);
  if (denied) return denied;
  try {
    const value = await readBody(request), token = request.headers.get('x-sync-device');
    if (!exact(value, ['expectedRevision']) || !revision(value.expectedRevision) || !isSyncToken(token)) return invalid();
    return json(await clearNativeHealthChannel(database(), user.userId, {
      deviceTokenHash: await hashSyncToken(token as string), expectedRevision: value.expectedRevision,
    }));
  } catch (error) { return failure(error); }
}
