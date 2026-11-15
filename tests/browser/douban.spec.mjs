import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { syntheticState, interceptSyntheticAPI } from './synthetic-api.mjs';
import { parseDoubanProfile } from '../../lib/douban.ts';
import { mergeDoubanDetails } from '../../lib/douban-details.ts';
import { doubanMissingFields, parseDoubanLocalRecord } from '../../lib/douban-library.ts';
import { syntheticPhotoPNG } from './photo-fixture.mjs';
import { parseIMDbRating } from '../../lib/imdb-rating.ts';
import { normalizeUserCoverUrl, userCoverDescriptor } from '../../lib/douban-cover-selection.ts';

const PROFILE = 'synthetic-douban-user';
const STAMP = '2026-11-14T08:00:00.000Z';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const KINDS = ['movie', 'series', 'book', 'music', 'screen'];

function syntheticWebPCover() {
  // A valid local lossless WebP plus a legal unknown RIFF chunk exercises
  // 23 kB image responses without downloading a real person's cover.
  const image = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvD8AFAAfQmsIVsP+BiOh/AAA=', 'base64');
  const padding = Buffer.alloc(23000 - image.length);
  padding.write('JUNK'); padding.writeUInt32LE(padding.length - 8, 4);
  const bytes = Buffer.concat([image, padding]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

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
function localRecord(item) {
  return item.local ?? { note: '', tags: [], hidden: false, revision: 0 };
}
function presentRecord(item) {
  const local = localRecord(item), selected = item.cover?.mode === 'url' ? item.cover.url : null;
  return { ...item, local, cover: userCoverDescriptor(selected, local.revision),
    imdb: item.domain === 'screen' && item.imdb?.imdbId === item.details?.imdbId ? item.imdb : null,
    tmdbCoverUrl: item.domain === 'screen' && item.tmdb?.imdbId === item.details?.imdbId ? item.tmdbCoverUrl ?? null : null };
}
function listResult(state, params) {
  const scope = params.get('profile') ?? 'all', kind = params.get('kind') ?? '', query = (params.get('q') ?? '').trim().toLowerCase();
  const hidden = params.get('hidden') ?? 'visible', sort = params.get('sort') ?? 'date-desc', rating = params.get('rating'), year = params.get('year'), tag = params.get('tag');
  const owned = state.doubanItems.filter(item => (scope !== 'current' || item.profileId === state.doubanConnection.profileId)
    && (hidden === 'all' || localRecord(item).hidden === (hidden === 'hidden')));
  const matched = owned.filter(item => {
    const personal = localRecord(item), details = item.details ?? {};
    const searchable = [item.title, item.comment, personal.note, ...personal.tags, ...(details.authors ?? []), ...(details.directors ?? []), ...(details.artists ?? []), ...(details.cast ?? [])];
    return (!query || searchable.some(value => typeof value === 'string' && value.toLowerCase().includes(query)))
      && (!rating || (rating === 'unrated' ? item.rating === null : item.rating === Number(rating)))
      && (!year || item.markedDate?.slice(0, 4) === year) && (!tag || personal.tags.includes(tag))
      && (params.get('missing') !== '1' || doubanMissingFields(item).length > 0);
  });
  const date = item => item.markedDate ?? item.publishedAt?.slice(0, 10) ?? item.observedAt?.slice(0, 10) ?? '';
  const filtered = matched.filter(item => !kind || kind === 'all' || item.kind === kind).sort((a, b) => {
    if (sort.startsWith('rating-')) {
      if (a.rating === null || b.rating === null) return Number(a.rating === null) - Number(b.rating === null);
      const order = (a.rating - b.rating) * (sort === 'rating-asc' ? 1 : -1);
      if (order) return order;
    }
    // Stable ties keep individual fixture identities readable; database tests cover the final SQL tie-breakers.
    return date(a).localeCompare(date(b)) * (sort === 'date-asc' ? 1 : -1);
  });
  const offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 24);
  return { connection: state.doubanConnection, dataEpoch: state.doubanDataEpoch, ...(state.doubanRatingsFeatures ? { features: { ratings: true } } : {}),
    items: filtered.slice(offset, offset + limit).map(presentRecord), total: filtered.length,
    counts: Object.fromEntries(['all', ...KINDS].map(key => [key, key === 'all' ? matched.length : matched.filter(item => item.kind === key).length])),
    years: [...new Set(owned.filter(item => item.markedDate).map(item => Number(item.markedDate.slice(0, 4))))].sort((a, b) => b - a),
    tags: [...new Set(owned.flatMap(item => localRecord(item).tags))].sort(),
    offset, limit, hasMore: offset + limit < filtered.length, lastRun: state.doubanRun };
}
const mutations = info => info.synthetic.requests.filter(request => request.path.startsWith('/api/life/douban') && request.method !== 'GET');
const syncRequests = info => mutations(info).filter(request => request.path === '/api/life/douban/sync');
const resetRequests = info => mutations(info).filter(request => request.path === '/api/life/douban/reset');
function resetSnapshot(state) {
  const counts = Object.fromEntries(['all', ...KINDS].map(kind => [kind, kind === 'all' ? state.doubanItems.length : state.doubanItems.filter(item => item.kind === kind).length]));
  const latestUpdatedAt = state.doubanItems.map(item => item.updatedAt).sort().at(-1) ?? null;
  return { epoch: state.doubanDataEpoch, total: state.doubanItems.length, counts, latestUpdatedAt,
    previewHash: createHash('sha256').update(JSON.stringify({ epoch: state.doubanDataEpoch, items: state.doubanItems })).digest('hex') };
}
function importPlan(state, profileId, items) {
  return items.map(input => {
    const index = state.doubanItems.findIndex(item => item.profileId === profileId && item.domain === input.domain && item.subjectId === input.subjectId);
    const old = state.doubanItems[index], next = { ...old, ...input, profileId };
    if (old) {
      if (input.kind === 'screen' && ['movie', 'series'].includes(old.kind)) next.kind = old.kind;
      for (const key of ['coverUrl', 'publishedAt']) if (input[key] == null && old[key] != null) next[key] = old[key];
      for (const key of ['rating', 'markedDate', 'comment']) if (input.source !== 'browser' && input[key] == null && old[key] != null) next[key] = old[key];
    }
    const details = mergeDoubanDetails(old?.details, input.details);
    if (Object.keys(details).length) next.details = details;
    else delete next.details;
    const keys = ['domain', 'subjectId', 'title', 'url', 'kind', 'coverUrl', 'rating', 'markedDate', 'comment', 'publishedAt', 'source', 'details'];
    const changed = Boolean(old && keys.some(key => JSON.stringify(old[key]) !== JSON.stringify(next[key])));
    return { index, old, next, changed };
  });
}
function nextVersion(state, previous = STAMP) {
  return new Date(Math.max(Date.parse(previous) + 1, Date.parse(STAMP) + ++state.doubanMetadataVersion)).toISOString();
}

test.beforeEach(async ({ context, page }, testInfo) => {
  const state = syntheticState();
  state.doubanConnection = { profileId: null, profileUrl: null, revision: 0, updatedAt: null };
  state.doubanItems = []; state.doubanRun = null; state.doubanHoldStep = false; state.doubanStepPending = false;
  state.doubanImportPreview = null; state.doubanImportReceipts = new Map(); state.doubanLoseImportReply = false;
  state.doubanDataEpoch = 0; state.doubanRatingsFeatures = false; state.doubanCompletePublicSync = false; state.doubanPublicSyncItems = null; state.doubanPublicRunStatus = 'completed'; state.doubanPublicSourceError = null;
  state.doubanResetReceipt = null; state.doubanLoseResetReply = false; state.doubanOtherOwnerItems = [];
  state.doubanFailedCovers = new Set(); state.doubanMetadataResults = new Map(); state.doubanMetadataVersion = 0;
  state.doubanLoseMetadataReply = false;
  state.doubanAllowTMDB = false; state.doubanTMDBResults = new Map(); state.doubanLoseTMDBReply = false;
  state.doubanAllowIMDbRatings = false; state.doubanIMDbRatingResults = new Map(); state.doubanIMDbRatingReceipts = new Map();
  state.doubanLoseIMDbRatingReply = false; state.doubanIMDbRatingFailure = null;
  state.doubanCoverBytes = new Map(); state.doubanLoseCoverReply = false; state.doubanCoverHold = false; state.doubanCoverPending = false;
  testInfo.synthetic = state;
  await interceptSyntheticAPI(context, state);
  await page.route('**/api/life/douban**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), body = request.postDataJSON() ?? null;
    state.requests.push({ path: url.pathname, search: url.search, method, body });
    const send = (value, status = 200, responseHeaders = {}) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store', 'X-Account-Owner': state.owner, ...responseHeaders }, body: JSON.stringify(value) });
    const fail = (message, code, status = 409) => send({ error: message, code }, status);
    if (url.pathname === '/api/life/douban' && method === 'GET') return send(listResult(state, url.searchParams));
    if (url.pathname === '/api/life/douban/reset' && method === 'POST') {
      if (body.action === 'preview') return send({ preview: resetSnapshot(state) });
      const payload = JSON.stringify(body), replay = state.doubanResetReceipt;
      if (replay?.receipt.requestId === body.requestId) return replay.payload === payload ? send({ receipt: replay.receipt }) : fail('清空提交内容已变化。', 'DOUBAN_RESET_CONFLICT');
      if (body.expectedEpoch !== state.doubanDataEpoch) return fail('豆瓣资料已在其他页面清空，请重新核对。', 'DOUBAN_DATA_EPOCH_CONFLICT');
      const snapshot = resetSnapshot(state);
      if (body.action !== 'commit' || body.confirmed !== true || !/^[0-9a-f-]{36}$/i.test(body.requestId)
        || body.expectedPreviewHash !== snapshot.previewHash) return fail('清空范围已变化，请重新查看范围后确认。', 'DOUBAN_RESET_CONFLICT');
      const receipt = { requestId: body.requestId, epoch: ++state.doubanDataEpoch, deleted: snapshot.total, counts: snapshot.counts, clearedAt: STAMP };
      state.doubanItems = []; state.doubanRun = null; state.doubanImportPreview = null; state.doubanImportReceipts.clear();
      state.doubanConnection = { ...state.doubanConnection, revision: state.doubanConnection.revision + 1, updatedAt: STAMP };
      state.doubanResetReceipt = { payload, receipt };
      if (state.doubanLoseResetReply) { state.doubanLoseResetReply = false; return route.abort('connectionreset'); }
      return send({ receipt });
    }
    if (url.pathname === '/api/life/douban/cover-selection' && method === 'PUT') {
      if (state.doubanCoverHold) {
        state.doubanCoverHold = false; state.doubanCoverPending = true;
        await new Promise(resolve => { state.doubanReleaseCover = resolve; });
        state.doubanCoverPending = false;
      }
      if (body.expectedDataEpoch !== state.doubanDataEpoch) return fail('收藏已重置，请重新读取后填写封面。', 'DOUBAN_DATA_EPOCH_CONFLICT');
      const item = state.doubanItems.find(item => item.profileId === body.profileId && item.domain === body.domain && item.subjectId === body.subjectId);
      if (!item) return fail('条目不存在。', 'DOUBAN_ITEM_NOT_FOUND', 404);
      let selected;
      try { selected = body.mode === 'url' ? normalizeUserCoverUrl(body.url) : body.mode === 'original' ? null : (() => { throw new Error(); })(); }
      catch { return fail('请填写公开HTTPS图片链接。', 'INVALID_USER_COVER', 400); }
      const current = item.cover?.mode === 'url' ? item.cover.url : null;
      if (selected !== current) {
        if (body.expectedLocalRevision !== localRecord(item).revision) return fail('这部作品的个人整理已变化，请重新打开详情核对。', 'DOUBAN_RECORD_CONFLICT');
        item.local = { ...localRecord(item), revision: localRecord(item).revision + 1 };
        item.cover = userCoverDescriptor(selected, item.local.revision);
      }
      if (state.doubanLoseCoverReply) { state.doubanLoseCoverReply = false; return route.abort('connectionreset'); }
      return send({ item: presentRecord(item), dataEpoch: state.doubanDataEpoch });
    }
    if (url.pathname === '/api/life/douban/library' && ['PUT', 'POST'].includes(method)) {
      if (body.expectedDataEpoch !== state.doubanDataEpoch) return fail('收藏已重置，请重新读取。', 'DOUBAN_DATA_EPOCH_CONFLICT');
      const find = entry => state.doubanItems.find(item => item.profileId === entry.profileId && item.domain === entry.domain && item.subjectId === entry.subjectId);
      if (method === 'PUT') {
        const item = find(body);
        if (!item) return fail('条目不存在。', 'DOUBAN_ITEM_NOT_FOUND', 404);
        if (body.expectedLocalRevision !== localRecord(item).revision) return fail('我的整理已在其他页面更新。', 'DOUBAN_LOCAL_CONFLICT');
        let personal;
        try { personal = parseDoubanLocalRecord(body); } catch { return fail('备注或标签格式不正确。', 'INVALID_DOUBAN_INPUT', 400); }
        item.local = { ...personal, revision: localRecord(item).revision + 1 };
        return send({ item: presentRecord(item), dataEpoch: state.doubanDataEpoch });
      }
      if (body.action !== 'classify' || !['movie', 'series'].includes(body.kind) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 24) return fail('请选择影视分类。', 'INVALID_DOUBAN_INPUT', 400);
      const items = body.items.map(find), keys = body.items.map(item => JSON.stringify([item.profileId, item.domain, item.subjectId]));
      if (new Set(keys).size !== keys.length || items.some((item, index) => !item || item.domain !== 'screen' || body.items[index].expectedUpdatedAt !== item.updatedAt)) return fail('部分作品已更新，本次分类未覆盖。', 'DOUBAN_RECORD_CONFLICT');
      for (const item of items) { item.kind = body.kind; item.metadataCheckedRunId = 'manual-kind'; item.updatedAt = nextVersion(state, item.updatedAt); }
      return send({ items: items.map(presentRecord), dataEpoch: state.doubanDataEpoch });
    }
    if ((url.pathname === '/api/life/douban/metadata' && ['POST', 'PUT'].includes(method)) || (url.pathname === '/api/life/douban/classification' && method === 'PUT')) {
      if (url.pathname.endsWith('/metadata') && (body.expectedDataEpoch ?? 0) !== state.doubanDataEpoch) return fail('书影音资料已清空或重置，旧作品补全已停止。', 'DOUBAN_DATA_EPOCH_CONFLICT');
      const item = state.doubanItems.find(value => value.profileId === body.profileId && value.domain === body.domain && value.subjectId === body.subjectId);
      if (!item) return fail('条目不存在。', 'DOUBAN_ITEM_NOT_FOUND', 404);
      if (body.expectedUpdatedAt !== item.updatedAt) {
        const metadata = body.metadata;
        const alreadySaved = url.pathname.endsWith('/metadata') && method === 'PUT' && body.confirmed === true && metadata
          && (!metadata.kind || metadata.kind === item.kind) && (!metadata.coverUrl || metadata.coverUrl === item.coverUrl)
          && JSON.stringify(mergeDoubanDetails(item.details, metadata.details)) === JSON.stringify(item.details ?? {});
        if (alreadySaved) return send({ item: presentRecord(item), changed: false, dataEpoch: state.doubanDataEpoch, metadata: { status: 'complete' } });
        return fail('条目已更新，请重新核对。', 'DOUBAN_RECORD_CONFLICT');
      }
      if (url.pathname.endsWith('/classification')) {
        if (body.domain !== 'screen' || !['movie', 'series'].includes(body.kind)) return fail('请选择电影或电视剧。', 'DOUBAN_INVALID_CLASSIFICATION', 400);
        item.kind = body.kind;
        item.updatedAt = nextVersion(state, item.updatedAt);
        return send({ item: presentRecord(item) });
      }
      if (body.confirmed !== true) return fail('请明确确认补全此条目。', 'DOUBAN_METADATA_CONFIRMATION_REQUIRED', 400);
      const metadata = method === 'PUT' ? body.metadata : state.doubanMetadataResults.get(item.subjectId);
      if (!metadata || metadata.unavailable) return send({ item: presentRecord(item), changed: false, metadata: { status: 'unavailable', message: '合成来源暂不可用，原记录仍保留。' } });
      if (metadata.kind) item.kind = metadata.kind;
      if (metadata.coverUrl) item.coverUrl = metadata.coverUrl;
      const details = mergeDoubanDetails(item.details, metadata.details);
      if (Object.keys(details).length) item.details = details;
      item.updatedAt = nextVersion(state, item.updatedAt);
      if (method === 'PUT' && state.doubanLoseMetadataReply) { state.doubanLoseMetadataReply = false; return route.abort('connectionreset'); }
      return send({ item: presentRecord(item), changed: true, dataEpoch: state.doubanDataEpoch, metadata: { status: 'complete' } });
    }
    if (url.pathname === '/api/life/douban/imdb-ratings' && method === 'POST' && state.doubanAllowIMDbRatings) {
      expect(Object.keys(body).sort()).toEqual(['confirmed', 'expectedDataEpoch', 'items', 'requestId']);
      expect(body.confirmed).toBe(true); expect(body.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
      expect(body.items.length).toBeGreaterThan(0); expect(body.items.length).toBeLessThanOrEqual(50);
      if (body.expectedDataEpoch !== state.doubanDataEpoch) return fail('收藏已重置，请重新读取后刷新评分。', 'DOUBAN_DATA_EPOCH_CONFLICT');
      const payload = JSON.stringify(body), replay = state.doubanIMDbRatingReceipts.get(body.requestId);
      if (replay) return replay.payload === payload ? send(replay.result) : fail('原 IMDb 评分批次内容已变化。', 'IMDB_RATINGS_REQUEST_CONFLICT');
      if (state.doubanIMDbRatingFailure) {
        const error = state.doubanIMDbRatingFailure;
        return send({ error: error.message, code: error.status === 429 ? 'IMDB_RATE_LIMITED' : 'IMDB_DATASET_UNAVAILABLE' }, error.status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      }
      const targets = body.items.map(expected => {
        expect(Object.keys(expected).sort()).toEqual(['domain', 'expectedImdbId', 'expectedUpdatedAt', 'profileId', 'subjectId']);
        const item = state.doubanItems.find(item => item.profileId === expected.profileId && item.domain === expected.domain && item.subjectId === expected.subjectId);
        expect(expected.domain).toBe('screen'); expect(item).toBeTruthy();
        expect(expected.expectedUpdatedAt).toBe(item.updatedAt); expect(expected.expectedImdbId).toBe(item.details?.imdbId);
        expect(state.doubanIMDbRatingResults.has(item.subjectId), 'each synthetic IMDb outcome must be explicitly configured').toBe(true);
        return item;
      });
      expect(new Set(targets.map(item => item.profileId + ':' + item.subjectId)).size).toBe(targets.length);
      let updated = 0, missing = 0;
      for (const item of targets) {
        const raw = state.doubanIMDbRatingResults.get(item.subjectId), rating = raw === null ? null : parseIMDbRating(raw);
        if (!rating) { missing++; continue; }
        expect(rating.imdbId).toBe(item.details.imdbId);
        if (JSON.stringify(item.imdb) !== JSON.stringify(rating)) { item.imdb = rating; item.updatedAt = nextVersion(state, item.updatedAt); updated++; }
      }
      const result = { items: targets.map(presentRecord), dataEpoch: state.doubanDataEpoch,
        receipt: { requestId: body.requestId, requested: targets.length, updated, missing, checkedAt: STAMP }, ratings: { status: 'complete', source: 'imdb-datasets' } };
      state.doubanIMDbRatingReceipts.set(body.requestId, { payload, result: structuredClone(result) });
      if (state.doubanLoseIMDbRatingReply) { state.doubanLoseIMDbRatingReply = false; return route.abort('connectionreset'); }
      return send(result);
    }
    if (url.pathname === '/api/life/douban/tmdb' && method === 'POST' && state.doubanAllowTMDB) {
      if (body.expectedDataEpoch !== state.doubanDataEpoch) return fail('收藏已重置，请重新读取后查找封面。', 'DOUBAN_DATA_EPOCH_CONFLICT');
      const item = state.doubanItems.find(item => item.profileId === body.profileId && item.domain === body.domain && item.subjectId === body.subjectId);
      if (!item || body.domain !== 'screen' || body.confirmed !== true) return fail('请明确选择已保存的影视作品。', 'INVALID_DOUBAN_INPUT', 400);
      const result = state.doubanTMDBResults.get(item.subjectId);
      if (!result) return fail('本测试未授权此作品的 TMDB 请求。', 'SYNTHETIC_TMDB_NOT_ALLOWED', 400);
      const saved = result.status === 'matched' && item.tmdb?.imdbId === item.details?.imdbId && JSON.stringify(item.tmdb) === JSON.stringify(result.cover)
        && item.tmdbCoverUrl === 'https://image.tmdb.org/t/p/w500' + result.cover.posterPath;
      if (!saved && body.expectedUpdatedAt !== item.updatedAt) return fail('作品资料已更新，请重新核对。', 'DOUBAN_RECORD_CONFLICT');
      if (result.status === 'matched' && !saved) {
        if (!result.cover || result.cover.imdbId !== item.details?.imdbId) return fail('合成 IMDb 匹配不一致。', 'SYNTHETIC_TMDB_INVALID', 400);
        item.tmdb = structuredClone(result.cover); item.tmdbCoverUrl = 'https://image.tmdb.org/t/p/w500' + result.cover.posterPath; item.updatedAt = nextVersion(state, item.updatedAt);
      }
      if (state.doubanLoseTMDBReply) { state.doubanLoseTMDBReply = false; return route.abort('connectionreset'); }
      const status = result.status === 'rate_limited' ? 429 : result.status === 'unavailable' ? 503 : 200;
      return send({ item: presentRecord(item), changed: result.status === 'matched' && !saved, dataEpoch: state.doubanDataEpoch,
        tmdb: { status: result.status, ...(result.message ? { message: result.message } : {}), ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) },
        ...(status >= 400 ? { error: result.message ?? 'TMDB 暂不可用。', code: status === 429 ? 'TMDB_RATE_LIMITED' : 'TMDB_UNAVAILABLE' } : {}) }, status, result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {});
    }
    if (url.pathname === '/api/life/douban/cover' && method === 'GET') {
      const item = state.doubanItems.find(value => value.profileId === url.searchParams.get('profileId')
        && value.domain === url.searchParams.get('domain') && value.subjectId === url.searchParams.get('subjectId'));
      if (!item?.coverUrl) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'No stored cover' });
      if (state.doubanFailedCovers.has(item.subjectId)) return route.fulfill({ status: 502, contentType: 'text/plain', body: 'Synthetic cover unavailable' });
      const bytes = state.doubanCoverBytes.get(item.subjectId) ?? await readFile(new URL('../../public/brand/favicon-32.png', import.meta.url));
      return route.fulfill({ status: 200, contentType: bytes.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/png', body: bytes });
    }
    if (url.pathname === '/api/life/douban/import' && method === 'POST') {
      const profile = parseDoubanProfile(body.profile), items = body.items;
      if (!Array.isArray(items) || !items.length || items.some(item => !['import', 'browser'].includes(item.source))) return fail('请提交本地解析后的本人资料。', 'SYNTHETIC_IMPORT_INVALID', 400);
      const expectedDataEpoch = body.expectedDataEpoch ?? 0;
      if (expectedDataEpoch !== state.doubanDataEpoch) return fail('豆瓣资料已清空或更新，请重新预览后再保存。', 'DOUBAN_DATA_EPOCH_CONFLICT');
      const snapshotHash = ['a', 'b', 'c', 'd', 'e', 'f'][state.doubanDataEpoch % 6].repeat(64), payload = JSON.stringify({ profileId: profile.profileId, items, dataEpoch: state.doubanDataEpoch });
      const plans = importPlan(state, profile.profileId, items), added = plans.filter(plan => !plan.old).length, updated = plans.filter(plan => plan.changed).length;
      const currentRecords = () => items.map(input => presentRecord(state.doubanItems.find(item => item.profileId === profile.profileId && item.domain === input.domain && item.subjectId === input.subjectId)));
      const result = receipt => ({ receipt, ...(body.returnRecords === true ? { records: currentRecords() } : {}) });
      if (body.action === 'preview') {
        state.doubanImportPreview = { snapshotHash, payload };
        return send({ preview: { ...profile, snapshotHash, dataEpoch: state.doubanDataEpoch, total: items.length, added, updated, unchanged: items.length - added - updated } });
      }
      const replay = state.doubanImportReceipts.get(body.requestId);
      if (replay) return replay.payload === payload ? send(result(replay.receipt)) : fail('原操作内容已变化。', 'DOUBAN_IMPORT_CONFLICT');
      if (body.action !== 'commit' || body.confirmed !== true || !/^[0-9a-f-]{36}$/i.test(body.requestId)
        || body.expectedSnapshotHash !== state.doubanImportPreview?.snapshotHash || payload !== state.doubanImportPreview?.payload) {
        return fail('导入预览已变化，请重新预览。', 'DOUBAN_IMPORT_CONFLICT');
      }
      for (const plan of plans) {
        const persisted = { ...plan.next, observedAt: STAMP, createdAt: plan.old?.createdAt ?? STAMP, updatedAt: plan.changed ? nextVersion(state, plan.old.updatedAt) : plan.old?.updatedAt ?? STAMP };
        if (plan.old) state.doubanItems[plan.index] = persisted;
        else state.doubanItems.push(persisted);
      }
      const receipt = { profileId: profile.profileId, requestId: body.requestId, dataEpoch: state.doubanDataEpoch, total: items.length, added, updated, unchanged: items.length - added - updated };
      state.doubanImportReceipts.set(body.requestId, { payload, receipt });
      if (state.doubanLoseImportReply) { state.doubanLoseImportReply = false; return route.abort('connectionreset'); }
      return send(result(receipt));
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
      if (state.doubanCompletePublicSync) {
        expect(Array.isArray(state.doubanPublicSyncItems)).toBe(true);
        if (!body.runId) state.doubanRun ??= newRun(state.doubanConnection);
        else {
          expect(body.runId).toBe(state.doubanRun.id); expect(body.expectedRunRevision).toBe(state.doubanRun.revision);
          state.doubanItems = structuredClone(state.doubanPublicSyncItems);
          Object.assign(state.doubanRun, { revision: state.doubanRun.revision + 1, status: state.doubanPublicRunStatus, phase: 'done', added: state.doubanItems.length, finishedAt: STAMP,
            sources: Object.fromEntries(['screen', 'book', 'music'].map(domain => [domain, domain === 'book' && state.doubanPublicSourceError ? { ...source('blocked'), errorCode: state.doubanPublicSourceError } : source('complete', state.doubanItems.filter(item => item.domain === domain).length)])),
            rss: { status: 'complete', received: 0, errorCode: null }, classification: { checked: 0, unclassified: 0, blocked: false, errorCode: null }, message: state.doubanPublicRunStatus === 'partial' ? '部分完成：合成图书公开页面暂时无法读取，已保存其余公开记录。' : '合成公开收藏已完整读取。' });
        }
        return send({ connection: state.doubanConnection, run: state.doubanRun, more: state.doubanRun.status === 'running' });
      }
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
  testInfo.synthetic.doubanReleaseStep?.(); testInfo.synthetic.doubanReleaseCover?.();
  expect(testInfo.synthetic.externalRequests, 'Synthetic library records must not contact Douban or another external service').toEqual([]);
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('douban-acceptance.png'), fullPage: true });
});
async function openLibrary(page, url = '/life/douban') {
  await page.goto(url);
  await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
}
async function openTools(page, section) {
  const dialog = page.locator('#douban-tools-dialog');
  if (!await dialog.isVisible()) await page.locator('#douban-tools-open').click();
  await expect(dialog).toBeVisible();
  await page.locator('[data-douban-tools-tab="' + section + '"]').click();
  await expect(page.locator('#douban-tools-panel-' + section)).toBeVisible();
}
async function closeTools(page) {
  if (await page.locator('#douban-tools-dialog').isVisible()) await page.locator('#douban-tools-close').click();
  await expect(page.locator('#douban-tools-dialog')).toBeHidden();
}
async function selectKind(page, kind) {
  const chip = page.locator('#douban-kind-chips [data-douban-kind="' + (kind || 'all') + '"]');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
}
async function expandDetail(page, section) {
  const button = page.locator('[data-douban-expand="' + section + '"]');
  if (await button.isVisible() && await button.getAttribute('aria-expanded') === 'false') await button.click();
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
    if (!options.preserveUserAgent) {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 Synthetic Desktop Chrome/130.0.0.0 Safari/537.36' });
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { mobile: false } });
    }
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111', results = new Map();
    const state = { calls: [], reads: 0, holdStep: options.holdStep ?? null, release: null, pending: false, lostReply: Boolean(options.lostReply),
      subjectPending: false, releaseSubject: null, holdSubject: options.holdSubject ?? null };
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
      if (['CONNECT', 'STATUS'].includes(body.action)) return reply({ ok: true, data: { extensionVersion: options.version ?? '1.0.6', protocolVersion: 1 } });
      if (body.action === 'SUBJECT_CANCEL') return reply({ ok: true, data: { cancelled: true } });
      if (body.action === 'SUBJECT') {
        const key = body.domain + ':' + body.subjectId, metadata = options.subjects?.[key];
        const complete = () => {
          state.subjectPending = false; state.releaseSubject = null;
          reply(metadata?.error ? { ok: false, error: metadata.error } : { ok: true, data: { requestId: body.requestId, domain: body.domain, subjectId: body.subjectId, metadata: metadata ?? { kind: null, coverUrl: null, details: {} } } });
        };
        if (state.holdSubject === key) { state.holdSubject = null; state.subjectPending = true; state.releaseSubject = complete; }
        else complete();
        return;
      }
      if (body.action === 'START') return reply({ ok: true, data: { runId, step: 0, progress: progress(0), done: false } });
      if (body.action === 'CANCEL') return reply({ ok: true, data: { runId, step: state.reads, progress: { ...progress(state.reads), status: 'cancelled' }, done: true } });
      if (body.action !== 'STEP' || body.runId !== runId || !pages[body.step]) return reply({ ok: false, error: { code: 'STEP_CONFLICT', message: '合成扩展进度错误。' } });
      const key = body.step + ':' + body.requestId;
      if (!results.has(key)) {
        state.reads++;
        results.set(key, { ok: true, data: { runId, step: body.step + 1, progress: progress(body.step + 1), done: body.step + 1 === pages.length, items: pages[body.step].map(item => ({ ...item, source: (options.version ?? '1.0.6').split('.').map(Number)[2] >= 5 ? 'browser' : 'import' })) } });
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
  await page.locator('#douban-empty-cta').click();
  await expect(page.locator('#douban-tools-panel-manage')).toBeVisible();
  await openTools(page, 'browser');
  await expect(page.locator('#douban-browser-sync')).toBeDisabled();
  if (testInfo.project.name === 'mobile-390-chromium') await expect(page.locator('#douban-browser-status')).toContainText('手机或当前浏览器暂不支持扩展同步');
  await openTools(page, 'manage');
  await page.locator('#douban-profile').fill('https://www.douban.com/people/' + PROFILE + '/');
  await page.locator('#douban-save').click();
  await expect.poll(() => testInfo.synthetic.doubanConnection.profileId).toBe(PROFILE);
  expect(syncRequests(testInfo)).toEqual([]);
  expect(mutations(testInfo)[0].body).toEqual({ profile: 'https://www.douban.com/people/' + PROFILE + '/', expectedRevision: 0 });
  await openTools(page, 'public');
  await page.locator('#douban-sync').click();
  await expect.poll(() => testInfo.synthetic.doubanRun?.status).toBe('partial');
  await expect(page.locator('#douban-sync-status')).toContainText(/部分|受限|限制/);
  await expect(page.locator('#douban-run-summary')).toContainText(/RSS|近期/);
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(4);
  expect(syncRequests(testInfo)[0].body).toEqual({ expectedConnectionRevision: 1 });
  expect(syncRequests(testInfo).slice(1).every(request => request.body.runId === RUN_ID && Number.isInteger(request.body.expectedRunRevision))).toBe(true);
  expect(JSON.stringify(mutations(testInfo).map(request => request.body))).not.toMatch(/cookie|password|userId|synthetic-owner/);
  await closeTools(page);
  await expect(page.locator('#douban-tools-open')).toBeFocused();
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
    await selectKind(page, kind);
    await expect.poll(() => page.locator('#douban-list [data-douban-open]').count()).toBeGreaterThan(0);
    await expect(page.locator('#douban-list')).toContainText('合成' + ({ movie: '电影', series: '电视剧', book: '图书', music: '音乐', screen: '待分类影视' }[kind]));
  }
  await selectKind(page, 'all');
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
  await openLibrary(page); await openTools(page, 'public'); await page.locator('#douban-sync').click();
  await expect.poll(() => testInfo.synthetic.doubanStepPending).toBe(true);
  await page.locator('#douban-stop').click();
  testInfo.synthetic.doubanReleaseStep();
  await expect(page.locator('#douban-sync')).toBeEnabled();
  expect(testInfo.synthetic.doubanRun.status).toBe('running');
  const beforeReload = syncRequests(testInfo).length;
  await page.reload();
  await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
  expect(syncRequests(testInfo)).toHaveLength(beforeReload);
  await openTools(page, 'public');
  await page.locator('#douban-sync').click();
  await expect.poll(() => testInfo.synthetic.doubanRun.status).toBe('partial');
  expect(testInfo.synthetic.doubanItems).toHaveLength(4);
  await fits(page);
});

