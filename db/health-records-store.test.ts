import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { measurementDay, measurementKey, type HealthMeasurement } from '../lib/health.ts';
import type { HealthRecordCommand, HealthRecordView } from '../lib/health-records.ts';
import { HealthRecordConflictError, HealthRecordNotFoundError, listHealthRecords, readEffectiveHealthMeasurements,
  readHealthRecord, readHealthRecordHistory, writeHealthRecord } from './health-records-store.ts';

const NOW = '2026-11-09T12:00:00.000Z';
const NEWER = '2026-11-09T13:00:00.000Z';
let serial = 0;
const requestId = () => '00000000-0000-4000-8000-' + String(++serial).padStart(12, '0');
interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  execute(): { results: unknown[]; meta: { changes: number } };
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
  let beforeBatch: (() => void) | null = null;
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
      const bound: Statement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
        execute() { return statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } } : { results: [], meta: { changes: Number(statement.run(...values).changes) } }; },
      }; return bound;
    },
    async batch(commands: Statement[]) {
      sqlite.exec('BEGIN');
      try { const hook = beforeBatch; beforeBatch = null; hook?.(); const result = commands.map((command) => command.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { db, sqlite,
    race(action: () => void) { beforeBatch = action; },
    raw(owner: string, measurement: HealthMeasurement, exportedAt = NOW) {
      sqlite.prepare(`INSERT INTO health_measurements (user_id,record_key,metric,day,measurement_json,exported_at,received_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,record_key) DO UPDATE SET metric=excluded.metric,day=excluded.day,
        measurement_json=excluded.measurement_json,exported_at=excluded.exported_at,received_at=excluded.received_at`)
        .run(owner, measurementKey(measurement), measurement.metric, measurementDay(measurement), JSON.stringify(measurement), exportedAt, exportedAt);
    },
    changes(owner = 'alice') { return Number(sqlite.prepare('SELECT count(*) AS count FROM health_record_changes WHERE user_id=?').get(owner)?.count); },
  };
}
const weight = (id = 'scale', value = 70, startDate = '2026-11-08T08:00:00.000Z'): HealthMeasurement => ({ id, metric: 'weight', value, unit: 'kg', source: 'synthetic-scale', aggregation: 'sample', startDate });
const steps = (value = 1000): HealthMeasurement => ({ id: 'manual:steps', metric: 'steps', value, unit: 'count', source: 'manual', aggregation: 'daily', startDate: '2026-11-08T00:00:00+08:00', endDate: '2026-11-08T22:00:00+08:00' });

void test('metric-scoped effective reads exclude unselected records at the SQL result boundary',async(t)=>{
  const f=fixture(t);f.raw('alice',weight());f.raw('alice',steps(1234));f.raw('bob',steps(9999));
  // An unselected malformed source row must not even be decoded for this scope.
  f.sqlite.prepare('UPDATE health_measurements SET measurement_json=? WHERE user_id=? AND metric=?').run('{invalid-unselected','alice','weight');
  const result=await readEffectiveHealthMeasurements(f.db,'alice','2026-11-01','2026-11-09',['steps']);
  assert.deepEqual(result.map((row)=>[row.metric,row.value]),[['steps',1234]]);
  assert.deepEqual(await readEffectiveHealthMeasurements(f.db,'alice','2026-11-01','2026-11-09',[]),[]);
});
function mutation(record: HealthRecordView, action: 'correct' | 'hide' | 'restore' | 'reset', value = 71): HealthRecordCommand {
  return { action, recordKey: record.recordKey, expectedRevision: record.revision, expectedBaseExportedAt: record.base?.exportedAt ?? null, reason: 'synthetic correction', ...(action === 'correct' ? { value } : {}) } as HealthRecordCommand;
}
async function required(db: D1Database, owner: string, key: string) {
  const record = await readHealthRecord(db, owner, key); assert.ok(record); return record;
}

void test('manual create and subsequent corrections retain immutable receipt replay and before/after history', async (t) => {
  const f = fixture(t); const id = requestId(); const command = { action: 'create' as const, measurement: weight('manual:new'), reason: 'forgot scale upload' };
  const first = await writeHealthRecord(f.db, 'alice', command, id, NOW); assert.equal(first.record.revision, 1); assert.equal(first.record.manual, true); assert.equal(first.replayed, false);
  const edited = await writeHealthRecord(f.db, 'alice', mutation(first.record, 'correct', 72), requestId(), NEWER); assert.equal(edited.record.effective.value, 72);
  const replay = await writeHealthRecord(f.db, 'alice', command, id, NEWER); assert.equal(replay.replayed, true); assert.equal(replay.record.effective.value, 72); assert.equal(f.changes(), 2);
  await assert.rejects(writeHealthRecord(f.db, 'alice', { ...command, reason: 'different payload' }, id), HealthRecordConflictError);
  const history = await readHealthRecordHistory(f.db, 'alice', first.record.recordKey); assert.equal(history.length, 2); assert.equal(history[1].before, null); assert.equal(history[0].before?.effective.value, 70); assert.equal(history[0].after.effective.value, 72);
});

void test('manual corrections survive new raw sync and reset reveals the latest source while retaining original snapshots', async (t) => {
  const f = fixture(t); const source = weight(); f.raw('alice', source);
  let record = await required(f.db, 'alice', measurementKey(source)); assert.equal(record.revision, 0);
  record = (await writeHealthRecord(f.db, 'alice', mutation(record, 'correct', 71), requestId(), NOW)).record;
  f.raw('alice', weight('scale', 75), NEWER);
  assert.equal((await readEffectiveHealthMeasurements(f.db, 'alice', '2026-11-01'))[0].value, 71);
  record = await required(f.db, 'alice', record.recordKey); assert.equal(record.base?.measurement.value, 75); assert.equal(record.effective.value, 71);
  record = (await writeHealthRecord(f.db, 'alice', mutation(record, 'reset'), requestId(), NEWER)).record;
  assert.equal(record.override, null); assert.equal(record.effective.value, 75); assert.equal(record.revision, 2);
  const history = await readHealthRecordHistory(f.db, 'alice', record.recordKey); assert.equal(history[1].before?.base?.measurement.value, 70); assert.equal(history[1].after.effective.value, 71); assert.equal(history[0].after.effective.value, 75);
});

void test('hidden daily records are excluded but cannot be recreated and restoring retains their correction', async (t) => {
  const f = fixture(t); let record = (await writeHealthRecord(f.db, 'alice', { action: 'create', measurement: steps(0), reason: '' }, requestId(), NOW)).record;
  record = (await writeHealthRecord(f.db, 'alice', mutation(record, 'hide'), requestId(), NOW)).record;
  assert.deepEqual(await readEffectiveHealthMeasurements(f.db, 'alice', '2026-11-01'), []);
  await assert.rejects(writeHealthRecord(f.db, 'alice', { action: 'create', measurement: steps(9000), reason: '' }, requestId(), NOW), HealthRecordConflictError);
  assert.equal((await listHealthRecords(f.db, 'alice', { from: '2026-11-01', to: '2026-11-09', includeDeleted: false })).records.length, 0);
  assert.equal((await listHealthRecords(f.db, 'alice', { from: '2026-11-01', to: '2026-11-09', includeDeleted: true })).records.length, 1);
  record = (await writeHealthRecord(f.db, 'alice', mutation(record, 'restore'), requestId(), NOW)).record; assert.equal(record.effective.value, 0); assert.equal(record.deleted, false);
  await assert.rejects(writeHealthRecord(f.db, 'alice', mutation(record, 'reset'), requestId(), NOW), HealthRecordConflictError); assert.equal(f.changes(), 3);
});

void test('stale overlay versions and raced raw sync reject changes without orphan history', async (t) => {
  const f = fixture(t); f.raw('alice', weight()); const stale = await required(f.db, 'alice', 'weight:scale');
  await writeHealthRecord(f.db, 'alice', mutation(stale, 'correct', 71), requestId(), NOW);
  await assert.rejects(writeHealthRecord(f.db, 'alice', mutation(stale, 'correct', 72), requestId(), NEWER), HealthRecordConflictError); assert.equal(f.changes(), 1);
  const latest = await required(f.db, 'alice', 'weight:scale');
  f.race(() => f.raw('alice', weight('scale', 76), NEWER));
  await assert.rejects(writeHealthRecord(f.db, 'alice', mutation(latest, 'correct', 73), requestId(), NEWER), HealthRecordConflictError);
  assert.equal(f.changes(), 1); assert.equal((await required(f.db, 'alice', 'weight:scale')).effective.value, 71);
});

void test('receipt and override rollback together if the overlay write fails', async (t) => {
  const f = fixture(t); f.sqlite.exec(`CREATE TRIGGER fail_overlay BEFORE INSERT ON health_record_overrides BEGIN SELECT RAISE(ABORT,'synthetic disk error'); END`);
  await assert.rejects(writeHealthRecord(f.db, 'alice', { action: 'create', measurement: weight('manual:error'), reason: '' }, requestId(), NOW));
  assert.equal(f.changes(), 0); assert.equal(await readHealthRecord(f.db, 'alice', 'weight:manual:error'), null);
});

void test('date ranges follow the effective observation and reset follows the moved latest raw sample', async (t) => {
  const f = fixture(t); f.raw('alice', weight()); let record = await required(f.db, 'alice', 'weight:scale');
  record = (await writeHealthRecord(f.db, 'alice', mutation(record, 'correct', 71), requestId(), NOW)).record;
  f.raw('alice', weight('scale', 75, '2026-11-09T08:00:00.000Z'), NEWER);
  assert.equal((await readEffectiveHealthMeasurements(f.db, 'alice', '2026-11-08', '2026-11-08'))[0].value, 71);
  assert.deepEqual(await readEffectiveHealthMeasurements(f.db, 'alice', '2026-11-09', '2026-11-09'), []);
  record = await required(f.db, 'alice', 'weight:scale'); await writeHealthRecord(f.db, 'alice', mutation(record, 'reset'), requestId(), NEWER);
  assert.deepEqual(await readEffectiveHealthMeasurements(f.db, 'alice', '2026-11-08', '2026-11-08'), []);
  assert.equal((await readEffectiveHealthMeasurements(f.db, 'alice', '2026-11-09', '2026-11-09'))[0].value, 75);
});

void test('list cursor reaches more than 100 same-day samples while aggregate readers retain every observation', async (t) => {
  const f = fixture(t); for (let i = 0; i < 105; i++) f.raw('alice', weight('sample-' + String(i).padStart(3, '0')));
  const selection = { from: '2026-11-08', to: '2026-11-08', includeDeleted: false };
  const first = await listHealthRecords(f.db, 'alice', selection); assert.equal(first.records.length, 100); assert.equal(first.hasMore, true); assert.ok(first.nextCursor);
  const second = await listHealthRecords(f.db, 'alice', { ...selection, cursor: JSON.parse(first.nextCursor) as [string, string] }); assert.equal(second.records.length, 5); assert.equal(second.hasMore, false); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.records, ...second.records].map((record) => record.recordKey)).size, 105);
  assert.equal((await readEffectiveHealthMeasurements(f.db, 'alice', '2026-11-08')).length, 105);
});

void test('owner isolation covers list, write, history and shared request identifiers', async (t) => {
  const f = fixture(t); f.raw('alice', weight());
  assert.equal(await readHealthRecord(f.db, 'bob', 'weight:scale'), null);
  await assert.rejects(readHealthRecordHistory(f.db, 'bob', 'weight:scale'), HealthRecordNotFoundError);
  const alice = await required(f.db, 'alice', 'weight:scale'); await assert.rejects(writeHealthRecord(f.db, 'bob', mutation(alice, 'hide'), requestId()), HealthRecordNotFoundError);
  const id = requestId(); const command = { action: 'create' as const, measurement: weight('manual:same'), reason: '' };
  await writeHealthRecord(f.db, 'alice', command, id, NOW); await writeHealthRecord(f.db, 'bob', command, id, NOW);
  assert.equal((await listHealthRecords(f.db, 'bob', { from: '2026-11-01', to: '2026-11-09', includeDeleted: true })).records.length, 1); assert.equal(f.changes('bob'), 1);
});
