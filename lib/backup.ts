import { measurementDay, measurementKey, normalizeTimestamp, parseSyncPayload, shanghaiDay } from './health.ts';
import { ACCOUNT_TYPES, CURRENCIES } from './finance.ts';
import { parseStoredFinanceReview } from './finance-review-close.ts';

export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
export const MAX_BACKUP_ROWS = 50000;
export type BackupValue = string | number | null;
export type BackupRow = Record<string, BackupValue>;
type Rule = (value: unknown) => boolean;
interface BackupTable { label: string; fields: Record<string, Rule>; key: readonly string[]; order?: string; globalId?: boolean; generated?: readonly string[] }
function hasControl(value: string, allowWhitespace = true) {
  for (const character of value) { const code = character.charCodeAt(0); if ((code < 32 && !(allowWhitespace && [9, 10, 13].includes(code))) || code === 127) return true; }
  return false;
}
const string = (maximum = 1000): Rule => (value) => typeof value === 'string' && value.length <= maximum && !hasControl(value);
const required = (maximum = 1000): Rule => (value) => string(maximum)(value) && (value as string).length > 0;
const nullable = (rule: Rule): Rule => (value) => value === null || rule(value);
const number: Rule = (value) => typeof value === 'number' && Number.isFinite(value);
const integer: Rule = (value) => number(value) && Number.isSafeInteger(value) && (value as number) >= 0;
const positive: Rule = (value) => integer(value) && (value as number) > 0;
const flag: Rule = (value) => value === 0 || value === 1;
const oneOf = (values: readonly string[]): Rule => (value) => typeof value === 'string' && values.includes(value);
const timestamp: Rule = (value) => typeof value === 'string' && normalizeTimestamp(value) === value;
const date: Rule = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !!normalizeTimestamp(value + 'T12:00:00+08:00');
const weekDate: Rule = (value) => value === '1969-12-29' || date(value);
const month: Rule = (value) => typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && date(value + '-01');
const uuid: Rule = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const balanceId: Rule = (value) => uuid(value) || typeof value === 'string' && value.startsWith('initial:') && uuid(value.slice(8));
const hash: Rule = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const money: Rule = (value) => typeof value === 'string' && /^(?:0|[1-9]\d{0,17})$/.test(value);
const positiveMoney: Rule = (value) => money(value) && value !== '0';
const nutritionHash: Rule = (value) => hash(value) || typeof value === 'string' && /^meal:[0-9a-f]{64}$/.test(value);
const ledger = oneOf(['personal', 'family']);
const currency = oneOf(Object.keys(CURRENCIES));
const metric = oneOf(['steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass']);
const json: Rule = (value) => {
  if (!string(1024 * 1024)(value)) return false;
  try { safeObject(JSON.parse(value as string)); return true; } catch { return false; }
};
const ids: Rule = (value) => {
  if (!json(value)) return false;
  const parsed: unknown = JSON.parse(value as string);
  return Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 10000 && parsed.every(uuid) && new Set(parsed).size === parsed.length;
};
const timestamps = { created_at: timestamp, updated_at: timestamp };

