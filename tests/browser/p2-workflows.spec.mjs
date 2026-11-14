import { test, expect } from '@playwright/test';
import { syntheticState, interceptSyntheticAPI, DAY, ACCOUNT_ID } from './synthetic-api.mjs';
import { p2State, shiftDay } from './p2-api.mjs';
import { splitBackupVolumes } from '../../lib/backup-volumes.ts';

test.beforeEach(async ({ context }, testInfo) => {
  const state = syntheticState(); p2State(state); testInfo.synthetic = state;
  await interceptSyntheticAPI(context, state);
});
test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.synthetic.externalRequests).toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('p2-acceptance-view.png'), fullPage: true });
});
async function fits(page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
const writes = (info) => info.synthetic.requests.filter((request) => request.method !== 'GET');

test('a custom health range stays aligned across chart navigation, assistant handoff, reload, and JSON download', async ({ page }, testInfo) => {
  const from = shiftDay(DAY, -6), to = shiftDay(DAY, -1);
  await page.goto('/health?metric=sleep&from=' + from + '&to=' + to);
  await expect(page.locator('#health-range-selected')).toContainText(from + ' — ' + to);
  await expect(page.locator('#chart-title')).toContainText('睡眠');
  await expect(page.locator('#sleep-analysis')).toContainText('作息与分期');
  const nextFrom = shiftDay(DAY, -4);
  await page.locator('#health-range-from').fill(nextFrom);
  await page.locator('#health-range-form button[type="submit"]').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('from')).toBe(nextFrom);
  await expect(page.locator('#health-range-selected')).toContainText('4 天');
  const expectedExport = new URL('/api/health/export?from=' + nextFrom + '&to=' + to, page.url()).href;
  await expect.poll(async () => new URL(await page.locator('#health-export-chart').getAttribute('href'), page.url()).href).toBe(expectedExport);
  await page.evaluate(() => window.addEventListener('health-assistant-open', (event) => { window.__syntheticHandoff = event.detail; }));
  await page.locator('#ask-health-chart').click();
  expect(await page.evaluate(() => window.__syntheticHandoff)).toMatchObject({ metric: 'sleep', from: nextFrom, to, days: 4 });
  expect(writes(testInfo)).toEqual([]);
  await page.reload();
  await expect(page.locator('#health-range-selected')).toContainText(nextFrom);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#health-export-chart').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('jiashu-health-' + nextFrom + '_' + to + '.json');
  await expect.poll(() => testInfo.synthetic.requests.some((request) => request.path === '/api/health/export' && request.search === '?from=' + nextFrom + '&to=' + to)).toBe(true);
  await fits(page);
});

test('sleep timing clearly distinguishes actual intervals from old duration-only records', async ({ page }, testInfo) => {
  await page.goto('/health?metric=sleep&from=' + shiftDay(DAY, -5) + '&to=' + shiftDay(DAY, -1));
  const panel = page.locator('#sleep-analysis');
  await expect(panel).toContainText('可比较完整时刻 1 天');
  await expect(panel).toContainText('有睡眠记录 2 天');
  await expect(panel).toContainText('23:00'); await expect(panel).toContainText('07:00');
  await panel.locator('details > summary').last().click();
  const detail = panel.locator('[aria-label="睡眠时刻明细"]');
  await expect(detail).toBeVisible();
  const legacy = detail.locator('tr').filter({ hasText: shiftDay(DAY, -2) });
  await expect(legacy).toContainText('未提供'); await expect(legacy).toContainText('仅有总时长');
  expect(writes(testInfo)).toEqual([]);
  await fits(page);
});

