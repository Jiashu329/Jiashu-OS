import { measurementDay, shanghaiDay, METRIC_INFO, type HealthMeasurement, type HealthMetric, type HealthSyncPayload } from './health.ts';

export const SYNC_METRICS = ['steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass'] as const;
export const SYNC_ATTEMPT_STATUSES = ['success', 'empty', 'unchanged', 'duplicate', 'reverted', 'failed'] as const;
export type SyncAttemptStatus = typeof SYNC_ATTEMPT_STATUSES[number];
export const SYNC_FAILURES = {
  SYNC_DEVICE_INVALID: '连接无效或已撤销，请重新生成连接并更新快捷指令。',
  SYNC_TOO_LARGE: '单次数据超过 512 KB，请按完整日期窗口分批同步。',
  SYNC_INVALID_FORMAT: '数据格式不正确，请核对来源、单位、日期与快捷指令输出。',
  SYNC_FUTURE_EXPORT: '导出时间晚于当前时间，请检查 iPhone 的日期与时区。',
  HEALTH_IMPORT_STALE: '预览后记录已有变化，请重新预览后确认。',
  HEALTH_IMPORT_PREVIEW_REQUIRED: '数据尚未写入，请先查看变更预览并确认导入。',
  HEALTH_IMPORT_SOURCE_CONFIRMATION: '来源发生变化，数据尚未写入；请查看预览并确认切换。',
  HEALTH_SYNC_CHANNEL_REQUIRED: '此账号已选择 Apple 健康通道，请从选定的 iPhone 同步；其他导入通道已暂停。',
  HEALTH_SYNC_CHANNEL_CHANGED: '同步通道已变化，本次数据未写入；请读取最新设置后重试。',
  SYNC_STORAGE_UNAVAILABLE: '本次未能确认保存结果，请稍后查看记录或使用相同批次重试。',
} as const;
export type SyncFailureCode = keyof typeof SYNC_FAILURES;
export interface SyncMetricReceipt {
  metric: HealthMetric; from: string | null; to: string | null; sources: string[]; sourceCount: number;
  received: number; added: number; updated: number; unchanged: number; older: number; manualOverrides: number;
}
export interface SyncAttemptSummary { version: 1; known: boolean; received: number | null; metrics: SyncMetricReceipt[]; emptySleepWindow: { from: string; to: string } | null }
export function emptySyncSummary(): SyncAttemptSummary { return { version: 1, known: false, received: null, metrics: [], emptySleepWindow: null }; }
export function syncPayloadSummary(payload: HealthSyncPayload): SyncAttemptSummary {
  const metrics: SyncMetricReceipt[] = [];
  for (const metric of SYNC_METRICS) {
    const rows = payload.measurements.filter((row) => row.metric === metric);
    if (!rows.length) continue;
    const days = rows.map(measurementDay).sort(), sources = [...new Set(rows.map((row) => row.source ?? '未注明来源'))].sort();
    metrics.push({ metric, from: days[0], to: days.at(-1)!, sources: sources.slice(0, 5), sourceCount: sources.length,
      received: rows.length, added: 0, updated: 0, unchanged: 0, older: 0, manualOverrides: 0 });
  }
  return { version: 1, known: true, received: payload.measurements.length, metrics, emptySleepWindow: null };
}
export function countSyncOutcome(summary: SyncAttemptSummary, row: HealthMeasurement, outcome: 'added' | 'updated' | 'unchanged' | 'older', manual: boolean) {
  const metric = summary.metrics.find((item) => item.metric === row.metric);
  if (!metric) return;
  metric[outcome]++;
  if (manual) metric.manualOverrides++;
}
/** A zero-record sleep report is still a request for sleep, never proof of 0 hours. */
export function withEmptySleepRequest(summary: SyncAttemptSummary, input: { from: string; to: string; source: string } | null): SyncAttemptSummary {
  if (!input) return summary;
  const window = { from: input.from, to: input.to };
  if (summary.metrics.some((item) => item.metric === 'sleep')) return { ...summary, emptySleepWindow: window };
  return { ...summary, emptySleepWindow: window, metrics: [...summary.metrics, { metric: 'sleep', from: input.from, to: input.to, sources: [input.source], sourceCount: 1,
    received: 0, added: 0, updated: 0, unchanged: 0, older: 0, manualOverrides: 0 }] };
}
export function syncAttemptStatus(result: { reverted?: boolean; replayed?: boolean; imported?: number }, summary: SyncAttemptSummary): SyncAttemptStatus {
  if (result.reverted) return 'reverted';
  if (result.replayed) return 'duplicate';
  if (summary.received === 0) return 'empty';
  return Number(result.imported) > 0 ? 'success' : 'unchanged';
}
export function syncMetricLabel(metric: HealthMetric): string { return METRIC_INFO[metric].label; }

