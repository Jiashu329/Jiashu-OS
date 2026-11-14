import { test as base, expect, chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderBrowserFixture, BROWSER_FIXTURE_OWNER } from '../../scripts/browser-fixture.mjs';
import { startOfflineProxy } from './offline-proxy.mjs';

const ORIGIN = 'https://jiashu-life-os-health.jiashuh329.chatgpt.site';
const EXTENSION_ID = 'gbcgjkicjfbaakippafhhpadfkfifaeb';
const PROFILE = 'mv3-synthetic-owner';
const OWNER_KEY = '11111111-2222-4333-8444-555555555555';
const RAW_SECRET = 'PRIVATE-HTML-MUST-STAY-IN-DOUBAN-TAB';
const COOKIE_SECRET = 'SYNTHETIC-BROWSER-LOGIN-NEVER-UPLOAD';
const hosts = { screen: 'movie', book: 'book', music: 'music' };
const SUBJECT_IDS = { screen: '9400000', book: '9500000', music: '9600000' };
const assetTypes = {
  '/favicon.ico': 'image/x-icon', '/apple-touch-icon.png': 'image/png', '/manifest.webmanifest': 'application/manifest+json',
  '/brand/logo-192.png': 'image/png', '/brand/favicon-32.png': 'image/png', '/brand/icon-192.png': 'image/png',
  '/brand/icon-512.png': 'image/png', '/brand/icon-maskable-512.png': 'image/png',
};

function collectionHTML(domain, start = 0) {
  const label = { screen: '看过的电影', book: '读过的书', music: '听过的音乐' }[domain];
  const total = domain === 'screen' ? 16 : 1;
  const count = domain === 'screen' && start === 0 ? 15 : 1;
  const collection = 'https://' + hosts[domain] + '.douban.com/people/' + PROFILE + '/collect';
  const canonical = domain === 'screen' ? collection + '?start=' + start + '&sort=time&type=all&filter=all&mode=grid' : collection;
  const rows = Array.from({ length: count }, (_, index) => {
    const subjectId = String({ screen: 9100000, book: 9200000, music: 9300000 }[domain] + start + index);
    const title = '扩展合成' + { screen: '影视', book: '图书', music: '音乐' }[domain] + (start + index);
    return '<div class="item"><div class="pic"><img data-original="https://img1.doubanio.com/view/subject/s/public/s' + subjectId + '.jpg"></div>'
      + '<div class="info"><ul><li class="title"><a href="https://' + hosts[domain] + '.douban.com/subject/' + subjectId + '/"><em>' + title + '</em></a></li>'
      + '<li><span class="rating4-t"></span><span class="date">2026-11-12</span></li><li class="comment">扩展合成个人短评</li></ul></div></div>';
  }).join('');
  // Only a fetched subsequent page contains active-resource markup. The real
  // isolated-world parser must inspect it through an unattached template.
  const inert = start ? '<p>' + RAW_SECRET + '</p><img src="https://private-import.invalid/pixel">'
    + '<iframe src="https://private-import.invalid/frame" srcdoc="<img src=https://private-import.invalid/srcdoc>"></iframe>'
    + '<link rel="stylesheet" href="https://private-import.invalid/style"><style>@import url(https://private-import.invalid/import);body{background:url(https://private-import.invalid/background)}</style>'
    + '<script>globalThis.__doubanExtensionRawExecuted=true;fetch("https://private-import.invalid/script")</script>' : '';
  return '<!doctype html><html><head><title>合成用户' + label + '(' + total + ')</title><link rel="icon" href="data:,"><link rel="canonical" href="' + canonical + '"></head><body>'
    + '<div id="db-global-nav"><div class="nav-user-account"><a href="https://www.douban.com/mine/">个人主页</a></div></div>'
    + '<h1>合成用户' + label + '(' + total + ')</h1><span class="subject-num">' + (start + 1) + '-' + (start + count) + ' / ' + total + '</span>'
    + '<div class="grid-view">' + rows + '</div>'
    + (domain === 'screen' && start === 0 ? '<div class="paginator"><span class="next"><a href="' + collection + '?start=15&sort=time&type=all&filter=all&mode=grid">后页</a></span></div>' : '')
    + inert + '</body></html>';
}

