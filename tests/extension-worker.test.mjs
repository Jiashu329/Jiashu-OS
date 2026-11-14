import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const extensionRoot = new URL('../browser-extension/douban/', import.meta.url);
const productionOrigin = 'https://jiashu-life-os-health.jiashuh329.chatgpt.site';
const workerSource = readFileSync(new URL('background.js', extensionRoot), 'utf8');
const ownerKey = '11111111-1111-4111-8111-111111111111';
const secondOwner = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const nextRequest = '55555555-5555-4555-8555-555555555555';
const finalRequest = '66666666-6666-4666-8666-666666666666';
const sender = { url: productionOrigin + '/life/douban', tab: { id: 7 }, frameId: 0 };
const message = (action, extra = {}) => ({ type: 'JIASHU_DOUBAN', version: 1, action, ownerKey, profileId: 'mine', ...extra });
const step = (number = 0, id = requestId, extra = {}) => message('STEP', { runId, step: number, requestId: id, ...extra });
const record = (domain = 'screen', subjectId = '12345') => ({ domain, subjectId, kind: domain, title: '合成个人收藏', url: 'https://' + ({ screen: 'movie', book: 'book', music: 'music' }[domain]) + '.douban.com/subject/' + subjectId + '/', coverUrl: null, rating: 4, markedDate: '2026-11-14', comment: '合成个人短评', publishedAt: null, source: 'collection' });
const page = (domain = 'screen', items = [record(domain)], extra = {}) => ({ items, total: items.length, nextStart: null, accountProfileId: 'mine', ...extra });
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function loadWorker(chromeApi) {
  const context = { URL, URLSearchParams, structuredClone, crypto: { randomUUID: () => runId }, setTimeout, clearTimeout, ...(chromeApi ? { chrome: chromeApi } : {}) };
  runInNewContext(workerSource.replace(/^export\s+/gm, '') + '\n;globalThis.testControllerFactory=createDoubanExtensionController;', context);
  return context;
}
function fixture(readPage) {
  let clock = 10000, issuedRuns = 0;
  const calls = { reads: [], created: [], updated: [], scripts: [] };
  const chromeApi = {
    tabs: { async create(options) { calls.created.push(clone(options)); return { id: 100, ...options }; }, async update(id, options) { calls.updated.push({ id, ...clone(options) }); } },
    scripting: { async executeScript(options) { calls.scripts.push(options); return []; } },
    get storage() { throw new Error('Sync must not persist private records or credentials'); },
    get cookies() { throw new Error('Sync must not access the Cookie API'); },
  };
  const controller = loadWorker().testControllerFactory(chromeApi, { now: () => clock, randomUUID: () => issuedRuns++ === 0 ? runId : finalRequest, readPage: async (run, domain) => {
    calls.reads.push({ runId: run.id, ownerKey: run.ownerKey, profileId: run.profileId, domain, offset: run.sources[domain].start });
    return readPage ? readPage(run, domain) : page(domain);
  } });
  return { controller, chromeApi, calls, advance(ms = 1500) { clock += ms; }, send(body, from = sender) { return controller.handle(body, from); }, async start() { const response = await controller.handle(message('START'), sender); assert.equal(response.ok, true); return response; } };
}

test('local Douban extension grants only collection hosts and never asks for Cookie or request interception permissions', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', extensionRoot), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.1');
  assert.deepEqual(manifest.permissions.toSorted(), ['scripting', 'tabs']);
  assert.deepEqual(manifest.host_permissions.toSorted(), ['https://book.douban.com/*', 'https://movie.douban.com/*', 'https://music.douban.com/*']);
  assert.deepEqual(manifest.externally_connectable.matches, [productionOrigin + '/*']);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'");
});

