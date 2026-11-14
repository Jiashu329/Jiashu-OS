import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { syntheticState, interceptSyntheticAPI } from './synthetic-api.mjs';
import { parseDoubanProfile } from '../../lib/douban.ts';

const PROFILE = 'synthetic-douban-user';
const STAMP = '2026-11-14T08:00:00.000Z';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const KINDS = ['movie', 'series', 'book', 'music', 'screen'];

function record(kind, index = 0, profileId = PROFILE) {
  const domain = kind === 'movie' || kind === 'series' || kind === 'screen' ? 'screen' : kind;
  const subjectId = String(9000000 + index), host = domain === 'screen' ? 'movie' : domain;
  return { profileId, domain, subjectId, kind, title: '合成' + ({ movie: '电影', series: '电视剧', book: '图书', music: '音乐', screen: '待分类影视' }[kind]) + index,
    url: 'https://' + host + '.douban.com/subject/' + subjectId + '/', coverUrl: null, rating: 4,
    markedDate: '2026-11-12', comment: '合成个人短评', publishedAt: null, source: 'collection',
    observedAt: STAMP, createdAt: STAMP, updatedAt: STAMP };
}
function source(status = 'pending', received = 0) {
  return { status, pages: received ? 1 : 0, received, total: status === 'complete' ? received : null, errorCode: status === 'blocked' ? 'DOUBAN_ACCESS_DENIED' : null };
}
function newRun(connection) {
  return { id: RUN_ID, profileId: connection.profileId, connectionRevision: connection.revision, revision: 0,
    status: 'running', phase: 'collections', sources: { screen: source(), book: source(), music: source() },
    rss: { status: 'pending', received: 0, errorCode: null }, classification: { checked: 0, unclassified: 0, blocked: false, errorCode: null },
    added: 0, updated: 0, unchanged: 0, message: '公开记录同步已准备好，等待读取第一页。',
    createdAt: STAMP, startedAt: STAMP, updatedAt: STAMP, finishedAt: null };
}
function listResult(state, params) {
  const scope = params.get('profile') ?? 'all', kind = params.get('kind') ?? '', query = (params.get('q') ?? '').trim().toLowerCase();
  const owned = state.doubanItems.filter(item => scope !== 'current' || item.profileId === state.doubanConnection.profileId);
  const filtered = owned.filter(item => (!kind || kind === 'all' || item.kind === kind) && (!query || item.title.toLowerCase().includes(query)));
  const offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 24);
  return { connection: state.doubanConnection, items: filtered.slice(offset, offset + limit), total: filtered.length,
    counts: Object.fromEntries(['all', ...KINDS].map(key => [key, key === 'all' ? owned.length : owned.filter(item => item.kind === key).length])),
    offset, limit, hasMore: offset + limit < filtered.length, lastRun: state.doubanRun };
}
const mutations = info => info.synthetic.requests.filter(request => request.path.startsWith('/api/life/douban') && request.method !== 'GET');
const syncRequests = info => mutations(info).filter(request => request.path === '/api/life/douban/sync');

