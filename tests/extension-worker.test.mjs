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
const subject = (id = requestId, extra = {}) => message('SUBJECT', { requestId: id, domain: 'screen', subjectId: '12345', ...extra });
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function loadWorker(chromeApi) {
  const context = { URL, URLSearchParams, TextEncoder, structuredClone, crypto: { randomUUID: () => runId }, setTimeout, clearTimeout, ...(chromeApi ? { chrome: chromeApi } : {}) };
  runInNewContext(readFileSync(new URL('details-parser.js', extensionRoot), 'utf8').replace(/^export\s+/gm, ''), context);
  runInNewContext(workerSource.replace(/^import \{ parseDoubanDetails \} from '\.\/details-parser\.js';\r?\n/m, '').replace(/^export\s+/gm, '')
    + '\n;globalThis.testControllerFactory=createDoubanExtensionController;globalThis.cloneInjectionResult=value=>JSON.parse(JSON.stringify(value));', context);
  return context;
}
function fixture(readPage, readSubject) {
  let clock = 10000, issuedRuns = 0;
  const calls = { reads: [], subjectReads: [], created: [], updated: [], scripts: [] };
  const chromeApi = {
    tabs: { async create(options) { calls.created.push(clone(options)); return { id: 100, ...options }; }, async update(id, options) { calls.updated.push({ id, ...clone(options) }); } },
    scripting: { async executeScript(options) { calls.scripts.push(options); return []; } },
    get storage() { throw new Error('Sync must not persist private records or credentials'); },
    get cookies() { throw new Error('Sync must not access the Cookie API'); },
  };
  const worker = loadWorker();
  const controller = worker.testControllerFactory(chromeApi, { now: () => clock, randomUUID: () => issuedRuns++ === 0 ? runId : finalRequest, readPage: async (run, domain) => {
    calls.reads.push({ runId: run.id, ownerKey: run.ownerKey, profileId: run.profileId, domain, offset: run.sources[domain].start });
    return readPage ? readPage(run, domain) : page(domain);
  }, readSubject: async job => {
    calls.subjectReads.push({ requestId: job.requestId, ownerKey: job.ownerKey, profileId: job.profileId, domain: job.domain, subjectId: job.subjectId, collectionRunId: job.collectionRunId });
    const result = readSubject ? await readSubject(job) : { kind: job.domain === 'screen' ? 'series' : job.domain, coverUrl: null,
      details: { summary: '合成作品简介', doubanRating: 8.6, ratingCount: 321, year: 2026 } };
    // Chrome serializes an isolated-world result into the service worker realm.
    return worker.cloneInjectionResult(result);
  } });
  return { controller, chromeApi, calls, advance(ms = 1500) { clock += ms; }, send(body, from = sender) { return controller.handle(body, from); }, async start() { const response = await controller.handle(message('START'), sender); assert.equal(response.ok, true); return response; } };
}

test('local Douban extension grants only collection hosts and never asks for Cookie or request interception permissions', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', extensionRoot), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.5');
  assert.deepEqual(manifest.permissions.toSorted(), ['scripting', 'tabs']);
  assert.deepEqual(manifest.host_permissions.toSorted(), ['https://book.douban.com/*', 'https://movie.douban.com/*', 'https://music.douban.com/*']);
  assert.deepEqual(manifest.externally_connectable.matches, [productionOrigin + '/*']);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'");
});

test('a selected source run reads only those collections, reports skipped sources and preserves immutable replay', async () => {
  const f = fixture();
  const started = await f.send(message('START', { domains: ['book'] }));
  assert.equal(started.ok, true);
  assert.equal(started.data.progress.sources.screen.status, 'skipped');
  assert.equal(started.data.progress.sources.music.status, 'skipped');
  assert.equal(f.calls.reads.length, 0);
  const result = await f.send(step());
  assert.equal(result.data.done, true);
  assert.equal(result.data.progress.status, 'completed');
  assert.equal(result.data.progress.sources.book.status, 'complete');
  assert.equal(result.data.items[0].source, 'browser');
  assert.deepEqual(f.calls.reads.map(read => read.domain), ['book']);
  assert.deepEqual(clone(await f.send(step())), clone(result));
  assert.equal(f.calls.reads.length, 1);
});