test('worker accepts only the production top-level media page before any collector, tab or login operation', async () => {
  const f = fixture();
  const denied = [
    { ...sender, url: 'https://evil.example/life/douban' },
    { ...sender, url: productionOrigin + '.evil.example/life/douban' },
    { ...sender, url: productionOrigin.replace('https:', 'http:') + '/life/douban' },
    { ...sender, url: productionOrigin + ':9443/life/douban' },
    { ...sender, url: productionOrigin + '/life/douban/other' },
    { ...sender, url: productionOrigin + '/life' },
    { ...sender, frameId: 1 },
    { ...sender, tab: { id: -1 } },
    { ...sender, tab: undefined },
    { ...sender, url: 'not-a-url' },
  ];
  for (const from of denied) for (const action of ['CONNECT', 'LOGIN', 'START']) {
    assert.equal((await f.send(message(action), from)).error.code, 'FORBIDDEN');
  }
  assert.equal(f.calls.reads.length + f.calls.created.length + f.calls.scripts.length, 0);
  const response = await f.send(message('CONNECT'), { ...sender, url: productionOrigin + '/life/douban?kind=book' });
  assert.deepEqual(clone(response), { ok: true, data: { extensionVersion: '1.0.1', protocolVersion: 1 } });
});

test('message schemas reject injected URLs, credentials, non-string identities and malformed step fields', async () => {
  const f = fixture();
  const invalid = [
    message('LOGIN', { url: 'https://evil.example/steal' }), message('START', { cookie: 'PRIVATE_CREDENTIAL' }),
    message('START', { profileId: '../other' }), message('START', { profileId: ['mine'] }),
    message('START', { ownerKey: [ownerKey] }), message('START', { ownerKey: 'not-a-uuid' }),
    message('START', { type: 'OTHER' }), message('START', { version: '1' }), message('UNKNOWN'),
    step(0, requestId, { runId: [runId] }), step(0, [requestId]), step(-1), step(1.5), step('0'),
    step(0, requestId, { rawHTML: '<html>private</html>' }),
  ];
  for (const body of invalid) assert.equal((await f.send(body)).error.code, 'INVALID_REQUEST', JSON.stringify(body));
  assert.equal(f.calls.reads.length + f.calls.created.length + f.calls.scripts.length, 0);
});

test('connect, status and start never read Douban; login opens only its fixed official URL', async () => {
  const f = fixture();
  for (const action of ['CONNECT', 'STATUS']) assert.equal((await f.send(message(action))).ok, true);
  const response = await f.start(); assert.equal(response.data.runId, runId); assert.equal(response.data.step, 0); assert.equal(response.data.done, false);
  assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.created.length, 0);
  assert.equal((await f.send(message('START'))).error.code, 'RUN_BUSY');
  assert.equal((await f.send(message('LOGIN'))).ok, true);
  assert.deepEqual(f.calls.created, [{ url: 'https://www.douban.com/accounts/login', active: true }]);
  assert.equal(f.calls.reads.length, 0);
});

test('run identity is pinned to website tab, owner key and profile for read, poll and cancel', async () => {
  const f = fixture(); await f.start();
  for (const action of ['STEP', 'POLL', 'CANCEL']) {
    const body = action === 'STEP' ? step() : message(action, { runId });
    for (const [payload, from] of [
      [body, { ...sender, tab: { id: 8 } }],
      [{ ...body, ownerKey: secondOwner }, sender],
      [{ ...body, profileId: 'other' }, sender],
      [{ ...body, runId: secondOwner }, sender],
    ]) assert.equal((await f.send(payload, from)).error.code, 'RUN_NOT_FOUND');
  }
  assert.equal(f.calls.reads.length + f.calls.scripts.length, 0);
  assert.equal((await f.send(message('POLL', { runId }))).data.progress.status, 'running');
  assert.equal((await f.send(step())).ok, true); assert.equal(f.calls.reads.length, 1);
});

