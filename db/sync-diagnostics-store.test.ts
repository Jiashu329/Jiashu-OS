import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { measurementDay, measurementKey, shanghaiDay } from '../lib/health.ts';
import type { HealthSyncPayload } from '../lib/health.ts';
import { buildSyncDiagnostics } from '../lib/sync-diagnostics.ts';
import { readEffectiveHealthMeasurements } from './health-records-store.ts';
import { readSyncImportDiagnostics } from './sync-diagnostics-store.ts';
import * as importStore from './health-import-store.ts';
import * as attemptStore from './sync-attempts-store.ts';

type LocalStatement = { bind(...values: unknown[]): LocalStatement; execute(): { meta: { changes: number } } };
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  let beforeBatch: (() => void) | undefined;
  t.after(() => sqlite.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        execute() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
      };
      return bound;
    },
    async batch(statements: LocalStatement[]) {
      const callback = beforeBatch; beforeBatch = undefined; callback?.();
      sqlite.exec('BEGIN');
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  const bindings = { env: { DB: db }, measurementDay, measurementKey, shanghaiDay, ...importStore, ...attemptStore, readSyncImportDiagnostics,
    readEffectiveHealthMeasurements, buildSyncDiagnostics };
  const source = stripTypeScriptTypes(readFileSync(new URL('./health-repository.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s+\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
  const actualRepository = compileFunction(source + '\nreturn { importHealth, readSyncStatus, readSyncDiagnostics, SyncDeviceInvalidError };', Object.keys(bindings))(...Object.values(bindings)) as {
    importHealth(user: string, payload: HealthSyncPayload, deviceId?: string | null, options?: importStore.HealthImportOptions): Promise<{ imported: number; skipped: number; replayed: boolean }>;
    readSyncStatus(user: string): Promise<ReturnType<typeof buildSyncDiagnostics>>;
    readSyncDiagnostics(user: string): Promise<{ metricStatus: Array<{ metric: string; lastRecordDate: string | null; observedDays7: number; observedDays30: number }> }>;
    SyncDeviceInvalidError: new () => Error;
  };
  const repository = { ...actualRepository, async importHealth(user: string, input: HealthSyncPayload, deviceId: string | null = null) {
    const options = deviceId ? {} : { previewToken: (await importStore.previewHealthImport(db, user, input)).token, confirmSourceChanges: true };
    return actualRepository.importHealth(user, input, deviceId, options);
  } };
  return { sqlite, db, repository, race(callback: () => void) { beforeBatch = callback; } };
}

function payload(day = '2026-11-12', exportedAt = '2026-11-12T02:00:00.000Z'): HealthSyncPayload {
  return { version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt,
    measurements: [{ id: 'synthetic-step', metric: 'steps', value: 1234, unit: 'count', aggregation: 'daily', startDate: day + 'T01:00:00.000Z' }] };
}

void test('repository saves exact changed and skipped counts atomically and only updates included metrics', async (t) => {
  const { db, repository } = fixture(t);
  const batch = payload();
  batch.measurements.push({ id: 'weight-one', metric: 'weight', value: 65, unit: 'kg', startDate: '2026-11-10T01:00:00.000Z' });
  assert.deepEqual(await repository.importHealth('alice', batch).then(({ imported, skipped }) => ({ imported, skipped })), { imported: 2, skipped: 0 });
  const first = await readSyncImportDiagnostics(db, 'alice');
  assert.equal(first.find((row) => row.scope === 'batch')!.importedCount, 2);
  assert.equal(first.find((row) => row.scope === 'weight')!.lastDay, '2026-11-10');
  await repository.importHealth('alice', payload('2026-11-12', '2026-11-12T03:00:00.000Z'));
  const afterSteps = await readSyncImportDiagnostics(db, 'alice');
  assert.deepEqual(afterSteps.find((row) => row.scope === 'weight'), first.find((row) => row.scope === 'weight'));
  const replay = await repository.importHealth('alice', batch);
  assert.equal(replay.replayed, true);
  assert.equal(replay.imported, 2);
  assert.equal(replay.skipped, 0);
  const last = (await readSyncImportDiagnostics(db, 'alice')).find((row) => row.scope === 'batch')!;
  assert.equal(last.importedCount, 0);
  assert.equal(last.skippedCount, 1);
  assert.equal(last.firstDay, '2026-11-12');
  assert.deepEqual(last, afterSteps.find((row) => row.scope === 'batch'));
  assert.equal(last.lastDay, '2026-11-12');
  assert.deepEqual(await readSyncImportDiagnostics(db, 'bob'), []);
});

void test('empty batches leave metric import receipts and effective measurement freshness unchanged', async (t) => {
  const { db, repository } = fixture(t);
  await repository.importHealth('alice', payload('2026-10-01'));
  const first = (await readSyncImportDiagnostics(db, 'alice')).find((row) => row.scope === 'steps')!;
  await repository.importHealth('alice', { ...payload(), measurements: [] });
  const after = await readSyncImportDiagnostics(db, 'alice');
  assert.deepEqual(after.find((row) => row.scope === 'steps'), first);
  assert.equal(after.find((row) => row.scope === 'batch')!.submittedCount, 0);
  assert.equal(after.find((row) => row.scope === 'batch')!.importedCount, 0);
  const view = await repository.readSyncStatus('alice');
  assert.equal(view.metrics.find((row) => row.metric === 'steps')!.latestDay, '2026-10-01');
  assert.equal(view.metrics.find((row) => row.metric === 'sleep')!.latestDay, null);
});

void test('a revoked connection cannot change measurements, receipts or diagnostics', async (t) => {
  const { sqlite, db, repository } = fixture(t);
  sqlite.prepare('INSERT INTO sync_devices (id,user_id,label,token_hash,created_at,revoked_at) VALUES (?,?,?,?,?,?)')
    .run('revoked-device', 'alice', 'synthetic', 'hash', '2026-11-12T00:00:00.000Z', '2026-11-12T01:00:00.000Z');
  await assert.rejects(repository.importHealth('alice', payload(), 'revoked-device'), repository.SyncDeviceInvalidError);
  assert.deepEqual(await readSyncImportDiagnostics(db, 'alice'), []);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM health_measurements').get()!.count, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM health_syncs').get()!.count, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM health_import_batches').get()!.count, 0);
});

void test('a valid connection records use and exact batch counts without granting access to another owner', async (t) => {
  const { sqlite, db, repository } = fixture(t);
  sqlite.prepare('INSERT INTO sync_devices (id,user_id,label,token_hash,created_at) VALUES (?,?,?,?,?)')
    .run('active-device', 'alice', 'synthetic', 'hash', '2026-11-12T00:00:00.000Z');
  const result = await repository.importHealth('alice', payload(), 'active-device');
  assert.equal(result.imported, 1);
  const batch = (await readSyncImportDiagnostics(db, 'alice')).find((row) => row.scope === 'batch')!;
  assert.equal(batch.importedCount, 1);
  assert.equal(batch.skippedCount, 0);
  assert.ok(sqlite.prepare('SELECT last_used_at FROM sync_devices WHERE id=?').get('active-device')!.last_used_at);
  await assert.rejects(repository.importHealth('bob', payload(), 'active-device'), repository.SyncDeviceInvalidError);
  assert.deepEqual(await readSyncImportDiagnostics(db, 'bob'), []);
});

void test('a diagnostics write failure rolls back raw measurements and the import receipt', async (t) => {
  const { sqlite, db, repository } = fixture(t);
  sqlite.exec("CREATE TRIGGER reject_diagnostics BEFORE INSERT ON health_sync_diagnostics BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  await assert.rejects(repository.importHealth('alice', payload()), /synthetic failure/);
  assert.deepEqual(await readSyncImportDiagnostics(db, 'alice'), []);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM health_measurements').get()!.count, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM health_syncs').get()!.count, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM health_import_batches').get()!.count, 0);
});

void test('coverage follows audited effective records rather than hidden sync originals', async (t) => {
  const { sqlite, repository } = fixture(t);
  await repository.importHealth('alice', payload());
  sqlite.prepare(`INSERT INTO health_record_overrides
    (user_id,record_key,metric,day,deleted,revision,last_change_id,created_at,updated_at)
    VALUES (?,?,?,?,1,1,?,?,?)`).run('alice', 'steps:2026-11-12', 'steps', '2026-11-12', 'change', 'now', 'now');
  const view = await repository.readSyncStatus('alice');
  assert.equal(view.metrics.find((row) => row.metric === 'steps')!.latestDay, null);
  assert.equal(view.metrics.find((row) => row.metric === 'steps')!.observedDays7, 0);
  assert.equal(view.lastImport!.importedCount, 1);
  const merged = (await repository.readSyncDiagnostics('alice')).metricStatus.find((row) => row.metric === 'steps')!;
  assert.equal(merged.lastRecordDate, null);
  assert.equal(merged.observedDays7, 0);
});

void test('a preview race cannot overwrite diagnostics unless this operation owns the import receipt', async (t) => {
  const f = fixture(t);
  await f.repository.importHealth('alice', payload());
  const before = await readSyncImportDiagnostics(f.db, 'alice');
  const changed = payload('2026-11-12', '2026-11-12T03:00:00.000Z');
  changed.measurements[0].value = 4321;
  f.race(() => f.sqlite.prepare('UPDATE health_measurements SET exported_at=? WHERE user_id=?')
    .run('2026-11-12T04:00:00.000Z', 'alice'));
  await assert.rejects(f.repository.importHealth('alice', changed), importStore.HealthImportConflictError);
  assert.deepEqual(await readSyncImportDiagnostics(f.db, 'alice'), before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM health_import_batches').get()!.count, 1);
});

void test('rollback and identical retry do not reapply records or replace the successful import diagnostics', async (t) => {
  const f = fixture(t);
  await f.repository.importHealth('alice', payload());
  const before = await readSyncImportDiagnostics(f.db, 'alice');
  const batch = (await importStore.listHealthImports(f.db, 'alice'))[0];
  await importStore.revertHealthImport(f.db, 'alice', batch.batchId, 'synthetic wrong source');
  assert.equal((await f.repository.readSyncStatus('alice')).metrics.find((row) => row.metric === 'steps')!.latestDay, null);
  assert.equal((await f.repository.importHealth('alice', payload())).replayed, true);
  assert.deepEqual(await readSyncImportDiagnostics(f.db, 'alice'), before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM health_measurements').get()!.count, 0);
});
