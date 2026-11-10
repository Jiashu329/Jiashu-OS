/**
 * Versioned Apple Health → website contract.
 *
 * Steps, energy, and sleep use one selected source per metric/day and an
 * already aggregated daily total. Body mass metrics retain individual samples.
 * This module never adds raw phone/watch activity or sleep samples.
 * Sleep belongs to the Shanghai calendar date on which its interval ends;
 * it is not split or redistributed across midnight.
 */

export const HEALTH_TIMEZONE = "Asia/Shanghai" as const;
export const MAX_SYNC_BYTES = 512 * 1024;
export const MAX_MEASUREMENTS = 1000;

export const METRIC_INFO = {
  weight: { label: "体重", unit: "kg", minimum: 10, maximum: 600 },
  lean_body_mass: { label: "去脂体重", unit: "kg", minimum: 1, maximum: 600 },
  steps: { label: "步数", unit: "count", minimum: 0, maximum: 200000 },
  active_energy: { label: "活动能量", unit: "kcal", minimum: 0, maximum: 20000 },
  sleep: { label: "睡眠", unit: "hours", minimum: 0, maximum: 24 },
} as const;

export type HealthMetric = keyof typeof METRIC_INFO;
export type HealthUnit = (typeof METRIC_INFO)[HealthMetric]["unit"];

/** Hours within the same reporting window; awake and inBed are separate totals. */
export interface SleepStages {
  unspecified: number;
  core: number;
  deep: number;
  rem: number;
  awake: number;
  inBed: number;
}

export interface HealthMeasurement {
  id: string;
  metric: HealthMetric;
  value: number;
  unit: HealthUnit;
  /** All accepted dates are normalized to an ISO UTC timestamp. */
  startDate: string;
  endDate?: string;
  source?: string;
  /** Required for steps, energy, and sleep; optional/sample for body mass measurements. */
  aggregation?: "daily" | "sample";
  /** Optional for legacy totals. The four asleep stages sum to value. */
  sleepStages?: SleepStages;
}

export interface HealthSyncPayload {
  version: 1;
  source: "apple-health-shortcuts";
  timezone: typeof HEALTH_TIMEZONE;
  /** Compare this value on upsert; old exports must not replace newer records. */
  exportedAt: string;
  measurements: HealthMeasurement[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class HealthValidationError extends Error {
  readonly code = "INVALID_HEALTH_SYNC";
  readonly status = 400;
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "HealthValidationError";
    this.issues = issues;
  }
}

const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const sourcePattern = /^[^\u0000-\u001f\u007f]{1,120}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$/;
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: HEALTH_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Rejects impossible dates such as February 30 instead of letting Date normalize them. */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = timestampPattern.exec(value);
  if (!match || match[0] !== value) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number((fraction ?? "").padEnd(3, "0"));
  const offsetHour = zone === "Z" ? 0 : Number(offsetHourText);
  const offsetMinute = zone === "Z" ? 0 : Number(offsetMinuteText);
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)) return null;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
  const offset = (offsetHour * 60 + offsetMinute) * 60000 * (sign === "-" ? -1 : 1);
  const normalized = new Date(local.getTime() - offset);
  // Keep accepted timestamps closed under normalization: downstream day helpers
  // must be able to read the canonical UTC value that the parser returns.
  if (normalized.getUTCFullYear() < 1970 || normalized.getUTCFullYear() > 2100) return null;
  return normalized.toISOString();
}

