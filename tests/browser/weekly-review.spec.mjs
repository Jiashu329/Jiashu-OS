import { test, expect } from '@playwright/test';
import { syntheticState, interceptSyntheticAPI } from './synthetic-api.mjs';
import { buildHealthWeeklyReview, parseHealthWeekQuery } from '../../lib/health-weekly.ts';
import { buildHealthWeeklyFocus } from '../../lib/health-weekly-focus.ts';
import { parseWeeklyActionInput, shiftWeekDay } from '../../lib/health-weekly-actions.ts';

const NOW = new Date('2026-11-14T08:00:00Z');
const WEEK = '2026-11-02';
const STAMP = NOW.toISOString();
const GOALS = { targets: { steps: 8000, sleep: 7, active_energy: 400 }, updatedAt: STAMP, effectiveFrom: '2026-10-01' };
function daily(metric, day, value) {
  return { id: 'synthetic-weekly-' + metric + '-' + day, metric, value, aggregation: 'daily', source: '合成周回顾来源',
    unit: metric === 'steps' ? 'count' : metric === 'sleep' ? 'hours' : 'kcal',
    startDate: day + 'T00:00:00+08:00', endDate: day + 'T08:00:00+08:00' };
}
function regularMeasurements() {
  return Array.from({ length: 5 }, (_, index) => [
    daily('sleep', shiftWeekDay(WEEK, index), 5.5), daily('sleep', shiftWeekDay(WEEK, index - 7), 7.5),
    daily('steps', shiftWeekDay(WEEK, index), 5500), daily('steps', shiftWeekDay(WEEK, index - 7), 8500),
    daily('active_energy', shiftWeekDay(WEEK, index), 270), daily('active_energy', shiftWeekDay(WEEK, index - 7), 400),
  ]).flat();
}
function reviewFor(state, params = new URLSearchParams({ week: WEEK })) {
  const selection = parseHealthWeekQuery(params, NOW);
  const actions = state.weeklyActions;
  const review = buildHealthWeeklyReview(state.weeklyMeasurements, GOALS, selection, NOW, {
    nutrition: [], actions: { previous: actions.get(selection.previousStart) ?? null,
      current: actions.get(selection.weekStart) ?? null, next: actions.get(shiftWeekDay(selection.weekStart, 7)) ?? null },
  });
  return { ...review, focus: buildHealthWeeklyFocus(review) };
}
const writes = (info) => info.synthetic.requests.filter(request => request.method !== 'GET');

test.beforeEach(async ({ context, page }, testInfo) => {
  const state = syntheticState();
  state.weeklyMeasurements = regularMeasurements(); state.weeklyActions = new Map();
  testInfo.synthetic = state;
  await interceptSyntheticAPI(context, state);
  await page.route('**/api/health/review?**', async route => {
    const request = route.request(), url = new URL(request.url());
    state.requests.push({ path: url.pathname, search: url.search, method: request.method(), body: null });
    const review = reviewFor(state, url.searchParams); testInfo.weeklyReview = review;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store', 'X-Account-Owner': state.owner }, body: JSON.stringify(review) });
  });
  await page.route('**/api/health/actions', async route => {
    const request = route.request(), body = request.postDataJSON();
    state.requests.push({ path: '/api/health/actions', method: request.method(), body });
    try {
      expect(request.method()).toBe('PUT');
      const command = parseWeeklyActionInput(body, NOW), previous = state.weeklyActions.get(command.weekStart);
      if ((previous?.revision ?? 0) !== command.expectedRevision) {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '行动已在其他页面更新。', code: 'WEEKLY_ACTION_CONFLICT' }) }); return;
      }
      const action = { weekStart: command.weekStart, text: command.text, status: command.status, feedback: command.feedback,
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? STAMP, updatedAt: STAMP };
      state.weeklyActions.set(command.weekStart, action);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store', 'X-Account-Owner': state.owner }, body: JSON.stringify({ action }) });
    } catch (error) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: error.message, code: 'SYNTHETIC_WEEKLY_ACTION_INVALID' }) });
    }
  });
});
test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.synthetic.externalRequests, 'Weekly evidence and actions must stay in the synthetic local fixture').toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('weekly-review-acceptance.png'), fullPage: true });
});
async function openReview(page) {
  await page.goto('/health/review?week=' + WEEK);
  await expect(page.locator('#weekly-page')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#weekly-content')).toBeVisible();
}
async function fits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The weekly focus must fit desktop and 390px layouts').toBe(true);
}

