import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthSummary, type HealthMeasurement } from './health.ts';
import { buildBodyComposition } from './body-composition.ts';
import { buildHomeOverview, type HomeFinanceInput, type HomeHealthInput, type HomeOverviewSources } from './home-overview.ts';

const NOW = '2026-11-09T08:00:00Z';
const emptyFinance: HomeFinanceInput = { accounts: [] };
function health(measurements: HealthMeasurement[] = [], lastSync: string | null = NOW): HomeHealthInput {
  return { summary: buildHealthSummary(measurements), lastSync };
}
function sources(input: Partial<HomeOverviewSources> = {}): HomeOverviewSources {
  return { health: health(), personal: emptyFinance, family: emptyFinance, ...input };
}
function dayMetric(metric: 'steps' | 'active_energy', day: string, value: number): HealthMeasurement {
  return {
    id: metric + day, metric, value, unit: metric === 'steps' ? 'count' : 'kcal', aggregation: 'daily',
    startDate: day + 'T00:00:00+08:00', endDate: day + 'T23:59:00+08:00', source: 'Private sample source',
  };
}
let accountSequence = 0;
function account(ledger: 'personal' | 'family', options: Partial<HomeFinanceInput['accounts'][number]> = {}): HomeFinanceInput['accounts'][number] {
  return { id: ledger + (++accountSequence), ledger, type: 'bank', currency: 'CNY', balanceMinor: '100', asOfDate: '2026-11-09', ...options };
}

test('zero records stay zero, missing dates stay missing and weekly mean uses observed days only', () => {
  const output = buildHomeOverview(sources({ health: health([
    dayMetric('steps', '2026-11-08', 0), dayMetric('steps', '2026-11-06', 6000),
    dayMetric('steps', '2026-11-01', 10000),
  ]) }), NOW);
  const steps = output.health.metrics[0];
  assert.equal(steps.value, 0);
  assert.equal(steps.freshness, 'current');
  assert.deepEqual(steps.points, [{ day: '2026-11-06', value: 6000 }, { day: '2026-11-08', value: 0 }]);
  assert.equal(steps.average7, 3000);
  assert.equal(steps.observedDays7, 2);
  assert.equal(output.health.metrics[1].value, null);
  assert.equal(output.health.metrics[1].average7, null);
  assert.equal(output.health.metrics[1].freshness, 'missing');
  assert.equal(output.health.recordedMetricCount, 1);
  assert.ok(!JSON.stringify(output).includes('Private sample source'));
});

test('sleep is assigned to its ending day and freshness rolls over at Shanghai midnight', () => {
  const measurements: HealthMeasurement[] = [{
    id: 'sleep-window', metric: 'sleep', value: 7, unit: 'hours', aggregation: 'daily',
    startDate: '2026-11-07T23:00:00+08:00', endDate: '2026-11-08T07:00:00+08:00', source: 'Watch',
  }];
  const input = sources({ health: health(measurements) });
  const beforeMidnight = buildHomeOverview(input, '2026-11-09T15:59:59Z');
  const afterMidnight = buildHomeOverview(input, '2026-11-09T16:00:00Z');
  assert.equal(beforeMidnight.today, '2026-11-09');
  assert.equal(beforeMidnight.health.metrics[1].day, '2026-11-08');
  assert.equal(beforeMidnight.health.metrics[1].freshness, 'current');
  assert.equal(afterMidnight.today, '2026-11-10');
  assert.equal(afterMidnight.health.metrics[1].freshness, 'stale');
});

test('a new sync of old measurements cannot make them current or imply today has data', () => {
  const result = buildHomeOverview(sources({ health: health([dayMetric('steps', '2026-10-20', 9000)], NOW) }), NOW);
  const steps = result.health.metrics[0];
  assert.equal(result.health.lastSync, NOW);
  assert.equal(steps.day, '2026-10-20');
  assert.equal(steps.freshness, 'stale');
  assert.equal(steps.average7, null);
  assert.deepEqual(steps.points, []);
  assert.equal(result.priorities[0].id, 'health-stale');
});

test('weight permits seven-day freshness while future and older-than-90-day points do not appear', () => {
  const h = health([
    { id: 'weight', metric: 'weight', value: 73, unit: 'kg', startDate: '2026-11-02T08:00:00+08:00' },
    dayMetric('steps', '2026-11-10', 333), dayMetric('active_energy', '2026-08-01', 500),
  ]);
  const result = buildHomeOverview(sources({ health: h }), NOW);
  assert.equal(result.health.metrics[3].freshness, 'current');
  assert.equal(result.health.metrics[3].day, '2026-11-02');
  assert.equal(result.health.metrics[0].value, null);
  assert.equal(result.health.metrics[2].value, null);
  assert.equal(result.health.recordedMetricCount, 1);
});

test('ledgers and currencies stay separate, archived accounts stay excluded and money stays exact', () => {
  const personal = { accounts: [
    account('personal', { currency: 'CNY', balanceMinor: '9007199254740993' }),
    account('personal', { currency: 'CNY', type: 'loan', balanceMinor: '2' }),
    account('personal', { currency: 'USD', balanceMinor: '3500' }),
    account('personal', { archived: true, balanceMinor: '900000', asOfDate: '2020-01-01' }),
    account('family', { balanceMinor: '900000000' }),
  ] };
  const family = { accounts: [account('family', { balanceMinor: '200' })] };
  const output = buildHomeOverview(sources({ personal, family }), NOW);
  assert.equal(output.finance.personal.accountCount, 3);
  assert.equal(output.finance.personal.currencies.length, 2);
  assert.equal(output.finance.personal.currencies[0].netMinor, '9007199254740991');
  assert.equal(output.finance.personal.currencies[0].netFormatted, 'CNY 90,071,992,547,409.91');
  assert.equal(output.finance.personal.currencies[1].netMinor, '3500');
  assert.equal(output.finance.family.currencies[0].netMinor, '200');
  assert.equal(output.finance.personal.oldestBalanceDate, '2026-11-09');
  assert.equal(output.finance.personal.staleAccountCount, 0);
});

