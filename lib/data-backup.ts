import { measurementDay, measurementKey, normalizeTimestamp, parseSyncPayload, shanghaiDay } from './health.ts';
import { parseGoalSettingsInput } from './health-goals.ts';
import { parseWeightPlanInput } from './weight-plan.ts';
import { validateWeightCycleArchive } from './weight-cycles.ts';
import { parseNutritionTemplate } from './nutrition-templates.ts';
import { parseNutritionCreate, parseNutritionProvenance } from './nutrition.ts';
import type { NutritionInput } from './nutrition.ts';
import { validateFoodSnapshot } from './food-catalog.ts';
import { decimalFromMinor, defaultAccountLiquidity, parseAccountPatch, parseAsOfDate, parseCurrency, parseLedger } from './finance.ts';
import { parseFinanceGoalCreate } from './finance-goals.ts';
import { parseFinanceRunwayInput } from './finance-runway.ts';
import { parseSyncAttemptSummary, SYNC_ATTEMPT_STATUSES, SYNC_FAILURES } from './sync-diagnostics.ts';
import { parseStoredFinanceReview } from './finance-review-close.ts';

export const BACKUP_MAX_BYTES = 8 * 1024 * 1024;
export const BACKUP_MAX_ROWS = 20000;
export interface BackupLimits { maxBytes: number; maxRows: number }
export const SINGLE_BACKUP_LIMITS: BackupLimits = { maxBytes: BACKUP_MAX_BYTES, maxRows: BACKUP_MAX_ROWS };
export const VOLUME_BACKUP_LIMITS: BackupLimits = { maxBytes: 16 * 1024 * 1024, maxRows: 40000 };
export const BACKUP_EXCLUDED = ['AI 凭据与调用计数', '同步设备与连接密钥'] as const;
export type BackupRow = Record<string, string | number | null>;
interface TableSpec { label: string; columns: readonly string[]; keys: readonly string[]; sequence?: boolean; globalId?: boolean }
// Identifiers are application constants. File input never becomes a SQL identifier.
export const BACKUP_TABLES = {
  health_measurements: { label: '健康原始记录', columns: ['record_key','metric','day','measurement_json','exported_at','received_at'], keys: ['record_key'] },
  health_syncs: { label: '同步回执', columns: ['payload_hash','exported_at','received_at','measurement_count'], keys: ['payload_hash'] },
  health_import_batches: { label: '导入与回退历史', columns: ['batch_id','payload_hash','operation_id','before_json','after_json','receipt_json','created_at','reverted_at','revert_reason','revert_id'], keys: ['batch_id'] },
  health_sync_attempts: { label: '同步诊断回执', columns: ['attempt_id','created_at','channel','device_label','status','batch_id','error_code','summary_json'], keys: ['attempt_id'] },
  health_goal_settings: { label: '健康目标', columns: ['steps_target','sleep_target','active_energy_target','updated_at','revision'], keys: [] },
  health_goal_versions: { label: '健康目标历史', columns: ['revision','effective_from','steps_target','sleep_target','active_energy_target','created_at'], keys: ['revision'] },
  health_weight_plan_settings: { label: '当前体重周期', columns: ['baseline_weight','target_weight','start_date','deadline','enabled','created_at','updated_at','revision','cycle_id','archived_at'], keys: [] },
  health_weight_plan_cycles: { label: '体重周期归档', columns: ['id','settings_json','summary_json','started_at','archived_at'], keys: ['id'] },
  health_weight_plan_operations: { label: '体重周期操作回执', columns: ['id','action','request_hash','cycle_id','created_at'], keys: ['id'] },
  health_record_changes: { label: '健康修改历史', columns: ['change_id','record_key','request_hash','action','target_revision','before_state_json','after_state_json','reason','created_at'], keys: ['change_id'] },
  health_record_overrides: { label: '健康更正与屏蔽', columns: ['record_key','metric','day','override_json','deleted','revision','last_change_id','created_at','updated_at'], keys: ['record_key'] },
  nutrition_entry_history: { label: '饮食来源与修改历史', columns: ['entry_id','revision','action','before_json','after_json','created_at'], keys: ['entry_id','revision'] },
  nutrition_entries: { label: '饮食记录（含营养素、已删除与食物来源）', columns: ['id','date','meal','name','portion','note','calories_tenth','carbs_tenth','protein_tenth','fat_tenth','food_json','provenance_json','creation_hash','revision','created_at','updated_at','deleted_at'], keys: ['id'], globalId: true },
  nutrition_goal_settings: { label: '每日营养目标', columns: ['calories_tenth','carbs_tenth','protein_tenth','fat_tenth','revision','created_at','updated_at'], keys: [] },
  nutrition_restore_operations: { label: '饮食历史恢复回执', columns: ['id','entry_id','source_revision','target_revision','request_hash','created_at'], keys: ['id'] },
  nutrition_favorites: { label: '常用食物', columns: ['id','template_hash','template_json','created_at'], keys: ['template_hash'], globalId: true },
  nutrition_templates: { label: '自建食物、食谱与整餐模板', columns: ['id','kind','name','template_json','creation_hash','revision','created_at','updated_at','archived_at'], keys: ['id'], globalId: true },
  nutrition_template_operations: { label: '食物模板操作回执', columns: ['id','template_id','action','request_hash','result_json','created_at'], keys: ['id'], globalId: true },
  nutrition_day_status: { label: '饮食记录完整度', columns: ['date','complete','meals_json','revision','updated_at'], keys: ['date'] },
  nutrition_batches: { label: '饮食批量提交回执', columns: ['id','request_hash','entry_ids_json','created_at'], keys: ['id'] },
  nutrition_copy_operations: { label: '餐次复制回执', columns: ['id','request_hash','entry_ids_json','created_at'], keys: ['id'], globalId: true },
  finance_accounts: { label: '财务账户（含归档与流动性）', columns: ['id','ledger','name','type','currency','creation_hash','note','balance_revision','metadata_revision','liquidity_kind','usable_bps','created_at','updated_at','archived_at'], keys: ['id'], globalId: true },
  finance_account_classifications: { label: '财务分类与归档生效历史', columns: ['account_id','revision','effective_from','type','archived','origin','recorded_at'], keys: ['account_id','revision'] },
  finance_balance_entries: { label: '余额原始历史', columns: ['sequence','id','account_id','amount_minor','as_of_date','note','created_at'], keys: ['id'], sequence: true, globalId: true },
  finance_balance_changes: { label: '余额更正与作废历史', columns: ['sequence','id','account_id','entry_id','revision','action','amount_minor','as_of_date','note','reason','request_hash','created_at'], keys: ['id'], sequence: true, globalId: true },
  finance_goal_plans: { label: '资金目标（含归档）', columns: ['id','ledger','currency','name','target_minor','deadline','account_ids_json','creation_hash','revision','created_at','updated_at','archived_at'], keys: ['id'], globalId: true },
  finance_runway_settings: { label: '应急储备设置', columns: ['ledger','currency','monthly_expense_minor','target_months','account_ids_json','created_at','updated_at','revision'], keys: ['ledger','currency'] },
  health_sync_diagnostics: { label: '逐指标同步核对', columns: ['scope','received_at','exported_at','submitted_count','imported_count','skipped_count','first_day','last_day'], keys: ['scope'] },
  health_weekly_actions: { label: '每周行动与反馈', columns: ['week_start','text','status','feedback','revision','created_at','updated_at'], keys: ['week_start'] },
  finance_month_closes: { label: '已确认月结与重结历史', columns: ['ledger','currency','month','version','operation_id','request_hash','snapshot_json','reason','closed_at'], keys: ['ledger','currency','month','version'] },
} satisfies Record<string, TableSpec>;
export type BackupTable = keyof typeof BACKUP_TABLES;
export const BACKUP_TABLE_NAMES = Object.keys(BACKUP_TABLES) as BackupTable[];
const P1_BACKUP_TABLES = ['nutrition_entry_history','nutrition_goal_settings','nutrition_restore_operations'] as const;
const P2_BACKUP_TABLES = ['health_weight_plan_cycles','health_weight_plan_operations','nutrition_templates','nutrition_template_operations','finance_account_classifications'] as const;
const ACTION_BACKUP_TABLES = ['health_sync_diagnostics','health_weekly_actions','finance_month_closes'] as const;
/** Published v2 volume sets used these 27 tables; their signed shape must remain verifiable. */
export const BACKUP_PREVIOUS_V2_TABLE_NAMES = BACKUP_TABLE_NAMES.filter((table) => !(ACTION_BACKUP_TABLES as readonly string[]).includes(table));
const BACKUP_LEGACY_V2_TABLE_NAMES = BACKUP_TABLE_NAMES.filter((table) => !([...P1_BACKUP_TABLES,...P2_BACKUP_TABLES,...ACTION_BACKUP_TABLES] as readonly string[]).includes(table));
export const BACKUP_V1_TABLE_NAMES = ['health_measurements','health_syncs','health_import_batches','health_goal_settings','health_weight_plan_settings','health_record_changes','health_record_overrides','nutrition_entries','finance_accounts','finance_balance_entries','finance_balance_changes','finance_goal_plans','finance_runway_settings'] as const;
const REVISION_SETTINGS: readonly BackupTable[] = ['health_goal_settings','health_weight_plan_settings','finance_runway_settings'];
export interface DataBackup { kind: 'jiashu-os-backup'; version: 2; exportedAt: string; tables: Record<BackupTable, BackupRow[]> }
export class BackupValidationError extends Error { readonly code = 'INVALID_DATA_BACKUP'; readonly status = 400; constructor(message: string) { super(message); this.name = 'BackupValidationError'; } }
export class BackupCapacityError extends RangeError { constructor(message: string) { super(message); this.name = 'BackupCapacityError'; } }
export function backupFail(message: string): never { throw new BackupValidationError(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return backupFail('备份中应为完整的对象。');
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[]) { const row = object(value); if (Object.keys(row).length !== fields.length || fields.some((key) => !Object.hasOwn(row, key))) backupFail('备份含有缺失或不受支持的字段。'); return row; }
function hasControl(value: string, allowWhitespace = true) {
  for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if((code<32&&!(allowWhitespace&&[9,10,13].includes(code)))||code===127)return true;}
  return false;
}
function text(value: unknown, maximum = 500, empty = true): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length) || hasControl(value)) return backupFail('备份文字字段无效。');
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
const nutritionMeals = ['breakfast','lunch','dinner','snack'] as const;
const macroNames = ['carbs', 'protein', 'fat'] as const;
function nutritionBackupRow(value: unknown): Record<string, unknown> {
  const raw = object(value);
  // Both published backup versions predate optional macronutrient columns.
  return { provenance_json:null, ...Object.fromEntries(macroNames.map((key) => [key + '_tenth', null])), ...raw };
}
function compatibleBackupRow(table: BackupTable, value: unknown): Record<string, unknown> {
  const row = table === 'nutrition_entries' ? nutritionBackupRow(value) : object(value);
  if (table === 'finance_accounts') { const liquidity=defaultAccountLiquidity(String(row.type));return { metadata_revision:1,liquidity_kind:liquidity.liquidityKind,usable_bps:liquidity.usableBps, ...row }; }
  if (table === 'finance_goal_plans') return { revision:1, ...row };
  if (table === 'health_weight_plan_settings') return {cycle_id:'legacy',archived_at:null,...row};
  return row;
}
function nutritionSnapshot(row: Record<string, unknown>) {
  return { id:row.id,date:row.date,meal:row.meal,name:row.name,portion:row.portion,note:row.note,
    caloriesTenth:row.calories_tenth,carbsTenth:row.carbs_tenth,proteinTenth:row.protein_tenth,fatTenth:row.fat_tenth,
    revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,deletedAt:row.deleted_at,
    food:row.food_json===null?null:parsedJson(row.food_json),provenance:row.provenance_json===null?null:parsedJson(row.provenance_json) };
}
function nutritionFoodSnapshot(value: unknown) {
  try { return validateFoodSnapshot(value); }
  catch { return backupFail('备份食物来源、历史版本或份量营养数据无法核对。'); }
}
function nutritionFavoriteTemplate(value: unknown, now: number) {
  const raw = object(value);
  const template = exact(raw, ['name','portion','calories','note', ...macroNames.filter((key) => Object.hasOwn(raw, key)), ...(Object.hasOwn(raw,'food') ? ['food'] : []), ...(Object.hasOwn(raw,'provenance') ? ['provenance'] : [])]);
  const macros = Object.fromEntries(macroNames.filter((key) => Object.hasOwn(template, key)).map((key) => [key, template[key]]));
  const parsed = parseNutritionCreate({ date: new Date(now).toISOString().slice(0,10), meal:'snack', name:template.name, portion:template.portion, note:template.note, calories:template.calories, ...macros }, now);
  if (Object.hasOwn(template,'food')) {
    const food = nutritionFoodSnapshot(template.food);
    if (parsed.name !== food.foodName || parsed.portion !== String(food.amount)+food.unit || parsed.caloriesTenth !== food.caloriesTenth) backupFail('常用食物的来源快照与名称、份量或热量不一致。');
    parsed.food = food;
  }
  if (Object.hasOwn(template,'provenance')) parseNutritionProvenance(template.provenance, parsed);
  return template;
}
function nutritionHistorySnapshot(value: unknown, now: number) {
  const row = exact(value, ['id','date','meal','name','portion','note','caloriesTenth','carbsTenth','proteinTenth','fatTenth','revision','createdAt','updatedAt','deletedAt','food','provenance']);
  id(row.id); integer(row.revision,1); timestamp(row.createdAt); timestamp(row.updatedAt); timestamp(row.deletedAt,true);
  if (Date.parse(row.updatedAt as string)>now+5*60000) backupFail('饮食历史时间不能晚于当前时间。');
  for (const key of ['calories','carbs','protein','fat']) if (row[key+'Tenth']!==null) integer(row[key+'Tenth'],0,200000);
  const values=Object.fromEntries(['calories','carbs','protein','fat'].map((key)=>[key,row[key+'Tenth']===null?null:(Number(row[key+'Tenth'])/10).toFixed(1)]));
  const input: NutritionInput = parseNutritionCreate({date:row.date,meal:row.meal,name:row.name,portion:row.portion,note:row.note,...values},now);
  if (row.food!==null) {
    input.food=nutritionFoodSnapshot(row.food);
    if(row.name!==input.food.foodName||row.portion!==String(input.food.amount)+input.food.unit||row.caloriesTenth!==input.food.caloriesTenth)backupFail('饮食历史与食物来源快照不一致。');
  }
  if(row.provenance!==null)parseNutritionProvenance(row.provenance,input);
  return row;
}
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
    if (key.endsWith('_at')) { timestamp(value, ['archived_at','deleted_at','reverted_at'].includes(key)); if (value !== null && Date.parse(value as string) > now + 5*60000) backupFail('备份记录时间不能晚于当前时间。'); }
    if (['note','reason','revert_reason'].includes(key) && value !== null) text(value);
  }
  if (table === 'health_measurements') rawHealth({ recordKey:r.record_key, metric:r.metric, day:r.day, measurementJson:r.measurement_json, exportedAt:r.exported_at, receivedAt:r.received_at },now);
  if (table === 'health_syncs') { hash(r.payload_hash); integer(r.measurement_count, 0, 1000); }
  if (table === 'health_sync_diagnostics') {
    if (!['batch','steps','sleep','active_energy','weight','lean_body_mass'].includes(String(r.scope))) backupFail('逐指标同步核对范围无效。');
    integer(r.submitted_count,0,1000);
    if(r.imported_count!==null)integer(r.imported_count,0,1000);
    if(r.skipped_count!==null)integer(r.skipped_count,0,1000);
    if((r.imported_count===null)!==(r.skipped_count===null)||(r.imported_count!==null&&Number(r.imported_count)+Number(r.skipped_count)!==r.submitted_count))backupFail('同步核对新增与跳过数量不一致。');
    if(r.first_day!==null)day(r.first_day);if(r.last_day!==null)day(r.last_day);
    if((r.first_day===null)!==(r.last_day===null)||(r.first_day!==null&&String(r.first_day)>String(r.last_day)))backupFail('同步核对日期范围无效。');
  }
  if (table === 'health_weekly_actions') {
    if(r.week_start!=='1969-12-29')day(r.week_start);
    if(new Date(String(r.week_start)+'T12:00:00Z').getUTCDay()!==1)backupFail('每周行动必须从周一开始。');
    text(r.text,200,false);text(r.feedback,500);integer(r.revision,1);
    if(!String(r.text).trim()||hasControl(String(r.text),false)||!['planned','completed','not_completed'].includes(String(r.status)))backupFail('每周行动内容或状态无效。');
    if(Date.parse(String(r.created_at))>Date.parse(String(r.updated_at)))backupFail('每周行动创建和修改时间无效。');
    if(String(r.week_start)>shanghaiDay(new Date(now).toISOString())&&(r.status!=='planned'||String(r.feedback).trim()))backupFail('未来每周行动不能带有完成反馈。');
  }
  if (table === 'finance_month_closes') {
    parseLedger(r.ledger);parseCurrency(r.currency);integer(r.version,1);id(r.operation_id);hash(r.request_hash);text(r.reason,500);
    parseStoredFinanceReview(parsedJson(r.snapshot_json),{ledger:String(r.ledger),currency:String(r.currency),month:String(r.month)});
    if(!/^\d{4}-\d{2}$/.test(String(r.month)))backupFail('月结月份无效。');
    day(String(r.month)+'-01');
    if(String(r.month)>=shanghaiDay(String(r.closed_at)).slice(0,7))backupFail('已确认月结必须属于确认时已经结束的月份。');
  }
  if (table === 'health_sync_attempts') {
    id(r.attempt_id); if (!['manual','device'].includes(String(r.channel)) || !SYNC_ATTEMPT_STATUSES.includes(r.status as typeof SYNC_ATTEMPT_STATUSES[number])) backupFail('同步诊断状态无效。');
    if (r.device_label !== null) text(r.device_label,40,false);
    if (r.batch_id !== null) hash(r.batch_id);
    if ((r.status === 'failed' && (typeof r.error_code !== 'string' || !Object.hasOwn(SYNC_FAILURES,r.error_code))) || (r.status !== 'failed' && r.error_code !== null)) backupFail('同步诊断错误码无效。');
    parseSyncAttemptSummary(parsedJson(r.summary_json));
  }
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
  if (table === 'health_goal_settings' || table === 'health_goal_versions') {
    integer(r.revision); parseGoalSettingsInput({ targets: { steps:r.steps_target, sleep:r.sleep_target, active_energy:r.active_energy_target } });
    if (table === 'health_goal_versions') { day(r.effective_from); if (String(r.effective_from) > shanghaiDay(new Date(now).toISOString())) backupFail('健康目标历史不能在未来生效。'); }
  }
  if (table === 'health_weight_plan_settings') { integer(r.revision); integer(r.enabled, 0, 1); if(r.cycle_id!=='legacy')id(r.cycle_id);parseWeightPlanInput({ baselineWeight:r.baseline_weight, targetWeight:r.target_weight, startDate:r.start_date, deadline:r.deadline, enabled:r.enabled === 1 }, now); }
  if(table==='health_weight_plan_cycles')validateWeightCycleArchive({id:r.id,settings:parsedJson(r.settings_json),summary:parsedJson(r.summary_json),startedAt:r.started_at,archivedAt:r.archived_at},now);
  if(table==='health_weight_plan_operations'){id(r.id);if(r.cycle_id!=='legacy')id(r.cycle_id);hash(r.request_hash);if(!['archive','start'].includes(String(r.action))||(r.action==='start'&&r.id!==r.cycle_id))backupFail('体重周期操作回执无效。');}
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
    for (const key of macroNames) if (r[key + '_tenth'] !== null) integer(r[key + '_tenth'], 0, 200000);
    const macros = Object.fromEntries(macroNames.map((key) => [key, r[key + '_tenth'] === null ? null : (Number(r[key + '_tenth']) / 10).toFixed(1)]));
    const input=parseNutritionCreate({ date:r.date, meal:r.meal, name:r.name, portion:r.portion, note:r.note, calories:r.calories_tenth === null ? null : (Number(r.calories_tenth) / 10).toFixed(1), ...macros }, now);
    if (r.food_json !== null) {
      const food = nutritionFoodSnapshot(parsedJson(r.food_json));
      if (r.name !== food.foodName || r.portion !== String(food.amount)+food.unit || r.calories_tenth !== food.caloriesTenth) backupFail('饮食记录的来源快照与名称、份量或热量不一致。');
      input.food=food;
    }
    if(r.provenance_json!==null)parseNutritionProvenance(parsedJson(r.provenance_json),input);
  }
  if(table==='nutrition_entry_history'){
    id(r.entry_id);integer(r.revision,1);if(!['baseline','create','edit','delete','restore'].includes(String(r.action)))backupFail('饮食历史操作无效。');
    const after=nutritionHistorySnapshot(parsedJson(r.after_json),now);
    if(after.id!==r.entry_id||after.revision!==r.revision||after.updatedAt!==r.created_at)backupFail('饮食历史版本或时间不一致。');
    if(r.before_json===null){if(!['baseline','create'].includes(String(r.action)))backupFail('饮食历史缺少修改前状态。');}
    else{const before=nutritionHistorySnapshot(parsedJson(r.before_json),now);if(before.id!==r.entry_id||before.revision!==Number(r.revision)-1||before.createdAt!==after.createdAt)backupFail('饮食历史前后版本不连续。');}
  }
  if(table==='nutrition_goal_settings'){
    integer(r.revision,1);for(const key of ['calories_tenth','carbs_tenth','protein_tenth','fat_tenth'])if(r[key]!==null)integer(r[key],0,200000);
  }
  if(table==='nutrition_restore_operations'){
    id(r.id);id(r.entry_id);integer(r.source_revision,1);integer(r.target_revision,2);hash(r.request_hash);
    if(Number(r.source_revision)>=Number(r.target_revision))backupFail('饮食恢复回执版本无效。');
  }
  if (table === 'nutrition_favorites') { id(r.id); hash(r.template_hash); nutritionFavoriteTemplate(parsedJson(r.template_json), now); }
  if(table==='nutrition_templates'){
    id(r.id);hash(r.creation_hash);integer(r.revision,1);const definition=parseNutritionTemplate(parsedJson(r.template_json));
    if(definition.kind!==r.kind||definition.name!==r.name||canonical(definition)!==canonical(parsedJson(r.template_json)))backupFail('食物模板内容与名称、类型或规范格式不一致。');
  }
  if(table==='nutrition_template_operations'){
    id(r.id);id(r.template_id);hash(r.request_hash);
    const saved=object(parsedJson(r.result_json));const{ id:templateId,revision,createdAt,updatedAt,archivedAt,...definition }=saved;
    parseNutritionTemplate(definition);integer(revision,1);timestamp(createdAt);timestamp(updatedAt);timestamp(archivedAt,true);
    if(templateId!==r.template_id||updatedAt!==r.created_at||!['create','edit','archive'].includes(String(r.action))||(r.action==='create'&&(r.id!==templateId||revision!==1||archivedAt!==null))||(r.action==='edit'&&(Number(revision)<2||archivedAt!==null))||(r.action==='archive'&&(Number(revision)<2||archivedAt!==updatedAt)))backupFail('食物模板回执与保存结果不一致。');
  }
  if (table === 'nutrition_day_status') {
    day(r.date); integer(r.complete, 0, 1); integer(r.revision, 1);
    parseNutritionCreate({ date:r.date, meal:'snack', name:'日期校验', calories:null }, now);
    const meals = object(parsedJson(r.meals_json));
    if (Object.keys(meals).some((meal) => !nutritionMeals.includes(meal as typeof nutritionMeals[number]) || typeof meals[meal]!=='string' || !['unrecorded','recorded','skipped'].includes(meals[meal] as string))) backupFail('备份饮食餐次状态无效。');
  }
  if (table === 'nutrition_copy_operations' || table === 'nutrition_batches') {
    id(r.id); hash(r.request_hash); const ids = parsedJson(r.entry_ids_json);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30 || new Set(ids).size !== ids.length) backupFail('饮食提交回执行数无效。');
    for (const entryId of ids) id(entryId);
  }
  if (table === 'finance_accounts') { id(r.id); parseLedger(r.ledger); parseCurrency(r.currency); parseAccountPatch({ name:r.name, type:r.type, note:r.note,liquidityKind:r.liquidity_kind,usableBps:r.usable_bps }); hash(r.creation_hash, true); integer(r.balance_revision); integer(r.metadata_revision,1); }
  if(table==='finance_account_classifications'){
    id(r.account_id);integer(r.revision,1);day(r.effective_from);integer(r.archived,0,1);parseAccountPatch({type:r.type});
    if(!['opening','baseline','change'].includes(String(r.origin))||(['opening','baseline'].includes(String(r.origin))&&r.effective_from!=='1970-01-01')||(r.origin==='opening'&&r.revision!==1)||(r.origin==='change'&&r.effective_from!==shanghaiDay(String(r.recorded_at))))backupFail('财务分类生效历史无效。');
  }
  if (table === 'finance_balance_entries') { integer(r.sequence, 1); id(r.id, true); id(r.account_id); minor(r.amount_minor); parseAsOfDate(r.as_of_date); }
  if (table === 'finance_balance_changes') {
    integer(r.sequence, 1); id(r.id); id(r.account_id); id(r.entry_id, true); integer(r.revision, 1); hash(r.request_hash); text(r.reason, 500, false);
    if (r.action === 'void') { if (r.amount_minor !== null || r.as_of_date !== null || r.note !== null) backupFail('作废记录不应携带更正值。'); }
    else if (r.action === 'correct') { minor(r.amount_minor); parseAsOfDate(r.as_of_date); text(r.note); }
    else backupFail('余额修改操作无效。');
  }
  if (table === 'finance_goal_plans') { id(r.id); hash(r.creation_hash); integer(r.revision,1); minor(r.target_minor, true); parseFinanceGoalCreate({ ledger:r.ledger, currency:r.currency, name:r.name, targetAmount:decimalFromMinor(r.target_minor as string, r.currency as string), deadline:r.deadline, accountIds:parsedJson(r.account_ids_json) }); }
  if (table === 'finance_runway_settings') { integer(r.revision); parseLedger(r.ledger); parseCurrency(r.currency); minor(r.monthly_expense_minor, true); parseFinanceRunwayInput({ monthlyExpenseAmount:decimalFromMinor(r.monthly_expense_minor as string, r.currency as string), targetMonths:r.target_months, accountIds:parsedJson(r.account_ids_json) }, r.currency as Parameters<typeof parseFinanceRunwayInput>[1]); }
}
export function backupRowKey(table: BackupTable, row: BackupRow): string { return JSON.stringify((BACKUP_TABLES[table].keys as readonly string[]).map((k) => row[k])); }
export function comparableBackupRow(table: BackupTable, row: BackupRow): string { return JSON.stringify(Object.fromEntries(BACKUP_TABLES[table].columns.filter((k) => k !== 'sequence' && !(table === 'finance_accounts' && ['balance_revision','metadata_revision'].includes(k)) && !(table==='finance_account_classifications'&&row.origin==='baseline'&&k==='recorded_at') && !(table === 'finance_goal_plans' && k === 'revision') && !(REVISION_SETTINGS.includes(table) && k === 'revision') && !(table==='nutrition_favorites'&&['id','created_at'].includes(k))).map((k) => [k,row[k]]))); }

