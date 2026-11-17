import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import { hashSyncToken, isSyncToken } from '../devices/tokens.ts';

const ORIGIN = 'https://synthetic-channel.example';
const DEVICE_TOKEN = 'jso_sync_' + 'a'.repeat(43);
const STATE = { revision: 1, deviceId: 'synthetic-device', label: 'My iPhone', updatedAt: '2026-11-17T00:00:00Z', isCurrentDevice: true };
class NativeHealthChannelError extends Error {
  code: string; status: number;
  constructor(code: string, status: number) { super('请重新核对同步设备。'); this.code = code; this.status = status; }
}

function fixture(options: { signedIn?: boolean; local?: boolean } = {}) {
  const calls: { method: string; owner: string; input: unknown }[] = [];
  let rejection: Error | null = null;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  const invoke = async (method: string, _db: unknown, owner: string, input: unknown) => {
    if (rejection) throw rejection;
    calls.push({ method, owner, input });
    return { ...STATE, isCurrentDevice: method !== 'read' || input === await hashSyncToken(DEVICE_TOKEN) };
  };
  const bindings = {
    env: { DB: {}, SELFHOST_AUTH_PROVIDER: options.local === false ? undefined : 'local' },
    NativeHealthChannelError, hashSyncToken, isSyncToken, json,
    apiUser: async () => options.signedIn === false ? null : { userId: 'synthetic-owner' },
    unauthenticated: () => json({ code: 'SIGN_IN_REQUIRED' }, 401),
    unavailable: () => json({ code: 'HEALTH_STORAGE_UNAVAILABLE' }, 503),
    isSameOrigin: (request: Request) => request.headers.get('origin') === ORIGIN,
    invalidOrigin: () => json({ code: 'INVALID_ORIGIN' }, 403),
    readNativeHealthChannel: (...args: [unknown, string, unknown]) => invoke('read', ...args),
    selectNativeHealthChannel: (...args: [unknown, string, unknown]) => invoke('select', ...args),
    clearNativeHealthChannel: (...args: [unknown, string, unknown]) => invoke('clear', ...args),
  };
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const routes = compileFunction(source + '\nreturn {GET,PUT,DELETE};', Object.keys(bindings))(...Object.values(bindings)) as Record<string, (request: Request) => Promise<Response>>;
  return {
    calls,
    reject(error: Error) { rejection = error; },
    call(method: string, body?: unknown, headers: Record<string, string> = {}, rawBody?: string) {
      return routes[method](new Request(ORIGIN + '/api/sync/channel', { method,
        headers: method === 'GET' ? headers : { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Jso-Native-Client': 'healthkit-v1', ...headers },
        ...(method === 'GET' ? {} : { body: rawBody ?? JSON.stringify(body) }),
      }));
    },
  };
}

void test('channel endpoints authenticate before reading or mutating device state', async () => {
  const f = fixture({ signedIn: false });
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await f.call(method, {})).status, 401);
  assert.deepEqual(f.calls, []);
});

void test('status is scoped to the current owner and a supplied device token is only hashed for comparison', async () => {
  const f = fixture();
  const noDevice = await f.call('GET');
  assert.equal(noDevice.status, 200);
  assert.equal((await noDevice.json() as typeof STATE).isCurrentDevice, false);
  assert.deepEqual(f.calls[0], { method: 'read', owner: 'synthetic-owner', input: undefined });
  const current = await f.call('GET', undefined, { 'X-Sync-Device': DEVICE_TOKEN });
  assert.equal(current.headers.get('cache-control'), 'no-store');
  assert.equal((await current.json() as typeof STATE).isCurrentDevice, true);
  assert.equal(f.calls[1].input, await hashSyncToken(DEVICE_TOKEN));
  assert.doesNotMatch(JSON.stringify(f.calls), new RegExp(DEVICE_TOKEN));
  const other = await f.call('GET', undefined, { 'X-Sync-Device': 'jso_sync_' + 'b'.repeat(43) });
  assert.equal((await other.json() as typeof STATE).isCurrentDevice, false);
  assert.equal((await f.call('GET', undefined, { 'X-Sync-Device': 'invalid' })).status, 400);
});

