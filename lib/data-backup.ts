import { measurementDay, measurementKey, normalizeTimestamp, parseSyncPayload } from './health.ts';
import { parseGoalSettingsInput } from './health-goals.ts';
import { parseWeightPlanInput } from './weight-plan.ts';
import { parseNutritionCreate } from './nutrition.ts';
import { decimalFromMinor, parseAccountPatch, parseAsOfDate, parseCurrency, parseLedger } from './finance.ts';
import { parseFinanceGoalCreate } from './finance-goals.ts';
import { parseFinanceRunwayInput } from './finance-runway.ts';

export const BACKUP_MAX_BYTES = 8 * 1024 * 1024;
export const BACKUP_MAX_ROWS = 20000;
export const BACKUP_EXCLUDED = ['AI 凭据与调用计数', '同步设备与连接密钥'] as const;
export type BackupRow = Record<string, string | number | null>;
interface TableSpec { label: string; columns: readonly string[]; keys: readonly string[]; sequence?: boolean; globalId?: boolean }
// Identifiers are application constants. File input never becomes a SQL identifier.
export const BACKUP_TABLES = {
  health_measurements: { label: '健康原始记录', columns: ['record_key','metric','day','measurement_json','exported_at','received_at'], keys: ['record_key'] },
  health_syncs: { label: '同步回执', columns: ['payload_hash','exported_at','received_at','measurement_count'], keys: ['payload_hash'] },
  health_import_batches: { label: '导入与回退历史', columns: ['batch_id','payload_hash','operation_id','before_json','after_json','receipt_json','created_at','reverted_at','revert_reason','revert_id'], keys: ['batch_id'] },
  health_goal_settings: { label: '健康目标', columns: ['steps_target','sleep_target','active_energy_target','updated_at'], keys: [] },
  health_weight_plan_settings: { label: '体重计划', columns: ['baseline_weight','target_weight','start_date','deadline','enabled','created_at','updated_at'], keys: [] },
  health_record_changes: { label: '健康修改历史', columns: ['change_id','record_key','request_hash','action','target_revision','before_state_json','after_state_json','reason','created_at'], keys: ['change_id'] },
  health_record_overrides: { label: '健康更正与屏蔽', columns: ['record_key','metric','day','override_json','deleted','revision','last_change_id','created_at','updated_at'], keys: ['record_key'] },
  nutrition_entries: { label: '饮食记录（含已删除）', columns: ['id','date','meal','name','portion','note','calories_tenth','creation_hash','revision','created_at','updated_at','deleted_at'], keys: ['id'], globalId: true },
  finance_accounts: { label: '财务账户（含归档）', columns: ['id','ledger','name','type','currency','creation_hash','note','balance_revision','created_at','updated_at','archived_at'], keys: ['id'], globalId: true },
  finance_balance_entries: { label: '余额原始历史', columns: ['sequence','id','account_id','amount_minor','as_of_date','note','created_at'], keys: ['id'], sequence: true, globalId: true },
  finance_balance_changes: { label: '余额更正与作废历史', columns: ['sequence','id','account_id','entry_id','revision','action','amount_minor','as_of_date','note','reason','request_hash','created_at'], keys: ['id'], sequence: true, globalId: true },
  finance_goal_plans: { label: '资金目标（含归档）', columns: ['id','ledger','currency','name','target_minor','deadline','account_ids_json','creation_hash','created_at','updated_at','archived_at'], keys: ['id'], globalId: true },
  finance_runway_settings: { label: '应急储备设置', columns: ['ledger','currency','monthly_expense_minor','target_months','account_ids_json','created_at','updated_at'], keys: ['ledger','currency'] },
} satisfies Record<string, TableSpec>;
export type BackupTable = keyof typeof BACKUP_TABLES;
export const BACKUP_TABLE_NAMES = Object.keys(BACKUP_TABLES) as BackupTable[];
export interface DataBackup { kind: 'jiashu-os-backup'; version: 1; exportedAt: string; tables: Record<BackupTable, BackupRow[]> }
export class BackupValidationError extends Error { readonly code = 'INVALID_DATA_BACKUP'; readonly status = 400; constructor(message: string) { super(message); this.name = 'BackupValidationError'; } }
export class BackupCapacityError extends RangeError { constructor(message: string) { super(message); this.name = 'BackupCapacityError'; } }
export function backupFail(message: string): never { throw new BackupValidationError(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return backupFail('备份中应为完整的对象。');
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[]) { const row = object(value); if (Object.keys(row).length !== fields.length || fields.some((key) => !Object.hasOwn(row, key))) backupFail('备份含有缺失或不受支持的字段。'); return row; }
function text(value: unknown, maximum = 500, empty = true): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return backupFail('备份文字字段无效。');
  return value;
}
function timestamp(value: unknown, nullable = false) { if (value === null && nullable) return; if (!normalizeTimestamp(value)) backupFail('备份时间无效。'); }
function day(value: unknown) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !normalizeTimestamp(value + 'T12:00:00Z')) backupFail('备份日期无效。'); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) backupFail('备份整数无效。'); }
function id(value: unknown, initial = false) { if (typeof value !== 'string' || !(initial ? /^(?:initial:)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i : /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).test(value)) backupFail('备份记录标识无效。'); }
function hash(value: unknown, nullable = false) { if (nullable && value === null) return; if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) backupFail('备份摘要无效。'); }
function minor(value: unknown, positive = false) { if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,17})$/.test(value) || (positive && value === '0')) backupFail('备份金额无效。'); }
function parsedJson(value: unknown) { text(value, 2 * 1024 * 1024, false); try { return JSON.parse(value as string) as unknown; } catch { return backupFail('备份内嵌 JSON 无效。'); } }
function canonical(value: unknown): string { return JSON.stringify(value,(_key,item:unknown)=>item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item); }
function measurement(value: unknown, exportedAt: string) {
  try { return parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt, measurements: [value] }).measurements[0]; }
  catch { return backupFail('备份健康记录不符合指标、单位、数值或时间规则。'); }
}
function rawHealth(value: unknown, now: number) {
  const r = exact(value, ['recordKey','metric','day','measurementJson','exportedAt','receivedAt']);
  timestamp(r.exportedAt); timestamp(r.receivedAt); day(r.day);
  if (Date.parse(r.exportedAt as string) > now + 5*60000) backupFail('健康导出时间不能晚于当前时间。');
  const m = measurement(parsedJson(r.measurementJson), r.exportedAt as string);
  if (measurementKey(m) !== r.recordKey || measurementDay(m) !== r.day || m.metric !== r.metric) backupFail('备份健康记录标识与内容不一致。');
  return r;
}
function recordState(value: unknown, key: string, now: number): Record<string, unknown> {
  const r = exact(value, ['recordKey','metric','day','base','effective','override','deleted','revision','updatedAt','manual']);
  if (r.recordKey !== key || typeof r.deleted !== 'boolean' || typeof r.manual !== 'boolean') backupFail('健康修改历史状态无效。');
  integer(r.revision); timestamp(r.updatedAt, true); day(r.day);
  const horizon = new Date(now + 5*60000).toISOString();
  const effective = measurement(r.effective, horizon);
  if (measurementKey(effective) !== key || effective.metric !== r.metric || measurementDay(effective) !== r.day) backupFail('健康修改历史标识不一致。');
  if (r.override !== null && measurementKey(measurement(r.override, horizon)) !== key) backupFail('健康更正标识不一致。');
  if (r.base !== null) {
    const base = exact(r.base, ['measurement','exportedAt','receivedAt']); timestamp(base.exportedAt); timestamp(base.receivedAt);
    if (Date.parse(base.exportedAt as string) > now + 5*60000) backupFail('健康历史导出时间不能晚于当前时间。');
    if (measurementKey(measurement(base.measurement, base.exportedAt as string)) !== key) backupFail('健康原值标识不一致。');
  }
  if (r.base === null && r.override === null) backupFail('健康状态缺少原值与更正值。');
  const source = r.override ?? (r.base as Record<string,unknown>).measurement;
  if (canonical(r.effective) !== canonical(source) || r.manual !== (r.base === null)) backupFail('健康历史的有效值与来源不一致。');
  return r;
}
function validateRow(table: BackupTable, r: BackupRow, now: number) {
  for (const [key, value] of Object.entries(r)) {
    if (value !== null && !['string','number'].includes(typeof value)) backupFail('备份数据库字段类型无效。');
    if (typeof value === 'number' && !Number.isFinite(value)) backupFail('备份中含无效数字。');
    if (key.endsWith('_at')) timestamp(value, ['archived_at','deleted_at','reverted_at'].includes(key));
    if (['note','reason','revert_reason'].includes(key) && value !== null) text(value);
  }
  if (table === 'health_measurements') rawHealth({ recordKey:r.record_key, metric:r.metric, day:r.day, measurementJson:r.measurement_json, exportedAt:r.exported_at, receivedAt:r.received_at },now);
  if (table === 'health_syncs') { hash(r.payload_hash); integer(r.measurement_count, 0, 1000); }
  if (table === 'health_import_batches') {
    hash(r.batch_id); id(r.operation_id); hash(r.payload_hash); if (r.batch_id !== r.payload_hash) backupFail('导入批次摘要不一致。');
    if (r.revert_id !== null) id(r.revert_id);
    if ((r.reverted_at === null) !== (r.revert_id === null) || (r.reverted_at === null) !== (r.revert_reason === null)) backupFail('导入回退状态不完整。');
    const beforeKeys: string[] = []; const afterKeys: string[] = [];
    for (const field of ['before_json','after_json']) {
      const rows = parsedJson(r[field]); if (!Array.isArray(rows) || rows.length > 1000) backupFail('导入历史行数无效。');
      for (const item of rows) {
        const row = object(item);
        if (field === 'before_json') { exact(row, ['recordKey','base']); if (row.base !== null && rawHealth(row.base,now).recordKey !== row.recordKey) backupFail('导入历史原值标识不一致。'); text(row.recordKey, 200, false); beforeKeys.push(row.recordKey as string); }
        else { rawHealth(row,now); afterKeys.push(row.recordKey as string); }
      }
    }
    if (new Set(beforeKeys).size !== beforeKeys.length || beforeKeys.sort().join('\n') !== afterKeys.sort().join('\n')) backupFail('导入历史修改前后标识不一致。');
    const receipt = exact(parsedJson(r.receipt_json), ['ok','batchId','imported','skipped','lastSync','summary','canRevert']);
    if (receipt.ok !== true || receipt.batchId !== r.batch_id || typeof receipt.canRevert !== 'boolean') backupFail('导入回执无效。');
    integer(receipt.imported,0,1000); integer(receipt.skipped,0,1000); timestamp(receipt.lastSync);
    if (Number(receipt.imported) + Number(receipt.skipped) < afterKeys.length || Number(receipt.imported) + Number(receipt.skipped) > 1000 || receipt.canRevert !== (afterKeys.length > 0) || receipt.lastSync !== r.created_at) backupFail('导入回执行数或时间不一致。');
    const summary = exact(receipt.summary, ['from','to','metrics','sourceChanges','manualOverrides']);
    if (summary.from !== null) day(summary.from); if (summary.to !== null) day(summary.to);
    if ((summary.from === null) !== (summary.to === null) || (typeof summary.from === 'string' && typeof summary.to === 'string' && summary.from > summary.to)) backupFail('导入回执日期范围无效。');
    integer(summary.sourceChanges,0,1000); integer(summary.manualOverrides,0,1000);
    if (!Array.isArray(summary.metrics) || summary.metrics.length > 5 || summary.metrics.some((v) => !['体重','去脂体重','步数','活动能量','睡眠'].includes(String(v)))) backupFail('导入回执指标无效。');
  }
  if (table === 'health_goal_settings') parseGoalSettingsInput({ targets: { steps:r.steps_target, sleep:r.sleep_target, active_energy:r.active_energy_target } });
  if (table === 'health_weight_plan_settings') { integer(r.enabled, 0, 1); parseWeightPlanInput({ baselineWeight:r.baseline_weight, targetWeight:r.target_weight, startDate:r.start_date, deadline:r.deadline, enabled:r.enabled === 1 }, now); }
  if (table === 'health_record_changes') {
    id(r.change_id); hash(r.request_hash); text(r.record_key, 200, false); integer(r.target_revision, 1);
    if (!['create','correct','hide','restore','reset'].includes(String(r.action))) backupFail('健康修改操作无效。');
    if (r.before_state_json !== null) recordState(parsedJson(r.before_state_json), r.record_key as string,now);
    const after = recordState(parsedJson(r.after_state_json), r.record_key as string,now);
    if (after.revision !== r.target_revision || after.updatedAt !== r.created_at) backupFail('健康修改历史版本或时间不一致。');
    if (r.action === 'create') { if (r.before_state_json !== null || r.target_revision !== 1 || after.base !== null || after.deleted !== false) backupFail('健康补录历史无效。'); }
    else { if (r.before_state_json === null || recordState(parsedJson(r.before_state_json),r.record_key as string,now).revision !== Number(r.target_revision)-1) backupFail('健康修改前后版本不连续。'); }
  }
  if (table === 'health_record_overrides') {
    integer(r.deleted, 0, 1); integer(r.revision, 1); id(r.last_change_id); day(r.day);
    if (r.override_json !== null) { const m = measurement(parsedJson(r.override_json), new Date(now + 5*60000).toISOString()); if (measurementKey(m) !== r.record_key || m.metric !== r.metric || measurementDay(m) !== r.day) backupFail('健康更正标识与内容不一致。'); }
  }
  if (table === 'nutrition_entries') {
    id(r.id); hash(r.creation_hash); integer(r.revision, 1); if (r.calories_tenth !== null) integer(r.calories_tenth, 0, 200000);
    parseNutritionCreate({ date:r.date, meal:r.meal, name:r.name, portion:r.portion, note:r.note, calories:r.calories_tenth === null ? null : (Number(r.calories_tenth) / 10).toFixed(1) }, now);
  }
  if (table === 'finance_accounts') { id(r.id); parseLedger(r.ledger); parseCurrency(r.currency); parseAccountPatch({ name:r.name, type:r.type, note:r.note }); hash(r.creation_hash, true); integer(r.balance_revision); }
  if (table === 'finance_balance_entries') { integer(r.sequence, 1); id(r.id, true); id(r.account_id); minor(r.amount_minor); parseAsOfDate(r.as_of_date); }
  if (table === 'finance_balance_changes') {
    integer(r.sequence, 1); id(r.id); id(r.account_id); id(r.entry_id, true); integer(r.revision, 1); hash(r.request_hash); text(r.reason, 500, false);
    if (r.action === 'void') { if (r.amount_minor !== null || r.as_of_date !== null || r.note !== null) backupFail('作废记录不应携带更正值。'); }
    else if (r.action === 'correct') { minor(r.amount_minor); parseAsOfDate(r.as_of_date); text(r.note); }
    else backupFail('余额修改操作无效。');
  }
  if (table === 'finance_goal_plans') { id(r.id); hash(r.creation_hash); minor(r.target_minor, true); parseFinanceGoalCreate({ ledger:r.ledger, currency:r.currency, name:r.name, targetAmount:decimalFromMinor(r.target_minor as string, r.currency as string), deadline:r.deadline, accountIds:parsedJson(r.account_ids_json) }); }
  if (table === 'finance_runway_settings') { parseLedger(r.ledger); parseCurrency(r.currency); minor(r.monthly_expense_minor, true); parseFinanceRunwayInput({ monthlyExpenseAmount:decimalFromMinor(r.monthly_expense_minor as string, r.currency as string), targetMonths:r.target_months, accountIds:parsedJson(r.account_ids_json) }, r.currency as Parameters<typeof parseFinanceRunwayInput>[1]); }
}
export function backupRowKey(table: BackupTable, row: BackupRow): string { return JSON.stringify((BACKUP_TABLES[table].keys as readonly string[]).map((k) => row[k])); }
export function comparableBackupRow(table: BackupTable, row: BackupRow): string { return JSON.stringify(Object.fromEntries(BACKUP_TABLES[table].columns.filter((k) => k !== 'sequence' && !(table === 'finance_accounts' && k === 'balance_revision')).map((k) => [k,row[k]]))); }

