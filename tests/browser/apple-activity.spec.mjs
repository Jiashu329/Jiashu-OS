import { test, expect } from '@playwright/test';
import { interceptSyntheticAPI, syntheticAppleActivityDaily, syntheticState } from './synthetic-api.mjs';
import { p2State } from './p2-api.mjs';
import { buildWeeklyAppleActivity } from '../../lib/apple-activity-supplements.ts';
import { emptyGoalSettings } from '../../lib/health-goals.ts';
import { buildHealthWeeklyFocus } from '../../lib/health-weekly-focus.ts';
import { buildHealthWeeklyReview, parseHealthWeekQuery } from '../../lib/health-weekly.ts';

const FROM = '2026-11-16';
const TO = '2026-11-22';
const RECORDED = '2026-11-21';
const MISSING = '2026-11-20';
const NOW = new Date('2026-11-22T14:00:00Z');
const RANGE = new URLSearchParams({ from: FROM, to: TO }).toString();
const WATCH = '合成手表';

function daily(metric, day, value, unit, extra = {}) {
  return { id: 'synthetic-workspace-' + metric + '-' + day, metric, value, unit,
    aggregation: 'daily', source: WATCH, startDate: day + 'T00:00:00+08:00', endDate: day + 'T08:00:00+08:00', ...extra };
}

function setSamples(state) {
  state.now = NOW.getTime();
  state.appleActivity = {
    vitals: [
      { day: RECORDED, heartRate: { average: 76.2, min: 52, max: 141 },
        restingHeartRate: { value: 58, measuredAt: '2026-11-21T00:32:00Z' },
        oxygenSaturation: { latest: 97.3, average: 97.6, min: 96, max: 99, count: 3, measuredAt: '2026-11-20T23:32:00Z' } },
      { day: '2026-11-19', heartRate: { average: 72, min: 50, max: 139 },
        restingHeartRate: { value: 56, measuredAt: '2026-11-19T02:00:00Z' } },
    ],
    workouts: [
      { id: '88eaea29-6064-4a1c-8f26-ecfaa7347cd3', activityType: 37, startDate: '2026-11-20T23:10:00Z', endDate: '2026-11-20T23:52:00Z', durationSeconds: 2400, energyKcal: 288, distanceMeters: 5072 },
      { id: '88eaea29-6064-4a1c-8f26-ecfaa7347cd4', activityType: 9999, startDate: '2026-11-19T15:50:00Z', endDate: '2026-11-19T16:25:00Z', durationSeconds: 2050 },
      { id: '88eaea29-6064-4a1c-8f26-ecfaa7347cd5', activityType: 52, startDate: '2026-11-22T00:10:00Z', endDate: '2026-11-22T00:40:00Z', durationSeconds: 1800 },
    ],
  };
  p2State(state).measurements = [
    daily('steps', RECORDED, 8750, 'count'),
    daily('steps', TO, 0, 'count'),
    daily('active_energy', RECORDED, 410, 'kcal'),
    daily('sleep', RECORDED, 7.5, 'hours', {
      sleepStages: { core: 4, deep: 1.5, rem: 2, unspecified: 0, awake: 0, inBed: 0 },
      sleepTiming: { onset: '2026-11-21T00:00:00+08:00', wake: '2026-11-21T07:30:00+08:00', clipped: false, method: 'longest-sleep-group-v1' },
    }),
    { id: 'synthetic-workspace-weight', metric: 'weight', value: 73.6, unit: 'kg', source: WATCH,
      aggregation: 'sample', startDate: RECORDED + 'T08:00:00+08:00' },
  ];
}

test.beforeEach(async ({ context, page }, info) => {
  const state = syntheticState();
  setSamples(state);
  info.synthetic = state;
  await page.clock.setFixedTime(NOW);
  await interceptSyntheticAPI(context, state);
});

test.afterEach(async ({ page }, info) => {
  expect(info.synthetic.externalRequests, 'Health values stay in the synthetic local fixture').toEqual([]);
  expect(info.synthetic.requests.filter(request => request.method !== 'GET')).toEqual([]);
  if (!page.isClosed()) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width + 1);
  }
});

const group = (page, key) => page.locator('#health-groups [data-health-group="' + key + '"]');
const tab = (page, key) => page.locator('#health-metric-tabs [data-metric="' + key + '"]');
const dayGroup = (page, key) => page.locator('#health-day-rows [data-day-group="' + key + '"]');

