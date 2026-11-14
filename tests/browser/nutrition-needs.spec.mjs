import { test, expect } from '@playwright/test';
import { syntheticState, interceptSyntheticAPI } from './synthetic-api.mjs';
import { calculateNutritionNeeds, parseNutritionNeedsInput } from '../../lib/nutrition-needs.ts';

const PROFILE = { age: 30, heightCm: 170, weightKg: 65, sex: 'male', activity: 'sedentary', goal: 'maintain' };
const TARGETS = calculateNutritionNeeds(parseNutritionNeedsInput(PROFILE)).targets;

test.beforeEach(async ({ context, page }, testInfo) => {
  const state = syntheticState();
  testInfo.synthetic = state;
  testInfo.needsAI = { status: 'ready', text: '合成 AI 解读：以上为公式参考估算，请根据实际活动和体重趋势复核。', message: null };
  await interceptSyntheticAPI(context, state);
  // This one endpoint is synthetic too: no model, credentials or personal data are used.
  await page.route('**/api/health/nutrition/needs', async (route) => {
    const request = route.request(), body = request.postDataJSON();
    state.requests.push({ path: '/api/health/nutrition/needs', method: request.method(), body, key: null });
    try {
      const estimate = calculateNutritionNeeds(parseNutritionNeedsInput(body));
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ estimate, ai: testInfo.needsAI }) });
    } catch (error) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: error.message, code: 'SYNTHETIC_NEEDS_INPUT' }) });
    }
  });
});

test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.synthetic.externalRequests, 'Synthetic body inputs must never reach an external service').toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('nutrition-needs-acceptance.png'), fullPage: true });
});

async function openCalculator(page) {
  await page.goto('/health/nutrition');
  await expect(page.locator('#nutrition-page')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#nutrition-goals > summary').click();
  await expect(page.locator('#nutrition-goals-status')).toContainText('目标可分别留空');
  await page.locator('#nutrition-needs > summary').click();
  await expect(page.locator('#nutrition-needs-form')).toBeVisible();
}
async function fillProfile(page) {
  await page.locator('#nutrition-needs-age').fill(String(PROFILE.age));
  await page.locator('#nutrition-needs-sex').selectOption(PROFILE.sex);
  await page.locator('#nutrition-needs-height').fill(String(PROFILE.heightCm));
  await page.locator('#nutrition-needs-weight').fill(String(PROFILE.weightKg));
  await page.locator('#nutrition-needs-activity').selectOption(PROFILE.activity);
  await page.locator('#nutrition-needs-goal').selectOption(PROFILE.goal);
}
async function calculate(page) {
  await page.locator('#nutrition-needs-calculate').click();
  await expect(page.locator('#nutrition-needs-result')).toBeVisible();
}
async function fitsViewport(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'The calculator must fit the desktop and 390px viewport').toBe(true);
}
const goalWrites = (testInfo) => testInfo.synthetic.requests.filter((request) => request.path === '/api/health/nutrition/goals' && request.method === 'PUT');
const needsRequests = (testInfo) => testInfo.synthetic.requests.filter((request) => request.path === '/api/health/nutrition/needs');

