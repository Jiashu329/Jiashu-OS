import { test, expect } from '@playwright/test';
import { syntheticState, interceptSyntheticAPI, DAY } from './synthetic-api.mjs';
import { syntheticPhotoFile, jpegDimensions } from './photo-fixture.mjs';

test.beforeEach(async ({ context }, testInfo) => {
  testInfo.synthetic = syntheticState();
  await interceptSyntheticAPI(context, testInfo.synthetic);
});

test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.synthetic.externalRequests, 'Synthetic food images never leave the local acceptance fixture').toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('food-photo-view.png'), fullPage: true });
});

const photoRequests = (state) => state.requests.filter((request) => request.path === '/api/health/nutrition/photo');
async function openPhoto(page) {
  await page.goto('/health/nutrition?compose=1');
  await expect(page.locator('#nutrition-page')).toHaveAttribute('aria-busy', 'false');
  await page.locator('[data-entry-method="photo"]').click();
  await expect(page.locator('#nutrition-entry-photo')).toBeVisible();
}
async function choosePhoto(page, file = syntheticPhotoFile()) {
  await page.locator('#nutrition-photo-file').setInputFiles(file);
  await expect(page.locator('#nutrition-photo-image')).toBeVisible();
  await expect(page.locator('#nutrition-photo-recognize')).toBeEnabled();
  await page.locator('#nutrition-photo-meal').selectOption('lunch');
}
async function noImagePersistence(page) {
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain('data:image/');
  expect(stored).not.toContain('synthetic-food.png');
  expect(stored).not.toContain('iVBORw0KGgo');
  expect(stored).not.toContain('/9j/');
}

