import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthWeeklyFocus } from './health-weekly-focus.ts';
import { buildHealthWeeklyReview, parseHealthWeekQuery, type WeeklyReviewContext } from './health-weekly.ts';
import { emptyGoalSettings, type GoalSettings } from './health-goals.ts';
import type { HealthMeasurement } from './health.ts';
import type { NutritionEntry } from './nutrition.ts';

const NOW = new Date('2026-11-14T08:00:00Z');
const CURRENT = '2026-11-02';
const PREVIOUS = '2026-10-26';
type Metric = 'steps' | 'sleep' | 'active_energy';
function day(start: string, offset: number): string {
  return new Date(Date.parse(start + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}
function daily(metric: Metric, date: string, value: number): HealthMeasurement {
  return { id: metric + ':' + date, metric, value, aggregation: 'daily', source: 'synthetic-focus-source',
    unit: metric === 'sleep' ? 'hours' : metric === 'steps' ? 'count' : 'kcal',
    startDate: date + 'T00:00:00+08:00', endDate: date + 'T08:00:00+08:00' };
}
function rows(metric: Metric, current: number[], previous: number[] = []): HealthMeasurement[] {
  return [...current.map((value, index) => daily(metric, day(CURRENT, index), value)),
    ...previous.map((value, index) => daily(metric, day(PREVIOUS, index), value))];
}
function goals(targets: Partial<GoalSettings['targets']>): GoalSettings {
  return { targets: { steps: null, sleep: null, active_energy: null, ...targets }, updatedAt: null, effectiveFrom: '2026-10-01' };
}
function review(measurements: HealthMeasurement[] = [], settings = emptyGoalSettings(), context: WeeklyReviewContext = {}) {
  return buildHealthWeeklyReview(measurements, settings, parseHealthWeekQuery(new URLSearchParams({ week: CURRENT }), NOW), NOW, context);
}
function items(focus: ReturnType<typeof buildHealthWeeklyFocus>) {
  return [...(focus.primary ? [focus.primary] : []), ...focus.secondary];
}
function allText(focus: ReturnType<typeof buildHealthWeeklyFocus>) {
  return JSON.stringify(focus);
}

test('empty health data produces an honest recording priority with a concrete optional action', () => {
  const focus = buildHealthWeeklyFocus(review());
  assert.equal(focus.headline, '先补齐记录，再判断本周变化');
  assert.equal(focus.primary?.metric, 'coverage');
  assert.equal(focus.primary?.kind, 'data');
  assert.ok(focus.suggestedAction?.text.trim());
  assert.doesNotMatch(allText(focus), /健康恶化|睡眠不足|摄入不足|步数下降/);
});

test('a Monday preview does not mistake an unfinished day for a weekly shortfall', () => {
  const now = new Date('2026-11-09T02:00:00Z');
  const source = buildHealthWeeklyReview([daily('steps', '2026-11-09', 0), daily('sleep', '2026-11-09', 0)],
    goals({ steps: 8000, sleep: 7 }), parseHealthWeekQuery(new URLSearchParams(), now), now);
  const focus = buildHealthWeeklyFocus(source);
  assert.equal(focus.headline, '这周刚开始，先积累几天记录');
  assert.ok(items(focus).every(item => item.kind !== 'attention'));
});

test('substantial repeated shortfalls against the person’s daily sleep goal lead the review', () => {
  const focus = buildHealthWeeklyFocus(review([
    ...rows('sleep', [5, 5.5, 6, 7, 5]), ...rows('steps', [2000, 2000, 2000, 2000, 2000]),
  ], goals({ sleep: 7, steps: 8000 })));
  assert.equal(focus.primary?.metric, 'sleep');
  assert.equal(focus.primary?.kind, 'attention');
  assert.equal(focus.primary?.title, '先把睡眠时长补稳');
  assert.match(focus.primary.evidence, /目标/);
  assert.match(focus.primary.evidence, /日均5\.7小时.*目标7小时/);
  assert.ok(focus.suggestedAction?.text);
  assert.doesNotMatch(allText(focus), /失眠|诊断|睡眠质量差|由于|导致/);
});

test('minor misses do not become an attention headline merely because a target exists', () => {
  const focus = buildHealthWeeklyFocus(review([
    ...rows('sleep', [6.99, 6.99, 6.99, 6.99]),
    ...rows('steps', [7999, 7999, 7999, 7999]),
    ...rows('active_energy', [499, 499, 499, 499]),
  ], goals({ sleep: 7, steps: 8000, active_energy: 500 })));
  assert.ok(items(focus).every(item => item.kind !== 'attention'));
});

test('missing and unset-target dates never count as missed goals or inflate eligible days', () => {
  const settings: GoalSettings = { targets: { steps: null, sleep: 8, active_energy: null }, updatedAt: null,
    history: [
      { effectiveFrom: '1970-01-01', revision: 0, targets: { steps: null, sleep: null, active_energy: null }, createdAt: NOW.toISOString() },
      { effectiveFrom: day(CURRENT, 4), revision: 1, targets: { steps: null, sleep: 8, active_energy: null }, createdAt: NOW.toISOString() },
    ] };
  const records = [0, 1, 2, 4, 5].map(index => daily('sleep', day(CURRENT, index), 5));
  const focus = buildHealthWeeklyFocus(review(records, settings));
  assert.equal(items(focus).some(item => item.metric === 'sleep' && item.kind === 'attention'), false,
    'only two recorded dates had an effective sleep target');
});

test('later target changes do not rewrite the interpretation of historical target attainment', () => {
  const settings: GoalSettings = { targets: { steps: null, sleep: 10, active_energy: null }, updatedAt: NOW.toISOString(),
    history: [
      { effectiveFrom: '2026-10-01', revision: 0, targets: { steps: null, sleep: 6.5, active_energy: null }, createdAt: NOW.toISOString() },
      { effectiveFrom: '2026-11-10', revision: 1, targets: { steps: null, sleep: 10, active_energy: null }, createdAt: NOW.toISOString() },
    ] };
  const focus = buildHealthWeeklyFocus(review(rows('sleep', [7, 7, 7, 7, 7]), settings));
  assert.equal(items(focus).some(item => item.metric === 'sleep' && item.kind === 'attention'), false);
});

test('migration baselines and unknown or future goal dates cannot create historical goal attainment claims', () => {
  for (const effectiveFrom of [null, '1970-01-01', '2026-12-01', '2026-02-30']) {
    for (const value of [5, 8]) {
      const source = review(rows('sleep', [value, value, value, value]), { ...goals({ sleep: 7 }), effectiveFrom });
      const focus = buildHealthWeeklyFocus(source);
      assert.equal(items(focus).some(item => item.id.startsWith('sleep-goal-')), false);
      assert.match(focus.coverageNote, /生效日期不明|历史基线/);
    }
    const pairedSource = review(rows('sleep', [5, 5, 5, 5], [7, 7, 7, 7]), { ...goals({ sleep: 7 }), effectiveFrom });
    const paired = buildHealthWeeklyFocus(pairedSource);
    assert.equal(items(paired).some(item => item.id === 'sleep-paired-change' && item.kind === 'attention'), true);
  }
});

test('today does not create a third comparable day or a third eligible goal observation', () => {
  const now = new Date('2026-11-11T08:00:00Z');
  const source = buildHealthWeeklyReview([
    ...[0, 1, 2].map(index => daily('steps', day('2026-11-09', index), index === 2 ? 0 : 1000)),
    ...[0, 1, 2].map(index => daily('steps', day('2026-11-02', index), 10000)),
  ], goals({ steps: 8000 }), parseHealthWeekQuery(new URLSearchParams(), now), now);
  const focus = buildHealthWeeklyFocus(source);
  assert.equal(items(focus).some(item => item.metric === 'steps' && item.kind === 'attention'), false);
});

test('different recorded weekdays cannot turn a misleading aggregate delta into a trend conclusion', () => {
  const source = review([
    ...[3, 4, 5].map(index => daily('steps', day(CURRENT, index), 1000)),
    ...[0, 1, 2].map(index => daily('steps', day(PREVIOUS, index), 10000)),
  ]);
  assert.equal(source.metrics.find(metric => metric.metric === 'steps')?.delta, -9000);
  const focus = buildHealthWeeklyFocus(source);
  assert.equal(items(focus).some(item => item.metric === 'steps' && item.kind === 'attention'), false);
});

test('a substantial drop requires at least three same-weekday pairs and both relative and absolute thresholds', () => {
  const insufficient = buildHealthWeeklyFocus(review(rows('steps', [1000, 1000], [10000, 10000])));
  assert.equal(items(insufficient).some(item => item.metric === 'steps' && item.kind === 'attention'), false);
  const smallAbsolute = buildHealthWeeklyFocus(review(rows('steps', [1500, 1500, 1500], [2000, 2000, 2000])));
  assert.equal(items(smallAbsolute).some(item => item.metric === 'steps' && item.kind === 'attention'), false);
  const supported = buildHealthWeeklyFocus(review(rows('steps', [8000, 8000, 8000], [10000, 10000, 10000])));
  assert.ok(items(supported).some(item => item.metric === 'steps' && item.kind === 'attention'));
});

test('real zero readings remain evidence and are not silently replaced by missing values', () => {
  const focus = buildHealthWeeklyFocus(review(rows('steps', [0, 0, 0, 0]), goals({ steps: 8000 })));
  assert.equal(focus.primary?.metric, 'steps');
  assert.equal(focus.primary?.kind, 'attention');
});

test('steps and activity energy do not occupy two of the limited focus slots for the same activity story', () => {
  const focus = buildHealthWeeklyFocus(review([
    ...rows('steps', [2000, 2000, 2000, 2000], [10000, 10000, 10000, 10000]),
    ...rows('active_energy', [100, 100, 100, 100], [600, 600, 600, 600]),
  ], goals({ steps: 8000, active_energy: 500 })));
  assert.equal(items(focus).filter(item => item.metric === 'steps' || item.metric === 'active_energy').length, 1);
  assert.equal(focus.primary?.metric, 'steps');
});

test('increased sleep duration and a change in weight are described without inventing health improvement or fat loss', () => {
  const weight = (date: string, value: number): HealthMeasurement => ({ id: 'weight:' + date, metric: 'weight', value, unit: 'kg',
    aggregation: 'sample', source: 'synthetic-scale', startDate: date + 'T08:00:00+08:00' });
  const focus = buildHealthWeeklyFocus(review([
    ...rows('sleep', [8, 8, 8, 8], [5, 5, 5, 5]),
    ...[0, 1, 2, 3].flatMap(index => [weight(day(CURRENT, index), 68), weight(day(PREVIOUS, index), 70)]),
  ]));
  assert.ok(items(focus).filter(item => item.metric === 'weight' || item.metric === 'sleep').every(item => item.kind === 'data'));
  assert.equal(items(focus).some(item => item.id === 'steady-records'), false, 'an actual highlighted change cannot coexist with a no-change conclusion');
  assert.doesNotMatch(allText(focus), /减脂成功|体脂下降|睡眠质量改善|睡眠质量变好|健康改善/);
});

test('unavailable nutrition does not masquerade as zero days of food recording', () => {
  const source = review(rows('steps', [8000, 8000, 8000], [8000, 8000, 8000]), emptyGoalSettings(), {
    supplementalStatus: { nutrition: 'unavailable', weightPlan: 'ready', actions: 'ready' },
  });
  const focus = buildHealthWeeklyFocus(source);
  assert.doesNotMatch(allText(focus), /没有饮食记录|饮食未记录|饮食记录.*0\s*(?:天|\/)/);
  for (const item of items(focus).filter(item => item.metric === 'nutrition')) assert.match(item.evidence + item.interpretation, /不可用|未读取/);
});

test('known calorie subtotals and sparse meals cannot imply total intake, a deficit or excess', () => {
  const food = (caloriesTenth: number | null, index: number): NutritionEntry => ({ id: 'food:' + index, date: CURRENT,
    meal: 'lunch', name: 'synthetic meal', portion: '', note: '', caloriesTenth, revision: 1, deletedAt: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  const focus = buildHealthWeeklyFocus(review(rows('steps', [8000, 8000, 8000], [8000, 8000, 8000]), emptyGoalSettings(), {
    nutrition: [food(10, 1), food(null, 2), food(null, 3)],
  }));
  const claims = [focus.headline, focus.summary, focus.suggestedAction?.text,
    ...items(focus).flatMap(item => [item.title, item.evidence])].join(' ');
  assert.doesNotMatch(claims, /摄入不足|吃得太少|摄入过多|热量缺口|热量超标|少吃|多吃/);
  for (const item of items(focus).filter(item => item.metric === 'nutrition')) assert.match(item.interpretation, /不能|不判断/);
});

test('sufficient stable paired data has an honest quiet-week conclusion rather than a manufactured problem', () => {
  const focus = buildHealthWeeklyFocus(review([
    ...rows('steps', [8000, 8000, 8000, 8000], [8000, 8000, 8000, 8000]),
    ...rows('sleep', [7, 7, 7, 7], [7, 7, 7, 7]),
  ]));
  assert.ok(items(focus).every(item => item.kind !== 'attention'));
  assert.match(focus.headline + focus.summary, /不明显|无明显|没有明显|暂未|未见/);
});

test('focus selection is bounded, deterministic, immutable and links only to relevant same-site routes', () => {
  const source = review([
    ...rows('sleep', [5, 5, 5, 5], [7, 7, 7, 7]),
    ...rows('steps', [1000, 1000, 1000, 1000], [10000, 10000, 10000, 10000]),
    ...rows('active_energy', [100, 100, 100, 100], [600, 600, 600, 600]),
  ], goals({ sleep: 7, steps: 8000, active_energy: 500 }));
  const original = structuredClone(source);
  const focus = buildHealthWeeklyFocus(source);
  assert.deepEqual(buildHealthWeeklyFocus(source), focus);
  assert.deepEqual(source, original);
  assert.ok(items(focus).length > 0 && items(focus).length <= 3);
  assert.equal(new Set(items(focus).map(item => item.id)).size, items(focus).length);
  for (const item of items(focus)) {
    const url = new URL(item.href, 'https://synthetic.example');
    assert.equal(url.origin, 'https://synthetic.example');
    assert.ok(['/health', '/health/nutrition', '/health/weight-plan', '/health/records', '/sync'].includes(url.pathname));
    assert.ok(item.title.trim() && item.evidence.trim() && item.interpretation.trim() && item.linkLabel.trim());
  }
});