function subjectHTML(domain, subjectId, inert = false) {
  const url = 'https://' + hosts[domain] + '.douban.com/subject/' + subjectId + '/';
  const title = { screen: '合成电影作品', book: '合成图书作品', music: '合成音乐作品' }[domain];
  const type = { screen: 'Movie', book: 'Book', music: 'MusicAlbum' }[domain];
  const info = domain === 'screen' ? '<span class="pl">导演:</span> 合成导演<br><span class="pl">编剧:</span> 合成编剧<br><span class="pl">主演:</span> 合成演员<br><span class="pl">类型:</span> 剧情<br><span class="pl">制片国家/地区:</span> 中国大陆<br><span class="pl">语言:</span> 汉语普通话<br><span class="pl">上映日期:</span> 2024-02-10(中国大陆)<br><span class="pl">片长:</span> 120分钟<br>'
    : domain === 'book' ? '<span class="pl">作者:</span> 合成作者<br><span class="pl">译者:</span> 合成译者<br><span class="pl">出版社:</span> 合成出版社<br><span class="pl">出版年:</span> 2024-03<br><span class="pl">页数:</span> 320<br><span class="pl">ISBN:</span> 9787020002207<br><span class="pl">装帧:</span> 平装<br>'
      : '<span class="pl">表演者:</span> 合成歌手<br><span class="pl">流派:</span> 民谣<br><span class="pl">专辑类型:</span> 专辑<br><span class="pl">介质:</span> CD<br><span class="pl">发行时间:</span> 2024-06-01<br><span class="pl">出版者:</span> 合成唱片<br>';
  return '<!doctype html><html><head><title>' + title + '</title><link rel="icon" href="data:,"><link rel="canonical" href="' + url + '"><meta property="og:url" content="' + url + '">'
    + '<meta property="og:image" content="https://img1.doubanio.com/view/subject/s/public/s' + subjectId + '.jpg">'
    + '<script type="application/ld+json">' + JSON.stringify({ '@type': type, url, name: title, datePublished: '2024-02-10', aggregateRating: { '@type': 'AggregateRating', ratingValue: 8.6, ratingCount: 12345 } }) + '</script></head><body>'
    + '<h1><span property="v:itemreviewed">' + title + '</span><span class="year">(2024)</span></h1><div id="info">' + info + '</div>'
    + '<div class="rating_self"><strong class="rating_num" property="v:average">8.6</strong><span property="v:votes">12345</span></div>'
    + '<div id="link-report"><span property="v:summary">合成作品简介，只有公开资料。</span></div>'
    + (domain === 'music' ? '<div id="tracklist"><div class="track-list">01. 第一首合成曲目<br>02. 第二首合成曲目</div></div>' : '')
    + (inert ? '<p>' + RAW_SECRET + '</p><img src="https://private-import.invalid/subject-pixel"><iframe src="https://private-import.invalid/subject-frame"></iframe>'
      + '<style>body{background:url(https://private-import.invalid/subject-style)}</style>'
      + '<script>globalThis.__doubanSubjectRawExecuted=true;fetch("https://private-import.invalid/subject-script")</script>' : '') + '</body></html>';
}