test.beforeEach(async ({ context, page }, testInfo) => {
  const state = syntheticState();
  state.doubanConnection = { profileId: null, profileUrl: null, revision: 0, updatedAt: null };
  state.doubanItems = []; state.doubanRun = null; state.doubanHoldStep = false; state.doubanStepPending = false;
  state.doubanImportPreview = null; state.doubanImportReceipts = new Map(); state.doubanLoseImportReply = false;
  state.doubanFailedCovers = new Set(); state.doubanMetadataResults = new Map(); state.doubanMetadataVersion = 0;
  testInfo.synthetic = state;
  await interceptSyntheticAPI(context, state);
  await page.route('**/api/life/douban**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), body = request.postDataJSON() ?? null;
    state.requests.push({ path: url.pathname, search: url.search, method, body });
    const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store', 'X-Account-Owner': state.owner }, body: JSON.stringify(value) });
    const fail = (message, code, status = 409) => send({ error: message, code }, status);
    if (url.pathname === '/api/life/douban' && method === 'GET') return send(listResult(state, url.searchParams));
    if ((url.pathname === '/api/life/douban/metadata' && method === 'POST') || (url.pathname === '/api/life/douban/classification' && method === 'PUT')) {
      const item = state.doubanItems.find(value => value.profileId === body.profileId && value.domain === body.domain && value.subjectId === body.subjectId);
      if (!item) return fail('条目不存在。', 'DOUBAN_ITEM_NOT_FOUND', 404);
      if (body.expectedUpdatedAt !== item.updatedAt) return fail('条目已更新，请重新核对。', 'DOUBAN_ITEM_CONFLICT');
      if (url.pathname.endsWith('/classification')) {
        if (body.domain !== 'screen' || !['movie', 'series'].includes(body.kind)) return fail('请选择电影或电视剧。', 'DOUBAN_INVALID_CLASSIFICATION', 400);
        item.kind = body.kind;
        item.updatedAt = new Date(Date.parse(STAMP) + ++state.doubanMetadataVersion).toISOString();
        return send({ item });
      }
      if (body.confirmed !== true) return fail('请明确确认补全此条目。', 'DOUBAN_METADATA_CONFIRMATION_REQUIRED', 400);
      const metadata = state.doubanMetadataResults.get(item.subjectId);
      if (!metadata || metadata.unavailable) return send({ item, changed: false, metadata: { status: 'unavailable', message: '合成来源暂不可用，原记录仍保留。' } });
      if (metadata.kind) item.kind = metadata.kind;
      if (metadata.coverUrl) item.coverUrl = metadata.coverUrl;
      item.updatedAt = new Date(Date.parse(STAMP) + ++state.doubanMetadataVersion).toISOString();
      return send({ item, changed: true, metadata: { status: 'complete' } });
    }
    if (url.pathname === '/api/life/douban/cover' && method === 'GET') {
      const item = state.doubanItems.find(value => value.profileId === url.searchParams.get('profileId')
        && value.domain === url.searchParams.get('domain') && value.subjectId === url.searchParams.get('subjectId'));
      if (!item?.coverUrl) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'No stored cover' });
      if (state.doubanFailedCovers.has(item.subjectId)) return route.fulfill({ status: 502, contentType: 'text/plain', body: 'Synthetic cover unavailable' });
      return route.fulfill({ status: 200, contentType: 'image/png', body: await readFile(new URL('../../public/brand/favicon-32.png', import.meta.url)) });
    }
    if (url.pathname === '/api/life/douban/import' && method === 'POST') {
      const profile = parseDoubanProfile(body.profile), items = body.items;
      if (!Array.isArray(items) || !items.length || items.some(item => item.source !== 'import')) return fail('请提交本地解析后的本人资料。', 'SYNTHETIC_IMPORT_INVALID', 400);
      const snapshotHash = 'a'.repeat(64), payload = JSON.stringify({ profileId: profile.profileId, items });
      if (body.action === 'preview') {
        state.doubanImportPreview = { snapshotHash, payload };
        return send({ preview: { ...profile, snapshotHash, total: items.length, added: items.length, updated: 0, unchanged: 0 } });
      }
      const replay = state.doubanImportReceipts.get(body.requestId);
      if (replay) return replay.payload === payload ? send({ receipt: replay.receipt }) : fail('原操作内容已变化。', 'DOUBAN_IMPORT_CONFLICT');
      if (body.action !== 'commit' || body.confirmed !== true || !/^[0-9a-f-]{36}$/i.test(body.requestId)
        || body.expectedSnapshotHash !== state.doubanImportPreview?.snapshotHash || payload !== state.doubanImportPreview?.payload) {
        return fail('导入预览已变化，请重新预览。', 'DOUBAN_IMPORT_CONFLICT');
      }
      state.doubanItems.push(...items.map(item => ({ ...item, profileId: profile.profileId, observedAt: STAMP, createdAt: STAMP, updatedAt: STAMP })));
      const receipt = { profileId: profile.profileId, requestId: body.requestId, total: items.length, added: items.length, updated: 0, unchanged: 0 };
      state.doubanImportReceipts.set(body.requestId, { payload, receipt });
      if (state.doubanLoseImportReply) { state.doubanLoseImportReply = false; return route.abort('connectionreset'); }
      return send({ receipt });
    }
    if (url.pathname === '/api/life/douban/connection' && method === 'PUT') {
      if (body.expectedRevision !== state.doubanConnection.revision) return fail('请读取最新配置后再保存。', 'DOUBAN_CONNECTION_CONFLICT');
      const profile = body.profile === null ? { profileId: null, profileUrl: null } : parseDoubanProfile(body.profile);
      state.doubanConnection = { ...profile, revision: state.doubanConnection.revision + 1, updatedAt: STAMP };
      state.doubanRun = null;
      return send({ connection: state.doubanConnection });
    }
    if (url.pathname === '/api/life/douban/sync' && method === 'POST') {
      if (body.expectedConnectionRevision !== state.doubanConnection.revision) return fail('绑定配置已更新。', 'DOUBAN_CONNECTION_CONFLICT');
      if (!body.runId) {
        state.doubanRun ??= newRun(state.doubanConnection);
      } else {
        if (body.runId !== state.doubanRun?.id || body.expectedRunRevision !== state.doubanRun.revision) return fail('同步进度已更新，请读取最新进度。', 'DOUBAN_RUN_CONFLICT');
        if (state.doubanHoldStep) {
          state.doubanHoldStep = false; state.doubanStepPending = true;
          await new Promise(resolve => { state.doubanReleaseStep = resolve; });
          state.doubanStepPending = false;
        }
        state.doubanRun.revision++;
        if (state.doubanRun.revision === 1) {
          state.doubanItems = [record('movie', 1), record('screen', 2)];
          state.doubanRun.sources.screen = source('complete', 2); state.doubanRun.added = 2;
          state.doubanRun.message = '已读取公开影视记录，可继续同步其余分类。';
        } else {
          state.doubanItems = [record('movie', 1), record('screen', 2), record('book', 3), record('music', 4)];
          Object.assign(state.doubanRun, { status: 'partial', phase: 'done', added: 4, finishedAt: STAMP,
            sources: { screen: source('complete', 2), book: source('blocked'), music: source('complete', 1) },
            rss: { status: 'complete', received: 1, errorCode: null },
            classification: { checked: 1, unclassified: 1, blocked: true, errorCode: 'DOUBAN_ACCESS_DENIED' },
            message: '部分完成：图书公开页面受访问限制，已保留已有记录并补充近期 RSS；这不代表历史全量。' });
        }
      }
      return send({ connection: state.doubanConnection, run: state.doubanRun, more: state.doubanRun.status === 'running' });
    }
    return fail('不支持的合成测试请求。', 'SYNTHETIC_DOUBAN_REQUEST', 400);
  });
});
test.afterEach(async ({ page }, testInfo) => {
  testInfo.synthetic.doubanReleaseStep?.();
  expect(testInfo.synthetic.externalRequests, 'Synthetic library records must not contact Douban or another external service').toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('douban-acceptance.png'), fullPage: true });
});
async function openLibrary(page) {
  await page.goto('/life/douban');
  await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
}
async function fits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The book and media library must fit desktop and 390px layouts').toBe(true);
}
function bind(state) {
  state.doubanConnection = { profileId: PROFILE, profileUrl: 'https://www.douban.com/people/' + PROFILE + '/', revision: 1, updatedAt: STAMP };
}
function extensionItem(kind, index) {
  const { profileId: _profileId, observedAt: _observedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...item } = record(kind, index);
  return { ...item, source: 'import' };
}
async function installExtensionMock(context, pages, options = {}) {
  await context.addInitScript(({ pages, options }) => {
    // The narrow project also exercises a resized desktop extension window.
    // Real iPhone/Safari support is deliberately not implied by this mock.
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 Synthetic Desktop Chrome/130.0.0.0 Safari/537.36' });
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { mobile: false } });
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111', results = new Map();
    const state = { calls: [], reads: 0, holdStep: options.holdStep ?? null, release: null, pending: false, lostReply: Boolean(options.lostReply) };
    window.__doubanExtensionMock = state;
    const progress = step => ({ status: step >= pages.length ? 'completed' : 'running', accountProfileId: 'synthetic-douban-user',
      received: pages.slice(0, step).flat().length, pages: step,
      sources: Object.fromEntries(['screen', 'book', 'music'].map(domain => {
        const items = pages.slice(0, step).flat().filter(item => item.domain === domain);
        return [domain, { status: step >= pages.length ? 'complete' : 'pending', start: items.length, pages: items.length ? 1 : 0,
          segmentPages: items.length ? 1 : 0, received: items.length, total: step >= pages.length ? items.length : null, lastPageIds: null, errorCode: null }];
      })) });
    const runtime = { sendMessage(id, body, callback) {
      state.calls.push({ id, body: structuredClone(body) });
      const reply = value => queueMicrotask(() => callback(value));
      if (['CONNECT', 'STATUS'].includes(body.action)) return reply({ ok: true, data: { extensionVersion: '1.0.2', protocolVersion: 1 } });
      if (body.action === 'START') return reply({ ok: true, data: { runId, step: 0, progress: progress(0), done: false } });
      if (body.action === 'CANCEL') return reply({ ok: true, data: { runId, step: state.reads, progress: { ...progress(state.reads), status: 'cancelled' }, done: true } });
      if (body.action !== 'STEP' || body.runId !== runId || !pages[body.step]) return reply({ ok: false, error: { code: 'STEP_CONFLICT', message: '合成扩展进度错误。' } });
      const key = body.step + ':' + body.requestId;
      if (!results.has(key)) {
        state.reads++;
        results.set(key, { ok: true, data: { runId, step: body.step + 1, progress: progress(body.step + 1), done: body.step + 1 === pages.length, items: pages[body.step] } });
      }
      const complete = () => {
        state.pending = false; state.release = null;
        if (state.lostReply) { state.lostReply = false; queueMicrotask(() => { runtime.lastError = { message: 'Synthetic reply was lost after reading' }; callback(); delete runtime.lastError; }); }
        else reply(structuredClone(results.get(key)));
      };
      if (state.holdStep === body.step) { state.holdStep = null; state.pending = true; state.release = complete; }
      else complete();
    } };
    window.chrome = window.chrome || {};
    window.chrome.runtime = runtime;
  }, { pages, options });
}
async function extensionCalls(page, action) {
  return page.evaluate(action => window.__doubanExtensionMock.calls.filter(call => !action || call.body.action === action), action);
}

