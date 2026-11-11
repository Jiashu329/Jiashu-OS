import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthSummary } from './health.ts';
import type { HealthMeasurement, HealthSummary } from './health.ts';
import { buildGoalProgress, emptyGoalSettings, GoalValidationError, parseGoalUpdateInput, parseGoalSettingsInput } from './health-goals.ts';
import type { GoalMetric, GoalSettings, GoalTargets } from './health-goals.ts';

const NOW = '2026-11-09T08:00:00.000Z';
const targets: GoalTargets = { steps: 8000, sleep: 7.5, active_energy: 500 };
function settings(patch: Partial<GoalTargets> = {}): GoalSettings {
  return { targets: { ...targets, ...patch }, updatedAt: NOW };
}
function daily(metric: GoalMetric, day: string, value: number): HealthMeasurement {
  return {
    id: metric + ':' + day, metric, value, aggregation: 'daily',
    unit: metric === 'steps' ? 'count' : metric === 'sleep' ? 'hours' : 'kcal',
    startDate: day + 'T00:00:00+08:00', endDate: day + 'T08:00:00+08:00', source: 'synthetic-source',
  };
}
function summary(records: HealthMeasurement[] = []): HealthSummary { return buildHealthSummary(records); }

void test('new users have no invented targets and every metric has an unset 30-day calendar', () => {
  const defaults = emptyGoalSettings();
  assert.deepEqual(defaults, { targets: { steps: null, sleep: null, active_energy: null }, updatedAt: null, revision:0,effectiveFrom:null,history:[] });
  const independent = emptyGoalSettings();
  independent.targets.steps = 1000;
  assert.equal(emptyGoalSettings().targets.steps, null, 'defaults must not share mutable targets');
  const result = buildGoalProgress(emptyGoalSettings(), summary([daily('steps', '2026-11-09', 0)]), NOW);
  assert.deepEqual(result.metrics.map((metric) => [metric.metric, metric.label, metric.unit]), [
    ['steps', '步数', '步'], ['sleep', '睡眠', '小时'], ['active_energy', '活动能量', '千卡'],
  ]);
  for (const metric of result.metrics) {
    assert.equal(metric.days.length, 30);
    assert.equal(metric.days[0].day, '2026-10-11');
    assert.equal(metric.current.day, '2026-11-09');
    assert.ok(metric.days.every((day) => day.status === 'unset' && day.percent === null));
    assert.equal(metric.achievedDays, 0);
  }
  assert.equal(result.metrics[0].recordedDays, 1);
  assert.equal(result.metrics[0].current.value, 0);
});

void test('zero readings remain observations while missing days never become misses', () => {
  const progress = buildGoalProgress(settings(), summary([
    daily('steps', '2026-11-07', 0), daily('steps', '2026-11-09', 0),
    daily('sleep', '2026-11-08', 8),
  ]), NOW);
  const steps = progress.metrics[0];
  assert.deepEqual(steps.days.find((day) => day.day === '2026-11-07'), { day: '2026-11-07', value: 0, status: 'missed', percent: 0,target:8000,targetEffectiveFrom:null });
  assert.deepEqual(steps.days.find((day) => day.day === '2026-11-08'), { day: '2026-11-08', value: null, status: 'missing', percent: null,target:8000,targetEffectiveFrom:null });
  assert.deepEqual(steps.current, { day: '2026-11-09', value: 0, status: 'in-progress', percent: 0,target:8000,targetEffectiveFrom:null });
  assert.equal(steps.recordedDays, 2);
  assert.equal(steps.achievedDays, 0);
  assert.equal(progress.metrics[1].achievedDays, 1);
  assert.equal(progress.metrics[1].current.status, 'missing');
});

void test('thresholds and percentages use one resolved daily total and cap achievements at 100 percent', () => {
  const progress = buildGoalProgress(settings(), summary([
    daily('steps', '2026-11-07', 16000), daily('steps', '2026-11-08', 8000),
    daily('steps', '2026-11-09', 2000), daily('steps', '2026-11-09', 4000),
    daily('active_energy', '2026-11-09', 500), daily('sleep', '2026-11-09', 7.5),
  ]), NOW);
  assert.equal(progress.metrics[0].current.value, 4000, 'resolved points must not be added together');
  assert.equal(progress.metrics[0].current.percent, 50);
  assert.equal(progress.metrics[0].current.status, 'in-progress');
  assert.equal(progress.metrics[0].achievedDays, 2);
  assert.equal(progress.metrics[0].recordedDays, 3);
  assert.equal(progress.metrics[0].days.find((day) => day.day === '2026-11-07')!.percent, 100);
  assert.equal(progress.metrics[1].current.status, 'achieved');
  assert.equal(progress.metrics[2].current.status, 'achieved');
});

void test('the current goal recalculates history without changing observations, and cancelling keeps raw values', () => {
  const data = summary([daily('steps', '2026-11-08', 6000)]);
  const before = structuredClone(data);
  const high = buildGoalProgress(settings(), data, NOW).metrics[0];
  const low = buildGoalProgress(settings({ steps: 5000 }), data, NOW).metrics[0];
  const unset = buildGoalProgress(settings({ steps: null }), data, NOW).metrics[0];
  assert.equal(high.achievedDays, 0);
  assert.equal(low.achievedDays, 1);
  assert.equal(low.recordedDays, 1);
  assert.equal(unset.achievedDays, 0);
  assert.equal(unset.recordedDays, 1);
  assert.equal(unset.days.find((day) => day.day === '2026-11-08')!.value, 6000);
  assert.ok(unset.days.every((day) => day.status === 'unset' && day.percent === null));
  assert.deepEqual(data, before);
});

