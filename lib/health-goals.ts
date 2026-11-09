import { HEALTH_TIMEZONE, shanghaiDay } from './health.ts';
import type { HealthSummary, ValidationIssue } from './health.ts';

export const GOAL_METRICS = ['steps', 'sleep', 'active_energy'] as const;
export type GoalMetric = typeof GOAL_METRICS[number];
export type GoalTargets = Record<GoalMetric, number | null>;
export interface GoalSettings { targets: GoalTargets; updatedAt: string | null }
export interface GoalDay {
  day: string;
  value: number | null;
  status: 'unset' | 'missing' | 'in-progress' | 'achieved' | 'missed';
  percent: number | null;
}
export interface GoalMetricProgress {
  metric: GoalMetric;
  label: string;
  unit: string;
  target: number | null;
  current: GoalDay;
  days: GoalDay[];
  achievedDays: number;
  recordedDays: number;
}
export interface GoalProgress extends GoalSettings {
  today: string;
  timezone: typeof HEALTH_TIMEZONE;
  metrics: GoalMetricProgress[];
}

export class GoalValidationError extends Error {
  readonly code = 'INVALID_HEALTH_GOALS';
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super('Health goals must contain all three valid targets');
    this.name = 'GoalValidationError';
    this.issues = issues;
  }
}

export function emptyGoalSettings(): GoalSettings {
  return { targets: { steps: null, sleep: null, active_energy: null }, updatedAt: null };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Complete replacement: omitted keys never silently preserve an older target. */
export function parseGoalSettingsInput(input: unknown): GoalTargets {
  const issues: ValidationIssue[] = [];
  if (!plainObject(input)) throw new GoalValidationError([{ path: '$', message: '请提交完整的目标设置。' }]);
  if (Object.keys(input).some((key) => key !== 'targets')) issues.push({ path: '$', message: '目标设置包含未知字段。' });
  if (!Object.hasOwn(input, 'targets') || !plainObject(input.targets)) {
    throw new GoalValidationError([...issues, { path: 'targets', message: '请提交三个指标的目标；未设置请使用 null。' }]);
  }
  const raw = input.targets;
  if (Object.keys(raw).some((key) => !GOAL_METRICS.includes(key as GoalMetric))) issues.push({ path: 'targets', message: '只支持步数、睡眠和活动能量目标。' });
  const targets: GoalTargets = { steps: null, sleep: null, active_energy: null };
  const maximum = { steps: 200000, sleep: 24, active_energy: 20000 };
  for (const metric of GOAL_METRICS) {
    const value = raw[metric];
    if (!Object.hasOwn(raw, metric)) {
      issues.push({ path: 'targets.' + metric, message: '请提供目标，或使用 null 取消。' });
    } else if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)
      || value <= 0 || value > maximum[metric] || (metric === 'steps' && !Number.isInteger(value)))) {
      issues.push({ path: 'targets.' + metric, message: metric === 'steps'
        ? '步数目标需为 1–200000 的整数。'
        : metric === 'sleep' ? '睡眠目标需大于 0 且不超过 24 小时。' : '活动能量目标需大于 0 且不超过 20000 千卡。' });
    } else targets[metric] = value as number | null;
  }
  if (issues.length) throw new GoalValidationError(issues);
  return targets;
}

/** Uses existing daily points, never adds totals from multiple devices. */
export function buildGoalProgress(settings: GoalSettings, summary: HealthSummary, now: Date | string = new Date()): GoalProgress {
  const instant = new Date(now);
  const today = shanghaiDay(instant.toISOString());
  const calendarToday = Date.parse(today + 'T12:00:00Z');
  const days = Array.from({ length: 30 }, (_, index) => new Date(calendarToday - (29 - index) * 86400000).toISOString().slice(0, 10));
  const labels = { steps: '步数', sleep: '睡眠', active_energy: '活动能量' };
  const units = { steps: '步', sleep: '小时', active_energy: '千卡' };
  const metrics = GOAL_METRICS.map((metric): GoalMetricProgress => {
    const target = settings.targets[metric];
    const points = new Map(summary.metrics[metric].points
      .filter((point) => point.day >= days[0] && point.day <= today
        && Number.isFinite(point.value) && point.value >= 0
        && Number.isFinite(Date.parse(point.measuredAt)) && Date.parse(point.measuredAt) <= instant.getTime())
      .map((point) => [point.day, point.value]));
    const calendar = days.map((day): GoalDay => {
      const value = points.get(day) ?? null;
      const status = target === null ? 'unset' : value === null ? 'missing'
        : value >= target ? 'achieved' : day === today ? 'in-progress' : 'missed';
      return { day, value, status, percent: target === null || value === null ? null : Math.min(100, value / target * 100) };
    });
    return {
      metric, label: labels[metric], unit: units[metric], target,
      current: calendar[calendar.length - 1], days: calendar,
      achievedDays: calendar.filter((day) => day.status === 'achieved').length,
      recordedDays: calendar.filter((day) => day.value !== null).length,
    };
  });
  return { today, timezone: HEALTH_TIMEZONE, targets: { ...settings.targets }, updatedAt: settings.updatedAt, metrics };
}