/** Reused by full backup validation. The shape cannot carry health values or raw requests. */
export function parseSyncAttemptSummary(input: unknown): SyncAttemptSummary {
  const fail = (): never => { throw new Error('同步回执摘要格式不正确。'); };
  const exact = (value: unknown, fields: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== fields.length || fields.some((key) => !Object.hasOwn(row, key))) return fail();
    return row;
  };
  const count = (value: unknown, maximum = 1000): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fail();
  const day = (value: unknown): string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail();
    const parsed = Date.parse(value + 'T12:00:00Z');
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : fail();
  };
  const raw = exact(input, ['version','known','received','metrics','emptySleepWindow']);
  if (raw.version !== 1 || typeof raw.known !== 'boolean' || !Array.isArray(raw.metrics) || raw.metrics.length > SYNC_METRICS.length) return fail();
  if (raw.emptySleepWindow !== null) {
    const window = exact(raw.emptySleepWindow, ['from','to']); if (day(window.from) > day(window.to)) return fail();
  }
  const seen = new Set<string>(); let total = 0;
  for (const item of raw.metrics) {
    const metric = exact(item, ['metric','from','to','sources','sourceCount','received','added','updated','unchanged','older','manualOverrides']);
    if (!SYNC_METRICS.includes(metric.metric as typeof SYNC_METRICS[number]) || seen.has(String(metric.metric))) return fail();
    seen.add(String(metric.metric));
    if ((metric.from === null) !== (metric.to === null) || (metric.from !== null && day(metric.from) > day(metric.to))) return fail();
    if (!Array.isArray(metric.sources) || metric.sources.length > 5 || metric.sources.some((source) => typeof source !== 'string' || !source.length || source.length > 120 || Array.from(source).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) return fail();
    if (new Set(metric.sources).size !== metric.sources.length || count(metric.sourceCount) < metric.sources.length) return fail();
    const received = count(metric.received); total += received;
    if (received > 0 && metric.from === null) return fail();
    if (count(metric.added) + count(metric.updated) + count(metric.unchanged) + count(metric.older) > received || count(metric.manualOverrides) > received) return fail();
  }
  if (raw.emptySleepWindow !== null && !seen.has('sleep')) return fail();
  if (raw.known ? count(raw.received) !== total : raw.received !== null || raw.metrics.length > 0 || raw.emptySleepWindow !== null) return fail();
  return input as SyncAttemptSummary;
}

export interface SyncImportDiagnostic {
  scope: 'batch' | HealthMetric;
  receivedAt: string;
  exportedAt: string;
  submittedCount: number;
  importedCount: number | null;
  skippedCount: number | null;
  firstDay: string | null;
  lastDay: string | null;
}

export function summarizeSyncMeasurements(measurements: readonly HealthMeasurement[]) {
  return (Object.keys(METRIC_INFO) as HealthMetric[]).flatMap((metric) => {
    const days = measurements.filter((record) => record.metric === metric).map(measurementDay).sort();
    return days.length ? [{ metric, submittedCount: days.length, firstDay: days[0], lastDay: days.at(-1)! }] : [];
  });
}

export function buildSyncDiagnostics(measurements: readonly HealthMeasurement[], imports: readonly SyncImportDiagnostic[], now = new Date().toISOString()) {
  const today = shanghaiDay(now);
  const from = (days: number) => new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  const metrics = (Object.keys(METRIC_INFO) as HealthMetric[]).map((metric) => {
    const days = [...new Set(measurements.filter((record) => record.metric === metric)
      .map(measurementDay).filter((day) => day <= today))].sort();
    const latestDay = days.at(-1) ?? null;
    // Only measurement dates establish freshness. An empty import or a batch
    // containing another metric must not make this metric appear up to date.
    const freshness = latestDay === null ? 'missing' : latestDay >= from(metric === 'weight' || metric === 'lean_body_mass' ? 8 : 2) ? 'current' : 'stale';
    return {
      metric, label: METRIC_INFO[metric].label, latestDay, freshness,
      observedDays7: days.filter((day) => day >= from(7)).length,
      observedDays30: days.filter((day) => day >= from(30)).length,
      lastImport: imports.find((row) => row.scope === metric) ?? null,
    };
  });
  return { asOf: new Date(now).toISOString(), today, metrics, lastImport: imports.find((row) => row.scope === 'batch') ?? null };
}
