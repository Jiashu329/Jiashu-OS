import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import { HealthValidationError, MAX_SYNC_BYTES, measurementDay, type HealthSyncPayload } from '../../../../lib/health.ts';
import { parseMobileSyncPayload } from '../../../../lib/mobile-sync.ts';
import { hashSyncToken, isSyncToken } from '../../sync/devices/tokens.ts';
import { HealthImportConflictError } from '../../../../db/health-import-store.ts';
import { emptySyncSummary, syncAttemptStatus, syncPayloadSummary, withEmptySleepRequest, SYNC_FAILURES } from '../../../../lib/sync-diagnostics.ts';
import type { SyncAttemptInput } from '../../../../db/sync-attempts-store.ts';

const ORIGIN = 'https://synthetic-health.example';
const EXPORTED_AT = '2026-11-09T14:00:00+08:00';
class SyncDeviceInvalidError extends Error {}

interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  lastSync: string;
  sleepStatus?: 'recorded' | 'no-asleep-data';
  sleepDays?: number;
  message?: string;
}
interface ImportError {
  error: string;
  code: string;
  issues: Array<{ path: string; message: string }>;
}
async function readImport(response: Response): Promise<ImportResult> {
  return await response.json() as ImportResult;
}
async function readError(response: Response): Promise<ImportError> {
  return await response.json() as ImportError;
}

// Exercise the actual POST and adapter. Only request identity and the
// repository are supplied at the route's external boundaries.
function loadExports(path: URL, bindings: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export /gm, '');
  return compileFunction(source + '\nreturn {' + names.join(',') + '};', Object.keys(bindings))(...Object.values(bindings));
}

function fixture(options: { signedIn?: boolean } = {}) {
  const writes: HealthSyncPayload[] = [];
  let unchanged = false;
  const attempts: SyncAttemptInput[] = [];
  let rejection: Error | null = null;
  let reads = 0;
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => options.signedIn === false ? null : ({ userId: 'synthetic-owner' }),
  }, ['apiUser', 'json', 'unauthenticated', 'unavailable', 'isSameOrigin', 'invalidOrigin']);
  const route = loadExports(new URL('./route.ts', import.meta.url), {
    ...shared, HealthValidationError, MAX_SYNC_BYTES, measurementDay,
    parseMobileSyncPayload, hashSyncToken, isSyncToken, SyncDeviceInvalidError,
    HealthImportConflictError, emptySyncSummary, syncAttemptStatus, syncPayloadSummary, withEmptySleepRequest, SYNC_FAILURES,
    saveSyncAttempt: async (_userId: string, attempt: SyncAttemptInput) => { attempts.push(attempt); },
    readImportHistory: async (userId: string) => { assert.equal(userId, 'synthetic-owner'); reads++; return []; },
    readSyncDiagnostics: async (userId: string) => { assert.equal(userId, 'synthetic-owner'); return { attempts: [], metricStatus: [] }; },
    findSyncDevice: async () => 'synthetic-device',
    importHealth: async (userId: string, payload: HealthSyncPayload) => {
      assert.equal(userId, 'synthetic-owner');
      if (rejection) throw rejection;
      writes.push(payload);
      return { ok: true, imported: unchanged ? 0 : payload.measurements.length,
        skipped: unchanged ? payload.measurements.length : 0, lastSync: EXPORTED_AT };
    },
  }, ['POST', 'GET']) as { POST(request: Request): Promise<Response>; GET(): Promise<Response> };
  return {
    writes,
    attempts,
    get reads() { return reads; },
    get() { return route.GET(); },
    reject(error: Error) { rejection = error; },
    markUnchanged() { unchanged = true; },
    post(payload: unknown) {
      return route.POST(new Request(ORIGIN + '/api/health/import', {
        method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }));
    },
  };
}

void test('diagnostic history returns a server verification timestamp and does not read data before authentication', async () => {
  const f = fixture(); const response = await f.get();
  assert.equal(response.status, 200);
  const data = await response.json() as { checkedAt: string; attempts: unknown[]; batches: unknown[] };
  assert.ok(Number.isFinite(Date.parse(data.checkedAt))); assert.deepEqual(data.attempts, []); assert.deepEqual(data.batches, []);
  assert.equal(f.reads, 1); assert.equal(f.writes.length, 0);
  const anonymous = fixture({ signedIn: false }); assert.equal((await anonymous.get()).status, 401); assert.equal(anonymous.reads, 0);
});