test('an account change keeps the old-page profile draft local and blocks sending it as the next account', async ({ page }, testInfo) => {
  bind(testInfo.synthetic); await openLibrary(page);
  await openTools(page, 'manage');
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
  await openTools(page, 'import');
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
    coverUrl: null, rating: 4, markedDate: '2026-11-12', comment: rawItems[0].myComment, publishedAt: null, source: 'import', details: { doubanRating: 9.8 } };
  expect(imports()[0].body.items).toEqual([expectedItem]);
  expect(imports()[0].body.items[0].rating).toBe(4);
  expect(imports()[0].body.items[0].details.doubanRating).toBe(9.8);
  expect(JSON.stringify(imports()[0].body)).not.toMatch(/private-douban-records\.json|myRating|myComment|collectionDate|"score"|unrelatedPrivateData|PRIVATE-DO-NOT-UPLOAD|rawFile|rawText|cookie|password|userId/);
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
  await openTools(page, 'import');
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
  await openTools(page, 'public');
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
  await openTools(page, 'public');
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
  await openTools(page, 'public');
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
  await openTools(page, 'public');
  await page.locator('#douban-sources').screenshot({ path: testInfo.outputPath('douban-source-failure-recovery.png') });
});

test('private media covers distinguish a failed read from a missing image and recover only through explicit same-origin retry', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = KINDS.map((kind, index) => ({ ...record(kind, 500 + index), source: 'import',
    coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p' + (500 + index) + '.jpg' }));
  state.doubanItems[2].coverUrl = null;
  state.doubanFailedCovers.add(state.doubanItems[1].subjectId);
  state.doubanCoverBytes.set(state.doubanItems[1].subjectId, syntheticWebPCover());
  await openLibrary(page);
  const covers = page.locator('#douban-list img[data-douban-cover]');
  await expect(covers).toHaveCount(KINDS.length);
  for (let index = 0; index < KINDS.length; index++) await covers.nth(index).scrollIntoViewIfNeeded();
  await expect(covers.nth(1)).toHaveAttribute('data-douban-cover', 'failed');
  await expect(covers.nth(1)).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(covers.nth(1)).toHaveAttribute('alt', '封面加载失败');
  const failedCard = page.locator('#douban-list .db-card').nth(1);
  await expect(failedCard.locator('[data-douban-cover-status]')).toContainText('封面加载失败');
  await expect(failedCard.locator('[data-douban-cover-retry]')).toBeVisible();
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
  await expect(page.locator('#douban-list .db-card').nth(2).locator('[data-douban-cover-retry]')).toHaveCount(0);
  state.doubanFailedCovers.clear();
  await failedCard.locator('[data-douban-cover-retry]').click();
  await expect(covers.nth(1)).toHaveAttribute('data-douban-cover', 'available');
  await expect(covers.nth(1)).toHaveAttribute('src', /^blob:/);
  await expect(failedCard.locator('[data-douban-cover-retry]')).toHaveCount(0);
  await expect(page.locator('#douban-detail-dialog')).toBeHidden();
  expect(state.requests.filter(request => request.path === '/api/life/douban/cover')).toHaveLength(5);
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
    ({ profileId: PROFILE, domain, subjectId: String(9000600 + index), expectedUpdatedAt: STAMP, expectedDataEpoch: 0, confirmed: true }))));
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
  await expect(page.locator('#douban-bulk')).toHaveCount(0);
  await expect(page.locator('[data-douban-select]')).toHaveCount(0);
  await expect(page.locator('[data-douban-select-all]')).toHaveCount(0);
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
  await installExtensionMock(context, pages, { version: '1.0.3' });
  await openLibrary(page);
  expect(await extensionCalls(page)).toEqual([]);
  expect(mutations(testInfo)).toEqual([]);
  await openTools(page, 'browser');
  await page.locator('#douban-browser-connect').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器扩展可连接');
  expect((await extensionCalls(page)).map(call => call.body.action)).toEqual(['CONNECT']);
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(3);
  expect(state.doubanItems.map(item => item.kind)).toEqual(['screen', 'book', 'music']);
  await expect(page.locator('#douban-browser-status')).toContainText('分类尚未补全');
  await expect(page.locator('#douban-browser-status')).toContainText('1.0.4');
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
  await installExtensionMock(context, [[extensionItem('book', 810)]], { version: '1.0.3', lostReply: true });
  await openLibrary(page);
  await openTools(page, 'browser');
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
  await installExtensionMock(context, [[extensionItem('book', 820)], [extensionItem('music', 821)]], { version: '1.0.3', holdStep: 0 });
  await openLibrary(page);
  await openTools(page, 'import');
  await page.locator('#douban-import-profile').fill('keep-local-file-draft');
  await page.locator('#douban-import-files').setInputFiles({ name: 'keep-local-draft.json', mimeType: 'application/json', buffer: Buffer.from('[{"title":"尚未提交的本人草稿","url":"https://book.douban.com/subject/9999820/","state":"读过"}]') });
  await openTools(page, 'browser');
  await closeTools(page);
  await page.locator('[data-navigation-page="health"]').click();
  await expect(page.locator('#draft-guard-dialog')).toBeVisible();
  await page.locator('#draft-guard-dialog [data-draft-choice="continue"]').click();
  expect(new URL(page.url()).pathname).toBe('/life/douban');
  await openTools(page, 'import');
  await expect(page.locator('#douban-import-profile')).toHaveValue('keep-local-file-draft');
  expect(await page.locator('#douban-import-files').evaluate(input => input.files[0]?.name)).toBe('keep-local-draft.json');
  expect(mutations(testInfo)).toEqual([]);
  await openTools(page, 'browser');
  await page.locator('#douban-browser-sync').click();
  await expect.poll(() => page.evaluate(() => window.__doubanExtensionMock.pending)).toBe(true);
  await closeTools(page);
  await expect(page.locator('#douban-workspace-progress')).toBeVisible();
  expect(await extensionCalls(page, 'CANCEL')).toEqual([]);
  expect(await extensionCalls(page, 'STEP')).toHaveLength(1);
  await page.locator('#douban-workspace-progress').click();
  await expect(page.locator('#douban-tools-panel-browser')).toBeVisible();
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

test('clearing the personal library previews all own sources, waits for confirmation and keeps the binding ready for an explicit fresh sync', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = KINDS.map((kind, index) => ({ ...record(kind, 900 + index, index === 2 ? 'previous-synthetic-profile' : PROFILE), source: ['collection', 'rss', 'import'][index % 3] }));
  state.doubanOtherOwnerItems = [record('book', 999, 'another-synthetic-profile')];
  const otherOwnerBefore = structuredClone(state.doubanOtherOwnerItems);
  state.doubanRun = newRun(state.doubanConnection);
  await openLibrary(page);
  await selectKind(page, 'book');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(1);
  await openTools(page, 'manage');
  await page.locator('#douban-reset-panel > summary').click();
  expect(resetRequests(testInfo)).toEqual([]);
  await expect(page.locator('#douban-reset-confirm')).toBeHidden();
  await page.locator('#douban-reset-preview').click();
  await expect(page.locator('#douban-reset-result')).toBeVisible();
  await expect(page.locator('#douban-reset-counts')).toContainText('当前账户的 5 条记录');
  for (const label of ['电影', '电视剧', '书籍', '音乐', '待分类影视']) await expect(page.locator('#douban-reset-counts')).toContainText(label + ' 1 条');
  expect(resetRequests(testInfo).map(request => request.body)).toEqual([{ action: 'preview' }]);
  expect(state.doubanItems).toHaveLength(5);
  expect(state.doubanDataEpoch).toBe(0);
  expect(syncRequests(testInfo)).toEqual([]);
  await page.locator('#douban-reset-confirm').click();
  await expect.poll(() => state.doubanDataEpoch).toBe(1);
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(0);
  await expect(page.locator('#douban-reset-status')).toContainText('删除 5 条记录，绑定主页保留');
  expect(state.doubanItems).toEqual([]);
  expect(state.doubanOtherOwnerItems).toEqual(otherOwnerBefore);
  expect(state.doubanRun).toBeNull();
  expect(state.doubanConnection.profileId).toBe(PROFILE);
  expect(state.doubanConnection.revision).toBe(2);
  await expect(page.locator('#douban-profile-link')).toHaveAttribute('href', 'https://www.douban.com/people/' + PROFILE + '/');
  const command = resetRequests(testInfo).find(request => request.body.action === 'commit').body;
  expect(Object.keys(command).sort()).toEqual(['action', 'expectedEpoch', 'expectedPreviewHash', 'requestId', 'confirmed'].sort());
  expect(command).toMatchObject({ action: 'commit', expectedEpoch: 0, confirmed: true });
  expect(command.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(syncRequests(testInfo)).toEqual([]);
  await openTools(page, 'public');
  await page.locator('#douban-sync').click();
  await expect.poll(() => state.doubanRun?.status).toBe('partial');
  expect(state.doubanItems).toHaveLength(4);
  expect(state.doubanDataEpoch).toBe(1);
  expect(syncRequests(testInfo)[0].body).toEqual({ expectedConnectionRevision: 2 });
  await fits(page);
  await openTools(page, 'manage');
  await page.locator('#douban-reset-panel').screenshot({ path: testInfo.outputPath('douban-reset-confirmed.png') });
});

test('an old import cannot resurrect cleared data and retrying an unknown clear receipt preserves records synced afterward', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [record('movie', 930)];
  await openLibrary(page);
  await openTools(page, 'import');
  await page.locator('#douban-import-files').setInputFiles({ name: 'stale-before-clear.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([{ title: '清空前的本人导入草稿', url: 'https://book.douban.com/subject/9999930/', state: '读过' }])) });
  await page.locator('#douban-import-completed').check();
  await page.locator('#douban-import-preview').click();
  await expect(page.locator('#douban-import-confirm')).toBeEnabled();
  // Another page cleared this same account after the local import preview.
  state.doubanDataEpoch = 1; state.doubanItems = [record('music', 931)];
  state.doubanConnection = { ...state.doubanConnection, revision: 2 };
  await page.locator('#douban-import-confirm').click();
  await expect(page.locator('#douban-import-status')).toContainText(/已清空|重新预览/);
  await expect(page.locator('#douban-import-confirm')).toBeDisabled();
  expect(await page.locator('#douban-import-files').evaluate(input => input.files[0]?.name)).toBe('stale-before-clear.json');
  const stale = mutations(testInfo).find(request => request.path === '/api/life/douban/import' && request.body.action === 'commit');
  expect(stale.body.expectedDataEpoch).toBe(0);
  expect(state.doubanItems.map(item => item.subjectId)).toEqual(['9000931']);
  await openTools(page, 'manage');
  await page.locator('#douban-reset-panel > summary').click();
  await page.locator('#douban-reset-preview').click();
  await expect(page.locator('#douban-reset-confirm')).toBeEnabled();
  state.doubanLoseResetReply = true;
  await page.locator('#douban-reset-confirm').click();
  await expect(page.locator('#douban-reset-retry')).toBeVisible();
  await expect(page.locator('#douban-sync')).toBeDisabled();
  await expect(page.locator('#douban-import-preview')).toBeDisabled();
  expect(state.doubanDataEpoch).toBe(2);
  expect(state.doubanItems).toEqual([]);
  // A fresh sync in another page completed before this page retried the receipt.
  state.doubanItems = [{ ...record('book', 932), source: 'import' }];
  await page.locator('#douban-reset-retry').click();
  await expect(page.locator('#douban-list')).toContainText('合成图书932');
  await expect(page.locator('#douban-reset-status')).toContainText('原清空提交已核对');
  const commits = resetRequests(testInfo).filter(request => request.body.action === 'commit');
  expect(commits).toHaveLength(2);
  expect(commits[1].body).toEqual(commits[0].body);
  expect(commits[0].body.expectedEpoch).toBe(1);
  expect(state.doubanItems.map(item => item.subjectId)).toEqual(['9000932']);
  expect(state.doubanDataEpoch).toBe(2);
  expect(state.doubanConnection.profileId).toBe(PROFILE);
  expect(syncRequests(testInfo)).toEqual([]);
  await fits(page);
});

test('explicit local work enrichment displays movie, book and music facts separately from personal ratings and preserves existing fields', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [
    { ...record('movie', 1000), details: { year: 2020, summary: '应保留的原作品简介', genres: ['剧情'] } },
    { ...record('book', 1001), details: { publisher: '应保留的原出版社' } },
    record('music', 1002),
  ];
  await installExtensionMock(context, [], { subjects: {
    'screen:9001000': { kind: 'movie', coverUrl: null, details: { directors: ['合成导演'], cast: Array.from({ length: 12 }, (_, index) => '合成演员' + (index + 1)), doubanRating: 8.6, ratingCount: 12000, summary: null, genres: [] } },
    'book:9001001': { kind: 'book', coverUrl: null, details: { year: 2024, authors: ['合成作者'], publisher: null, publicationDate: '2024-03', pages: 320, isbn: '9787020002207' } },
    'music:9001002': { kind: 'music', coverUrl: null, details: { artists: ['合成歌手'], albumType: '专辑', tracks: ['第一首合成曲目', '第二首合成曲目'], doubanRating: 9.1 } },
  } });
  await openLibrary(page);
  await page.locator('#douban-list [data-douban-open="0"]').click();
  await expect(page.locator('[data-douban-details="summary"]')).toContainText('应保留的原作品简介');
  await expect(page.locator('[data-douban-details="personal"]')).toContainText('4 / 5');
  expect(await extensionCalls(page)).toEqual([]);
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('#douban-detail-close').click();
  await page.locator('#douban-metadata').click();
  await expect(page.locator('#douban-metadata-status')).toContainText('本次补全完成');
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(3);
  const writes = mutations(testInfo);
  expect(writes).toHaveLength(3);
  expect(writes.every(request => request.path === '/api/life/douban/metadata' && request.method === 'PUT' && request.body.expectedDataEpoch === 0 && request.body.confirmed === true)).toBe(true);
  for (const call of await extensionCalls(page, 'SUBJECT')) expect(Object.keys(call.body).sort()).toEqual(['type', 'version', 'action', 'ownerKey', 'profileId', 'requestId', 'domain', 'subjectId'].sort());
  expect(JSON.stringify(writes)).not.toMatch(/"rating":|"comment":|合成个人短评|cookie|password|rawHTML/i);
  expect(state.doubanItems.every(item => item.rating === 4 && item.comment === '合成个人短评')).toBe(true);
  expect(state.doubanItems[0].details.summary).toBe('应保留的原作品简介');
  expect(state.doubanItems[0].details.genres).toEqual(['剧情']);
  expect(state.doubanItems[1].details.publisher).toBe('应保留的原出版社');
  await page.locator('#douban-list [data-douban-open="0"]').click();
  await expect(page.locator('[data-douban-details="work"]')).toContainText('8.6');
  await expect(page.locator('[data-douban-details="screen"]')).toContainText('合成导演');
  await expect(page.locator('[data-douban-details="personal"]')).toContainText('4 / 5');
  await expect(page.locator('[data-douban-details="summary"]')).toContainText('应保留的原作品简介');
  await expandDetail(page, 'cast');
  await expect(page.locator('[data-douban-details="screen"]')).toContainText('合成演员12');
  await page.locator('#douban-detail-dialog').screenshot({ path: testInfo.outputPath('douban-work-details-dialog.png') });
  await page.locator('#douban-detail-close').click();
  await page.locator('#douban-list [data-douban-open="1"]').click();
  await expect(page.locator('[data-douban-details="book"]')).toContainText('合成作者');
  await expect(page.locator('[data-douban-details="book"]')).toContainText('320 页');
  await expect(page.locator('[data-douban-details="book"]')).toContainText('应保留的原出版社');
  await page.locator('#douban-detail-close').click();
  await page.locator('#douban-list [data-douban-open="2"]').click();
  await expect(page.locator('[data-douban-details="music"]')).toContainText('合成歌手');
  await expect(page.locator('[data-douban-details="tracks"] li')).toHaveCount(2);
  await page.locator('#douban-detail-body').screenshot({ path: testInfo.outputPath('douban-work-details.png') });
  await fits(page);
});

test('a local subject challenge stops the batch without server fallback or erasing known work details', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [{ ...record('movie', 1010), details: { summary: '挑战前已保存的作品简介', directors: ['原导演'] } }, record('book', 1011)];
  await installExtensionMock(context, [], { subjects: { 'screen:9001010': { error: { code: 'DOUBAN_BROWSER_CHALLENGE', message: '豆瓣要求安全验证。' } } } });
  await openLibrary(page);
  await page.locator('#douban-metadata').click();
  await expect(page.locator('#douban-metadata-status')).toContainText('补全已停止');
  await expect(page.locator('#douban-metadata-status')).toContainText('安全验证');
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(1);
  expect(mutations(testInfo)).toEqual([]);
  expect(state.doubanItems).toHaveLength(2);
  expect(state.doubanItems[0].details).toEqual({ summary: '挑战前已保存的作品简介', directors: ['原导演'] });
  await fits(page);
});