export function parseDataBackup(input: unknown, now = Date.now()): DataBackup {
  try {
    const encoded = typeof input === 'string' ? input : JSON.stringify(input);
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > BACKUP_MAX_BYTES) backupFail('完整备份最多 8 MiB；当前版本不支持分卷恢复。');
    const raw = exact(typeof input === 'string' ? JSON.parse(input) : input, ['kind','version','exportedAt','tables']);
    if (raw.kind !== 'jiashu-os-backup' || raw.version !== 1) backupFail('请选择 Jiashu OS 完整备份 v1 文件。');
    timestamp(raw.exportedAt);
    if (Date.parse(raw.exportedAt as string) > now + 5*60000) backupFail('备份导出时间不能晚于当前时间。');
    const tables = exact(raw.tables, BACKUP_TABLE_NAMES); let count = 0;
    for (const table of BACKUP_TABLE_NAMES) {
      const rows = tables[table]; const spec = BACKUP_TABLES[table] as TableSpec;
      if (!Array.isArray(rows)) backupFail('备份数据表应为数组。');
      count += rows.length; if (count > BACKUP_MAX_ROWS) backupFail('完整备份最多 20,000 行；当前版本不支持分卷恢复。');
      const seen = new Set<string>(); const sequences = new Set<number>();
      for (const value of rows) {
        const row = exact(value, spec.columns) as BackupRow;
        validateRow(table, row,now);
        const key = backupRowKey(table,row); if (seen.has(key)) backupFail('备份中含重复记录。'); seen.add(key);
        if (spec.sequence) { if (sequences.has(row.sequence as number)) backupFail('备份余额顺序重复。'); sequences.add(row.sequence as number); }
      }
      if (spec.keys.length === 0 && rows.length > 1) backupFail('备份单项设置重复。');
      rows.sort((a: BackupRow,b: BackupRow) => spec.sequence ? Number(a.sequence) - Number(b.sequence) : backupRowKey(table,a).localeCompare(backupRowKey(table,b)));
    }
    const result = raw as unknown as DataBackup; validateBackupRelations(result); return result;
  } catch (error) { if (error instanceof BackupValidationError) throw error; return backupFail('备份内容未通过完整性与业务规则检查。'); }
}
function validateBackupRelations(backup: DataBackup) {
  const t = backup.tables; const accounts = new Map(t.finance_accounts.map((r) => [r.id,r]));
  const entries = new Map(t.finance_balance_entries.map((r) => [r.id,r]));
  for (const r of t.finance_balance_entries) { if (!accounts.has(r.account_id)) backupFail('余额缺少关联账户。'); if (String(r.id).startsWith('initial:') && r.id !== 'initial:'+r.account_id) backupFail('初始余额与账户标识不一致。'); }
  const revisions = new Map<string, number>();
  const latestChanges = new Map<string,BackupRow>();
  for (const r of t.finance_balance_changes) {
    const entry = entries.get(r.entry_id); if (!entry || entry.account_id !== r.account_id) backupFail('余额修改缺少关联原记录。');
    const rev = revisions.get(String(r.entry_id)) ?? 0; if (r.revision !== rev + 1) backupFail('余额修改版本不连续。'); revisions.set(String(r.entry_id),Number(r.revision));
    latestChanges.set(String(r.entry_id),r);
  }
  for (const account of t.finance_accounts) if (!t.finance_balance_entries.some((entry)=>entry.account_id === account.id && latestChanges.get(String(entry.id))?.action !== 'void')) backupFail('每个财务账户必须保留至少一条有效余额。');
  for (const r of [...t.finance_goal_plans,...t.finance_runway_settings]) {
    for (const accountId of parsedJson(r.account_ids_json) as string[]) { const account = accounts.get(accountId); if (!account || account.ledger !== r.ledger || account.currency !== r.currency) backupFail('目标或应急设置的关联账户不完整。'); }
  }
  const bases = new Map(t.health_measurements.map((r) => [r.record_key,r]));
  const changes = new Map(t.health_record_changes.map((r) => [r.change_id,r]));
  const overrides = new Map(t.health_record_overrides.map((r)=>[r.record_key,r]));
  const grouped = new Map<string,BackupRow[]>();
  for (const change of t.health_record_changes) { if (!overrides.has(change.record_key)) backupFail('健康修改历史缺少对应更正状态。'); const rows=grouped.get(String(change.record_key))??[];rows.push(change);grouped.set(String(change.record_key),rows); }
  for (const rows of grouped.values()) { rows.sort((a,b)=>Number(a.target_revision)-Number(b.target_revision)); for (let i=0;i<rows.length;i++) if (rows[i].target_revision !== i+1) backupFail('健康修改历史版本不连续。'); }
  for (const r of t.health_record_overrides) {
    const last = changes.get(r.last_change_id);
    if (!last || last.record_key !== r.record_key || last.target_revision !== r.revision || r.updated_at !== last.created_at) backupFail('健康更正缺少匹配的修改历史。');
    if (grouped.get(String(r.record_key))?.at(-1)?.change_id !== r.last_change_id) backupFail('健康更正未指向最后一个修改版本。');
    const after = parsedJson(last.after_state_json) as Record<string,unknown>;
    if (after.metric !== r.metric || after.day !== r.day || after.deleted !== (r.deleted === 1) || canonical(after.override) !== canonical(r.override_json === null ? null : parsedJson(r.override_json))) backupFail('健康当前更正状态与修改历史不一致。');
    if (r.override_json === null && !bases.has(r.record_key)) backupFail('健康更正缺少同步原值。');
  }
  const syncs = new Set(t.health_syncs.map((r)=>r.payload_hash));
  for (const batch of t.health_import_batches) if (!syncs.has(batch.payload_hash)) backupFail('导入历史缺少同步回执。');
}

export async function backupDigest(value: unknown): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map((n) => n.toString(16).padStart(2,'0')).join(''); }
