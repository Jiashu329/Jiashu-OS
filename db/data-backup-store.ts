import { BACKUP_MAX_BYTES, BACKUP_MAX_ROWS, BACKUP_TABLE_NAMES, BACKUP_TABLES, BackupCapacityError, backupDigest, backupRowKey, comparableBackupRow, parseDataBackup } from '../lib/data-backup.ts';
import type { BackupRow, BackupTable, DataBackup } from '../lib/data-backup.ts';

export type BackupDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export class BackupConflictError extends Error { readonly code = 'BACKUP_CONFLICT'; readonly status = 409; constructor(message = '备份与当前数据有差异，未写入任何记录。请重新预览并处理冲突。') { super(message); this.name = 'BackupConflictError'; } }
export interface BackupTablePreview { table: BackupTable; label: string; incoming: number; added: number; skipped: number; conflicts: number; conflictExamples: Array<{ record:string;reason:string }> }
export interface BackupPreview { previewHash: string; backupHash: string; canRestore: boolean; total: { incoming: number; added: number; skipped: number; conflicts: number }; tables: BackupTablePreview[] }
interface Plan { preview: BackupPreview; current: Record<BackupTable, BackupRow[]>; additions: Record<BackupTable, BackupRow[]> }
const MAX_RESTORE_QUERIES = 48;
function existingFinanceAffected(current: Record<BackupTable,BackupRow[]>, additions: Record<BackupTable,BackupRow[]>) {
  const existing = new Set(current.finance_accounts.map((row)=>row.id));
  return [...new Set([...additions.finance_balance_entries,...additions.finance_balance_changes].map((row)=>String(row.account_id)).filter((accountId)=>existing.has(accountId)))];
}
function queryBudget(current: Record<BackupTable,BackupRow[]>, additions: Record<BackupTable,BackupRow[]>) {
  const foreignReads = BACKUP_TABLE_NAMES.filter((table) => 'globalId' in BACKUP_TABLES[table] && additions[table].length > 0).length;
  return BACKUP_TABLE_NAMES.length + foreignReads + 1 + (existingFinanceAffected(current,additions).length ? 1 : 0) + BACKUP_TABLE_NAMES.reduce((sum,table) => sum + chunks(current[table]).length + chunks(additions[table]).length,0);
}
function order(table: BackupTable) { const spec = BACKUP_TABLES[table]; return 'sequence' in spec ? 'sequence' : spec.keys.length ? spec.keys.join(',') : 'user_id'; }
async function readTables(db: BackupDatabase, userId: string): Promise<Record<BackupTable, BackupRow[]>> {
  const queries = BACKUP_TABLE_NAMES.map((table) => db.prepare(`SELECT ${BACKUP_TABLES[table].columns.join(',')} FROM ${table} WHERE user_id = ? ORDER BY ${order(table)} LIMIT ?`).bind(userId, BACKUP_MAX_ROWS + 1));
  const result = await db.batch<BackupRow>(queries);
  const rows = Object.fromEntries(BACKUP_TABLE_NAMES.map((table,index) => [table,result[index].results])) as Record<BackupTable, BackupRow[]>;
  if (Object.values(rows).reduce((sum, list) => sum + list.length, 0) > BACKUP_MAX_ROWS) throw new BackupCapacityError('完整备份最多 20,000 行；当前版本不支持分卷恢复。');
  return rows;
}
export async function exportDataBackup(db: BackupDatabase, userId: string, now = new Date().toISOString()): Promise<DataBackup> {
  const backup: DataBackup = { kind: 'jiashu-os-backup', version: 1, exportedAt: now, tables: await readTables(db,userId) };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > BACKUP_MAX_BYTES) throw new BackupCapacityError('完整备份超过 8 MiB；当前版本不支持分卷导出，请联系维护者扩容。');
  const empty = Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,[]])) as unknown as Record<BackupTable,BackupRow[]>;
  if (queryBudget(empty,backup.tables) > MAX_RESTORE_QUERIES) throw new BackupCapacityError('备份过大，超过安全恢复的查询预算；未截断记录。当前版本暂不支持分卷，请联系维护者扩容。');
  // Export and restore use exactly the same validator; never offer an unrestorable download.
  return parseDataBackup(backup);
}
async function planRestore(db: BackupDatabase, userId: string, backup: DataBackup): Promise<Plan> {
  const current = await readTables(db,userId);
  const additions = Object.fromEntries(BACKUP_TABLE_NAMES.map((table) => [table,[]])) as unknown as Record<BackupTable, BackupRow[]>;
  const summaries: BackupTablePreview[] = [];
  for (const table of BACKUP_TABLE_NAMES) {
    const incoming = backup.tables[table]; const existing = new Map(current[table].map((row) => [backupRowKey(table,row),row]));
    let skipped = 0; let conflicts = 0;
    const conflictExamples: BackupTablePreview['conflictExamples'] = [];
    const describe = (row: BackupRow, reason: string) => { if (conflictExamples.length < 5) conflictExamples.push({record:String(row.name ?? row.record_key ?? row.date ?? row.as_of_date ?? row.id ?? (row.ledger ? String(row.ledger)+' / '+row.currency : spec.label)),reason}); };
    const spec = BACKUP_TABLES[table];
    const candidates: BackupRow[] = [];
    for (const row of incoming) {
      const prior = existing.get(backupRowKey(table,row));
      if (!prior) candidates.push(row);
      else if (comparableBackupRow(table,prior) === comparableBackupRow(table,row)) skipped++;
      else { conflicts++; describe(row,'已有记录内容不同，需要先核对当前记录。'); }
    }
    // Global UUID columns can collide with another user's data. Inspect only IDs,
    // never return somebody else's fields to a preview or overwrite their rows.
    if ('globalId' in spec && candidates.length) {
      const foreign = await db.prepare(`SELECT id FROM ${table} WHERE user_id <> ? AND id IN (SELECT value FROM json_each(?))`).bind(userId,JSON.stringify(candidates.map((row) => row.id))).all<{ id: string }>();
      const blocked = new Set(foreign.results.map((row) => row.id));
      for (const row of candidates) { if (blocked.has(String(row.id))) { conflicts++; describe(row,'记录标识已被占用，无法补入。'); } else additions[table].push(row); }
    } else additions[table].push(...candidates);
    // Sequence is local to a database. Same-day relative order must still agree
    // when a partial merge contains existing records interleaved with additions.
    if ('sequence' in spec && incoming.some((r) => existing.has(backupRowKey(table,r)))) {
      const expected = incoming.map((r) => String(r.id));
      const actual = [...current[table].filter((r) => expected.includes(String(r.id))),...additions[table]].map((r) => String(r.id));
      if (expected.join('\n') !== actual.join('\n') && additions[table].length) { conflicts += additions[table].length; for (const row of additions[table]) describe(row,'历史记录顺序不同，无法安全合并。'); additions[table] = []; }
    }
    summaries.push({ table,label:spec.label,incoming:incoming.length,added:additions[table].length,skipped,conflicts,conflictExamples });
  }
  const total = summaries.reduce((value,r) => ({ incoming:value.incoming+r.incoming,added:value.added+r.added,skipped:value.skipped+r.skipped,conflicts:value.conflicts+r.conflicts }),{ incoming:0,added:0,skipped:0,conflicts:0 });
  const merged = Object.fromEntries(BACKUP_TABLE_NAMES.map((table) => [table,[...current[table],...additions[table]]])) as Record<BackupTable,BackupRow[]>;
  if (Object.values(merged).reduce((sum,list) => sum+list.length,0) > BACKUP_MAX_ROWS || new TextEncoder().encode(JSON.stringify({kind:'jiashu-os-backup',version:1,exportedAt:backup.exportedAt,tables:merged})).byteLength > BACKUP_MAX_BYTES) throw new BackupCapacityError('恢复后的数据将超过完整备份容量，未写入数据。');
  if (total.added && queryBudget(current,additions) > MAX_RESTORE_QUERIES) throw new BackupCapacityError('当前数据与备份合并超过安全恢复的查询预算；未写入数据。请联系维护者扩容。');
  const backupHash = await backupDigest(backup);
  const previewHash = await backupDigest([userId,backupHash,current]);
  return { preview:{ previewHash,backupHash,canRestore:total.conflicts === 0,total,tables:summaries },current,additions };
}
export async function previewDataRestore(db: BackupDatabase, userId: string, input: unknown): Promise<BackupPreview> { return (await planRestore(db,userId,parseDataBackup(input))).preview; }
function chunks(rows: BackupRow[]) {
  const groups: BackupRow[][] = []; let group: BackupRow[] = []; let bytes = 0;
  for (const row of rows) { const size = new TextEncoder().encode(JSON.stringify(row)).byteLength; if (group.length && bytes+size > 128*1024) { groups.push(group); group=[]; bytes=0; } group.push(row); bytes+=size; }
  if (group.length) groups.push(group); return groups;
}
function guard(db: BackupDatabase, sql: string, values: unknown[]) { return db.prepare(`SELECT CASE WHEN (${sql}) THEN 1 ELSE abs(-9223372036854775808) END AS restore_guard`).bind(...values); }
export async function restoreDataBackup(db: BackupDatabase, userId: string, input: unknown, previewHash: string) {
  const backup = parseDataBackup(input); const plan = await planRestore(db,userId,backup);
  if (previewHash !== plan.preview.previewHash) throw new BackupConflictError('预览后数据已变化，未写入记录。请重新预览。');
  if (!plan.preview.canRestore) throw new BackupConflictError();
  if (!plan.preview.total.added) return { ok:true, added:0, skipped:plan.preview.total.skipped, tables:plan.preview.tables };
  const guards: D1PreparedStatement[] = []; const inserts: D1PreparedStatement[] = [];
  guards.push(guard(db,BACKUP_TABLE_NAMES.map((table)=>`(SELECT COUNT(*) FROM ${table} WHERE user_id = ?) = ?`).join(' AND '),BACKUP_TABLE_NAMES.flatMap((table)=>[userId,plan.current[table].length])));
  for (const table of BACKUP_TABLE_NAMES) {
    const spec = BACKUP_TABLES[table]; const rows = plan.current[table];
    for (const group of chunks(rows)) {
      const columns = spec.columns; const match = (spec.keys.length ? spec.keys : ['user_id']).map((k) => k === 'user_id' ? 't.user_id = ?' : `t.${k} IS json_extract(b.value, '$.${k}')`).join(' AND ');
      const equal = columns.map((k) => `t.${k} IS json_extract(b.value, '$.${k}')`).join(' AND ');
      guards.push(guard(db,`NOT EXISTS (SELECT 1 FROM json_each(?) b WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.user_id = ? AND ${match} AND ${equal}))`,[JSON.stringify(group),userId,...(spec.keys.length ? [] : [userId])]));
    }
    const columns = spec.columns.filter((c) => c !== 'sequence');
    for (const group of chunks(plan.additions[table])) {
      inserts.push(db.prepare(`INSERT INTO ${table} (user_id,${columns.join(',')}) SELECT ?,${columns.map((c) => `json_extract(value, '$.${c}')`).join(',')} FROM json_each(?) ORDER BY CAST(key AS INTEGER)`).bind(userId,JSON.stringify(group)));
    }
  }
  const affected = existingFinanceAffected(plan.current,plan.additions);
  if (affected.length) inserts.push(db.prepare('UPDATE finance_accounts SET balance_revision = balance_revision + 1 WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))').bind(userId,JSON.stringify(affected)));
  try { await db.batch([...guards,...inserts]); }
  catch { throw new BackupConflictError('恢复期间数据发生变化或关联冲突，未写入任何记录。请重新预览。'); }
  return { ok:true, added:plan.preview.total.added, skipped:plan.preview.total.skipped, tables:plan.preview.tables };
}