for (const change of ['account', 'epoch']) test('a pending local subject result cannot write after a ' + change + ' change', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [record('book', 1020)];
  await installExtensionMock(context, [], { holdSubject: 'book:9001020', subjects: { 'book:9001020': { kind: 'book', coverUrl: null, details: { authors: ['不得写回的旧作者'] } } } });
  await openLibrary(page);
  await page.locator('#douban-metadata').click();
  await expect.poll(() => page.evaluate(() => window.__doubanExtensionMock.subjectPending)).toBe(true);
  if (change === 'account') {
    state.owner = 'another-synthetic-account';
    await page.evaluate(() => window.JiashuAccountSession.verify().catch(() => {}));
    await expect(page.locator('html')).toHaveAttribute('data-account-changed', '');
    await expect.poll(() => extensionCalls(page, 'SUBJECT_CANCEL').then(calls => calls.length)).toBe(1);
  } else {
    state.doubanDataEpoch = 1; state.doubanItems = [];
    state.doubanConnection = { ...state.doubanConnection, revision: 2 };
  }
  await page.evaluate(() => window.__doubanExtensionMock.releaseSubject());
  await expect(page.locator('#douban-metadata-stop')).toBeHidden();
  if (change === 'account') {
    expect(mutations(testInfo)).toEqual([]);
    expect(state.doubanItems[0]).not.toHaveProperty('details');
    await expect(page.locator('#douban-metadata')).toBeDisabled();
  } else {
    await expect(page.locator('#douban-metadata-status')).toContainText('已清空或重置');
    const writes = mutations(testInfo);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: '/api/life/douban/metadata', method: 'PUT', body: { expectedDataEpoch: 0 } });
    expect(state.doubanItems).toEqual([]);
    await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(0);
  }
  expect(syncRequests(testInfo)).toEqual([]);
  await fits(page);
});

