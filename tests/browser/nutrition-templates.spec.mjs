import { test, expect } from '@playwright/test';
import { syntheticState, interceptSyntheticAPI } from './synthetic-api.mjs';
import { syntheticNutritionTemplate } from './nutrition-templates-api.mjs';

test.beforeEach(async ({ context }, testInfo) => {
  testInfo.synthetic = syntheticState();
  await interceptSyntheticAPI(context, testInfo.synthetic);
});

test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.synthetic.externalRequests, 'Template inputs stay inside the local synthetic fixture').toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('nutrition-template-view.png'), fullPage: true });
});

async function openTemplates(page) {
  await page.goto('/health/nutrition');
  await expect(page.locator('#nutrition-page')).toHaveAttribute('aria-busy', 'false');
  await page.locator('[data-entry-method="quick"]').click();
  const disclosure = page.locator('#nutrition-templates > summary');
  await disclosure.focus();
  await disclosure.press('Enter');
  await expect(page.locator('#nutrition-templates')).toHaveAttribute('open', '');
  await expect(page.locator('#nutrition-templates-status')).not.toContainText('正在读取');
}

async function fitsViewport(page, dialog) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  if (dialog) {
    expect(await page.locator(dialog).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'Template dialogs must not require horizontal scrolling').toBe(true);
  }
}

async function fillPersonalFood(page) {
  await page.locator('#nutrition-template-new').click();
  await page.locator('#nutrition-template-name').fill('合成自建牛奶');
  const component = page.locator('[data-template-component="0"]');
  await component.locator('[data-template-field="name"]').fill('合成盒装牛奶');
  await component.locator('[data-template-field="portion"]').fill('1盒');
  await component.locator('[data-template-field="calories"]').fill('120');
  await component.locator('[data-template-field="protein"]').fill('0');
  await component.locator('[data-template-field="fat"]').fill('2');
  await component.locator('details > summary').click();
  await component.locator('[data-template-source="calories"]').selectOption('label');
  await component.locator('[data-template-basis="calories"]').fill('合成包装每盒120kcal');
}

test('personal food templates are keyboard reachable, retain unknown and zero, and save independently of meals', async ({ page }, testInfo) => {
  await openTemplates(page);
  await fillPersonalFood(page);
  await fitsViewport(page, '#nutrition-template-dialog');
  await page.locator('#nutrition-template-save').click();
  await expect(page.locator('#nutrition-template-dialog')).not.toBeVisible();
  await expect(page.locator('#nutrition-template-list')).toContainText('合成自建牛奶');
  expect(testInfo.synthetic.templates).toHaveLength(1);
  expect(testInfo.synthetic.templates[0].components[0]).toMatchObject({ calories: '120.0', carbs: null, protein: '0.0', fat: '2.0', provenance: { calories: { source: 'label', basis: '合成包装每盒120kcal' } } });
  expect(testInfo.synthetic.entries).toHaveLength(0);
  expect(testInfo.synthetic.requests.some((request) => request.path.endsWith('/nutrition/batch'))).toBe(false);
  await fitsViewport(page);
});