test('daily calorie needs are calculated on demand, previewed, filled and saved in separate actions', async ({ page }, testInfo) => {
  await openCalculator(page);
  await expect(page.locator('#nutrition-needs-sex')).toHaveValue('');
  await expect(page.locator('#nutrition-needs-activity')).toHaveValue('');
  await expect(page.locator('#nutrition-needs-result')).not.toBeVisible();
  expect(testInfo.synthetic.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  await fillProfile(page); await calculate(page);
  expect(needsRequests(testInfo)).toHaveLength(1);
  expect(needsRequests(testInfo)[0]).toMatchObject({ method: 'POST', body: PROFILE });
  await expect(page.locator('#nutrition-needs-calories')).toHaveText(TARGETS.calories + ' kcal');
  await expect(page.locator('#nutrition-needs-protein')).toHaveText(TARGETS.protein + ' g');
  await expect(page.locator('#nutrition-needs-ai')).toContainText('合成 AI 解读');
  await expect(page.locator('#nutrition-goal-calories')).toHaveValue('');
  expect(goalWrites(testInfo)).toHaveLength(0);
  await fitsViewport(page);
  await page.screenshot({ path: testInfo.outputPath('nutrition-needs-preview.png'), fullPage: true });

  await page.locator('#nutrition-needs-apply').click();
  for (const [key, value] of Object.entries(TARGETS)) await expect(page.locator('#nutrition-goal-' + key)).toHaveValue(value);
  await expect(page.locator('#nutrition-needs-apply-status')).toContainText('保存每日目标');
  expect(goalWrites(testInfo)).toHaveLength(0);
  expect(testInfo.synthetic.goals.calories).toBeNull();
  await page.locator('#nutrition-goals-save').click();
  await expect.poll(() => testInfo.synthetic.goals.calories).toBe(TARGETS.calories);
  expect(goalWrites(testInfo)).toHaveLength(1);
  expect(goalWrites(testInfo)[0].body).toMatchObject({ ...TARGETS, expectedRevision: 0 });
  await fitsViewport(page);
});

test('an unsaved daily target prevents calculated values from overwriting it', async ({ page }, testInfo) => {
  await openCalculator(page);
  await page.locator('#nutrition-goal-calories').fill('2100');
  await page.locator('#nutrition-goal-protein').fill('100');
  await fillProfile(page); await calculate(page);
  await expect(page.locator('#nutrition-needs-apply')).toBeDisabled();
  await expect(page.locator('#nutrition-needs-apply-status')).toContainText('未保存的目标');
  await expect(page.locator('#nutrition-goal-calories')).toHaveValue('2100');
  await expect(page.locator('#nutrition-goal-protein')).toHaveValue('100');
  expect(goalWrites(testInfo)).toHaveLength(0);
  await fitsViewport(page);
  await page.screenshot({ path: testInfo.outputPath('nutrition-needs-protected-targets.png'), fullPage: true });

  // Saving the existing draft resolves the block; applying a preview still does not save it.
  await page.locator('#nutrition-goals-save').click();
  await expect.poll(() => testInfo.synthetic.goals.calories).toBe('2100.0');
  await expect(page.locator('#nutrition-needs-apply')).toBeEnabled();
  await page.locator('#nutrition-needs-apply').click();
  await expect(page.locator('#nutrition-goal-calories')).toHaveValue(TARGETS.calories);
  expect(goalWrites(testInfo)).toHaveLength(1);
  expect(testInfo.synthetic.goals.calories).toBe('2100.0');
});

test('AI unavailability is explicit, profile edits invalidate the preview and clearing removes the transient inputs', async ({ page }, testInfo) => {
  testInfo.needsAI = { status: 'unavailable', text: null, message: '合成 AI 本次不可用，先参考公式估算。' };
  await openCalculator(page); await fillProfile(page); await calculate(page);
  await expect(page.locator('#nutrition-needs-status')).toContainText('AI 解读本次未生成');
  await expect(page.locator('#nutrition-needs-ai')).toHaveText(testInfo.needsAI.message);
  await expect(page.locator('#nutrition-needs-apply')).toBeEnabled();
  const storage = await page.evaluate(() => Object.values(localStorage));
  expect(storage.some((value) => /nutrition-needs|heightCm|weightKg/.test(value)), 'Body-profile fields must stay out of durable local drafts').toBe(false);
  await fitsViewport(page);
  await page.screenshot({ path: testInfo.outputPath('nutrition-needs-ai-unavailable.png'), fullPage: true });

  await page.locator('#nutrition-needs-weight').fill('66');
  await expect(page.locator('#nutrition-needs-result')).not.toBeVisible();
  await expect(page.locator('#nutrition-needs-apply')).toBeDisabled();
  await expect(page.locator('#nutrition-goal-calories')).toHaveValue('');
  expect(needsRequests(testInfo)).toHaveLength(1);
  await page.locator('#nutrition-needs-clear').click();
  for (const key of ['age', 'height', 'weight', 'sex', 'activity']) await expect(page.locator('#nutrition-needs-' + key)).toHaveValue('');
  await expect(page.locator('#nutrition-needs-ai')).toHaveText('');
  expect(goalWrites(testInfo)).toHaveLength(0);
});
