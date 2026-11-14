import type { HealthWeeklyReview, WeeklyMetric, WeeklyMetricReview, WeeklyPoint } from './health-weekly.ts';

export interface WeeklyFocusItem {
  id: string;
  kind: 'attention' | 'positive' | 'data';
  metric: WeeklyMetric | 'nutrition' | 'coverage';
  title: string;
  evidence: string;
  interpretation: string;
  href: string;
  linkLabel: string;
}
export interface HealthWeeklyFocus {
  headline: string;
  summary: string;
  coverageNote: string;
  primary: WeeklyFocusItem | null;
  secondary: WeeklyFocusItem[];
  suggestedAction: { text: string; label: string } | null;
}

type Candidate = WeeklyFocusItem & { priority: number; action: string };
type GoalMetric = Exclude<WeeklyMetric, 'weight'>;
const LABELS = { sleep: '睡眠时长', steps: '步数', active_energy: '活动能量', weight: '体重' };
const UNITS = { sleep: '小时', steps: '步', active_energy: '千卡', weight: 'kg' };
const CHANGE_FLOORS = { sleep: 0.5, steps: 1000, active_energy: 100, weight: 0.5 };
const GOAL_PRIORITY = { sleep: 100, steps: 85, active_energy: 75 };
const CHANGE_PRIORITY = { sleep: 95, steps: 80, active_energy: 70, weight: 35 };
const ACTIONS = {
  sleep: '下周选3天，在计划睡觉前留出30分钟做睡前准备，并记录次日睡眠时长。',
  steps: '在身体情况允许时，下周选3天饭后走动10分钟，并记录当天步数。',
  active_energy: '在身体情况允许时，下周选3天安排一次轻松活动，并记录当天活动量。',
  weight: '下周选3天，在相近时间和条件下测量体重，周末再看连续记录。',
  coverage: '下周至少3天同步步数和睡眠记录，周末再回顾一次。',
  nutrition: '下周选3天把当天各餐记录完整，未知热量先保留待核对。',
};

function dayBefore(day: string, offset: number): string {
  return new Date(Date.parse(day + 'T12:00:00Z') - offset * 86400000).toISOString().slice(0, 10);
}
function shortDay(day: string): string { return Number(day.slice(5, 7)) + '/' + Number(day.slice(8, 10)); }
function amount(value: number, metric: WeeklyMetric): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: metric === 'steps' ? 0 : metric === 'weight' ? 2 : 1 });
}
function measured(point: WeeklyPoint): point is WeeklyPoint & { value: number } {
  return typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0;
}
function closed(point: WeeklyPoint, review: HealthWeeklyReview): boolean {
  return point.day >= review.weekStart && point.day <= review.cutoffDay && point.day < review.today;
}
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function metricLink(review: HealthWeeklyReview, metric: WeeklyMetric): string {
  return '/health?' + new URLSearchParams({ metric, from: review.weekStart, to: review.cutoffDay });
}
function item(candidate: Candidate): WeeklyFocusItem {
  const { priority: _priority, action: _action, ...view } = candidate;
  return view;
}
function knownGoalDate(point: WeeklyPoint): boolean {
  const day = point.targetEffectiveFrom;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day <= '1970-01-01' || day > point.day) return false;
  const instant = Date.parse(day + 'T12:00:00Z');
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === day;
}
function goalRows(metric: WeeklyMetricReview, review: HealthWeeklyReview) {
  return metric.currentPoints.filter((point): point is WeeklyPoint & { value: number; target: number } =>
    closed(point, review) && measured(point) && knownGoalDate(point)
    && typeof point.target === 'number' && Number.isFinite(point.target) && point.target > 0);
}
function matchedRows(metric: WeeklyMetricReview, review: HealthWeeklyReview) {
  const previous = new Map(metric.previousPoints.filter(measured).map(point => [point.day, point.value]));
  return metric.currentPoints.filter(point => closed(point, review) && measured(point))
    .flatMap(point => {
      const before = previous.get(dayBefore(point.day, 7));
      return before === undefined ? [] : [{ day: point.day, current: point.value as number, previous: before }];
    });
}
function activity(metric: WeeklyFocusItem['metric']): boolean { return metric === 'steps' || metric === 'active_energy'; }

