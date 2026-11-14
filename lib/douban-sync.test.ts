import assert from 'node:assert/strict';
import test from 'node:test';
import { doubanSubjectUrl, type DoubanDomain, type DoubanRecordInput } from './douban.ts';
import { DoubanSourceError } from './douban-source.ts';
import { advanceDoubanSyncStep, createDoubanSyncState, parseDoubanSyncState, presentDoubanRun, DoubanSyncError, type DoubanRunForSync, type DoubanSyncDependencies } from './douban-sync.ts';

function record(domain: DoubanDomain = 'screen', subjectId = '12345', source: DoubanRecordInput['source'] = 'collection'): DoubanRecordInput {
  return { domain, subjectId, kind: domain, title: '合成书影音条目', url: doubanSubjectUrl(domain, subjectId), coverUrl: null,
    rating: 3, markedDate: source === 'rss' ? null : '2026-11-01', comment: null, publishedAt: source === 'rss' ? '2026-11-01T00:00:00.000Z' : null, source };
}
function run(state = createDoubanSyncState()): DoubanRunForSync {
  return { id: '11111111-1111-4111-8111-111111111111', profileId: 'synthetic-owner', connectionRevision: 1, revision: 0, status: 'running', state,
    added: 0, updated: 0, unchanged: 0, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', finishedAt: null };
}
function dependencies(overrides: Partial<DoubanSyncDependencies> = {}): DoubanSyncDependencies {
  return { collection: async () => ({ items: [], nextStart: null, total: 0 }), rss: async () => [], classify: async () => null,
    nextUnclassified: async () => null, countUnclassified: async () => 0, ...overrides };
}
async function advance(current: DoubanRunForSync, deps: DoubanSyncDependencies) {
  const decision = await advanceDoubanSyncStep(current, deps);
  Object.assign(current, { state: decision.state, status: decision.status, revision: current.revision + 1 });
  return decision;
}

test('a complete set of proven-empty public collection pages can finish without RSS or subject requests', async () => {
  const current = run(), reads: string[] = [];
  const deps = dependencies({ collection: async (profile, domain, start) => { assert.equal(profile, current.profileId); reads.push(domain + ':' + start); return { items: [], nextStart: null, total: 0 }; },
    rss: async () => { throw new Error('RSS cannot be read for a complete collection'); }, classify: async () => { throw new Error('No subject to classify'); } });
  for (let i = 0; i < 5; i++) await advance(current, deps);
  assert.equal(current.status, 'completed');
  assert.deepEqual(reads, ['screen:0', 'book:0', 'music:0']);
  assert.equal(parseDoubanSyncState(current.state).rss.status, 'skipped');
  assert.match(presentDoubanRun(current).message, /公开收藏分页已读取完成/);
});

test('each step reads at most one public page and a failed category does not erase observations or prevent other categories', async () => {
  const current = run(), calls: string[] = [];
  const deps = dependencies({ collection: async (_profile, domain, start) => {
    calls.push(domain + ':' + start);
    if (domain === 'book') throw new DoubanSourceError('DOUBAN_SOURCE_BLOCKED', 'PRIVATE-UPSTREAM');
    return { items: domain === 'screen' ? [record()] : [], nextStart: null, total: domain === 'screen' ? 1 : 0 };
  }, rss: async () => { calls.push('rss'); return [record('book', '22222', 'rss')]; } });
  const before = structuredClone(current.state);
  const first = await advanceDoubanSyncStep(current, deps);
  assert.deepEqual(current.state, before, 'planning must not mutate the loaded run');
  assert.equal(calls.length, 1); assert.equal(first.items.length, 1);
  await advance(current, deps); await advance(current, deps); await advance(current, deps); await advance(current, deps); await advance(current, deps);
  assert.equal(current.status, 'partial');
  const state = parseDoubanSyncState(current.state);
  assert.equal(state.sources.book.status, 'blocked'); assert.equal(state.sources.music.status, 'complete');
  assert.equal(state.rss.status, 'complete'); assert.equal(state.rss.received, 1);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE-UPSTREAM/);
  assert.match(presentDoubanRun(current).message, /未将近期动态当作历史全量/);
});

