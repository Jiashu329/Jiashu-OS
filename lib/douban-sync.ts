import { parseDoubanRecord, type DoubanDomain, type DoubanRecordInput } from './douban.ts';
import { DoubanSourceError, fetchDoubanCollection, fetchDoubanRSS, fetchDoubanSubjectKind } from './douban-source.ts';

export const DOUBAN_SYNC_DOMAINS = ['screen', 'book', 'music'] as const;
export type DoubanRunStatus = 'running' | 'completed' | 'partial' | 'failed';
export type DoubanSyncPhase = 'collections' | 'rss' | 'classification' | 'done';
export interface DoubanSourceProgress {
  status: 'pending' | 'complete' | 'blocked' | 'failed' | 'limited';
  start: number;
  pages: number;
  segmentPages: number;
  received: number;
  total: number | null;
  lastPageIds: string | null;
  errorCode: string | null;
}
export interface DoubanSyncState {
  version: 1;
  /** A short server-side claim prevents overlapping external reads of one cursor. */
  leaseUntil: string | null;
  phase: DoubanSyncPhase;
  sources: Record<DoubanDomain, DoubanSourceProgress>;
  rss: { status: 'pending' | 'complete' | 'failed' | 'skipped'; received: number; errorCode: string | null };
  classification: { checked: number; classified: number; unclassified: number; blocked: boolean; errorCode: string | null };
}
export interface DoubanRunForSync {
  id: string;
  profileId: string;
  connectionRevision: number;
  revision: number;
  status: DoubanRunStatus;
  state: unknown;
  added: number;
  updated: number;
  unchanged: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}
export interface DoubanSyncDecision {
  items: DoubanRecordInput[];
  classification?: { domain: 'screen'; subjectId: string; kind: 'movie' | 'series' | null };
  state: DoubanSyncState;
  status: DoubanRunStatus;
}
export interface DoubanSyncDependencies {
  collection?: typeof fetchDoubanCollection;
  rss?: typeof fetchDoubanRSS;
  classify?: typeof fetchDoubanSubjectKind;
  nextUnclassified(profileId: string, runId: string): Promise<{ subjectId: string } | null>;
  countUnclassified(profileId: string): Promise<number>;
}

const MAX_SOURCE_START = 100000;
const MAX_SEGMENT_PAGES = 1000;
const MAX_CLASSIFICATION_STEPS = 5000;
const SOURCE_STATUSES = ['pending', 'complete', 'blocked', 'failed', 'limited'];
const BLOCKED_CODES = new Set(['DOUBAN_SOURCE_BLOCKED', 'DOUBAN_SOURCE_LOGIN_REQUIRED', 'DOUBAN_SOURCE_CHALLENGE', 'DOUBAN_SOURCE_RATE_LIMITED']);
const SAFE_SOURCE_CODES = new Set([...BLOCKED_CODES, 'DOUBAN_SOURCE_TIMEOUT', 'DOUBAN_SOURCE_NETWORK', 'DOUBAN_SOURCE_INVALID',
  'DOUBAN_SOURCE_TOO_LARGE', 'DOUBAN_SOURCE_REDIRECT', 'DOUBAN_SOURCE_HTTP_ERROR']);