/** Inspectable prioritisation of observed records, not a medical score or causal explanation. */
export function buildHealthWeeklyFocus(review: HealthWeeklyReview): HealthWeeklyFocus {
  const metrics = new Map(review.metrics.map(metric => [metric.metric, metric]));
  const endedDays = Array.from({ length: review.comparisonDays }, (_, index) => dayBefore(review.weekStart, -index))
    .filter(day => day <= review.cutoffDay && day < review.today).length;
  const counts = (key: WeeklyMetric) => metrics.get(key)?.currentPoints.filter(point => closed(point, review) && measured(point)).length ?? 0;
  const hasUncertainGoals = review.metrics.some(metric => metric.currentPoints.some(point => closed(point, review) && measured(point)
    && typeof point.target === 'number' && point.target > 0 && !knownGoalDate(point)));
  const coverageNote = (review.isCurrent
    ? '本周进行中，重点只看已结束的 ' + endedDays + ' 天；今天的记录不用于判断未达目标或周变化。'
    : '按所选周已结束的 ' + endedDays + ' 天回顾。')
    + '周变化至少使用3个相同星期位置的配对记录日；缺失不算0。'
    + (hasUncertainGoals ? '历史基线或生效日期不明的目标只保留在详细数据，不用于判断当时是否达成。' : '');
  const candidates: Candidate[] = [];
  for (const key of ['sleep', 'steps', 'active_energy'] as const) {
    const metric = metrics.get(key);
    if (!metric) continue;
    const rows = goalRows(metric, review), missed = rows.filter(point => point.value < point.target);
    if (rows.length >= 3) {
      const averageGap = missed.length ? mean(missed.map(point => point.target - point.value)) : 0;
      const relativeGap = missed.length ? averageGap / mean(missed.map(point => point.target)) : 0;
      const meaningful = averageGap + 1e-9 >= CHANGE_FLOORS[key] && (key === 'sleep' || relativeGap + 1e-9 >= 0.2);
      const changedTargets = new Set(rows.map(point => point.target)).size > 1;
      const basis = changedTargets ? '本周目标有调整，已逐日按当时目标核对。' : '这里比较的是你设置的目标，并非医学标准。';
      const targetMinimum = Math.min(...rows.map(point => point.target)), targetMaximum = Math.max(...rows.map(point => point.target));
      const baseline = '有目标的记录日均' + amount(mean(rows.map(point => point.value)), key) + UNITS[key]
        + '，当日目标' + amount(targetMinimum, key) + (targetMaximum === targetMinimum ? '' : '–' + amount(targetMaximum, key)) + UNITS[key] + '。';
      if (missed.length >= 2 && missed.length / rows.length >= 0.5 && meaningful) {
        const dates = missed.slice(0, 3).map(point => shortDay(point.day)).join('、') + (missed.length > 3 ? '等' : '');
        candidates.push({ id: key + '-goal-gap', kind: 'attention', metric: key,
          title: key === 'sleep' ? '先把睡眠时长补稳' : key === 'steps' ? '先让步数更接近自己的目标' : '活动量与自己的目标还有距离',
          evidence: baseline + rows.length + '个可核对日期中，' + missed.length + '天未达到目标（' + dates + '）；未达日平均少' + amount(averageGap, key) + UNITS[key] + '。',
          interpretation: basis + (key === 'sleep' ? '时长不能代表睡眠质量，也不能据此确认原因。' : '可先选择适合自己的活动安排，无需为了补数值突然增加运动。'),
          href: metricLink(review, key), linkLabel: '查看' + LABELS[key] + '记录', priority: GOAL_PRIORITY[key], action: ACTIONS[key] });
      } else if (rows.length - missed.length >= 3 && (rows.length - missed.length) / rows.length >= 0.8) {
        candidates.push({ id: key + '-goal-kept', kind: 'positive', metric: key,
          title: (key === 'sleep' ? '睡眠时长' : LABELS[key]) + '目标多数日期有做到',
          evidence: baseline + rows.length + '个可核对日期中，' + (rows.length - missed.length) + '天达到了当日目标。',
          interpretation: basis + '值得保持适合自己的节奏；数值越大不等于健康越好。',
          href: metricLink(review, key), linkLabel: '查看目标与记录', priority: key === 'sleep' ? 55 : key === 'steps' ? 50 : 45,
          action: '延续当前适合自己的' + (key === 'sleep' ? '作息' : '活动') + '节奏，下周继续记录至少3天。' });
      }
    }
  }
  for (const key of ['sleep', 'steps', 'active_energy', 'weight'] as const) {
    const metric = metrics.get(key);
    if (!metric) continue;
    const pairs = matchedRows(metric, review);
    if (pairs.length < 3) continue;
    const current = mean(pairs.map(point => point.current)), previous = mean(pairs.map(point => point.previous));
    const delta = current - previous, absolute = Math.abs(delta);
    if (absolute + 1e-9 < CHANGE_FLOORS[key] || ((key === 'steps' || key === 'active_energy') && previous > 0 && absolute / previous + 1e-9 < 0.2)) continue;
    const decreasing = delta < 0;
    // More sleep/energy/steps and a lower weight are not intrinsically healthier.
    // Raw changes remain neutral unless a drop merits looking at the records.
    const kind = key === 'weight' || !decreasing ? 'data' : 'attention';
    const standout = [...pairs].sort((a, b) => Math.abs(b.current - b.previous) - Math.abs(a.current - a.previous))[0]!;
    candidates.push({ id: key + '-paired-change', kind, metric: key,
      title: LABELS[key] + '比上周同期' + (decreasing ? '少了' : '增加了') + amount(absolute, key) + UNITS[key],
      evidence: pairs.length + '个同星期配对日，记录日均由' + amount(previous, key) + '变为' + amount(current, key) + UNITS[key] + '；其中' + shortDay(standout.day) + '的差值最大。',
      interpretation: key === 'weight' ? '这只是配对日期的体重记录变化，不能据此判断体脂变化或计划成败。'
        : key === 'sleep' ? '只说明记录里的睡眠时长变化，不能代表睡眠质量，也不能确认原因。'
          : '只说明配对日期的活动记录变化，不能据此判断体能；不需要追求数值无限增加。',
      href: metricLink(review, key), linkLabel: '查看变化出现的日期', priority: kind === 'attention' ? CHANGE_PRIORITY[key] : key === 'weight' ? 35 : 40,
      action: decreasing || key === 'weight' ? ACTIONS[key] : '下周在相同星期继续记录' + LABELS[key] + '，周末核对变化是否仍然存在。' });
  }

  const pairCounts = ['sleep', 'steps', 'active_energy', 'weight'].map(key => metrics.get(key as WeeklyMetric))
    .map(metric => metric ? matchedRows(metric, review).length : 0);
  const noHealthRecords = ['sleep', 'steps', 'active_energy', 'weight'].every(key => counts(key as WeeklyMetric) === 0);
  const insufficient = noHealthRecords || Math.max(...pairCounts) < 3;
  if (insufficient) {
    candidates.push({ id: 'record-coverage', kind: 'data', metric: 'coverage',
      title: endedDays === 0 ? '这周刚开始，先积累几天记录' : '先补齐记录，再判断本周变化',
      evidence: endedDays === 0 ? '本周还没有已结束的日期；今天的记录可在详细数据中查看。'
        : '已结束的' + endedDays + '天中，步数记录' + counts('steps') + '天、睡眠记录' + counts('sleep') + '天；目前最多只有' + Math.max(...pairCounts) + '个同星期配对日。',
      interpretation: '暂时不能从不同日期的日均差值判断变好或变差。本周记录也会成为下周的比较基线。',
      href: '/sync', linkLabel: '查看同步与补记录入口', priority: noHealthRecords ? 65 : 25, action: ACTIONS.coverage });
  }
  if (review.supplementalStatus.nutrition === 'ready' && endedDays >= 3) {
    const points = review.nutrition.current.points.filter(point => point.day < review.today && point.day <= review.cutoffDay);
    const recorded = points.filter(point => point.entryCount > 0).length;
    const unknown = points.reduce((sum, point) => sum + point.unknownCount, 0);
    const entries = points.reduce((sum, point) => sum + point.entryCount, 0);
    if (entries > 0 && (recorded < Math.min(3, endedDays) || unknown >= 2 && unknown / entries >= 0.5)) {
      candidates.push({ id: 'nutrition-coverage', kind: 'data', metric: 'nutrition', title: '饮食先记完整，再看营养',
        evidence: '已结束的' + endedDays + '天中，' + recorded + '天有饮食记录，共' + entries + '条食物；其中' + unknown + '条热量待补充。',
        interpretation: '有记录不代表全天已记全；已知热量小计不能用来判断摄入过多、过少或能量缺口。',
        href: '/health/nutrition', linkLabel: '核对饮食记录', priority: 30, action: ACTIONS.nutrition });
    }
  }
  if (!insufficient && !candidates.some(candidate => candidate.kind === 'attention' || candidate.kind === 'positive' || candidate.id.endsWith('-paired-change'))) {
    const comparable = (['sleep', 'steps', 'active_energy', 'weight'] as const).filter(key => { const metric = metrics.get(key); return metric && matchedRows(metric, review).length >= 3; });
    const evidence = comparable.flatMap(key => {
      const metric = metrics.get(key), pairs = metric ? matchedRows(metric, review) : [];
      if (pairs.length < 3) return [];
      const delta = mean(pairs.map(point => point.current - point.previous));
      return [LABELS[key] + '有' + pairs.length + '个配对日，平均差值' + (delta > 0 ? '+' : '') + amount(delta, key) + UNITS[key]];
    });
    if (evidence.length) candidates.push({ id: 'steady-records', kind: 'data', metric: 'coverage', title: '可比记录暂未出现明显变化',
      evidence: evidence.join('；') + '。', interpretation: '这些差值没有达到本回顾的重点提示幅度；这不等于对健康状况作出评价。',
      href: metricLink(review, comparable[0]!),
      linkLabel: '查看每日记录', priority: 20, action: '保持当前适合自己的记录节奏，下周在相同星期继续记录，周末再比较一次。' });
  }
  candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (selected.some(existing => existing.metric === candidate.metric || activity(existing.metric) && activity(candidate.metric))) continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  const primary = selected[0];
  return {
    headline: primary?.title ?? '这周暂时没有足够依据提炼重点',
    summary: primary ? primary.evidence : '继续积累相同日期的记录，再看变化；不把缺失当作0，也不凑出健康结论。',
    coverageNote, primary: primary ? item(primary) : null, secondary: selected.slice(1).map(item),
    suggestedAction: primary ? { text: primary.action, label: '用作下周行动' } : null,
  };
}