test('a personal profile is saved separately from explicit public syncing and limited sources remain visibly partial', async ({ page }, testInfo) => {
  await openLibrary(page);
  expect(mutations(testInfo)).toEqual([]);
  await expect(page.locator('#douban-browser-sync')).toBeDisabled();
  if (testInfo.project.name === 'mobile-390-chromium') await expect(page.locator('#douban-browser-status')).toContainText('手机或当前浏览器暂不支持扩展同步');
  await page.locator('#douban-profile').fill('https://www.douban.com/people/' + PROFILE + '/');
  await page.locator('#douban-save').click();
  await expect.poll(() => testInfo.synthetic.doubanConnection.profileId).toBe(PROFILE);
  expect(syncRequests(testInfo)).toEqual([]);
  expect(mutations(testInfo)[0].body).toEqual({ profile: 'https://www.douban.com/people/' + PROFILE + '/', expectedRevision: 0 });
  await page.locator('#douban-sync').click();
  await expect.poll(() => testInfo.synthetic.doubanRun?.status).toBe('partial');
  await expect(page.locator('#douban-sync-status')).toContainText(/部分|受限|限制/);
  await expect(page.locator('#douban-run-summary')).toContainText(/RSS|近期/);
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(4);
  expect(syncRequests(testInfo)[0].body).toEqual({ expectedConnectionRevision: 1 });
  expect(syncRequests(testInfo).slice(1).every(request => request.body.runId === RUN_ID && Number.isInteger(request.body.expectedRunRevision))).toBe(true);
  expect(JSON.stringify(mutations(testInfo).map(request => request.body))).not.toMatch(/cookie|password|userId|synthetic-owner/);
  await fits(page);
  await page.locator('#douban-list').screenshot({ path: testInfo.outputPath('douban-library-cards.png') });
});

