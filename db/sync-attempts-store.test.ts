import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { parseSyncPayload, type HealthSyncPayload } from '../lib/health.ts';
import { emptySyncSummary, parseSyncAttemptSummary, syncAttemptStatus, syncPayloadSummary, withEmptySleepRequest } from '../lib/sync-diagnostics.ts';
import { HealthImportConflictError, previewHealthImport, revertHealthImport, writeHealthImport } from './health-import-store.ts';
import { listSyncAttempts, readSyncMetricStatus, recordSyncAttempt, type SyncAttemptsDatabase } from './sync-attempts-store.ts';

const NOW = '2026-11-10T09:00:00.000Z';
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(dir).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound = { bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return statement.get(...values) as T ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; } };
      return bound;
    },
    async batch(commands: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec('BEGIN'); try { const result = []; for (const command of commands) result.push(await command.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as SyncAttemptsDatabase;
  return { db, sqlite };
}
function payload(value = 5000, source = 'watch', exportedAt = NOW): HealthSyncPayload {
  return parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt,
    measurements: [{ id: 'synthetic-steps', metric: 'steps', value, unit: 'count', source, aggregation: 'daily', startDate: '2026-11-10T00:00:00+08:00', endDate: '2026-11-10T12:00:00+08:00' }] });
}
async function receive(db: SyncAttemptsDatabase, input: HealthSyncPayload, at = NOW) {
  const preview = await previewHealthImport(db, 'alice', input);
  const saved = await writeHealthImport(db, 'alice', input, null, { previewToken: preview.token, confirmSourceChanges: true }, at);
  await recordSyncAttempt(db, 'alice', { channel: 'manual', status: syncAttemptStatus(saved, saved.attemptSummary), batchId: saved.batchId, summary: saved.attemptSummary }, at);
  return saved;
}

test('steps receipt persists source, exact scope and outcome without implying that sleep updated', async (t) => {
  const f = fixture(t); await receive(f.db, payload());
  const [attempt] = await listSyncAttempts(f.db, 'alice');
  assert.doesNotThrow(() => parseSyncAttemptSummary(attempt.summary));
  assert.equal(attempt.status, 'success'); assert.equal(attempt.summary.received, 1);
  assert.deepEqual(attempt.summary.metrics.map((row) => row.metric), ['steps']);
  assert.equal(attempt.summary.metrics[0].added, 1); assert.deepEqual(attempt.summary.metrics[0].sources, ['watch']);
  const status = await readSyncMetricStatus(f.db, 'alice');
  assert.equal(status.find((row) => row.metric === 'steps')?.lastRecordDate, '2026-11-10');
  assert.equal(status.find((row) => row.metric === 'steps')?.lastReceivedAt, NOW);
  assert.equal(status.find((row) => row.metric === 'sleep')?.lastReceivedAt, null);
  assert.equal(status.find((row) => row.metric === 'sleep')?.lastRecordDate, null);
  const text = JSON.stringify(attempt); assert.doesNotMatch(text, /"value"|5000|measurementJson|token|jso_sync_/);
});

test('backup receipt validation accepts generated metadata but rejects raw values and malformed scope', () => {
  const summary = syncPayloadSummary(payload()); assert.doesNotThrow(() => parseSyncAttemptSummary(summary));
  assert.doesNotThrow(() => parseSyncAttemptSummary(emptySyncSummary()));
  assert.throws(() => parseSyncAttemptSummary({ ...summary, rawPayload: { value: 5000 } }));
  assert.throws(() => parseSyncAttemptSummary({ ...summary, metrics: [{ ...summary.metrics[0], value: 5000 }] }));
  assert.throws(() => parseSyncAttemptSummary({ ...summary, metrics: [{ ...summary.metrics[0], metric: 'unknown' }] }));
  assert.throws(() => parseSyncAttemptSummary({ ...summary, metrics: [{ ...summary.metrics[0], added: 1000 }] }));
  assert.throws(() => parseSyncAttemptSummary({ ...emptySyncSummary(), received: 0 }));
});