export function parseDataBackup(input: unknown, now = Date.now(), limits: BackupLimits = SINGLE_BACKUP_LIMITS): DataBackup {
  try {
    const encoded = typeof input === 'string' ? input : JSON.stringify(input);
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > limits.maxBytes) backupFail('完整备份超过当前格式的容量，请使用完整分卷组或减少文件大小。');
    const raw = exact(typeof input === 'string' ? JSON.parse(input) : input, ['kind','version','exportedAt','tables']);
    if (raw.kind !== 'jiashu-os-backup' || (raw.version !== 1 && raw.version !== 2)) backupFail('请选择 Jiashu OS 完整备份 v1 或 v2 文件。');
    timestamp(raw.exportedAt);
    if (Date.parse(raw.exportedAt as string) > now + 5*60000) backupFail('备份导出时间不能晚于当前时间。');
    const sourceTables = object(raw.tables);
    if(raw.version===2&&(BACKUP_LEGACY_V2_TABLE_NAMES.some((table)=>!Object.hasOwn(sourceTables,table))||Object.keys(sourceTables).some((table)=>!BACKUP_TABLE_NAMES.includes(table as BackupTable))))backupFail('备份含有缺失或不支持的数据表。');
    const hadNutritionHistory=Object.hasOwn(sourceTables,'nutrition_entry_history');
    const hadFinanceClassifications=Object.hasOwn(sourceTables,'finance_account_classifications');
    const optionalV1=['nutrition_favorites','nutrition_day_status','nutrition_batches'];
    if (raw.version===1 && (BACKUP_V1_TABLE_NAMES.some((table)=>!Object.hasOwn(sourceTables,table)) || Object.keys(sourceTables).some((table)=>!BACKUP_V1_TABLE_NAMES.includes(table as typeof BACKUP_V1_TABLE_NAMES[number])&&!optionalV1.includes(table)))) backupFail('旧版备份含有缺失或不支持的数据表。');
    const tables = raw.version === 2 ? Object.fromEntries(BACKUP_TABLE_NAMES.map((table)=>[table,sourceTables[table]??[]])) : Object.fromEntries(BACKUP_TABLE_NAMES.map((table) => {
      if (!Object.hasOwn(sourceTables,table)) return [table,[]];
      const rows = sourceTables[table]; if (!Array.isArray(rows)) return backupFail('备份数据表应为数组。');
      return [table,rows.map((value) => {
        const columns = BACKUP_TABLES[table].columns.filter((key) => !(REVISION_SETTINGS.includes(table) && key === 'revision'));
        const original=compatibleBackupRow(table,value); const compatible=table==='nutrition_entries'&&!Object.hasOwn(original,'food_json')?{...original,food_json:null}:original;
        const row = exact(compatible,columns);
        return REVISION_SETTINGS.includes(table) ? { ...row,revision:0 } : { ...row };
      })];
    }));
    if(!hadNutritionHistory){
      const entries=tables.nutrition_entries;if(!Array.isArray(entries))backupFail('备份饮食记录应为数组。');
      tables.nutrition_entry_history=entries.map((value)=>{const row=nutritionBackupRow(value);return{entry_id:row.id,revision:row.revision,action:'baseline',before_json:null,after_json:JSON.stringify(nutritionSnapshot(row)),created_at:row.updated_at};});
    }
    if(!hadFinanceClassifications){
      if(!Array.isArray(tables.finance_accounts))backupFail('财务账户应为数组。');
      tables.finance_account_classifications=tables.finance_accounts.map((value)=>{const row=compatibleBackupRow('finance_accounts',value);return{account_id:row.id,revision:row.metadata_revision,effective_from:'1970-01-01',type:row.type,archived:row.archived_at===null?0:1,origin:'baseline',recorded_at:raw.exportedAt};});
    }
    let count = 0;
    for (const table of BACKUP_TABLE_NAMES) {
      const rows = tables[table]; const spec = BACKUP_TABLES[table] as TableSpec;
      if (!Array.isArray(rows)) backupFail('备份数据表应为数组。');
      count += rows.length; if (count > limits.maxRows) backupFail('完整备份超过当前格式的行数上限，请使用完整分卷组。');
      const seen = new Set<string>(); const sequences = new Set<number>();
      const normalized: BackupRow[] = [];
      for (const value of rows) {
        const row = exact(compatibleBackupRow(table,value), spec.columns) as BackupRow;
        validateRow(table, row,now);
        const key = backupRowKey(table,row); if (seen.has(key)) backupFail('备份中含重复记录。'); seen.add(key);
        if (spec.sequence) { if (sequences.has(row.sequence as number)) backupFail('备份余额顺序重复。'); sequences.add(row.sequence as number); }
        normalized.push(row);
      }
      if (spec.keys.length === 0 && rows.length > 1) backupFail('备份单项设置重复。');
      normalized.sort((a: BackupRow,b: BackupRow) => spec.sequence ? Number(a.sequence) - Number(b.sequence) : backupRowKey(table,a).localeCompare(backupRowKey(table,b)));
      tables[table] = normalized;
    }
    const result = { kind:'jiashu-os-backup',version:2,exportedAt:raw.exportedAt,tables } as unknown as DataBackup; validateBackupRelations(result); return result;
  } catch (error) { if (error instanceof BackupValidationError) throw error; return backupFail('备份内容未通过完整性与业务规则检查。'); }
}
function validateBackupRelations(backup: DataBackup) {
  const t = backup.tables; const accounts = new Map(t.finance_accounts.map((r) => [r.id,r]));
  const monthVersions=new Map<string,BackupRow[]>(),closeOperations=new Set<string>();
  for(const row of t.finance_month_closes){
    if(closeOperations.has(String(row.operation_id)))backupFail('月结操作标识重复。');closeOperations.add(String(row.operation_id));
    const review=parseStoredFinanceReview(parsedJson(row.snapshot_json),{ledger:String(row.ledger),currency:String(row.currency),month:String(row.month)});
    for(const account of review.accounts){const stored=accounts.get(account.accountId);if(!stored||stored.ledger!==row.ledger||stored.currency!==row.currency)backupFail('月结快照缺少同账本、同币种的关联账户。');}
    const key=JSON.stringify([row.ledger,row.currency,row.month]),versions=monthVersions.get(key)??[];versions.push(row);monthVersions.set(key,versions);
  }
  for(const versions of monthVersions.values()){
    versions.sort((a,b)=>Number(a.version)-Number(b.version));
    for(let index=0;index<versions.length;index++)if(versions[index].version!==index+1||(index>0&&Date.parse(String(versions[index].closed_at))<Date.parse(String(versions[index-1].closed_at))))backupFail('月结重结历史版本或时间不连续。');
  }
  const weightCycles=new Map(t.health_weight_plan_cycles.map((row)=>[row.id,row]));
  const weightPlan=t.health_weight_plan_settings[0];
  if(weightPlan){
    const archived=weightCycles.get(weightPlan.cycle_id);
    if((weightPlan.archived_at!==null)!==Boolean(archived)||(archived&&archived.archived_at!==weightPlan.archived_at))backupFail('当前体重周期与归档状态不一致。');
  }
  for(const row of t.health_weight_plan_operations)if(row.action==='archive'?!weightCycles.has(row.cycle_id):row.cycle_id!==weightPlan?.cycle_id&&!weightCycles.has(row.cycle_id))backupFail('体重周期回执缺少对应周期。');
  const templates=new Map(t.nutrition_templates.map((row)=>[row.id,row]));
  const templateReceipts=new Map(t.nutrition_template_operations.map((row)=>[row.id,row]));
  if(t.nutrition_templates.filter((row)=>row.archived_at===null).length>200)backupFail('未归档的食物模板不能超过200项。');
  for(const row of t.nutrition_templates){
    const opening=templateReceipts.get(row.id);
    if(!opening||opening.action!=='create'||opening.template_id!==row.id||opening.request_hash!==row.creation_hash)backupFail('食物模板缺少原始创建回执。');
  }
  for(const row of t.nutrition_template_operations){
    const template=templates.get(row.template_id),saved=object(parsedJson(row.result_json));
    if(!template||Number(saved.revision)>Number(template.revision)||saved.createdAt!==template.created_at||Date.parse(String(saved.createdAt))>Date.parse(String(saved.updatedAt)))backupFail('食物模板操作回执缺少对应模板或版本不一致。');
    if(saved.revision===template.revision){
      const{id:_id,revision:_revision,createdAt:_created,updatedAt:_updated,archivedAt:_archived,...definition}=saved;
      if(saved.updatedAt!==template.updated_at||saved.archivedAt!==template.archived_at||canonical(definition)!==canonical(parsedJson(template.template_json)))backupFail('食物模板最新回执与当前内容不一致。');
    }
  }
  const classificationChains=new Map<string,BackupRow[]>();
  for(const row of t.finance_account_classifications){
    const account=accounts.get(row.account_id);if(!account||Number(row.revision)>Number(account.metadata_revision))backupFail('财务分类历史缺少对应账户或版本超出当前账户。');
    const chain=classificationChains.get(String(row.account_id))??[];chain.push(row);classificationChains.set(String(row.account_id),chain);
  }
  for(const account of t.finance_accounts){
    const chain=(classificationChains.get(String(account.id))??[]).sort((a,b)=>Number(a.revision)-Number(b.revision));
    if(!chain.length||!['opening','baseline'].includes(String(chain[0].origin)))backupFail('财务分类历史缺少已知基线。');
    for(let index=1;index<chain.length;index++)if(chain[index].origin!=='change'||String(chain[index].effective_from)<String(chain[index-1].effective_from))backupFail('财务分类生效顺序无效。');
    const latest=chain.at(-1)!;
    if(latest.type!==account.type||latest.archived!==(account.archived_at===null?0:1))backupFail('财务账户与最新分类或归档历史不一致。');
  }
  const goals = t.health_goal_settings[0]; const versions = [...t.health_goal_versions].sort((a,b) => Number(a.revision)-Number(b.revision));
  if (!goals && versions.length) backupFail('健康目标历史缺少当前目标。');
  if (goals && Number(goals.revision) > 0 && !versions.length) backupFail('健康目标缺少版本历史。');
  if (versions.length) {
    if (versions[0].revision !== 0 || versions[0].effective_from !== '1970-01-01') backupFail('健康目标缺少历史基线。');
    for (let index=0;index<versions.length;index++) if (versions[index].revision !== index || (index>0 && String(versions[index].effective_from)<String(versions[index-1].effective_from))) backupFail('健康目标版本不连续或生效日期倒退。');
    const latest=versions.at(-1)!;
    if (latest.revision !== goals.revision || latest.created_at !== goals.updated_at || ['steps_target','sleep_target','active_energy_target'].some((key)=>latest[key]!==goals[key])) backupFail('健康目标与最新历史版本不一致。');
  }
  const nutritionIds = new Set(t.nutrition_entries.map((row)=>row.id));
  const nutritionRows=new Map(t.nutrition_entries.map((row)=>[row.id,row]));
  const nutritionHistory=new Map(t.nutrition_entry_history.map((row)=>[String(row.entry_id)+':'+row.revision,row]));
  const nutritionChains=new Map<string,BackupRow[]>();
  for(const row of t.nutrition_entry_history){
    const entry=nutritionRows.get(row.entry_id);if(!entry||Number(row.revision)>Number(entry.revision))backupFail('饮食历史缺少所属记录或版本超出当前记录。');
    const chain=nutritionChains.get(String(row.entry_id))??[];chain.push(row);nutritionChains.set(String(row.entry_id),chain);
  }
  for(const chain of nutritionChains.values()){
    chain.sort((a,b)=>Number(a.revision)-Number(b.revision));
    const first=chain[0];
    if(first.before_json!==null||!(first.action==='baseline'||(first.action==='create'&&first.revision===1)))backupFail('饮食修改历史缺少有效基线。');
    for(let index=1;index<chain.length;index++){
      const prior=chain[index-1],current=chain[index];
      if(current.revision!==Number(prior.revision)+1||!['edit','delete','restore'].includes(String(current.action))||current.before_json===null||canonical(parsedJson(current.before_json))!==canonical(parsedJson(prior.after_json)))backupFail('饮食修改历史不连续或修改前状态不一致。');
    }
  }
  for(const row of t.nutrition_entries){const latest=nutritionHistory.get(String(row.id)+':'+row.revision);if(!latest||canonical(parsedJson(latest.after_json))!==canonical(nutritionSnapshot(row)))backupFail('饮食记录与最新修改历史不一致。');}
  for(const row of t.nutrition_restore_operations){const target=nutritionHistory.get(String(row.entry_id)+':'+row.target_revision);if(!nutritionIds.has(row.entry_id)||!nutritionHistory.has(String(row.entry_id)+':'+row.source_revision)||!target||target.action!=='restore')backupFail('饮食恢复回执缺少对应历史。');}
  for (const operation of [...t.nutrition_copy_operations,...t.nutrition_batches]) for (const entryId of parsedJson(operation.entry_ids_json) as string[]) if (!nutritionIds.has(entryId)) backupFail('饮食提交回执缺少所属用户的饮食记录。');
  if (t.nutrition_favorites.length>100 || new Set(t.nutrition_favorites.map((row)=>row.id)).size!==t.nutrition_favorites.length) backupFail('常用食物数量或记录标识无效。');
  const activeMeals=new Map<string,Set<string>>();
  for(const row of t.nutrition_entries)if(row.deleted_at===null){const date=String(row.date),meals=activeMeals.get(date)??new Set<string>();meals.add(String(row.meal));activeMeals.set(date,meals);}
  for(const status of t.nutrition_day_status) if(status.complete===1){const meals=parsedJson(status.meals_json) as Record<string,unknown>;if(['breakfast','lunch','dinner'].some((meal)=>!activeMeals.get(String(status.date))?.has(meal)&&meals[meal]!=='skipped'))backupFail('已记完的饮食日期缺少对应餐次记录或未进食标记。');}
  if (t.health_sync_attempts.length>100) backupFail('同步诊断最多保留最近100次记录。');
  const entries = new Map(t.finance_balance_entries.map((r) => [r.id,r]));
  for (const r of t.finance_balance_entries) { if (!accounts.has(r.account_id)) backupFail('余额缺少关联账户。'); if (String(r.id).startsWith('initial:') && r.id !== 'initial:'+r.account_id) backupFail('初始余额与账户标识不一致。'); }
  const revisions = new Map<string, number>();
  const latestChanges = new Map<string,BackupRow>();
  for (const r of t.finance_balance_changes) {
    const entry = entries.get(r.entry_id); if (!entry || entry.account_id !== r.account_id) backupFail('余额修改缺少关联原记录。');
    const rev = revisions.get(String(r.entry_id)) ?? 0; if (r.revision !== rev + 1) backupFail('余额修改版本不连续。'); revisions.set(String(r.entry_id),Number(r.revision));
    latestChanges.set(String(r.entry_id),r);
  }
  const fundedAccounts=new Set(t.finance_balance_entries.filter((entry)=>latestChanges.get(String(entry.id))?.action!=='void').map((entry)=>entry.account_id));
  for (const account of t.finance_accounts) if (!fundedAccounts.has(account.id)) backupFail('每个财务账户必须保留至少一条有效余额。');
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
