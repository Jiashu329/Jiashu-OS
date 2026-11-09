import { HEALTH_TIMEZONE, HealthValidationError, METRIC_INFO, normalizeTimestamp, parseSyncPayload, shanghaiDay } from './health.ts';
import type { HealthMeasurement, HealthMetric, ValidationIssue } from './health.ts';

export interface HealthRecordBase { measurement: HealthMeasurement; exportedAt: string; receivedAt: string }
export interface HealthRecordView {
  recordKey: string;
  metric: HealthMetric;
  day: string;
  base: HealthRecordBase | null;
  effective: HealthMeasurement;
  override: HealthMeasurement | null;
  deleted: boolean;
  revision: number;
  updatedAt: string | null;
  manual: boolean;
}
export type HealthRecordCommand = {
  action: 'create'; measurement: HealthMeasurement; reason: string;
} | {
  action: 'correct'; recordKey: string; value: number; expectedRevision: number; expectedBaseExportedAt: string | null; reason: string;
} | {
  action: 'hide' | 'restore' | 'reset'; recordKey: string; expectedRevision: number; expectedBaseExportedAt: string | null; reason: string;
};
export interface HealthRecordSelection {
  from: string;
  to: string;
  metric?: HealthMetric | null;
  includeDeleted: boolean;
  limit?: number;
  cursor?: [string, string] | null;
}
export interface HealthRecordChangeView {
  changeId: string;
  recordKey: string;
  action: HealthRecordCommand['action'];
  before: HealthRecordView | null;
  after: HealthRecordView;
  reason: string;
  createdAt: string;
}
export class HealthRecordValidationError extends Error {
  readonly code = 'INVALID_HEALTH_RECORD';
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join('；'));
    this.name = 'HealthRecordValidationError';
    this.issues = issues;
  }
}
function fail(path: string, message: string): never { throw new HealthRecordValidationError([{ path, message }]); }
function fields(input: unknown, allowed: readonly string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return fail('$', '请提交完整的健康记录。');
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new HealthRecordValidationError(unknown.map((path) => ({ path, message: '此记录字段不能修改或不受支持。' })));
  return raw;
}
function day(input: unknown, path = 'date') {
  if (typeof input !== 'string' || input.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return fail(path, '日期请使用 YYYY-MM-DD 格式。');
  const parsed = normalizeTimestamp(input + 'T12:00:00+08:00');
  if (!parsed) return fail(path, '请选择 1970–2100 年之间的有效日期。');
  return input;
}
function shiftDay(input: string, offset: number) {
  return new Date(Date.parse(input + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}
function reason(input: unknown) {
  if (input === undefined) return '';
  if (typeof input !== 'string' || input.trim().length > 500) return fail('reason', '更正说明最多 500 个字符。');
  for (const character of input) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return fail('reason', '更正说明包含不支持的控制字符。');
  }
  return input.trim();
}
function parsedMeasurement(measurement: unknown, exportedAt: string) {
  try {
    return parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: HEALTH_TIMEZONE, exportedAt, measurements: [measurement] }).measurements[0];
  } catch (error) {
    if (error instanceof HealthValidationError) throw new HealthRecordValidationError(error.issues);
    throw error;
  }
}
function localTimestamp(date: string, time: string) {
  let instant = Date.parse(date + 'T' + time + '+08:00');
  const desired = Date.parse(date + 'T' + time + 'Z');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: HEALTH_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string) => parts.find((item) => item.type === type)!.value;
    const observed = Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
    if (observed === desired) return new Date(instant).toISOString();
    instant -= observed - desired;
  }
  return fail('time', '所选时间在上海时区中不存在，请核对测量时间。');
}
function midnight(input: string) { return localTimestamp(input, '00:00:00'); }

export function validHealthRecordRequestId(input: unknown): input is string {
  return typeof input === 'string' && input.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}
export function parseHealthRecordKey(input: unknown): string {
  if (typeof input !== 'string' || input.length > 190 || input.trim() !== input) return fail('recordKey', '健康记录标识不正确。');
  const daily = input.match(/^(steps|sleep|active_energy):(\d{4}-\d{2}-\d{2})$/);
  if (daily) { day(daily[2], 'recordKey'); return input; }
  if (/^(weight|lean_body_mass):[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,159}$/.test(input)) return input;
  return fail('recordKey', '健康记录标识不正确。');
}