export function shanghaiDay(timestamp: string): string {
  const parsed = normalizeTimestamp(timestamp);
  if (!parsed) throw new HealthValidationError([{ path: "timestamp", message: "Expected a valid ISO timestamp with a timezone" }]);
  const parts = dayFormatter.formatToParts(new Date(parsed));
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function measurementDay(measurement: HealthMeasurement): string {
  if (measurement.metric === "sleep") {
    if (!measurement.endDate) throw new HealthValidationError([{ path: "endDate", message: "Sleep requires an ending timestamp" }]);
    return shanghaiDay(measurement.endDate);
  }
  return shanghaiDay(measurement.startDate);
}

function isSampleMetric(metric: HealthMetric): boolean {
  return metric === "weight" || metric === "lean_body_mass";
}

/** Daily totals have a stable metric/day key; mass samples retain their sender-provided ID. */
export function measurementKey(measurement: HealthMeasurement): string {
  return isSampleMetric(measurement.metric)
    ? `${measurement.metric}:${measurement.id}`
    : `${measurement.metric}:${measurementDay(measurement)}`;
}

/**
 * Accept JSON text or a plain parsed object. Empty measurements is a valid sync,
 * not a zero-valued measurement. Unknown fields and ambiguous daily sources are rejected.
 */
export function parseSyncPayload(input: unknown): HealthSyncPayload {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => {
    if (issues.length < 20) issues.push({ path, message });
  };
  let encoded: string;
  try {
    encoded = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    throw new HealthValidationError([{ path: "$", message: "Expected JSON-serializable data without cycles" }]);
  }
  if (typeof encoded !== "string") throw new HealthValidationError([{ path: "$", message: "Expected a JSON object" }]);
  if (new TextEncoder().encode(encoded).byteLength > MAX_SYNC_BYTES) {
    throw new HealthValidationError([{ path: "$", message: `Payload exceeds ${MAX_SYNC_BYTES} bytes` }]);
  }
  let raw: unknown;
  try {
    raw = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new HealthValidationError([{ path: "$", message: "Invalid JSON" }]);
  }
  if (!isObject(raw)) throw new HealthValidationError([{ path: "$", message: "Expected a JSON object" }]);
  const allowedPayloadKeys = new Set(["version", "source", "timezone", "exportedAt", "measurements"]);
  for (const key of Object.keys(raw)) if (!allowedPayloadKeys.has(key)) add(key, "Unknown field");
  if (raw.version !== 1) add("version", "Expected schema version 1");
  if (raw.source !== "apple-health-shortcuts") add("source", "Expected apple-health-shortcuts");
  if (raw.timezone !== HEALTH_TIMEZONE) add("timezone", `Expected ${HEALTH_TIMEZONE}`);
  const exportedAt = normalizeTimestamp(raw.exportedAt);
  if (!exportedAt) add("exportedAt", "Expected a valid ISO timestamp with a timezone");
  if (!Array.isArray(raw.measurements)) add("measurements", "Expected an array");
  else if (raw.measurements.length > MAX_MEASUREMENTS) add("measurements", `At most ${MAX_MEASUREMENTS} records are allowed`);
  if (issues.length) throw new HealthValidationError(issues);

  const measurements: HealthMeasurement[] = [];
  const byID = new Map<string, string>();
  const byKey = new Map<string, string>();
  const sources = new Map<string, string>();
  const allowedMeasurementKeys = new Set(["id", "metric", "value", "unit", "startDate", "endDate", "source", "aggregation", "sleepStages"]);
  const sleepStageKeys = ["unspecified", "core", "deep", "rem", "awake", "inBed"] as const;
  const sleepTolerance = 1e-8;

  for (const [index, item] of (raw.measurements as unknown[]).entries()) {
    if (issues.length >= 20) break;
    const path = `measurements[${index}]`;
    if (!isObject(item)) { add(path, "Expected an object"); continue; }
    const issueCount = issues.length;
    for (const key of Object.keys(item)) if (!allowedMeasurementKeys.has(key)) add(`${path}.${key}`, "Unknown field");
    if (typeof item.id !== "string" || item.id.trim() !== item.id || !idPattern.test(item.id)) add(`${path}.id`, "Expected a stable ID of 1–160 safe characters");
    if (typeof item.metric !== "string" || !Object.hasOwn(METRIC_INFO, item.metric)) { add(`${path}.metric`, "Unknown metric"); continue; }
    const metric = item.metric as HealthMetric;
    const definition = METRIC_INFO[metric];
    if (typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < definition.minimum || item.value > definition.maximum) {
      add(`${path}.value`, `Expected a finite number from ${definition.minimum} to ${definition.maximum}`);
    } else if (metric === "steps" && !Number.isInteger(item.value)) add(`${path}.value`, "Steps must be an integer");
    if (item.unit !== definition.unit) add(`${path}.unit`, `Expected ${definition.unit}`);
    const startDate = normalizeTimestamp(item.startDate);
    const endDate = item.endDate === undefined ? undefined : normalizeTimestamp(item.endDate);
    if (!startDate) add(`${path}.startDate`, "Expected a valid ISO timestamp with a timezone");
    if (item.endDate !== undefined && !endDate) add(`${path}.endDate`, "Expected a valid ISO timestamp with a timezone");
    if (startDate && endDate && Date.parse(endDate) < Date.parse(startDate)) add(`${path}.endDate`, "End must not precede start");
    if (startDate && exportedAt && Date.parse(startDate) > Date.parse(exportedAt) + 5 * 60000) add(`${path}.startDate`, "Measurement is later than its export");
    if (endDate && exportedAt && Date.parse(endDate) > Date.parse(exportedAt) + 5 * 60000) add(`${path}.endDate`, "Measurement is later than its export");
    if (item.source !== undefined && (typeof item.source !== "string" || item.source.trim() !== item.source || !sourcePattern.test(item.source))) {
      add(`${path}.source`, "Expected a non-empty source identifier of at most 120 characters");
    }
    if (isSampleMetric(metric)) {
      if (item.aggregation !== undefined && item.aggregation !== "sample") add(`${path}.aggregation`, "Body mass is a point sample, not a daily total");
    } else {
      if (item.aggregation !== "daily") add(`${path}.aggregation`, "Send an explicit daily aggregate; raw samples must not be added together here");
      if (!endDate) add(`${path}.endDate`, "A daily aggregate requires an ending timestamp");
      if (typeof item.source !== "string" || !item.source.length) add(`${path}.source`, "A daily aggregate requires one selected source");
      if (startDate && endDate && Date.parse(endDate) <= Date.parse(startDate)) add(`${path}.endDate`, "A daily aggregate must cover a positive interval");
      if (startDate && endDate && Date.parse(endDate) - Date.parse(startDate) > 48 * 3600000) add(`${path}.endDate`, "A daily aggregate interval cannot exceed 48 hours");
      if (metric !== "sleep" && startDate && endDate && Date.parse(endDate) > Date.parse(startDate)
        && shanghaiDay(startDate) !== shanghaiDay(new Date(Date.parse(endDate) - 1).toISOString())) {
        add(`${path}.endDate`, "Steps and energy totals must stay within one Shanghai calendar day, ending no later than the next midnight");
      }
      const sourceDayTimestamp = metric === "sleep" ? endDate : startDate;
      if (typeof item.source === "string" && sourceDayTimestamp) {
        const sourceKey = `${metric}:${shanghaiDay(sourceDayTimestamp)}`;
        const previousSource = sources.get(sourceKey);
        if (previousSource !== undefined && previousSource !== item.source) add(`${path}.source`, "Use one selected source per metric and day");
        else sources.set(sourceKey, item.source);
      }
    }
    let sleepStages: SleepStages | undefined;
    if (Object.hasOwn(item, "sleepStages")) {
      const stagePath = `${path}.sleepStages`;
      if (metric !== "sleep") add(stagePath, "Sleep stages are only allowed for sleep measurements");
      else if (!isObject(item.sleepStages)) add(stagePath, "Expected a sleep stage duration object");
      else {
        const stageIssueCount = issues.length;
        const suppliedStages = item.sleepStages;
        for (const key of Object.keys(suppliedStages)) {
          if (!(sleepStageKeys as readonly string[]).includes(key)) add(`${stagePath}.${key}`, "Unknown sleep stage");
        }
        for (const key of sleepStageKeys) {
          const hours = suppliedStages[key];
          if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0 || hours > 24) {
            add(`${stagePath}.${key}`, "Expected finite hours from 0 to 24");
          } else if (startDate && endDate && hours > (Date.parse(endDate) - Date.parse(startDate)) / 3600000 + sleepTolerance) {
            add(`${stagePath}.${key}`, "Stage duration cannot exceed the reporting window");
          }
        }
        if (issues.length === stageIssueCount) {
          const stages = Object.fromEntries(sleepStageKeys.map((key) => [key, suppliedStages[key]])) as unknown as SleepStages;
          const asleepHours = stages.unspecified + stages.core + stages.deep + stages.rem;
          if (typeof item.value === "number" && Number.isFinite(item.value) && Math.abs(asleepHours - item.value) > sleepTolerance) {
            add(stagePath, "Asleep stage durations must sum to the sleep total");
          }
          if (startDate && endDate && asleepHours > (Date.parse(endDate) - Date.parse(startDate)) / 3600000 + sleepTolerance) {
            add(stagePath, "Asleep stage durations cannot exceed the reporting window");
          }
          sleepStages = stages;
        }
      }
    }
    if (issues.length !== issueCount) continue;

    const measurement: HealthMeasurement = {
      id: item.id as string,
      metric,
      value: item.value as number,
      unit: definition.unit,
      startDate: startDate!,
      ...(endDate ? { endDate } : {}),
      ...(item.source !== undefined ? { source: item.source as string } : {}),
      ...(isSampleMetric(metric) ? { aggregation: "sample" as const } : { aggregation: "daily" as const }),
      ...(sleepStages ? { sleepStages } : {}),
    };
    const serialized = JSON.stringify(measurement);
    const priorID = byID.get(measurement.id);
    if (priorID !== undefined) {
      if (priorID !== serialized) add(`${path}.id`, "The same ID cannot describe different records in one export");
      continue;
    }
    // Track every sender ID, including aliases of an identical daily total.
    // Otherwise an alias could later be reused for a different day unnoticed.
    byID.set(measurement.id, serialized);
    const key = measurementKey(measurement);
    const comparable = JSON.stringify({ ...measurement, id: "" });
    const priorKey = byKey.get(key);
    if (priorKey !== undefined) {
      if (priorKey !== comparable) add(path, "Only one unambiguous daily total is allowed per metric and day");
      continue;
    }
    byKey.set(key, comparable);
    measurements.push(measurement);
  }
  if (issues.length) throw new HealthValidationError(issues);
  return { version: 1, source: "apple-health-shortcuts", timezone: HEALTH_TIMEZONE, exportedAt: exportedAt!, measurements };
}