function segment(day: string, state = 1) {
  return { state, startDate: day + 'T01:00:00+08:00', endDate: day + 'T07:00:00+08:00' };
}

function upload(segments: unknown[], days?: unknown) {
  return {
    version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai',
    exportedAt: EXPORTED_AT, measurements: [] as unknown[],
    sleepReport: { day: '2026-11-09', source: 'selected-watch', segments,
      ...(days === undefined ? {} : { days }) },
  };
}

void test('multi-day sleep is recorded when earlier nights have data and the final day has none', async () => {
  const f = fixture();
  const response = await f.post(upload([segment('2026-11-07'), segment('2026-11-08'), segment('2026-11-09', 2)], 3));
  assert.equal(response.status, 200);
  const result = await readImport(response);
  assert.equal(result.sleepStatus, 'recorded');
  assert.equal(result.sleepDays, 2);
  assert.equal(result.imported, 2);
  assert.deepEqual(f.writes[0].measurements.map(measurementDay), ['2026-11-07', '2026-11-08']);
});

void test('a report with no asleep data across its range returns zero days without fabricating or deleting records', async () => {
  const f = fixture();
  const response = await f.post(upload([segment('2026-11-07', 0), segment('2026-11-08', 2)], 3));
  assert.equal(response.status, 200);
  const result = await readImport(response);
  assert.equal(result.sleepStatus, 'no-asleep-data');
  assert.equal(result.sleepDays, 0);
  assert.equal(result.imported, 0);
  assert.ok(typeof result.message === 'string');
  assert.match(result.message, /本次日期范围/);
  assert.match(result.message, /不补零/);
  assert.match(result.message, /已有睡眠记录会保留/);
  assert.deepEqual(f.writes[0].measurements, []);
  assert.equal(f.attempts[0].status, 'empty');
  assert.deepEqual(f.attempts[0].summary?.metrics.map((row) => [row.metric, row.received, row.from, row.to]), [['sleep', 0, '2026-11-07', '2026-11-09']]);
});

void test('invalid payload diagnostics retain only a fixed code and unknown scope', async () => {
  const f = fixture(); const response = await f.post({ secret: 'synthetic-invalid-body', measurements: 'bad' });
  assert.equal(response.status, 400); assert.equal(f.writes.length, 0);
  assert.equal(f.attempts[0].errorCode, 'SYNC_INVALID_FORMAT');
  assert.equal(f.attempts[0].summary?.known, false); assert.equal(f.attempts[0].summary?.received, null);
  assert.doesNotMatch(JSON.stringify(f.attempts), /synthetic-invalid-body|secret/);
});

void test('source conflict produces a safe persisted result while preserving the 409 confirmation boundary', async () => {
  const f = fixture(); f.reject(new HealthImportConflictError('HEALTH_IMPORT_SOURCE_CONFIRMATION', '请确认来源变化'));
  const response = await f.post(upload([segment('2026-11-09')]));
  assert.equal(response.status, 409); assert.equal(f.writes.length, 0);
  assert.equal(f.attempts[0].status, 'failed'); assert.equal(f.attempts[0].errorCode, 'HEALTH_IMPORT_SOURCE_CONFIRMATION');
  assert.equal(f.attempts[0].summary?.metrics[0].metric, 'sleep');
  assert.equal(f.attempts[0].summary?.metrics[0].updated, 0);
});

void test('failed server previews retain safe diagnostics while valid previews make no diagnostic or health writes', async () => {
  const attempts: SyncAttemptInput[] = []; let previews = 0;
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), { getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => ({ userId: 'synthetic-owner' }) }, ['apiUser','json','unauthenticated','unavailable','isSameOrigin','invalidOrigin']);
  const route = loadExports(new URL('./preview/route.ts', import.meta.url), { ...shared, HealthValidationError, MAX_SYNC_BYTES, parseMobileSyncPayload, emptySyncSummary, syncPayloadSummary,
    SyncDeviceInvalidError, HealthImportConflictError, hashSyncToken, isSyncToken, SYNC_FAILURES, findSyncDevice: async () => 'synthetic-device',
    saveSyncAttempt: async (owner: string, input: SyncAttemptInput) => { assert.equal(owner,'synthetic-owner'); attempts.push(input); },
    previewImport: async (_owner: string, _payload: HealthSyncPayload) => { previews++; return { token: 'a'.repeat(64) }; },
  }, ['POST']) as { POST(request: Request): Promise<Response> };
  const request = (value: unknown) => new Request(ORIGIN+'/api/health/import/preview',{ method:'POST', headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(value) });
  assert.equal((await route.POST(request(upload([])))).status,200); assert.equal(previews,1); assert.equal(attempts.length,0);
  assert.equal((await route.POST(request({secret:'synthetic-invalid-preview'}))).status,400); assert.equal(previews,1); assert.equal(attempts.length,1);
  assert.equal(attempts[0].errorCode,'SYNC_INVALID_FORMAT'); assert.equal(attempts[0].summary?.known,false); assert.doesNotMatch(JSON.stringify(attempts),/synthetic-invalid-preview|secret/);
});

