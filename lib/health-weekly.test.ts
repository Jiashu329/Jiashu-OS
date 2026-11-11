import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyGoalSettings } from './health-goals.ts';
import type { GoalSettings } from './health-goals.ts';
import type { HealthMeasurement } from './health.ts';
import { buildHealthWeeklyReview, HealthWeekValidationError, parseHealthWeekQuery } from './health-weekly.ts';

const NOW = new Date('2026-11-11T08:00:00Z');
function selection(week?: string, now = NOW) {
  return parseHealthWeekQuery(new URLSearchParams(week === undefined ? '' : { week }), now);
}
function daily(metric: 'steps' | 'sleep' | 'active_energy', day: string, value: number, end = '08:00:00'): HealthMeasurement {
  return {
    id: metric + ':' + day, metric, value, aggregation: 'daily',
    unit: metric === 'steps' ? 'count' : metric === 'sleep' ? 'hours' : 'kcal',
    startDate: day + 'T00:00:00+08:00', endDate: day + 'T' + end + '+08:00', source: 'synthetic-source',
  };
}
function weight(id: string, at: string, value: number): HealthMeasurement {
  return { id, metric: 'weight', value, unit: 'kg', startDate: at, source: 'synthetic-scale', aggregation: 'sample' };
}
const goals: GoalSettings = { targets: { steps: 8000, sleep: 7, active_energy: 500 }, updatedAt: '2026-11-11T07:00:00Z' };

void test('the current Shanghai week compares only equal elapsed weekdays against the previous week', () => {
  assert.deepEqual(selection(), {
    weekStart: '2026-11-09', weekEnd: '2026-11-15', cutoffDay: '2026-11-11',
    previousStart: '2026-11-02', previousEnd: '2026-11-08', previousCutoffDay: '2026-11-04',
    comparisonDays: 3, today: '2026-11-11', isCurrent: true, partial: true,
  });
  assert.deepEqual(selection('2026-11-10'), selection('2026-11-09'));
  assert.deepEqual(selection('2026-11-15'), selection(), 'a selected day in the current week normalizes to its Monday');
  const sunday = selection(undefined, new Date('2026-11-15T08:00:00Z'));
  assert.equal(sunday.comparisonDays, 7);
  assert.equal(sunday.partial, true, 'a Sunday still in progress is not a completed historical week');
});

void test('historical weeks compare complete Monday-to-Sunday periods and normalize selected dates', () => {
  assert.deepEqual(selection('2026-10-28'), {
    weekStart: '2026-10-26', weekEnd: '2026-11-01', cutoffDay: '2026-11-01',
    previousStart: '2026-10-19', previousEnd: '2026-10-25', previousCutoffDay: '2026-10-25',
    comparisonDays: 7, today: '2026-11-11', isCurrent: false, partial: false,
  });
});

void test('Shanghai midnight, cross-year weeks and leap days have stable calendar boundaries', () => {
  const before = selection(undefined, new Date('2026-11-08T15:59:59Z'));
  const after = selection(undefined, new Date('2026-11-08T16:00:00Z'));
  assert.equal(before.today, '2026-11-08');
  assert.equal(before.weekStart, '2026-11-02');
  assert.equal(before.comparisonDays, 7);
  assert.equal(after.today, '2026-11-09');
  assert.equal(after.weekStart, '2026-11-09');
  assert.equal(after.comparisonDays, 1);
  assert.equal(after.previousCutoffDay, '2026-11-02');
  const year = selection(undefined, new Date('2027-01-01T00:00:00+08:00'));
  assert.equal(year.weekStart, '2026-12-28');
  assert.equal(year.weekEnd, '2027-01-03');
  assert.equal(year.previousStart, '2026-12-21');
  assert.equal(year.previousCutoffDay, '2026-12-25');
  assert.equal(year.comparisonDays, 5);
  const leap = selection('2024-02-29');
  assert.equal(leap.weekStart, '2024-02-26');
  assert.equal(leap.weekEnd, '2024-03-03');
  const first = selection('1970-01-01');
  assert.equal(first.weekStart, '1969-12-29');
  assert.deepEqual(selection(first.weekStart), first, 'canonical first supported week must round-trip');
});

void test('invalid calendars, malformed strings and future weeks fail with a predictable validation code', () => {
  for (const raw of ['', '2026-2-09', '2026-02-30', '2025-02-29', '2026-00-01', '2026-13-01',
    '2026-11-09\n', ' 2026-11-09', '2026-11-09T00:00:00Z', '2026-11-16', '3000-01-01', '1969-12-28']) {
    assert.throws(() => selection(raw), (error) => error instanceof HealthWeekValidationError && error.code === 'INVALID_HEALTH_WEEK');
  }
});