test('concurrent retries perform one read, then replay the immutable last result without another read', async () => {
  let resolveRead;
  const f = fixture(() => new Promise(resolve => { resolveRead = resolve; })); await f.start();
  const pending = f.send(step()); assert.equal(f.calls.reads.length, 1);
  assert.equal((await f.send(step())).error.code, 'RUN_BUSY');
  assert.equal((await f.send(step(0, nextRequest))).error.code, 'RUN_BUSY');
  resolveRead(page()); const result = await pending; assert.equal(result.ok, true); assert.equal(result.data.step, 1);
  assert.equal(result.data.items[0].source, 'import');
  const replay = await f.send(step()); assert.deepEqual(clone(replay), clone(result)); assert.equal(f.calls.reads.length, 1);
  replay.data.items[0].title = 'mutated by page';
  assert.equal((await f.send(step())).data.items[0].title, '合成个人收藏');
  assert.equal((await f.send(step(1))).error.code, 'STEP_CONFLICT');
  assert.equal((await f.send(step(0, nextRequest))).error.code, 'STEP_CONFLICT');
  assert.equal(f.calls.reads.length, 1);
});

test('steps enforce the read interval, expose read-only progress and replay the final completed result', async () => {
  const f = fixture(); await f.start(); await f.send(step());
  const poll = await f.send(message('POLL', { runId })); assert.equal(poll.data.step, 1); assert.equal(poll.data.progress.received, 1); assert.equal(poll.data.items, undefined);
  assert.equal((await f.send(step(1, nextRequest))).error.code, 'PACING'); assert.equal(f.calls.reads.length, 1);
  f.advance(); const second = await f.send(step(1, nextRequest)); assert.equal(second.ok, true); assert.equal(second.data.done, false);
  f.advance(); const last = await f.send(step(2, finalRequest)); assert.equal(last.data.done, true); assert.equal(last.data.progress.status, 'completed');
  assert.deepEqual(f.calls.reads.map(call => call.domain), ['screen', 'book', 'music']);
  assert.deepEqual(clone(await f.send(step(2, finalRequest))), clone(last)); assert.equal(f.calls.reads.length, 3);
});

test('login, challenge and upstream errors remain explicit partial results and never return raw private details', async () => {
  const f = fixture((_run, domain) => {
    if (domain === 'screen') throw { code: 'DOUBAN_BROWSER_CHALLENGE', message: 'PRIVATE_HTML_SECRET' };
    if (domain === 'book') throw new Error('PRIVATE_COOKIE_SECRET');
    return page(domain);
  });
  await f.start(); const first = await f.send(step()); assert.equal(first.data.progress.sources.screen.status, 'blocked'); assert.equal(first.data.progress.sources.screen.errorCode, 'DOUBAN_BROWSER_CHALLENGE');
  f.advance(); const second = await f.send(step(1, nextRequest)); assert.equal(second.data.progress.sources.book.status, 'failed'); assert.equal(second.data.progress.sources.book.errorCode, 'DOUBAN_BROWSER_INVALID');
  f.advance(); const third = await f.send(step(2, finalRequest)); assert.equal(third.data.progress.status, 'partial'); assert.equal(third.data.done, true);
  assert.equal(JSON.stringify([first, second, third]).includes('PRIVATE_'), false);
});