test('movies, series, books, music and unclassified screen records stay searchable and paginated in the personal library', async ({ page }, testInfo) => {
  bind(testInfo.synthetic);
  testInfo.synthetic.doubanItems = [...KINDS.map((kind, index) => record(kind, index + 10)), ...Array.from({ length: 26 }, (_, index) => record('book', index + 100))];
  await openLibrary(page);
  await expect(page.locator('#douban-next')).toBeEnabled();
  await page.locator('#douban-next').click();
  await expect.poll(() => testInfo.synthetic.requests.some(request => request.path === '/api/life/douban' && Number(new URLSearchParams(request.search).get('offset')) > 0)).toBe(true);
  for (const kind of KINDS) {
    await page.locator('#douban-kind').selectOption(kind);
    await expect.poll(() => page.locator('#douban-list [data-douban-open]').count()).toBeGreaterThan(0);
    await expect(page.locator('#douban-list')).toContainText('合成' + ({ movie: '电影', series: '电视剧', book: '图书', music: '音乐', screen: '待分类影视' }[kind]));
  }
  await page.locator('#douban-kind').selectOption('');
  await page.locator('#douban-query').fill('合成电视剧11');
  await page.locator('#douban-search').click();
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(1);
  await page.locator('#douban-list [data-douban-open]').click();
  await expect(page.locator('#douban-detail-dialog')).toBeVisible();
  await expect(page.locator('#douban-detail-title')).toHaveText('合成电视剧11');
  await expect(page.locator('#douban-detail-body')).toContainText('合成个人短评');
  await page.locator('#douban-detail-close').click();
  expect(mutations(testInfo)).toEqual([]);
  await fits(page);
});

test('pausing finishes only the current step and a page reload waits for an explicit resume', async ({ page }, testInfo) => {
  bind(testInfo.synthetic); testInfo.synthetic.doubanHoldStep = true;
  await openLibrary(page); await page.locator('#douban-sync').click();
  await expect.poll(() => testInfo.synthetic.doubanStepPending).toBe(true);
  await page.locator('#douban-stop').click();
  testInfo.synthetic.doubanReleaseStep();
  await expect(page.locator('#douban-sync')).toBeEnabled();
  expect(testInfo.synthetic.doubanRun.status).toBe('running');
  const beforeReload = syncRequests(testInfo).length;
  await page.reload();
  await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
  expect(syncRequests(testInfo)).toHaveLength(beforeReload);
  await page.locator('#douban-sync').click();
  await expect.poll(() => testInfo.synthetic.doubanRun.status).toBe('partial');
  expect(testInfo.synthetic.doubanItems).toHaveLength(4);
  await fits(page);
});

test('an account change keeps the old-page profile draft local and blocks sending it as the next account', async ({ page }, testInfo) => {
  bind(testInfo.synthetic); await openLibrary(page);
  await page.locator('#douban-profile-settings > summary').click();
  const draft = 'https://www.douban.com/people/keep-this-profile-draft/';
  await page.locator('#douban-profile').fill(draft);
  testInfo.synthetic.owner = 'another-synthetic-account';
  await page.locator('#douban-save').click();
  await expect(page.locator('html')).toHaveAttribute('data-account-changed', '');
  await expect(page.locator('#douban-profile')).toHaveValue(draft);
  await expect(page.locator('#douban-save')).toBeDisabled();
  await expect(page.locator('#douban-sync')).toBeDisabled();
  expect(mutations(testInfo)).toEqual([]);
  expect(testInfo.synthetic.doubanConnection.profileId).toBe(PROFILE);
  await fits(page);
});

