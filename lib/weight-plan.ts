import { buildHealthSummary, HEALTH_TIMEZONE, normalizeTimestamp, shanghaiDay } from './health.ts';
import type { HealthMeasurement, ValidationIssue } from './health.ts';

export interface WeightPlanInput {
  baselineWeight: number;
  targetWeight: number;
  startDate: string;
  deadline: string;
  enabled: boolean;
}
export interface WeightPlanSettings extends WeightPlanInput { createdAt: string; updatedAt: string; revision?: number }
export interface WeightPlanPoint { day: string; value: number }
export interface WeightChangeRate {
  from: string | null; to: string | null; recordedDays: number; daysBetween: number;
  changeKg: number | null; kgPerWeek: number | null;
}
export interface WeightObservations {
  latestWeight: number | null;
  latestDate: string | null;
  average7: number | null;
  recordedDays7: number;
  points: WeightPlanPoint[];
  rate7: WeightChangeRate;
  rate30: WeightChangeRate;
}
export interface WeightPlanProgress {
  direction: 'loss' | 'gain' | 'maintain';
  gapKg: number | null;
  progressPercent: number | null;
  referenceWeight: number;
  referencePoints: WeightPlanPoint[];
  remainingDays: number;
  status: 'active' | 'achieved' | 'ended' | 'missing';
  sustained: { requiredDays: 7; recordedDays: number; qualifyingDays: number; achieved: boolean };
}
export interface WeightPlanReview {
  today: string;
  timezone: typeof HEALTH_TIMEZONE;
  settings: WeightPlanSettings | null;
  observations: WeightObservations;
  progress: WeightPlanProgress | null;
}
export class WeightPlanValidationError extends Error {
  readonly code = 'INVALID_WEIGHT_PLAN';
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join('；'));
    this.name = 'WeightPlanValidationError';
    this.issues = issues;
  }
}
function fail(path: string, message: string): never { throw new WeightPlanValidationError([{ path, message }]); }
function calendar(input: unknown, path: string) {
  if (typeof input !== 'string' || input.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(input)
    || !normalizeTimestamp(input + 'T12:00:00+08:00')) return fail(path, '请选择 1970–2100 年之间的有效日期。');
  return input;
}
function shiftDay(day: string, offset: number) {
  return new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}
function calendarDifference(later: string, earlier: string) {
  return Math.round((Date.parse(later + 'T12:00:00Z') - Date.parse(earlier + 'T12:00:00Z')) / 86400000);
}

/** Uses two actual daily last values, exposing their span instead of inventing a missing anchor. */
export function weightChangeRate(points: readonly WeightPlanPoint[], today: string, days: 7 | 30): WeightChangeRate {
  const observed=points.filter((point)=>point.day>=shiftDay(today,1-days)&&point.day<=today).sort((a,b)=>a.day.localeCompare(b.day));
  const first=observed[0],last=observed.at(-1),span=first&&last?calendarDifference(last.day,first.day):0;
  const change=span>0?last!.value-first!.value:null;
  return {from:first?.day??null,to:last?.day??null,recordedDays:observed.length,daysBetween:span,changeKg:change,kgPerWeek:change===null?null:change/span*7};
}

/** User-provided settings are required in full; no weight or target is inferred. */
export function parseWeightPlanInput(input: unknown, now: Date | number = Date.now()): WeightPlanInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return fail('$', '请提交完整的体重计划。');
  const raw = input as Record<string, unknown>;
  const allowed = ['baselineWeight', 'targetWeight', 'startDate', 'deadline', 'enabled'];
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new WeightPlanValidationError(unknown.map((path) => ({ path, message: '此计划字段不受支持。' })));
  for (const field of ['baselineWeight', 'targetWeight'] as const) {
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field]) || raw[field] < 10 || raw[field] > 600) return fail(field, '体重需为 10–600 kg 之间的有效数字。');
  }
  const startDate = calendar(raw.startDate, 'startDate');
  const deadline = calendar(raw.deadline, 'deadline');
  const today = shanghaiDay(new Date(now).toISOString());
  if (startDate > today) return fail('startDate', '计划起始日期不能晚于今天。');
  if (deadline <= startDate) return fail('deadline', '目标日期需晚于起始日期。');
  if (typeof raw.enabled !== 'boolean') return fail('enabled', '请明确体重计划是否启用。');
  return { baselineWeight: raw.baselineWeight as number, targetWeight: raw.targetWeight as number, startDate, deadline, enabled: raw.enabled };
}