test('worker exposes only documented diagnostic reason enums and never raw error messages or HTML', async () => {
  const reasons = ['input', 'document', 'structure_limit', 'account_link', 'heading', 'total', 'rows', 'item_url', 'item_title', 'item_comment', 'item_rating', 'item_date', 'duplicate_items', 'item_range', 'pagination_query', 'pagination_offset', 'pagination_incomplete', 'subject_identity', 'subject_structure', 'account_mismatch', 'collection_identity', 'script_unavailable', 'document_unavailable', 'document_position', 'result_shape', 'total_changed', 'duplicate_page'];
  for (const reason of reasons) {
    const f = fixture(() => { throw { code: 'DOUBAN_BROWSER_INVALID', reason, message: 'PRIVATE_RAW_HTML<script>unsafe()</script>' }; });
    await f.start(); const response = await f.send(step()); const source = response.data.progress.sources.screen;
    assert.equal(source.status, 'failed'); assert.equal(source.errorCode, 'DOUBAN_BROWSER_INVALID'); assert.equal(source.errorReason, reason);
    assert.equal(response.data.items.length, 0); assert.equal(JSON.stringify(response).includes('PRIVATE_RAW_HTML'), false); assert.equal(JSON.stringify(response).includes('<script>'), false);
    assert.deepEqual(clone(await f.send(step())), clone(response), 'lost-response replay keeps the same safe diagnostic');
    assert.equal(f.calls.reads.length, 1);
  }
  for (const reason of ['PRIVATE_RAW_HTML<script>unsafe()</script>', 'unknown_reason', { text: 'PRIVATE_RAW_HTML' }, ['account_link'], null, 1]) {
    const f = fixture(() => { throw { code: 'DOUBAN_BROWSER_INVALID', reason, message: 'PRIVATE_RAW_HTML<script>unsafe()</script>' }; });
    await f.start(); const response = await f.send(step());
    assert.equal(response.data.progress.sources.screen.errorReason == null, true);
    assert.equal(JSON.stringify(response).includes('PRIVATE_RAW_HTML'), false); assert.equal(JSON.stringify(response).includes('<script>'), false); assert.equal(JSON.stringify(response).includes('unknown_reason'), false);
  }
});

test('a later invalid page keeps earlier successful data and finishes partial rather than treating the source as empty', async () => {
  const f = fixture((run, domain) => {
    if (domain !== 'screen') return page(domain, []);
    if (run.sources.screen.start === 0) return page(domain, [record(domain)], { total: 2, nextStart: 1 });
    throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'account_link', message: 'PRIVATE_RAW_HTML' };
  });
  await f.start(); const first = await f.send(step()); assert.equal(first.data.items.length, 1); assert.equal(first.data.items[0].subjectId, '12345');
  f.advance(); const invalid = await f.send(step(1, nextRequest)); assert.equal(invalid.data.items.length, 0); assert.equal(invalid.data.done, false);
  const source = invalid.data.progress.sources.screen;
  assert.equal(source.status, 'failed'); assert.equal(source.errorReason, 'account_link'); assert.equal(source.pages, 1); assert.equal(source.received, 1); assert.equal(source.total, 2); assert.equal(source.start, 1);
  f.advance(); await f.send(step(2, finalRequest));
  f.advance(); const last = await f.send(step(3, '77777777-7777-4777-8777-777777777777'));
  assert.equal(last.data.done, true); assert.equal(last.data.progress.status, 'partial'); assert.equal(last.data.progress.received, 1); assert.equal(last.data.progress.sources.screen.errorReason, 'account_link'); assert.equal(last.data.items.length, 0);
  assert.deepEqual(f.calls.reads.map(call => [call.domain, call.offset]), [['screen', 0], ['screen', 1], ['book', 0], ['music', 0]]);
  assert.equal(JSON.stringify([first, invalid, last]).includes('PRIVATE_RAW_HTML'), false);
});

test('rate limits and account mismatch stop remaining domains without another collector request', async () => {
  for (const condition of ['rate', 'profile']) {
    const f = fixture(() => {
      if (condition === 'rate') throw { code: 'DOUBAN_BROWSER_RATE_LIMITED' };
      return page('screen', [record()], { accountProfileId: 'another_account' });
    });
    await f.start(); const response = await f.send(step()); assert.equal(response.data.done, true); assert.equal(response.data.items.length, 0); assert.equal(response.data.progress.status, 'failed');
    for (const source of Object.values(response.data.progress.sources)) assert.equal(source.status, 'blocked');
    assert.equal(f.calls.reads.length, 1); assert.equal((await f.send(step(1, nextRequest))).error.code, 'STEP_CONFLICT'); assert.equal(f.calls.reads.length, 1);
  }
});