/** Explicit allowlist: credentials, user identity and internal restore guards never leave the server. */
export const BACKUP_TABLES = {
  health_measurements: { label: '健康原始记录', key: ['record_key'], fields: { record_key: required(2000), metric, day: date, measurement_json: json, exported_at: timestamp, received_at: timestamp } },
  health_syncs: { label: '同步回执', key: ['payload_hash'], fields: { payload_hash: hash, exported_at: timestamp, received_at: timestamp, measurement_count: integer } },
  health_goal_settings: { label: '健康目标', key: [], fields: { steps_target: nullable((v) => positive(v) && (v as number) <= 200000), sleep_target: nullable((v) => number(v) && (v as number) > 0 && (v as number) <= 24), active_energy_target: nullable((v) => number(v) && (v as number) > 0 && (v as number) <= 20000), updated_at: timestamp } },
  health_weight_plan_settings: { label: '体重计划', key: [], fields: { baseline_weight: (v) => number(v) && (v as number) >= 10 && (v as number) <= 600, target_weight: (v) => number(v) && (v as number) >= 10 && (v as number) <= 600, start_date: date, deadline: date, enabled: flag, ...timestamps } },
  health_record_overrides: { label: '健康更正', key: ['record_key'], fields: { record_key: required(2000), metric, day: date, override_json: nullable(json), deleted: flag, revision: positive, last_change_id: uuid, ...timestamps } },
  health_record_changes: { label: '健康修改历史', key: ['change_id'], fields: { change_id: uuid, record_key: required(2000), request_hash: hash, action: oneOf(['create', 'correct', 'hide', 'restore', 'reset']), target_revision: positive, before_state_json: nullable(json), after_state_json: json, reason: string(500), created_at: timestamp } },
  nutrition_entries: { label: '饮食记录', key: ['id'], globalId: true, fields: { id: uuid, date, meal: oneOf(['breakfast', 'lunch', 'dinner', 'snack']), name: required(100), portion: string(100), note: string(500), calories_tenth: nullable((v) => integer(v) && (v as number) <= 200000), creation_hash: nutritionHash, revision: positive, ...timestamps, deleted_at: nullable(timestamp) } },
  finance_accounts: { label: '财务账户', key: ['id'], globalId: true, fields: { id: uuid, ledger, name: required(60), type: oneOf(Object.keys(ACCOUNT_TYPES)), currency, creation_hash: nullable(hash), note: string(500), ...timestamps, archived_at: nullable(timestamp) } },
  finance_balance_entries: { label: '余额历史', key: ['id'], globalId: true, generated: ['sequence'], order: 'sequence', fields: { sequence: positive, id: balanceId, account_id: uuid, amount_minor: money, as_of_date: date, note: string(500), created_at: timestamp } },
  finance_goal_plans: { label: '财务目标', key: ['id'], globalId: true, fields: { id: uuid, ledger, currency, name: required(60), target_minor: positiveMoney, deadline: date, account_ids_json: ids, creation_hash: hash, ...timestamps, archived_at: nullable(timestamp) } },
  finance_runway_settings: { label: '应急资金设置', key: ['ledger', 'currency'], fields: { ledger, currency, monthly_expense_minor: positiveMoney, target_months: positive, account_ids_json: ids, ...timestamps } },
  health_sync_diagnostics: { label: '同步核对结果', key: ['scope'], fields: { scope: oneOf(['batch', 'steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass']), received_at: timestamp, exported_at: timestamp, submitted_count: integer, imported_count: nullable(integer), skipped_count: nullable(integer), first_day: nullable(date), last_day: nullable(date) } },
  health_weekly_actions: { label: '每周行动', key: ['week_start'], fields: { week_start: weekDate, text: (v) => required(200)(v) && !hasControl(v as string, false), status: oneOf(['planned', 'completed', 'not_completed']), feedback: string(500), revision: positive, ...timestamps } },
  finance_month_closes: { label: '已确认月结', key: ['ledger', 'currency', 'month', 'version'], fields: { ledger, currency, month, version: positive, operation_id: uuid, request_hash: hash, snapshot_json: json, reason: string(500), closed_at: timestamp } },
} satisfies Record<string, BackupTable>;
export type BackupTableName = keyof typeof BACKUP_TABLES;
export const BACKUP_TABLE_NAMES = Object.keys(BACKUP_TABLES) as BackupTableName[];
export function backupTable(name: BackupTableName): BackupTable { return BACKUP_TABLES[name]; }
export interface FullBackup { kind: 'jiashu-os-backup'; version: 1; exportedAt: string; tables: Record<BackupTableName, BackupRow[]> }
export class BackupValidationError extends Error { readonly code = 'INVALID_BACKUP'; constructor(message: string) { super(message); this.name = 'BackupValidationError'; } }
function fail(message: string): never { throw new BackupValidationError(message); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function safeObject(value: unknown, depth = 0) {
  if (depth > 40) fail('备份内容嵌套过深。');
  if (Array.isArray(value)) { for (const item of value) safeObject(item, depth + 1); }
  else if (plain(value)) { for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype', 'user_id', 'userId', 'token_hash', 'tokenHash'].includes(key)) fail('备份中包含身份或授权字段。'); safeObject(item, depth + 1); } }
}
export function backupRowKey(name: BackupTableName, row: BackupRow): string { return JSON.stringify(backupTable(name).key.map((field) => row[field])); }
export function comparableBackupRow(name: BackupTableName, row: BackupRow) { return Object.fromEntries(Object.keys(backupTable(name).fields).filter((key) => !backupTable(name).generated?.includes(key)).map((key) => [key, row[key]])); }
export function canonicalBackup(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => plain(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
export async function backupHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalBackup(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function validateMeasurement(raw: string, exportedAt: string, key: BackupValue, day: BackupValue, expectedMetric?: BackupValue) {
  try {
    const measurement = parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt, measurements: [JSON.parse(raw)] }).measurements[0];
    if (measurementKey(measurement) !== key || measurementDay(measurement) !== day || expectedMetric !== undefined && measurement.metric !== expectedMetric) fail('健康记录的标识、日期或指标不一致。');
  } catch { fail('备份中的健康测量记录不完整或无效。'); }
}
function validateRecordState(raw: string, at: string, expectedKey: BackupValue): Record<string, unknown> {
  const state: unknown = JSON.parse(raw);
  const fields = ['recordKey', 'metric', 'day', 'base', 'effective', 'override', 'deleted', 'revision', 'updatedAt', 'manual'];
  if (!plain(state) || Object.keys(state).sort().join(',') !== fields.sort().join(',') || state.recordKey !== expectedKey || !metric(state.metric) || !date(state.day)
    || typeof state.deleted !== 'boolean' || !integer(state.revision) || !nullable(timestamp)(state.updatedAt) || typeof state.manual !== 'boolean') fail('健康修改历史的状态不完整。');
  validateMeasurement(JSON.stringify(state.effective), at, expectedKey, state.day as string, state.metric as string);
  if (state.base !== null) {
    if (!plain(state.base) || Object.keys(state.base).sort().join(',') !== 'exportedAt,measurement,receivedAt' || !timestamp(state.base.exportedAt) || !timestamp(state.base.receivedAt) || !plain(state.base.measurement)) fail('健康修改历史的同步原值不完整。');
    validateMeasurement(JSON.stringify(state.base.measurement), state.base.exportedAt as string, expectedKey, measurementDay(state.base.measurement as unknown as Parameters<typeof measurementDay>[0]), state.metric as string);
  }
  if (state.override !== null) {
    validateMeasurement(JSON.stringify(state.override), at, expectedKey, state.day as string, state.metric as string);
    if (canonicalBackup(state.effective) !== canonicalBackup(state.override)) fail('健康修改历史的有效值与更正值不一致。');
  } else if (!plain(state.base) || canonicalBackup(state.effective) !== canonicalBackup(state.base.measurement)) fail('健康修改历史缺少有效测量。');
  if (state.manual !== (state.base === null)) fail('健康修改历史的补录来源不一致。');
  return state;
}
function validateRelations(tables: FullBackup['tables']) {
  const accounts = new Map(tables.finance_accounts.map((row) => [row.id, row]));
  for (const row of tables.finance_balance_entries) if (!accounts.has(row.account_id)) fail('余额历史引用了备份中不存在的账户。');
  for (const name of ['finance_goal_plans', 'finance_runway_settings'] as const) {
    for (const row of tables[name]) for (const id of JSON.parse(row.account_ids_json as string) as string[]) {
      const account = accounts.get(id);
      if (!account) fail('财务计划引用了备份中不存在的账户。');
      if (account.ledger !== row.ledger || account.currency !== row.currency) fail('财务计划的关联账户账本或币种不一致。');
    }
  }
  const measurements = new Map(tables.health_measurements.map((row) => [row.record_key, row]));
  for (const row of tables.health_measurements) validateMeasurement(row.measurement_json as string, row.exported_at as string, row.record_key, row.day, row.metric);
  for (const row of tables.health_record_overrides) {
    if (row.override_json !== null) validateMeasurement(row.override_json as string, row.updated_at as string, row.record_key, row.day, row.metric);
    if (row.override_json === null && !measurements.has(row.record_key)) fail('健康更正缺少同步原值或补录记录。');
    const latest = tables.health_record_changes.find((change) => change.change_id === row.last_change_id && change.record_key === row.record_key);
    if (!latest || latest.target_revision !== row.revision) fail('健康更正缺少对应修改历史。');
    const after = JSON.parse(latest.after_state_json as string) as Record<string, unknown>;
    if (after.revision !== row.revision || after.deleted !== (row.deleted === 1) || canonicalBackup(after.override) !== canonicalBackup(row.override_json === null ? null : JSON.parse(row.override_json as string))) fail('健康更正与最新修改历史不一致。');
  }
  for (const row of tables.health_record_changes) {
    const after = validateRecordState(row.after_state_json as string, row.created_at as string, row.record_key);
    if (after.revision !== row.target_revision) fail('健康修改历史的版本不一致。');
    if (row.before_state_json !== null) {
      const before = validateRecordState(row.before_state_json as string, row.created_at as string, row.record_key);
      if (before.revision !== (row.target_revision as number) - 1 || row.action === 'create') fail('健康修改历史的前后版本不一致。');
    } else if (row.action !== 'create' || row.target_revision !== 1) fail('健康修改历史缺少修改前状态。');
  }
  for (const row of tables.health_weight_plan_settings) if ((row.deadline as string) <= (row.start_date as string)) fail('体重计划截止日期需晚于起始日期。');
  for (const row of tables.health_weekly_actions) if (new Date(row.week_start + 'T12:00:00Z').getUTCDay() !== 1) fail('每周行动的起始日期必须是周一。');
  for (const row of tables.health_sync_diagnostics) if (row.first_day !== null && row.last_day !== null && row.first_day > row.last_day) fail('同步核对日期范围无效。');
  const operationIds = new Set<BackupValue>();
  for (const row of tables.finance_month_closes) {
    if (operationIds.has(row.operation_id)) fail('月结操作标识重复。');
    operationIds.add(row.operation_id);
    try { parseStoredFinanceReview(JSON.parse(row.snapshot_json as string), { ledger: row.ledger as 'personal' | 'family', currency: row.currency as keyof typeof CURRENCIES, month: row.month as string }); }
    catch { fail('月结快照与账本、币种或月份不一致，或快照内容无效。'); }
  }
}

export function parseFullBackup(value: unknown): FullBackup {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'exportedAt,kind,tables,version' || value.kind !== 'jiashu-os-backup' || value.version !== 1 || !timestamp(value.exportedAt) || !plain(value.tables)) fail('请选择 Jiashu OS 完整备份文件（版本 1）。');
  safeObject(value);
  if (Object.keys(value.tables).sort().join(',') !== [...BACKUP_TABLE_NAMES].sort().join(',')) fail('备份缺少必要数据或包含不支持的数据表。');
  let count = 0;
  const tables = {} as FullBackup['tables'];
  for (const name of BACKUP_TABLE_NAMES) {
    const definition = backupTable(name);
    const rows = value.tables[name];
    if (!Array.isArray(rows)) fail(definition.label + '格式不正确。');
    count += rows.length;
    if (count > MAX_BACKUP_ROWS) fail('备份记录数量超过 50,000 条的恢复上限。');
    if (!definition.key.length && rows.length > 1) fail(definition.label + '只能有一份设置。');
    const keys = new Set<string>();
    tables[name] = rows.map((candidate) => {
      if (!plain(candidate) || Object.keys(candidate).sort().join(',') !== Object.keys(definition.fields).sort().join(',')) fail(definition.label + '字段不完整或包含未支持的字段。');
      for (const [field, rule] of Object.entries(definition.fields)) if (!rule(candidate[field])) fail(definition.label + '中的 ' + field + ' 无效。');
      const row = Object.fromEntries(Object.keys(definition.fields).map((field) => [field, candidate[field]])) as BackupRow;
      const key = backupRowKey(name, row);
      if (keys.has(key)) fail(definition.label + '存在重复标识。');
      keys.add(key);
      return row;
    });
    if (name === 'finance_balance_entries') tables[name].sort((a, b) => (a.sequence as number) - (b.sequence as number));
    else tables[name].sort((a, b) => backupRowKey(name, a).localeCompare(backupRowKey(name, b)));
  }
  validateRelations(tables);
  const backupDay = shanghaiDay(value.exportedAt as string);
  const latestTimestamp = Date.parse(value.exportedAt as string) + 5 * 60000;
  if (Date.parse(value.exportedAt as string) > Date.now() + 5 * 60000) fail('备份生成时间晚于当前时间，请检查文件或设备日期。');
  for (const name of BACKUP_TABLE_NAMES) for (const row of tables[name]) {
    for (const [field, item] of Object.entries(row)) if (field.endsWith('_at') && typeof item === 'string' && Date.parse(item) > latestTimestamp) fail(backupTable(name).label + '的时间晚于备份生成时间。');
    if ((name === 'finance_balance_entries' && (row.as_of_date as string) > backupDay)
      || (name === 'nutrition_entries' && (row.date as string) > backupDay)
      || (name === 'health_weight_plan_settings' && (row.start_date as string) > backupDay)) fail(backupTable(name).label + '包含未来日期。');
  }
  const backup: FullBackup = { kind: 'jiashu-os-backup', version: 1, exportedAt: value.exportedAt as string, tables };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > MAX_BACKUP_BYTES) fail('备份文件不能超过 16 MB。');
  return backup;
}