test('invalid source selections fail before starting or reading and cannot be injected into a running step', async () => {
  const f = fixture();
  for (const domains of [[], ['book', 'book'], ['unknown'], ['book', 'music', 'screen', 'book'], 'book', null, { book: true }]) {
    assert.equal((await f.send(message('START', { domains }))).error.code, 'INVALID_REQUEST');
  }
  assert.equal(f.calls.reads.length, 0);
  await f.send(message('START', { domains: ['music', 'book'] }));
  assert.equal((await f.send(step(0, requestId, { domains: ['screen'] }))).error.code, 'INVALID_REQUEST');
  const first = await f.send(step());
  assert.equal(first.data.done, false);
  f.advance();
  const second = await f.send(step(1, nextRequest));
  assert.equal(second.data.done, true);
  assert.deepEqual(f.calls.reads.map(read => read.domain), ['book', 'music']);
});

test('subject reads accept only fixed subject keys and reject URLs, credentials, frames and invalid identities before any read', async () => {
  const f = fixture();
  for (const body of [subject(requestId, { url: 'https://evil.example/' }), subject(requestId, { cookie: 'PRIVATE_COOKIE' }),
    subject(requestId, { domain: 'other' }), subject(requestId, { subjectId: '../secret' }), subject(requestId, { subjectId: ['12345'] }),
    subject('bad-id'), message('SUBJECT_CANCEL', { requestId: ['bad'] }), subject(requestId, { ownerKey: 'not-a-uuid' }),
    subject(requestId, { runId: null }), subject(requestId, { runId: [runId] }), subject(requestId, { runId: 'bad-run' })]) {
    assert.equal((await f.send(body)).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await f.send(subject(), { ...sender, frameId: 1 })).error.code, 'FORBIDDEN');
  assert.equal(f.calls.subjectReads.length + f.calls.created.length + f.calls.scripts.length, 0);
});

test('subject responses contain public metadata only, replay once, and never reveal cached results across owner, profile or tab', async () => {
  const f = fixture(), first = await f.send(subject());
  assert.equal(first.ok, true); assert.equal(first.data.requestId, requestId); assert.equal(first.data.domain, 'screen'); assert.equal(first.data.subjectId, '12345');
  assert.equal(first.data.metadata.kind, 'series'); assert.equal(first.data.metadata.details.doubanRating, 8.6);
  assert.deepEqual(Object.keys(first.data).sort(), ['domain', 'metadata', 'requestId', 'subjectId']);
  assert.deepEqual(clone(await f.send(subject())), clone(first)); assert.equal(f.calls.subjectReads.length, 1);
  first.data.metadata.details.summary = 'changed by website';
  assert.equal((await f.send(subject())).data.metadata.details.summary, '合成作品简介');
  assert.equal((await f.send(subject(requestId, { subjectId: '12346' }))).error.code, 'STEP_CONFLICT');
  for (const [payload, from] of [[subject(requestId, { ownerKey: secondOwner }), sender], [subject(requestId, { profileId: 'other' }), sender],
    [subject(), { ...sender, tab: { id: 8 } }]]) assert.equal((await f.send(payload, from)).error.code, 'RUN_NOT_FOUND');
  assert.equal(f.calls.subjectReads.length, 1);
});

test('held subject reads are exclusive and cancellation discards their eventual result without crossing ownership', async () => {
  let resolveRead;
  const f = fixture(undefined, () => new Promise(resolve => { resolveRead = resolve; }));
  const pending = f.send(subject());
  assert.equal((await f.send(subject())).error.code, 'RUN_BUSY');
  assert.equal((await f.send(subject(nextRequest))).error.code, 'RUN_BUSY');
  assert.equal((await f.send(message('START'))).error.code, 'RUN_BUSY');
  assert.equal((await f.send(message('SUBJECT_CANCEL', { requestId, ownerKey: secondOwner }))).error.code, 'RUN_NOT_FOUND');
  assert.equal((await f.send(message('SUBJECT_CANCEL', { requestId }))).data.cancelled, true);
  resolveRead({ kind: 'movie', coverUrl: null, details: { summary: 'SHOULD_NOT_RETURN' } });
  assert.equal((await pending).error.code, 'RUN_NOT_FOUND');
  assert.equal((await f.send(subject())).error.code, 'RUN_NOT_FOUND');
  assert.equal(f.calls.subjectReads.length, 1);
});

