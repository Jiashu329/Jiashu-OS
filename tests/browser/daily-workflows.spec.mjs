import { test, expect } from '@playwright/test';
import { syntheticState, interceptSyntheticAPI, DAY } from './synthetic-api.mjs';
import { presentNutritionEntry } from '../../lib/nutrition.ts';

test.beforeEach(async ({ context }, testInfo) => {
  const state = syntheticState();
  testInfo.synthetic = state;
  await interceptSyntheticAPI(context, state);
});

test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.synthetic.externalRequests, 'No personal data or synthetic input may leave the local fixture').toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('acceptance-view.png'), fullPage: true });
});

async function ready(page) {
  await expect(page.locator('#nutrition-page')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#nutrition-entry-ai')).toBeVisible();
}
async function noHorizontalOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Page content must fit the desktop or 390px viewport').toBe(true);
}

test('one-tap food entry reaches a usable composer without opening a modal or calling AI', async ({ page }, testInfo) => {
  await page.goto('/');
  const action = page.locator('a[href="/health/nutrition?compose=1"]').first();
  await expect(action).toBeVisible();
  await action.click();
  await ready(page);
  await expect(page.locator('#nutrition-ai-text')).toBeFocused();
  await expect(page.locator('#nutrition-dialog')).not.toBeVisible();
  await expect(page.locator('#nutrition-history')).not.toHaveAttribute('open', '');
  expect(testInfo.synthetic.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  await noHorizontalOverflow(page);
});

test('quick weight entry opens the kilogram form with current Shanghai date and time without writing', async ({ page }, testInfo) => {
  await page.goto('/health/records?metric=weight&compose=1');
  await expect(page.locator('#records-page')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#records-dialog')).toBeVisible();
  await expect(page.locator('#records-form-metric')).toHaveValue('weight');
  await expect(page.locator('#records-unit')).toContainText('kg');
  await expect(page.locator('#records-day')).toHaveValue(DAY);
  await expect(page.locator('#records-value')).toBeFocused();
  const recorded = await page.locator('#records-date-time').inputValue();
  expect(recorded).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  const difference = await page.evaluate((time) => {
    const now = new Date(), parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const value = (key) => Number(parts.find((part) => part.type === key).value);
    const [h,m,s] = time.split(':').map(Number), seconds = value('hour') * 3600 + value('minute') * 60 + value('second');
    return Math.min(Math.abs(seconds - h*3600 - m*60 - s), 86400 - Math.abs(seconds - h*3600 - m*60 - s));
  }, recorded);
  expect(difference).toBeLessThan(30);
  expect(testInfo.synthetic.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  await noHorizontalOverflow(page);
});

test('manual recording keeps zero and unknown grams distinct and its optional fields remain reachable', async ({ page }, testInfo) => {
  await page.goto('/health/nutrition'); await ready(page);
  await page.locator('[data-entry-method="manual"]').click();
  await expect(page.locator('#nutrition-dialog')).toBeVisible();
  await page.locator('#nutrition-name').fill('合成验收食物');
  await page.locator('#nutrition-portion').fill('1份');
  await page.locator('#nutrition-form-nutrients > summary').click();
  await page.locator('#nutrition-calories').fill('120');
  await page.locator('#nutrition-carbs').fill('20.5');
  await page.locator('#nutrition-protein').fill('0');
  await page.locator('#nutrition-fat').fill('');
  await page.locator('#nutrition-save').click();
  await expect(page.locator('#nutrition-dialog')).not.toBeVisible();
  await expect(page.locator('#nutrition-list')).toContainText('合成验收食物');
  const write = testInfo.synthetic.requests.find((request) => request.path === '/api/health/nutrition' && request.method === 'POST');
  expect(write.body).toMatchObject({ carbs: '20.5', protein: '0.0', fat: null });
  await noHorizontalOverflow(page);
});

test('AI parsing makes a compact review and writes only after explicit confirmation', async ({ page }, testInfo) => {
  await page.goto('/health/nutrition'); await ready(page);
  await page.locator('#nutrition-ai-text').fill('午餐吃了一份合成验收午餐');
  await page.locator('#nutrition-ai-parse').click();
  await expect(page.locator('#nutrition-batch-dialog')).toBeVisible();
  await expect(page.locator('.nt-batch-summary')).toContainText('450.0');
  await expect(page.locator('.nt-batch-details')).not.toHaveAttribute('open', '');
  expect(testInfo.synthetic.requests.filter((request) => request.path.endsWith('/batch'))).toEqual([]);
  await page.locator('.nt-batch-summary').click();
  await page.locator('[data-draft-field="protein"]').fill('26.5');
  await page.locator('#nutrition-batch-save').click();
  await expect(page.locator('#nutrition-batch-dialog')).not.toBeVisible();
  await expect(page.locator('#nutrition-ai-text')).toHaveValue('');
  const write = testInfo.synthetic.requests.find((request) => request.path.endsWith('/batch'));
  expect(write.body.entries[0].protein).toBe('26.5');
  expect(testInfo.synthetic.entries).toHaveLength(1);
});

test('an uncertain AI save retains its description and retries the exact original operation once', async ({ page }, testInfo) => {
  testInfo.synthetic.loseNextBatchReply = true;
  await page.goto('/health/nutrition'); await ready(page);
  const description = '午餐吃了一份合成验收午餐';
  await page.locator('#nutrition-ai-text').fill(description);
  await page.locator('#nutrition-ai-parse').click();
  await expect(page.locator('#nutrition-batch-dialog')).toBeVisible();
  await page.locator('#nutrition-batch-save').click();
  await expect(page.locator('#nutrition-batch-error')).toBeVisible();
  await expect(page.locator('#nutrition-ai-text')).toHaveValue(description);
  await expect(page.locator('[data-draft-field="name"]')).toBeDisabled();
  await expect(page.locator('#nutrition-batch-save')).toBeEnabled();
  await page.locator('#nutrition-batch-save').click();
  await expect(page.locator('#nutrition-batch-dialog')).not.toBeVisible();
  const writes = testInfo.synthetic.requests.filter((request) => request.path.endsWith('/batch'));
  expect(writes).toHaveLength(2); expect(writes[0].key).toBe(writes[1].key); expect(writes[0].body).toEqual(writes[1].body);
  expect(testInfo.synthetic.entries).toHaveLength(1);
});

test('nutrition goal conflicts retain the user targets until explicitly reading and saving the latest revision', async ({ page }, testInfo) => {
  await page.goto('/health/nutrition'); await ready(page);
  await page.locator('#nutrition-goals > summary').click();
  await expect(page.locator('#nutrition-goals-save')).toBeEnabled();
  await page.locator('#nutrition-goal-calories').fill('2000');
  await page.locator('#nutrition-goal-protein').fill('100');
  testInfo.synthetic.rejectNextGoalEdit = true;
  await page.locator('#nutrition-goals-save').click();
  await expect(page.locator('#nutrition-goals-save')).toBeDisabled();
  await expect(page.locator('#nutrition-goal-protein')).toHaveValue('100');
  await page.locator('#nutrition-goals-reload').click();
  await expect(page.locator('#nutrition-goals-save')).toBeEnabled();
  await expect(page.locator('#nutrition-goal-protein')).toHaveValue('100');
  await page.locator('#nutrition-goals-save').click();
  await expect.poll(() => testInfo.synthetic.goals.protein).toBe('100.0');
  const writes = testInfo.synthetic.requests.filter((request) => request.path.endsWith('/nutrition/goals') && request.method === 'PUT');
  expect(writes).toHaveLength(2); expect(writes[0].body.expectedRevision).toBe(0); expect(writes[1].body.expectedRevision).toBe(1);
  await noHorizontalOverflow(page);
});

test('finance metadata conflict preserves the edit and requires explicitly reading the latest revision', async ({ page }, testInfo) => {
  testInfo.synthetic.rejectNextAccountEdit = true;
  await page.goto('/finance?ledger=personal&currency=CNY');
  await expect(page.locator('#status-banner')).not.toBeVisible();
  await page.locator('.account-row .row-menu > summary').first().click();
  await page.locator('[data-action="edit"]').first().click();
  await page.locator('#account-name').fill('保留这次合成修改');
  await page.locator('#account-submit').click();
  await expect(page.locator('#account-error')).toBeVisible();
  await expect(page.locator('#account-name')).toHaveValue('保留这次合成修改');
  await expect(page.locator('#account-submit')).toBeDisabled();
  await page.locator('#account-reload-latest').click();
  await expect(page.locator('#account-submit')).toBeEnabled();
  await expect(page.locator('#account-name')).toHaveValue('保留这次合成修改');
  expect(testInfo.synthetic.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  await page.locator('#account-submit').click();
  await expect(page.locator('#account-dialog')).not.toBeVisible();
  const writes = testInfo.synthetic.requests.filter((request) => request.method === 'PATCH');
  expect(writes[0].body.expectedRevision).toBe(1); expect(writes[1].body.expectedRevision).toBe(2);
});

test('a newly opened page offers explicit recovery of an unsent account draft without creating an account', async ({ page, context }, testInfo) => {
  await page.goto('/finance');
  await expect(page.locator('#status-banner')).not.toBeVisible();
  await page.locator('#add-account').click();
  await page.locator('#account-name').fill('重新打开后恢复的合成草稿');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('jiashu-work:v1:')))).toBe(true);
  await page.close();
  const next = await context.newPage();
  await next.goto('/finance');
  await expect(next.locator('#status-banner')).not.toBeVisible();
  await next.locator('#add-account').click();
  const recovery = next.locator('#account-form [data-durable-recovery]');
  await expect(recovery).toBeVisible();
  await recovery.locator('[data-durable-choice="restore"]').click();
  await expect(next.locator('#account-name')).toHaveValue('重新打开后恢复的合成草稿');
  expect(testInfo.synthetic.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  await next.screenshot({ path: testInfo.outputPath('recovered-draft.png'), fullPage: true });
});

test('history remains lazy and can be reached with the keyboard on both viewport sizes', async ({ page }, testInfo) => {
  await page.goto('/health/nutrition'); await ready(page);
  expect(testInfo.synthetic.requests.some((request) => request.path.endsWith('/review'))).toBe(false);
  const history = page.locator('#nutrition-history > summary');
  await history.focus(); await history.press('Enter');
  await expect(page.locator('#nutrition-review-summary')).toBeVisible();
  await expect.poll(() => testInfo.synthetic.requests.some((request) => request.path.endsWith('/review'))).toBe(true);
  await expect(page.locator('#nutrition-day')).toHaveValue(DAY);
  await noHorizontalOverflow(page);
});

test('record history shows prior nutrients and restores a selected revision as a new audited change', async ({ page }, testInfo) => {
  await page.goto('/health/nutrition'); await ready(page);
  await page.locator('[data-entry-method="manual"]').click();
  await page.locator('#nutrition-name').fill('修改历史验收食物');
  await page.locator('#nutrition-form-nutrients > summary').click();
  await page.locator('#nutrition-calories').fill('120');
  await page.locator('#nutrition-protein').fill('10');
  await page.locator('#nutrition-save').click();
  await expect(page.locator('#nutrition-dialog')).not.toBeVisible();
  const entryId = testInfo.synthetic.entries[0].id;
  const card = page.locator('[data-nutrition-entry="' + entryId + '"]');
  await card.locator('.nt-row-menu > summary').click();
  await card.locator('[data-nutrition-action="edit"]').click();
  if (!(await page.locator('#nutrition-form-nutrients').evaluate((element) => element.open))) await page.locator('#nutrition-form-nutrients > summary').click();
  await page.locator('#nutrition-protein').fill('20');
  await page.locator('#nutrition-save').click();
  await expect(page.locator('#nutrition-dialog')).not.toBeVisible();
  await card.locator('.nt-row-menu > summary').click();
  await page.locator('[data-nutrition-history="' + entryId + '"]').click();
  await expect(page.locator('#nutrition-record-history-dialog')).toBeVisible();
  await expect(page.locator('#nutrition-record-history-rows')).toContainText('版本 2');
  const restore = page.locator('[data-restore-nutrition-revision="1"]');
  await restore.locator('xpath=ancestor::details/summary').click();
  await expect(restore.locator('xpath=ancestor::details')).toContainText('10.0');
  await restore.click();
  await expect(page.locator('#nutrition-record-history-status')).toContainText('已恢复');
  expect(testInfo.synthetic.entries[0].revision).toBe(3);
  expect(presentNutritionEntry(testInfo.synthetic.entries[0]).protein).toBe('10.0');
  expect(testInfo.synthetic.histories.get(entryId)).toHaveLength(3);
  const operation = testInfo.synthetic.requests.find((request) => request.path.endsWith('/restore'));
  expect(operation.body).toMatchObject({ revision: 1, expectedRevision: 2 });
  await noHorizontalOverflow(page);
});
