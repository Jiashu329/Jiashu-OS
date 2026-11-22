import { isCalendarDay } from './date-range.ts';
import { normalizeTimestamp, shanghaiDay } from './health.ts';

export const APPLE_VITAL_METRICS = ['heartRate', 'restingHeartRate', 'oxygenSaturation'] as const;
export type AppleVitalMetric = typeof APPLE_VITAL_METRICS[number];
export const MAX_APPLE_VITAL_DAYS = 360;
export const MAX_APPLE_WORKOUTS = 1000;

export interface AppleVitalRange {
  average: number;
  min: number;
  max: number;
}

export interface AppleVitalDay {
  day: string;
  heartRate?: AppleVitalRange;
  restingHeartRate?: { value: number; measuredAt: string };
  oxygenSaturation?: AppleVitalRange & { latest: number; count: number; measuredAt: string };
}

export interface AppleWorkout {
  id: string;
  activityType: number;
  startDate: string;
  endDate: string;
  durationSeconds: number;
  energyKcal?: number;
  distanceMeters?: number;
}

export interface AppleActivityPayload {
  version: 1;
  exportedAt: string;
  vitals: AppleVitalDay[];
  workouts: AppleWorkout[];
}

export class AppleActivityValidationError extends Error {
  constructor(field: string) {
    super('Apple 健康同步数据不正确，请核对 ' + field + '。');
    this.name = 'AppleActivityValidationError';
  }
}

function invalid(field: string): never { throw new AppleActivityValidationError(field); }
function object(value: unknown, field: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  if (!required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid(field);
  return value as Record<string, unknown>;
}

function finite(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid(field);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const number = finite(value, field, 1);
  if (!Number.isSafeInteger(number)) invalid(field);
  return number;
}

function timestamp(value: unknown, field: string, exportedAt?: string): string {
  const canonical = normalizeTimestamp(value);
  if (!canonical || (exportedAt !== undefined && canonical > exportedAt)) invalid(field);
  return canonical;
}

function measuredAt(value: unknown, field: string, day: string, exportedAt: string): string {
  const measured = timestamp(value, field, exportedAt);
  if (shanghaiDay(measured) !== day) invalid(field);
  return measured;
}

const rangeFields = ['average', 'min', 'max'];
function range(value: Record<string, unknown>, field: string, maximum: number): AppleVitalRange {
  const min = finite(value.min, field + '.min', Number.MIN_VALUE, maximum);
  const max = finite(value.max, field + '.max', min, maximum);
  // Floating-point averages can fall just outside an otherwise valid sample range.
  const average = finite(value.average, field + '.average', Math.max(Number.MIN_VALUE, min - 1e-9), Math.min(maximum, max + 1e-9));
  return { average: Math.min(max, Math.max(min, average)), min, max };
}

function vitalDay(value: unknown, field: string, exportedAt: string): AppleVitalDay {
  const raw = object(value, field, ['day'], APPLE_VITAL_METRICS);
  if (!isCalendarDay(raw.day) || raw.day > shanghaiDay(exportedAt) || Object.keys(raw).length === 1) invalid(field);
  const day: AppleVitalDay = { day: raw.day };
  if (Object.hasOwn(raw, 'heartRate')) {
    const path = field + '.heartRate';
    day.heartRate = range(object(raw.heartRate, path, rangeFields), path, 500);
  }
  if (Object.hasOwn(raw, 'restingHeartRate')) {
    const path = field + '.restingHeartRate';
    const resting = object(raw.restingHeartRate, path, ['value', 'measuredAt']);
    day.restingHeartRate = { value: finite(resting.value, path + '.value', Number.MIN_VALUE, 500),
      measuredAt: measuredAt(resting.measuredAt, path + '.measuredAt', day.day, exportedAt) };
  }
  if (Object.hasOwn(raw, 'oxygenSaturation')) {
    const path = field + '.oxygenSaturation';
    const oxygen = object(raw.oxygenSaturation, path, [...rangeFields, 'latest', 'count', 'measuredAt']);
    const bounds = range(oxygen, path, 100);
    day.oxygenSaturation = { ...bounds, latest: finite(oxygen.latest, path + '.latest', bounds.min, bounds.max),
      count: positiveInteger(oxygen.count, path + '.count'),
      measuredAt: measuredAt(oxygen.measuredAt, path + '.measuredAt', day.day, exportedAt) };
  }
  return day;
}

const WORKOUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function workout(value: unknown, field: string, exportedAt: string): AppleWorkout {
  const raw = object(value, field, ['id', 'activityType', 'startDate', 'endDate', 'durationSeconds'], ['energyKcal', 'distanceMeters']);
  if (typeof raw.id !== 'string' || raw.id.length !== 36 || !WORKOUT_ID.test(raw.id)) invalid(field + '.id');
  const startDate = timestamp(raw.startDate, field + '.startDate', exportedAt);
  const endDate = timestamp(raw.endDate, field + '.endDate', exportedAt);
  if (endDate < startDate || !isCalendarDay(shanghaiDay(startDate))) invalid(field + '.endDate');
  const elapsedSeconds = (Date.parse(endDate) - Date.parse(startDate)) / 1000;
  return {
    id: raw.id, activityType: positiveInteger(raw.activityType, field + '.activityType'), startDate, endDate,
    durationSeconds: finite(raw.durationSeconds, field + '.durationSeconds', 0, elapsedSeconds + 0.001),
    ...(Object.hasOwn(raw, 'energyKcal') ? { energyKcal: finite(raw.energyKcal, field + '.energyKcal') } : {}),
    ...(Object.hasOwn(raw, 'distanceMeters') ? { distanceMeters: finite(raw.distanceMeters, field + '.distanceMeters') } : {}),
  };
}

export function parseAppleActivityPayload(value: unknown): AppleActivityPayload {
  const raw = object(value, '数据格式', ['version', 'exportedAt', 'vitals', 'workouts']);
  if (raw.version !== 1) invalid('version');
  const exportedAt = timestamp(raw.exportedAt, 'exportedAt');
  if (!Array.isArray(raw.vitals) || raw.vitals.length > MAX_APPLE_VITAL_DAYS) invalid('vitals');
  if (!Array.isArray(raw.workouts) || raw.workouts.length > MAX_APPLE_WORKOUTS) invalid('workouts');
  const vitals = raw.vitals.map((entry, index) => vitalDay(entry, `vitals[${index}]`, exportedAt));
  const workouts = raw.workouts.map((entry, index) => workout(entry, `workouts[${index}]`, exportedAt));
  if (new Set(vitals.map(entry => entry.day)).size !== vitals.length) invalid('vitals 日期');
  if (new Set(workouts.map(entry => entry.id)).size !== workouts.length) invalid('workouts 记录 ID');
  return { version: 1, exportedAt, vitals, workouts };
}