test('the six main destinations lead with the library and opening tools stays read-only at wide and narrow sizes', async ({ context, page }, testInfo) => {
  bind(testInfo.synthetic);
  testInfo.synthetic.doubanItems = Array.from({ length: 12 }, (_, index) => ({ ...record(KINDS[index % KINDS.length], 1100 + index),
    coverUrl: 'https://img1.doubanio.com/view/subject/s/public/s' + (1100 + index) + '.jpg', details: { year: 2023 + index % 3, doubanRating: 7.2 + index % 3 } }));
  for (const [index, item] of testInfo.synthetic.doubanItems.entries()) testInfo.synthetic.doubanCoverBytes.set(item.subjectId,
    syntheticPhotoPNG(180, 240, [[95, 129, 140], [169, 105, 87], [112, 128, 91], [154, 126, 82], [121, 113, 146]][index % 5].map(value => value + Math.floor(index / 5) * 12)));
  await installExtensionMock(context, [], { preserveUserAgent: true });
  await openLibrary(page);
  const navigation = page.getByRole('navigation', { name: '主要页面', exact: true });
  await expect(navigation.locator('[data-navigation-page]')).toHaveCount(6);
  expect((await navigation.locator('[data-navigation-page]').allTextContents()).map(text => text.trim())).toEqual(['首页', '健康', '饮食', '书影音', '财务', '同步']);
  await expect(navigation.locator('[data-navigation-page="douban"]')).toHaveAttribute('href', '/life/douban');
  await expect(navigation.locator('[data-navigation-page="douban"]')).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('[aria-current]')).toHaveCount(1);
  await expect(page.locator('.sidebar-utilities [data-context-path="/life/douban"]')).toHaveCount(0);
  await expect(page.locator('#douban-list')).toBeVisible();
  await expect(page.locator('#douban-tools-dialog')).toBeHidden();
  await expect(page.locator('#douban-profile')).toBeHidden();
  await expect(page.locator('#douban-import-files')).toBeHidden();
  await expect(page.locator('#douban-sync')).toBeHidden();
  const covers = page.locator('#douban-list img[data-douban-cover]');
  await expect(covers).toHaveCount(12);
  for (let index = 0; index < 12; index++) await covers.nth(index).scrollIntoViewIfNeeded();
  await expect.poll(() => covers.evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  for (const section of ['browser', 'public', 'import', 'manage']) {
    await openTools(page, section);
    expect(mutations(testInfo)).toEqual([]);
    expect(await extensionCalls(page)).toEqual([]);
    if (['browser', 'manage'].includes(section)) await page.locator('#douban-tools-dialog').screenshot({ path: testInfo.outputPath('douban-tools-' + section + '.png') });
    await closeTools(page);
  }
  await openTools(page, 'browser');
  const browserTab = page.locator('[data-douban-tools-tab="browser"]');
  await browserTab.focus(); await browserTab.press('ArrowRight');
  await expect(page.locator('[data-douban-tools-tab="public"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-douban-tools-tab="public"]').press('End');
  await expect(page.locator('[data-douban-tools-tab="manage"]')).toBeFocused();
  await page.locator('[data-douban-tools-tab="manage"]').press('Home');
  await expect(browserTab).toBeFocused();
  await browserTab.press('ArrowLeft');
  await expect(page.locator('[data-douban-tools-tab="manage"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#douban-tools-dialog')).toBeHidden();
  await expect(page.locator('#douban-tools-open')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('douban-library-first.png'), fullPage: true });
  const original = page.viewportSize();
  expect(await navigation.locator('[data-navigation-page]').evaluateAll(links => links.every(link => {
    const box = link.getBoundingClientRect(); return box.width >= 44 && box.height >= 44 && link.scrollWidth <= link.clientWidth + 1;
  })), 'Navigation targets must remain readable and at least 44px at the project viewport').toBe(true);
  await page.setViewportSize({ width: 320, height: original.height });
  const boxes = await navigation.locator('[data-navigation-page]').evaluateAll(links => links.map(link => ({
    width: link.getBoundingClientRect().width, height: link.getBoundingClientRect().height,
    x: link.getBoundingClientRect().x, fits: link.scrollWidth <= link.clientWidth + 1,
  })));
  expect(boxes.every(box => box.width >= 44 && box.height >= 44 && box.fits), 'Every mobile navigation target must remain at least 44px with readable labels').toBe(true);
  expect(boxes.every((box, index) => index === 0 || box.x >= boxes[index - 1].x + boxes[index - 1].width - 1)).toBe(true);
  await expect(page.locator('[data-navigation-group="douban"]')).toBeHidden();
  for (const section of ['browser', 'public', 'import', 'manage']) {
    await openTools(page, section);
    expect(await page.locator('#douban-tools-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
    expect(await page.locator('#douban-tools-panel-' + section).evaluate(panel => panel.scrollWidth <= panel.clientWidth + 1)).toBe(true);
    if (['browser', 'manage'].includes(section)) await page.locator('#douban-tools-dialog').screenshot({ path: testInfo.outputPath('douban-tools-' + section + '-320.png') });
    await closeTools(page);
  }
  await fits(page);
  await page.screenshot({ path: testInfo.outputPath('douban-navigation-320.png'), fullPage: true });
  expect(mutations(testInfo)).toEqual([]);
  expect(await extensionCalls(page)).toEqual([]);
});

test('category chips, restored search and browser history keep the URL and sidebar context aligned before clearing filters', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [...Array.from({ length: 28 }, (_, index) => ({ ...record('book', 1200 + index), title: '目标图书' + index })),
    { ...record('movie', 1250), title: '目标电影' }, { ...record('music', 1251), title: '目标音乐' }];
  await openLibrary(page, '/life/douban?kind=book&q=%E7%9B%AE%E6%A0%87&profile=current&offset=24');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(4);
  await expect(page.locator('#douban-kind-chips [data-douban-kind="book"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-context-kind="book"]')).toHaveAttribute('aria-current', 'page');
  const contextURL = new URL(await page.locator('[data-context-kind="movie"]').getAttribute('href'), page.url());
  expect(Object.fromEntries(contextURL.searchParams)).toEqual({ kind: 'movie', q: '目标', profile: 'current' });
  await selectKind(page, 'movie');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('offset')).toBeNull();
  await expect(page.locator('[data-context-kind="movie"]')).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page.locator('#douban-kind-chips [data-douban-kind="book"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(4);
  expect(new URL(page.url()).searchParams.get('offset')).toBe('24');
  await page.goForward();
  await expect(page.locator('#douban-kind-chips [data-douban-kind="movie"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#douban-query').fill('目标电影');
  await page.locator('#douban-search').click();
  await expect(page.locator('#douban-list')).toContainText('目标电影');
  expect(new URL(page.url()).searchParams.get('q')).toBe('目标电影');
  await page.locator('#douban-reset-filters').click();
  await expect(page.locator('#douban-query')).toHaveValue('');
  await expect(page.locator('#douban-kind-chips [data-douban-kind="all"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-context-kind="all"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(24);
  const params = new URL(page.url()).searchParams;
  expect(params.has('q') || params.has('kind') || params.has('offset')).toBe(false);
  expect(params.get('profile') ?? 'all').toBe('all');
  expect(mutations(testInfo)).toEqual([]);
  await fits(page);
});

test('long work summaries, casts and track lists expand accessibly and Escape returns focus without a request', async ({ page }, testInfo) => {
  bind(testInfo.synthetic);
  testInfo.synthetic.doubanItems = [
    { ...record('movie', 1300), details: { year: 2025, doubanRating: 8.8,
      summary: Array.from({ length: 22 }, (_, index) => '第' + (index + 1) + '段合成作品简介：这是用于阅读长文的公开内容，不包含个人资料。').join('\n\n'),
      cast: Array.from({ length: 24 }, (_, index) => '长名单合成演员' + (index + 1)) } },
    { ...record('music', 1301), details: { artists: ['合成歌手'], tracks: Array.from({ length: 24 }, (_, index) => '长列表合成曲目' + (index + 1)) } },
  ];
  await openLibrary(page);
  const opener = page.locator('#douban-list [data-douban-open="0"]');
  await opener.focus(); await opener.press('Enter');
  await expect(page.locator('#douban-detail-dialog')).toBeVisible();
  const summary = page.locator('#douban-work-summary'), summaryToggle = page.locator('[data-douban-expand="summary"]');
  await expect(summaryToggle).toHaveAttribute('aria-expanded', 'false');
  const collapsedHeight = (await summary.boundingBox()).height;
  await summaryToggle.focus(); await summaryToggle.press('Enter');
  await expect(summaryToggle).toHaveAttribute('aria-expanded', 'true');
  expect((await summary.boundingBox()).height).toBeGreaterThan(collapsedHeight);
  const castToggle = page.locator('[data-douban-expand="cast"]');
  await expect(castToggle).toHaveAttribute('aria-expanded', 'false');
  await castToggle.focus(); await castToggle.press('Enter');
  await expect(page.locator('[data-douban-long="cast"]')).toHaveAttribute('data-expanded', 'true');
  await expect(page.locator('[data-douban-long="cast"]')).toContainText('长名单合成演员24');
  expect(await page.locator('#douban-detail-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  await page.locator('#douban-detail-dialog').screenshot({ path: testInfo.outputPath('douban-long-details-expanded.png') });
  if (testInfo.project.name === 'mobile-390-chromium') {
    const original = page.viewportSize();
    await page.setViewportSize({ width: 320, height: original.height });
    expect(await page.locator('#douban-detail-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
    await page.locator('#douban-detail-dialog').screenshot({ path: testInfo.outputPath('douban-long-details-320.png') });
    await page.setViewportSize(original);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#douban-detail-dialog')).toBeHidden();
  await expect(opener).toBeFocused();
  const music = page.locator('#douban-list [data-douban-open="1"]');
  await music.focus(); await music.press('Enter');
  const tracksToggle = page.locator('[data-douban-expand="tracks"]');
  await expect(tracksToggle).toHaveAttribute('aria-expanded', 'false');
  await tracksToggle.focus(); await tracksToggle.press('Enter');
  await expect(page.locator('[data-douban-long="tracks"]')).toHaveAttribute('data-expanded', 'true');
  await expect(page.locator('[data-douban-details="tracks"]')).toContainText('长列表合成曲目24');
  await page.keyboard.press('Escape');
  await expect(music).toBeFocused();
  expect(mutations(testInfo)).toEqual([]);
  await fits(page);
});


test('explicit browser resync saves every collection page before classifying existing records and refreshing covers', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  const inputs = [extensionItem('screen', 1200), extensionItem('screen', 1201)];
  state.doubanItems = inputs.map((input, index) => ({ ...record('screen', 1200 + index), ...input,
    coverUrl: index ? null : 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p-old.jpg', details: { summary: '已有简介必须保留' } }));
  const subjects = Object.fromEntries(inputs.map((item, index) => ['screen:' + item.subjectId, { kind: index ? 'series' : 'movie',
    coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p-new-' + index + '.jpg',
    details: { directors: ['合成导演'], ...(index ? { episodes: 12 } : { duration: '118分钟' }) } }]));
  await installExtensionMock(context, [inputs, []], { version: '1.0.5', subjects });
  await openLibrary(page);
  expect(await extensionCalls(page)).toEqual([]);
  expect(mutations(testInfo)).toEqual([]);
  await openTools(page, 'browser');
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  await expect(page.locator('#douban-browser-status')).toContainText('识别影视 2 条');
  expect(state.doubanItems.map(item => item.kind)).toEqual(['movie', 'series']);
  expect(state.doubanItems).toHaveLength(2);
  for (const item of state.doubanItems) {
    expect(item.coverUrl).toContain('p-new-');
    expect(item.details.summary).toBe('已有简介必须保留');
    expect(item.rating).toBe(4);
    expect(item.comment).toBe('合成个人短评');
  }
  const calls = await extensionCalls(page), reads = calls.filter(call => ['STEP', 'SUBJECT'].includes(call.body.action));
  expect(reads.map(call => call.body.action)).toEqual(['STEP', 'STEP', 'SUBJECT', 'SUBJECT']);
  const runId = reads[0].body.runId;
  expect(reads.filter(call => call.body.action === 'SUBJECT').every(call => call.body.runId === runId)).toBe(true);
  const writes = mutations(testInfo), commits = writes.filter(request => request.body.action === 'commit'), puts = writes.filter(request => request.method === 'PUT');
  expect(commits).toHaveLength(1);
  expect(commits[0].body.returnRecords).toBe(true);
  expect(writes.find(request => request.body.action === 'preview').body.returnRecords).toBeUndefined();
  expect(puts).toHaveLength(2);
  expect(puts.every(request => request.path === '/api/life/douban/metadata' && request.body.expectedDataEpoch === 0)).toBe(true);
  expect(JSON.stringify(reads.filter(call => call.body.action === 'SUBJECT')) + JSON.stringify(puts)).not.toMatch(/合成个人短评|markedDate|rawHTML|cookie|password/i);
  const subjectsBefore = (await extensionCalls(page, 'SUBJECT')).length;
  await page.locator('#douban-browser-sync').click();
  await expect.poll(() => extensionCalls(page, 'START').then(items => items.length)).toBe(2);
  await expect.poll(() => extensionCalls(page, 'SUBJECT').then(calls => calls.length)).toBe(subjectsBefore + inputs.length);
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(subjectsBefore + inputs.length);
  expect(state.doubanItems.map(item => item.kind)).toEqual(['movie', 'series']);
  expect(state.doubanItems).toHaveLength(2);
  await closeTools(page);
  await expect(page.locator('#douban-list img[data-douban-cover="available"]')).toHaveCount(2);
  await fits(page);
});

test('automatic classification retains a paused queue and an unknown metadata save retries the original body without another subject read', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  const items = [extensionItem('screen', 1220), extensionItem('screen', 1221)];
  const subjects = Object.fromEntries(items.map(item => ['screen:' + item.subjectId, { kind: 'movie', coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p-auto.jpg', details: { duration: '120分钟' } }]));
  // This regression targets the metadata receipt protocol used before IMDb/TMDB support.
  await installExtensionMock(context, [items], { version: '1.0.5', subjects, holdSubject: 'screen:' + items[0].subjectId });
  await openLibrary(page);
  await openTools(page, 'browser');
  await page.locator('#douban-browser-sync').click();
  await expect.poll(() => page.evaluate(() => window.__doubanExtensionMock.subjectPending)).toBe(true);
  await page.locator('#douban-browser-stop').click();
  await page.evaluate(() => window.__doubanExtensionMock.releaseSubject());
  await expect(page.locator('#douban-browser-status')).toContainText('已暂停浏览器同步');
  expect(state.doubanItems.map(item => item.kind)).toEqual(['movie', 'screen']);
  expect(await extensionCalls(page, 'STEP')).toHaveLength(1);
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(1);
  state.doubanLoseMetadataReply = true;
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-sync')).toHaveText('重试并继续浏览器同步');
  await expect(page.locator('#douban-browser-sync')).toBeEnabled();
  expect(state.doubanItems.map(item => item.kind)).toEqual(['movie', 'movie']);
  const metadataWrites = () => mutations(testInfo).filter(request => request.path === '/api/life/douban/metadata');
  expect(metadataWrites()).toHaveLength(2);
  const original = structuredClone(metadataWrites()[1].body), savedVersion = state.doubanItems[1].updatedAt;
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  expect(metadataWrites()).toHaveLength(3);
  expect(metadataWrites()[2].body).toEqual(original);
  expect(mutations(testInfo).filter(request => request.path === '/api/life/douban/tmdb')).toEqual([]);
  expect(state.doubanItems[1].updatedAt).toBe(savedVersion);
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(2);
  expect(await extensionCalls(page, 'STEP')).toHaveLength(1);
  expect(await extensionCalls(page, 'START')).toHaveLength(1);
  expect(state.doubanItems).toHaveLength(2);
  expect(state.externalRequests).toEqual([]);
  await fits(page);
});

test('a real concurrent metadata change stops automatic classification without replacing its saved version', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  const item = extensionItem('screen', 1230);
  await installExtensionMock(context, [[item]], { holdSubject: 'screen:' + item.subjectId,
    subjects: { ['screen:' + item.subjectId]: { kind: 'movie', coverUrl: null, details: { duration: '120分钟' } } } });
  await openLibrary(page);
  await openTools(page, 'browser');
  await page.locator('#douban-browser-sync').click();
  await expect.poll(() => page.evaluate(() => window.__doubanExtensionMock.subjectPending)).toBe(true);
  const persisted = state.doubanItems[0];
  persisted.kind = 'series'; persisted.details = { episodes: 12 }; persisted.updatedAt = nextVersion(state, persisted.updatedAt);
  const concurrentVersion = structuredClone(persisted);
  await page.evaluate(() => window.__doubanExtensionMock.releaseSubject());
  await expect(page.locator('#douban-browser-status')).toContainText('未重复覆盖');
  await expect(page.locator('#douban-browser-sync')).toHaveText('跳过冲突并继续同步');
  expect(state.doubanItems[0]).toEqual(concurrentVersion);
  const puts = mutations(testInfo).filter(request => request.path === '/api/life/douban/metadata');
  expect(puts).toHaveLength(1);
  expect(puts[0].body.expectedUpdatedAt).not.toBe(concurrentVersion.updatedAt);
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(1);
  expect(await extensionCalls(page, 'STEP')).toHaveLength(1);
  expect(await extensionCalls(page, 'START')).toHaveLength(1);
  expect(state.externalRequests).toEqual([]);
  await fits(page);
});

test('clearing an account during queued subject enrichment prevents the late metadata from restoring old records', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  const item = extensionItem('screen', 1240);
  await installExtensionMock(context, [[item]], { holdSubject: 'screen:' + item.subjectId,
    subjects: { ['screen:' + item.subjectId]: { kind: 'series', coverUrl: null, details: { episodes: 8 } } } });
  await openLibrary(page);
  await openTools(page, 'browser');
  await page.locator('#douban-browser-sync').click();
  await expect.poll(() => page.evaluate(() => window.__doubanExtensionMock.subjectPending)).toBe(true);
  state.doubanItems = []; state.doubanDataEpoch = 1;
  state.doubanConnection = { ...state.doubanConnection, revision: 2 };
  await page.evaluate(() => window.__doubanExtensionMock.releaseSubject());
  await expect(page.locator('#douban-browser-status')).toContainText('已清空或重置');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(0);
  expect(state.doubanItems).toEqual([]);
  const puts = mutations(testInfo).filter(request => request.path === '/api/life/douban/metadata');
  expect(puts).toHaveLength(1);
  expect(puts[0].body.expectedDataEpoch).toBe(0);
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(1);
  expect(await extensionCalls(page, 'STEP')).toHaveLength(1);
  expect(await extensionCalls(page, 'CANCEL')).toHaveLength(1);
  expect(state.doubanDataEpoch).toBe(1);
  await fits(page);
});

test('personal rating, marking year, author search and missing details filter the saved library with explicit sorting', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [
    { ...record('book', 1300), title: '低评分合成书', rating: 3, markedDate: '2025-06-10', details: { authors: ['共同合成作者'] } },
    { ...record('book', 1301), title: '五星合成书', rating: 5, markedDate: '2026-03-11', coverUrl: 'https://img1.doubanio.com/view/subject/s/public/s1301.jpg', details: { authors: ['共同合成作者'], summary: '已完整保存的合成简介' } },
    { ...record('movie', 1302), title: '尚未评分合成电影', rating: null, markedDate: null },
  ];
  await openLibrary(page);
  await page.locator('#douban-filters > summary').click();
  await page.locator('#douban-rating').selectOption('5');
  await expect(page.locator('#douban-list h3')).toHaveText(['五星合成书']);
  await page.locator('#douban-year').selectOption('2025');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(0);
  await page.locator('#douban-rating').selectOption('');
  await expect(page.locator('#douban-list h3')).toHaveText(['低评分合成书']);
  await page.locator('#douban-year').selectOption('');
  await page.locator('#douban-sort').selectOption('rating-asc');
  await expect(page.locator('#douban-list h3')).toHaveText(['低评分合成书', '五星合成书', '尚未评分合成电影']);
  await page.locator('#douban-query').fill('共同合成作者');
  await page.locator('#douban-search').click();
  await expect(page.locator('#douban-list h3')).toHaveText(['低评分合成书', '五星合成书']);
  await page.locator('#douban-missing').check();
  await expect(page.locator('#douban-list h3')).toHaveText(['低评分合成书']);
  expect(new URL(page.url()).searchParams.get('missing')).toBe('1');
  await expect(page.locator('#douban-kind-chips [data-douban-kind="book"]')).toContainText('1');
  expect(mutations(testInfo)).toEqual([]);
  await fits(page);
});

test('local notes and tags save separately from Douban fields and a hidden work can be restored', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state); state.doubanItems = [record('book', 1320)];
  await openLibrary(page);
  await page.locator('#douban-list [data-douban-open]').click();
  const note = '我的备注 <img src=x onerror=alert(1)>，同步不应覆盖';
  await page.locator('[data-douban-note]').fill(note);
  await page.locator('[data-douban-tags]').fill('想重读，合成标签');
  await page.locator('[data-douban-hidden]').check();
  await page.locator('[data-douban-personal-save]').click();
  await expect(page.locator('[data-douban-personal-status]')).toContainText('已保存');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(0);
  expect(state.doubanItems[0].local).toEqual({ note, tags: ['想重读', '合成标签'], hidden: true, revision: 1 });
  expect(state.doubanItems[0]).toMatchObject({ rating: 4, comment: '合成个人短评', updatedAt: STAMP });
  await expect(page.locator('#douban-personal-form img')).toHaveCount(0);
  await page.locator('#douban-detail-close').click();
  await page.locator('#douban-filters > summary').click();
  await page.locator('#douban-hidden').selectOption('hidden');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(1);
  await page.locator('#douban-tag').selectOption('想重读');
  await expect(page.locator('#douban-list h3')).toHaveText(['合成图书1320']);
  await page.locator('#douban-list [data-douban-open]').click();
  await expect(page.locator('[data-douban-note]')).toHaveValue(note);
  await expect(page.locator('[data-douban-hidden]')).toBeChecked();
  await page.locator('[data-douban-hidden]').uncheck();
  await page.locator('[data-douban-personal-save]').click();
  await expect(page.locator('[data-douban-personal-status]')).toContainText('已保存');
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(0);
  await page.locator('#douban-detail-close').click();
  await page.locator('#douban-hidden').selectOption('visible');
  await expect(page.locator('#douban-list h3')).toHaveText(['合成图书1320']);
  const writes = mutations(testInfo);
  expect(writes).toHaveLength(2);
  expect(writes.map(request => request.body.expectedLocalRevision)).toEqual([0, 1]);
  expect(writes.every(request => request.path === '/api/life/douban/library' && request.method === 'PUT' && request.body.expectedDataEpoch === 0)).toBe(true);
  expect(state.doubanItems[0].local.hidden).toBe(false);
  expect(syncRequests(testInfo)).toEqual([]);
  await fits(page);
});

test('a public sync can remain busy while saved records are searched, classified for browsing and paginated', async ({ page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state); state.doubanHoldStep = true;
  state.doubanItems = Array.from({ length: 28 }, (_, index) => ({ ...record('book', 1340 + index), title: '同步中仍可浏览的图书' + index }));
  await openLibrary(page); await openTools(page, 'public');
  await page.locator('#douban-sync').click();
  await expect.poll(() => state.doubanStepPending).toBe(true);
  await closeTools(page);
  await expect(page.locator('#douban-workspace-progress')).toBeVisible();
  await page.locator('#douban-query').fill('同步中仍可浏览');
  await page.locator('#douban-search').click();
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(24);
  await selectKind(page, 'book');
  await page.locator('#douban-next').click();
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(4);
  expect(new URL(page.url()).searchParams.get('offset')).toBe('24');
  expect(state.doubanStepPending).toBe(true);
  await page.locator('#douban-workspace-progress').click();
  await expect(page.locator('#douban-stop')).toBeEnabled();
  await page.locator('#douban-stop').click(); state.doubanReleaseStep();
  await expect(page.locator('#douban-stop')).toBeHidden();
  await expect(page.locator('#douban-sync-status')).toContainText('已暂停');
  await closeTools(page); await fits(page);
});

test('single-work enrichment refreshes its open detail and a paused missing-details queue resumes without reading the first work again', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  state.doubanItems = [record('book', 1380), record('book', 1381), record('book', 1382)];
  const metadata = index => ({ kind: 'book', coverUrl: 'https://img1.doubanio.com/view/subject/s/public/s' + index + '.jpg', details: { authors: ['即时刷新的合成作者' + index], summary: '此书已补全的合成简介' } });
  await installExtensionMock(context, [], { subjects: { 'book:9001380': metadata(1380), 'book:9001381': metadata(1381), 'book:9001382': metadata(1382) } });
  await openLibrary(page);
  await page.locator('#douban-list [data-douban-open="0"]').click();
  await page.locator('[data-douban-metadata-item]').click();
  await expect(page.locator('[data-douban-details="book"]')).toContainText('即时刷新的合成作者1380');
  await expect(page.locator('#douban-metadata-status')).toContainText('本次补全完成');
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(1);
  await page.locator('#douban-detail-close').click();
  await page.evaluate(() => { window.__doubanExtensionMock.holdSubject = 'book:9001381'; });
  await page.locator('#douban-metadata').click();
  await expect.poll(() => page.evaluate(() => window.__doubanExtensionMock.subjectPending)).toBe(true);
  await page.locator('#douban-metadata-stop').click();
  await page.evaluate(() => window.__doubanExtensionMock.releaseSubject());
  await expect(page.locator('#douban-metadata-resume')).toHaveText('继续补全（1）');
  await expect(page.locator('#douban-metadata-status')).toContainText('已暂停补全');
  await page.locator('#douban-query').fill('合成图书1382');
  await page.locator('#douban-search').click();
  await expect(page.locator('#douban-list [data-douban-open]')).toHaveCount(1);
  await page.locator('#douban-metadata-resume').click();
  await expect(page.locator('#douban-metadata-status')).toContainText('本次补全完成');
  await expect(page.locator('#douban-metadata-resume')).toBeHidden();
  const subjects = await extensionCalls(page, 'SUBJECT');
  expect(subjects.map(call => call.body.subjectId)).toEqual(['9001380', '9001381', '9001382']);
  expect(state.doubanItems.every(item => doubanMissingFields(item).length === 0)).toBe(true);
  await fits(page);
});

test('a current browser snapshot can clear revoked ratings and comments while retaining local organization', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic;
  bind(state);
  const item = record('book', 1390), local = { note: '应保留的本站备注', tags: ['本站标签'], hidden: false, revision: 2 };
  state.doubanItems = [{ ...item, source: 'import', local }];
  await installExtensionMock(context, [[{ ...extensionItem('book', 1390), rating: null, comment: null }]], { version: '1.0.5' });
  await openLibrary(page); await openTools(page, 'browser');
  await page.locator('#douban-browser-auto-complete').uncheck();
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('基础收藏已同步');
  expect(state.doubanItems).toHaveLength(1);
  expect(state.doubanItems[0]).toMatchObject({ rating: null, comment: null, source: 'browser', local });
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(0);
  expect(mutations(testInfo).filter(request => request.body.action === 'commit')[0].body.items[0].source).toBe('browser');
  await fits(page);
});

const USER_COVER_URL = 'https://images.example.org/my-selected-cover.jpg';
async function mockUserCoverImages(page, { failing = false } = {}) {
  const requests = [], bytes = await readFile(new URL('../../public/brand/favicon-32.png', import.meta.url));
  let fail = failing;
  await page.route('https://images.example.org/**', async route => {
    const request = route.request();
    requests.push({ url: request.url(), type: request.resourceType(), headers: request.headers() });
    if (fail) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'image/png', body: bytes });
  });
  return { requests, succeed() { fail = false; } };
}
async function openCoverEditor(page) {
  const editor = page.locator('[data-douban-cover-editor]');
  if (await editor.getAttribute('open') === null) await editor.locator('summary').click();
  await expect(page.locator('#douban-cover-form')).toBeVisible();
}
test('a custom fallback is explicitly previewed, stays saved when an official cover becomes available and can be removed', async ({ page }, testInfo) => {
  const state = testInfo.synthetic, images = await mockUserCoverImages(page);
  bind(state); state.doubanItems = [record('book', 1400)];
  state.doubanMetadataResults.set('9001400', { kind: 'book', coverUrl: 'https://img1.doubanio.com/view/subject/s/public/s1400.jpg', details: { authors: ['合成作者'], summary: '保留用户封面的作品资料' } });
  await openLibrary(page);
  await page.locator('#douban-list [data-douban-open]').click();
  await openCoverEditor(page);
  await page.locator('[data-douban-cover-mode]').selectOption('url');
  await page.locator('[data-douban-cover-url]').fill(USER_COVER_URL);
  expect(images.requests).toEqual([]);
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('[data-douban-cover-preview]').click();
  await expect(page.locator('[data-douban-cover-save]')).toBeEnabled();
  await expect(page.locator('[data-douban-cover-preview-image]')).toHaveAttribute('src', USER_COVER_URL);
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('[data-douban-cover-save]').click();
  await expect(page.locator('[data-douban-cover-status]')).toContainText('已保存');
  await expect(page.locator('#douban-list .db-cover img')).toHaveAttribute('src', USER_COVER_URL);
  await expect(page.locator('.db-detail-cover img')).toHaveAttribute('src', USER_COVER_URL);
  expect(state.doubanItems[0].cover).toMatchObject({ mode: 'url', url: USER_COVER_URL, revision: 1 });
  expect(state.doubanItems[0].coverUrl).toBeNull();
  expect(images.requests.every(request => request.type === 'image' && !request.headers.referer && !request.headers.authorization)).toBe(true);
  await page.locator('[data-douban-metadata-item]').click();
  await expect(page.locator('[data-douban-details="book"]')).toContainText('合成作者');
  await expect(page.locator('#douban-list .db-cover img')).toHaveAttribute('src', /^\/api\/life\/douban\/cover\?/);
  await expect(page.locator('.db-detail-cover img')).toHaveAttribute('src', /^\/api\/life\/douban\/cover\?/);
  expect(state.doubanItems[0].cover).toMatchObject({ mode: 'url', url: USER_COVER_URL, revision: 1 });
  expect(state.doubanItems[0].coverUrl).toContain('/s1400.jpg');
  await openCoverEditor(page);
  await page.locator('[data-douban-cover-original]').click();
  await expect(page.locator('[data-douban-cover-save]')).toBeEnabled();
  await page.locator('[data-douban-cover-save]').click();
  await expect(page.locator('[data-douban-cover-status]')).toContainText('备用链接已移除');
  await expect(page.locator('#douban-list .db-cover img')).toHaveAttribute('src', /^\/api\/life\/douban\/cover\?/);
  expect(state.doubanItems[0].cover).toMatchObject({ mode: 'original', revision: 2 });
  const saves = mutations(testInfo).filter(request => request.path === '/api/life/douban/cover-selection');
  expect(saves.map(request => request.body.mode)).toEqual(['url', 'original']);
  expect(saves.map(request => request.body.expectedLocalRevision)).toEqual([0, 1]);
  expect(saves[1].body).not.toHaveProperty('url');
  await fits(page);
});

test('a failed user image offers replacement and retries directly as an image without using the authenticated cover proxy', async ({ page }, testInfo) => {
  const state = testInfo.synthetic, images = await mockUserCoverImages(page, { failing: true });
  bind(state); state.doubanItems = [{ ...record('book', 1410), local: { note: '本地备注', tags: [], hidden: false, revision: 2 }, cover: { mode: 'url', url: USER_COVER_URL, revision: 2 } }];
  await openLibrary(page);
  const card = page.locator('#douban-list .db-card'), image = card.locator('.db-cover img');
  await expect(image).toHaveAttribute('data-douban-cover', 'failed');
  await expect(card.locator('[data-douban-cover-change]')).toBeVisible();
  await card.locator('[data-douban-cover-change]').click();
  await expect(page.locator('#douban-detail-dialog')).toBeVisible();
  await expect(page.locator('#douban-cover-form')).toBeVisible();
  await expect(page.locator('[data-douban-cover-url]')).toHaveValue(USER_COVER_URL);
  await page.locator('#douban-detail-close').click();
  images.succeed();
  await card.locator('[data-douban-cover-retry]').click();
  await expect(image).toHaveAttribute('data-douban-cover', 'available');
  await expect.poll(() => image.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(images.requests.length).toBeGreaterThanOrEqual(2);
  expect(images.requests.every(request => request.type === 'image')).toBe(true);
  expect(state.requests.filter(request => request.path === '/api/life/douban/cover')).toEqual([]);
  expect(mutations(testInfo)).toEqual([]);
  await fits(page);
});

test('invalid links stay local and a concurrent personal revision prevents an old cover draft overwriting saved data', async ({ page }, testInfo) => {
  const state = testInfo.synthetic, images = await mockUserCoverImages(page);
  bind(state); state.doubanItems = [record('book', 1420)];
  await openLibrary(page); await page.locator('#douban-list [data-douban-open]').click();
  await openCoverEditor(page);
  await page.locator('[data-douban-cover-mode]').selectOption('url');
  await page.locator('[data-douban-cover-url]').fill('https://127.0.0.1/cover.png');
  await page.locator('[data-douban-cover-preview]').click();
  await expect(page.locator('[data-douban-cover-status]')).toContainText('HTTPS');
  await expect(page.locator('[data-douban-cover-save]')).toBeDisabled();
  expect(images.requests).toEqual([]); expect(mutations(testInfo)).toEqual([]);
  await page.locator('[data-douban-cover-url]').fill(USER_COVER_URL);
  await page.locator('[data-douban-cover-preview]').click();
  await expect(page.locator('[data-douban-cover-save]')).toBeEnabled();
  state.doubanItems[0].local = { note: '其他页面已保存的备注', tags: ['保留'], hidden: false, revision: 1 };
  await page.locator('[data-douban-cover-save]').click();
  await expect(page.locator('[data-douban-cover-status]')).toContainText(/变化|更新|核对/);
  await expect(page.locator('[data-douban-cover-url]')).toHaveValue(USER_COVER_URL);
  expect(state.doubanItems[0].local).toMatchObject({ note: '其他页面已保存的备注', tags: ['保留'], revision: 1 });
  expect(state.doubanItems[0].cover?.mode ?? 'original').toBe('original');
  expect(mutations(testInfo).filter(request => request.path === '/api/life/douban/cover-selection')).toHaveLength(1);
  await fits(page);
});


function imdbScore(imdbId, rating = 7.3, ratingCount = 45678) {
  return { imdbId, rating, ratingCount, source: 'imdb-datasets', checkedAt: STAMP, datasetDate: STAMP.slice(0, 10) };
}
const TMDB_POSTER_URL = 'https://image.tmdb.org/t/p/w500/synthetic-poster.jpg';
function tmdbPoster(imdbId, tmdbId = 24680, posterPath = '/synthetic-poster.jpg') {
  return { imdbId, mediaType: 'movie', tmdbId, posterPath, language: 'zh', matchedAt: STAMP };
}
async function mockTMDBImages(page, failingPaths = []) {
  const requests = [], bytes = await readFile(new URL('../../public/brand/favicon-32.png', import.meta.url));
  await page.route('https://image.tmdb.org/**', async route => {
    const request = route.request();
    requests.push({ url: request.url(), type: request.resourceType(), headers: request.headers() });
    if (failingPaths.some(path => request.url().endsWith(path))) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'image/png', body: bytes });
  });
  return requests;
}
function expectDirectTMDBImages(requests) {
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request => request.type === 'image')).toBe(true);
  expect(requests.every(request => !request.headers.authorization && !request.headers.cookie && !request.headers['x-page-owner'] && !request.headers.referer)).toBe(true);
}

test('saved covers automatically fall through official, TMDB and custom URLs without changing their stored sources', async ({ page }, testInfo) => {
  const state = testInfo.synthetic; bind(state);
  const official = { ...record('movie', 1600), coverUrl: 'https://img1.doubanio.com/view/photo/public/p1600.jpg', details: { imdbId: 'tt0016000' }, tmdb: tmdbPoster('tt0016000'), tmdbCoverUrl: TMDB_POSTER_URL };
  const tmdb = { ...record('movie', 1601), coverUrl: 'https://img1.doubanio.com/view/photo/public/p1601.jpg', details: { imdbId: 'tt0016001' }, tmdb: tmdbPoster('tt0016001'), tmdbCoverUrl: TMDB_POSTER_URL };
  const custom = { ...record('movie', 1602), coverUrl: 'https://img1.doubanio.com/view/photo/public/p1602.jpg', details: { imdbId: 'tt0016002' }, tmdb: tmdbPoster('tt0016002', 24682, '/synthetic-final.jpg'), tmdbCoverUrl: 'https://image.tmdb.org/t/p/w500/synthetic-final.jpg', cover: { mode: 'url', url: USER_COVER_URL, revision: 2 }, local: { note: '', tags: [], hidden: false, revision: 2 } };
  const stale = { ...record('movie', 1603), details: { imdbId: 'tt0016003' }, tmdb: tmdbPoster('tt0016999') };
  state.doubanItems = [official, tmdb, custom, stale]; state.doubanFailedCovers.add(tmdb.subjectId); state.doubanFailedCovers.add(custom.subjectId);
  const imageRequests = await mockTMDBImages(page, ['/synthetic-final.jpg']); await mockUserCoverImages(page);
  await openLibrary(page);
  await expect(page.locator('#douban-list .db-card').nth(0).locator('img')).toHaveAttribute('src', /^\/api\/life\/douban\/cover\?/);
  await expect(page.locator('#douban-list .db-card').nth(1).locator('img')).toHaveAttribute('src', TMDB_POSTER_URL);
  await expect(page.locator('#douban-list .db-card').nth(2).locator('img')).toHaveAttribute('src', USER_COVER_URL);
  await expect(page.locator('#douban-list .db-card').nth(3).locator('img')).toHaveAttribute('data-douban-cover', 'missing');
  await expectSourceRatingsCorner(page);
  const sourcePlacement = await page.locator('#douban-list .db-card').nth(1).locator('.db-cover').evaluate(cover => {
    const box = cover.getBoundingClientRect(), source = cover.querySelector('[data-douban-tmdb-source]').getBoundingClientRect(), ratings = cover.querySelector('[data-douban-source-ratings]').getBoundingClientRect();
    return { left: Math.abs(source.left - (box.left + 8)), top: Math.abs(source.top - (box.top + 8)), separate: source.bottom <= ratings.top };
  });
  expect(sourcePlacement.left <= 2 && sourcePlacement.top <= 2 && sourcePlacement.separate, 'The TMDB source label stays in the upper left and clear of the rating tags').toBe(true);
  await page.locator('#douban-list [data-douban-open="1"]').click();
  await expect(page.locator('#douban-detail-body')).toContainText('tt0016001');
  await expect(page.locator('#douban-detail-body [data-douban-tmdb-source]')).toContainText('TMDB');
  await expect(page.locator('.db-detail-cover img')).toHaveAttribute('src', TMDB_POSTER_URL);
  expect(mutations(testInfo)).toEqual([]); expectDirectTMDBImages(imageRequests);
  expect(state.doubanItems[0].coverUrl).toBe(official.coverUrl);
  expect(state.doubanItems[2].cover).toMatchObject({ mode: 'url', url: USER_COVER_URL, revision: 2 });
  await fits(page);
});

test('extension 1.0.6 preserves IMDb from Douban and saves TMDB after metadata while retaining a custom fallback', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanAllowTMDB = true;
  const inputs = [extensionItem('movie', 1610), extensionItem('movie', 1611)];
  state.doubanItems = inputs.map((input, index) => ({ ...record('movie', 1610 + index), ...input,
    coverUrl: 'https://img1.doubanio.com/view/photo/public/p161' + index + '.jpg',
    ...(index ? { local: { note: '保留本地备注', tags: ['保留'], hidden: false, revision: 3 }, cover: { mode: 'url', url: USER_COVER_URL, revision: 3 } } : {}) }));
  const subjects = Object.fromEntries(inputs.map((item, index) => ['screen:' + item.subjectId,
    { kind: 'movie', coverUrl: null, details: { directors: ['合成导演'], duration: '120分钟', imdbId: 'tt00161' + index + '0' } }]));
  for (const [index, item] of inputs.entries()) state.doubanTMDBResults.set(item.subjectId, { status: 'matched', cover: tmdbPoster('tt00161' + index + '0', 24680 + index) });
  state.doubanFailedCovers.add(inputs[0].subjectId);
  const images = await mockTMDBImages(page); await mockUserCoverImages(page);
  state.doubanAllowIMDbRatings = true;
  for (const item of inputs) state.doubanIMDbRatingResults.set(item.subjectId, imdbScore(subjects['screen:' + item.subjectId].details.imdbId));
  await installExtensionMock(context, [inputs], { version: '1.0.6', subjects });
  await openLibrary(page); expect(mutations(testInfo)).toEqual([]);
  await openTools(page, 'browser'); await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  const writes = mutations(testInfo), metadata = writes.filter(request => request.path.endsWith('/metadata')), tmdb = writes.filter(request => request.path.endsWith('/tmdb'));
  expect(metadata).toHaveLength(2); expect(tmdb).toHaveLength(2);
  for (const [index, item] of state.doubanItems.entries()) {
    expect(item.details.imdbId).toBe('tt00161' + index + '0'); expect(item.tmdb.imdbId).toBe(item.details.imdbId);
    expect(item.coverUrl).toContain('/p161' + index + '.jpg');
    const save = metadata.find(request => request.body.subjectId === item.subjectId), lookup = tmdb.find(request => request.body.subjectId === item.subjectId);
    expect(writes.indexOf(lookup)).toBeGreaterThan(writes.indexOf(save));
    expect(lookup.body).toEqual({ profileId: PROFILE, domain: 'screen', subjectId: item.subjectId, expectedUpdatedAt: lookup.body.expectedUpdatedAt, expectedDataEpoch: 0, confirmed: true });
    expect(Date.parse(lookup.body.expectedUpdatedAt)).toBeGreaterThan(Date.parse(save.body.expectedUpdatedAt));
  }
  expect(state.doubanItems[1].cover).toMatchObject({ mode: 'url', url: USER_COVER_URL, revision: 3 });
  expect(state.doubanItems[1].local).toMatchObject({ note: '保留本地备注', tags: ['保留'], revision: 3 });
  expect(JSON.stringify(tmdb.map(request => request.body))).not.toMatch(/合成个人短评|rating|comment|markedDate|cookie|password|rawHTML/i);
  await closeTools(page);
  await expect(page.locator('#douban-list .db-card').nth(0).locator('img')).toHaveAttribute('src', TMDB_POSTER_URL);
  await expect(page.locator('#douban-list .db-card').nth(1).locator('img')).toHaveAttribute('src', /^\/api\/life\/douban\/cover\?/);
  expectDirectTMDBImages(images); await fits(page);
});

test('missing TMDB configuration stops further poster calls while every Douban detail save continues', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanAllowTMDB = true;
  const inputs = [extensionItem('screen', 1620), extensionItem('screen', 1621)];
  const subjects = Object.fromEntries(inputs.map((item, index) => ['screen:' + item.subjectId,
    { kind: 'movie', coverUrl: null, details: { imdbId: 'tt00162' + index + '0', duration: '120分钟' } }]));
  for (const item of inputs) state.doubanTMDBResults.set(item.subjectId, { status: 'not_configured', message: 'TMDB 尚未配置，豆瓣资料继续保存。' });
  state.doubanAllowIMDbRatings = true;
  for (const item of inputs) state.doubanIMDbRatingResults.set(item.subjectId, imdbScore(subjects['screen:' + item.subjectId].details.imdbId));
  await installExtensionMock(context, [inputs], { version: '1.0.6', subjects });
  await openLibrary(page); await openTools(page, 'browser'); await page.locator('#douban-browser-sync').click();
  // Neither source supplied a cover, so the incomplete detail summary precedes the TMDB configuration explanation.
  await expect(page.locator('#douban-browser-status')).toContainText('收藏记录已同步，自动补全仍有未完成条目');
  await expect(page.locator('#douban-browser-status')).toContainText('未补全 2 条');
  await expect(page.locator('#douban-browser-status')).toContainText('TMDB 已查找 1 条，已补全 0 条');
  await expect(page.locator('#douban-browser-status')).toContainText(/管理员尚未配置 TMDB/);
  expect(mutations(testInfo).filter(request => request.path.endsWith('/metadata'))).toHaveLength(2);
  expect(mutations(testInfo).filter(request => request.path.endsWith('/tmdb'))).toHaveLength(1);
  expect(state.doubanItems.every(item => item.kind === 'movie' && item.details.imdbId && item.coverUrl === null && !item.tmdb)).toBe(true);
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(2); await fits(page);
});