test('all sources unavailable is a failed run, not an empty successful library', async () => {
  const current = run(), deps = dependencies({ collection: async () => { throw new DoubanSourceError('DOUBAN_SOURCE_CHALLENGE'); },
    rss: async () => { throw new Error('PRIVATE-NETWORK'); } });
  for (let i = 0; i < 5; i++) await advance(current, deps);
  assert.equal(current.status, 'failed'); assert.match(presentDoubanRun(current).message, /已有收藏保留/);
  assert.doesNotMatch(JSON.stringify(current.state), /PRIVATE-NETWORK/);
});

test('an upstream rate limit stops all further network stages rather than trying more endpoints', async () => {
  const current = run(); let calls = 0;
  await advance(current, dependencies({ collection: async () => { calls++; throw new DoubanSourceError('DOUBAN_SOURCE_RATE_LIMITED'); },
    rss: async () => { calls++; return []; } }));
  assert.equal(calls, 1); assert.equal(current.status, 'failed');
  assert.equal(parseDoubanSyncState(current.state).phase, 'done');
  assert.equal(parseDoubanSyncState(current.state).rss.status, 'skipped');
  assert.match(presentDoubanRun(current).message, /停止后续访问/);
});

test('monotonic offsets and different page IDs are required before a continuation can advance', async () => {
  for (const nextStart of [-1, 0, 100001, 1.5]) {
    const current = run();
    const decision = await advance(current, dependencies({ collection: async () => ({ items: [record()], nextStart, total: 20 }) }));
    assert.equal(decision.items.length, 0); assert.equal(parseDoubanSyncState(current.state).sources.screen.status, 'failed');
  }
  const current = run(), deps = dependencies({ collection: async (_profile, _domain, start) => ({ items: [record()], nextStart: start + 15, total: 50 }) });
  assert.equal((await advance(current, deps)).items.length, 1);
  const repeated = await advance(current, deps);
  assert.equal(repeated.items.length, 0);
  assert.equal(parseDoubanSyncState(current.state).sources.screen.errorCode, 'DOUBAN_PAGINATION_STALLED');
});

test('collection items cannot change source/domain and RSS cannot smuggle another source or invalid subject URL', async () => {
  const current = run();
  await advance(current, dependencies({ collection: async () => ({ items: [record('music')], nextStart: null, total: 1 }) }));
  assert.equal(parseDoubanSyncState(current.state).sources.screen.status, 'failed');
  const state = createDoubanSyncState(); state.phase = 'rss'; state.sources.screen.status = 'blocked';
  const rssRun = run(state);
  const decision = await advance(rssRun, dependencies({ rss: async () => [record('book', '12345', 'import')] }));
  assert.equal(decision.items.length, 0); assert.equal(parseDoubanSyncState(rssRun.state).rss.status, 'failed');
});

test('RSS supplements only incomplete domains and cannot replace a successfully read collection with older activity', async () => {
  const state = createDoubanSyncState(); state.phase = 'rss'; state.sources.music.status = 'complete'; state.sources.music.received = 1;
  state.sources.book.status = 'blocked'; state.sources.screen.status = 'complete';
  const current = run(state);
  const olderMusic = { ...record('music', '33333', 'rss'), rating: 3 as const };
  const missingBook = record('book', '22222', 'rss');
  const decision = await advance(current, dependencies({ rss: async () => [olderMusic, missingBook] }));
  assert.deepEqual(decision.items, [missingBook]);
  assert.equal(parseDoubanSyncState(current.state).rss.received, 1);
});