export class DoubanSyncError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;
  constructor(message: string, code = 'INVALID_DOUBAN_SYNC_REQUEST', status = 400, retryAfter?: number) {
    super(message); this.name = 'DoubanSyncError'; this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stateError(): never { throw new DoubanSyncError('同步进度暂时无法读取，请重新开始同步。', 'DOUBAN_SYNC_STATE_UNAVAILABLE', 503); }

/** The continuation cursor is validated server data, never accepted from a browser. */
export function parseDoubanSyncState(raw: unknown): DoubanSyncState {
  if (!object(raw) || raw.version !== 1 || !['collections', 'rss', 'classification', 'done'].includes(String(raw.phase))
    || !object(raw.sources) || !object(raw.rss) || !object(raw.classification)) return stateError();
  const leaseUntil = raw.leaseUntil ?? null;
  if (leaseUntil !== null && (typeof leaseUntil !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(leaseUntil)
    || !Number.isFinite(Date.parse(leaseUntil)) || new Date(leaseUntil).toISOString() !== leaseUntil)) return stateError();
  const sources = {} as Record<DoubanDomain, DoubanSourceProgress>;
  for (const domain of DOUBAN_SYNC_DOMAINS) {
    const value = raw.sources[domain];
    if (!object(value) || !SOURCE_STATUSES.includes(String(value.status)) || !integer(value.start, MAX_SOURCE_START)
      || !integer(value.pages) || !integer(value.segmentPages, MAX_SEGMENT_PAGES) || !integer(value.received)
      || value.total !== null && !integer(value.total) || value.lastPageIds !== null && (typeof value.lastPageIds !== 'string' || value.lastPageIds.length > 2000)
      || value.errorCode !== null && (typeof value.errorCode !== 'string' || !/^DOUBAN_[A-Z_]{1,80}$/.test(value.errorCode))) return stateError();
    sources[domain] = { status: value.status as DoubanSourceProgress['status'], start: value.start, pages: value.pages,
      segmentPages: value.segmentPages, received: value.received, total: value.total as number | null,
      lastPageIds: value.lastPageIds as string | null, errorCode: value.errorCode as string | null };
  }
  const rss = raw.rss, classification = raw.classification;
  if (!['pending', 'complete', 'failed', 'skipped'].includes(String(rss.status)) || !integer(rss.received)
    || rss.errorCode !== null && typeof rss.errorCode !== 'string' || !integer(classification.checked)
    || !integer(classification.classified) || !integer(classification.unclassified) || typeof classification.blocked !== 'boolean'
    || classification.errorCode !== null && typeof classification.errorCode !== 'string') return stateError();
  return { version: 1, leaseUntil, phase: raw.phase as DoubanSyncPhase, sources,
    rss: { status: rss.status as DoubanSyncState['rss']['status'], received: rss.received, errorCode: rss.errorCode as string | null },
    classification: { checked: classification.checked, classified: classification.classified, unclassified: classification.unclassified,
      blocked: classification.blocked, errorCode: classification.errorCode as string | null } };
}

export function createDoubanSyncState(previous?: unknown): DoubanSyncState {
  const source = (): DoubanSourceProgress => ({ status: 'pending', start: 0, pages: 0, segmentPages: 0, received: 0, total: null, lastPageIds: null, errorCode: null });
  const state: DoubanSyncState = { version: 1, leaseUntil: null, phase: 'collections', sources: { screen: source(), book: source(), music: source() },
    rss: { status: 'pending', received: 0, errorCode: null }, classification: { checked: 0, classified: 0, unclassified: 0, blocked: false, errorCode: null } };
  if (previous !== undefined) {
    const old = parseDoubanSyncState(previous);
    // A bounded segment preserves its next offset. Ordinary refreshes start at
    // the first page so changed ratings and comments can be observed again.
    if (DOUBAN_SYNC_DOMAINS.some(domain => old.sources[domain].status === 'limited')) {
      for (const domain of DOUBAN_SYNC_DOMAINS) {
        state.sources[domain] = { ...old.sources[domain], status: old.sources[domain].status === 'limited' ? 'pending' : old.sources[domain].status,
          segmentPages: 0, errorCode: old.sources[domain].status === 'limited' ? null : old.sources[domain].errorCode };
      }
    }
  }
  return state;
}

function safeCode(error: unknown): string {
  return error instanceof DoubanSourceError && SAFE_SOURCE_CODES.has(error.code) ? error.code : 'DOUBAN_SOURCE_UNAVAILABLE';
}
function nextPhase(state: DoubanSyncState): void {
  if (state.phase === 'collections' && DOUBAN_SYNC_DOMAINS.every(domain => state.sources[domain].status !== 'pending')) state.phase = 'rss';
}
function finalStatus(state: DoubanSyncState): DoubanRunStatus {
  if (DOUBAN_SYNC_DOMAINS.every(domain => state.sources[domain].status === 'complete') && state.classification.unclassified === 0 && !state.classification.blocked) return 'completed';
  const observations = DOUBAN_SYNC_DOMAINS.reduce((sum, domain) => sum + state.sources[domain].received, 0) + state.rss.received + state.classification.classified;
  return observations > 0 ? 'partial' : 'failed';
}
function rateLimited(state: DoubanSyncState): void {
  for (const domain of DOUBAN_SYNC_DOMAINS) if (state.sources[domain].status === 'pending') {
    state.sources[domain].status = 'blocked'; state.sources[domain].errorCode = 'DOUBAN_SOURCE_RATE_LIMITED';
  }
  if (state.rss.status === 'pending') state.rss.status = 'skipped';
  state.classification.blocked = true; state.classification.errorCode = 'DOUBAN_SOURCE_RATE_LIMITED'; state.phase = 'done';
}
export function doubanRateLimited(state: DoubanSyncState): boolean {
  return DOUBAN_SYNC_DOMAINS.some(domain => state.sources[domain].errorCode === 'DOUBAN_SOURCE_RATE_LIMITED')
    || state.rss.errorCode === 'DOUBAN_SOURCE_RATE_LIMITED' || state.classification.errorCode === 'DOUBAN_SOURCE_RATE_LIMITED';
}

/** Plan at most one external read. Persistence and compare-and-swap belong to the store. */
export async function advanceDoubanSyncStep(run: DoubanRunForSync, dependencies: DoubanSyncDependencies): Promise<DoubanSyncDecision> {
  const state = parseDoubanSyncState(run.state);
  const decision: DoubanSyncDecision = { items: [], state, status: 'running' };
  if (run.status !== 'running' || state.phase === 'done') return { ...decision, status: run.status === 'running' ? finalStatus(state) : run.status };
  if (state.phase === 'collections') {
    const domain = DOUBAN_SYNC_DOMAINS.find(key => state.sources[key].status === 'pending');
    if (!domain) { nextPhase(state); return decision; }
    const progress = state.sources[domain];
    if (progress.segmentPages >= MAX_SEGMENT_PAGES) {
      progress.status = 'limited'; progress.errorCode = 'DOUBAN_PAGE_LIMIT'; nextPhase(state); return decision;
    }
    try {
      const page = await (dependencies.collection ?? fetchDoubanCollection)(run.profileId, domain, progress.start);
      if (!Array.isArray(page.items) || page.items.length > 30 || page.total !== null && !integer(page.total)
        || page.nextStart !== null && (!integer(page.nextStart, MAX_SOURCE_START) || page.nextStart <= progress.start || page.items.length === 0)) throw new Error('Invalid page contract');
      const items = page.items.map(parseDoubanRecord);
      if (items.some(item => item.domain !== domain || item.source !== 'collection')) throw new Error('Invalid collection domain');
      const pageIds = items.map(item => item.subjectId).sort().join(',');
      if (items.length && pageIds === progress.lastPageIds) {
        progress.status = 'failed'; progress.errorCode = 'DOUBAN_PAGINATION_STALLED'; nextPhase(state); return decision;
      }
      decision.items = items; progress.pages++; progress.segmentPages++; progress.received += items.length;
      progress.total = page.total; progress.lastPageIds = pageIds; progress.errorCode = null;
      if (page.nextStart === null) progress.status = 'complete'; else progress.start = page.nextStart;
    } catch (error) {
      const code = safeCode(error); progress.status = BLOCKED_CODES.has(code) ? 'blocked' : 'failed'; progress.errorCode = code;
      if (code === 'DOUBAN_SOURCE_RATE_LIMITED') { rateLimited(state); decision.status = finalStatus(state); }
    }
    nextPhase(state); return decision;
  }
  if (state.phase === 'rss') {
    if (DOUBAN_SYNC_DOMAINS.every(domain => state.sources[domain].status === 'complete')) state.rss.status = 'skipped';
    else {
      try {
        const items = await (dependencies.rss ?? fetchDoubanRSS)(run.profileId);
        if (!Array.isArray(items) || items.length > 100) throw new Error('Invalid RSS contract');
        const normalized = items.map(parseDoubanRecord);
        if (normalized.some(item => item.source !== 'rss')) throw new Error('Invalid RSS source');
        // A recent activity feed is neither a complete collection nor a newer
        // authoritative view of fields already read from that collection.
        decision.items = normalized.filter(item => state.sources[item.domain].status !== 'complete');
        if (decision.items.length > 30) throw new DoubanSourceError('DOUBAN_SOURCE_TOO_LARGE');
        state.rss.status = 'complete'; state.rss.received = decision.items.length; state.rss.errorCode = null;
      } catch (error) {
        state.rss.status = 'failed'; state.rss.errorCode = safeCode(error); decision.items = [];
        if (state.rss.errorCode === 'DOUBAN_SOURCE_RATE_LIMITED') { rateLimited(state); decision.status = finalStatus(state); return decision; }
      }
    }
    state.phase = 'classification'; return decision;
  }
  if (state.phase === 'classification') {
    state.classification.unclassified = await dependencies.countUnclassified(run.profileId);
    if (!integer(state.classification.unclassified)) return stateError();
    const record = state.classification.blocked || state.classification.checked >= MAX_CLASSIFICATION_STEPS
      ? null : await dependencies.nextUnclassified(run.profileId, run.id);
    if (!record) {
      if (state.classification.checked >= MAX_CLASSIFICATION_STEPS && state.classification.unclassified > 0) {
        state.classification.blocked = true; state.classification.errorCode = 'DOUBAN_CLASSIFICATION_LIMIT';
      }
      state.phase = 'done'; decision.status = finalStatus(state); return decision;
    }
    try {
      const kind = await (dependencies.classify ?? fetchDoubanSubjectKind)(record.subjectId);
      if (kind !== null && kind !== 'movie' && kind !== 'series') throw new Error('Invalid classification');
      decision.classification = { domain: 'screen', subjectId: record.subjectId, kind };
      state.classification.checked++;
      if (kind !== null) { state.classification.classified++; state.classification.unclassified = Math.max(0, state.classification.unclassified - 1); }
    } catch (error) {
      state.classification.blocked = true; state.classification.errorCode = safeCode(error);
      state.phase = 'done'; decision.status = finalStatus(state);
    }
    return decision;
  }
  return stateError();
}

export function presentDoubanRun(run: DoubanRunForSync) {
  const state = parseDoubanSyncState(run.state);
  let message = state.phase === 'collections' ? '正在按页读取公开的已完成标记。'
    : state.phase === 'rss' ? '正在检查近期公开动态补充；近期动态不代表历史全量。'
      : state.phase === 'classification' ? '正在核对公开记录的影视类型，不能确认的保留为待分类影视。' : '';
  if (run.status === 'completed') message = '本次可访问的公开收藏分页已读取完成。';
  else if (run.status === 'partial') message = '本次只完成部分同步。受限或未核对的信息已明确保留，未将近期动态当作历史全量。';
  else if (run.status === 'failed') message = '本次没有获取到可确认的新记录；已有收藏保留。请稍后重试或使用本人导出资料导入。';
  if (doubanRateLimited(state)) message = '豆瓣返回请求频率限制，本次已停止后续访问并保留已保存记录。请至少一分钟后再重试。';
  if (DOUBAN_SYNC_DOMAINS.some(domain => state.sources[domain].status === 'limited')) message += ' 已保留下一页位置，再次开始可继续读取。';
  return { id: run.id, profileId: run.profileId, connectionRevision: run.connectionRevision, revision: run.revision, status: run.status,
    phase: state.phase, sources: Object.fromEntries(DOUBAN_SYNC_DOMAINS.map(domain => {
      const { start: _start, segmentPages: _segmentPages, lastPageIds: _lastPageIds, ...progress } = state.sources[domain];
      return [domain, progress];
    })) as Record<DoubanDomain, Omit<DoubanSourceProgress, 'start' | 'segmentPages' | 'lastPageIds'>>,
    rss: state.rss, classification: state.classification, added: run.added, updated: run.updated, unchanged: run.unchanged,
    message, createdAt: run.createdAt, startedAt: run.createdAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt };
}
