import { buildHealthSummary, HEALTH_TIMEZONE, METRIC_INFO, measurementDay, normalizeTimestamp, shanghaiDay } from './health.ts';
import type { HealthMeasurement, HealthMetric, HealthUnit, SleepStages } from './health.ts';
import { summarizeNutrition } from './nutrition.ts';
import type { NutritionDayStatus, NutritionEntry, NutritionMeal, NutritionMealStatus } from './nutrition.ts';
import { nutritionDayCompleteness } from './nutrition-review.ts';
import { NUTRIENT_KEYS, summarizeNutrients, type NutritionNutrients } from './nutrition-nutrients.ts';
import { ASSISTANT_METRICS, parseAssistantScope } from './health-assistant-scope.ts';
import type { AssistantDays, AssistantScope } from './health-assistant-scope.ts';

export const MAX_HEALTH_ASSISTANT_CONTEXT_BYTES = 50 * 1024;

export interface HealthAssistantRange { days: AssistantDays; from: string; to: string; today: string }
export interface HealthAssistantPoint { date: string; value: number; sourceRef: string; sleepStages?: SleepStages; from?: string; to?: string; recordedDays?: number; aggregation?: 'last-recorded-day' | 'available-days-mean' }
export interface HealthAssistantMetric {
  metric: HealthMetric; label: string; unit: HealthUnit; recordedDays: number; points: HealthAssistantPoint[];
}
export interface HealthAssistantNutritionDay {
  date: string; entryCount: number; knownCalorieCount: number; unknownCalorieCount: number;
  recordedKnownKcal: string | null; sourceRef: string; from?: string; to?: string; recordedDays?: number; aggregation?: 'available-days-total';
  complete?: boolean; meals?: Record<NutritionMeal,NutritionMealStatus>; completeDays?: number; comparableDays?: number; comparableKnownKcal?: string | null;
  nutrients: NutritionNutrients;
  nutrientComparisons?: Record<(typeof NUTRIENT_KEYS)[number], { comparableDays: number; total: string | null; average: string | null }>;
}
/** This is the only object intended for the model provider. */
export interface HealthAssistantContext {
  version: 1;
  timezone: typeof HEALTH_TIMEZONE;
  range: HealthAssistantRange;
  health: HealthAssistantMetric[];
  nutrition: { recordedDays: number; days: HealthAssistantNutritionDay[]; completeDays?: number; comparableDays?: number };
  scope: AssistantScope;
  goals?: { label: string; targets: Array<{ metric: string; value: number; effectiveFrom: string | null }>; nutritionTargets?: Array<{ nutrient: (typeof NUTRIENT_KEYS)[number]; value: string; unit: 'kcal' | 'g' }>; weightPlan: { baselineWeight: number; targetWeight: number; startDate: string; deadline: string } | null; notes: string[] };
  limitations: string[];
}
/** Local citations may contain source labels; never include this table in a model request. */
export interface HealthAssistantSource {
  id: string; label: string; url: string; from: string; to: string; recordedDays: number; sources: string[]; dates?: string[];
}
export interface HealthAssistantContextResult {
  context: HealthAssistantContext;
  sources: HealthAssistantSource[];
  hasData: boolean;
}
export interface HealthAssistantContextInput {
  measurements: readonly HealthMeasurement[];
  nutrition: readonly NutritionEntry[];
  nutritionStatuses?: readonly NutritionDayStatus[];
  days: AssistantDays;
  now: number;
  scope?: AssistantScope;
  goals?: { targets: { steps: number | null; sleep: number | null; active_energy: number | null }; effectiveFrom?: string | null };
  nutritionGoals?: Partial<Record<(typeof NUTRIENT_KEYS)[number], string | null>> | null;
  weightPlan?: { enabled: boolean; baselineWeight: number; targetWeight: number; startDate: string; deadline: string } | null;
}
export class HealthAssistantContextError extends Error {
  readonly code: 'INVALID_HEALTH_ASSISTANT_CONTEXT' | 'HEALTH_ASSISTANT_CONTEXT_TOO_LARGE';
  constructor(message: string, code: 'INVALID_HEALTH_ASSISTANT_CONTEXT' | 'HEALTH_ASSISTANT_CONTEXT_TOO_LARGE' = 'INVALID_HEALTH_ASSISTANT_CONTEXT') {
    super(message);
    this.name = 'HealthAssistantContextError';
    this.code = code;
  }
}