test('recipe serving preview exposes unknown ingredients and waits for explicit batch save', async ({ page }, testInfo) => {
  testInfo.synthetic.templates = [syntheticNutritionTemplate('recipe')];
  await openTemplates(page);
  await page.locator('[data-template-use]').click();
  await page.locator('#nutrition-template-scale-amount').fill('1');
  await page.locator('#nutrition-template-preview').click();
  await expect(page.locator('#nutrition-template-confirm')).toBeEnabled();
  await expect(page.locator('#nutrition-template-use-status')).toContainText('碳水化合物 10.0 g（1 项未知）');
  await expect(page.locator('#nutrition-template-preview-rows li')).toHaveCount(1);
  await expect(page.locator('#nutrition-template-preview-rows')).toContainText('碳水化合物 未填');
  expect(testInfo.synthetic.entries).toHaveLength(0);
  await fitsViewport(page, '#nutrition-template-use-dialog');
  await page.locator('#nutrition-template-confirm').click();
  await expect(page.locator('#nutrition-batch-dialog')).toBeVisible();
  expect(testInfo.synthetic.requests.some((request) => request.path.endsWith('/nutrition/batch'))).toBe(false);
  await fitsViewport(page, '#nutrition-batch-dialog');
  await page.locator('#nutrition-batch-save').click();
  await expect(page.locator('#nutrition-batch-dialog')).not.toBeVisible();
  expect(testInfo.synthetic.entries).toHaveLength(1);
  expect(testInfo.synthetic.entries[0]).toMatchObject({ name: '合成酸奶燕麦杯', caloriesTenth: 750, carbsTenth: null, proteinTenth: 30, fatTenth: 5 });
});

test('whole meal weight preview keeps separate foods and their source metadata', async ({ page }, testInfo) => {
  testInfo.synthetic.templates = [syntheticNutritionTemplate('meal')];
  await openTemplates(page);
  await page.locator('[data-template-use]').click();
  await page.locator('#nutrition-template-scale-mode').selectOption('weight');
  await page.locator('#nutrition-template-scale-amount').fill('75');
  await page.locator('#nutrition-template-preview').click();
  await expect(page.locator('#nutrition-template-confirm')).toBeEnabled();
  await expect(page.locator('#nutrition-template-preview-rows li')).toHaveCount(2);
  await expect(page.locator('#nutrition-template-preview-rows')).toContainText('25g');
  await expect(page.locator('#nutrition-template-preview-rows')).toContainText('50g');
  await fitsViewport(page, '#nutrition-template-use-dialog');
  await page.locator('#nutrition-template-confirm').click();
  await expect(page.locator('#nutrition-batch-dialog')).toBeVisible();
  await page.locator('#nutrition-batch-save').click();
  await expect(page.locator('#nutrition-batch-dialog')).not.toBeVisible();
  expect(testInfo.synthetic.entries).toHaveLength(2);
  const write = testInfo.synthetic.requests.find((request) => request.path.endsWith('/nutrition/batch'));
  expect(write.body.entries[0]).toMatchObject({ calories: '25.0', fat: '0.0', provenance: { calories: { source: 'label', basis: '合成包装标签' } } });
  expect(write.body.entries[1]).toMatchObject({ calories: '12.5', carbs: null });
});

test('a lost template save response is resumed after reload with the original operation and no duplicate template', async ({ page }, testInfo) => {
  await openTemplates(page);
  await fillPersonalFood(page);
  testInfo.synthetic.loseNextTemplateReply = true;
  await page.locator('#nutrition-template-save').click();
  await expect(page.locator('#nutrition-template-pending')).toBeVisible();
  await expect(page.locator('#nutrition-template-resume')).toBeEnabled();
  await expect(page.locator('#nutrition-template-name')).toBeDisabled();
  expect(testInfo.synthetic.templates).toHaveLength(1);
  await page.locator('[data-template-editor-close]').first().click();
  await page.reload();
  await expect(page.locator('#nutrition-page')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#nutrition-template-pending')).toBeVisible();
  let writes = testInfo.synthetic.requests.filter((request) => request.path === '/api/health/nutrition/templates' && request.method === 'POST');
  expect(writes).toHaveLength(1);
  await page.locator('#nutrition-template-resume').click();
  await expect(page.locator('#nutrition-template-pending')).not.toBeVisible();
  writes = testInfo.synthetic.requests.filter((request) => request.path === '/api/health/nutrition/templates' && request.method === 'POST');
  expect(writes).toHaveLength(2); expect(writes[1].key).toBe(writes[0].key); expect(writes[1].body).toEqual(writes[0].body);
  expect(testInfo.synthetic.templates).toHaveLength(1);
  expect(testInfo.synthetic.entries).toHaveLength(0);
});
