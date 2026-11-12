import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { BACKUP_TABLE_NAMES, BackupValidationError, backupRowKey, canonicalBackup, comparableBackupRow, parseFullBackup } from '../lib/backup.ts';
import type { FullBackup } from '../lib/backup.ts';
import { measurementDay, measurementKey, type HealthMeasurement } from '../lib/health.ts';
import { buildFinanceReview, parseFinanceReviewQuery } from '../lib/finance-review.ts';
import { createFinanceAccount } from './finance-store.ts';
import { createNutritionEntry, createNutritionMeal } from './nutrition-store.ts';
import { writeHealthRecord } from './health-records-store.ts';
import { BackupConflictError, exportFullBackup, previewFullBackup, restoreFullBackup } from './backup-store.ts';

const NOW = '2026-11-12T04:00:00.000Z';
const HASH = 'a'.repeat(64);
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const ENTRY = '00000000-0000-4000-8000-000000000002';
const GOAL = '00000000-0000-4000-8000-000000000003';
const CHANGE = '00000000-0000-4000-8000-000000000004';
interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }>; execute(): { results: unknown[]; meta: { changes: number } } }
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  let batchesUntilRace = -1;
  let race: (() => void) | null = null;
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const execute = () => statement.columns().length ? { results: statement.all(...values), meta: { changes: 0 } } : { results: [], meta: { changes: Number(statement.run(...values).changes) } };
      const bound: Statement = { bind(...parameters) { values = parameters as SQLInputValue[]; return bound; }, async first<T>() { return statement.get(...values) as T ?? null; }, async all<T>() { return { results: statement.all(...values) as T[] }; }, async run() { return execute(); }, execute };
      return bound;
    },
    async batch(commands: Statement[]) {
      if (batchesUntilRace === 0) { const action = race; race = null; batchesUntilRace = -1; action?.(); }
      else if (batchesUntilRace > 0) batchesUntilRace--;
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = commands.map((command) => command.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { sqlite, db, raceBeforeWrite(action: () => void) { batchesUntilRace = 1; race = action; } };
}
async function seed(f: ReturnType<typeof fixture>, owner = 'alice') {
  const { sqlite, db } = f;
  const weight: HealthMeasurement = { id: 'old-weight', metric: 'weight', value: 70, unit: 'kg', source: 'scale', aggregation: 'sample', startDate: '2025-01-01T00:00:00.000Z' };
  sqlite.prepare('INSERT INTO health_measurements VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner, measurementKey(weight), weight.metric, measurementDay(weight), JSON.stringify(weight), NOW, NOW);
  await writeHealthRecord(db, owner, { action: 'create', measurement: { ...weight, id: 'manual:weight', startDate: '2026-11-10T00:00:00.000Z' }, reason: '补录' }, CHANGE, NOW);
  sqlite.prepare('INSERT INTO health_syncs VALUES (?, ?, ?, ?, ?)').run(owner, HASH, NOW, NOW, 1);
  sqlite.prepare('INSERT INTO health_goal_settings VALUES (?, ?, ?, ?, ?)').run(owner, 8000, 8, 400, NOW);
  sqlite.prepare('INSERT INTO health_weight_plan_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(owner, 80, 70, '2026-11-01', '2027-01-01', 1, NOW, NOW);
  await createFinanceAccount(db, owner, { ledger: 'personal', name: '现金账户', type: 'bank', currency: 'CNY', amountMinor: '9007199254740993', asOfDate: '2026-10-31', note: '' }, NOW, ACCOUNT);
  await createNutritionEntry(db, owner, { date: '2026-11-10', meal: 'breakfast', name: '鸡蛋', portion: '1个', note: '', caloriesTenth: null }, ENTRY, NOW);
  sqlite.prepare('INSERT INTO finance_goal_plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(GOAL, owner, 'personal', 'CNY', '应急目标', '999999999999999999', '2027-01-01', JSON.stringify([ACCOUNT]), HASH, NOW, NOW, null);
  sqlite.prepare('INSERT INTO finance_runway_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(owner, 'personal', 'CNY', '100000', 6, JSON.stringify([ACCOUNT]), NOW, NOW);
  sqlite.prepare('INSERT INTO health_sync_diagnostics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(owner, 'weight', NOW, NOW, 1, null, null, '2025-01-01', '2025-01-01');
  sqlite.prepare('INSERT INTO health_weekly_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(owner, '2026-11-09', '晚饭后散步', 'completed', '完成', 1, NOW, NOW);
  const snapshot = buildFinanceReview([{ accountId: ACCOUNT, name: '现金账户', type: 'bank', ledger: 'personal', currency: 'CNY', archivedAt: null }], [{ accountId: ACCOUNT, amountMinor: '9007199254740993', asOfDate: '2026-10-31', sequence: 1 }], parseFinanceReviewQuery(new URLSearchParams({ ledger: 'personal', currency: 'CNY', month: '2026-10' }), new Date(NOW)));
  sqlite.prepare('INSERT INTO finance_month_closes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(owner, 'personal', 'CNY', '2026-10', 1, ENTRY, HASH, JSON.stringify(snapshot), '', NOW);
  sqlite.prepare('INSERT INTO sync_devices VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner + '-device', owner, '手机授权', 'must-never-export-this-hash', NOW, NOW, null);
}
function businessRows(backup: FullBackup) {
  return Object.fromEntries(BACKUP_TABLE_NAMES.map((name) => [name, backup.tables[name].map((row) => comparableBackupRow(name, row)).sort((a, b) => backupRowKey(name, a).localeCompare(backupRowKey(name, b)))]));
}
async function restore(db: D1Database, owner: string, backup: FullBackup) {
  const preview = await previewFullBackup(db, owner, backup);
  assert.equal(preview.canRestore, true, JSON.stringify(preview.conflicts));
  return restoreFullBackup(db, owner, backup, { ...preview, confirmed: true });
}

void test('full export includes old history, edits, all plans and month closes, while excluding other owners and device authorization', async (t) => {
  const f = fixture(t); await seed(f);
  f.sqlite.prepare('INSERT INTO health_goal_settings VALUES (?, ?, ?, ?, ?)').run('bob', 10000, 7, 300, NOW);
  const backup = await exportFullBackup(f.db, 'alice', NOW);
  assert.equal(backup.tables.health_measurements[0].day, '2025-01-01');
  assert.equal(backup.tables.finance_balance_entries[0].id, 'initial:' + ACCOUNT);
  assert.equal(backup.tables.health_record_changes.length, 1);
  assert.equal(backup.tables.finance_month_closes.length, 1);
  assert.equal(backup.tables.health_weekly_actions.length, 1);
  assert.equal(backup.tables.health_goal_settings[0].steps_target, 8000);
  assert.equal(JSON.stringify(backup).includes('must-never-export'), false);
  assert.equal(JSON.stringify(backup).includes('user_id'), false);
});

void test('a fresh database round trip restores every business record and an identical retry is a no-op', async (t) => {
  const source = fixture(t); await seed(source);
  const backup = await exportFullBackup(source.db, 'alice', NOW);
  const destination = fixture(t);
  const result = await restore(destination.db, 'alice', backup);
  assert.ok(result.inserted > 0);
  const restored = await exportFullBackup(destination.db, 'alice', NOW);
  assert.equal(canonicalBackup(businessRows(restored)), canonicalBackup(businessRows(backup)));
  assert.equal(destination.sqlite.prepare('SELECT COUNT(*) n FROM sync_devices').get()!.n, 0);
  assert.deepEqual(await restore(destination.db, 'alice', backup), { ok: true, inserted: 0, unchanged: result.inserted, replayed: true });
});

void test('cross-owner UUID collisions remap accounts, balance entries, goals, meals and frozen reports without touching the source owner', async (t) => {
  const f = fixture(t); await seed(f);
  const backup = await exportFullBackup(f.db, 'alice', NOW);
  const before = canonicalBackup(backup.tables);
  const preview = await previewFullBackup(f.db, 'bob', backup);
  assert.ok(preview.remappedCount >= 4);
  await restoreFullBackup(f.db, 'bob', backup, { ...preview, confirmed: true });
  const bob = await exportFullBackup(f.db, 'bob', NOW);
  const mapped = bob.tables.finance_accounts[0].id;
  assert.notEqual(mapped, ACCOUNT);
  assert.equal(bob.tables.finance_balance_entries[0].account_id, mapped);
  assert.deepEqual(JSON.parse(bob.tables.finance_goal_plans[0].account_ids_json as string), [mapped]);
  assert.deepEqual(JSON.parse(bob.tables.finance_runway_settings[0].account_ids_json as string), [mapped]);
  assert.equal(JSON.parse(bob.tables.finance_month_closes[0].snapshot_json as string).accounts[0].accountId, mapped);
  assert.equal(canonicalBackup((await exportFullBackup(f.db, 'alice', NOW)).tables), before);
  assert.equal((await restore(f.db, 'bob', backup)).replayed, true);
});

void test('changed singleton settings produce visible conflicts and no rows are written', async (t) => {
  const f = fixture(t); await seed(f);
  const backup = await exportFullBackup(f.db, 'alice', NOW);
  f.sqlite.prepare('UPDATE health_goal_settings SET steps_target = 9000 WHERE user_id = ?').run('alice');
  const preview = await previewFullBackup(f.db, 'alice', backup);
  assert.equal(preview.canRestore, false);
  assert.ok(preview.conflicts.some((row) => row.table === '健康目标'));
  await assert.rejects(restoreFullBackup(f.db, 'alice', backup, { ...preview, confirmed: true }), BackupConflictError);
  assert.equal(f.sqlite.prepare('SELECT steps_target FROM health_goal_settings WHERE user_id=?').get('alice')!.steps_target, 9000);
});

void test('a changed destination after preview is rejected before any restore writes', async (t) => {
  const f = fixture(t); await seed(f);
  const backup = await exportFullBackup(f.db, 'alice', NOW);
  const preview = await previewFullBackup(f.db, 'bob', backup);
  f.sqlite.prepare('INSERT INTO health_goal_settings VALUES (?, ?, ?, ?, ?)').run('bob', 5000, null, null, NOW);
  await assert.rejects(restoreFullBackup(f.db, 'bob', backup, { ...preview, confirmed: true }), /数据已变化/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM finance_accounts WHERE user_id=?').get('bob')!.n, 0);
});

void test('batch guards catch a race between revalidation and writes and roll back all restore statements', async (t) => {
  const f = fixture(t); await seed(f);
  const backup = await exportFullBackup(f.db, 'alice', NOW);
  const preview = await previewFullBackup(f.db, 'bob', backup);
  f.raceBeforeWrite(() => f.sqlite.prepare('INSERT INTO health_goal_settings VALUES (?, ?, ?, ?, ?)').run('bob', 9000, null, null, NOW));
  await assert.rejects(restoreFullBackup(f.db, 'bob', backup, { ...preview, confirmed: true }), BackupConflictError);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM health_measurements WHERE user_id=?').get('bob')!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM backup_restore_guards WHERE user_id=?').get('bob')!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT steps_target FROM health_goal_settings WHERE user_id=?').get('bob')!.steps_target, 9000);
});

void test('a later storage failure rolls back previously inserted health, goals, account and guard rows', async (t) => {
  const f = fixture(t); await seed(f);
  const backup = await exportFullBackup(f.db, 'alice', NOW);
  f.sqlite.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON nutrition_entries WHEN NEW.user_id='bob' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;");
  await assert.rejects(restore(f.db, 'bob', backup), /synthetic disk failure/);
  for (const table of [...BACKUP_TABLE_NAMES, 'backup_restore_guards']) assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE user_id=?').get('bob')!.n, 0, table);
});

void test('backup validation rejects owner injection, missing references, invalid financial precision, malformed history and broken frozen reports', async (t) => {
  const f = fixture(t); await seed(f);
  const backup = await exportFullBackup(f.db, 'alice', NOW);
  const bad = (mutate: (copy: FullBackup) => void) => { const copy = structuredClone(backup); mutate(copy); assert.throws(() => parseFullBackup(copy), BackupValidationError); };
  bad((copy) => { copy.tables.health_goal_settings[0].user_id = 'bob'; });
  bad((copy) => { copy.tables.finance_accounts = []; });
  bad((copy) => { copy.tables.finance_balance_entries[0].amount_minor = '1000000000000000000'; });
  bad((copy) => { copy.tables.finance_goal_plans[0].target_minor = '0'; });
  bad((copy) => { copy.tables.health_record_changes[0].before_state_json = '{}'; });
  bad((copy) => { copy.tables.health_record_overrides[0].revision = 2; });
  bad((copy) => { copy.tables.finance_month_closes[0].snapshot_json = JSON.stringify({ ledger: 'personal', currency: 'CNY', month: '2026-10', snapshot: {}, accounts: [] }); });
  bad((copy) => { copy.tables.health_measurements[0].exported_at = '2026-11-12T12:00:00+08:00'; });
  bad((copy) => { copy.tables.finance_goal_plans[0].account_ids_json = JSON.stringify(['00000000-0000-4000-8000-000000000099']); });
  bad((copy) => { copy.version = 2 as 1; });
  bad((copy) => { copy.tables.health_measurements.push(copy.tables.health_measurements[0]); });
});

void test('same-day balance precedence survives a clean restore and ambiguous merges are rejected', async (t) => {
  const source = fixture(t); await seed(source);
  source.sqlite.prepare('INSERT INTO finance_balance_entries (id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES (?,?,?,?,?,?,?)').run(ENTRY, 'alice', ACCOUNT, '50000', '2026-10-31', '修正', NOW);
  const backup = await exportFullBackup(source.db, 'alice', NOW);
  const destination = fixture(t); await restore(destination.db, 'alice', backup);
  const latest = destination.sqlite.prepare('SELECT amount_minor FROM finance_balance_entries WHERE user_id=? ORDER BY as_of_date DESC,sequence DESC LIMIT 1').get('alice');
  assert.equal(latest!.amount_minor, '50000');
  destination.sqlite.prepare('DELETE FROM finance_balance_entries WHERE id=?').run('initial:' + ACCOUNT);
  const preview = await previewFullBackup(destination.db, 'alice', backup);
  assert.equal(preview.canRestore, false);
  assert.match(preview.conflicts[0].reason, /先后顺序/);
});

void test('whole-meal quick entry fingerprints remain compatible with full backup and restore', async (t) => {
  const f = fixture(t);
  await createNutritionMeal(f.db, 'alice', [{ date: '2026-11-10', meal: 'lunch', name: '米饭', portion: '一碗', note: '', caloriesTenth: 2000 }], ENTRY, NOW);
  const backup = await exportFullBackup(f.db, 'alice', NOW);
  assert.match(backup.tables.nutrition_entries[0].creation_hash as string, /^meal:/);
  await restore(f.db, 'bob', backup);
  assert.equal((await exportFullBackup(f.db, 'bob', NOW)).tables.nutrition_entries[0].creation_hash, backup.tables.nutrition_entries[0].creation_hash);
});