test('empty sleep, duplicate payload and an older export have distinct persisted explanations', async (t) => {
  const f = fixture(t); const original = payload(); await receive(f.db, original);
  await receive(f.db, original, '2026-11-10T10:00:00.000Z');
  let rows = await listSyncAttempts(f.db, 'alice'); assert.equal(rows[0].status, 'duplicate'); assert.equal(rows[0].summary.metrics[0].added, 0);
  assert.equal(rows[0].summary.metrics[0].unchanged, 1);
  await receive(f.db, payload(4000, 'watch', '2026-11-10T08:00:00.000Z'), '2026-11-10T11:00:00.000Z');
  rows = await listSyncAttempts(f.db, 'alice'); assert.equal(rows[0].status, 'unchanged'); assert.equal(rows[0].summary.metrics[0].older, 1);
  const empty = parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: NOW, measurements: [] });
  const summary = withEmptySleepRequest(syncPayloadSummary(empty), { from: '2026-11-04', to: '2026-11-10', source: 'watch' });
  await recordSyncAttempt(f.db, 'alice', { channel: 'manual', status: syncAttemptStatus({}, summary), summary }, '2026-11-10T12:00:00.000Z');
  rows = await listSyncAttempts(f.db, 'alice'); assert.equal(rows[0].status, 'empty'); assert.equal(rows[0].summary.metrics[0].metric, 'sleep');
  assert.equal(rows[0].summary.metrics[0].received, 0); assert.equal((await readSyncMetricStatus(f.db, 'alice')).find((row) => row.metric === 'sleep')?.lastReceivedAt, null);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM health_measurements').get()?.n, 1);
});

test('source switching retains a safe failed receipt and never writes without explicit confirmation', async (t) => {
  const f = fixture(t); await receive(f.db, payload());
  f.sqlite.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?,?)').run('device', 'alice', '我的手表', 'synthetic-private-hash', NOW, null, null);
  const switched = payload(7000, 'phone', '2026-11-10T10:00:00.000Z');
  await assert.rejects(writeHealthImport(f.db, 'alice', switched, 'device'), (error) => error instanceof HealthImportConflictError && error.code === 'HEALTH_IMPORT_SOURCE_CONFIRMATION');
  await recordSyncAttempt(f.db, 'alice', { channel: 'device', deviceId: 'device', status: 'failed', errorCode: 'HEALTH_IMPORT_SOURCE_CONFIRMATION', summary: syncPayloadSummary(switched) }, '2026-11-10T10:00:00.000Z');
  const [attempt] = await listSyncAttempts(f.db, 'alice'); assert.equal(attempt.deviceLabel, '我的手表'); assert.match(attempt.guidance!, /确认切换/);
  assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT measurement_json FROM health_measurements').get()?.measurement_json)).source, 'watch');
  assert.doesNotMatch(JSON.stringify(attempt), /synthetic-private-hash|7000/);
  assert.equal((await listSyncAttempts(f.db, 'bob')).length, 0);
});

test('reverted batches no longer count as received data for first-sync verification', async (t) => {
  const f = fixture(t); const saved = await receive(f.db, payload()); await revertHealthImport(f.db, 'alice', saved.batchId, 'wrong day');
  assert.equal((await listSyncAttempts(f.db, 'alice'))[0].status, 'reverted');
  assert.equal((await readSyncMetricStatus(f.db, 'alice')).find((row) => row.metric === 'steps')?.lastReceivedAt, null);
});

test('diagnostics retain only the owner latest 100 attempts and expose the latest 30 without invalid bodies', async (t) => {
  const f = fixture(t);
  await recordSyncAttempt(f.db, 'bob', { channel: 'manual', status: 'failed', errorCode: 'SYNC_INVALID_FORMAT' }, NOW);
  for (let i = 0; i < 105; i++) await recordSyncAttempt(f.db, 'alice', { channel: 'manual', status: 'failed', errorCode: 'SYNC_INVALID_FORMAT', summary: emptySyncSummary() }, new Date(Date.parse(NOW) + i * 1000).toISOString());
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM health_sync_attempts WHERE user_id=?').get('alice')?.n, 100);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM health_sync_attempts WHERE user_id=?').get('bob')?.n, 1);
  assert.equal((await listSyncAttempts(f.db, 'alice')).length, 30);
  assert.deepEqual((await listSyncAttempts(f.db, 'alice'))[0].summary, emptySyncSummary());
});