test('an unknown TMDB receipt retries the original poster body without rereading or resaving Douban details', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanAllowTMDB = true; state.doubanLoseTMDBReply = true;
  const input = extensionItem('screen', 1630);
  state.doubanTMDBResults.set(input.subjectId, { status: 'matched', cover: tmdbPoster('tt0016300') });
  state.doubanAllowIMDbRatings = true; state.doubanIMDbRatingResults.set(input.subjectId, imdbScore('tt0016300'));
  await mockTMDBImages(page);
  await installExtensionMock(context, [[input]], { version: '1.0.6', subjects: { ['screen:' + input.subjectId]: { kind: 'movie', coverUrl: null, details: { imdbId: 'tt0016300', duration: '120分钟' } } } });
  await openLibrary(page); await openTools(page, 'browser'); await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-sync')).toHaveText('重试并继续浏览器同步');
  expect(state.doubanItems[0].tmdb.imdbId).toBe('tt0016300');
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  const posters = mutations(testInfo).filter(request => request.path.endsWith('/tmdb'));
  expect(posters).toHaveLength(2); expect(posters[1].body).toEqual(posters[0].body);
  expect(mutations(testInfo).filter(request => request.path.endsWith('/metadata'))).toHaveLength(1);
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(1);
  expect(await extensionCalls(page, 'START')).toHaveLength(1); await fits(page);
});