test('account liquidity preserves exact percentage and runway excludes unreviewed assets', async ({ page }, testInfo) => {
  await page.goto('/finance');
  await expect(page.locator('#status-banner')).not.toBeVisible();
  await page.locator('.account-row .row-menu > summary').first().click();
  await page.locator('[data-action="edit"]').first().click();
  await expect(page.locator('#account-classification-hint')).toContainText('今天');
  await page.locator('#account-liquidity').selectOption('restricted');
  await page.locator('#account-usable').fill('37.5');
  await page.locator('#account-submit').click();
  await expect(page.locator('#account-dialog')).not.toBeVisible();
  expect(writes(testInfo)[0].body).toMatchObject({ liquidityKind: 'restricted', usableBps: 3750, expectedRevision: 1 });
  testInfo.synthetic.accounts.push({ ...testInfo.synthetic.accounts[0], id: '22222222-2222-4222-8222-222222222222', name: '待核对合成投资', type: 'investment', liquidityKind: 'unreviewed', usableBps: 0, balanceMinor: '100000', amount: '1000.00' });
  await page.goto('/finance/runway');
  await expect(page.locator('#runway-page')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#runway-summary')).toContainText('37.50');
  await expect(page.locator('#runway-estimate')).toContainText('尚未核对');
  await expect(page.locator('#runway-accounts')).toContainText('待核对合成投资');
  await expect(page.locator('#runway-accounts')).toContainText('37.5%');
  await fits(page);
});

test('historical finance review labels baseline assumptions and separates reclassification from balance changes', async ({ page }, testInfo) => {
  testInfo.synthetic.accounts[0].type = 'loan';
  testInfo.synthetic.p2.reviewClassifications = [
    { accountId: ACCOUNT_ID, revision: 1, effectiveFrom: '1970-01-01', type: 'bank', archived: 0, origin: 'baseline', recordedAt: DAY.slice(0,7) + '-01T00:00:00Z' },
    { accountId: ACCOUNT_ID, revision: 2, effectiveFrom: DAY.slice(0,7) + '-01', type: 'loan', archived: 0, origin: 'change', recordedAt: DAY.slice(0,7) + '-01T01:00:00Z' },
  ];
  await page.goto('/finance/review?month=' + DAY.slice(0,7));
  await expect(page.locator('#review-content')).toBeVisible();
  await expect(page.locator('#review-scope')).toContainText('基线记录日前的历史无法核实');
  await expect(page.locator('#review-breakdown')).toContainText('分类调整影响 CNY -200.00');
  await expect(page.locator('#review-accounts')).toContainText('贷款（原 银行存款）');
  await expect(page.locator('#review-chart svg')).toBeVisible();
  expect(writes(testInfo)).toEqual([]);
  await fits(page);
});

test('weight cycle archive requires explicit confirmation and a new cycle preserves the archived summary', async ({ page }, testInfo) => {
  await page.goto('/health/weight-plan');
  await expect(page.locator('#weight-plan-cycle-archive-open')).toBeVisible();
  await expect(page.locator('#weight-plan-rate-7')).toContainText('7个记录日');
  await expect(page.locator('#weight-plan-sustained')).toContainText('连续7个上海日期');
  await page.locator('#weight-plan-cycle-archive-open').click();
  await expect(page.locator('#weight-plan-cycle-confirmation')).toBeVisible();
  expect(writes(testInfo)).toEqual([]);
  await page.locator('#weight-plan-cycle-confirm').click();
  await expect(page.locator('#weight-plan-cycle-start-prepare')).toBeVisible();
  expect(testInfo.synthetic.p2.cycles).toHaveLength(1);
  const snapshot = structuredClone(testInfo.synthetic.p2.cycles[0]);
  await page.locator('#weight-plan-cycle-start-prepare').click();
  await expect(page.locator('#weight-plan-baseline')).toHaveValue('');
  await page.locator('#weight-plan-baseline').fill('74.9');
  await page.locator('#weight-plan-target').fill('73');
  await page.locator('#weight-plan-deadline').fill(shiftDay(DAY, 60));
  await page.locator('#weight-plan-save').click();
  await expect.poll(() => testInfo.synthetic.p2.cycle.id).not.toBe('legacy');
  await expect(page.locator('#weight-plan-cycle-archive-open')).toBeVisible();
  expect(testInfo.synthetic.p2.cycles[0]).toEqual(snapshot);
  expect(writes(testInfo).map((request) => request.body.action)).toEqual(['archive','start']);
  expect(writes(testInfo)[1].body.expectedRevision).toBe(2);
  await fits(page);
});

test('backup volumes require explicit file downloads and local saved confirmation survives reload', async ({ page }, testInfo) => {
  await page.goto('/data/backup');
  await expect(page.locator('#backup-recent')).toContainText('尚无备份生成记录');
  await page.locator('#backup-export-volumes').click();
  await expect(page.locator('#backup-download-panel')).toBeVisible();
  await expect(page.locator('#backup-downloads a')).toHaveCount(2);
  await expect(page.locator('#backup-recent')).toContainText('网站无法判断文件是否已保存');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#backup-downloads a').first().click();
  expect((await downloadPromise).suggestedFilename()).toContain('-manifest.json');
  await page.locator('#backup-saved').click();
  await expect(page.locator('#backup-recent')).toContainText('你已确认妥善保存');
  await page.reload();
  await expect(page.locator('#backup-recent')).toContainText('你已确认妥善保存');
  expect(writes(testInfo)).toEqual([]);
  await fits(page);
});

test('backup imports require every volume and conflict details block restore even after checking confirmation', async ({ page }, testInfo) => {
  testInfo.synthetic.p2.backupConflict = true;
  const backup = structuredClone(testInfo.synthetic.p2.backup);
  backup.tables.health_goal_settings.push({ steps_target: 10000, sleep_target: null, active_energy_target: null, updated_at: backup.exportedAt, revision: 0 });
  const set = await splitBackupVolumes(backup);
  const files = [set.manifest, ...set.volumes].map((value, index) => ({ name: 'synthetic-backup-' + index + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) }));
  await page.goto('/data/backup');
  await page.locator('#backup-file').setInputFiles(files.slice(0,1));
  await expect(page.locator('#backup-status')).toContainText('清单和全部分卷');
  await expect(page.locator('#backup-preview')).toBeDisabled();
  expect(writes(testInfo)).toEqual([]);
  await page.locator('#backup-file').setInputFiles(files);
  await expect(page.locator('#backup-preview')).toBeEnabled();
  await page.locator('#backup-preview').click();
  await expect(page.locator('#backup-status')).toContainText('发现冲突');
  await page.locator('#backup-conflicts summary').click();
  await expect(page.locator('#backup-conflicts')).toContainText('当前：6000');
  await expect(page.locator('#backup-conflicts')).toContainText('备份：10000');
  await page.locator('#backup-confirm').check();
  await expect(page.locator('#backup-restore')).toBeDisabled();
  expect(writes(testInfo).map((request) => request.body.action)).toEqual(['preview']);
  await fits(page);
});
