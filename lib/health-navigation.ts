import { isCalendarDay, resolveDateRange, DATE_RANGE_CLIENT_SCRIPT } from './date-range.ts';

const HEALTH_VIEW_METRICS = [
  'steps', 'active_energy', 'workouts', 'sleep', 'heart_rate', 'resting_heart_rate', 'oxygen_saturation', 'weight', 'lean_body_mass', 'body_fat',
] as const;
export type HealthViewMetric = typeof HEALTH_VIEW_METRICS[number];
interface HealthViewRange { from?: string; to?: string; day?: string }
export interface HealthView extends HealthViewRange {
  metric: HealthViewMetric;
  days: number;
  rangeError?: string;
}

/** Filters and the day inspector are URL state, including on historical ranges. */
export function readHealthView(search: string, now = Date.now()): HealthView {
  const params = new URLSearchParams(search);
  const rawMetric = params.get('metric') as HealthViewMetric | null;
  const metric = rawMetric && HEALTH_VIEW_METRICS.includes(rawMetric) ? rawMetric : 'steps';
  const rawDays = params.get('days');
  const parsedDays = rawDays !== null && /^(7|30|90|180|360)$/.test(rawDays) ? Number(rawDays) : null;
  const fallback: HealthView = { metric, days: parsedDays ?? (['weight', 'lean_body_mass', 'body_fat'].includes(metric) ? 90 : 30) };
  const custom = params.has('from') || params.has('to');
  const day = params.get('day');
  const hasDay = params.getAll('day').length === 1 && isCalendarDay(day);
  if (!custom && !hasDay) return fallback;

  try {
    if (custom && ['from', 'to', 'days'].some(key => params.getAll(key).length > 1)) throw new Error('时间范围不能重复提交。');
    const range = resolveDateRange(custom ? {
      from: params.get('from') ?? undefined, to: params.get('to') ?? undefined,
      ...(params.has('days') ? { days: params.get('days') } : {}),
    } : { days: fallback.days }, now);
    const view = custom ? { metric, days: range.days, from: range.from, to: range.to } : fallback;
    return hasDay && day >= range.from && day <= range.to ? { ...view, day } : view;
  } catch (error) {
    return { ...fallback, rangeError: error instanceof Error ? error.message : '请选择有效日期。' };
  }
}

export function healthViewPath(metric: string, days: number, goals = false, range?: HealthViewRange): string {
  const params = new URLSearchParams(range?.from && range.to ? { metric, from: range.from, to: range.to } : { metric, days: String(days) });
  if (isCalendarDay(range?.day)) params.set('day', range.day);
  return '/health?' + params.toString() + (goals ? '#goals' : '');
}

/** Translate bookmarks from the previous Apple Health page to Health's shared view. */
export function readAppleActivityRedirect(search: string, now = Date.now()): string {
  const params = new URLSearchParams(search);
  const metric = params.get('metric');
  if (metric === null || !['heart_rate', 'resting_heart_rate', 'oxygen_saturation', 'workouts'].includes(metric)) {
    params.set('metric', 'heart_rate');
  }
  const view = readHealthView(params.toString(), now);
  return healthViewPath(view.metric, view.days, false, view);
}

/** Sync keeps its URL free of filters; restore only a complete, bounded history snapshot. */
export function readInitialHealthView(pathname: string, search: string, historyState: unknown, now = Date.now()): HealthView {
  const fallback = readHealthView(search, now);
  if (pathname !== '/sync' || historyState === null || typeof historyState !== 'object') return fallback;
  const stored = Object.getOwnPropertyDescriptor(historyState, 'healthView');
  if (!stored || !('value' in stored) || stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)) return fallback;
  if (Reflect.ownKeys(stored.value).some(key => !['metric', 'days', 'from', 'to', 'day'].includes(String(key)))) return fallback;

  const fields = Object.getOwnPropertyDescriptors(stored.value);
  const metric = fields.metric?.value, days = fields.days?.value;
  const from = fields.from?.value, to = fields.to?.value, day = fields.day?.value;
  if (typeof metric !== 'string' || typeof days !== 'number' || !Number.isSafeInteger(days)) return fallback;
  if ((fields.from || fields.to) && (typeof from !== 'string' || typeof to !== 'string')) return fallback;
  if (fields.day && !isCalendarDay(day)) return fallback;

  const view = readHealthView(healthViewPath(metric, days, false, { from, to, day }).slice('/health'.length), now);
  return !view.rangeError && view.metric === metric && view.days === days && view.day === day ? view : fallback;
}

