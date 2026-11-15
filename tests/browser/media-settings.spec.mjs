import { test, expect } from '@playwright/test';
import { syntheticState, interceptSyntheticAPI } from './synthetic-api.mjs';

const ENDPOINT = '/api/media/tmdb/settings';
const STAMP = '2026-11-14T08:00:00.000Z';
const SYNTHETIC_TOKEN = 'synthetic-tmdb-token-DO-NOT-ECHO';

test.beforeEach(async ({ context, page }, testInfo) => {
  const state = syntheticState();
  state.tmdbCanManage = true; state.tmdbAllowWrites = false;
  state.tmdbSettings = { configured: false, revision: 0, updatedAt: null, lastTestStatus: null, lastTestAt: null };
  testInfo.synthetic = state;
  await interceptSyntheticAPI(context, state);
  await page.route('**/api/media/tmdb/settings**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), body = request.postDataJSON() ?? null;
    state.requests.push({ path: url.pathname, method, body });
    const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store', 'X-Account-Owner': state.owner }, body: JSON.stringify(value) });
    const result = () => ({ scope: 'site', canManage: state.tmdbCanManage, storageReady: true, settings: state.tmdbSettings });
    if (method === 'GET' && url.pathname === ENDPOINT) return send(result());
    if (!state.tmdbAllowWrites || !state.tmdbCanManage) return send({ error: '未授权的合成配置写入。', code: 'TMDB_SETTINGS_FORBIDDEN' }, 403);
    expect(request.headers()['x-page-owner']).toBe(state.owner);
    expect(body.expectedRevision).toBe(state.tmdbSettings.revision);
    if (method === 'PUT' && url.pathname === ENDPOINT) {
      expect(Object.keys(body).sort()).toEqual(['expectedRevision', 'token']);
      expect(body.token).toBe(SYNTHETIC_TOKEN);
      state.tmdbSettings = { ...state.tmdbSettings, configured: true, revision: state.tmdbSettings.revision + 1, updatedAt: STAMP };
      return send(result());
    }
    if (method === 'POST' && url.pathname === ENDPOINT + '/test') {
      expect(body).toEqual({ expectedRevision: state.tmdbSettings.revision });
      state.tmdbSettings = { ...state.tmdbSettings, lastTestStatus: 'success', lastTestAt: STAMP };
      return send(result());
    }
    if (method === 'DELETE' && url.pathname === ENDPOINT) {
      expect(body).toEqual({ expectedRevision: state.tmdbSettings.revision });
      state.tmdbSettings = { configured: false, revision: state.tmdbSettings.revision + 1, updatedAt: STAMP, lastTestStatus: null, lastTestAt: null };
      return send(result());
    }
    return send({ error: '未知的合成配置写入。', code: 'SYNTHETIC_TMDB_SETTINGS_REQUEST' }, 400);
  });
});
test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.synthetic.externalRequests).toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('media-settings-acceptance.png'), fullPage: true });
});
const writes = info => info.synthetic.requests.filter(request => request.path.startsWith(ENDPOINT) && request.method !== 'GET');
async function openSettings(page) {
  await page.goto('/settings/media');
  await expect(page.locator('#tmdb-page')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test('the owner explicitly saves a shared token without echoing it, tests it and confirms deletion', async ({ page }, testInfo) => {
  const state = testInfo.synthetic; state.tmdbAllowWrites = true;
  await openSettings(page);
  expect(writes(testInfo)).toEqual([]);
  await expect(page.locator('#tmdb-token')).toHaveAttribute('type', 'password');
  await expect(page.locator('#tmdb-token')).toHaveValue('');
  await expect(page.locator('#tmdb-token')).toHaveAttribute('autocomplete', 'new-password');
  await page.locator('#tmdb-token').fill(SYNTHETIC_TOKEN);
  await page.locator('#tmdb-save').click();
  await expect(page.locator('#tmdb-configured')).toContainText('Token 不回显');
  await expect(page.locator('#tmdb-token')).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(SYNTHETIC_TOKEN);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(SYNTHETIC_TOKEN);
  await page.locator('#tmdb-test').click();
  await expect(page.locator('#tmdb-tested')).toContainText('测试成功');
  await page.locator('#tmdb-delete-open').click();
  expect(writes(testInfo).map(request => request.method)).toEqual(['PUT', 'POST']);
  await expect(page.locator('#tmdb-delete-confirm')).toBeVisible();
  await page.locator('#tmdb-delete-submit').click();
  await expect(page.locator('#tmdb-configured')).toHaveText('尚未配置');
  expect(writes(testInfo).map(request => request.body)).toEqual([{ token: SYNTHETIC_TOKEN, expectedRevision: 0 }, { expectedRevision: 1 }, { expectedRevision: 1 }]);
  await page.locator('#tmdb-token').fill(SYNTHETIC_TOKEN);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('#tmdb-token')).toHaveValue('');
});

test('members can view the shared configuration status while secret controls and synthetic forced submits remain read-only', async ({ page }, testInfo) => {
  const state = testInfo.synthetic; state.tmdbCanManage = false; state.tmdbSettings.configured = true;
  await openSettings(page);
  await expect(page.locator('#tmdb-manage')).toBeHidden();
  await expect(page.locator('#tmdb-token')).toBeDisabled();
  await expect(page.locator('#tmdb-token')).toHaveValue('');
  await expect(page.locator('#tmdb-shared-note')).toContainText('无需填写');
  await page.evaluate(() => {
    document.getElementById('tmdb-token').value = 'synthetic-unauthorized-secret';
    document.getElementById('tmdb-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (const id of ['test', 'delete-open', 'delete-submit']) document.getElementById('tmdb-' + id).dispatchEvent(new Event('click', { bubbles: true }));
  });
  expect(writes(testInfo)).toEqual([]);
});

test('an account change clears a token draft and blocks it from being sent as the next account', async ({ page }, testInfo) => {
  await openSettings(page);
  await page.locator('#tmdb-token').fill(SYNTHETIC_TOKEN);
  testInfo.synthetic.owner = 'another-synthetic-account';
  await page.locator('#tmdb-save').click();
  await expect(page.locator('html')).toHaveAttribute('data-account-changed', '');
  await expect(page.locator('#tmdb-token')).toHaveValue('');
  await expect(page.locator('#tmdb-save')).toBeDisabled();
  expect(writes(testInfo)).toEqual([]);
});
