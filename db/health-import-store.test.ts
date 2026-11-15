import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { measurementKey, parseSyncPayload, type HealthSyncPayload } from '../lib/health.ts';
import { HealthImportConflictError, listHealthImports, previewHealthImport, revertHealthImport, writeHealthImport, type HealthImportDatabase } from './health-import-store.ts';
import {parseMobileSyncPayload} from '../lib/mobile-sync.ts';

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
  let beforeBatch: (() => void) | undefined;
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return statement.get(...values) as T ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
      };
      return bound;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const callback = beforeBatch; beforeBatch = undefined; callback?.();
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as HealthImportDatabase;
  return { db, sqlite, race(callback: () => void) { beforeBatch = callback; } };
}
function payload(value = 5000, source = 'selected-watch', exportedAt = '2026-11-09T10:00:00.000Z'): HealthSyncPayload {
  return parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt,
    measurements: [{ id: 'steps-nine', metric: 'steps', value, unit: 'count', source, aggregation: 'daily',
      startDate: '2026-11-09T00:00:00+08:00', endDate: '2026-11-09T08:00:00+08:00' }] });
}
function current(sqlite: DatabaseSync, userId = 'alice') {
  return sqlite.prepare('SELECT * FROM health_measurements WHERE user_id=?').all(userId);
}
async function manual(db: HealthImportDatabase, input: HealthSyncPayload, user = 'alice') {
  const preview = await previewHealthImport(db, user, input);
  return writeHealthImport(db, user, input, null, { previewToken: preview.token, confirmSourceChanges: true });
}
function isConflict(code: string) { return (error: unknown) => error instanceof HealthImportConflictError && error.code === code; }
function rollingPayload(exportedAt = '2026-11-09T10:00:00.000Z'): HealthSyncPayload {
  const metrics = [
    ['weight', 70, 'kg'], ['lean_body_mass', 55, 'kg'], ['steps', 7000, 'count'], ['active_energy', 500, 'kcal'], ['sleep', 7, 'hours'],
  ] as const;
  return parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt,
    measurements: Array.from({ length: 30 }, (_, index) => metrics.map(([metric, value, unit]) => {
      const day = '2026-10-' + String(index + 1).padStart(2, '0'), sample = metric === 'weight' || metric === 'lean_body_mass';
      return { id: metric + '-' + index, metric, value, unit, source: 'selected-watch', startDate: day + 'T00:00:00.000Z',
        aggregation: sample ? 'sample' : 'daily', ...(!sample ? { endDate: day + 'T08:00:00.000Z' } : {}) };
    })).flat() });
}

test('manual preview performs no writes and submission requires its exact token', async (t) => {
  const f = fixture(t), input = payload();
  const preview = await previewHealthImport(f.db, 'alice', input);
  assert.equal(preview.added, 1); assert.equal(preview.updated, 0); assert.equal(preview.skipped, 0);
  assert.equal(preview.from, '2026-11-09'); assert.equal(preview.examples[0].after, 5000);
  assert.deepEqual(current(f.sqlite), []);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM health_import_batches').get()?.n, 0);
  await assert.rejects(writeHealthImport(f.db, 'alice', input, null), isConflict('HEALTH_IMPORT_PREVIEW_REQUIRED'));
  await assert.rejects(writeHealthImport(f.db, 'alice', payload(6000), null, { previewToken: preview.token }), isConflict('HEALTH_IMPORT_STALE'));
  assert.equal(current(f.sqlite).length, 0);
  const saved = await writeHealthImport(f.db, 'alice', input, null, { previewToken: preview.token });
  assert.equal(saved.imported, 1); assert.equal(saved.replayed, false);
  assert.equal((await listHealthImports(f.db, 'alice')).length, 1);
});

test('same-source device refresh remains automatic and identical payload replays once', async (t) => {
  const f = fixture(t);
  f.sqlite.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?,?)').run('device', 'alice', 'watch', 'synthetic', '2026-11-09', null, null);
  const input = payload();
  const first = await writeHealthImport(f.db, 'alice', input, 'device');
  const replay = await writeHealthImport(f.db, 'alice', input, 'device');
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
  assert.equal(current(f.sqlite).length, 1);
  const newer = await writeHealthImport(f.db, 'alice', payload(6000, 'selected-watch', '2026-11-09T11:00:00.000Z'), 'device');
  assert.equal(newer.imported, 1);
  assert.equal(JSON.parse(String(current(f.sqlite)[0].measurement_json)).value, 6000);
});

