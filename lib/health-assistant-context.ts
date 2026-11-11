import { buildHealthSummary, HEALTH_TIMEZONE, METRIC_INFO, measurementDay, normalizeTimestamp, shanghaiDay } from './health.ts';
import type { HealthMeasurement, HealthMetric, HealthUnit, SleepStages } from './health.ts';
import { summarizeNutrition } from './nutrition.ts';
import type { NutritionEntry } from './nutrition.ts';

export const MAX_HEALTH_ASSISTANT_CONTEXT_BYTES = 50 * 1024;

export interface HealthAssistantRange { days: 7 | 30; from: string; to: string; today: string }
export interface HealthAssistantPoint { date: string; value: number; sourceRef: string; sleepStages?: SleepStages }
export interface HealthAssistantMetric {
  metric: HealthMetric; label: string; unit: HealthUnit; recordedDays: number; points: HealthAssistantPoint[];
}
export interface HealthAssistantNutritionDay {
  date: string; entryCount: number; knownCalorieCount: number; unknownCalorieCount: number;
  recordedKnownKcal: string | null; sourceRef: 'N1';
}
/** This is the only object intended for the model provider. */
export interface HealthAssistantContext {
  version: 1;
  timezone: typeof HEALTH_TIMEZONE;
  range: HealthAssistantRange;
  health: HealthAssistantMetric[];
  nutrition: { recordedDays: number; days: HealthAssistantNutritionDay[] };
  limitations: string[];
}
/** Local citations may contain source labels; never include this table in a model request. */
export interface HealthAssistantSource {
  id: string; label: string; url: string; from: string; to: string; recordedDays: number; sources: string[];
}
export interface HealthAssistantContextResult {
  context: HealthAssistantContext;
  sources: HealthAssistantSource[];
  hasData: boolean;
}
export interface HealthAssistantContextInput {
  measurements: readonly HealthMeasurement[];
  nutrition: readonly NutritionEntry[];
  days: 7 | 30;
  now: number;
}
export class HealthAssistantContextError extends Error {
  readonly code: 'INVALID_HEALTH_ASSISTANT_CONTEXT' | 'HEALTH_ASSISTANT_CONTEXT_TOO_LARGE';
  constructor(message: string, code: 'INVALID_HEALTH_ASSISTANT_CONTEXT' | 'HEALTH_ASSISTANT_CONTEXT_TOO_LARGE' = 'INVALID_HEALTH_ASSISTANT_CONTEXT') {
    super(message);
    this.name = 'HealthAssistantContextError';
    this.code = code;
  }
}

const metrics: readonly HealthMetric[] = ['weight', 'lean_body_mass', 'steps', 'active_energy', 'sleep'];
const sourceIds: Record<HealthMetric, string> = { weight: 'H1', lean_body_mass: 'H2', steps: 'H3', active_energy: 'H4', sleep: 'H5' };
const stageKeys = ['unspecified', 'core', 'deep', 'rem', 'awake', 'inBed'] as const;
const tolerance = 1e-8;