const test = base.extend({
  extension: async ({ playwright: _playwright }, provide, testInfo) => {
    if (process.env.SITES_MANAGED_LINUX_CONTAINER === '1') throw new Error('Real MV3 acceptance is CI/local-only; never launch a browser inside managed Sites.');
    const profilePath = testInfo.outputPath('chromium-profile');
    await mkdir(profilePath, { recursive: true });
    const extensionPath = resolve(import.meta.dirname, '../../browser-extension/douban');
    const fixtureHosts = [new URL(ORIGIN).hostname, 'not-jiashu.invalid', ...Object.values(hosts).map(host => host + '.douban.com')];
    const fixtureOrigins = new Set(fixtureHosts.map(host => 'https://' + host));
    const subjects = new Map(Object.entries(SUBJECT_IDS).map(([domain, subjectId]) => [domain + ':' + subjectId, subjectHTML(domain, subjectId)]));
    subjects.set('screen:9400001', subjectHTML('screen', '9400001', true));
    // Start the transport before Chrome, so even its first extension-created tab
    // is synthetic. Playwright request routes attach too late for that navigation.
    const offline = await startOfflineProxy({
      allowedHosts: fixtureHosts,
      nativeLoginCookie: { name: 'synthetic_native_login', value: COOKIE_SECRET },
      respond: async (url, method) => {
        if (method !== 'GET') return null;
        const send = data => ({ headers: { 'Content-Type': 'application/json', 'X-Account-Owner': BROWSER_FIXTURE_OWNER }, body: JSON.stringify(data) });
        if (url.origin === ORIGIN && url.pathname === '/api/session') return send({ userId: BROWSER_FIXTURE_OWNER });
        if (url.origin === ORIGIN && url.pathname === '/api/life/douban') {
          return send({ connection: { profileId: PROFILE, profileUrl: 'https://www.douban.com/people/' + PROFILE + '/', revision: 1, updatedAt: null },
            items: [], total: 0, counts: { all: 0, movie: 0, series: 0, screen: 0, book: 0, music: 0 }, offset: 0, limit: 24, hasMore: false, lastRun: null });
        }
        if (url.origin === ORIGIN && url.pathname === '/life/douban') return { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: renderBrowserFixture('/life/douban') };
        if ((url.origin === ORIGIN && url.pathname === '/not-the-douban-page') || (url.origin === 'https://not-jiashu.invalid' && url.pathname === '/life/douban')) return { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>Synthetic denied origin</title><link rel="icon" href="data:,"><p>Not an authorized extension caller</p>' };
        const domain = Object.keys(hosts).find(key => url.hostname === hosts[key] + '.douban.com');
        const subjectId = /^\/subject\/([1-9]\d*)\/$/.exec(url.pathname)?.[1];
        if (domain && subjectId && subjects.has(domain + ':' + subjectId)) return { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: subjects.get(domain + ':' + subjectId) };
        if (domain && url.pathname === '/people/' + PROFILE + '/collect') {
          const start = Number(url.searchParams.get('start') ?? 0);
          if ((domain === 'screen' && [0, 15].includes(start)) || (domain !== 'screen' && start === 0)) return { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: collectionHTML(domain, start) };
        }
        if (url.origin === ORIGIN && Object.hasOwn(assetTypes, url.pathname)) return { headers: { 'Content-Type': assetTypes[url.pathname] }, body: await readFile(resolve(import.meta.dirname, '../../public', '.' + url.pathname)) };
        return null;
      },
    });
    const { requests, unexpected } = offline;
    let context, page, tracing = false;
    try {
      context = await chromium.launchPersistentContext(profilePath, { channel: 'chromium', headless: true,
        viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', ignoreHTTPSErrors: true,
        proxy: { server: offline.proxy, bypass: '<-loopback>' },
        args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath,
          '--ignore-certificate-errors', '--disable-quic', '--disable-background-networking',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
      // Browser-process bootstrap requests are locally refused separately by the
      // proxy. Any page or worker request to those same hosts is still a failure.
      context.on('request', request => {
        const url = new URL(request.url());
        if (['http:', 'https:'].includes(url.protocol) && !fixtureOrigins.has(url.origin)) unexpected.push('application request outside fixture: ' + url.origin + url.pathname);
      });
      await context.tracing.start({ screenshots: true, snapshots: true }); tracing = true;
      await context.addCookies([{ name: 'synthetic_native_login', value: COOKIE_SECRET, domain: '.douban.com', path: '/', secure: true, httpOnly: true }]);
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      expect(new URL(worker.url()).hostname).toBe(EXTENSION_ID);
      page = await context.newPage();
      await provide({ context, page, worker, requests, unexpected, subjects });
    }
    finally {
      await Promise.allSettled([page && !page.isClosed() ? page.screenshot({ path: testInfo.outputPath('extension-page.png'), fullPage: true }) : undefined,
        tracing ? context.tracing.stop({ path: testInfo.outputPath('extension-trace.zip') }) : undefined]);
      try { await context?.close(); } finally { await offline.close(); }
      expect(unexpected, 'Every HTTP response must be synthetic; the collector must never activate fetched raw HTML resources').toEqual([]);
    }
  },
});

const message = (action, extra = {}) => ({ type: 'JIASHU_DOUBAN', version: 1, action, ownerKey: OWNER_KEY, profileId: PROFILE, ...extra });
async function bridge(page, payload) {
  return page.evaluate(({ id, payload }) => new Promise(resolve => {
    if (typeof globalThis.chrome?.runtime?.sendMessage !== 'function') return resolve({ transportError: 'runtime-unavailable' });
    globalThis.chrome.runtime.sendMessage(id, payload, response => {
      const error = globalThis.chrome.runtime.lastError?.message;
      resolve(error ? { transportError: error } : response);
    });
  }), { id: EXTENSION_ID, payload });
}
const collectionRequests = requests => requests.filter(request => Object.values(hosts).some(host => new URL(request.url).hostname === host + '.douban.com') && new URL(request.url).pathname.startsWith('/people/'));
const subjectRequests = requests => requests.filter(request => new URL(request.url).pathname.startsWith('/subject/'));

test('the actual MV3 package accepts only the production media page handshake without reading Douban automatically', async ({ extension }) => {
  const { page, requests, context } = extension;
  await page.goto(ORIGIN + '/life/douban');
  await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
  expect(collectionRequests(requests)).toEqual([]);
  expect(subjectRequests(requests)).toEqual([]);
  for (const action of ['CONNECT', 'STATUS']) expect(await bridge(page, message(action))).toEqual({ ok: true, data: { extensionVersion: '1.0.3', protocolVersion: 1 } });
  expect(collectionRequests(requests)).toEqual([]);
  await page.goto(ORIGIN + '/not-the-douban-page');
  expect(await bridge(page, message('CONNECT'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  const denied = await context.newPage();
  await denied.goto('https://not-jiashu.invalid/life/douban');
  expect(await bridge(denied, message('CONNECT'))).not.toMatchObject({ ok: true });
  expect(collectionRequests(requests)).toEqual([]);
});

test('native subject reads reuse browser login for movies, books and music and return public work fields without private HTML', async ({ extension }) => {
  const { page, context, requests } = extension;
  await page.goto(ORIGIN + '/life/douban');
  await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
  expect(subjectRequests(requests)).toEqual([]);
  const results = [];
  for (const [index, domain] of ['screen', 'book', 'music'].entries()) {
    const payload = message('SUBJECT', { requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(100 + index).padStart(12, '0'), domain, subjectId: SUBJECT_IDS[domain] });
    const result = await bridge(page, payload);
    expect(result).toMatchObject({ ok: true, data: { requestId: payload.requestId, domain, subjectId: SUBJECT_IDS[domain], metadata: {
      kind: domain === 'screen' ? 'movie' : domain, details: { doubanRating: 8.6, ratingCount: 12345, summary: '合成作品简介，只有公开资料。' } } } });
    expect(Object.keys(result.data.metadata).sort()).toEqual(['kind', 'coverUrl', 'details'].sort());
    expect(result.data.metadata).not.toHaveProperty('rating');
    expect(result.data.metadata).not.toHaveProperty('comment');
    results.push(result);
    if (index === 0) {
      expect(await bridge(page, payload)).toEqual(result);
      const conflict = await bridge(page, { ...payload, subjectId: '9400001' });
      expect(conflict).toMatchObject({ ok: false, error: { code: 'STEP_CONFLICT' } });
      expect(subjectRequests(requests)).toHaveLength(1);
    }
    if (index < 2) await page.waitForTimeout(1600);
  }
  expect(results[0].data.metadata.details).toMatchObject({ directors: ['合成导演'], duration: '120分钟' });
  expect(results[1].data.metadata.details).toMatchObject({ authors: ['合成作者'], publisher: '合成出版社', pages: 320, isbn: '9787020002207' });
  expect(results[2].data.metadata.details).toMatchObject({ artists: ['合成歌手'], albumType: '专辑', label: '合成唱片' });
  expect(subjectRequests(requests).map(request => request.nativeLogin)).toEqual([true, true, true]);
  await page.waitForTimeout(1600);
  // A different subject on the same owned tab is fetched and parsed inertly.
  const followup = await bridge(page, message('SUBJECT', { requestId: 'cccccccc-dddd-4eee-8fff-111111111111', domain: 'screen', subjectId: '9400001' }));
  expect(followup).toMatchObject({ ok: true, data: { metadata: { kind: 'movie', details: { doubanRating: 8.6 } } } });
  results.push(followup);
  expect(subjectRequests(requests)).toHaveLength(4);
  expect(subjectRequests(requests)[3].nativeLogin).toBe(true);
  expect(JSON.stringify(results)).not.toMatch(new RegExp(RAW_SECRET + '|' + COOKIE_SECRET + '|private-import\\.invalid|<iframe|<script'));
  for (const sourcePage of context.pages().filter(tab => /\.douban\.com\/subject\//.test(tab.url()))) expect(await sourcePage.evaluate(() => globalThis.__doubanSubjectRawExecuted)).toBeUndefined();
  expect(requests.filter(request => new URL(request.url).origin === ORIGIN && request.method !== 'GET')).toEqual([]);
});

test('a native subject challenge returns a safe fixed error and does not expose or activate its response', async ({ extension }) => {
  const { page, requests, subjects } = extension;
  subjects.set('screen:' + SUBJECT_IDS.screen, '<!doctype html><title>安全验证</title><link rel="icon" href="data:,"><p>' + RAW_SECRET + '</p>');
  await page.goto(ORIGIN + '/life/douban');
  await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
  const result = await bridge(page, message('SUBJECT', { requestId: 'bbbbbbbb-cccc-4ddd-8eee-111111111111', domain: 'screen', subjectId: SUBJECT_IDS.screen }));
  expect(result).toMatchObject({ ok: false, error: { code: 'DOUBAN_BROWSER_CHALLENGE' } });
  expect(subjectRequests(requests)).toHaveLength(1);
  expect(subjectRequests(requests)[0].nativeLogin).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(new RegExp(RAW_SECRET + '|' + COOKIE_SECRET + '|private-import\\.invalid|<script'));
});

test('native collection follows the real fifteen-item type-all movie pagination and mine navigation without activating raw HTML', async ({ extension }) => {
  const { page, context, worker, requests } = extension;
  await page.goto(ORIGIN + '/life/douban');
  await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
  const started = await bridge(page, message('START'));
  expect(started).toMatchObject({ ok: true, data: { step: 0, done: false, progress: { status: 'running', pages: 0 } } });
  expect(collectionRequests(requests)).toEqual([]);
  const runId = started.data.runId, results = [];
  let replayedFirst;
  for (let step = 0; step < 4; step++) {
    const payload = message('STEP', { runId, step, requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(step + 1).padStart(12, '0') });
    const result = await bridge(page, payload);
    expect(result).toMatchObject({ ok: true, data: { runId, step: step + 1, progress: { accountProfileId: null } } });
    expect(result.data.items).toHaveLength(step === 0 ? 15 : 1);
    results.push(result);
    if (step === 0) {
      const anotherOwner = await bridge(page, { ...payload, ownerKey: '22222222-3333-4444-8555-666666666666' });
      expect(anotherOwner).toMatchObject({ ok: false, error: { code: 'RUN_NOT_FOUND' } });
      expect(anotherOwner).not.toHaveProperty('data.items');
      expect(collectionRequests(requests)).toHaveLength(1);
      replayedFirst = await bridge(page, payload);
      expect(replayedFirst).toEqual(result);
      expect(collectionRequests(requests)).toHaveLength(1);
    }
    if (step < 3) await page.waitForTimeout(1600);
  }
  const items = results.flatMap(result => result.data.items);
  expect(items.map(item => item.domain)).toEqual([...Array(16).fill('screen'), 'book', 'music']);
  expect(items.map(item => item.kind)).toEqual([...Array(16).fill('screen'), 'book', 'music']);
  expect(new Set(items.map(item => item.domain + ':' + item.subjectId)).size).toBe(18);
  expect(items[15].subjectId).toBe('9100015');
  expect(items.every(item => item.source === 'import' && item.rating === 4 && item.markedDate === '2026-11-12' && item.comment === '扩展合成个人短评')).toBe(true);
  expect(items.map(item => Object.keys(item).sort())).toEqual(Array.from({ length: 18 }, () => ['domain', 'subjectId', 'url', 'title', 'kind', 'coverUrl', 'rating', 'markedDate', 'comment', 'publishedAt', 'source'].sort()));
  expect(results.at(-1)).toMatchObject({ data: { done: true, progress: { status: 'completed', received: 18, pages: 4, accountProfileId: null,
    sources: { screen: { status: 'complete', received: 16 }, book: { status: 'complete', received: 1 }, music: { status: 'complete', received: 1 } } } } });
  const poll = await bridge(page, message('POLL', { runId }));
  expect(poll).toMatchObject({ ok: true, data: { done: true, step: 4 } });
  expect(poll.data).not.toHaveProperty('items');
  expect(collectionRequests(requests)).toHaveLength(4);
  expect(collectionRequests(requests).map(request => Number(new URL(request.url).searchParams.get('start')))).toEqual([0, 15, 0, 0]);
  expect(collectionRequests(requests).every(request => new URL(request.url).pathname === '/people/' + PROFILE + '/collect')).toBe(true);
  expect(collectionRequests(requests).map(request => request.nativeLogin)).toEqual([true, true, true, true]);
  expect(JSON.stringify({ results, replayedFirst, poll })).not.toMatch(new RegExp(RAW_SECRET + '|' + COOKIE_SECRET + '|private-import\\.invalid|<iframe|<script'));
  const sourcePage = context.pages().find(tab => tab.url().startsWith('https://movie.douban.com/people/'));
  expect(sourcePage).toBeTruthy();
  expect(await sourcePage.evaluate(() => globalThis.__doubanExtensionRawExecuted)).toBeUndefined();
  expect((await context.cookies('https://movie.douban.com')).some(cookie => cookie.name === 'synthetic_native_login' && cookie.value === COOKIE_SECRET)).toBe(true);
  const manifest = JSON.parse(await readFile(new URL('../../browser-extension/douban/manifest.json', import.meta.url), 'utf8'));
  expect(manifest.permissions).not.toContain('cookies');
  expect(manifest.permissions).not.toContain('storage');
  expect(await worker.evaluate(() => typeof chrome.cookies)).toBe('undefined');
  expect(await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }))).not.toMatch(/扩展合成个人短评|PRIVATE-HTML-MUST-STAY|SYNTHETIC-BROWSER-LOGIN/);
  expect(requests.filter(request => new URL(request.url).origin === ORIGIN && request.method !== 'GET')).toEqual([]);
});