/** Capture time is part of the frozen client draft, keeping retries deterministic. */
export function parseHealthRecordCreate(input: unknown, requestId: string, now: Date | number = Date.now()): HealthRecordCommand & { action: 'create' } {
  const raw = fields(input, ['metric', 'value', 'date', 'time', 'capturedAt', 'reason']);
  if (!validHealthRecordRequestId(requestId)) return fail('requestId', '请使用有效的提交标识。');
  if (typeof raw.metric !== 'string' || !Object.hasOwn(METRIC_INFO, raw.metric)) return fail('metric', '请选择支持的原始健康指标。');
  const metric = raw.metric as HealthMetric;
  const date = day(raw.date);
  const capturedAt = normalizeTimestamp(raw.capturedAt);
  if (!capturedAt || Date.parse(capturedAt) > new Date(now).getTime()) return fail('capturedAt', '读取时间需为有效且不晚于当前时间的 ISO 日期。');
  if (date > shanghaiDay(capturedAt)) return fail('date', '记录日期不能晚于本次读取日期。');
  const sample = metric === 'weight' || metric === 'lean_body_mass';
  let startDate: string;
  let endDate: string | undefined;
  if (sample) {
    if (typeof raw.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw.time) || (raw.time.length !== 5 && raw.time.length !== 8)) return fail('time', '体重与去脂体重需填写明确的测量时间。');
    const parsed = localTimestamp(date, raw.time + (raw.time.length === 5 ? ':00' : ''));
    if (!parsed || Date.parse(parsed) > Date.parse(capturedAt)) return fail('time', '测量时间需有效且不晚于本次读取时间。');
    startDate = parsed;
  } else {
    if (raw.time !== undefined) return fail('time', '每日汇总只填写记录日期，不填写测量时间。');
    if (metric === 'sleep') {
      startDate = midnight(shiftDay(date, -1));
      endDate = midnight(date);
    } else {
      startDate = midnight(date);
      endDate = new Date(Math.min(Date.parse(midnight(shiftDay(date, 1))), Date.parse(capturedAt))).toISOString();
    }
  }
  const measurement = parsedMeasurement({
    id: sample ? 'manual:' + requestId.toLowerCase() : 'manual:' + metric + ':' + date,
    metric, value: raw.value, unit: METRIC_INFO[metric].unit, source: '人工补录',
    aggregation: sample ? 'sample' : 'daily', startDate, ...(endDate ? { endDate } : {}),
  }, capturedAt);
  return { action: 'create', measurement, reason: reason(raw.reason) };
}

export function parseHealthRecordPatch(input: unknown, record: HealthRecordView, now: Date | number = Date.now()): Exclude<HealthRecordCommand, { action: 'create' }> {
  const raw = fields(input, ['action', 'value', 'expectedRevision', 'expectedBaseExportedAt', 'reason']);
  if (!['correct', 'hide', 'restore', 'reset'].includes(raw.action as string)) return fail('action', '请选择更正、屏蔽、恢复或恢复同步值。');
  if (typeof raw.expectedRevision !== 'number' || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) return fail('expectedRevision', '请先读取最新的健康记录版本。');
  let expectedBaseExportedAt: string | null = null;
  if (!Object.hasOwn(raw, 'expectedBaseExportedAt')) return fail('expectedBaseExportedAt', '请先读取最新的同步版本。');
  if (raw.expectedBaseExportedAt !== null) {
    expectedBaseExportedAt = normalizeTimestamp(raw.expectedBaseExportedAt);
    if (!expectedBaseExportedAt) return fail('expectedBaseExportedAt', '同步版本日期不正确。');
  }
  const common = { recordKey: record.recordKey, expectedRevision: raw.expectedRevision, expectedBaseExportedAt, reason: reason(raw.reason) };
  if (raw.action === 'correct') {
    const parsed = parsedMeasurement({ ...record.effective, value: raw.value }, new Date(now).toISOString());
    return { action: 'correct', ...common, value: parsed.value };
  }
  if (Object.hasOwn(raw, 'value')) return fail('value', '只有更正数值时才能提交数值。');
  return { action: raw.action as 'hide' | 'restore' | 'reset', ...common };
}

export function parseHealthRecordsQuery(params: URLSearchParams, now: Date | number = Date.now()): HealthRecordSelection {
  const today = shanghaiDay(new Date(now).toISOString());
  const from = day(params.get('from') ?? shiftDay(today, -29), 'from');
  const to = day(params.get('to') ?? today, 'to');
  if (from > to || to > today) return fail('from', '请选择起止顺序正确且不晚于今天的日期范围。');
  const requestedMetric = params.get('metric');
  if (requestedMetric && requestedMetric !== 'all' && !Object.hasOwn(METRIC_INFO, requestedMetric)) return fail('metric', '请选择支持的原始健康指标。');
  const requestedLimit = params.get('limit') ?? '100';
  if (!/^\d{1,3}$/.test(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > 100) return fail('limit', '每次可读取 1–100 条记录。');
  let cursor: [string, string] | null = null;
  const requestedCursor = params.get('cursor');
  if (requestedCursor !== null) {
    if (requestedCursor.length > 256) return fail('cursor', '记录分页标识不正确。');
    let parsed: unknown;
    try { parsed = JSON.parse(requestedCursor); }
    catch { return fail('cursor', '记录分页标识不正确。'); }
    if (!Array.isArray(parsed) || parsed.length !== 2) return fail('cursor', '记录分页标识不正确。');
    cursor = [day(parsed[0], 'cursor'), parseHealthRecordKey(parsed[1])];
  }
  return { from, to, metric: requestedMetric && requestedMetric !== 'all' ? requestedMetric as HealthMetric : null,
    includeDeleted: params.get('includeDeleted') === '1', limit: Number(requestedLimit), cursor };
}