test('cancellation aborts only owned reads and discards a late result rather than advancing the cancelled run', async () => {
  let resolveRead;
  const f = fixture((run, domain) => { run.tabs[domain] = 123; return new Promise(resolve => { resolveRead = resolve; }); });
  await f.start(); const pending = f.send(step());
  assert.equal((await f.send(message('CANCEL', { runId, ownerKey: secondOwner }))).error.code, 'RUN_NOT_FOUND'); assert.equal(f.calls.scripts.length, 0);
  const cancelled = await f.send(message('CANCEL', { runId })); assert.equal(cancelled.data.progress.status, 'cancelled'); assert.equal(cancelled.data.done, true);
  assert.equal(f.calls.scripts.length, 1); assert.deepEqual(clone(f.calls.scripts[0].target), { tabId: 123 }); assert.deepEqual(clone(f.calls.scripts[0].args), [runId]);
  resolveRead(page()); assert.equal((await pending).error.code, 'RUN_NOT_FOUND');
  assert.equal((await f.send(message('POLL', { runId }))).data.step, 0); assert.equal((await f.send(step())).error.code, 'STEP_CONFLICT');
});

test('worker restart reports unknown temporary state honestly without persisting or fabricating a result', async () => {
  const before = fixture(); await before.start(); await before.send(step());
  const after = fixture();
  assert.equal((await after.send(message('POLL', { runId }))).error.code, 'RUN_NOT_FOUND');
  assert.equal((await after.send(step())).error.code, 'RUN_NOT_FOUND'); assert.equal(after.calls.reads.length, 0);
  assert.equal((await after.send(message('STATUS'))).ok, true);
});

test('an explicit refreshed-page start cancels its old owner without exposing a late result to the new page', async () => {
  let resolveRead, count = 0;
  const f = fixture((run, domain) => {
    if (count++ === 0) { run.tabs[domain] = 123; return new Promise(resolve => { resolveRead = resolve; }); }
    return page(domain, [record(domain, '23456')]);
  });
  await f.start(); const pending = f.send(step());
  const refreshed = await f.send(message('START', { ownerKey: secondOwner })); assert.equal(refreshed.ok, true); assert.notEqual(refreshed.data.runId, runId); assert.equal(refreshed.data.progress.received, 0); assert.equal(refreshed.data.step, 0);
  assert.equal(f.calls.scripts.length, 1); assert.deepEqual(clone(f.calls.scripts[0].args), [runId]);
  resolveRead(page()); assert.equal((await pending).error.code, 'RUN_NOT_FOUND');
  assert.equal((await f.send(message('POLL', { runId }))).error.code, 'RUN_NOT_FOUND');
  const result = await f.send(step(0, nextRequest, { ownerKey: secondOwner, runId: refreshed.data.runId }));
  assert.equal(result.ok, true); assert.equal(result.data.items[0].subjectId, '23456'); assert.equal(JSON.stringify(result).includes('12345'), false);
});

test('a different website tab cannot take over a live run even when it supplies a new page owner key', async () => {
  const f = fixture(); await f.start();
  const result = await f.send(message('START', { ownerKey: secondOwner }), { ...sender, tab: { id: 8 } });
  assert.equal(result.error.code, 'RUN_BUSY'); assert.equal(f.calls.scripts.length + f.calls.reads.length, 0);
  assert.equal((await f.send(message('POLL', { runId }))).data.progress.status, 'running');
  assert.equal((await f.send(step())).ok, true); assert.equal(f.calls.reads.length, 1);
});