export interface HealthTrendPoint {
  day: string;
  value: number;
  measuredAt: string;
  source: string | null;
  sleepStages?: SleepStages;
}

export interface HealthMetricSummary {
  metric: HealthMetric;
  label: string;
  unit: HealthUnit;
  latestValue: number | null;
  latestDate: string | null;
  points: HealthTrendPoint[];
}

export interface HealthSummary {
  metrics: Record<HealthMetric, HealthMetricSummary>;
  measurementCount: number;
  lastMeasurementAt: string | null;
}

/**
 * No filling gaps with zero. Daily totals are replaced, never summed. If a
 * caller supplies repeated daily keys, later array entries take precedence;
 * the persistence layer must first order/resolve them by exportedAt.
 * Multiple mass samples on one day become the last measurement of that day.
 */
export function buildHealthSummary(input: readonly HealthMeasurement[]): HealthSummary {
  const unique = new Map<string, HealthMeasurement>();
  for (const measurement of input) unique.set(measurementKey(measurement), measurement);
  const measurements = [...unique.values()];
  const metrics = {} as Record<HealthMetric, HealthMetricSummary>;
  for (const metric of Object.keys(METRIC_INFO) as HealthMetric[]) {
    const rows = measurements.filter((measurement) => measurement.metric === metric);
    const daily = new Map<string, HealthTrendPoint>();
    for (const row of rows) {
      const day = measurementDay(row);
      const measuredAt = row.metric === "sleep" ? row.endDate! : row.startDate;
      const previous = daily.get(day);
      if (!isSampleMetric(metric) || !previous || Date.parse(measuredAt) >= Date.parse(previous.measuredAt)) {
        daily.set(day, { day, value: row.value, measuredAt, source: row.source ?? null,
          ...(row.metric === "sleep" && row.sleepStages ? { sleepStages: row.sleepStages } : {}),
        });
      }
    }
    const points = [...daily.values()].sort((left, right) => left.day.localeCompare(right.day));
    const latest = points.at(-1);
    metrics[metric] = {
      metric,
      label: METRIC_INFO[metric].label,
      unit: METRIC_INFO[metric].unit,
      latestValue: latest?.value ?? null,
      latestDate: latest?.measuredAt ?? null,
      points,
    };
  }
  const lastMeasurementAt = measurements.reduce<string | null>((latest, row) => {
    const timestamp = isSampleMetric(row.metric) ? row.startDate : row.endDate ?? row.startDate;
    return latest === null || Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest;
  }, null);
  return { metrics, measurementCount: measurements.length, lastMeasurementAt };
}