export function assistantRange(days: 7 | 30, now: number): HealthAssistantRange {
  if ((days !== 7 && days !== 30) || !Number.isFinite(now)) {
    throw new HealthAssistantContextError('健康助手仅支持最近7天或30天，请使用有效的当前时间。');
  }
  let today: string;
  try { today = shanghaiDay(new Date(now).toISOString()); }
  catch { throw new HealthAssistantContextError('健康助手的当前日期不在支持范围内。'); }
  const from = new Date(Date.parse(today + 'T12:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { days, from, to: today, today };
}

function checkedStages(raw: unknown, total: number, windowHours: number): SleepStages | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const supplied = raw as Record<string, unknown>;
  const result = {} as SleepStages;
  for (const key of stageKeys) {
    const value = supplied[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 24 || value > windowHours + tolerance) return undefined;
    result[key] = value;
  }
  const asleep = result.unspecified + result.core + result.deep + result.rem;
  return Math.abs(asleep - total) <= tolerance && asleep <= windowHours + tolerance ? result : undefined;
}

function eligibleMeasurement(row: HealthMeasurement, range: HealthAssistantRange, now: number): HealthMeasurement | null {
  if (!row || typeof row.metric !== 'string' || !Object.hasOwn(METRIC_INFO, row.metric)) return null;
  const definition = METRIC_INFO[row.metric];
  if (!Number.isFinite(row.value) || row.value < definition.minimum || row.value > definition.maximum || row.unit !== definition.unit
    || (row.metric === 'steps' && !Number.isInteger(row.value))) return null;
  const startDate = normalizeTimestamp(row.startDate);
  if (!startDate || Date.parse(startDate) > now) return null;
  const sample = row.metric === 'weight' || row.metric === 'lean_body_mass';
  const endDate = sample ? undefined : normalizeTimestamp(row.endDate);
  if (!sample && (!endDate || Date.parse(endDate) > now || Date.parse(endDate) <= Date.parse(startDate))) return null;
  // Whitelist before aggregation: neither arbitrary added fields nor original
  // sample timestamps/identifiers are copied into the provider context.
  const measurement: HealthMeasurement = {
    id: row.id, metric: row.metric, value: row.value, unit: definition.unit, startDate,
    ...(endDate ? { endDate } : {}),
    ...(typeof row.source === 'string' ? { source: row.source } : {}),
    aggregation: sample ? 'sample' : 'daily',
  };
  const day = measurementDay(measurement);
  if (day < range.from || day > range.to) return null;
  if (row.metric === 'sleep' && endDate) {
    const stages = checkedStages(row.sleepStages, row.value, (Date.parse(endDate) - Date.parse(startDate)) / 3600000);
    if (stages) measurement.sleepStages = stages;
  }
  return measurement;
}

/**
 * Inputs must already be scoped to the authenticated user by the repository.
 * Effective measurements incorporate corrections and omit hidden records;
 * this pure projection cannot authorize ownership from untrusted client data.
 */
export function buildHealthAssistantContext(input: HealthAssistantContextInput): HealthAssistantContextResult {
  const range = assistantRange(input.days, input.now);
  const eligible = input.measurements.map((row) => eligibleMeasurement(row, range, input.now))
    .filter((row): row is HealthMeasurement => row !== null);
  const summary = buildHealthSummary(eligible);
  const sources: HealthAssistantSource[] = [];
  const health = metrics.map((metric): HealthAssistantMetric => {
    const definition = METRIC_INFO[metric];
    const points = summary.metrics[metric].points;
    const sourceRef = sourceIds[metric];
    if (points.length) {
      sources.push({
        id: sourceRef, label: definition.label + '记录',
        url: '/health/records?' + new URLSearchParams({ metric, from: range.from, to: range.to }),
        from: range.from, to: range.to, recordedDays: points.length,
        sources: [...new Set(points.map((point) => point.source).filter((source): source is string => typeof source === 'string' && source.length > 0))].sort(),
      });
    }
    return {
      metric, label: definition.label, unit: definition.unit, recordedDays: points.length,
      points: points.map((point) => ({ date: point.day, value: point.value, sourceRef,
        ...(metric === 'sleep' && point.sleepStages ? { sleepStages: point.sleepStages } : {}),
      })),
    };
  });

  const nutrition = input.nutrition.filter((entry) => entry && entry.deletedAt === null
    && typeof entry.date === 'string' && entry.date >= range.from && entry.date <= range.to
    && entry.date.length === 10 && normalizeTimestamp(entry.date + 'T12:00:00+08:00'));
  if (nutrition.some((entry) => entry.caloriesTenth !== null && (!Number.isSafeInteger(entry.caloriesTenth) || entry.caloriesTenth < 0 || entry.caloriesTenth > 200000))) {
    throw new HealthAssistantContextError('部分饮食热量记录无效，请先核对饮食记录后重试。');
  }
  const nutritionDates = [...new Set(nutrition.map((entry) => entry.date))].sort();
  const nutritionDays = nutritionDates.map((date): HealthAssistantNutritionDay => {
    const day = summarizeNutrition(nutrition.filter((entry) => entry.date === date));
    return { date, entryCount: day.entryCount, knownCalorieCount: day.knownCount, unknownCalorieCount: day.unknownCount,
      recordedKnownKcal: day.knownCalories, sourceRef: 'N1' };
  });
  if (nutritionDays.length) sources.push({
    id: 'N1', label: '饮食记录', url: '/health/nutrition?' + new URLSearchParams({ date: nutritionDates.at(-1)! }),
    from: range.from, to: range.to, recordedDays: nutritionDays.length, sources: ['手工饮食记录'],
  });

  const context: HealthAssistantContext = {
    version: 1, timezone: HEALTH_TIMEZONE, range, health,
    nutrition: { recordedDays: nutritionDays.length, days: nutritionDays },
    limitations: [
      '数据为选定日期范围内的有效日汇总；缺失日期不补0，也不以前值填充。',
      '体重与去脂体重分别采用各日最后一次记录，未作为同次测量配对，不据此计算体脂率。',
      '睡眠归属于窗口结束的上海日期；清醒、卧床单列，不加入睡眠时长。缺失或与总时长矛盾的分期不提供。',
      '今日尚未结束，当日步数、活动能量、睡眠及饮食记录可能不完整，不能当作完整一天评价。',
      '饮食热量只汇总已记录且已填写热量的食物，并非全天真实总摄入；未知热量不按0计算，未记录不能解释为未进食。',
      '活动能量仅表示活动消耗，不是全天总能量消耗，不能直接与已记录摄入相减计算热量缺口。',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > MAX_HEALTH_ASSISTANT_CONTEXT_BYTES) {
    throw new HealthAssistantContextError('健康助手上下文超过50KB，请切换最近7天后重试。', 'HEALTH_ASSISTANT_CONTEXT_TOO_LARGE');
  }
  return { context, sources, hasData: health.some((metric) => metric.recordedDays > 0) || nutritionDays.length > 0 };
}