test('idle own collections interleave one subject read while sharing pacing and preserving collection replay and cursor', async () => {
  const f = fixture(); await f.start();
  const first = await f.send(step());
  const lookup = subject(nextRequest, { runId });
  assert.equal((await f.send(lookup)).error.code, 'PACING');
  f.advance(); const metadata = await f.send(lookup); assert.equal(metadata.ok, true);
  assert.equal(f.calls.subjectReads[0].collectionRunId, runId);
  assert.deepEqual(clone(await f.send(lookup)), clone(metadata)); assert.equal(f.calls.subjectReads.length, 1);
  assert.deepEqual(clone(await f.send(step())), clone(first)); assert.equal(f.calls.reads.length, 1);
  const poll = await f.send(message('POLL', { runId })); assert.equal(poll.data.step, 1); assert.equal(poll.data.done, false);
  const paced = await f.send(step(1, finalRequest));
  assert.equal(paced.error.code, 'PACING'); assert.equal(paced.error.retryAfter, 2);
  f.advance(); assert.equal((await f.send(step(1, finalRequest))).ok, true);
  await f.send(message('CANCEL', { runId }));
  const restarted = await f.start(); assert.equal((await f.send(step(0, finalRequest, { runId: restarted.data.runId }))).error.code, 'PACING');
});

test('interleaving cannot read through another owner, profile or tab, and an explicit parent must identify the current owned run', async () => {
  const f = fixture(); await f.start(); await f.send(step()); f.advance();
  for (const [payload, from] of [[subject(nextRequest, { ownerKey: secondOwner }), sender], [subject(nextRequest, { profileId: 'other' }), sender],
    [subject(nextRequest), { ...sender, tab: { id: 8 } }]]) assert.equal((await f.send(payload, from)).error.code, 'RUN_BUSY');
  for (const [payload, from] of [[subject(nextRequest, { runId, ownerKey: secondOwner }), sender], [subject(nextRequest, { runId, profileId: 'other' }), sender],
    [subject(nextRequest, { runId }), { ...sender, tab: { id: 8 } }], [subject(nextRequest, { runId: finalRequest }), sender]]) {
    assert.equal((await f.send(payload, from)).error.code, 'RUN_NOT_FOUND');
  }
  assert.equal(f.calls.subjectReads.length, 0);
  const own = await f.send(subject(nextRequest, { runId })); assert.equal(own.ok, true);
  assert.equal((await f.send(subject(nextRequest))).error.code, 'STEP_CONFLICT');
  assert.equal(f.calls.subjectReads.length, 1);
});

test('collection and subject network reads are mutually exclusive while immutable page replays remain available', async () => {
  let resolveCollection, resolveSubject, collectionCount = 0;
  const f = fixture((run, domain) => collectionCount++ === 0 ? new Promise(resolve => { resolveCollection = resolve; }) : page(domain),
    () => new Promise(resolve => { resolveSubject = resolve; }));
  await f.start(); const collectionPending = f.send(step());
  f.advance(); assert.equal((await f.send(subject(nextRequest, { runId }))).error.code, 'RUN_BUSY'); assert.equal(f.calls.subjectReads.length, 0);
  resolveCollection(page()); const first = await collectionPending;
  const subjectPending = f.send(subject(nextRequest, { runId })); assert.equal(f.calls.subjectReads.length, 1);
  f.advance(); assert.equal((await f.send(step(1, finalRequest))).error.code, 'RUN_BUSY');
  assert.equal((await f.send(message('START'))).error.code, 'RUN_BUSY');
  assert.equal((await f.send(message('START', { ownerKey: secondOwner }))).error.code, 'RUN_BUSY');
  assert.deepEqual(clone(await f.send(step())), clone(first)); assert.equal(f.calls.reads.length, 1);
  resolveSubject({ kind: 'movie', coverUrl: null, details: {} }); assert.equal((await subjectPending).ok, true);
  assert.equal((await f.send(step(1, finalRequest))).ok, true); assert.equal(f.calls.reads.length, 2);
});

test('cancelling a collection also cancels only its associated subject, discards late results and invalidates cached metadata', async () => {
  let resolveSubject;
  const f = fixture((run, domain) => { run.tabs[domain] = 123; return page(domain); }, job => {
    job.tabs[job.domain] = 456; return new Promise(resolve => { resolveSubject = resolve; });
  });
  await f.start(); await f.send(step()); f.advance();
  const lookup = subject(nextRequest, { runId }), pending = f.send(lookup);
  assert.equal((await f.send(message('CANCEL', { runId, ownerKey: secondOwner }))).error.code, 'RUN_NOT_FOUND');
  assert.equal((await f.send(message('CANCEL', { runId }), { ...sender, tab: { id: 8 } })).error.code, 'RUN_NOT_FOUND');
  assert.equal(f.calls.scripts.length, 0);
  assert.equal((await f.send(message('CANCEL', { runId }))).data.done, true);
  assert.deepEqual(f.calls.scripts.map(call => clone(call.args)), [[runId], [nextRequest]]);
  resolveSubject({ kind: 'movie', coverUrl: null, details: { summary: 'OLD_PAGE_MUST_NOT_RETURN' } });
  const late = await pending; assert.equal(late.error.code, 'RUN_NOT_FOUND'); assert.doesNotMatch(JSON.stringify(late), /OLD_PAGE/);
  assert.equal((await f.send(lookup)).error.code, 'RUN_NOT_FOUND');
  assert.equal((await f.send(subject(finalRequest, { runId }))).error.code, 'RUN_NOT_FOUND');
  assert.equal(f.calls.subjectReads.length, 1);
});

