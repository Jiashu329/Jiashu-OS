import { BACKUP_TABLE_NAMES, BackupValidationError, backupHash, backupRowKey, backupTable, canonicalBackup, comparableBackupRow, parseFullBackup } from '../lib/backup.ts';
import type { BackupRow, BackupTableName, FullBackup } from '../lib/backup.ts';

export type BackupDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export class BackupConflictError extends Error { readonly code = 'BACKUP_CONFLICT'; constructor(message = '当前数据与备份存在差异，请查看冲突并重新预览。') { super(message); this.name = 'BackupConflictError'; } }
export interface BackupTablePreview { table: BackupTableName; label: string; total: number; insert: number; unchanged: number; conflicts: number }
export interface BackupPreview { backupHash: string; targetHash: string; exportedAt: string; tables: BackupTablePreview[]; insertCount: number; unchangedCount: number; conflictCount: number; remappedCount: number; conflicts: Array<{ table: string; key: string; reason: string }>; canRestore: boolean }
interface RestorePlan { preview: BackupPreview; target: FullBackup['tables']; incoming: FullBackup['tables']; inserts: FullBackup['tables']; globalOwners: Map<BackupTableName, Map<string, string>> }
const chunks = (rows: BackupRow[]) => {
  const result: BackupRow[][] = [];
  let chunk: BackupRow[] = [];
  let bytes = 2;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
    if (chunk.length && (bytes + size > 768 * 1024 || chunk.length >= 500)) { result.push(chunk); chunk = []; bytes = 2; }
    chunk.push(row); bytes += size;
  }
  if (chunk.length) result.push(chunk);
  return result;
};
function columns(name: BackupTableName) { return Object.keys(backupTable(name).fields); }
function order(name: BackupTableName) { const table = backupTable(name); return table.order ?? (table.key.length ? table.key.join(', ') : 'user_id'); }
async function readTables(db: BackupDatabase, userId: string): Promise<FullBackup['tables']> {
  // D1 executes the batch sequentially in one transaction, producing a consistent full export.
  const output = await db.batch(BACKUP_TABLE_NAMES.map((name) => db.prepare(`SELECT ${columns(name).join(', ')} FROM ${name} WHERE user_id = ? ORDER BY ${order(name)}`).bind(userId)));
  return Object.fromEntries(BACKUP_TABLE_NAMES.map((name, index) => [name, output[index].results])) as FullBackup['tables'];
}
export async function exportFullBackup(db: BackupDatabase, userId: string, now = new Date().toISOString()): Promise<FullBackup> {
  return parseFullBackup({ kind: 'jiashu-os-backup', version: 1, exportedAt: now, tables: await readTables(db, userId) });
}
async function ownerMaps(db: BackupDatabase, backup: FullBackup) {
  const maps = new Map<BackupTableName, Map<string, string>>();
  // Only ownership of submitted IDs is inspected. No other user's contents enter a preview or export.
  for (const name of BACKUP_TABLE_NAMES.filter((name) => backupTable(name).globalId)) {
    const map = new Map<string, string>();
    for (const rows of chunks(backup.tables[name])) {
      const result = await db.prepare(`SELECT id, user_id FROM ${name} WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`)
        .bind(JSON.stringify(rows)).all<{ id: string; user_id: string }>();
      for (const row of result.results) map.set(row.id, row.user_id);
    }
    maps.set(name, map);
  }
  return maps;
}
async function mappedId(userId: string, table: string, id: string) {
  const hex = await backupHash(['jiashu-restore-id-v1', userId, table, id]);
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}
function remapSnapshot(value: unknown, accountIds: Map<string, string>, key = ''): unknown {
  if (typeof value === 'string' && (key === 'accountId' || key === 'account_id')) return accountIds.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' && (key === 'accountIds' || key === 'account_ids') ? accountIds.get(item) ?? item : remapSnapshot(item, accountIds));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, remapSnapshot(item, accountIds, field)]));
  return value;
}
async function makePlan(db: BackupDatabase, userId: string, value: unknown): Promise<RestorePlan> {
  const backup = parseFullBackup(value);
  const target = await readTables(db, userId);
  const globalOwners = await ownerMaps(db, backup);
  const incoming = structuredClone(backup.tables);
  let remappedCount = 0;
  const accountIds = new Map<string, string>();
  for (const name of BACKUP_TABLE_NAMES.filter((name) => backupTable(name).globalId)) {
    const owners = globalOwners.get(name)!;
    for (const row of incoming[name]) {
      const original = row.id as string;
      if (owners.has(original) && owners.get(original) !== userId) { row.id = await mappedId(userId, name, original); remappedCount++; }
      if (name === 'finance_accounts') accountIds.set(original, row.id as string);
    }
  }
  for (const row of incoming.finance_balance_entries) row.account_id = accountIds.get(row.account_id as string) ?? row.account_id;
  for (const name of ['finance_goal_plans', 'finance_runway_settings'] as const) for (const row of incoming[name]) row.account_ids_json = JSON.stringify((JSON.parse(row.account_ids_json as string) as string[]).map((id) => accountIds.get(id) ?? id));
  for (const row of incoming.finance_month_closes) row.snapshot_json = JSON.stringify(remapSnapshot(JSON.parse(row.snapshot_json as string), accountIds));
  const inserts = {} as FullBackup['tables'];
  const conflicts: BackupPreview['conflicts'] = [];
  const tables: BackupTablePreview[] = [];
  let conflictCount = 0;
  const conflict = (name: BackupTableName, row: BackupRow, reason: string) => {
    conflictCount++;
    if (conflicts.length < 30) conflicts.push({ table: backupTable(name).label, key: backupRowKey(name, row), reason });
  };
  for (const name of BACKUP_TABLE_NAMES) {
    const existing = new Map(target[name].map((row) => [backupRowKey(name, row), row]));
    let unchanged = 0;
    let tableConflicts = 0;
    inserts[name] = [];
    for (const row of incoming[name]) {
      const prior = existing.get(backupRowKey(name, row));
      if (prior) {
        if (canonicalBackup(comparableBackupRow(name, prior)) === canonicalBackup(comparableBackupRow(name, row))) unchanged++;
        else { tableConflicts++; conflict(name, row, '相同标识已有不同内容，保留现有记录。'); }
      } else inserts[name].push(row);
    }
    tables.push({ table: name, label: backupTable(name).label, total: incoming[name].length, insert: inserts[name].length, unchanged, conflicts: tableConflicts });
  }
  // Inserting an older same-day balance after an existing one would change latest-balance precedence.
  // Require a clean destination for this ambiguous merge instead of silently changing current assets.
  const balanceDates = new Set(target.finance_balance_entries.map((row) => JSON.stringify([row.account_id, row.as_of_date])));
  for (const row of inserts.finance_balance_entries) if (balanceDates.has(JSON.stringify([row.account_id, row.as_of_date]))) {
    conflict('finance_balance_entries', row, '该账户当天已有其他余额记录，无法确定恢复后的先后顺序。');
    tables.find((table) => table.table === 'finance_balance_entries')!.conflicts++;
  }
  const existingOperations = new Set(target.finance_month_closes.map((row) => row.operation_id));
  for (const row of inserts.finance_month_closes) if (existingOperations.has(row.operation_id)) {
    conflict('finance_month_closes', row, '月结操作标识已用于其他版本。');
    tables.find((table) => table.table === 'finance_month_closes')!.conflicts++;
  }
  return { preview: { backupHash: await backupHash(backup), targetHash: await backupHash(target), exportedAt: backup.exportedAt, tables, insertCount: tables.reduce((sum, table) => sum + table.insert, 0), unchangedCount: tables.reduce((sum, table) => sum + table.unchanged, 0), conflictCount, remappedCount, conflicts, canRestore: conflictCount === 0 }, target, incoming, inserts, globalOwners };
}
export async function previewFullBackup(db: BackupDatabase, userId: string, value: unknown): Promise<BackupPreview> { return (await makePlan(db, userId, value)).preview; }