test('additive sleep timing preserves pre-upgrade receipts and explicit rollback for an identical original report',async(t)=>{
  const f=fixture(t),raw={version:1,source:'apple-health-shortcuts',timezone:'Asia/Shanghai',exportedAt:'2026-11-09T05:00:00Z',measurements:[],sleepReport:{day:'2026-11-09',source:'synthetic-watch',segments:[{state:'core',startDate:'2026-11-08T23:00:00+08:00',endDate:'2026-11-09T07:00:00+08:00'}]}};
  const upgraded=parseMobileSyncPayload(raw),legacy={...upgraded,measurements:upgraded.measurements.map((measurement)=>{const {sleepTiming:_timing,...rest}=measurement;return rest;})};
  const first=await manual(f.db,legacy),replay=await manual(f.db,upgraded);assert.equal(replay.replayed,true);assert.equal(replay.batchId,first.batchId);assert.equal((await listHealthImports(f.db,'alice')).length,1);assert.equal(JSON.parse(String(current(f.sqlite)[0].measurement_json)).sleepTiming,undefined);
  await revertHealthImport(f.db,'alice',first.batchId,'synthetic rollback');const rolled=await manual(f.db,upgraded);assert.equal(rolled.replayed,true);assert.equal(rolled.reverted,true);assert.equal(current(f.sqlite).length,0);
  const fresh=parseMobileSyncPayload({...raw,exportedAt:'2026-11-09T06:00:00Z'}),next=await manual(f.db,fresh);assert.equal(next.replayed,false);assert.notEqual(next.batchId,first.batchId);assert.ok(JSON.parse(String(current(f.sqlite)[0].measurement_json)).sleepTiming);
});

test('source changes block automatic import until explicit preview confirmation', async (t) => {
  const f = fixture(t); await manual(f.db, payload());
  f.sqlite.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?,?)').run('device', 'alice', 'watch', 'synthetic', '2026-11-09', null, null);
  const next = payload(7000, 'selected-phone', '2026-11-09T11:00:00.000Z');
  const preview = await previewHealthImport(f.db, 'alice', next);
  assert.equal(preview.sourceChanges, 1); assert.equal(preview.examples[0].oldSource, 'selected-watch');
  await assert.rejects(writeHealthImport(f.db, 'alice', next, 'device'), isConflict('HEALTH_IMPORT_SOURCE_CONFIRMATION'));
  await assert.rejects(writeHealthImport(f.db, 'alice', next, null, { previewToken: preview.token }), isConflict('HEALTH_IMPORT_SOURCE_CONFIRMATION'));
  assert.equal(JSON.parse(String(current(f.sqlite)[0].measurement_json)).source, 'selected-watch');
  await writeHealthImport(f.db, 'alice', next, null, { previewToken: preview.token, confirmSourceChanges: true });
  assert.equal(JSON.parse(String(current(f.sqlite)[0].measurement_json)).source, 'selected-phone');
});

