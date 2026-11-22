import type { AppleVitalDay } from './apple-health-activity.ts';
import { shiftWeekDay } from './health-weekly-actions.ts';
import type { HealthWeekSelection } from './health-weekly.ts';

export interface AppleActivityRange { from: string; to: string }
export interface AppleWorkoutSummary { count: number; durationSeconds: number }
export interface AppleActivityDaily {
  vitals: readonly AppleVitalDay[];
  workouts: readonly (AppleWorkoutSummary & { day: string })[];
}

type VitalReading = { value: number; measuredAt: string };
type CoveredAverage = { average: number; days: number };
type ActivityUnavailable = { status: 'unavailable' };

type ReadyToday = AppleActivityRange & {
  status: 'ready';
  today: string;
  restingHeartRate: VitalReading | null;
  oxygenSaturation: VitalReading | null;
  workouts: AppleWorkoutSummary | null;
};
export type HomeAppleActivity = ReadyToday | ActivityUnavailable;

export interface WeeklyAppleActivityPeriod extends AppleActivityRange {
  heartRate: CoveredAverage | null;
  restingHeartRate: CoveredAverage | null;
  oxygenSaturation: { days: number; samples: number } | null;
  workouts: AppleWorkoutSummary | null;
}

type ReadyWeekly = {
  status: 'ready';
  current: WeeklyAppleActivityPeriod | null;
  previous: WeeklyAppleActivityPeriod | null;
  today: WeeklyAppleActivityPeriod | null;
};
export type WeeklyAppleActivity = ReadyWeekly | ActivityUnavailable;

export function homeAppleActivityRange(today: string): AppleActivityRange {
  return { from: shiftWeekDay(today, -6), to: today };
}

export function buildHomeAppleActivity(data: AppleActivityDaily, range: AppleActivityRange): ReadyToday {
  let restingHeartRate: VitalReading | null = null;
  let oxygenSaturation: VitalReading | null = null;
  for (const day of data.vitals) {
    if (day.day < range.from || day.day > range.to) continue;
    const resting = day.restingHeartRate;
    const oxygen = day.oxygenSaturation;
    if (resting && (!restingHeartRate || resting.measuredAt > restingHeartRate.measuredAt)) restingHeartRate = resting;
    if (oxygen && (!oxygenSaturation || oxygen.measuredAt > oxygenSaturation.measuredAt)) {
      oxygenSaturation = { value: oxygen.latest, measuredAt: oxygen.measuredAt };
    }
  }
  const today = range.to;
  const workouts = data.workouts.find(entry => entry.day === today);
  return { status: 'ready', ...range, today, restingHeartRate, oxygenSaturation,
    workouts: workouts ? { count: workouts.count, durationSeconds: workouts.durationSeconds } : null };
}

function coveredAverage(values: number[]): CoveredAverage | null {
  return values.length ? { average: values.reduce((total, value) => total + value, 0) / values.length, days: values.length } : null;
}

function summarizePeriod(data: AppleActivityDaily, from: string, to: string): WeeklyAppleActivityPeriod {
  const rates: number[] = [];
  const restingRates: number[] = [];
  let oxygenDays = 0;
  let oxygenSamples = 0;
  for (const day of data.vitals) {
    if (day.day < from || day.day > to) continue;
    if (day.heartRate) rates.push(day.heartRate.average);
    if (day.restingHeartRate) restingRates.push(day.restingHeartRate.value);
    if (day.oxygenSaturation) {
      oxygenDays++;
      oxygenSamples += day.oxygenSaturation.count;
    }
  }
  const workouts = { count: 0, durationSeconds: 0 };
  for (const day of data.workouts) {
    if (day.day < from || day.day > to) continue;
    workouts.count += day.count;
    workouts.durationSeconds += day.durationSeconds;
  }
  // Missing days never enter an average. Each observed daily aggregate has
  // weight one because the ordinary heart-rate records have no sample count.
  return { from, to, heartRate: coveredAverage(rates), restingHeartRate: coveredAverage(restingRates),
    oxygenSaturation: oxygenDays ? { days: oxygenDays, samples: oxygenSamples } : null,
    workouts: workouts.count ? workouts : null };
}

export function buildWeeklyAppleActivity(data: AppleActivityDaily, selection: HealthWeekSelection): ReadyWeekly {
  const completedDays = selection.comparisonDays - (selection.isCurrent ? 1 : 0);
  const period = (start: string) => summarizePeriod(data, start, shiftWeekDay(start, completedDays - 1));
  return { status: 'ready', current: completedDays ? period(selection.weekStart) : null,
    previous: completedDays ? period(selection.previousStart) : null,
    today: selection.isCurrent ? summarizePeriod(data, selection.today, selection.today) : null };
}