test('registered external-message listener keeps the channel open and returns safe protocol failures', async () => {
  let listener;
  const chromeApi = { runtime: { onMessageExternal: { addListener(fn) { listener = fn; } } } };
  loadWorker(chromeApi); assert.equal(typeof listener, 'function');
  const response = await new Promise(resolve => { assert.equal(listener(message('CONNECT'), sender, resolve), true); });
  assert.equal(response.ok, true);
  const denied = await new Promise(resolve => { listener(message('CONNECT'), { ...sender, url: 'https://evil.example/life/douban' }, resolve); });
  assert.equal(denied.error.code, 'FORBIDDEN');
});

test('default collector refuses a tab navigated to another origin or another profile before script injection', async () => {
  for (const url of ['https://evil.example/people/mine/collect', 'https://movie.douban.com/people/other/collect', 'http://movie.douban.com/people/mine/collect', 'https://accounts.douban.com/passport/login']) {
    let scripts = 0;
    const chromeApi = { tabs: { async create() { return { id: 100 }; }, async get() { return { id: 100, status: 'complete', url }; } }, scripting: { async executeScript() { scripts++; throw new Error('Must reject before script injection'); } } };
    const controller = loadWorker().testControllerFactory(chromeApi, { randomUUID: () => runId });
    await controller.handle(message('START'), sender); const result = await controller.handle(step(), sender);
    assert.equal(result.data.progress.sources.screen.errorCode, 'DOUBAN_BROWSER_LOGIN_REQUIRED'); assert.equal(result.data.items.length, 0); assert.equal(scripts, 0);
  }
});

test('Chrome injection failures expose fixed diagnostic enums without leaking private exception text', async () => {
  for (const [stage, reason] of [['files', 'script_unavailable'], ['function', 'document_unavailable'], ['result', 'result_shape']]) {
    const chromeApi = {
      tabs: { async create() { return { id: 100 }; }, async get() { return { id: 100, status: 'complete', url: 'https://movie.douban.com/people/mine/collect?start=0' }; } },
      scripting: { async executeScript(options) {
        if (options.files) { if (stage === 'files') throw new Error('PRIVATE_RAW_HTML<script>unsafe()</script>'); return []; }
        if (stage === 'function') throw new Error('PRIVATE_RAW_HTML<script>unsafe()</script>');
        return [{ result: 'PRIVATE_RAW_HTML<script>unsafe()</script>' }];
      } },
    };
    const controller = loadWorker().testControllerFactory(chromeApi, { randomUUID: () => runId });
    await controller.handle(message('START'), sender); const response = await controller.handle(step(), sender);
    const source = response.data.progress.sources.screen;
    assert.equal(source.status, 'failed'); assert.equal(source.errorCode, 'DOUBAN_BROWSER_INVALID'); assert.equal(source.errorReason, reason); assert.equal(response.data.items.length, 0);
    assert.equal(JSON.stringify(response).includes('PRIVATE_RAW_HTML'), false); assert.equal(JSON.stringify(response).includes('<script>'), false);
  }
});