function guard(db: BackupDatabase, userId: string, condition: string, values: unknown[]) {
  return db.prepare(`INSERT INTO backup_restore_guards(user_id, valid) VALUES (?, CASE WHEN (${condition}) THEN 1 ELSE 0 END)
    ON CONFLICT(user_id) DO UPDATE SET valid = excluded.valid`).bind(userId, ...values);
}
export async function restoreFullBackup(db: BackupDatabase, userId: string, value: unknown, expected: { backupHash: string; targetHash: string; confirmed: boolean }) {
  if (expected.confirmed !== true) throw new BackupValidationError('请先预览并确认恢复。');
  const plan = await makePlan(db, userId, value);
  if (plan.preview.backupHash !== expected.backupHash || plan.preview.targetHash !== expected.targetHash) throw new BackupConflictError('文件或当前数据已变化，请重新预览。');
  if (!plan.preview.canRestore) throw new BackupConflictError();
  const commands: D1PreparedStatement[] = [];
  for (const name of BACKUP_TABLE_NAMES) {
    commands.push(guard(db, userId, `(SELECT COUNT(*) FROM ${name} WHERE user_id = ?) = ?`, [userId, plan.target[name].length]));
    for (const rows of chunks(plan.target[name])) {
      const definition = backupTable(name);
      const pk = definition.key.map((field) => `t.${field} IS json_extract(j.value, '$.${field}')`).join(' AND ');
      const equal = columns(name).map((field) => `t.${field} IS json_extract(j.value, '$.${field}')`).join(' AND ');
      commands.push(guard(db, userId, `NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN ${name} t ON t.user_id = ?${pk ? ' AND ' + pk : ''} WHERE t.user_id IS NULL OR NOT (${equal}))`, [JSON.stringify(rows), userId]));
    }
  }
  for (const name of BACKUP_TABLE_NAMES) {
    const fields = columns(name).filter((field) => !backupTable(name).generated?.includes(field));
    for (const rows of chunks(plan.inserts[name])) {
      // No OR IGNORE or updates: a concurrent global-ID collision aborts the transaction as well.
      commands.push(db.prepare(`INSERT INTO ${name}(user_id, ${fields.join(', ')}) SELECT ?, ${fields.map((field) => `json_extract(value, '$.${field}')`).join(', ')} FROM json_each(?)`)
        .bind(userId, JSON.stringify(rows)));
    }
  }
  try { await db.batch(commands); }
  catch (error) {
    if (error instanceof Error && /backup_restore_guards|CHECK constraint|UNIQUE constraint/.test(error.message)) throw new BackupConflictError('恢复期间数据已变化，所有恢复写入已撤回，请重新预览。');
    throw error;
  }
  return { ok: true, inserted: plan.preview.insertCount, unchanged: plan.preview.unchangedCount, replayed: plan.preview.insertCount === 0 };
}
