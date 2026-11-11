import { buildHealthSummary, shanghaiDay } from './health.ts';
import type { HealthMeasurement } from './health.ts';
import type { GoalSettings } from './health-goals.ts';
import { goalTargetsForDay } from './health-goals.ts';

export const WEEKLY_METRICS = ['steps', 'sleep', 'active_energy', 'weight'] as const;
export type WeeklyMetric = typeof WEEKLY_METRICS[number];
export interface HealthWeekSelection {
  weekStart: string;
  weekEnd: string;
  cutoffDay: string;
  previousStart: string;
  previousEnd: string;
  previousCutoffDay: string;
  comparisonDays: number;
  today: string;
  isCurrent: boolean;
  partial: boolean;
}
export interface WeeklyPoint { day: string; value: number | null; target?: number | null; targetEffectiveFrom?: string | null }
export interface WeeklyMetricReview {
  metric: WeeklyMetric;
  label: string;
  unit: string;
  currentAverage: number | null;
  previousAverage: number | null;
  delta: number | null;
  currentRecordedDays: number;
  previousRecordedDays: number;
  currentPoints: WeeklyPoint[];
  previousPoints: WeeklyPoint[];
  target: number | null;
  currentAchievedDays: number | null;
  previousAchievedDays: number | null;
  targetBasis?: 'daily';
  targetsInPeriod?: Array<{ day: string; target: number | null; effectiveFrom: string | null }>;
}
export interface HealthWeeklyReview extends HealthWeekSelection {
  targetsUpdatedAt: string | null;
  metrics: WeeklyMetricReview[];
}

export class HealthWeekValidationError extends Error {
  readonly code = 'INVALID_HEALTH_WEEK';
  constructor(message: string) { super(message); this.name = 'HealthWeekValidationError'; }
}

function validDay(value: string) {
  if (value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  // Include the canonical Monday for the first supported health dates in 1970.
  return value >= '1969-12-29' && year <= 2100 && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function shiftDay(day: string, offset: number) {
  return new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}

function monday(day: string) {
  const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

export function parseHealthWeekQuery(params: URLSearchParams, now: Date | number = Date.now()): HealthWeekSelection {
  const today = shanghaiDay(new Date(now).toISOString());
  const requested = params.get('week') ?? today;
  if (!validDay(requested)) throw new HealthWeekValidationError('请选择有效的 YYYY-MM-DD 日期。');
  const weekStart = monday(requested);
  const currentStart = monday(today);
  if (weekStart > currentStart) throw new HealthWeekValidationError('不能查看未来的健康回顾周。');
  const isCurrent = weekStart === currentStart;
  const comparisonDays = isCurrent ? Math.round((Date.parse(today + 'T12:00:00Z') - Date.parse(weekStart + 'T12:00:00Z')) / 86400000) + 1 : 7;
  const previousStart = shiftDay(weekStart, -7);
  return {
    weekStart, weekEnd: shiftDay(weekStart, 6), cutoffDay: isCurrent ? today : shiftDay(weekStart, 6),
    previousStart, previousEnd: shiftDay(previousStart, 6), previousCutoffDay: shiftDay(previousStart, comparisonDays - 1),
    comparisonDays, today, isCurrent, partial: isCurrent,
  };
}

/** Exclude future instants before choosing the last body-mass sample of each day. */
export function buildHealthWeeklyReview(measurements: readonly HealthMeasurement[], settings: GoalSettings, selection: HealthWeekSelection, now: Date | number = Date.now()): HealthWeeklyReview {
  const instant = new Date(now).getTime();
  const eligible = measurements.filter((measurement) => {
    const start = Date.parse(measurement.startDate);
    // Body mass remains a point sample even if a legacy record has an endDate.
    const measured = measurement.metric === 'weight' || measurement.metric === 'lean_body_mass'
      ? start : Date.parse(measurement.endDate ?? measurement.startDate);
    return Number.isFinite(start) && Number.isFinite(measured) && start <= instant && measured <= instant;
  });
  const summary = buildHealthSummary(eligible);
  const labels = { steps: '步数', sleep: '睡眠', active_energy: '活动能量', weight: '体重' };
  const units = { steps: '步', sleep: '小时', active_energy: '千卡', weight: 'kg' };
  const metrics = WEEKLY_METRICS.map((metric): WeeklyMetricReview => {
    const values = new Map(summary.metrics[metric].points.map((point) => [point.day, point.value]));
    const points = (start: string): WeeklyPoint[] => Array.from({ length: selection.comparisonDays }, (_, index) => {
      const day = shiftDay(start, index);
      const goal = goalTargetsForDay(settings,day);
      return { day, value: values.get(day) ?? null, ...(metric==='weight'?{}:{target:goal.targets[metric],targetEffectiveFrom:goal.effectiveFrom}) };
    });
    const currentPoints = points(selection.weekStart);
    const previousPoints = points(selection.previousStart);
    const observed = (rows: WeeklyPoint[]) => rows.filter((point): point is WeeklyPoint & { value: number } => point.value !== null);
    const current = observed(currentPoints);
    const previous = observed(previousPoints);
    const average = (rows: Array<WeeklyPoint & { value: number }>) => rows.length ? rows.reduce((total, point) => total + point.value, 0) / rows.length : null;
    const currentAverage = average(current);
    const previousAverage = average(previous);
    const target = metric === 'weight' ? null : settings.targets[metric];
    return {
      metric, label: labels[metric], unit: units[metric], currentAverage, previousAverage,
      delta: currentAverage === null || previousAverage === null ? null : currentAverage - previousAverage,
      currentRecordedDays: current.length, previousRecordedDays: previous.length, currentPoints, previousPoints, target,
      currentAchievedDays: metric==='weight'||currentPoints.every((point)=>point.target===null) ? null : current.filter((point) => point.target!==null&&point.target!==undefined&&point.value >= point.target).length,
      previousAchievedDays: metric==='weight'||previousPoints.every((point)=>point.target===null) ? null : previous.filter((point) => point.target!==null&&point.target!==undefined&&point.value >= point.target).length,
      ...(metric==='weight'?{}:{targetBasis:'daily',targetsInPeriod:currentPoints.map((point)=>({day:point.day,target:point.target??null,effectiveFrom:point.targetEffectiveFrom??null}))}),
    };
  });
  return { ...selection, targetsUpdatedAt: settings.updatedAt, metrics };
}