void test('weekly averages use actual recorded days, preserve zero and never include unmatched previous weekdays', () => {
  const result = buildHealthWeeklyReview([
    daily('steps', '2026-11-09', 0), daily('steps', '2026-11-10', 10000),
    daily('steps', '2026-11-02', 1000), daily('steps', '2026-11-04', 3000),
    daily('steps', '2026-11-05', 100000), daily('steps', '2026-11-08', 100000),
    daily('steps', '2026-11-01', 100000),
  ], goals, selection(), NOW);
  const steps = result.metrics[0];
  assert.equal(steps.currentAverage, 5000);
  assert.equal(steps.previousAverage, 2000);
  assert.equal(steps.delta, 3000);
  assert.equal(steps.currentRecordedDays, 2);
  assert.equal(steps.previousRecordedDays, 2);
  assert.deepEqual(steps.currentPoints, [
    { day: '2026-11-09', value: 0,target:8000,targetEffectiveFrom:null }, { day: '2026-11-10', value: 10000,target:8000,targetEffectiveFrom:null }, { day: '2026-11-11', value: null,target:8000,targetEffectiveFrom:null },
  ]);
  assert.deepEqual(steps.previousPoints.map((point) => point.day), ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.equal(steps.target, 8000);
  assert.equal(steps.currentAchievedDays, 1);
  assert.equal(steps.previousAchievedDays, 0);
  assert.equal(result.targetsUpdatedAt, goals.updatedAt);
});

void test('body-mass weekly means use the last measurement per Shanghai day rather than every sample', () => {
  const result = buildHealthWeeklyReview([
    weight('morning', '2026-11-09T06:00:00+08:00', 80),
    weight('evening', '2026-11-09T20:00:00+08:00', 84),
    weight('next-day', '2026-11-10T06:00:00+08:00', 78),
    weight('prior-mon', '2026-11-02T06:00:00+08:00', 82),
    weight('prior-tue', '2026-11-03T06:00:00+08:00', 84),
  ], goals, selection(), NOW).metrics[3];
  assert.equal(result.currentAverage, 81);
  assert.equal(result.previousAverage, 83);
  assert.equal(result.delta, -2);
  assert.equal(result.currentRecordedDays, 2);
  assert.deepEqual(result.currentPoints.map((point) => point.value), [84, 78, null]);
  assert.equal(result.target, null);
  assert.equal(result.currentAchievedDays, null);
  assert.equal(result.previousAchievedDays, null);
});

void test('sleep belongs to its Shanghai ending day and UTC-crossing point samples use local days', () => {
  const result = buildHealthWeeklyReview([
    { ...daily('sleep', '2026-11-08', 8), startDate: '2026-11-08T23:00:00+08:00', endDate: '2026-11-09T07:00:00+08:00' },
    weight('utc-before-midnight', '2026-11-09T15:59:00Z', 70),
    weight('utc-after-midnight', '2026-11-09T16:01:00Z', 72),
  ], goals, selection(), NOW);
  assert.equal(result.metrics[1].currentPoints[0].value, 8);
  assert.equal(result.metrics[1].currentAchievedDays, 1);
  assert.deepEqual(result.metrics[3].currentPoints.map((point) => point.value), [70, 72, null]);
});

void test('future instants are removed before choosing the last daily sample or calculating daily aggregates', () => {
  const result = buildHealthWeeklyReview([
    weight('past', '2026-11-11T07:00:00+08:00', 70),
    weight('future-today', '2026-11-11T23:00:00+08:00', 99),
    weight('tomorrow', '2026-11-12T07:00:00+08:00', 100),
    daily('steps', '2026-11-11', 9000, '23:00:00'),
    daily('sleep', '2026-11-11', 8, '23:00:00'),
    daily('active_energy', '2026-11-11', 500, '12:00:00'),
  ], goals, selection(), NOW);
  assert.equal(result.metrics[3].currentAverage, 70);
  assert.equal(result.metrics[3].currentRecordedDays, 1);
  assert.equal(result.metrics[0].currentRecordedDays, 0);
  assert.equal(result.metrics[1].currentRecordedDays, 0);
  assert.equal(result.metrics[2].currentAverage, 500);
  assert.equal(result.metrics[2].currentAchievedDays, 1);
});

void test('legacy body-mass ending timestamps do not turn a past point sample into a future one', () => {
  const result = buildHealthWeeklyReview([
    { ...weight('past', '2026-11-10T07:00:00+08:00', 70), endDate: '2026-11-12T07:00:00+08:00' },
  ], goals, selection(), NOW);
  assert.equal(result.metrics[3].currentAverage, 70);
});

void test('the current targets re-evaluate both periods without changing the source measurements', () => {
  const measurements = [
    daily('steps', '2026-11-09', 7000), daily('steps', '2026-11-02', 6000),
    daily('sleep', '2026-11-09', 7), daily('sleep', '2026-11-02', 8),
  ];
  const before = structuredClone(measurements);
  const original = buildHealthWeeklyReview(measurements, goals, selection(), NOW);
  const changed: GoalSettings = { targets: { steps: 6000, sleep: null, active_energy: null }, updatedAt: '2026-11-11T08:00:00Z' };
  const revised = buildHealthWeeklyReview(measurements, changed, selection(), NOW);
  assert.equal(original.metrics[0].currentAchievedDays, 0);
  assert.equal(original.metrics[0].previousAchievedDays, 0);
  assert.equal(revised.metrics[0].currentAchievedDays, 1);
  assert.equal(revised.metrics[0].previousAchievedDays, 1);
  assert.equal(revised.metrics[0].currentAverage, original.metrics[0].currentAverage);
  assert.equal(revised.metrics[1].currentAchievedDays, null);
  assert.equal(revised.metrics[1].currentAverage, 7);
  assert.equal(revised.targetsUpdatedAt, changed.updatedAt);
  assert.deepEqual(measurements, before);
});

void test('empty periods have null averages and deltas, with zero observations rather than fabricated zero values', () => {
  const result = buildHealthWeeklyReview([], emptyGoalSettings(), selection('2026-10-28'), NOW);
  assert.deepEqual(result.metrics.map((metric) => [metric.metric, metric.label, metric.unit]), [
    ['steps', '步数', '步'], ['sleep', '睡眠', '小时'], ['active_energy', '活动能量', '千卡'], ['weight', '体重', 'kg'],
  ]);
  for (const metric of result.metrics) {
    assert.equal(metric.currentAverage, null);
    assert.equal(metric.previousAverage, null);
    assert.equal(metric.delta, null);
    assert.equal(metric.currentRecordedDays, 0);
    assert.equal(metric.previousRecordedDays, 0);
    assert.equal(metric.currentPoints.length, 7);
    assert.equal(metric.previousPoints.length, 7);
    assert.ok(metric.currentPoints.every((point) => point.value === null));
    assert.equal(metric.currentAchievedDays, null);
  }
  const oneSide = buildHealthWeeklyReview([daily('steps', '2026-11-09', 0)], goals, selection(), NOW).metrics[0];
  assert.equal(oneSide.currentAverage, 0);
  assert.equal(oneSide.previousAverage, null);
  assert.equal(oneSide.delta, null);
});

void test('mixed target weeks count each date against its effective version and report daily evidence',()=>{
  const data:GoalSettings={targets:{steps:8000,sleep:null,active_energy:null},updatedAt:'2026-11-10T00:00:00Z',revision:1,effectiveFrom:'2026-11-10',history:[{revision:0,effectiveFrom:'1970-01-01',targets:{steps:6000,sleep:null,active_energy:null},createdAt:'2026-11-01T00:00:00Z'},{revision:1,effectiveFrom:'2026-11-10',targets:{steps:8000,sleep:null,active_energy:null},createdAt:'2026-11-10T00:00:00Z'}]};
  const records=['2026-11-02','2026-11-03','2026-11-04','2026-11-09','2026-11-10','2026-11-11'].map((day)=>({id:'steps:'+day,metric:'steps' as const,value:day==='2026-11-11'?9000:7000,unit:'count' as const,aggregation:'daily' as const,startDate:day+'T00:00:00+08:00',endDate:day+'T08:00:00+08:00',source:'synthetic'}));
  const result=buildHealthWeeklyReview(records,data,parseHealthWeekQuery(new URLSearchParams(),Date.parse('2026-11-11T08:00:00Z')),Date.parse('2026-11-11T08:00:00Z')).metrics[0];
  assert.equal(result.currentAchievedDays,2);assert.equal(result.previousAchievedDays,3);assert.deepEqual(result.targetsInPeriod?.map((point)=>point.target),[6000,8000,8000]);
});