test('the final saved page can still bind automatic metadata to its completed run and later cancellation clears its cache', async () => {
  const f = fixture(); await f.start(); await f.send(step());
  f.advance(); await f.send(step(1, nextRequest)); f.advance(); const final = await f.send(step(2, finalRequest)); assert.equal(final.data.done, true);
  f.advance(); const lookup = subject('77777777-7777-4777-8777-777777777777', { runId });
  const completed = await f.send(lookup); assert.equal(completed.ok, true); assert.equal(f.calls.subjectReads[0].collectionRunId, runId);
  assert.deepEqual(clone(await f.send(lookup)), clone(completed));
  await f.send(message('CANCEL', { runId }));
  assert.equal((await f.send(lookup)).error.code, 'RUN_NOT_FOUND'); assert.equal(f.calls.subjectReads.length, 1);
});

test('a legacy manual request may interleave its own idle running collection and is cancelled with that parent', async () => {
  const f = fixture(); await f.start(); await f.send(step()); f.advance();
  const lookup = subject(nextRequest), response = await f.send(lookup);
  assert.equal(response.ok, true); assert.equal(f.calls.subjectReads[0].collectionRunId, runId);
  assert.deepEqual(clone(await f.send(lookup)), clone(response)); assert.equal(f.calls.subjectReads.length, 1);
  await f.send(message('CANCEL', { runId }));
  assert.equal((await f.send(lookup)).error.code, 'RUN_NOT_FOUND');
});

test('a cancelled generation cannot publish metadata into a refreshed page or return old cached facts under the new parent', async () => {
  let resolveSubject;
  const f = fixture(undefined, () => new Promise(resolve => { resolveSubject = resolve; }));
  await f.start(); await f.send(step()); f.advance(); const old = f.send(subject(nextRequest, { runId }));
  await f.send(message('CANCEL', { runId }));
  const fresh = await f.send(message('START', { ownerKey: secondOwner })); assert.equal(fresh.ok, true);
  resolveSubject({ kind: 'series', coverUrl: null, details: { summary: 'OLD_GENERATION' } });
  assert.equal((await old).error.code, 'RUN_NOT_FOUND');
  assert.equal((await f.send(subject(nextRequest, { runId: fresh.data.runId, ownerKey: secondOwner }))).error.code, 'RUN_NOT_FOUND');
  assert.equal(f.calls.subjectReads.length, 1); assert.equal((await f.send(message('POLL', { runId: fresh.data.runId, ownerKey: secondOwner }))).data.step, 0);
});

test('manual metadata remains independent when another caller owns only an already completed collection', async () => {
  let resolveSubject;
  const f = fixture(undefined, job => { job.tabs[job.domain] = 456; return new Promise(resolve => { resolveSubject = resolve; }); });
  await f.start(); await f.send(step()); f.advance(); await f.send(step(1, nextRequest)); f.advance(); await f.send(step(2, finalRequest)); f.advance();
  const from = { ...sender, tab: { id: 8 } }, lookup = subject('77777777-7777-4777-8777-777777777777', { ownerKey: secondOwner, profileId: 'other_profile' });
  const pending = f.send(lookup, from); assert.equal(f.calls.subjectReads[0].collectionRunId, null);
  await f.send(message('CANCEL', { runId })); assert.equal(f.calls.scripts.length, 0);
  resolveSubject({ kind: 'movie', coverUrl: null, details: {} }); assert.equal((await pending).ok, true);
  assert.equal((await f.send(lookup, from)).ok, true); assert.equal(f.calls.subjectReads.length, 1);
});