test('private files are normalized locally, previewed without writes and imported only after explicit confirmation', async ({ page }, testInfo) => {
  await openLibrary(page);
  await page.locator('#douban-import-panel > summary').click();
  await page.locator('#douban-import-profile').fill(PROFILE);
  const rawItems = [{ title: '私密导入测试电影', url: 'https://movie.douban.com/subject/1234567/', type: 'movie',
    state: '看过', myRating: 4, collectionDate: '2026-11-12', myComment: '只属于本人的导入短评', score: 9.8,
    unrelatedPrivateData: 'PRIVATE-DO-NOT-UPLOAD' }];
  await page.locator('#douban-import-files').setInputFiles({ name: 'private-douban-records.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(rawItems)) });
  await page.locator('#douban-import-completed').check();
  expect(mutations(testInfo)).toEqual([]);
  expect(testInfo.synthetic.doubanItems).toEqual([]);
  await page.locator('#douban-import-preview').click();
  await expect(page.locator('#douban-import-result')).toBeVisible();
  await expect(page.locator('#douban-import-confirm')).toBeEnabled();
  expect(testInfo.synthetic.doubanItems).toEqual([]);
  const imports = () => mutations(testInfo).filter(request => request.path === '/api/life/douban/import');
  expect(imports()).toHaveLength(1);
  expect(imports()[0].body.action).toBe('preview');
  const expectedItem = { domain: 'screen', subjectId: '1234567', kind: 'movie', title: rawItems[0].title, url: rawItems[0].url,
    coverUrl: null, rating: 4, markedDate: '2026-11-12', comment: rawItems[0].myComment, publishedAt: null, source: 'import' };
  expect(imports()[0].body.items).toEqual([expectedItem]);
  expect(JSON.stringify(imports()[0].body)).not.toMatch(/private-douban-records\.json|myRating|myComment|collectionDate|"score"|9\.8|unrelatedPrivateData|PRIVATE-DO-NOT-UPLOAD|rawFile|rawText|cookie|password|userId/);
  await page.locator('#douban-import-completed').uncheck();
  await expect(page.locator('#douban-import-confirm')).toBeDisabled();
  expect(testInfo.synthetic.doubanItems).toEqual([]);
  await page.locator('#douban-import-completed').check();
  await page.locator('#douban-import-preview').click();
  await expect(page.locator('#douban-import-confirm')).toBeEnabled();
  testInfo.synthetic.doubanLoseImportReply = true;
  await page.locator('#douban-import-confirm').click();
  await expect.poll(() => testInfo.synthetic.doubanItems.length).toBe(1);
  await expect(page.locator('#douban-import-retry')).toBeVisible();
  await expect(page.locator('#douban-import-profile')).toBeDisabled();
  await page.locator('#douban-import-retry').click();
  await expect(page.locator('#douban-list')).toContainText(rawItems[0].title);
  const commits = imports().filter(request => request.body.action === 'commit');
  expect(commits).toHaveLength(2);
  expect(commits[1].body).toEqual(commits[0].body);
  expect(testInfo.synthetic.doubanItems).toHaveLength(1);
  expect(commits[0].body).toMatchObject({ items: [expectedItem], expectedSnapshotHash: 'a'.repeat(64), confirmed: true });
  expect(parseDoubanProfile(commits[0].body.profile).profileId).toBe(PROFILE);
  expect(commits[0].body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(testInfo.synthetic.doubanConnection.profileId).toBeNull();
  expect(syncRequests(testInfo)).toEqual([]);
  await fits(page);
  await page.locator('#douban-import-panel').screenshot({ path: testInfo.outputPath('douban-private-import-confirmed.png') });
});

test('saved private HTML stays inert while only normalized book records reach the preview and import requests', async ({ page }, testInfo) => {
  await openLibrary(page);
  await page.locator('#douban-import-panel > summary').click();
  await page.locator('#douban-import-profile').fill(PROFILE);
  const savedHTML = `<!DOCTYPE html><html><head><title>本人读过的书(1)</title>
<link rel="canonical" href="https://book.douban.com/people/${PROFILE}/collect">
<link rel="stylesheet" href="https://private-import.invalid/saved-page.css">
<style>@import url("https://private-import.invalid/import.css"); .saved-private { background-image:url("https://private-import.invalid/background.png") }</style>
<script>window.__privateDoubanHTMLExecuted=true;fetch("https://private-import.invalid/inline-script")</script>
</head><body class="saved-private"><h1>本人读过的书(1)</h1>
<img src="https://private-import.invalid/outside.png" srcset="https://private-import.invalid/large.png 2x">
<iframe src="https://private-import.invalid/frame" srcdoc="&lt;script&gt;fetch('https://private-import.invalid/srcdoc-script')&lt;/script&gt;"></iframe>
<div class="grid-view"><div class="item"><img src="https://private-import.invalid/private-cover.png">
<ul><li class="title"><a href="https://book.douban.com/subject/7654321/"><em>私密HTML导入测试书</em></a></li>
<li><span class="rating4-t"></span><span class="date">2026-11-11</span></li>
<li class="comment">只保留本人的书籍短评</li></ul></div></div></body></html>`;
  await page.locator('#douban-import-files').setInputFiles({ name: 'my-private-book-collect.html', mimeType: 'text/html', buffer: Buffer.from(savedHTML) });
  await page.locator('#douban-import-completed').check();
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('#douban-import-preview').click();
  await expect(page.locator('#douban-import-result')).toBeVisible();
  await expect(page.locator('#douban-import-confirm')).toBeEnabled();
  expect(testInfo.synthetic.doubanItems).toEqual([]);
  const expectedItem = { domain: 'book', subjectId: '7654321', kind: 'book', title: '私密HTML导入测试书',
    url: 'https://book.douban.com/subject/7654321/', coverUrl: null, rating: 4, markedDate: '2026-11-11',
    comment: '只保留本人的书籍短评', publishedAt: null, source: 'import' };
  const imports = () => mutations(testInfo).filter(request => request.path === '/api/life/douban/import');
  expect(imports()).toHaveLength(1);
  expect(imports()[0].body.items).toEqual([expectedItem]);
  expect(await page.evaluate(() => window.__privateDoubanHTMLExecuted)).toBeUndefined();
  expect(testInfo.synthetic.externalRequests).toEqual([]);
  expect(JSON.stringify(imports()[0].body)).not.toMatch(/private-import\.invalid|<script|<iframe|srcdoc|DOCTYPE|saved-private|my-private-book-collect\.html/);
  await page.locator('#douban-import-confirm').click();
  await expect(page.locator('#douban-list')).toContainText(expectedItem.title);
  expect(testInfo.synthetic.doubanItems).toHaveLength(1);
  expect(imports().filter(request => request.body.action === 'commit')[0].body.items).toEqual([expectedItem]);
  expect(await page.evaluate(() => window.__privateDoubanHTMLExecuted)).toBeUndefined();
  expect(testInfo.synthetic.externalRequests).toEqual([]);
  expect(testInfo.synthetic.doubanConnection.profileId).toBeNull();
  expect(syncRequests(testInfo)).toEqual([]);
  await fits(page);
});

test('source failures distinguish timeouts from blocks and offer recovery without replacing a private draft or unknown receipt', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [record('music', 40), record('music', 41)];
  state.doubanRun = { ...newRun(state.doubanConnection), revision: 5, status: 'partial', phase: 'done', added: 2, finishedAt: STAMP,
    sources: { screen: { ...source('failed'), errorCode: 'DOUBAN_SOURCE_TIMEOUT' },
      book: { ...source('blocked'), errorCode: 'DOUBAN_SOURCE_BLOCKED' }, music: source('complete', 2) },
    rss: { status: 'failed', received: 0, errorCode: 'DOUBAN_SOURCE_BLOCKED' },
    message: '公开来源未全部完成，已保存获取到的两条音乐记录。' };
  await openLibrary(page);
  const screen = page.locator('[data-douban-source="screen"]'), book = page.locator('[data-douban-source="book"]');
  await expect(screen.locator('strong')).toContainText('读取超时');
  await expect(screen.locator('[data-douban-source-reason]')).toContainText('本次等待内没有返回');
  await expect(book.locator('strong')).toContainText('访问受限');
  await expect(book.locator('[data-douban-source-reason]')).toContainText('暂不允许本站读取此公开页面');
  await expect(page.locator('[data-douban-source="rss"] [data-douban-source-reason]')).toContainText('暂不允许本站读取此公开页面');
  await expect(page.locator('[data-douban-source="music"]')).toContainText(/已读取/);
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(2);
  for (const [domain, host] of [['screen', 'movie'], ['book', 'book'], ['music', 'music']]) {
    const url = new URL(await page.locator('[data-douban-collection="' + domain + '"]').first().getAttribute('href'));
    expect(url.href).toBe('https://' + host + '.douban.com/people/' + PROFILE + '/collect');
  }
  expect(mutations(testInfo)).toEqual([]);
  expect(state.externalRequests).toEqual([]);

  await page.locator('[data-douban-import-source="book"]').click();
  await expect(page.locator('#douban-import-panel')).toHaveAttribute('open', '');
  expect(parseDoubanProfile(await page.locator('#douban-import-profile').inputValue()).profileId).toBe(PROFILE);
  await expect(page.locator('#douban-import-domain')).toHaveValue('book');
  await expect(page.locator('#douban-import-completed')).not.toBeChecked();
  const draftProfile = 'https://www.douban.com/people/retained-private-profile/';
  const draftFile = { name: 'retained-private-music.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([
    { title: '保留原私密音乐草稿', url: 'https://music.douban.com/subject/8765432/', type: 'music', state: '听过',
      myRating: 3, collectionDate: '2026-11-11', myComment: '这条资料属于原导入草稿' },
  ])) };
  await page.locator('#douban-import-profile').fill(draftProfile);
  await page.locator('#douban-import-domain').selectOption('music');
  await page.locator('#douban-import-files').setInputFiles(draftFile);
  await page.locator('#douban-import-completed').check();
  await page.locator('[data-douban-import-source="screen"]').click();
  await expect(page.locator('#douban-import-profile')).toHaveValue(draftProfile);
  await expect(page.locator('#douban-import-domain')).toHaveValue('music');
  expect(await page.locator('#douban-import-files').evaluate(input => input.files[0]?.name)).toBe(draftFile.name);
  await expect(page.locator('#douban-import-status')).toContainText(/保留|未保存|原.*草稿/);
  expect(mutations(testInfo)).toEqual([]);

  await page.locator('#douban-import-preview').click();
  await expect(page.locator('#douban-import-confirm')).toBeEnabled();
  state.doubanLoseImportReply = true;
  await page.locator('#douban-import-confirm').click();
  await expect(page.locator('#douban-import-retry')).toBeEnabled();
  const beforeRecovery = mutations(testInfo).length;
  await page.locator('[data-douban-import-source="screen"]').click();
  await expect(page.locator('#douban-import-profile')).toHaveValue(draftProfile);
  await expect(page.locator('#douban-import-domain')).toHaveValue('music');
  await expect(page.locator('#douban-import-profile')).toBeDisabled();
  await expect(page.locator('#douban-import-retry')).toBeEnabled();
  expect(mutations(testInfo)).toHaveLength(beforeRecovery);
  await page.locator('#douban-import-retry').click();
  await expect(page.locator('#douban-list')).toContainText('保留原私密音乐草稿');
  expect(state.doubanItems).toHaveLength(3);
  expect(state.doubanConnection.profileId).toBe(PROFILE);
  expect(syncRequests(testInfo)).toEqual([]);
  expect(state.externalRequests).toEqual([]);
  await fits(page);
  await page.locator('#douban-sources').screenshot({ path: testInfo.outputPath('douban-source-failure-recovery.png') });
});

