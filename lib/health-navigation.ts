import { resolveDateRange, DATE_RANGE_CLIENT_SCRIPT } from './date-range.ts';
export interface HealthView {
  metric: 'steps' | 'sleep' | 'active_energy' | 'weight' | 'lean_body_mass' | 'body_fat';
  days: number;
  from?: string;
  to?: string;
  rangeError?: string;
}

/** Filters are URL state, so refresh and browser history restore the same view. */
export function readHealthView(search: string): HealthView {
  const params = new URLSearchParams(search);
  const metrics = ['steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass', 'body_fat'];
  const rawMetric = params.get('metric');
  const metric = metrics.includes(rawMetric ?? '') ? rawMetric! : 'steps';
  const rawDays = params.get('days');
  const parsedDays = rawDays !== null && /^(7|30|90|180|360)$/.test(rawDays) ? Number(rawDays) : null;
  const fallback = { metric: metric as HealthView['metric'], days: parsedDays ?? (['weight', 'lean_body_mass', 'body_fat'].includes(metric) ? 90 : 30) };
  if (params.has('from') || params.has('to')) {
    try {
      if (['from','to','days'].some((key) => params.getAll(key).length > 1)) throw new Error('时间范围不能重复提交。');
      const range = resolveDateRange({from:params.get('from') ?? undefined,to:params.get('to') ?? undefined,...(params.has('days')?{days:params.get('days')}: {})});
      return { metric:fallback.metric,days:range.days,from:range.from,to:range.to };
    } catch (error) { return {...fallback,rangeError:error instanceof Error?error.message:'请选择有效日期。'}; }
  }
  return fallback;
}

export function healthViewPath(metric: string, days: number, goals = false, range?: {from?:string;to?:string}): string {
  const params = new URLSearchParams(range?.from&&range.to?{metric,from:range.from,to:range.to}:{ metric, days: String(days) });
  return '/health?' + params.toString() + (goals ? '#goals' : '');
}

/** Sync keeps its URL free of filters; only restore a valid, bounded history snapshot. */
export function readInitialHealthView(pathname: string, search: string, historyState: unknown): HealthView {
  const fallback = readHealthView(search);
  if (pathname !== '/sync' || historyState === null || typeof historyState !== 'object') return fallback;
  const stored = Object.getOwnPropertyDescriptor(historyState, 'healthView');
  if (!stored || !('value' in stored) || stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)) return fallback;
  const keys = Reflect.ownKeys(stored.value);
  if (![2,4].includes(keys.length) || keys.some((key) => !['metric','days','from','to'].includes(String(key)))) return fallback;
  const metric = Object.getOwnPropertyDescriptor(stored.value, 'metric');
  const days = Object.getOwnPropertyDescriptor(stored.value, 'days');
  if (!metric || !('value' in metric) || typeof metric.value !== 'string'
    || !days || !('value' in days) || typeof days.value !== 'number' || !Number.isSafeInteger(days.value)) return fallback;
  const from=Object.getOwnPropertyDescriptor(stored.value,'from'),to=Object.getOwnPropertyDescriptor(stored.value,'to');
  if(keys.length===4&&(!from||!('value'in from)||typeof from.value!=='string'||!to||!('value'in to)||typeof to.value!=='string'))return fallback;
  const view = readHealthView(new URLSearchParams(keys.length===4?{metric:metric.value,from:from!.value,to:to!.value}:{ metric: metric.value, days: String(days.value) }).toString());
  return !view.rangeError && view.metric === metric.value && view.days === days.value ? view : fallback;
}

/**
 * Literal browser source: function.toString() cannot preserve references to
 * sibling helpers after the server bundler renames those helpers.
 */
export const HEALTH_NAVIGATION_SCRIPT = DATE_RANGE_CLIENT_SCRIPT + String.raw`
function readHealthView(search){const params=new URLSearchParams(search);const metrics=['steps','sleep','active_energy','weight','lean_body_mass','body_fat'];const rawMetric=params.get('metric');const metric=metrics.includes(rawMetric??'')?rawMetric:'steps';const rawDays=params.get('days');const parsedDays=rawDays!==null&&/^(7|30|90|180|360)$/.test(rawDays)?Number(rawDays):null;const fallback={metric,days:parsedDays??(['weight','lean_body_mass','body_fat'].includes(metric)?90:30)};if(params.has('from')||params.has('to')){try{if(['from','to','days'].some((key)=>params.getAll(key).length>1))throw new Error('时间范围不能重复提交。');const range=resolveDateRange({from:params.get('from')??undefined,to:params.get('to')??undefined,...(params.has('days')?{days:params.get('days')}:{})});return {metric,days:range.days,from:range.from,to:range.to};}catch(error){return {...fallback,rangeError:error.message||'请选择有效日期。'};}}return fallback;}
function healthViewPath(metric,days,goals=false,range){const params=new URLSearchParams(range?.from&&range.to?{metric,from:range.from,to:range.to}:{metric,days:String(days)});return '/health?'+params.toString()+(goals?'#goals':'');}
function readInitialHealthView(pathname,search,historyState){const fallback=readHealthView(search);if(pathname!=='/sync'||historyState===null||typeof historyState!=='object')return fallback;const stored=Object.getOwnPropertyDescriptor(historyState,'healthView');if(!stored||!('value' in stored)||stored.value===null||typeof stored.value!=='object'||Array.isArray(stored.value))return fallback;const keys=Reflect.ownKeys(stored.value);if(![2,4].includes(keys.length)||keys.some((key)=>!['metric','days','from','to'].includes(String(key))))return fallback;const metric=Object.getOwnPropertyDescriptor(stored.value,'metric'),days=Object.getOwnPropertyDescriptor(stored.value,'days');if(!metric||!('value' in metric)||typeof metric.value!=='string'||!days||!('value' in days)||typeof days.value!=='number'||!Number.isSafeInteger(days.value))return fallback;const from=Object.getOwnPropertyDescriptor(stored.value,'from'),to=Object.getOwnPropertyDescriptor(stored.value,'to');if(keys.length===4&&(!from||!('value'in from)||typeof from.value!=='string'||!to||!('value'in to)||typeof to.value!=='string'))return fallback;const view=readHealthView(new URLSearchParams(keys.length===4?{metric:metric.value,from:from.value,to:to.value}:{metric:metric.value,days:String(days.value)}).toString());return !view.rangeError&&view.metric===metric.value&&view.days===days.value?view:fallback;}
`;