async function openDayDetail(page) {
  const toggle = page.locator('#health-day-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(page.locator('#health-day-rows')).toBeVisible();
}

async function expectSelection(page, metric, day, from = FROM, to = TO) {
  await expect.poll(() => {
    const url = new URL(page.url());
    return { path: url.pathname, metric: url.searchParams.get('metric'), day: url.searchParams.get('day'),
      from: url.searchParams.get('from'), to: url.searchParams.get('to') };
  }).toEqual({ path: '/health', metric, day, from, to });
}

test('five Health groups share the selected day and dates across metric changes', async ({ page }, info) => {
  await page.goto('/health?metric=steps&' + RANGE + '&day=' + RECORDED);
  await expect(page.locator('#health-groups [data-health-group]')).toHaveCount(5);
  await expect(page.locator('#health-day-detail')).toBeVisible();
  await openDayDetail(page);
  await expect(dayGroup(page, 'activity')).toContainText(/8,?750/);
  await expect(dayGroup(page, 'sleep')).toContainText(/7\.5|7\s*小时\s*30/);
  await expect(dayGroup(page, 'heart')).toContainText('76.2');
  await expect(dayGroup(page, 'oxygen')).toContainText(/97\.3|97\.6/);
  await expect(dayGroup(page, 'body')).toContainText('73.6');

  await group(page, 'sleep').click();
  await expectSelection(page, 'sleep', RECORDED);
  await expect(page.locator('#chart-title')).toContainText('睡眠');
  const dailyWorkout = page.locator('#health-day-workouts details.health-workout-row').filter({ hasText: '跑步' });
  await expect(dailyWorkout).toBeVisible();
  await dailyWorkout.locator('summary').click();
  await expect(dailyWorkout).toHaveAttribute('open', '');
  await expect(dailyWorkout).toContainText('5.07 公里');
  await group(page, 'heart').click();
  await tab(page, 'heart_rate').click();
  await expectSelection(page, 'heart_rate', RECORDED);
  await expect(page.locator('.health-workspace-chart-svg')).toHaveAttribute('aria-label', /心率趋势.*76\.2/);
  await tab(page, 'resting_heart_rate').click();
  await expectSelection(page, 'resting_heart_rate', RECORDED);
  await expect(page.locator('.health-workspace-chart-svg')).toHaveAttribute('aria-label', /静息心率趋势.*58/);
  await group(page, 'oxygen').click();
  await expectSelection(page, 'oxygen_saturation', RECORDED);
  await expect(page.locator('.health-workspace-chart-svg')).toHaveAttribute('aria-label', /血氧.*97\.6/);
  await expect(page.locator('#health-day-detail')).toContainText('97.3');
  await expect(page.locator('#health-day-detail')).toContainText(/3\s*次/);
  await group(page, 'body').click();
  await tab(page, 'weight').click();
  await expectSelection(page, 'weight', RECORDED);
  await expect(page.locator('#chart-title')).toContainText('体重');

  await page.goBack();
  await expectSelection(page, 'oxygen_saturation', RECORDED);
  await expect(page.locator('.health-workspace-chart-svg')).toHaveAttribute('aria-label', /血氧.*97\.6/);
  await page.reload();
  await expectSelection(page, 'oxygen_saturation', RECORDED);

  const loaded = info.synthetic.requests
    .filter(request => request.path === '/api/health' || request.path === '/api/health/apple-activity')
    .map(request => [request.path, new URLSearchParams(request.search).get('from'), new URLSearchParams(request.search).get('to')]);
  expect(loaded).toEqual(expect.arrayContaining([['/api/health', FROM, TO], ['/api/health/apple-activity', FROM, TO]]));
  expect(loaded.every(([, from, to]) => from === FROM && to === TO)).toBe(true);
});

test('keyboard date selection keeps explicit zero, absent dates, and a retryable source failure distinct', async ({ page }, info) => {
  const state = info.synthetic;
  await page.goto('/health?metric=steps&' + RANGE + '&day=' + RECORDED);
  const chart = page.locator('.health-workspace-chart-svg');
  await expect(chart).toHaveAttribute('aria-label', /8,?750/);
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  await expectSelection(page, 'steps', TO);
  await expect(chart).toHaveAttribute('aria-label', /2026-11-22.*0\s*步/);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expectSelection(page, 'steps', MISSING);
  await expect(chart).toHaveAttribute('aria-label', /2026-11-20.*暂无记录/);

  state.appleActivityReadFailure = true;
  await page.reload();
  await expect(chart).toHaveAttribute('aria-label', /暂无记录/);
  await expect(page.locator('#apple-health-status')).toBeVisible();
  await openDayDetail(page);
  await expect(dayGroup(page, 'activity')).toBeVisible();
  await group(page, 'oxygen').click();
  await expect(page.locator('#apple-health-status')).toBeVisible();
  await expect(dayGroup(page, 'oxygen')).toContainText('暂时无法读取');
  await expect(page.locator('#apple-health-retry')).toBeVisible();
  state.appleActivityReadFailure = false;
  await page.locator('#apple-health-retry').click();
  await expect(page.locator('#apple-health-status')).toBeHidden();
  await expect(chart).toHaveAttribute('aria-label', /2026-11-20.*暂无记录/);
  await page.locator('#health-next-day').click();
  await expectSelection(page, 'oxygen_saturation', RECORDED);
  await expect(chart).toHaveAttribute('aria-label', /97\.6/);

  const custom = page.locator('#health-custom-range');
  if (await custom.getAttribute('open') === null) await custom.locator('summary').click();
  await page.locator('#health-range-from').fill('2026-11-17');
  await page.locator('#health-range-to').fill('2026-11-19');
  await page.locator('#health-range-form button[type="submit"]').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('to')).toBe('2026-11-19');
  await expect(chart).toHaveAttribute('aria-label', /2026-11-19.*暂无记录/);
});