test('all media covers including private imports use owned same-origin images and missing or failed covers retain an image fallback', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = KINDS.map((kind, index) => ({ ...record(kind, 500 + index), source: 'import',
    coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p' + (500 + index) + '.jpg' }));
  state.doubanItems[2].coverUrl = null;
  state.doubanFailedCovers.add(state.doubanItems[1].subjectId);
  await openLibrary(page);
  const covers = page.locator('#douban-list img[data-douban-cover]');
  await expect(covers).toHaveCount(KINDS.length);
  for (let index = 0; index < KINDS.length; index++) await covers.nth(index).scrollIntoViewIfNeeded();
  await expect(covers.nth(1)).toHaveAttribute('data-douban-cover', 'failed');
  await expect(covers.nth(1)).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(covers.nth(2)).toHaveAttribute('data-douban-cover', 'missing');
  await expect(covers.nth(2)).toHaveAttribute('src', /^data:image\/svg\+xml/);
  for (const index of [0, 3, 4]) {
    await expect(covers.nth(index)).toHaveAttribute('data-douban-cover', 'available');
    const url = new URL(await covers.nth(index).getAttribute('src'), page.url());
    expect(url.origin).toBe(new URL(page.url()).origin);
    expect(url.pathname).toBe('/api/life/douban/cover');
    expect(Object.fromEntries(url.searchParams)).toEqual({ profileId: PROFILE, domain: state.doubanItems[index].domain, subjectId: state.doubanItems[index].subjectId });
  }
  await expect.poll(() => covers.evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  expect(state.requests.filter(request => request.path === '/api/life/douban/cover')).toHaveLength(4);
  expect(state.requests.filter(request => /metadata|classification/.test(request.path))).toEqual([]);
  expect(mutations(testInfo)).toEqual([]);
  expect(state.externalRequests).toEqual([]);
  await fits(page);
  await page.locator('#douban-list').screenshot({ path: testInfo.outputPath('douban-owned-cover-images.png') });
});

test('metadata completion waits for an explicit batch action and preserves records when one source is unavailable', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [record('screen', 600), { ...record('book', 601), source: 'import' }, record('music', 602)];
  state.doubanMetadataResults.set(state.doubanItems[0].subjectId, { kind: 'series', coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p600.jpg' });
  state.doubanMetadataResults.set(state.doubanItems[1].subjectId, { kind: 'book', coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p601.jpg' });
  state.doubanMetadataResults.set(state.doubanItems[2].subjectId, { unavailable: true });
  await openLibrary(page);
  const metadataRequests = () => state.requests.filter(request => request.path === '/api/life/douban/metadata');
  expect(metadataRequests()).toEqual([]);
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('#douban-metadata').click();
  await expect.poll(() => metadataRequests().length).toBe(3);
  await expect(page.locator('#douban-metadata')).toBeEnabled();
  expect(state.doubanItems[0].kind).toBe('series');
  expect(state.doubanItems[1].coverUrl).toContain('/p601.jpg');
  expect(state.doubanItems[2].coverUrl).toBeNull();
  expect(state.doubanItems[2].title).toBe('合成音乐602');
  expect(state.doubanItems).toHaveLength(3);
  expect(metadataRequests().every(request => request.method === 'POST')).toBe(true);
  expect(metadataRequests().map(request => request.body)).toEqual(expect.arrayContaining(['screen', 'book', 'music'].map((domain, index) =>
    ({ profileId: PROFILE, domain, subjectId: String(9000600 + index), expectedUpdatedAt: STAMP, confirmed: true }))));
  await expect(page.locator('#douban-metadata-status')).toContainText('暂无法获取 1 条');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(3);
  await expect(page.locator('#douban-list [data-douban-open="0"] img')).toHaveAttribute('data-douban-cover', 'available');
  await expect(page.locator('#douban-list [data-douban-open="1"] img')).toHaveAttribute('data-douban-cover', 'available');
  await expect(page.locator('#douban-list [data-douban-open="2"] img')).toHaveAttribute('data-douban-cover', 'missing');
  expect(syncRequests(testInfo)).toEqual([]);
  expect(state.externalRequests).toEqual([]);
  await fits(page);
});

test('manual movie or series classification is an explicit saved choice and an account change blocks the old-page choice', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [record('screen', 700), record('screen', 701)];
  await openLibrary(page);
  await page.locator('#douban-list [data-douban-open="0"]').click();
  await expect(page.locator('#douban-classification-form')).toBeVisible();
  await expect(page.locator('#douban-classification-kind')).toHaveValue('');
  await page.locator('#douban-classification-kind').selectOption('series');
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('#douban-classification-save').click();
  await expect.poll(() => state.doubanItems[0].kind).toBe('series');
  await expect(page.locator('#douban-classification-status')).toContainText('分类已保存为电视剧');
  const classificationRequests = () => state.requests.filter(request => request.path === '/api/life/douban/classification');
  expect(classificationRequests()).toHaveLength(1);
  expect(classificationRequests()[0].method).toBe('PUT');
  expect(classificationRequests()[0].body).toEqual({ profileId: PROFILE, domain: 'screen', subjectId: '9000700', kind: 'series', expectedUpdatedAt: STAMP });
  if (await page.locator('#douban-detail-dialog').isVisible()) await page.locator('#douban-detail-close').click();
  await page.locator('#douban-list [data-douban-open="1"]').click();
  await page.locator('#douban-classification-kind').selectOption('movie');
  state.owner = 'another-synthetic-account';
  await page.locator('#douban-classification-save').click();
  await expect(page.locator('html')).toHaveAttribute('data-account-changed', '');
  await expect(page.locator('#douban-classification-kind')).toHaveValue('movie');
  await expect(page.locator('#douban-classification-save')).toBeDisabled();
  expect(classificationRequests()).toHaveLength(1);
  expect(state.doubanItems[1].kind).toBe('screen');
  expect(state.requests.filter(request => request.path === '/api/life/douban/metadata')).toEqual([]);
  expect(syncRequests(testInfo)).toEqual([]);
  expect(state.externalRequests).toEqual([]);
  await fits(page);
});

test('desktop browser extension syncing starts explicitly and saves only normalized completed pages without persisting the private records', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  const pages = [[{ ...extensionItem('screen', 800), rawHTML: 'PRIVATE-RAW-EXTENSION-PAGE' }], [extensionItem('book', 801), extensionItem('music', 802)]];
  await installExtensionMock(context, pages);
  await openLibrary(page);
  expect(await extensionCalls(page)).toEqual([]);
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('#douban-browser-connect').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器扩展可连接');
  expect((await extensionCalls(page)).map(call => call.body.action)).toEqual(['CONNECT']);
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(3);
  expect(state.doubanItems.map(item => item.kind)).toEqual(['screen', 'book', 'music']);
  const calls = await extensionCalls(page);
  expect(calls.map(call => call.body.action)).toEqual(['CONNECT', 'START', 'STEP', 'STEP']);
  expect(calls.every(call => call.id === 'gbcgjkicjfbaakippafhhpadfkfifaeb' && call.body.type === 'JIASHU_DOUBAN' && call.body.version === 1 && call.body.profileId === PROFILE)).toBe(true);
  expect(new Set(calls.map(call => call.body.ownerKey)).size).toBe(1);
  expect(calls[0].body.ownerKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const imported = mutations(testInfo);
  expect(imported.map(request => request.body.action)).toEqual(['preview', 'commit', 'preview', 'commit']);
  expect(imported.every(request => request.path === '/api/life/douban/import' && request.body.profile === PROFILE && request.body.items.every(item => item.source === 'import'))).toBe(true);
  expect(Object.keys(imported[0].body.items[0]).sort()).toEqual(Object.keys(extensionItem('screen', 800)).sort());
  expect(JSON.stringify(imported)).not.toMatch(/PRIVATE-RAW-EXTENSION-PAGE|rawHTML|ownerKey|cookie|password|authorization/i);
  expect(await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }))).not.toMatch(/合成待分类影视800|合成图书801|合成音乐802|合成个人短评|PRIVATE-RAW-EXTENSION-PAGE/);
  expect(syncRequests(testInfo)).toEqual([]);
  await fits(page);
  await page.locator('#douban-browser-progress').screenshot({ path: testInfo.outputPath('douban-browser-extension-progress.png') });
});

test('an unknown extension step waits for explicit retry and reuses its original operation without reading or saving twice', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  await installExtensionMock(context, [[extensionItem('book', 810)]], { lostReply: true });
  await openLibrary(page);
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-sync')).toHaveText('重试并继续浏览器同步');
  await expect(page.locator('#douban-browser-sync')).toBeEnabled();
  await expect(page.locator('#douban-save')).toBeDisabled();
  expect(mutations(testInfo)).toEqual([]);
  const original = (await extensionCalls(page, 'STEP'))[0];
  expect(await extensionCalls(page, 'STEP')).toHaveLength(1);
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  expect(await extensionCalls(page, 'STEP')).toEqual([original, original]);
  expect(await extensionCalls(page, 'START')).toHaveLength(1);
  expect(await page.evaluate(() => window.__doubanExtensionMock.reads)).toBe(1);
  expect(mutations(testInfo).map(request => request.body.action)).toEqual(['preview', 'commit']);
  expect(state.doubanItems).toHaveLength(1);
  await expect(page.locator('#douban-list')).toContainText('合成图书810');
  expect(syncRequests(testInfo)).toEqual([]);
  await fits(page);
});

test('pausing saves only the current browser page and switching website accounts cancels the next return while retaining a file draft', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  await installExtensionMock(context, [[extensionItem('book', 820)], [extensionItem('music', 821)]], { holdStep: 0 });
  await openLibrary(page);
  await page.locator('#douban-import-panel > summary').click();
  await page.locator('#douban-import-profile').fill('keep-local-file-draft');
  await page.locator('#douban-import-files').setInputFiles({ name: 'keep-local-draft.json', mimeType: 'application/json', buffer: Buffer.from('[{"title":"尚未提交的本人草稿","url":"https://book.douban.com/subject/9999820/","state":"读过"}]') });
  await page.locator('#douban-browser-sync').click();
  await expect.poll(() => page.evaluate(() => window.__doubanExtensionMock.pending)).toBe(true);
  await page.locator('#douban-browser-stop').click();
  await page.evaluate(() => window.__doubanExtensionMock.release());
  await expect(page.locator('#douban-browser-status')).toContainText('已暂停浏览器同步');
  expect(await extensionCalls(page, 'STEP')).toHaveLength(1);
  expect(state.doubanItems).toHaveLength(1);
  expect(mutations(testInfo).map(request => request.body.action)).toEqual(['preview', 'commit']);
  await page.evaluate(() => { window.__doubanExtensionMock.holdStep = 1; });
  await page.locator('#douban-browser-sync').click();
  await expect.poll(() => page.evaluate(() => window.__doubanExtensionMock.pending)).toBe(true);
  state.owner = 'another-synthetic-account';
  await page.evaluate(() => window.JiashuAccountSession.verify().catch(() => {}));
  await expect(page.locator('html')).toHaveAttribute('data-account-changed', '');
  await expect.poll(() => extensionCalls(page, 'CANCEL').then(calls => calls.length)).toBe(1);
  await page.evaluate(() => window.__doubanExtensionMock.release());
  await expect(page.locator('#douban-browser-stop')).toBeHidden();
  await expect(page.locator('#douban-browser-sync')).toBeDisabled();
  await expect(page.locator('#douban-browser-status')).toContainText('后续返回不会保存');
  await expect(page.locator('#douban-import-profile')).toHaveValue('keep-local-file-draft');
  expect(await page.locator('#douban-import-files').evaluate(input => input.files[0]?.name)).toBe('keep-local-draft.json');
  expect(state.doubanItems.map(item => item.kind)).toEqual(['book']);
  expect(mutations(testInfo).map(request => request.body.action)).toEqual(['preview', 'commit']);
  expect(syncRequests(testInfo)).toEqual([]);
  await fits(page);
});