test('manual corrections and hidden state are visible in preview and untouched by import/revert', async (t) => {
  const f = fixture(t); await manual(f.db, payload());
  const override = JSON.stringify({ ...payload().measurements[0], value: 4000 });
  f.sqlite.prepare('INSERT INTO health_record_overrides VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('alice', measurementKey(payload().measurements[0]), 'steps', '2026-11-09', override, 1, 3, 'synthetic-change', '2026-11-09', '2026-11-09');
  const next = payload(8000, 'selected-phone', '2026-11-09T11:00:00.000Z');
  const preview = await previewHealthImport(f.db, 'alice', next);
  assert.equal(preview.manualOverrides, 1); assert.equal(preview.examples[0].manualOverride, true);
  const saved = await writeHealthImport(f.db, 'alice', next, null, { previewToken: preview.token, confirmSourceChanges: true });
  await revertHealthImport(f.db, 'alice', saved.batchId, '选错来源');
  assert.equal(JSON.parse(String(current(f.sqlite)[0].measurement_json)).value, 5000);
  const row = f.sqlite.prepare('SELECT * FROM health_record_overrides WHERE user_id=?').get('alice');
  assert.equal(row?.override_json, override); assert.equal(row?.deleted, 1); assert.equal(row?.revision, 3);
});

test('stale previews fail when base or overlay changes, even if exported timestamp stays equal', async (t) => {
  const f = fixture(t); await manual(f.db, payload());
  const next = payload(6000, 'selected-watch', '2026-11-09T11:00:00.000Z');
  const preview = await previewHealthImport(f.db, 'alice', next);
  f.sqlite.prepare('UPDATE health_measurements SET measurement_json=? WHERE user_id=?').run(JSON.stringify(payload(4000).measurements[0]), 'alice');
  await assert.rejects(writeHealthImport(f.db, 'alice', next, null, { previewToken: preview.token }), isConflict('HEALTH_IMPORT_STALE'));
  const fresh = await previewHealthImport(f.db, 'alice', next);
  f.sqlite.prepare('INSERT INTO health_record_overrides VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('alice', measurementKey(next.measurements[0]), 'steps', '2026-11-09', null, 1, 1, 'hide', '2026-11-09', '2026-11-09');
  await assert.rejects(writeHealthImport(f.db, 'alice', next, null, { previewToken: fresh.token }), isConflict('HEALTH_IMPORT_STALE'));
});

test('database race after planning is rejected atomically without receipt or partial update', async (t) => {
  const f = fixture(t); await manual(f.db, payload());
  const next = payload(6000, 'selected-watch', '2026-11-09T11:00:00.000Z');
  const preview = await previewHealthImport(f.db, 'alice', next);
  f.race(() => f.sqlite.prepare('UPDATE health_measurements SET received_at=? WHERE user_id=?').run('2026-11-09T12:00:00.000Z', 'alice'));
  await assert.rejects(writeHealthImport(f.db, 'alice', next, null, { previewToken: preview.token }), isConflict('HEALTH_IMPORT_STALE'));
  assert.equal(JSON.parse(String(current(f.sqlite)[0].measurement_json)).value, 5000);
  assert.equal((await listHealthImports(f.db, 'alice')).length, 1);
});

test('connection revocation racing commit leaves no records and no receipt', async (t) => {
  const f = fixture(t);
  f.sqlite.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?,?)').run('device', 'alice', 'watch', 'synthetic', '2026-11-09', null, null);
  f.race(() => f.sqlite.prepare('UPDATE sync_devices SET revoked_at=?').run('2026-11-09'));
  await assert.rejects(writeHealthImport(f.db, 'alice', payload(), 'device'), isConflict('SYNC_DEVICE_INVALID'));
  assert.equal(current(f.sqlite).length, 0); assert.equal((await listHealthImports(f.db, 'alice')).length, 0);
});

test('rollback removes new originals, keeps audit and replay does not reapply reverted payload', async (t) => {
  const f = fixture(t), input = payload();
  const saved = await manual(f.db, input);
  await revertHealthImport(f.db, 'alice', saved.batchId, '误导入测试数据');
  assert.equal(current(f.sqlite).length, 0);
  const again = await revertHealthImport(f.db, 'alice', saved.batchId, '重复确认');
  assert.equal(again.replayed, true);
  const replay = await writeHealthImport(f.db, 'alice', input, null);
  assert.equal(replay.replayed, true); assert.equal(replay.reverted, true); assert.equal(current(f.sqlite).length, 0);
  const history = await listHealthImports(f.db, 'alice');
  assert.equal(history.length, 1); assert.equal(history[0].revertReason, '误导入测试数据');
});

test('later raw synchronization prevents rollback without changing either batch', async (t) => {
  const f = fixture(t);
  const first = await manual(f.db, payload());
  await manual(f.db, payload(7000, 'selected-watch', '2026-11-09T11:00:00.000Z'));
  await assert.rejects(revertHealthImport(f.db, 'alice', first.batchId, '旧批次'), isConflict('HEALTH_IMPORT_REVERT_CONFLICT'));
  assert.equal(JSON.parse(String(current(f.sqlite)[0].measurement_json)).value, 7000);
  assert.equal((await listHealthImports(f.db, 'alice')).find((row) => row.batchId === first.batchId)?.revertedAt, null);
});

test('rollback never deletes a new raw record required by a later hide or reset overlay', async (t) => {
  const f = fixture(t), input = payload();
  const saved = await manual(f.db, input);
  f.sqlite.prepare('INSERT INTO health_record_overrides VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('alice', measurementKey(input.measurements[0]), 'steps', '2026-11-09', null, 1, 1, 'synthetic-hide', '2026-11-09', '2026-11-09');
  await assert.rejects(revertHealthImport(f.db, 'alice', saved.batchId, '整批回退'), isConflict('HEALTH_IMPORT_REVERT_CONFLICT'));
  assert.equal(current(f.sqlite).length, 1);
  assert.equal(f.sqlite.prepare('SELECT deleted FROM health_record_overrides WHERE user_id=?').get('alice')?.deleted, 1);
  assert.equal((await listHealthImports(f.db, 'alice'))[0].revertedAt, null);
});

test('owner isolation covers preview tokens, history and rollback', async (t) => {
  const f = fixture(t), input = payload();
  const preview = await previewHealthImport(f.db, 'alice', input);
  await assert.rejects(writeHealthImport(f.db, 'bob', input, null, { previewToken: preview.token }), isConflict('HEALTH_IMPORT_STALE'));
  const saved = await manual(f.db, input);
  assert.deepEqual(await listHealthImports(f.db, 'bob'), []);
  await assert.rejects(revertHealthImport(f.db, 'bob', saved.batchId, '越权'), isConflict('HEALTH_IMPORT_NOT_FOUND'));
  assert.equal(current(f.sqlite).length, 1);
});

test('unchanged and older exports explain skipped records and preserve newest version', async (t) => {
  const f = fixture(t); await manual(f.db, payload());
  const same = payload(5000, 'selected-watch', '2026-11-09T11:00:00.000Z');
  const preview = await previewHealthImport(f.db, 'alice', same);
  assert.equal(preview.skipped, 1); assert.match(preview.examples[0].reason, /仅更新接收版本/);
  const saved = await manual(f.db, same); assert.equal(saved.imported, 0); assert.equal(saved.skipped, 1);
  assert.equal(current(f.sqlite)[0].exported_at, same.exportedAt);
  const older = await previewHealthImport(f.db, 'alice', payload(2000, 'selected-phone'));
  assert.equal(older.skipped, 1); assert.equal(older.sourceChanges, 0);
  assert.match(older.examples[0].reason, /不晚于/);
});

test('repeated unchanged rolling exports advance every raw watermark without repeating rollback snapshots', async (t) => {
  const f = fixture(t), input = rollingPayload(), first = await manual(f.db, input);
  f.sqlite.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?,?)').run('device', 'alice', 'watch', 'synthetic', '2026-11-09', null, null);
  let latest = input, lastReceipt = first;
  for (let round = 1; round <= 3; round++) {
    latest = { ...input, exportedAt: '2026-11-09T1' + round + ':00:00.000Z' };
    const receivedAt = '2026-11-09T1' + round + ':00:01.000Z';
    lastReceipt = await writeHealthImport(f.db, 'alice', latest, 'device', {}, receivedAt);
    assert.equal(lastReceipt.imported, 0); assert.equal(lastReceipt.skipped, 150); assert.equal(lastReceipt.canRevert, false);
    const history = f.sqlite.prepare('SELECT before_json,after_json FROM health_import_batches WHERE user_id=? AND batch_id=?').get('alice', lastReceipt.batchId)!;
    assert.deepEqual(JSON.parse(String(history.before_json)), []); assert.deepEqual(JSON.parse(String(history.after_json)), []);
    const rows = current(f.sqlite); assert.equal(rows.length, 150);
    assert.ok(rows.every(row => row.exported_at === latest.exportedAt && row.received_at === receivedAt));
    assert.equal(f.sqlite.prepare('SELECT last_used_at FROM sync_devices WHERE id=?').get('device')?.last_used_at, receivedAt);
  }
  const replay = await writeHealthImport(f.db, 'alice', latest, null);
  assert.equal(replay.replayed, true); assert.equal(replay.canRevert, false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM health_import_batches').get()?.n, 4);
  await assert.rejects(revertHealthImport(f.db, 'alice', lastReceipt.batchId, '仅更新接收版本'), isConflict('HEALTH_IMPORT_NOT_REVERSIBLE'));
  await assert.rejects(revertHealthImport(f.db, 'alice', first.batchId, '旧内容批次'), isConflict('HEALTH_IMPORT_REVERT_CONFLICT'));
  const older = parseSyncPayload({ ...input, exportedAt: '2026-11-09T12:30:00.000Z', measurements: input.measurements.map(row => ({ ...row, value: row.metric === 'weight' ? 69 : row.value })) });
  const skipped = await manual(f.db, older); assert.equal(skipped.imported, 0); assert.equal(skipped.skipped, 150); assert.equal(skipped.canRevert, false);
  assert.ok(current(f.sqlite).every(row => row.exported_at === latest.exportedAt));
  assert.deepEqual(current(f.sqlite, 'bob'), []);
});

test('a mixed import reverts only changed content while preserving later unchanged-row watermarks', async (t) => {
  const f = fixture(t), original = parseSyncPayload({ ...payload(), measurements: [...payload().measurements,
    { id: 'weight-nine', metric: 'weight', value: 70, unit: 'kg', startDate: '2026-11-09T02:00:00.000Z', aggregation: 'sample', source: 'selected-scale' }] });
  await manual(f.db, original);
  const mixed = parseSyncPayload({ ...original, exportedAt: '2026-11-09T11:00:00.000Z', measurements: original.measurements.map(row => row.metric === 'steps' ? { ...row, value: 6000 } : row) });
  const saved = await manual(f.db, mixed); assert.equal(saved.imported, 1); assert.equal(saved.skipped, 1); assert.equal(saved.canRevert, true);
  const history = f.sqlite.prepare('SELECT before_json,after_json FROM health_import_batches WHERE batch_id=?').get(saved.batchId)!;
  assert.deepEqual(JSON.parse(String(history.after_json)).map((row: { metric: string }) => row.metric), ['steps']);
  assert.equal(JSON.parse(String(history.before_json)).length, 1);
  const weight = mixed.measurements.find(row => row.metric === 'weight')!, later = { ...mixed, exportedAt: '2026-11-09T12:00:00.000Z', measurements: [weight] };
  const unchanged = await manual(f.db, later); assert.equal(unchanged.canRevert, false);
  await revertHealthImport(f.db, 'alice', saved.batchId, '撤销实际数值变化');
  const rows = current(f.sqlite), steps = rows.find(row => row.metric === 'steps')!, storedWeight = rows.find(row => row.metric === 'weight')!;
  assert.equal(JSON.parse(String(steps.measurement_json)).value, 5000); assert.equal(steps.exported_at, original.exportedAt);
  assert.equal(storedWeight.exported_at, later.exportedAt); assert.equal(JSON.parse(String(storedWeight.measurement_json)).value, 70);
  const stale = parseSyncPayload({ ...later, exportedAt: '2026-11-09T11:30:00.000Z', measurements: [{ ...weight, value: 69 }] });
  assert.equal((await manual(f.db, stale)).skipped, 1);
  assert.equal(current(f.sqlite).find(row => row.metric === 'weight')?.exported_at, later.exportedAt);
});

test('a same-value refresh after a changed import still prevents the older rollback', async (t) => {
  const f = fixture(t); await manual(f.db, payload());
  const changed = await manual(f.db, payload(6000, 'selected-watch', '2026-11-09T11:00:00.000Z'));
  const refreshed = await manual(f.db, payload(6000, 'selected-watch', '2026-11-09T12:00:00.000Z'));
  assert.equal(refreshed.imported, 0); assert.equal(refreshed.canRevert, false);
  await assert.rejects(revertHealthImport(f.db, 'alice', changed.batchId, '已有后续同值同步'), isConflict('HEALTH_IMPORT_REVERT_CONFLICT'));
  assert.equal(JSON.parse(String(current(f.sqlite)[0].measurement_json)).value, 6000);
  assert.equal(current(f.sqlite)[0].exported_at, '2026-11-09T12:00:00.000Z');
});

test('an unchanged watermark race fails atomically without a compact receipt or partial writes', async (t) => {
  const f = fixture(t), input = rollingPayload(); await manual(f.db, input);
  const newer = { ...input, exportedAt: '2026-11-09T11:00:00.000Z' }, preview = await previewHealthImport(f.db, 'alice', newer);
  const key = measurementKey(input.measurements[0]);
  f.race(() => f.sqlite.prepare('UPDATE health_measurements SET received_at=? WHERE user_id=? AND record_key=?').run('2026-11-09T12:00:00.000Z', 'alice', key));
  await assert.rejects(writeHealthImport(f.db, 'alice', newer, null, { previewToken: preview.token }), isConflict('HEALTH_IMPORT_STALE'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM health_import_batches').get()?.n, 1);
  assert.ok(current(f.sqlite).every(row => row.exported_at === input.exportedAt));
});

test('1000 record batch uses bounded statements and can be entirely reverted', async (t) => {
  const f = fixture(t), input = payload();
  input.measurements = Array.from({ length: 1000 }, (_, index) => {
    const day = new Date(Date.parse('2026-11-09T00:00:00Z') - index * 86400000).toISOString().slice(0, 10);
    return { ...input.measurements[0], id: 'steps-' + index, startDate: day + 'T00:00:00+08:00', endDate: day + 'T08:00:00+08:00' };
  });
  const saved = await manual(f.db, parseSyncPayload(input));
  assert.equal(saved.imported, 1000); assert.equal(current(f.sqlite).length, 1000);
  await revertHealthImport(f.db, 'alice', saved.batchId, '整批恢复'); assert.equal(current(f.sqlite).length, 0);
});