void test('import preview resolves device credentials within the authenticated owner and preserves channel conflicts', async () => {
  const attempts: SyncAttemptInput[] = [];
  const resolved: { owner: string; hash: string }[] = [];
  const previewed: { owner: string; deviceId: string | null }[] = [];
  const token = 'jso_sync_' + 'a'.repeat(43);
  let activeDevice: string | null = 'synthetic-native-device';
  let conflict: Error | null = null;
  const shared = loadExports(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }),
    getChatGPTUser: async () => ({ userId: 'synthetic-owner' }),
  }, ['apiUser', 'json', 'unauthenticated', 'unavailable', 'isSameOrigin', 'invalidOrigin']);
  const route = loadExports(new URL('./preview/route.ts', import.meta.url), {
    ...shared, HealthValidationError, MAX_SYNC_BYTES, parseMobileSyncPayload, emptySyncSummary, syncPayloadSummary,
    SyncDeviceInvalidError, HealthImportConflictError, hashSyncToken, isSyncToken, SYNC_FAILURES,
    saveSyncAttempt: async (_owner: string, input: SyncAttemptInput) => { attempts.push(input); },
    findSyncDevice: async (owner: string, hash: string) => { resolved.push({ owner, hash }); return activeDevice; },
    previewImport: async (owner: string, _payload: HealthSyncPayload, deviceId: string | null) => {
      if (conflict) throw conflict;
      previewed.push({ owner, deviceId }); return { token: 'a'.repeat(64) };
    },
  }, ['POST']) as { POST(request: Request): Promise<Response> };
  const post = (deviceToken?: string) => route.POST(new Request(ORIGIN + '/api/health/import/preview', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(deviceToken === undefined ? {} : { 'X-Sync-Device': deviceToken }) },
    body: JSON.stringify(upload([segment('2026-11-09')])),
  }));
  assert.equal((await post()).status, 200);
  assert.deepEqual(previewed[0], { owner: 'synthetic-owner', deviceId: null });
  assert.equal((await post(token)).status, 200);
  assert.deepEqual(resolved[0], { owner: 'synthetic-owner', hash: await hashSyncToken(token) });
  assert.deepEqual(previewed[1], { owner: 'synthetic-owner', deviceId: 'synthetic-native-device' });
  assert.equal(attempts.length, 0);
  activeDevice = null;
  assert.equal((await post(token)).status, 403);
  assert.equal(attempts.at(-1)?.channel, 'device');
  assert.equal(attempts.at(-1)?.errorCode, 'SYNC_DEVICE_INVALID');
  const beforeMalformed = resolved.length;
  assert.equal((await post('invalid-device-secret')).status, 403);
  assert.equal(resolved.length, beforeMalformed);
  activeDevice = 'synthetic-native-device';
  conflict = new HealthImportConflictError('HEALTH_SYNC_CHANNEL_REQUIRED', '请使用当前选定的健康同步设备。');
  const response = await post(token);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, 'HEALTH_SYNC_CHANNEL_REQUIRED');
  assert.doesNotMatch(JSON.stringify(attempts), /jso_sync_|invalid-device-secret/);
});

void test('sleep outside the requested range cannot make an empty report look recorded', async () => {
  const f = fixture();
  const payload = upload([], 7);
  payload.measurements.push({ id: 'outside-sleep', metric: 'sleep', value: 6,
    unit: 'hours', aggregation: 'daily', source: 'selected-watch',
    startDate: '2026-11-02T01:00:00+08:00', endDate: '2026-11-02T07:00:00+08:00' });
  const response = await f.post(payload);
  assert.equal(response.status, 200);
  const result = await readImport(response);
  assert.equal(result.sleepStatus, 'no-asleep-data');
  assert.equal(result.sleepDays, 0);
  assert.equal(result.imported, 1);
  assert.equal(f.writes[0].measurements.length, 1);
  assert.deepEqual(f.attempts[0].summary?.emptySleepWindow, { from: '2026-11-03', to: '2026-11-09' });
});