test('subject challenge failures are fixed-label cached responses and invalid or personal metadata never leaves the worker', async () => {
  const f = fixture(undefined, () => { throw { code: 'DOUBAN_BROWSER_CHALLENGE', rawHTML: 'PRIVATE_HTML', message: 'PRIVATE_COOKIE' }; });
  const failed = await f.send(subject()); assert.equal(failed.error.code, 'DOUBAN_BROWSER_CHALLENGE');
  assert.equal((await f.send(subject())).error.code, 'DOUBAN_BROWSER_CHALLENGE'); assert.equal(f.calls.subjectReads.length, 1);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_|rawHTML|cookie/i);
  for (const metadata of [{ kind: 'movie', coverUrl: null, details: { cookie: 'PRIVATE_COOKIE' } },
    { kind: 'movie', coverUrl: null, details: {}, comment: 'PRIVATE_COMMENT' },
    { kind: 'book', coverUrl: null, details: {} }, { kind: 'movie', coverUrl: null, details: { summary: '中'.repeat(6000) } },
    { kind: 'movie', coverUrl: null, details: { year: -1 } }, { kind: 'movie', coverUrl: null, details: { cast: 3 } },
    { kind: 'movie', coverUrl: null, details: { summary: '<script>BAD_HTML</script>' } }]) {
    const invalid = fixture(undefined, () => metadata), result = await invalid.send(subject());
    assert.equal(result.error.code, 'DOUBAN_BROWSER_INVALID'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|summary|comment|cookie/i);
  }
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
  assert.deepEqual(clone(response), { ok: true, data: { extensionVersion: '1.0.5', protocolVersion: 1 } });
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
  assert.equal(result.data.items[0].source, 'browser');
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
  const reasons = ['input', 'document', 'structure_limit', 'account_navigation', 'heading', 'total', 'rows', 'item_url', 'item_title', 'item_comment', 'item_rating', 'item_date', 'duplicate_items', 'item_range', 'pagination_query', 'pagination_offset', 'pagination_incomplete', 'subject_identity', 'subject_structure', 'account_mismatch', 'collection_identity', 'script_unavailable', 'document_unavailable', 'document_position', 'result_shape', 'total_changed', 'duplicate_page'];
  for (const reason of reasons) {
    const f = fixture(() => { throw { code: 'DOUBAN_BROWSER_INVALID', reason, message: 'PRIVATE_RAW_HTML<script>unsafe()</script>' }; });
    await f.start(); const response = await f.send(step()); const source = response.data.progress.sources.screen;
    assert.equal(source.status, 'failed'); assert.equal(source.errorCode, 'DOUBAN_BROWSER_INVALID'); assert.equal(source.errorReason, reason);
    assert.equal(response.data.items.length, 0); assert.equal(JSON.stringify(response).includes('PRIVATE_RAW_HTML'), false); assert.equal(JSON.stringify(response).includes('<script>'), false);
    assert.deepEqual(clone(await f.send(step())), clone(response), 'lost-response replay keeps the same safe diagnostic');
    assert.equal(f.calls.reads.length, 1);
  }
  for (const reason of ['PRIVATE_RAW_HTML<script>unsafe()</script>', 'unknown_reason', { text: 'PRIVATE_RAW_HTML' }, ['account_navigation'], null, 1]) {
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
    throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'account_navigation', message: 'PRIVATE_RAW_HTML' };
  });
  await f.start(); const first = await f.send(step()); assert.equal(first.data.items.length, 1); assert.equal(first.data.items[0].subjectId, '12345');
  f.advance(); const invalid = await f.send(step(1, nextRequest)); assert.equal(invalid.data.items.length, 0); assert.equal(invalid.data.done, false);
  const source = invalid.data.progress.sources.screen;
  assert.equal(source.status, 'failed'); assert.equal(source.errorReason, 'account_navigation'); assert.equal(source.pages, 1); assert.equal(source.received, 1); assert.equal(source.total, 2); assert.equal(source.start, 1);
  f.advance(); await f.send(step(2, finalRequest));
  f.advance(); const last = await f.send(step(3, '77777777-7777-4777-8777-777777777777'));
  assert.equal(last.data.done, true); assert.equal(last.data.progress.status, 'partial'); assert.equal(last.data.progress.received, 1); assert.equal(last.data.progress.sources.screen.errorReason, 'account_navigation'); assert.equal(last.data.items.length, 0);
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
  const next = step(0, nextRequest, { ownerKey: secondOwner, runId: refreshed.data.runId });
  assert.equal((await f.send(next)).error.code, 'PACING'); f.advance();
  const result = await f.send(next);
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