test('weekly review leads with evidenced priorities and adopts one next action only as an unsaved draft', async ({ page }, testInfo) => {
  await openReview(page);
  const focus = testInfo.weeklyReview.focus;
  expect(focus.primary.metric).toBe('sleep'); expect(focus.primary.kind).toBe('attention');
  expect(focus.secondary.length).toBeLessThanOrEqual(2);
  await expect(page.locator('#weekly-focus-headline')).toHaveText(focus.headline);
  await expect(page.locator('#weekly-focus-primary')).toContainText(focus.primary.evidence);
  await expect(page.locator('#weekly-focus-primary')).toContainText(focus.primary.interpretation);
  await expect(page.locator('#weekly-focus-coverage')).toContainText('3个相同星期位置');
  await expect(page.locator('#weekly-details')).not.toHaveAttribute('open', '');
  await expect(page.locator('#weekly-daily-rows')).not.toBeVisible();
  expect(writes(testInfo)).toEqual([]);
  await fits(page);
  await page.screenshot({ path: testInfo.outputPath('weekly-focus-overview.png'), fullPage: true });
  await page.locator('.weekly-focus').screenshot({ path: testInfo.outputPath('weekly-focus-cards.png') });

  await page.locator('#weekly-focus-use-action').click();
  await expect(page.locator('#weekly-action-text')).toHaveValue(focus.suggestedAction.text);
  expect(writes(testInfo)).toEqual([]);
  expect(testInfo.synthetic.weeklyActions.size).toBe(0);
  await page.locator('#weekly-action-form button[type="submit"]').click();
  await expect.poll(() => testInfo.synthetic.weeklyActions.get(shiftWeekDay(WEEK, 7))?.text).toBe(focus.suggestedAction.text);
  expect(writes(testInfo)).toHaveLength(1);
  expect(writes(testInfo)[0].body).toMatchObject({ weekStart: shiftWeekDay(WEEK, 7), text: focus.suggestedAction.text, expectedRevision: 0 });
  await page.locator('#weekly-details > summary').click();
  await expect(page.locator('#weekly-daily-rows')).toBeVisible();
  await fits(page);
});

test('an unsaved weekly action blocks suggestion replacement and week navigation preserves the draft', async ({ page }, testInfo) => {
  await openReview(page);
  const original = '保留这项合成验收行动草稿';
  await page.locator('#weekly-action-text').fill(original);
  await expect(page.locator('#weekly-focus-use-action')).toBeDisabled();
  await expect(page.locator('#weekly-focus-action-message')).toContainText('未保存');
  await page.locator('#weekly-previous').click();
  await expect(page.locator('#draft-guard-dialog')).toBeVisible();
  await page.locator('#draft-guard-dialog [data-draft-choice="continue"]').click();
  await expect(page.locator('#weekly-action-text')).toHaveValue(original);
  expect(new URL(page.url()).searchParams.get('week')).toBe(WEEK);
  expect(writes(testInfo)).toEqual([]);
  await fits(page);
});

test('a saved next-week action is shown and cannot be silently replaced by a generated suggestion', async ({ page }, testInfo) => {
  const weekStart = shiftWeekDay(WEEK, 7), text = '原来已保存的合成行动';
  testInfo.synthetic.weeklyActions.set(weekStart, { weekStart, text, status: 'planned', feedback: '', revision: 2, createdAt: STAMP, updatedAt: STAMP });
  await openReview(page);
  await expect(page.locator('#weekly-action-text')).toHaveValue(text);
  await expect(page.locator('#weekly-focus-use-action')).toBeDisabled();
  await expect(page.locator('#weekly-focus-action-message')).toContainText('已保存');
  expect(testInfo.synthetic.weeklyActions.get(weekStart).revision).toBe(2);
  expect(writes(testInfo)).toEqual([]);
  await fits(page);
});

test('a sparse week explains the evidence gap instead of turning one short sleep record into a trend', async ({ page }, testInfo) => {
  testInfo.synthetic.weeklyMeasurements = [daily('sleep', WEEK, 5.5), daily('sleep', shiftWeekDay(WEEK, -7), 7.5)];
  await openReview(page);
  const focus = testInfo.weeklyReview.focus;
  expect(focus.primary.kind).toBe('data');
  expect([focus.primary, ...focus.secondary].some(item => item.kind === 'attention')).toBe(false);
  await expect(page.locator('#weekly-focus-headline')).toHaveText(focus.headline);
  await expect(page.locator('#weekly-focus-primary')).toContainText(focus.primary.evidence);
  await expect(page.locator('#weekly-details')).not.toHaveAttribute('open', '');
  await expect(page.locator('#weekly-focus-action-text')).toHaveText(focus.suggestedAction.text);
  expect(writes(testInfo)).toEqual([]);
  await fits(page);
});