const metrics = ASSISTANT_METRICS;
const sourceIds: Record<HealthMetric, string> = { weight: 'H1', lean_body_mass: 'H2', steps: 'H3', active_energy: 'H4', sleep: 'H5' };
const stageKeys = ['unspecified', 'core', 'deep', 'rem', 'awake', 'inBed'] as const;
const tolerance = 1e-8;

export function assistantRange(days: AssistantDays, now: number): HealthAssistantRange {
  if (![7, 30, 90, 180, 360].includes(days) || !Number.isFinite(now)) {
    throw new HealthAssistantContextError('健康助手支持最近7、30、90、180或360天，请使用有效的当前时间。');
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
  const scope = parseAssistantScope(input.scope);
  const eligible = input.measurements.filter((row) => scope.metrics.includes(row.metric)).map((row) => eligibleMeasurement(row, range, input.now))
    .filter((row): row is HealthMeasurement => row !== null);
  const summary = buildHealthSummary(eligible);
  const sources: HealthAssistantSource[] = [];
  const width = input.days > 180 ? 14 : input.days > 30 ? 7 : 1;
  const groupKey = (date: string) => Math.floor((Date.parse(date + 'T12:00:00Z') - Date.parse(range.from + 'T12:00:00Z')) / (width * 86400000));
  const health = metrics.filter((metric) => scope.metrics.includes(metric)).map((metric): HealthAssistantMetric => {
    const definition = METRIC_INFO[metric];
    const points = summary.metrics[metric].points;
    const groups = new Map<number, typeof points>();
    for (const point of points) { const key = groupKey(point.day); groups.set(key, [...(groups.get(key) ?? []), point]); }
    return { metric, label: definition.label, unit: definition.unit, recordedDays: points.length,
      points: [...groups.values()].map((rows) => {
        const first = rows[0].day, last = rows.at(-1)!.day;
        const sourceRef = sourceIds[metric] + '-' + first.replaceAll('-', '');
        const sample = metric === 'weight' || metric === 'lean_body_mass';
        sources.push({ id: sourceRef, label: definition.label + (width === 1 ? ' · ' + first : '分组记录'),
          url: '/health/records?' + new URLSearchParams({ metric, from: first, to: last }), from: first, to: last, recordedDays: rows.length,
          dates: rows.map((r) => r.day), sources: [...new Set(rows.map((r) => r.source).filter((r): r is string => typeof r === 'string' && !!r))].sort() });
        return { date: last, value: width === 1 || sample ? rows.at(-1)!.value : Number((rows.reduce((sum,r) => sum + r.value,0) / rows.length).toFixed(4)), sourceRef,
          ...(width > 1 ? { from:first, to:last, recordedDays:rows.length, aggregation:sample ? 'last-recorded-day' as const : 'available-days-mean' as const } : {}),
          ...(width === 1 && metric === 'sleep' && rows[0].sleepStages ? { sleepStages:rows[0].sleepStages } : {}) };
      }) };
  });
  const nutrition = (scope.includeNutrition ? input.nutrition : []).filter((entry) => entry && entry.deletedAt === null
    && typeof entry.date === 'string' && entry.date >= range.from && entry.date <= range.to
    && entry.date.length === 10 && normalizeTimestamp(entry.date + 'T12:00:00+08:00'));
  if (nutrition.some((entry) => entry.caloriesTenth !== null && (!Number.isSafeInteger(entry.caloriesTenth) || entry.caloriesTenth < 0 || entry.caloriesTenth > 200000))) {
    throw new HealthAssistantContextError('部分饮食热量记录无效，请先核对饮食记录后重试。');
  }
  for (const key of ['carbsTenth','proteinTenth','fatTenth'] as const) if (nutrition.some((entry) => entry[key] !== undefined && entry[key] !== null
    && (!Number.isSafeInteger(entry[key]) || entry[key]! < 0 || entry[key]! > 200000))) {
    throw new HealthAssistantContextError('部分饮食营养素记录无效，请先核对饮食记录后重试。');
  }
  const nutritionStatuses = (scope.includeNutrition ? input.nutritionStatuses : undefined)?.filter((status) => status && typeof status.date === 'string'
    && status.date >= range.from && status.date <= range.to && status.date.length === 10 && normalizeTimestamp(status.date+'T12:00:00+08:00'));
  const statusByDate = new Map(nutritionStatuses?.map((status) => [status.date,status]) ?? []);
  const recordedNutritionDates = [...new Set(nutrition.map((entry) => entry.date))];
  const nutritionDates = [...new Set([...recordedNutritionDates,...(nutritionStatuses ?? []).filter((status) => status.complete === true || Object.values(status.meals ?? {}).includes('skipped')).map((status)=>status.date)])].sort();
  const dailyNutrition = new Map(nutritionDates.map((date) => {const rows=nutrition.filter((entry)=>entry.date===date);return [date,{rows,summary:summarizeNutrition(rows),nutrients:summarizeNutrients(rows),...nutritionDayCompleteness(rows,statusByDate.get(date))}];}));
  const nutritionGroups = new Map<number,string[]>();
  for (const date of nutritionDates) { const key = groupKey(date); nutritionGroups.set(key,[...(nutritionGroups.get(key) ?? []),date]); }
  const nutritionDays = [...nutritionGroups.values()].map((dates): HealthAssistantNutritionDay => {
    const day = summarizeNutrition(nutrition.filter((entry) => dates.includes(entry.date)));
    const first=dates[0],last=dates.at(-1)!,sourceRef='N1-'+first.replaceAll('-','');
    const days=dates.map((date)=>dailyNutrition.get(date)!);
    const recordedDays=days.filter((date)=>date.summary.entryCount>0).length;
    const comparable=days.filter((date)=>date.complete && date.summary.entryCount>0 && date.summary.unknownCount===0);
    const comparableTenth=comparable.reduce((sum,date)=>sum+date.rows.reduce((subtotal,entry)=>subtotal+BigInt(entry.caloriesTenth ?? 0),BigInt(0)),BigInt(0));
    const comparableKnownKcal=comparable.length ? (comparableTenth / BigInt(10)).toString()+'.'+(comparableTenth % BigInt(10)).toString() : null;
    const nutrients=summarizeNutrients(days.flatMap((day)=>day.rows));
    const nutrientComparisons=Object.fromEntries(NUTRIENT_KEYS.map((key)=>{
      const eligibleDays=days.filter((day)=>day.complete&&day.summary.entryCount>0&&day.nutrients[key].unknownCount===0);
      const tenth=eligibleDays.reduce((sum,day)=>sum+BigInt(day.nutrients[key].total!.replace('.','')),BigInt(0));
      const count=BigInt(eligibleDays.length),format=(value:bigint)=>{const digits=value.toString().padStart(2,'0');return digits.slice(0,-1)+'.'+digits.slice(-1);};
      return [key,{comparableDays:eligibleDays.length,total:eligibleDays.length?format(tenth):null,average:eligibleDays.length?format((tenth+count/BigInt(2))/count):null}];
    })) as NonNullable<HealthAssistantNutritionDay['nutrientComparisons']>;
    sources.push({id:sourceRef,label:'饮食记录 · '+first+(last!==first?' — '+last:''),url:'/health/nutrition?'+new URLSearchParams({date:first}),from:first,to:last,recordedDays,dates,sources:['饮食记录']});
    return { date:last,entryCount:day.entryCount,knownCalorieCount:day.knownCount,unknownCalorieCount:day.unknownCount,recordedKnownKcal:day.knownCalories,sourceRef,nutrients,
      ...(width>1&&nutritionStatuses?{nutrientComparisons}:{}),
      ...(width > 1 ? {from:first,to:last,recordedDays,aggregation:'available-days-total' as const,...(nutritionStatuses ? {completeDays:days.filter((date)=>date.complete).length,comparableDays:comparable.length,comparableKnownKcal} : {})} : nutritionStatuses ? {complete:days[0].complete,meals:days[0].meals} : {}) };
  });
  const targets = scope.includeGoals && input.goals ? Object.entries(input.goals.targets).filter(([metric,value]) => scope.metrics.includes(metric as HealthMetric) && typeof value === 'number' && Number.isFinite(value) && value > 0)
    .map(([metric,value]) => ({metric,value:value as number,effectiveFrom:input.goals?.effectiveFrom === '1970-01-01' ? null : input.goals?.effectiveFrom ?? null})) : [];
  const plan = scope.includeGoals && scope.metrics.includes('weight') ? input.weightPlan : null;
  const activePlan = plan?.enabled && plan.startDate <= range.today && plan.deadline >= range.today ? {baselineWeight:plan.baselineWeight,targetWeight:plan.targetWeight,startDate:plan.startDate,deadline:plan.deadline} : null;
  const nutritionTargets=scope.includeGoals&&scope.includeNutrition&&input.nutritionGoals?NUTRIENT_KEYS.flatMap((nutrient)=>{
    const value=input.nutritionGoals?.[nutrient];return typeof value==='string'&&/^\d+(?:\.\d)?$/.test(value)&&Number(value)>=0&&Number(value)<=20000?[{nutrient,value,unit:nutrient==='calories'?'kcal' as const:'g' as const}]:[];
  }):[];
  const context: HealthAssistantContext = {
    version: 1, timezone: HEALTH_TIMEZONE, range, health, scope,
    ...(scope.includeGoals ? {goals:{label:'用户自定目标（非医学建议）',targets,...(scope.includeNutrition?{nutritionTargets}:{}),weightPlan:activePlan,notes:[...(!targets.length ? ['未设置所选健康指标目标。'] : []),...(nutritionTargets.length?['饮食目标仅代表当前设置，历史日期是否适用未知，不能据此判定历史每日达标。']:[]),...(input.goals?.effectiveFrom === '1970-01-01' ? ['目标使用历史／恢复基线，实际设置日期未知；不能解释为1970年设置。'] : []),...(plan && !activePlan ? ['体重计划尚未生效、已过期或已停用，本次不提供计划数值。'] : [])]}} : {}),
    nutrition: { recordedDays: recordedNutritionDates.length, days: nutritionDays, ...(nutritionStatuses ? {completeDays:[...dailyNutrition.values()].filter((day)=>day.complete).length,comparableDays:[...dailyNutrition.values()].filter((day)=>day.complete && day.summary.entryCount>0 && day.summary.unknownCount===0).length} : {}) },
    limitations: [
      '数据为选定日期范围内的有效日汇总；缺失日期不补0，也不以前值填充。',
      ...(width > 1 ? ['本次长期范围按连续'+width+'日分组：步数、活动能量、睡眠为有记录日期的均值，体重与去脂体重为组内最后记录；饮食为组内已记录合计。分组不是完整周，不能推测组内单日数值。长期范围不提供分期细节。'] : []),
      '体重与去脂体重分别采用各日最后一次记录，未作为同次测量配对，不据此计算体脂率。',
      '睡眠归属于窗口结束的上海日期；清醒、卧床单列，不加入睡眠时长。缺失或与总时长矛盾的分期不提供。',
      '今日尚未结束，当日步数、活动能量、睡眠及饮食记录可能不完整，不能当作完整一天评价。',
      '饮食热量只汇总已记录且已填写热量的食物，并非全天真实总摄入；未知热量不按0计算，未记录不能解释为未进食。',
      'nutrients 分别给出已记录热量（kcal）及碳水化合物、蛋白质、脂肪（g）的合计和逐项已知／未知数量；某项缺失不能用其他营养素推算或补0。',
      '当天记完和未进食是用户标记的记录状态，不保证实际份量、热量或全天摄入准确；比较日均值时仅使用已记完且食物热量无缺失的日期，并说明天数。',
      ...(width > 1 && nutritionStatuses ? ['长期饮食分组另提供completeDays、comparableDays和comparableKnownKcal；仅comparableKnownKcal除以comparableDays可作为完整已记录日的均值，不能用整组合计或完整天数替代可比较天数。分组不代表每天完整。'] : []),
      ...(width > 1 && nutritionStatuses ? ['营养素 nutrientComparisons 按字段分别筛选已记完且该项无缺失的记录日；不同营养素可比较天数可能不同，只用各自的average和comparableDays评价。'] : []),
      '活动能量仅表示活动消耗，不是全天总能量消耗，不能直接与已记录摄入相减计算热量缺口。',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > MAX_HEALTH_ASSISTANT_CONTEXT_BYTES) {
    throw new HealthAssistantContextError('健康助手上下文超过50KB，请减少共享指标或缩短日期范围后重试。', 'HEALTH_ASSISTANT_CONTEXT_TOO_LARGE');
  }
  return { context, sources, hasData: health.some((metric) => metric.recordedDays > 0) || nutritionDays.length > 0 };
}