test('default collection tabs use screen type=all and retain book/music rating=all', async () => {
  let clock = 10000;
  const tabs = new Map(), created = [], requests = [];
  const chromeApi = {
    tabs: { async create(options) { const id = 100 + created.length; created.push(options); tabs.set(id, options.url); return { id }; }, async get(id) { return { id, status: 'complete', url: tabs.get(id) }; } },
    scripting: { async executeScript(options) { if (options.files) return []; requests.push(options.args[0]); return [{ result: { ok: true, page: page(options.args[0].domain) } }]; } },
  };
  const controller = loadWorker().testControllerFactory(chromeApi, { now: () => clock, randomUUID: () => runId });
  await controller.handle(message('START'), sender);
  for (const [number, id] of [[0, requestId], [1, nextRequest], [2, finalRequest]]) { assert.equal((await controller.handle(step(number, id), sender)).ok, true); clock += 1500; }
  assert.equal(created.length, 3); assert.deepEqual(requests.map(request => request.domain), ['screen', 'book', 'music']);
  for (let index = 0; index < created.length; index++) {
    const url = new URL(created[index].url), domain = ['screen', 'book', 'music'][index];
    assert.equal(url.hostname, { screen: 'movie', book: 'book', music: 'music' }[domain] + '.douban.com'); assert.equal(url.pathname, '/people/mine/collect');
    assert.deepEqual(Object.fromEntries(url.searchParams), { start: '0', sort: 'time', ...(domain === 'screen' ? { type: 'all' } : { rating: 'all' }), filter: 'all', mode: 'grid' });
    assert.equal(requests[index].url, created[index].url); assert.equal(requests[index].firstPage, true);
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
  const url = 'https://movie.douban.com/people/mine/collect?start=0&sort=time&type=all&filter=all&mode=grid';
  const location = new URL(url);
  const pageContext = {
    URL, AbortController, TextDecoder, setTimeout, clearTimeout, location, document: { documentElement: { outerHTML: rawMarker } },
    JiashuDoubanCollector: { parseCollection(html, profile, domain, start) {
      assert.equal(profile, 'mine'); assert.equal(domain, 'screen'); assert.equal(html, rawMarker); parserCalls++;
      assert.ok(start === 0 || start === 15);
      return page(domain, Array.from({ length: start === 0 ? 15 : 2 }, (_, index) => record(domain, String(12345 + start + index))), { nextStart: start === 0 ? 15 : null, total: 17 });
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
  await controller.handle(message('START'), sender); const first = await controller.handle(step(), sender); assert.equal(reads.length, 0); assert.equal(first.data.items.length, 15);
  clock += 1500; const second = await controller.handle(step(1, nextRequest), sender); assert.equal(second.data.items.length, 2); assert.equal(reads.length, 1); assert.equal(parserCalls, 2);
  assert.equal(new URL(reads[0].target).origin, 'https://movie.douban.com'); assert.equal(new URL(reads[0].target).pathname, '/people/mine/collect');
  assert.deepEqual(Object.fromEntries(new URL(reads[0].target).searchParams), { start: '15', sort: 'time', type: 'all', filter: 'all', mode: 'grid' });
  assert.deepEqual(Object.fromEntries(new URL(created[0].url).searchParams), { start: '0', sort: 'time', type: 'all', filter: 'all', mode: 'grid' });
  assert.equal(reads[0].init.credentials, 'same-origin'); assert.equal(reads[0].init.redirect, 'manual'); assert.equal(new Headers(reads[0].init.headers).has('Cookie'), false);
  assert.equal(created.length, 1); assert.equal(injected.length, 4); assert.equal(JSON.stringify([first, second]).includes(rawMarker), false); assert.equal(JSON.stringify([first, second]).includes('untrusted challenge'), false);
  assert.equal(pageContext.__jiashuDoubanRead, undefined);
});

test('serialized runtime and owned-page bridge preserve a safe parser reason while discarding unknown or scripted diagnostics', async () => {
  for (const reason of ['account_navigation', 'pagination_query', 'PRIVATE_RAW_HTML<script>unsafe()</script>', { reason: 'item_url' }, ['account_navigation']]) {
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
    if (typeof reason === 'string' && ['account_navigation', 'pagination_query'].includes(reason)) assert.equal(source.errorReason, reason);
    else assert.equal(source.errorReason == null, true);
    assert.equal(JSON.stringify(response).includes('PRIVATE_RAW_HTML'), false); assert.equal(JSON.stringify(response).includes('<script>'), false); assert.equal(pageContext.__jiashuDoubanRead, undefined);
  }
});