void test('selection and release require both native gateway proof and the existing origin boundary', async () => {
  const input = { deviceToken: DEVICE_TOKEN, label: 'My iPhone', expectedRevision: 0 };
  for (const method of ['PUT', 'DELETE']) {
    const f = fixture();
    assert.equal((await f.call(method, input, { 'X-Jso-Native-Client': '' })).status, 403);
    assert.equal((await f.call(method, input, { Origin: 'https://other.example' })).status, 403);
    assert.deepEqual(f.calls, []);
    const sites = fixture({ local: false });
    assert.equal((await sites.call(method, input)).status, 403);
    assert.deepEqual(sites.calls, []);
  }
});

void test('explicit selection passes the hashed token, normalized label and exact observed revision', async () => {
  const f = fixture();
  const response = await f.call('PUT', { deviceToken: DEVICE_TOKEN, label: '  My iPhone  ', expectedRevision: 3 });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, [{ method: 'select', owner: 'synthetic-owner', input: {
    deviceTokenHash: await hashSyncToken(DEVICE_TOKEN), label: 'My iPhone', expectedRevision: 3,
  } }]);
  assert.doesNotMatch(await response.text(), new RegExp(DEVICE_TOKEN));
  const invalid = [{}, { deviceToken: DEVICE_TOKEN, label: 'x', expectedRevision: -1 },
    { deviceToken: DEVICE_TOKEN, label: 'x', expectedRevision: 1.5 },
    { deviceToken: DEVICE_TOKEN, label: 'x', expectedRevision: 0, confirm: true },
    { deviceToken: DEVICE_TOKEN, label: 'bad\nname', expectedRevision: 0 },
    { deviceToken: DEVICE_TOKEN, label: 'x'.repeat(41), expectedRevision: 0 }];
  for (const body of invalid) assert.equal((await f.call('PUT', body)).status, 400);
  assert.equal(f.calls.length, 1);
});

void test('release binds the current device credential and does not accept an arbitrary request body token', async () => {
  const f = fixture();
  assert.equal((await f.call('DELETE', { expectedRevision: 2 }, { 'X-Sync-Device': DEVICE_TOKEN })).status, 200);
  assert.deepEqual(f.calls, [{ method: 'clear', owner: 'synthetic-owner', input: {
    deviceTokenHash: await hashSyncToken(DEVICE_TOKEN), expectedRevision: 2,
  } }]);
  assert.equal((await f.call('DELETE', { expectedRevision: 2 })).status, 400);
  assert.equal((await f.call('DELETE', { expectedRevision: 2, deviceToken: DEVICE_TOKEN }, { 'X-Sync-Device': DEVICE_TOKEN })).status, 400);
  assert.equal(f.calls.length, 1);
});

void test('channel settings reject malformed, oversized and non-JSON input without leaking credentials', async () => {
  const f = fixture();
  assert.equal((await f.call('PUT', {}, { 'Content-Type': 'text/plain' })).status, 415);
  for (const raw of ['{', '[]', 'null']) assert.equal((await f.call('PUT', {}, {}, raw)).status, 400);
  const tooLarge = await f.call('PUT', {}, {}, JSON.stringify({ label: '测'.repeat(800) }));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(f.calls, []);
});

void test('channel storage conflicts and temporary failures preserve their error semantics', async () => {
  const f = fixture();
  f.reject(new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_STALE', 409));
  const conflict = await f.call('PUT', { deviceToken: DEVICE_TOKEN, label: 'My iPhone', expectedRevision: 0 });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { code: string }).code, 'NATIVE_HEALTH_CHANNEL_STALE');
  f.reject(new Error('PRIVATE storage failure'));
  const unavailable = await f.call('GET');
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /PRIVATE/);
});