test('any stale balance triggers a reminder, with exact 30-day boundary and independent ready sources', () => {
  const output = buildHomeOverview(sources({
    health: null,
    personal: { accounts: [account('personal', { asOfDate: '2026-10-10' }), account('personal', { asOfDate: '2026-10-09' })] },
    family: null,
  }), NOW);
  assert.equal(output.health.status, 'unavailable');
  assert.equal(output.finance.family.status, 'unavailable');
  assert.equal(output.finance.personal.status, 'ready');
  assert.equal(output.finance.personal.staleAccountCount, 1);
  assert.equal(output.finance.personal.oldestBalanceDate, '2026-10-09');
  assert.equal(output.finance.personal.latestBalanceDate, '2026-10-10');
  assert.deepEqual(output.priorities.map((item) => item.id), ['health-unavailable', 'finance-unavailable', 'personal-stale']);
  assert.ok(output.priorities.length <= 3);
  const unavailable = buildHomeOverview({ health: null, personal: null, family: null }, NOW);
  assert.equal(unavailable.finance.personal.status, 'unavailable');
  assert.equal(unavailable.health.metrics[0].value, null);
  assert.ok(unavailable.priorities.every((item) => item.tone === 'attention'));
});

test('all-current data needs no filler priority or status score', () => {
  const output = buildHomeOverview(sources({
    health: health([
      dayMetric('steps', '2026-11-08', 5000), dayMetric('active_energy', '2026-11-08', 300),
      { id: 'sleep', metric: 'sleep', value: 7, unit: 'hours', aggregation: 'daily', startDate: '2026-11-07T23:00:00+08:00', endDate: '2026-11-08T07:00:00+08:00' },
      { id: 'weight', metric: 'weight', value: 70, unit: 'kg', startDate: '2026-11-08T08:00:00+08:00' },
    ]), personal: { accounts: [account('personal')] }, family: { accounts: [account('family')] },
  }), NOW);
  assert.deepEqual(output.priorities, []);
  assert.equal(output.asOf, NOW.replace('Z', '.000Z'));
});

test('home composition indicators use server pairs instead of mixing independent latest samples', () => {
  const rows: HealthMeasurement[] = [
    { id: 'weight-old', metric: 'weight', value: 70, unit: 'kg', source: 'scale', startDate: '2026-11-08T07:00:00+08:00' },
    { id: 'lean-old', metric: 'lean_body_mass', value: 56, unit: 'kg', source: 'scale', startDate: '2026-11-08T07:00:00+08:00' },
    { id: 'weight-new', metric: 'weight', value: 75, unit: 'kg', source: 'scale', startDate: '2026-11-09T07:00:00+08:00' },
    { id: 'lean-new', metric: 'lean_body_mass', value: 58, unit: 'kg', source: 'scale', startDate: '2026-11-09T08:00:00+08:00' },
  ];
  const input = { ...health(rows), bodyComposition: buildBodyComposition(rows) };
  const output = buildHomeOverview(sources({ health: input }), NOW);
  const metric = (key: string) => output.health.metrics.find((item) => item.metric === key)!;
  assert.equal(metric('weight').value, 75);
  assert.equal(metric('lean_body_mass').value, 58);
  assert.equal(metric('body_fat').value, 20);
  assert.equal(metric('body_fat').day, '2026-11-08');
  assert.deepEqual(metric('body_fat').points, [{ day: '2026-11-08', value: 20 }]);
  assert.equal(metric('body_fat').observedDays7, 1);
  // Older clients without a server-derived field must not improvise a pair.
  const legacy = buildHomeOverview(sources({ health: health(rows) }), NOW);
  assert.equal(legacy.health.metrics.find((item) => item.metric === 'body_fat')!.value, null);
  assert.equal(output.health.recordedMetricCount, 3);
});

test('stale balances outrank an empty ledger setup while preserving order within each tone', () => {
  const output = buildHomeOverview(sources({
    health: health([
      dayMetric('steps', '2026-11-08', 5000), dayMetric('active_energy', '2026-11-08', 300),
      { id: 'sleep', metric: 'sleep', value: 7, unit: 'hours', aggregation: 'daily', startDate: '2026-11-07T23:00:00+08:00', endDate: '2026-11-08T07:00:00+08:00' },
      { id: 'weight', metric: 'weight', value: 70, unit: 'kg', startDate: '2026-11-08T08:00:00+08:00' },
    ]), personal: emptyFinance, family: { accounts: [account('family', { asOfDate: '2026-10-01' })] },
  }), NOW);
  assert.deepEqual(output.priorities.map((item) => item.id), ['family-stale', 'personal-setup']);
  assert.deepEqual(output.priorities.map((item) => item.tone), ['attention', 'setup']);
  const empty = buildHomeOverview(sources(), NOW);
  assert.deepEqual(empty.priorities.map((item) => item.id), ['health-setup', 'personal-setup', 'family-setup']);
});