test('serialized page runtime parses locally, fetches only a fixed same-origin continuation and returns normalized items', async () => {
  let clock = 10000, parserCalls = 0;
  const reads = [], injected = [], created = [], rawMarker = '<html>LOCAL_PRIVATE_RAW_HTML<script>untrusted challenge text</script></html>';
  const url = 'https://movie.douban.com/people/mine/collect?start=0';
  const location = new URL(url);
  const pageContext = {
    URL, AbortController, TextDecoder, setTimeout, clearTimeout, location, document: { documentElement: { outerHTML: rawMarker } },
    JiashuDoubanCollector: { parseCollection(html, profile, domain, start) {
      assert.equal(profile, 'mine'); assert.equal(domain, 'screen'); assert.equal(html, rawMarker); parserCalls++;
      return page(domain, [record(domain, String(12345 + start))], { nextStart: start === 0 ? 1 : null, total: 2 });
    } },
    async fetch(target, init) { reads.push({ target, init }); return new Response(rawMarker, { headers: { 'Content-Type': 'text/html' } }); },
  };
  const chromeApi = {
    tabs: { async create(options) { created.push(options); return { id: 100 }; }, async get() { return { id: 100, status: 'complete', url }; } },
    scripting: { async executeScript(options) {
      injected.push(options);
      if (options.files) { assert.deepEqual(clone(options.files), ['collector-parser.js', 'collector.js']); return []; }
      assert.equal(options.world, 'ISOLATED');
      pageContext.request = options.args[0];
      return [{ result: await runInNewContext('(' + options.func.toString() + ')(request)', pageContext) }];
    } },
  };
  const controller = loadWorker().testControllerFactory(chromeApi, { now: () => clock, randomUUID: () => runId });
  await controller.handle(message('START'), sender); const first = await controller.handle(step(), sender); assert.equal(reads.length, 0); assert.equal(first.data.items.length, 1);
  clock += 1500; const second = await controller.handle(step(1, nextRequest), sender); assert.equal(second.data.items.length, 1); assert.equal(reads.length, 1); assert.equal(parserCalls, 2);
  assert.equal(new URL(reads[0].target).origin, 'https://movie.douban.com'); assert.equal(new URL(reads[0].target).pathname, '/people/mine/collect'); assert.equal(new URL(reads[0].target).searchParams.get('start'), '1');
  assert.equal(reads[0].init.credentials, 'same-origin'); assert.equal(reads[0].init.redirect, 'manual'); assert.equal(new Headers(reads[0].init.headers).has('Cookie'), false);
  assert.equal(created.length, 1); assert.equal(injected.length, 4); assert.equal(JSON.stringify([first, second]).includes(rawMarker), false); assert.equal(JSON.stringify([first, second]).includes('untrusted challenge'), false);
  assert.equal(pageContext.__jiashuDoubanRead, undefined);
});

test('serialized runtime and owned-page bridge preserve a safe parser reason while discarding unknown or scripted diagnostics', async () => {
  for (const reason of ['account_link', 'pagination_query', 'PRIVATE_RAW_HTML<script>unsafe()</script>', { reason: 'item_url' }, ['account_link']]) {
    let parses = 0, requests = 0;
    const url = 'https://movie.douban.com/people/mine/collect?start=0';
    const pageContext = {
      URL, AbortController, TextDecoder, setTimeout, clearTimeout, location: new URL(url), document: { documentElement: { outerHTML: '<html>PRIVATE_RAW_HTML<script>unsafe()</script></html>' } },
      JiashuDoubanCollector: { parseCollection() { parses++; throw { code: 'DOUBAN_BROWSER_INVALID', reason, message: 'PRIVATE_RAW_HTML<script>unsafe()</script>' }; } },
      fetch() { requests++; throw new Error('First-page diagnostics must not fetch or execute page code'); },
    };
    const chromeApi = {
      tabs: { async create() { return { id: 100 }; }, async get() { return { id: 100, status: 'complete', url }; } },
      scripting: { async executeScript(options) {
        if (options.files) return [];
        pageContext.request = options.args[0]; return [{ result: await runInNewContext('(' + options.func.toString() + ')(request)', pageContext) }];
      } },
    };
    const controller = loadWorker().testControllerFactory(chromeApi, { randomUUID: () => runId });
    await controller.handle(message('START'), sender); const response = await controller.handle(step(), sender);
    const source = response.data.progress.sources.screen;
    assert.equal(source.errorCode, 'DOUBAN_BROWSER_INVALID'); assert.equal(response.data.items.length, 0); assert.equal(parses, 1); assert.equal(requests, 0);
    if (typeof reason === 'string' && ['account_link', 'pagination_query'].includes(reason)) assert.equal(source.errorReason, reason);
    else assert.equal(source.errorReason == null, true);
    assert.equal(JSON.stringify(response).includes('PRIVATE_RAW_HTML'), false); assert.equal(JSON.stringify(response).includes('<script>'), false); assert.equal(pageContext.__jiashuDoubanRead, undefined);
  }
});
