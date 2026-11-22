import { test, expect } from '@playwright/test';
import { interceptSyntheticAPI, syntheticState } from './synthetic-api.mjs';

test('Apple Health trends and workouts honor the selected dates and distinguish missing samples from a failed read', async ({ context, page }) => {
  const state = syntheticState();
  await interceptSyntheticAPI(context, state);
  await page.clock.setFixedTime(new Date('2026-11-22T14:00:00Z'));
  const vitalSamples = [
    { day: '2026-11-21', heartRate: { average: 76.2, min: 52, max: 141 },
      oxygenSaturation: { latest: 97.3, average: 97.6, min: 96, max: 99, count: 3, measuredAt: '2026-11-20T23:32:00Z' } },
    { day: '2026-11-19', heartRate: { average: 72, min: 50, max: 139 },
      restingHeartRate: { value: 56, measuredAt: '2026-11-19T02:00:00Z' } },
  ];
  const workoutSamples = [
    { id: '88eaea29-6064-4a1c-8f26-ecfaa7347cd3', activityType: 37, startDate: '2026-11-20T23:10:00Z', endDate: '2026-11-20T23:52:00Z', durationSeconds: 2400, energyKcal: 288, distanceMeters: 5072 },
    { id: '88eaea29-6064-4a1c-8f26-ecfaa7347cd4', activityType: 9999, startDate: '2026-11-19T10:00:00Z', endDate: '2026-11-19T10:35:00Z', durationSeconds: 2050 },
  ];
  const requests = [];
  let fail = false;
  await page.route('**/api/health/apple-activity?**', async route => {
    const { searchParams } = new URL(route.request().url());
    const from = searchParams.get('from'), to = searchParams.get('to');
    requests.push({ from, to });
    const vitals = vitalSamples.filter(value => value.day >= from && value.day <= to);
    const workouts = from === '2026-11-16' ? workoutSamples : [];
    await route.fulfill({ status: fail ? 503 : 200, headers: { 'X-Account-Owner': state.owner },
      json: fail ? { error: '暂时无法读取苹果健康记录。' } : { from, to, vitals, workouts } });
  });

  await page.goto('/health');
  await page.getByRole('link', { name: '心率、血氧与训练' }).click();
  await expect(page.locator('#activity-results')).toBeVisible();
  expect(requests[0]).toEqual({ from: '2026-10-24', to: '2026-11-22' });
  await page.getByRole('button', { name: '7 天', exact: true }).click();
  await expect(page.locator('#activity-heart-rate-value')).toHaveText('76.2');
  await expect(page.locator('#activity-heart-rate-plot span')).toHaveCount(7);
  await expect(page.locator('#activity-resting-heart-rate-value')).toHaveText('56');
  await expect(page.locator('#activity-oxygen-value')).toHaveText('97.3');
  await expect(page.getByRole('row', { name: /2026-11-21/ })).toContainText('97.6%');
  await expect(page.getByRole('row', { name: /2026-11-21/ })).toContainText('3 次采样');
  await expect(page.getByRole('row', { name: /2026-11-19/ })).toContainText('—');
  await expect(page.locator('.activity-workout').first()).toContainText('跑步');
  await expect(page.locator('.activity-workout').first()).toContainText('40 分');
  await expect(page.locator('.activity-workout').first()).toContainText('5.07 公里');
  await expect(page.locator('.activity-workout').last()).toContainText('其他训练');
  await expect(page.locator('.activity-workout').last()).not.toContainText('活动能量');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width + 1);
  expect(await page.locator('#activity-vitals-table').evaluate(node => node.scrollWidth)).toEqual(await page.locator('#activity-vitals-table').evaluate(node => node.clientWidth));

  const filter = page.getByRole('region', { name: '日期范围', exact: true });
  await filter.getByText('自定日期', { exact: true }).click();
  await filter.getByLabel('开始日期').fill('2026-11-13');
  await filter.getByLabel('结束日期').fill('2026-11-14');
  fail = true;
  await filter.getByRole('button', { name: '应用日期' }).click();
  await expect(page.locator('#activity-status-text')).toHaveText('暂时无法读取苹果健康记录。');
  await expect(page.locator('#activity-results')).toBeHidden();
  fail = false;
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.locator('#activity-vitals-empty')).toBeVisible();
  await expect(page.locator('#activity-workouts-empty')).toBeVisible();
  await expect(page.locator('#activity-help')).toContainText('苹果健康授权');
  await expect(page.locator('#activity-oxygen-value')).toHaveText('暂无记录');
  expect(requests.at(-1)).toEqual({ from: '2026-11-13', to: '2026-11-14' });

  await page.goBack();
  await expect(page.locator('.activity-workout')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '7 天', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(state.externalRequests).toEqual([]);
});
