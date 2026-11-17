import { BACKUP_TABLE_NAMES, BACKUP_TABLES, SINGLE_BACKUP_LIMITS, BackupCapacityError, backupDigest, backupRowKey, comparableBackupRow, parseDataBackup } from '../lib/data-backup.ts';
import type { BackupLimits, BackupRow, BackupTable, DataBackup } from '../lib/data-backup.ts';
import { parseBackupInput } from '../lib/backup-volumes.ts';
import { parseDoubanDetails } from '../lib/douban-details.ts';
import { parseTMDBCover } from '../lib/tmdb-cover.ts';
import { parseIMDbRating } from '../lib/imdb-rating.ts';
import { planNutritionBackupRestore, validateNutritionBackupReceipts } from './nutrition-backup-restore.ts';

export type BackupDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export class BackupConflictError extends Error { readonly code = 'BACKUP_CONFLICT'; readonly status = 409; constructor(message = '备份与当前数据有差异，未写入任何记录。请重新预览并处理冲突。') { super(message); this.name = 'BackupConflictError'; } }
export interface BackupFieldDifference { field: string; current: string; incoming: string }
export interface BackupTablePreview { table: BackupTable; label: string; incoming: number; added: number; skipped: number; conflicts: number; conflictExamples: Array<{ record:string;reason:string; differences?: BackupFieldDifference[] }> }
export interface BackupPreview { previewHash: string; backupHash: string; canRestore: boolean; generatedGoalHistoryRows: number; total: { incoming: number; added: number; skipped: number; conflicts: number }; tables: BackupTablePreview[] }
type BackupTables = DataBackup['tables'];
interface RestoreWrites {
  rows: BackupTables;
  financeRevisionAccountIds: string[];
  nutritionStatusInsertSuffix: string;
}
interface Plan { preview: BackupPreview; current: BackupTables; writes: RestoreWrites }
function retainsRicherDoubanData(prior: BackupRow, incoming: BackupRow): boolean {
  const oldDetails = parseDoubanDetails(JSON.parse(String(prior.details_json)));
  const nextDetails = parseDoubanDetails(JSON.parse(String(incoming.details_json)));
  // Published files without local fields normalize to this untouched baseline.
  // Restoring them must not erase, or conflict with, later personal organization.
  const untouchedLocal = incoming.local_revision === 0 && incoming.local_note === '' && incoming.local_hidden === 0
    && JSON.parse(String(incoming.local_tags_json)).length === 0;
  const preserved = { ...incoming, details_json: prior.details_json, local_cover_url: incoming.local_cover_url ?? prior.local_cover_url,
    tmdb_cover_json: parseTMDBCover(JSON.parse(String(incoming.tmdb_cover_json))) === null ? prior.tmdb_cover_json : incoming.tmdb_cover_json,
    tmdb_cover_url: incoming.tmdb_cover_url ?? prior.tmdb_cover_url,
    imdb_rating_json: parseIMDbRating(JSON.parse(String(incoming.imdb_rating_json))) === null ? prior.imdb_rating_json : incoming.imdb_rating_json,
    ...(untouchedLocal ? {local_note:prior.local_note,local_tags_json:prior.local_tags_json,local_hidden:prior.local_hidden} : {}) };
  return Object.entries(nextDetails).every(([key, value]) => JSON.stringify(value) === JSON.stringify(oldDetails[key as keyof typeof oldDetails]))
    && comparableBackupRow('douban_items', prior) === comparableBackupRow('douban_items', preserved);
}
const MAX_RESTORE_QUERIES = 48;
// D1 bounds an individual string binding/result cell to 2 MiB. JSON escaping
// can be larger than the original column text, so check encoded arrays too.
const MAX_RESTORE_BIND_BYTES = 2 * 1024 * 1024 - 4096;
function queryBudget(current: BackupTables, writes: RestoreWrites) {
  const foreignReads = BACKUP_TABLE_NAMES.filter(table => 'globalId' in BACKUP_TABLES[table] && writes.rows[table].length > 0).length;
  const preparedGroups = BACKUP_TABLE_NAMES.reduce((sum, table) => sum + chunks(current[table]).length + chunks(writes.rows[table]).length, 0);
  return 1 + foreignReads + 1 + (writes.financeRevisionAccountIds.length ? 1 : 0) + preparedGroups;
}