/** Observations stay available before configuration and while a saved plan is disabled. */
export function buildWeightPlanReview(settings: WeightPlanSettings | null, measurements: readonly HealthMeasurement[], now: Date | number = Date.now()): WeightPlanReview {
  const instant = new Date(now).getTime();
  const today = shanghaiDay(new Date(now).toISOString());
  const from = shiftDay(today, -359);
  const eligible = measurements.filter((measurement) => measurement.metric === 'weight'
    && Number.isFinite(Date.parse(measurement.startDate)) && Date.parse(measurement.startDate) <= instant
    && Number.isFinite(measurement.value));
  const points = buildHealthSummary(eligible).metrics.weight.points
    .filter((point) => point.day >= from && point.day <= today).map((point) => ({ day: point.day, value: point.value }));
  const recent = points.filter((point) => point.day >= shiftDay(today, -6));
  const average7 = recent.length ? recent.reduce((sum, point) => sum + point.value, 0) / recent.length : null;
  const latest = points.at(-1);
  const observations: WeightObservations = {
    latestWeight: latest?.value ?? null, latestDate: latest?.day ?? null,
    average7, recordedDays7: recent.length, points,rate7:weightChangeRate(points,today,7),rate30:weightChangeRate(points,today,30),
  };
  let progress: WeightPlanProgress | null = null;
  if (settings?.enabled) {
    const distance = settings.targetWeight - settings.baselineWeight;
    const direction = distance < 0 ? 'loss' : distance > 0 ? 'gain' : 'maintain';
    const totalDays = calendarDifference(settings.deadline, settings.startDate);
    const elapsed = Math.max(0, Math.min(totalDays, calendarDifference(today, settings.startDate)));
    const referenceWeight = settings.baselineWeight + distance * elapsed / totalDays;
    const achieved = average7 !== null && (direction === 'loss' ? average7 <= settings.targetWeight
      : direction === 'gain' ? average7 >= settings.targetWeight : false);
    const gapKg = average7 === null ? null : direction === 'loss' ? Math.max(0, average7 - settings.targetWeight)
      : direction === 'gain' ? Math.max(0, settings.targetWeight - average7) : Math.abs(average7 - settings.targetWeight);
    const progressPercent = average7 === null || direction === 'maintain' ? null
      : Math.max(0, Math.min(100, (average7 - settings.baselineWeight) / distance * 100));
    const cycleRecent=recent.filter((point)=>point.day>=settings.startDate);
    const qualifyingDays=cycleRecent.filter((point)=>direction==='loss'?point.value<=settings.targetWeight:direction==='gain'?point.value>=settings.targetWeight:false).length;
    progress = {
      direction, gapKg, progressPercent, referenceWeight,
      referencePoints: [{ day: settings.startDate, value: settings.baselineWeight }, { day: settings.deadline, value: settings.targetWeight }],
      remainingDays: Math.max(0, calendarDifference(settings.deadline, today)),
      status: achieved ? 'achieved' : settings.deadline < today ? 'ended' : average7 === null ? 'missing' : 'active',
      sustained:{requiredDays:7,recordedDays:cycleRecent.length,qualifyingDays,achieved:direction!=='maintain'&&cycleRecent.length===7&&qualifyingDays===7},
    };
  }
  return { today, timezone: HEALTH_TIMEZONE, settings: settings ? { ...settings } : null, observations, progress };
}