void test('the earliest requested day is counted and unchanged reuploads retain their recorded status', async () => {
  const f = fixture();
  const payload = upload([segment('2026-11-03')], 7);
  const first = await f.post(payload);
  assert.equal(first.status, 200);
  assert.equal((await readImport(first)).sleepDays, 1);
  f.markUnchanged();
  const second = await f.post(payload);
  assert.equal(second.status, 200);
  const result = await readImport(second);
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.sleepStatus, 'recorded');
  assert.equal(result.sleepDays, 1);
  assert.deepEqual(f.writes[0], f.writes[1]);
});

void test('omitted range remains a single-day report and ordinary health uploads omit sleep status', async () => {
  const f = fixture();
  const single = await f.post(upload([segment('2026-11-08'), segment('2026-11-09')]));
  assert.equal(single.status, 200);
  const singleResult = await readImport(single);
  assert.equal(singleResult.sleepStatus, 'recorded');
  assert.equal(singleResult.sleepDays, 1);
  assert.deepEqual(f.writes[0].measurements.map(measurementDay), ['2026-11-09']);
  const { sleepReport: _unused, ...ordinaryPayload } = upload([]);
  const ordinary = await f.post(ordinaryPayload);
  assert.equal(ordinary.status, 200);
  const result = await readImport(ordinary);
  assert.equal(Object.hasOwn(result, 'sleepStatus'), false);
  assert.equal(Object.hasOwn(result, 'sleepDays'), false);
});

void test('invalid sleep range types and bounds fail before writing to the repository', async () => {
  const f = fixture();
  for (const days of [null, '7', true, 0, -1, 31, 1.5]) {
    const response = await f.post(upload([segment('2026-11-09')], days));
    assert.equal(response.status, 400, String(days));
    const result = await readError(response);
    assert.equal(result.code, 'INVALID_HEALTH_SYNC');
    assert.equal(result.error, '同步数据格式不正确，请检查数据类型、单位、日期和每日汇总设置。');
    assert.ok(result.issues.some((issue) => issue.path === 'sleepReport.days'));
  }
  assert.deepEqual(f.writes, []);
});

void test('an unknown sleep state identifies its one-based segment without echoing health values', async () => {
  const f = fixture();
  const unknown = { ...segment('2026-11-09'), state: 'synthetic-unknown-state' };
  const response = await f.post(upload([segment('2026-11-08'), unknown], 30));
  assert.equal(response.status, 400);
  const result = await readError(response);
  assert.equal(result.code, 'INVALID_HEALTH_SYNC');
  assert.match(result.error, /第 2 段的睡眠状态无法识别/);
  assert.match(result.error, /原健康样本的 0–5 状态编号或支持的状态名称/);
  assert.equal(result.issues[0].path, 'sleepReport.segments[1].state');
  assert.equal(result.error.includes(unknown.state), false);
  assert.equal(result.error.includes(unknown.startDate), false);
  assert.deepEqual(f.writes, []);
});

void test('a 30-day iPhone upload accepts Chinese sleep labels and excludes awake time', async () => {
  const f = fixture();
  const payload = upload([
    { state: '核心睡眠', startDate: '2026-10-12T00:00:00+08:00', endDate: '2026-10-12T01:00:00+08:00' },
    { state: '清醒时间', startDate: '2026-10-12T01:00:00+08:00', endDate: '2026-10-12T01:30:00+08:00' },
    { state: '深度睡眠', startDate: '2026-10-12T01:30:00+08:00', endDate: '2026-10-12T02:00:00+08:00' },
    { state: '快速动眼睡眠', startDate: '2026-10-12T02:00:00+08:00', endDate: '2026-10-12T03:00:00+08:00' },
    { state: '核心睡眠', startDate: '2026-10-20T00:00:00+08:00', endDate: '2026-10-20T01:00:00+08:00' },
  ], 30);
  payload.sleepReport.source = 'iPhone';
  const response = await f.post(payload);
  assert.equal(response.status, 200);
  const result = await readImport(response);
  assert.equal(result.sleepStatus, 'recorded');
  assert.equal(result.sleepDays, 2);
  assert.equal(result.imported, 2);
  assert.deepEqual(f.writes[0].measurements.map((record) => [measurementDay(record), record.value, record.source]), [
    ['2026-10-12', 2.5, 'iPhone'], ['2026-10-20', 1, 'iPhone'],
  ]);
});