for (const [status, message] of [
  ['not_configured', 'TMDB 尚未配置，未保存封面。'],
  ['no_match', 'TMDB 未找到匹配的作品，未保存封面。'],
  ['ambiguous', 'TMDB 存在多个匹配，未保存封面。'],
  ['rate_limited', 'TMDB 请求频率受限，请稍后重试，未保存封面。'],
]) test('an explicit TMDB lookup reports ' + status + ' without claiming or saving a poster', async ({ page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanAllowTMDB = true;
  const item = { ...record('movie', 1640), details: { imdbId: 'tt0016400' } }; state.doubanItems = [item];
  state.doubanTMDBResults.set(item.subjectId, { status, message, ...(status === 'rate_limited' ? { retryAfter: 30 } : {}) });
  await openLibrary(page); await page.locator('#douban-list [data-douban-open]').click();
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('[data-douban-tmdb-item]').click();
  if (status === 'rate_limited') {
    await expect(page.locator('[data-douban-tmdb-status]')).toContainText(/限流|频率受限/);
    await expect(page.locator('[data-douban-tmdb-status]')).toContainText('30 秒');
  } else await expect(page.locator('[data-douban-tmdb-status]')).toContainText(message);
  expect(item.tmdb).toBeUndefined(); expect(item.coverUrl).toBeNull();
  expect(mutations(testInfo).map(request => request.path)).toEqual(['/api/life/douban/tmdb']);
  await expect(page.locator('.db-detail-cover img')).toHaveAttribute('data-douban-cover', 'missing'); await fits(page);
});

async function expectSourceRatingsCorner(page) {
  const placement = await page.locator('#douban-list .db-cover').evaluateAll(covers => covers.map(cover => {
    const badges = cover.querySelector('[data-douban-source-ratings]'), box = cover.getBoundingClientRect(), tagBox = badges?.lastElementChild?.getBoundingClientRect();
    return { inCover: badges?.parentElement === cover && Boolean(cover.querySelector('img')) && getComputedStyle(badges).position === 'absolute',
      inside: Boolean(tagBox && tagBox.top >= box.top && tagBox.left >= box.left && tagBox.bottom <= box.bottom && tagBox.right <= box.right),
      bottom: tagBox ? Math.abs(tagBox.bottom - (box.bottom - 8)) : Infinity,
      right: tagBox ? Math.abs(tagBox.right - (box.right - 8)) : Infinity };
  }));
  expect(placement.every(item => item.inCover && item.inside && item.bottom <= 2 && item.right <= 2), 'Source ratings overlay the cover at an 8px bottom-right inset for both short and long titles').toBe(true);
  await expect(page.locator('#douban-list .db-card-copy [data-douban-source-ratings]')).toHaveCount(0);
  await fits(page);
}

test('saved card tags distinguish rating sources while overlaying the cover bottom right for every title length', async ({ page }, testInfo) => {
  const state = testInfo.synthetic; bind(state);
  state.doubanItems = [
    { ...record('movie', 1800), title: '短标题', details: { imdbId: 'tt0018000', doubanRating: 8.6 }, imdb: imdbScore('tt0018000', 7.1) },
    { ...record('movie', 1801), title: '这是一个需要分成多行并且仍应让两个来源评分标签对齐在封面图片右下角的合成长标题', details: { imdbId: 'tt0018001', doubanRating: 6.4 }, imdb: imdbScore('tt0018001', 9.2) },
    { ...record('movie', 1802), details: { imdbId: 'tt0018002' }, imdb: imdbScore('tt0099999', 5.5) },
    { ...record('book', 1803), details: { doubanRating: 8.3 } },
    { ...record('music', 1804), details: { doubanRating: 7.6 } },
  ];
  await openLibrary(page);
  const cards = page.locator('#douban-list .db-card');
  await expect(cards.nth(0).locator('[data-douban-score="douban"]')).toContainText('8.6');
  await expect(cards.nth(0).locator('[data-douban-score="imdb"]')).toContainText('7.1');
  await expect(cards.nth(1).locator('[data-douban-score="douban"]')).toContainText('6.4');
  await expect(cards.nth(1).locator('[data-douban-score="imdb"]')).toContainText('9.2');
  for (const source of ['douban', 'imdb']) await expect(cards.nth(2).locator('[data-douban-score="' + source + '"]')).toContainText('—');
  for (const index of [3, 4]) {
    await expect(cards.nth(index).locator('[data-douban-score="douban"]')).toHaveCount(1);
    await expect(cards.nth(index).locator('[data-douban-score="imdb"]')).toHaveCount(0);
  }
  await expect(cards.nth(0).locator('.db-rating')).toContainText('4 / 5');
  await expect(page.locator('body')).toContainText('Information courtesy of IMDb (https://www.imdb.com). Used with permission.');
  await expectSourceRatingsCorner(page);
  await page.locator('#douban-list [data-douban-open="0"]').click();
  await expect(page.locator('[data-douban-details="personal"]')).toContainText('4 / 5');
  expect(mutations(testInfo)).toEqual([]);
});

test('an explicit refresh rereads complete selected works for Douban scores and batches all screen IMDb ratings once', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanAllowIMDbRatings = true;
  const kinds = ['movie', 'movie', 'book', 'music'], inputs = kinds.map((kind, index) => extensionItem(kind, 1810 + index));
  state.doubanItems = inputs.map((input, index) => ({ ...record(kinds[index], 1810 + index), ...input,
    coverUrl: 'https://img1.doubanio.com/view/photo/public/p181' + index + '.jpg',
    details: { summary: '资料已齐全仍应刷新评分', doubanRating: 5.1, ...(index < 2 ? { imdbId: 'tt00181' + index + '0', directors: ['已知导演'], duration: '120分钟' } : index === 2 ? { authors: ['已知作者'] } : { artists: ['已知歌手'] }) },
    ...(index < 2 ? { tmdb: tmdbPoster('tt00181' + index + '0'), tmdbCoverUrl: TMDB_POSTER_URL } : {}) }));
  const subjects = Object.fromEntries(inputs.map((input, index) => [input.domain + ':' + input.subjectId,
    { kind: kinds[index], coverUrl: null, details: { doubanRating: [8.6, 6.4, 8.3, 7.6][index], ...(index < 2 ? { imdbId: 'tt00181' + index + '0' } : {}) } }]));
  state.doubanIMDbRatingResults.set(inputs[0].subjectId, imdbScore('tt0018100', 7.1));
  state.doubanIMDbRatingResults.set(inputs[1].subjectId, null);
  await installExtensionMock(context, [inputs], { version: '1.0.6', subjects });
  await openLibrary(page); expect(mutations(testInfo)).toEqual([]);
  await openTools(page, 'browser'); await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  await expect(page.locator('#douban-browser-status')).toContainText('IMDb 评分已处理 2 条，更新 1 条，暂无评分 1 条');
  const writes = mutations(testInfo), metadata = writes.filter(request => request.path.endsWith('/metadata')), batches = writes.filter(request => request.path.endsWith('/imdb-ratings'));
  expect(metadata).toHaveLength(4); expect(batches).toHaveLength(1); expect(batches[0].body.items).toHaveLength(2);
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(4);
  expect(writes.filter(request => request.path.endsWith('/tmdb'))).toEqual([]);
  expect(writes.indexOf(batches[0])).toBeGreaterThan(Math.max(...metadata.map(request => writes.indexOf(request))));
  expect(state.doubanItems.map(item => item.details.doubanRating)).toEqual([8.6, 6.4, 8.3, 7.6]);
  expect(state.doubanItems[0].imdb.rating).toBe(7.1); expect(state.doubanItems[1].imdb ?? null).toBeNull();
  expect(state.doubanItems.every(item => item.rating === 4 && item.comment === '合成个人短评')).toBe(true);
  expect(JSON.stringify(batches[0].body)).not.toMatch(/ratingCount|doubanRating|comment|markedDate|cookie|password|rawHTML|token/i);
  await closeTools(page);
  await expect(page.locator('#douban-list .db-card').nth(0).locator('[data-douban-score="douban"]')).toContainText('8.6');
  await expect(page.locator('#douban-list .db-card').nth(0).locator('[data-douban-score="imdb"]')).toContainText('7.1');
  await expect(page.locator('#douban-list .db-card').nth(1).locator('[data-douban-score="imdb"]')).toContainText('—');
  await expectSourceRatingsCorner(page);
});