test('RSS never overflows the bounded thirty-record atomic storage step or silently truncates a larger feed', async () => {
  const state = createDoubanSyncState(); state.phase = 'rss'; state.sources.book.status = 'blocked';
  const current = run(state), feed = Array.from({ length: 31 }, (_, index) => record('book', String(10000 + index), 'rss'));
  const decision = await advance(current, dependencies({ rss: async () => feed }));
  assert.deepEqual(decision.items, []); assert.equal(decision.state.rss.status, 'failed');
  assert.equal(decision.state.rss.errorCode, 'DOUBAN_SOURCE_TOO_LARGE'); assert.equal(decision.state.rss.received, 0);
});

test('classification uses explicit subject evidence, then persists a checked null instead of guessing from a title', async () => {
  const state = createDoubanSyncState(); state.phase = 'classification'; state.sources.screen.status = 'complete'; state.sources.screen.received = 1;
  state.sources.book.status = 'complete'; state.sources.music.status = 'complete';
  const current = run(state); let calls = 0;
  const result = await advance(current, dependencies({ nextUnclassified: async () => ({ subjectId: '12345' }), countUnclassified: async () => 1,
    classify: async id => { calls++; assert.equal(id, '12345'); return null; } }));
  assert.equal(calls, 1); assert.deepEqual(result.classification, { domain: 'screen', subjectId: '12345', kind: null });
  assert.equal(result.status, 'running');
  await advance(current, dependencies({ countUnclassified: async () => 1 }));
  assert.equal(current.status, 'partial'); assert.equal(presentDoubanRun(current).classification.unclassified, 1);
});

test('a subject verification/login block stops further classification while keeping the already fetched records', async () => {
  const state = createDoubanSyncState(); state.phase = 'classification'; state.sources.screen.received = 2;
  const current = run(state);
  const decision = await advance(current, dependencies({ nextUnclassified: async () => ({ subjectId: '12345' }), countUnclassified: async () => 2,
    classify: async () => { throw new DoubanSourceError('DOUBAN_SOURCE_LOGIN_REQUIRED', 'PRIVATE-COOKIE'); } }));
  assert.equal(decision.items.length, 0); assert.equal(current.status, 'partial');
  assert.equal(presentDoubanRun(current).classification.blocked, true); assert.doesNotMatch(JSON.stringify(current.state), /PRIVATE-COOKIE/);
});

test('bounded collection segments preserve the continuation offset and resume only limited domains', async () => {
  const state = createDoubanSyncState(); state.sources.screen.start = 30000; state.sources.screen.pages = 1000; state.sources.screen.segmentPages = 1000;
  state.sources.book.status = 'complete'; state.sources.music.status = 'complete';
  const current = run(state); let reads = 0;
  await advance(current, dependencies({ collection: async () => { reads++; return { items: [], nextStart: null, total: 0 }; } }));
  assert.equal(reads, 0); assert.equal(parseDoubanSyncState(current.state).sources.screen.status, 'limited');
  const resumed = createDoubanSyncState(current.state);
  assert.equal(resumed.sources.screen.start, 30000); assert.equal(resumed.sources.screen.segmentPages, 0); assert.equal(resumed.sources.screen.status, 'pending');
  assert.equal(resumed.sources.book.status, 'complete');
});

test('persisted state is bounded and the public run view omits private continuation internals', () => {
  for (const state of [null, [], {}, { ...createDoubanSyncState(), phase: 'PRIVATE-STATE' },
    { ...createDoubanSyncState(), sources: { ...createDoubanSyncState().sources, screen: { start: -1 } } }]) {
    assert.throws(() => parseDoubanSyncState(state), (error: unknown) => error instanceof DoubanSyncError && error.status === 503);
  }
  const current = run(), snapshot = JSON.stringify(current.state), view = presentDoubanRun(current);
  assert.equal(JSON.stringify(current.state), snapshot);
  assert.equal(Object.hasOwn(view.sources.screen, 'start'), false); assert.equal(Object.hasOwn(view.sources.screen, 'lastPageIds'), false);
  assert.equal(view.startedAt, current.createdAt);
});