test('legacy Apple activity URLs preserve dates and workouts retain their source duration', async ({ page }) => {
  const legacy = '/health/apple-activity?metric=workouts&' + RANGE + '&day=' + RECORDED;
  await page.goto(legacy);
  await expectSelection(page, 'workouts', RECORDED);
  const workouts = page.locator('#health-workouts');
  const running = workouts.locator('details.health-workout-row').filter({ hasText: '跑步' });
  await expect(running).toBeVisible();
  await running.locator('summary').click();
  await expect(running).toHaveAttribute('open', '');
  await expect(running).toContainText(/40\s*分/);
  await expect(running).toContainText(/5\.07\s*公里/);
  const other = workouts.locator('details.health-workout-row').filter({ hasText: '其他训练' });
  await expect(other).toHaveCount(1);
  await other.locator('summary').click();
  await expect(other).not.toContainText('活动能量');
  await expect(other).toContainText(/11-19|11\/19|11月19|23:50/);
});

test('Today and Weekly link into the same Health views with the relevant dates', async ({ page }, info) => {
  await page.goto('/');
  const rest = page.locator('.metric-card.resting_heart_rate');
  const oxygen = page.locator('.metric-card.oxygen_saturation');
  const training = page.locator('.metric-card.workouts');
  await expect(rest).toContainText('58');
  await expect(oxygen).toContainText('97.3');
  await expect(training).toContainText('30 分钟');
  await rest.click();
  await expectSelection(page, 'resting_heart_rate', RECORDED);

  await page.goBack();
  await training.click();
  await expectSelection(page, 'workouts', TO, TO, TO);
  await expect(page.locator('#health-workouts')).toContainText('步行');

  const state = info.synthetic;
  await page.route(url => url.pathname === '/api/health/review', async route => {
    const selection = parseHealthWeekQuery(new URL(route.request().url()).searchParams, NOW);
    const review = buildHealthWeeklyReview(p2State(state).measurements, emptyGoalSettings(), selection, NOW);
    const appleActivity = buildWeeklyAppleActivity(syntheticAppleActivityDaily(state.appleActivity), selection);
    await route.fulfill({ headers: { 'X-Account-Owner': state.owner }, json: {
      ...review, focus: buildHealthWeeklyFocus(review), appleActivity,
    } });
  });
  await page.goto('/health/review?week=' + FROM);
  const week = page.locator('#weekly-apple-activity');
  await expect(week).toContainText(FROM + ' 至 ' + RECORDED);
  await expect(week.locator('.weekly-apple-card.heart_rate')).toContainText('2 / 6 天');
  await expect(week.locator('.weekly-apple-card.oxygen_saturation')).toContainText('3 次');
  await expect(week.locator('.weekly-apple-card.workouts')).toContainText('2 次');
  await expect(page.locator('#weekly-apple-today')).toContainText('30 分钟');
  await week.locator('.weekly-apple-card.workouts h3 a').click();
  await expectSelection(page, 'workouts', RECORDED, FROM, RECORDED);
});