test('an unknown IMDb batch receipt replays only its immutable batch after the original details and covers are saved', async ({ context, page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanAllowIMDbRatings = true; state.doubanLoseIMDbRatingReply = true;
  const inputs = [extensionItem('movie', 1820), extensionItem('movie', 1821)];
  state.doubanItems = inputs.map((input, index) => ({ ...record('movie', 1820 + index), ...input,
    coverUrl: 'https://img1.doubanio.com/view/photo/public/p182' + index + '.jpg', details: { imdbId: 'tt00182' + index + '0' },
    tmdb: tmdbPoster('tt00182' + index + '0'), tmdbCoverUrl: TMDB_POSTER_URL }));
  const subjects = Object.fromEntries(inputs.map((item, index) => ['screen:' + item.subjectId,
    { kind: 'movie', coverUrl: null, details: { imdbId: 'tt00182' + index + '0', doubanRating: 8.2 } }]));
  for (const [index, item] of inputs.entries()) state.doubanIMDbRatingResults.set(item.subjectId, imdbScore('tt00182' + index + '0'));
  await installExtensionMock(context, [inputs], { version: '1.0.6', subjects });
  await openLibrary(page); await openTools(page, 'browser'); await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('IMDb 评分保存回执尚未确认');
  await expect(page.locator('#douban-browser-sync')).toHaveText('重试并继续浏览器同步');
  const before = structuredClone(mutations(testInfo).filter(request => request.path.endsWith('/imdb-ratings'))[0].body);
  expect(state.doubanItems.every(item => item.imdb?.rating === 7.3)).toBe(true);
  await page.locator('#douban-browser-sync').click();
  await expect(page.locator('#douban-browser-status')).toContainText('浏览器同步完成');
  const writes = mutations(testInfo), batches = writes.filter(request => request.path.endsWith('/imdb-ratings'));
  expect(batches.map(request => request.body)).toEqual([before, before]);
  expect(writes.filter(request => request.path.endsWith('/metadata'))).toHaveLength(2);
  expect(writes.filter(request => request.path.endsWith('/tmdb'))).toHaveLength(0);
  expect(await extensionCalls(page, 'SUBJECT')).toHaveLength(2); expect(await extensionCalls(page, 'STEP')).toHaveLength(1); expect(await extensionCalls(page, 'START')).toHaveLength(1);
  expect(state.doubanIMDbRatingReceipts.size).toBe(1); await fits(page);
});

test('manual IMDb refresh shows an absent score as a dash and keeps an earlier genuine score when the provider is rate limited', async ({ page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanAllowIMDbRatings = true;
  const item = { ...record('movie', 1830), details: { imdbId: 'tt0018300', doubanRating: 8.6 } }; state.doubanItems = [item];
  state.doubanIMDbRatingResults.set(item.subjectId, null);
  await openLibrary(page); await page.locator('#douban-list [data-douban-open]').click();
  expect(mutations(testInfo)).toEqual([]);
  await page.locator('[data-douban-imdb-item]').click();
  await expect(page.locator('[data-douban-imdb-status]')).toContainText('暂无评分');
  await expect(page.locator('#douban-list [data-douban-score="imdb"]')).toContainText('—');
  expect(item.imdb ?? null).toBeNull();
  await page.locator('#douban-detail-close').click();
  item.imdb = imdbScore('tt0018300', 7.9); state.doubanIMDbRatingFailure = { status: 429, message: 'IMDb 官方评分暂时限流。', retryAfter: 25 };
  await page.reload(); await expect(page.locator('#douban-page')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#douban-list [data-douban-open]').click(); await page.locator('[data-douban-imdb-item]').click();
  await expect(page.locator('[data-douban-imdb-status]')).toContainText('限流');
  await expect(page.locator('[data-douban-imdb-status]')).toContainText('25 秒');
  await expect(page.locator('#douban-list [data-douban-score="imdb"]')).toContainText('7.9');
  expect(item.imdb).toEqual(imdbScore('tt0018300', 7.9));
  expect(mutations(testInfo).every(request => request.path === '/api/life/douban/imdb-ratings')).toBe(true); await fits(page);
});


test('a completed public sync refreshes every saved page and sends IMDb batches of fifty without per-work rating calls', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const state = testInfo.synthetic; bind(state); state.doubanRatingsFeatures = true; state.doubanCompletePublicSync = true; state.doubanAllowIMDbRatings = true;
  state.doubanPublicSyncItems = Array.from({ length: 51 }, (_, index) => {
    const imdbId = 'tt' + String(19000 + index).padStart(7, '0');
    const item = { ...record('movie', 1900 + index), coverUrl: 'https://img1.doubanio.com/view/photo/public/p19' + index + '.jpg',
      details: { imdbId, doubanRating: 5.1, directors: ['已知导演'], summary: '原资料已齐全' }, tmdb: tmdbPoster(imdbId), tmdbCoverUrl: TMDB_POSTER_URL };
    state.doubanMetadataResults.set(item.subjectId, { kind: 'movie', coverUrl: null, details: { imdbId, doubanRating: 8.4 } });
    state.doubanIMDbRatingResults.set(item.subjectId, imdbScore(imdbId, 7.8)); return item;
  });
  await openLibrary(page); expect(mutations(testInfo)).toEqual([]);
  await openTools(page, 'public'); await page.locator('#douban-sync').click();
  await expect.poll(() => state.doubanIMDbRatingReceipts.size, { timeout: 110000, intervals: [250] }).toBe(2);
  await expect(page.locator('#douban-metadata-status')).toContainText('本次补全完成');
  const writes = mutations(testInfo), metadata = writes.filter(request => request.path.endsWith('/metadata')), batches = writes.filter(request => request.path.endsWith('/imdb-ratings'));
  expect(metadata).toHaveLength(51); expect(batches.map(request => request.body.items.length)).toEqual([50, 1]);
  expect(new Set(batches.flatMap(request => request.body.items.map(item => item.subjectId))).size).toBe(51);
  expect(writes.indexOf(batches[0])).toBeGreaterThan(Math.max(...metadata.map(request => writes.indexOf(request))));
  expect(state.requests.some(request => request.path === '/api/life/douban' && new URLSearchParams(request.search).get('limit') === '50' && new URLSearchParams(request.search).get('offset') === '50')).toBe(true);
  expect(state.doubanItems.every(item => item.details.doubanRating === 8.4 && item.imdb?.rating === 7.8 && item.tmdbCoverUrl === TMDB_POSTER_URL)).toBe(true);
  expect(writes.filter(request => request.path.endsWith('/tmdb'))).toHaveLength(0);
  await closeTools(page); await fits(page);
});

test('a saved legacy TMDB match acquires its complete stored image URL only after an explicit cover refresh', async ({ page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanAllowTMDB = true;
  const cover = tmdbPoster('tt0018400'), item = { ...record('movie', 1840), details: { imdbId: cover.imdbId }, tmdb: cover, tmdbCoverUrl: null };
  state.doubanItems = [item]; state.doubanTMDBResults.set(item.subjectId, { status: 'matched', cover }); await mockTMDBImages(page);
  await openLibrary(page); expect(mutations(testInfo)).toEqual([]);
  await page.locator('#douban-list [data-douban-open]').click(); await page.locator('[data-douban-tmdb-item]').click();
  await expect(page.locator('[data-douban-tmdb-status]')).toContainText('已匹配');
  expect(item.tmdbCoverUrl).toBe(TMDB_POSTER_URL); expect(Date.parse(item.updatedAt)).toBeGreaterThan(Date.parse(STAMP));
  await expect(page.locator('[data-douban-source-link="tmdb-cover"]')).toHaveAttribute('href', TMDB_POSTER_URL);
  expect(mutations(testInfo).map(request => request.path)).toEqual(['/api/life/douban/tmdb']); await fits(page);
});


for (const errorCode of ['DOUBAN_ACCESS_DENIED', 'DOUBAN_SOURCE_RATE_LIMITED']) test('a partial public sync ' + (errorCode === 'DOUBAN_SOURCE_RATE_LIMITED' ? 'honors a source rate limit before automatic enrichment' : 'automatically refreshes the records already saved from available sources'), async ({ page }, testInfo) => {
  const state = testInfo.synthetic; bind(state); state.doubanRatingsFeatures = true; state.doubanCompletePublicSync = true;
  state.doubanPublicRunStatus = 'partial'; state.doubanPublicSourceError = errorCode; state.doubanAllowIMDbRatings = true;
  state.doubanPublicSyncItems = [0, 1].map(index => {
    const imdbId = 'tt00197' + index + '0', item = { ...record('movie', 1970 + index), coverUrl: 'https://img1.doubanio.com/view/photo/public/p197' + index + '.jpg',
      details: { imdbId, doubanRating: 5.1, directors: ['已知导演'], summary: '已保存的作品资料' }, tmdb: tmdbPoster(imdbId), tmdbCoverUrl: TMDB_POSTER_URL };
    state.doubanMetadataResults.set(item.subjectId, { kind: 'movie', coverUrl: null, details: { imdbId, doubanRating: 8.4 } });
    state.doubanIMDbRatingResults.set(item.subjectId, imdbScore(imdbId, 7.8)); return item;
  });
  await openLibrary(page); expect(mutations(testInfo)).toEqual([]);
  await openTools(page, 'public'); await page.locator('#douban-sync').click();
  await expect(page.locator('#douban-sync-status')).toContainText('部分');
  if (errorCode === 'DOUBAN_ACCESS_DENIED') {
    await expect.poll(() => state.doubanIMDbRatingReceipts.size).toBe(1);
    await expect(page.locator('#douban-metadata-status')).toContainText('本次补全完成');
    expect(state.doubanItems.every(item => item.details.doubanRating === 8.4 && item.imdb?.rating === 7.8)).toBe(true);
    expect(mutations(testInfo).filter(request => request.path.endsWith('/metadata'))).toHaveLength(2);
    expect(mutations(testInfo).filter(request => request.path.endsWith('/imdb-ratings'))).toHaveLength(1);
  } else {
    await expect(page.locator('#douban-sync')).toBeEnabled();
    expect(mutations(testInfo).filter(request => request.path.endsWith('/metadata') || request.path.endsWith('/imdb-ratings') || request.path.endsWith('/tmdb'))).toEqual([]);
    expect(state.doubanItems.every(item => item.details.doubanRating === 5.1 && !item.imdb)).toBe(true);
  }
  await fits(page);
});