test('album selection stays local, resizes to JPEG, and sends only after explicit recognition and batch confirmation', async ({ page }, testInfo) => {
  await page.goto('/health/nutrition?compose=1');
  await expect(page.locator('#nutrition-page')).toHaveAttribute('aria-busy', 'false');
  const retainedText = '尚未消费的独立文字描述';
  await page.locator('#nutrition-ai-text').fill(retainedText);
  await page.locator('[data-entry-method="photo"]').click();
  expect(await page.locator('#nutrition-photo-file').getAttribute('capture')).toBeNull();
  await expect(page.locator('#nutrition-photo-camera')).toHaveAttribute('capture', 'environment');
  await choosePhoto(page);
  await page.locator('#nutrition-photo-text').fill('只吃了一半，饮料未喝');
  expect(photoRequests(testInfo.synthetic)).toEqual([]);
  expect(testInfo.synthetic.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  await noImagePersistence(page);
  await page.locator('#nutrition-photo-recognize').click();
  await expect(page.locator('#nutrition-batch-dialog')).toBeVisible();
  await expect(page.locator('.nt-batch-summary')).toContainText('450.0');
  expect(testInfo.synthetic.entries).toHaveLength(0);
  const recognition = photoRequests(testInfo.synthetic)[0];
  expect(recognition.body).toMatchObject({ text: '只吃了一半，饮料未喝', date: DAY, meal: 'lunch' });
  expect(recognition.body.image.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(jpegDimensions(recognition.body.image.dataUrl)).toEqual({ width: 1600, height: 800 });
  expect(Buffer.from(recognition.body.image.dataUrl.split(',')[1], 'base64').length).toBeLessThanOrEqual(2 * 1024 * 1024);
  await noImagePersistence(page);
  await page.locator('.nt-batch-summary').click();
  await page.locator('[data-draft-field="protein"]').fill('26.5');
  expect(await page.locator('#nutrition-batch-dialog').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.locator('#nutrition-batch-save').click();
  await expect(page.locator('#nutrition-batch-dialog')).not.toBeVisible();
  const write = testInfo.synthetic.requests.find((request) => request.path.endsWith('/nutrition/batch'));
  expect(write.body.entries[0]).toMatchObject({ calories: '450.0', carbs: '50.0', protein: '26.5', fat: '16.7', date: DAY, meal: 'lunch' });
  expect(write.body.entries[0].provenance.calories.source).toBe('ai');
  await expect(page.locator('#nutrition-ai-text')).toHaveValue(retainedText);
  await noImagePersistence(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('invalid files and no-food answers never create a record or an empty review dialog', async ({ page }, testInfo) => {
  await openPhoto(page);
  await page.locator('#nutrition-photo-file').setInputFiles({ name: 'not-a-photo.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic text, not an image') });
  await expect(page.locator('#nutrition-photo-recognize')).toBeDisabled();
  expect(photoRequests(testInfo.synthetic)).toHaveLength(0);
  await choosePhoto(page, syntheticPhotoFile(200, 100));
  testInfo.synthetic.photoEmpty = true;
  await page.locator('#nutrition-photo-recognize').click();
  await expect.poll(() => photoRequests(testInfo.synthetic).length).toBe(1);
  await expect(page.locator('#nutrition-photo-recognize')).toBeEnabled();
  await expect(page.locator('#nutrition-batch-dialog')).not.toBeVisible();
  await expect(page.locator('#nutrition-photo-image')).toBeVisible();
  expect(testInfo.synthetic.entries).toHaveLength(0);
  expect(testInfo.synthetic.requests.some((request) => request.path.endsWith('/nutrition/batch'))).toBe(false);
});

test('a provider failure preserves the current photo and description until the user explicitly retries', async ({ page }, testInfo) => {
  await openPhoto(page); await choosePhoto(page, syntheticPhotoFile(200, 100));
  await page.locator('#nutrition-photo-text').fill('这份只吃了三分之一');
  testInfo.synthetic.photoFailure = { status: 503, code: 'AI_PROVIDER_UNAVAILABLE', message: '合成图片识别暂时不可用，请重试。' };
  await page.locator('#nutrition-photo-recognize').click();
  await expect(page.locator('#nutrition-photo-status')).toContainText('合成图片识别暂时不可用');
  await expect(page.locator('#nutrition-photo-image')).toBeVisible();
  await expect(page.locator('#nutrition-photo-text')).toHaveValue('这份只吃了三分之一');
  expect(photoRequests(testInfo.synthetic)).toHaveLength(1);
  await noImagePersistence(page);
  await page.locator('#nutrition-photo-recognize').click();
  await expect(page.locator('#nutrition-batch-dialog')).toBeVisible();
  const requests = photoRequests(testInfo.synthetic);
  expect(requests).toHaveLength(2); expect(requests[1].body).toEqual(requests[0].body);
  expect(testInfo.synthetic.entries).toHaveLength(0);
});

test('removing a photo while recognition is pending prevents a late answer from opening or overwriting a draft', async ({ page }, testInfo) => {
  await openPhoto(page); await choosePhoto(page, syntheticPhotoFile(200, 100));
  let release;
  testInfo.synthetic.photoGate = new Promise((resolve) => { release = resolve; });
  await page.locator('#nutrition-photo-recognize').click();
  await expect.poll(() => photoRequests(testInfo.synthetic).length).toBe(1);
  await page.locator('#nutrition-photo-remove').click();
  await expect(page.locator('#nutrition-photo-image')).not.toBeVisible();
  release();
  await expect.poll(() => testInfo.synthetic.photoAnswered).toBe(1);
  await expect(page.locator('#nutrition-batch-dialog')).not.toBeVisible();
  await expect(page.locator('#nutrition-photo-recognize')).toBeDisabled();
  expect(testInfo.synthetic.entries).toHaveLength(0);
  await noImagePersistence(page);
});

test('an uncertain photo batch save protects the original operation from another recognition request', async ({ page }, testInfo) => {
  await openPhoto(page); await choosePhoto(page, syntheticPhotoFile(200, 100));
  await page.locator('#nutrition-photo-recognize').click();
  await expect(page.locator('#nutrition-batch-dialog')).toBeVisible();
  testInfo.synthetic.loseNextBatchReply = true;
  await page.locator('#nutrition-batch-save').click();
  await expect(page.locator('#nutrition-batch-error')).toBeVisible();
  await page.locator('[data-nutrition-batch-close]').first().click();
  await expect(page.locator('#nutrition-batch-dialog')).not.toBeVisible();
  await expect(page.locator('#nutrition-photo-recognize')).toBeDisabled();
  expect(photoRequests(testInfo.synthetic)).toHaveLength(1);
  const writes = testInfo.synthetic.requests.filter((request) => request.path.endsWith('/nutrition/batch'));
  expect(writes).toHaveLength(1); expect(testInfo.synthetic.entries).toHaveLength(1);
});
