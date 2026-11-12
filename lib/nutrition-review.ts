import { NUTRITION_MEALS, NutritionValidationError, parseNutritionQuery, summarizeNutrition } from './nutrition.ts';
import type { NutritionDayStatus, NutritionEntry, NutritionMeal, NutritionMealStatus } from './nutrition.ts';
import { NUTRIENT_KEYS, summarizeNutrients, type NutritionNutrients } from './nutrition-nutrients.ts';

export interface NutritionInsightRange { from: string; to: string; days: 7 | 30 }
export interface NutritionInsightDay {
  date: string;
  knownCalories: string | null;
  entryCount: number;
  unknownCount: number;
  knownCount: number;
  complete: boolean;
  meals: Record<NutritionMeal, NutritionMealStatus>;
  nutrients: NutritionNutrients;
}
export interface NutritionInsight {
  range: NutritionInsightRange;
  days: NutritionInsightDay[];
  summary: {
    recordedDays: number; completeDays: number; comparableDays: number;
    knownCalories: string | null; averageCompleteKcal: string | null; unknownCount: number;
    nutrients: NutritionNutrients;
    nutrientAverages: Record<string, { average: string | null; comparableDays: number }>;
  };
  meals: Array<{ meal: NutritionMeal; label: string; knownCalories: string | null; entryCount: number; nutrients: NutritionNutrients }>;
  limitations: string[];
}

const mealKeys = Object.keys(NUTRITION_MEALS) as NutritionMeal[];
const shift = (date: string, offset: number) => new Date(Date.parse(date + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

function invalid(message: string): never {
  throw new NutritionValidationError([{ path: 'range', message }]);
}

export function parseNutritionInsightQuery(params: URLSearchParams, now: Date | number = Date.now()): NutritionInsightRange {
  if ([...params.keys()].some((key) => !['date', 'days'].includes(key))
    || ['date', 'days'].some((key) => params.getAll(key).length > 1)) invalid('请选择一个有效的日期与回顾范围。');
  const days = params.get('days') ?? '7';
  if (days !== '7' && days !== '30') invalid('饮食回顾仅支持最近 7 天或 30 天。');
  const selection = parseNutritionQuery(params, now);
  const first = shift(selection.date, -(Number(days) - 1));
  return { from: first < '1970-01-01' ? '1970-01-01' : first, to: selection.date, days: Number(days) as 7 | 30 };
}

/** A saved completion label is reconciled with the current, effective records. */
export function nutritionDayCompleteness(entries: readonly NutritionEntry[], status?: NutritionDayStatus) {
  const active = entries.filter((entry) => entry.deletedAt === null);
  const meals = Object.fromEntries(mealKeys.map((meal) => [meal,
    active.some((entry) => entry.meal === meal) ? 'recorded' : status?.meals?.[meal] === 'skipped' ? 'skipped' : 'unrecorded',
  ])) as Record<NutritionMeal, NutritionMealStatus>;
  const complete = status?.complete === true && (['breakfast', 'lunch', 'dinner'] as const).every((meal) => meals[meal] !== 'unrecorded');
  return { complete, meals };
}

function decimal(tenth: bigint) {
  const value = tenth.toString().padStart(2, '0');
  return value.slice(0, -1) + '.' + value.slice(-1);
}

/** Repository inputs must already be scoped to the signed-in owner. */
export function buildNutritionInsight(entries: readonly NutritionEntry[], statuses: readonly NutritionDayStatus[], range: NutritionInsightRange): NutritionInsight {
  const selected = entries.filter((entry) => entry.deletedAt === null && entry.date >= range.from && entry.date <= range.to);
  if (selected.some((entry) => entry.caloriesTenth !== null && (!Number.isSafeInteger(entry.caloriesTenth) || entry.caloriesTenth < 0 || entry.caloriesTenth > 200000))) {
    throw new Error('Invalid stored nutrition calories');
  }
  const saved = new Map(statuses.filter((status) => status.date >= range.from && status.date <= range.to).map((status) => [status.date, status]));
  const count = Math.round((Date.parse(range.to + 'T12:00:00Z') - Date.parse(range.from + 'T12:00:00Z')) / 86400000) + 1;
  if (!Number.isInteger(count) || count < 1 || count > 30) invalid('饮食回顾日期范围无效。');
  const days = Array.from({ length: count }, (_, index): NutritionInsightDay => {
    const date = shift(range.from, index);
    const rows = selected.filter((entry) => entry.date === date);
    const summary = summarizeNutrition(rows);
    return { date, knownCalories: summary.knownCalories, entryCount: summary.entryCount,
      unknownCount: summary.unknownCount, knownCount: summary.knownCount, nutrients: summary.nutrients, ...nutritionDayCompleteness(rows, saved.get(date)) };
  });
  const summary = summarizeNutrition(selected);
  const comparable = days.filter((day) => day.complete && day.entryCount > 0 && day.unknownCount === 0);
  const comparableTotal = comparable.reduce((sum, day) => sum + BigInt(day.knownCalories!.replace('.', '')), BigInt(0));
  const divisor = BigInt(comparable.length);
  const nutrientAverages = Object.fromEntries(NUTRIENT_KEYS.map((key) => {
    const observed = days.filter((day) => day.complete && day.entryCount > 0 && day.nutrients[key].unknownCount === 0 && day.nutrients[key].total !== null);
    const sum = observed.reduce((value, day) => value + BigInt(day.nutrients[key].total!.replace('.', '')), BigInt(0));
    const n = BigInt(observed.length);
    return [key, { average: observed.length ? decimal((sum + n / BigInt(2)) / n) : null, comparableDays: observed.length }];
  }));
  return {
    range, days,
    summary: { recordedDays: days.filter((day) => day.entryCount > 0).length, completeDays: days.filter((day) => day.complete).length,
      comparableDays: comparable.length, knownCalories: summary.knownCalories,
      averageCompleteKcal: comparable.length ? decimal((comparableTotal + divisor / BigInt(2)) / divisor) : null, unknownCount: summary.unknownCount,
      nutrients: summarizeNutrients(selected), nutrientAverages },
    meals: summary.meals.map(({ meal, label, knownCalories, entryCount, nutrients }) => ({ meal, label, knownCalories, entryCount, nutrients })),
    limitations: [
      '热量仅合计已记录且填写热量的食物，不代表实际全天总摄入；未知热量和未记录日期不按 0 计算。',
      '完整日均值仅包含已标记当天记完、至少有一项食物且全部热量已填写的日期；请同时查看可比较天数。',
      '当天记完与未进食由用户标记，表示记录状态，不保证份量、热量或全天摄入准确。',
      '日期按北京时间统计。活动能量不是全天总消耗，不能直接与已记录摄入相减计算热量缺口。',
    ],
  };
}
