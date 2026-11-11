export interface HealthView {
  metric: 'steps' | 'sleep' | 'active_energy' | 'weight' | 'lean_body_mass' | 'body_fat';
  days: number;
}

/** Filters are URL state, so refresh and browser history restore the same view. */
export function readHealthView(search: string): HealthView {
  const params = new URLSearchParams(search);
  const metrics = ['steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass', 'body_fat'];
  const rawMetric = params.get('metric');
  const metric = metrics.includes(rawMetric ?? '') ? rawMetric! : 'steps';
  const rawDays = params.get('days');
  const parsedDays = rawDays !== null && /^(7|30|90|180|360)$/.test(rawDays) ? Number(rawDays) : null;
  return { metric: metric as HealthView['metric'], days: parsedDays ?? (['weight', 'lean_body_mass', 'body_fat'].includes(metric) ? 90 : 30) };
}

export function healthViewPath(metric: string, days: number, goals = false): string {
  const params = new URLSearchParams({ metric, days: String(days) });
  return '/health?' + params.toString() + (goals ? '#goals' : '');
}

/** Sync keeps its URL free of filters; only restore a valid, bounded history snapshot. */
export function readInitialHealthView(pathname: string, search: string, historyState: unknown): HealthView {
  const fallback = readHealthView(search);
  if (pathname !== '/sync' || historyState === null || typeof historyState !== 'object') return fallback;
  const stored = Object.getOwnPropertyDescriptor(historyState, 'healthView');
  if (!stored || !('value' in stored) || stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)) return fallback;
  const keys = Reflect.ownKeys(stored.value);
  if (keys.length !== 2 || keys.some((key) => key !== 'metric' && key !== 'days')) return fallback;
  const metric = Object.getOwnPropertyDescriptor(stored.value, 'metric');
  const days = Object.getOwnPropertyDescriptor(stored.value, 'days');
  if (!metric || !('value' in metric) || typeof metric.value !== 'string'
    || !days || !('value' in days) || typeof days.value !== 'number' || !Number.isSafeInteger(days.value)) return fallback;
  const view = readHealthView(new URLSearchParams({ metric: metric.value, days: String(days.value) }).toString());
  return view.metric === metric.value && view.days === days.value ? view : fallback;
}