void test('Shanghai midnight rolls today and the 30-day window across leap-month and year boundaries', () => {
  const before = buildGoalProgress(settings(), summary(), '2026-11-09T15:59:59Z');
  const after = buildGoalProgress(settings(), summary(), '2026-11-09T16:00:00Z');
  assert.equal(before.today, '2026-11-09');
  assert.equal(after.today, '2026-11-10');
  assert.equal(after.timezone, 'Asia/Shanghai');
  assert.equal(after.metrics[0].days[0].day, '2026-10-12');
  const leap = buildGoalProgress(settings(), summary(), '2024-03-01T00:00:00+08:00');
  assert.equal(leap.metrics[0].days[0].day, '2024-02-01');
  assert.equal(leap.metrics[0].days[28].day, '2024-02-29');
  const year = buildGoalProgress(settings(), summary(), '2027-01-01T00:00:00+08:00');
  assert.equal(year.metrics[0].days[0].day, '2026-12-03');
});

void test('future measurements and days outside the reporting window do not influence progress', () => {
  const input = summary([
    daily('steps', '2026-10-10', 8000), daily('steps', '2026-10-11', 8000),
    daily('steps', '2026-11-10', 8000),
    { ...daily('sleep', '2026-11-09', 8), endDate: '2026-11-09T23:00:00+08:00' },
  ]);
  const result = buildGoalProgress(settings(), input, NOW);
  assert.equal(result.metrics[0].recordedDays, 1);
  assert.equal(result.metrics[0].achievedDays, 1);
  assert.equal(result.metrics[0].current.value, null);
  assert.equal(result.metrics[1].current.value, null);
});

void test('complete goal settings accept explicit nulls and finite fractional hour and energy targets', () => {
  assert.deepEqual(parseGoalSettingsInput({ targets }), targets);
  assert.deepEqual(parseGoalSettingsInput({ targets: { steps: 1, sleep: 0.5, active_energy: 0.25 } }), { steps: 1, sleep: 0.5, active_energy: 0.25 });
  assert.deepEqual(parseGoalSettingsInput({ targets: { steps: 200000, sleep: 24, active_energy: 20000 } }), { steps: 200000, sleep: 24, active_energy: 20000 });
  assert.deepEqual(parseGoalSettingsInput({ targets: emptyGoalSettings().targets }), emptyGoalSettings().targets);
});

void test('invalid, partial, coercible and unknown target inputs are rejected', () => {
  const invalid: unknown[] = [null, [], {}, { targets: null }, { targets: [] },
    { targets, extra: true }, { targets: { ...targets, weight: 70 } },
    { targets: { steps: 8000, sleep: 8 } }, { targets: { ...targets, steps: undefined } },
  ];
  for (const metric of ['steps', 'sleep', 'active_energy'] as const) {
    for (const value of [0, -1, '8000', true, NaN, Infinity, -Infinity, {}]) invalid.push({ targets: { ...targets, [metric]: value } });
  }
  invalid.push({ targets: { ...targets, steps: 1.5 } }, { targets: { ...targets, steps: 200001 } },
    { targets: { ...targets, sleep: 24.01 } }, { targets: { ...targets, active_energy: 20000.1 } });
  for (const input of invalid) assert.throws(() => parseGoalSettingsInput(input), GoalValidationError);
});

void test('daily goal history preserves yesterday when today increases and exposes the date-specific target',()=>{
  const data=settings({steps:8000});data.revision=1;data.effectiveFrom='2026-11-09';data.history=[{revision:0,effectiveFrom:'1970-01-01',targets:{steps:6000,sleep:null,active_energy:null},createdAt:NOW},{revision:1,effectiveFrom:'2026-11-09',targets:data.targets,createdAt:NOW}];
  const result=buildGoalProgress(data,summary([daily('steps','2026-11-08',7000),daily('steps','2026-11-09',7000)]),NOW).metrics[0];
  assert.equal(result.days.find((day)=>day.day==='2026-11-08')?.status,'achieved');assert.equal(result.days.find((day)=>day.day==='2026-11-08')?.target,6000);assert.equal(result.current.status,'in-progress');assert.equal(result.current.target,8000);assert.equal(result.current.targetEffectiveFrom,'2026-11-09');
});

void test('goal updates require an explicit revision and valid nonfuture effective date',()=>{const command={targets,expectedRevision:0,effectiveFrom:'2026-11-09'};assert.equal(parseGoalUpdateInput(command,Date.parse(NOW)).expectedRevision,0);for(const patch of [{expectedRevision:-1},{expectedRevision:'0'},{effectiveFrom:'2026-02-30'},{effectiveFrom:'2026-11-10'},{effectiveFrom:'1970-01-01'},{expectedRevision:undefined}])assert.throws(()=>parseGoalUpdateInput({...command,...patch},Date.parse(NOW)),GoalValidationError);});
