import { METRIC_INFO, measurementDay, shanghaiDay } from './health.ts';
import type { HealthMeasurement, HealthMetric } from './health.ts';

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