/** Literal browser source avoids bundler-renamed references in function.toString(). */
export const HEALTH_NAVIGATION_SCRIPT = DATE_RANGE_CLIENT_SCRIPT + String.raw`
const HEALTH_VIEW_METRICS = ${JSON.stringify(HEALTH_VIEW_METRICS)};
function readHealthView(search, now = Date.now()) {
  const params = new URLSearchParams(search), rawMetric = params.get('metric');
  const metric = HEALTH_VIEW_METRICS.includes(rawMetric) ? rawMetric : 'steps';
  const rawDays = params.get('days');
  const parsedDays = rawDays !== null && /^(7|30|90|180|360)$/.test(rawDays) ? Number(rawDays) : null;
  const fallback = {metric, days: parsedDays ?? (['weight', 'lean_body_mass', 'body_fat'].includes(metric) ? 90 : 30)};
  const custom = params.has('from') || params.has('to');
  const day = params.get('day'), hasDay = params.getAll('day').length === 1 && isCalendarDay(day);
  if (!custom && !hasDay) return fallback;
  try {
    if (custom && ['from', 'to', 'days'].some(key => params.getAll(key).length > 1)) throw new Error('时间范围不能重复提交。');
    const range = resolveDateRange(custom ? {
      from: params.get('from') ?? undefined, to: params.get('to') ?? undefined,
      ...(params.has('days') ? {days: params.get('days')} : {}),
    } : {days: fallback.days}, now);
    const view = custom ? {metric, days: range.days, from: range.from, to: range.to} : fallback;
    return hasDay && day >= range.from && day <= range.to ? {...view, day} : view;
  } catch (error) { return {...fallback, rangeError: error.message || '请选择有效日期。'}; }
}
function healthViewPath(metric, days, goals = false, range) {
  const params = new URLSearchParams(range?.from && range.to ? {metric, from: range.from, to: range.to} : {metric, days: String(days)});
  if (isCalendarDay(range?.day)) params.set('day', range.day);
  return '/health?' + params.toString() + (goals ? '#goals' : '');
}
function readInitialHealthView(pathname, search, historyState, now = Date.now()) {
  const fallback = readHealthView(search, now);
  if (pathname !== '/sync' || historyState === null || typeof historyState !== 'object') return fallback;
  const stored = Object.getOwnPropertyDescriptor(historyState, 'healthView');
  if (!stored || !('value' in stored) || stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)) return fallback;
  if (Reflect.ownKeys(stored.value).some(key => !['metric', 'days', 'from', 'to', 'day'].includes(String(key)))) return fallback;
  const fields = Object.getOwnPropertyDescriptors(stored.value);
  const metric = fields.metric?.value, days = fields.days?.value;
  const from = fields.from?.value, to = fields.to?.value, day = fields.day?.value;
  if (typeof metric !== 'string' || typeof days !== 'number' || !Number.isSafeInteger(days)) return fallback;
  if ((fields.from || fields.to) && (typeof from !== 'string' || typeof to !== 'string')) return fallback;
  if (fields.day && !isCalendarDay(day)) return fallback;
  const view = readHealthView(healthViewPath(metric, days, false, {from, to, day}).slice('/health'.length), now);
  return !view.rangeError && view.metric === metric && view.days === days && view.day === day ? view : fallback;
}
`;