function prepareRestore(current: BackupTables, additions: BackupTables) {
  const { rows, syntheticRows } = restorationRows(current, additions);
  const nutrition = planNutritionBackupRestore(current, rows);

  // When old balances are inserted, invalidate the affected accounts' prior
  // correction previews. Use the same account IDs in projection and commit.
  const existingAccounts = new Set(current.finance_accounts.map(row => row.id));
  const financeRevisionAccounts = new Set(
    [...rows.finance_balance_entries, ...rows.finance_balance_changes]
      .map(row => String(row.account_id)).filter(id => existingAccounts.has(id)),
  );
  const projected = Object.fromEntries(BACKUP_TABLE_NAMES.map(table => [table, [...current[table], ...rows[table]]])) as BackupTables;
  projected.nutrition_day_status = nutrition.statuses;
  projected.finance_accounts = projected.finance_accounts.map(row =>
    financeRevisionAccounts.has(String(row.id)) ? { ...row, balance_revision: Number(row.balance_revision) + 1 } : row,
  );
  const writes: RestoreWrites = {
    rows,
    financeRevisionAccountIds: [...financeRevisionAccounts],
    nutritionStatusInsertSuffix: nutrition.insertSuffix,
  };
  return { writes, syntheticRows, projected };
}

async function readTables(db: BackupDatabase, userId: string, limits: BackupLimits): Promise<Record<BackupTable, BackupRow[]>> {
  // One read snapshot, one query regardless of the number of business tables.
  // Each row is its own JSON value, avoiding a large json_group_array cell.
  const union = BACKUP_TABLE_NAMES.map((table) => {
    const row=`json_object(${BACKUP_TABLES[table].columns.map((column)=>`'${column}',${column}`).join(',')})`;
    return `SELECT '${table}' AS tableName,CASE WHEN length(CAST(${row} AS BLOB))>${MAX_RESTORE_BIND_BYTES-2} THEN NULL ELSE ${row} END AS rowJson FROM ${table} WHERE user_id=?`;
  }).join(' UNION ALL ');
  const result = await db.prepare(union+' LIMIT ?').bind(...BACKUP_TABLE_NAMES.map(()=>userId),limits.maxRows+1).all<{tableName:BackupTable;rowJson:string|null}>();
  if (result.results.length > limits.maxRows) throw new BackupCapacityError('完整备份超过当前格式行数上限，请选择分卷格式；整组最多 40,000 行。');
  const rows = Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,[]])) as unknown as Record<BackupTable,BackupRow[]>;
  for (const row of result.results) {
    if(row.rowJson===null)throw new BackupCapacityError('单条历史记录经 JSON 编码后超过数据库安全容量，未截断导出。请联系维护者处理这条历史记录。');
    rows[row.tableName].push(JSON.parse(row.rowJson) as BackupRow);
  }
  for (const table of BACKUP_TABLE_NAMES) rows[table].sort((a,b) => 'sequence' in BACKUP_TABLES[table] ? Number(a.sequence)-Number(b.sequence) : backupRowKey(table,a).localeCompare(backupRowKey(table,b)));
  return rows;
}
export async function exportDataBackup(db: BackupDatabase, userId: string, now = new Date().toISOString(), limits: BackupLimits = SINGLE_BACKUP_LIMITS): Promise<DataBackup> {
  const backup: DataBackup = { kind: 'jiashu-os-backup', version: 2, exportedAt: now, tables: await readTables(db,userId,limits) };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > limits.maxBytes) throw new BackupCapacityError('完整备份超过当前格式容量，请选择分卷格式；整组最多 16 MiB。');
  const empty = Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,[]])) as unknown as Record<BackupTable,BackupRow[]>;
  const { writes, projected: restoredTables } = prepareRestore(empty, backup.tables);
  if (Object.values(restoredTables).reduce((sum,list)=>sum+list.length,0)>limits.maxRows || new TextEncoder().encode(JSON.stringify({...backup,tables:restoredTables})).byteLength>limits.maxBytes) throw new BackupCapacityError('备份包含恢复基线和饮食状态生成记录后将超过恢复容量；未截断记录。');
  if (queryBudget(empty,writes) > MAX_RESTORE_QUERIES) throw new BackupCapacityError('备份过大，超过安全恢复的查询预算；未截断记录。');
  // Export and restore use exactly the same validator; never offer an unrestorable download.
  const parsed = parseDataBackup(backup,Date.now(),limits);
  await validateNutritionBackupReceipts(parsed.tables);
  return parsed;
}
async function planRestore(db: BackupDatabase, userId: string, backup: DataBackup, limits: BackupLimits): Promise<Plan> {
  await validateNutritionBackupReceipts(backup.tables);
  const current = await readTables(db,userId,limits);
  const additions = Object.fromEntries(BACKUP_TABLE_NAMES.map((table) => [table,[]])) as unknown as Record<BackupTable, BackupRow[]>;
  const summaries: BackupTablePreview[] = [];
  for (const table of BACKUP_TABLE_NAMES) {
    const incoming = backup.tables[table]; const existing = new Map(current[table].map((row) => [backupRowKey(table,row),row]));
    let skipped = 0; let conflicts = 0;
    const conflictExamples: BackupTablePreview['conflictExamples'] = [];
    const describe = (row: BackupRow, reason: string) => {
      if (conflictExamples.length >= 5) return;
      const example: BackupTablePreview['conflictExamples'][number] = {record:String(row.name ?? row.title ?? row.record_key ?? row.date ?? row.as_of_date ?? row.id ?? (row.ledger ? String(row.ledger)+' / '+row.currency : spec.label)),reason};
      conflictExamples.push(example);return example;
    };
    const spec = BACKUP_TABLES[table];
    const candidates: BackupRow[] = [];
    for (const row of incoming) {
      const prior = existing.get(backupRowKey(table,row));
      if (!prior) candidates.push(row);
      else if (comparableBackupRow(table,prior) === comparableBackupRow(table,row) || table === 'douban_items' && retainsRicherDoubanData(prior,row)) skipped++;
      else {
        conflicts++;const example=describe(row,'已有记录内容不同，需要先核对当前记录。');
        if(example) {
          const display=(value:BackupRow[string])=>value===null?'未填写':String(value).slice(0,240)+(String(value).length>240?'…':'');
          example.differences=spec.columns.filter((field)=>field!=='sequence'&&prior[field]!==row[field]).slice(0,8).map((field)=>({field,current:display(prior[field]),incoming:display(row[field])}));
        }
      }
    }
    if (table === 'health_goal_versions' && current.health_goal_settings.length && candidates.length) {
      for (const row of candidates) { conflicts++; describe(row,'已有健康目标的历史不能直接补写，请先核对完整版本。'); }
      candidates.length=0;
    }
    if(table==='finance_account_classifications'&&candidates.length){
      const currentAccounts=new Set(current.finance_accounts.map((row)=>row.id));
      for(let index=candidates.length-1;index>=0;index--)if(currentAccounts.has(candidates[index].account_id)){
        conflicts++;describe(candidates[index],'已有账户的分类与归档历史不能补写，以免改变过去月份的口径。');candidates.splice(index,1);
      }
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
      const expectedIds = new Set(expected);
      const actual = [...current[table].filter((r) => expectedIds.has(String(r.id))),...additions[table]].map((r) => String(r.id));
      if (expected.join('\n') !== actual.join('\n') && additions[table].length) { conflicts += additions[table].length; for (const row of additions[table]) describe(row,'历史记录顺序不同，无法安全合并。'); additions[table] = []; }
    }
    summaries.push({ table,label:spec.label,incoming:incoming.length,added:additions[table].length,skipped,conflicts,conflictExamples });
  }
  const total = summaries.reduce((value,r) => ({ incoming:value.incoming+r.incoming,added:value.added+r.added,skipped:value.skipped+r.skipped,conflicts:value.conflicts+r.conflicts }),{ incoming:0,added:0,skipped:0,conflicts:0 });
  const { writes, syntheticRows, projected: restoredTables } = prepareRestore(current, additions);
  if (Object.values(restoredTables).reduce((sum,list) => sum+list.length,0) > limits.maxRows || new TextEncoder().encode(JSON.stringify({kind:'jiashu-os-backup',version:2,exportedAt:backup.exportedAt,tables:restoredTables})).byteLength > limits.maxBytes) throw new BackupCapacityError('恢复后的数据将超过完整备份容量，未写入数据。');
  if (!total.conflicts) parseDataBackup({kind:'jiashu-os-backup',version:2,exportedAt:backup.exportedAt,tables:restoredTables},Date.now(),limits);
  if (total.added && queryBudget(current,writes) > MAX_RESTORE_QUERIES) throw new BackupCapacityError('当前数据与备份合并超过安全恢复的查询预算；未写入数据。请联系维护者扩容。');
  const backupHash = await backupDigest(backup);
  const previewHash = await backupDigest([userId,backupHash,current]);
  return { preview:{ previewHash,backupHash,canRestore:total.conflicts === 0,generatedGoalHistoryRows:syntheticRows,total,tables:summaries },current,writes };
}
function restorationRows(current: Record<BackupTable,BackupRow[]>, additions: Record<BackupTable,BackupRow[]>) {
  const rows = Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,additions[table].map((row)=>({...row}))])) as Record<BackupTable,BackupRow[]>;
  for (const table of ['health_weight_plan_settings','finance_runway_settings'] as const) for (const row of rows[table]) row.revision=Math.max(1,Number(row.revision));
  let syntheticRows=0;
  const goal=rows.health_goal_settings[0];
  if (goal && goal.revision === 0 && current.health_goal_settings.length === 0) {
    const baseline={revision:0,effective_from:'1970-01-01',steps_target:goal.steps_target,sleep_target:goal.sleep_target,active_energy_target:goal.active_energy_target,created_at:goal.updated_at};
    if (!rows.health_goal_versions.length) { rows.health_goal_versions.push(baseline); syntheticRows++; }
    rows.health_goal_versions.push({...baseline,revision:1}); syntheticRows++; goal.revision=1;
  }
  return {rows,syntheticRows};
}
export async function previewDataRestore(db: BackupDatabase, userId: string, input: unknown): Promise<BackupPreview> { const {backup,limits}=await parseBackupInput(input);return (await planRestore(db,userId,backup,limits)).preview; }
function chunks(rows: BackupRow[]) {
  const groups: BackupRow[][] = []; let group: BackupRow[] = []; let bytes = 2;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if(size+2>MAX_RESTORE_BIND_BYTES)throw new BackupCapacityError('单条历史记录经 JSON 编码后超过数据库安全容量，未写入数据。');
    if (group.length && bytes+size+1 > 1024*1024) { groups.push(group); group=[]; bytes=2; }
    bytes+=size+(group.length?1:0);group.push(row);
  }
  if (group.length) groups.push(group); return groups;
}
function guard(db: BackupDatabase, sql: string, values: unknown[]) { return db.prepare(`SELECT CASE WHEN (${sql}) THEN 1 ELSE abs(-9223372036854775808) END AS restore_guard`).bind(...values); }
export async function restoreDataBackup(db: BackupDatabase, userId: string, input: unknown, previewHash: string) {
  const {backup,limits} = await parseBackupInput(input); const plan = await planRestore(db,userId,backup,limits);
  if (previewHash !== plan.preview.previewHash) throw new BackupConflictError('预览后数据已变化，未写入记录。请重新预览。');
  if (!plan.preview.canRestore) throw new BackupConflictError();
  if (!plan.preview.total.added) return { ok:true, added:0, generatedGoalHistoryRows:0, skipped:plan.preview.total.skipped, tables:plan.preview.tables };
  const { rows: restored, financeRevisionAccountIds, nutritionStatusInsertSuffix } = plan.writes;
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
    for (const group of chunks(restored[table])) {
      const triggerRestore = table === 'nutrition_day_status' ? nutritionStatusInsertSuffix : '';
      // Restoring a known classification is an explicit confirmation; preserve it through later metadata refreshes without exporting internal run markers.
      const internalColumn=table==='douban_items'?',metadata_checked_run_id,collection_hash,details_checked_at':'';
      const internalValue=table==='douban_items'?",CASE WHEN json_extract(value,'$.domain')='screen' AND json_extract(value,'$.kind') IN ('movie','series') THEN 'manual-kind' ELSE NULL END,NULL,NULL":'';
      inserts.push(db.prepare(`INSERT INTO ${table} (user_id,${columns.join(',')}${internalColumn}) SELECT ?,${columns.map((c) => `json_extract(value, '$.${c}')`).join(',')}${internalValue} FROM json_each(?) WHERE 1 ORDER BY CAST(key AS INTEGER)${triggerRestore}`).bind(userId,JSON.stringify(group)));
    }
  }
  if (financeRevisionAccountIds.length) inserts.push(db.prepare('UPDATE finance_accounts SET balance_revision = balance_revision + 1 WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))').bind(userId,JSON.stringify(financeRevisionAccountIds)));
  try { await db.batch([...guards,...inserts]); }
  catch { throw new BackupConflictError('恢复期间数据发生变化或关联冲突，未写入任何记录。请重新预览。'); }
  return { ok:true, added:plan.preview.total.added, generatedGoalHistoryRows:plan.preview.generatedGoalHistoryRows, skipped:plan.preview.total.skipped, tables:plan.preview.tables };
}
