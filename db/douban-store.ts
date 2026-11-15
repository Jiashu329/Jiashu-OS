import { doubanCollectionHash, normalizeDoubanSyncHints, type DoubanSyncHints } from '../lib/douban-sync-hints.ts';
import { doubanSubjectUrl, normalizeDoubanCover, parseDoubanProfile, parseDoubanRecord, type DoubanDomain, type DoubanRecordInput, type DoubanSubjectDetails } from '../lib/douban.ts';
import { mergeDoubanDetails, parseDoubanDetails } from '../lib/douban-details.ts';
import { readDoubanDataEpoch } from './douban-reset-store.ts';
export { readDoubanDataEpoch } from './douban-reset-store.ts';

export type DoubanDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export type DoubanRunStatus = 'running' | 'completed' | 'partial' | 'failed';
export type DoubanKind = DoubanRecordInput['kind'];
export interface DoubanConnection { profileId: string | null; revision: number; updatedAt: string | null }
export interface DoubanRecord extends DoubanRecordInput {
  profileId: string; observedAt: string; createdAt: string; updatedAt: string; metadataCheckedRunId: string | null; sync?: DoubanSyncHints;
}
export interface DoubanRun {
  id: string; profileId: string; connectionRevision: number; revision: number; status: DoubanRunStatus;
  state: unknown; added: number; updated: number; unchanged: number;
  createdAt: string; updatedAt: string; finishedAt: string | null;
}
interface RunRow extends Omit<DoubanRun, 'state'> { stateJson: string }
export interface DoubanStoredRecord extends Omit<DoubanRecord, 'details' | 'sync'> { detailsJson: string; collectionHash?: string | null; detailsCheckedAt?: string | null }
export interface DoubanListOptions { profileId?: string; kind?: DoubanKind | 'all'; query?: string; offset?: number; limit?: number }
export class DoubanStoreError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'DOUBAN_SYNC_CONFLICT', status = 409) { super(message); this.name = 'DoubanStoreError'; this.code = code; this.status = status; }
}
const itemColumns = `profile_id AS profileId,domain,subject_id AS subjectId,kind,title,url,cover_url AS coverUrl,rating,
  marked_date AS markedDate,comment,published_at AS publishedAt,source,observed_at AS observedAt,
  created_at AS createdAt,updated_at AS updatedAt,metadata_checked_run_id AS metadataCheckedRunId,details_json AS detailsJson,collection_hash AS collectionHash,details_checked_at AS detailsCheckedAt`;
const runColumns = `id,profile_id AS profileId,connection_revision AS connectionRevision,revision,status,state_json AS stateJson,
  added,updated,unchanged,created_at AS createdAt,updated_at AS updatedAt,finished_at AS finishedAt`;
const kinds = ['screen', 'movie', 'series', 'book', 'music'] as const;
const statuses = ['running', 'completed', 'partial', 'failed'] as const;
const portableFields = ['domain', 'subjectId', 'kind', 'title', 'url', 'coverUrl', 'rating', 'markedDate', 'comment', 'publishedAt', 'source'] as const;

function invalid(message: string): never { throw new DoubanStoreError(message, 'INVALID_DOUBAN_INPUT', 400); }
function revision(value: number) { if (!Number.isSafeInteger(value) || value < 0) invalid('请先读取最新的豆瓣配置或同步进度。'); }
function timestamp(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('同步时间格式不正确。');
  return value;
}
function stateJson(value: unknown) {
  const seen = new Set<object>();
  function valid(raw: unknown, depth = 0): boolean {
    if (depth > 12) return false;
    if (raw === null || typeof raw === 'boolean') return true;
    if (typeof raw === 'string') return raw.length <= 4096;
    if (typeof raw === 'number') return Number.isFinite(raw);
    if (typeof raw !== 'object' || seen.has(raw) || (!Array.isArray(raw) && ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))) return false;
    seen.add(raw);
    const values = Object.values(raw);
    const result = values.length <= 200 && values.every(item => valid(item, depth + 1));
    seen.delete(raw); return result;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !valid(value)) invalid('同步进度格式不正确。');
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > 16 * 1024) invalid('同步进度内容过大。');
  return encoded;
}
function runView(row: RunRow | null): DoubanRun | null {
  if (!row) return null;
  const { stateJson, ...run } = row;
  return { ...run, state: JSON.parse(stateJson) };
}
export function doubanDetailsJson(details: unknown): string {
  try { return JSON.stringify(parseDoubanDetails(details)); } catch { return invalid('豆瓣作品详情含有不支持或超出限制的字段。'); }
}
function mergedDetails(old: unknown, incoming: unknown): DoubanSubjectDetails {
  try { return mergeDoubanDetails(old, incoming); } catch { return invalid('合并后的豆瓣作品详情超出限制，请精简后重试。'); }
}
export function presentDoubanStoredRecord(row: DoubanStoredRecord): DoubanRecord {
  const { detailsJson, collectionHash, detailsCheckedAt, ...item } = row;
  try { const details = parseDoubanDetails(JSON.parse(detailsJson)); return { ...item, sync: normalizeDoubanSyncHints({ collectionHash, detailsCheckedAt }), ...(Object.keys(details).length ? { details } : {}) }; }
  catch { throw new DoubanStoreError('豆瓣作品详情暂时无法读取，请稍后重试。', 'DOUBAN_STORAGE_UNAVAILABLE', 503); }
}
function equal(a: DoubanRecordInput, b: DoubanRecordInput) { return portableFields.every(key => a[key] === b[key]) && doubanDetailsJson(a.details) === doubanDetailsJson(b.details); }
function chosenKind(item: DoubanRecord | undefined) { return item?.metadataCheckedRunId === 'manual-kind' && (item.kind === 'movie' || item.kind === 'series'); }
function importedKind(item: DoubanRecord | undefined) { return Boolean(item && (item.source === 'import' || item.metadataCheckedRunId === 'import-kind') && (item.kind === 'movie' || item.kind === 'series')); }
function merge(old: DoubanRecord | undefined, input: DoubanRecordInput): DoubanRecordInput {
  if (!old) return input;
  const details = mergedDetails(old.details, input.details), detailFields = Object.keys(details).length ? { details } : {};
  const frozenRss = input.source === 'rss' && (old.source !== 'rss' || input.publishedAt === null
    || old.publishedAt !== null && input.publishedAt <= old.publishedAt);
  if (frozenRss) return {
    domain: old.domain, subjectId: old.subjectId, kind: old.kind, title: old.title, url: old.url,
    coverUrl: old.coverUrl ?? input.coverUrl, rating: old.rating, markedDate: old.markedDate, comment: old.comment,
    publishedAt: old.publishedAt ?? input.publishedAt, source: old.source, ...detailFields,
  };
  // An explicit browser refresh is an authoritative snapshot, including empty
  // ratings/comments. Old browser versions used `import`, so it must also be
  // able to replace those rows; anonymous collection/RSS reads stay conservative.
  const privateImport = old.source === 'import' && input.source !== 'import' && input.source !== 'browser';
  const browserSnapshot = old.source === 'browser' && input.source === 'collection';
  const unknownPersonalFields = input.source === 'rss' || input.source === 'import';
  return {
    ...input, ...detailFields,
    kind: chosenKind(old) || importedKind(old) && input.source !== 'import' || input.kind === 'screen' && (old.kind === 'movie' || old.kind === 'series') ? old.kind : input.kind,
    coverUrl: input.coverUrl ?? old.coverUrl,
    rating: browserSnapshot || privateImport && old.rating !== null || unknownPersonalFields && input.rating === null ? old.rating : input.rating,
    markedDate: browserSnapshot || privateImport && old.markedDate !== null || unknownPersonalFields && input.markedDate === null ? old.markedDate : input.markedDate,
    comment: browserSnapshot || privateImport && old.comment !== null || unknownPersonalFields && input.comment === null ? old.comment : input.comment,
    publishedAt: input.publishedAt ?? old.publishedAt,
    source: browserSnapshot || privateImport || input.source === 'rss' && old.source !== 'rss' ? old.source : input.source,
  };
}

export async function readDoubanConnection(db: DoubanDatabase, userId: string): Promise<DoubanConnection> {
  return await db.prepare('SELECT profile_id AS profileId,revision,updated_at AS updatedAt FROM douban_connections WHERE user_id=?')
    .bind(userId).first<DoubanConnection>() ?? { profileId: null, revision: 0, updatedAt: null };
}
/** A disconnected binding retains collected records; changing it only invalidates older run guards. */
export async function writeDoubanConnection(db: DoubanDatabase, userId: string, value: string | null, expectedRevision: number, now = new Date().toISOString()): Promise<DoubanConnection> {
  revision(expectedRevision); timestamp(now);
  const profileId = value === null ? null : parseDoubanProfile(value).profileId;
  const current = await readDoubanConnection(db, userId);
  if (current.profileId === profileId) return current;
  const row = expectedRevision === 0
    ? await db.prepare(`INSERT INTO douban_connections (user_id,profile_id,revision,updated_at) VALUES (?,?,1,?)
        ON CONFLICT(user_id) DO NOTHING RETURNING profile_id AS profileId,revision,updated_at AS updatedAt`).bind(userId, profileId, now).first<DoubanConnection>()
    : await db.prepare(`UPDATE douban_connections SET profile_id=?,revision=revision+1,updated_at=MAX(updated_at,?)
        WHERE user_id=? AND revision=? RETURNING profile_id AS profileId,revision,updated_at AS updatedAt`).bind(profileId, now, userId, expectedRevision).first<DoubanConnection>();
  if (row) return row;
  const latest = await readDoubanConnection(db, userId);
  if (latest.profileId === profileId) return latest;
  throw new DoubanStoreError('豆瓣主页配置已更新，请读取最新配置后重试。', 'DOUBAN_CONNECTION_CONFLICT');
}

export async function listDoubanRecords(db: DoubanDatabase, userId: string, options: DoubanListOptions = {}) {
  if (options.query !== undefined && typeof options.query !== 'string') invalid('豆瓣记录搜索内容不正确。');
  const offset = options.offset ?? 0, limit = options.limit ?? 24, kind = options.kind ?? 'all', query = options.query?.trim() ?? '';
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100
    || !['all', ...kinds].includes(kind) || typeof query !== 'string' || query.length > 100) invalid('豆瓣记录的筛选或分页参数不正确。');
  const clauses = ['user_id=?'], values: unknown[] = [userId];
  if (options.profileId !== undefined) { clauses.push('profile_id=?'); values.push(parseDoubanProfile(options.profileId).profileId); }
  if (query) { clauses.push("(title LIKE ? ESCAPE '\\' OR COALESCE(comment,'') LIKE ? ESCAPE '\\')"); const term = '%' + query.replace(/[\\%_]/g, char => '\\' + char) + '%'; values.push(term, term); }
  const where = clauses.join(' AND '), filtered = where + (kind === 'all' ? '' : ' AND kind=?');
  const selection = kind === 'all' ? values : [...values, kind];
  const results = await db.batch([
    db.prepare(`SELECT kind,COUNT(*) AS n FROM douban_items WHERE ${where} GROUP BY kind`).bind(...values),
    db.prepare(`SELECT ${itemColumns} FROM douban_items WHERE ${filtered}
      ORDER BY COALESCE(marked_date,substr(published_at,1,10),substr(observed_at,1,10)) DESC,observed_at DESC,domain,subject_id,profile_id LIMIT ? OFFSET ?`).bind(...selection, limit, offset),
  ]);
  const counts = { all: 0, screen: 0, movie: 0, series: 0, book: 0, music: 0 };
  for (const row of results[0].results as unknown as Array<{ kind: DoubanKind; n: number }>) { counts[row.kind] = row.n; counts.all += row.n; }
  const total = kind === 'all' ? counts.all : counts[kind], items = (results[1].results as unknown as DoubanStoredRecord[]).map(presentDoubanStoredRecord);
  return { items, total, counts, offset, limit, hasMore: offset + items.length < total };
}

export interface DoubanRecordKey { profileId: string; domain: DoubanDomain; subjectId: string }
/** A subject ID is not an ownership grant: every lookup includes this signed-in owner and source profile. */
export async function readDoubanRecord(db: DoubanDatabase, userId: string, key: DoubanRecordKey): Promise<DoubanRecord | null> {
  const profileId = parseDoubanProfile(key.profileId).profileId;
  doubanSubjectUrl(key.domain, key.subjectId);
  const row = await db.prepare(`SELECT ${itemColumns} FROM douban_items WHERE user_id=? AND profile_id=? AND domain=? AND subject_id=?`)
    .bind(userId, profileId, key.domain, key.subjectId).first<DoubanStoredRecord>();
  return row ? presentDoubanStoredRecord(row) : null;
}

export async function readDoubanRun(db: DoubanDatabase, userId: string, id?: string): Promise<DoubanRun | null> {
  const row = id !== undefined
    ? await db.prepare(`SELECT ${runColumns} FROM douban_sync_runs WHERE user_id=? AND id=?`).bind(userId, id).first<RunRow>()
    : await db.prepare(`SELECT ${runColumns} FROM douban_sync_runs WHERE user_id=? AND connection_revision=(SELECT revision FROM douban_connections WHERE user_id=?)
        ORDER BY created_at DESC,rowid DESC LIMIT 1`).bind(userId, userId).first<RunRow>();
  return runView(row);
}
export async function startDoubanRun(db: DoubanDatabase, userId: string, connectionRevision: number, state: unknown, now = new Date().toISOString()): Promise<DoubanRun> {
  revision(connectionRevision); timestamp(now); const encoded = stateJson(state);
  const connection = await readDoubanConnection(db, userId);
  if (!connection.profileId) throw new DoubanStoreError('请先设置自己的豆瓣主页。', 'DOUBAN_NOT_CONNECTED');
  if (connection.revision !== connectionRevision) throw new DoubanStoreError('豆瓣主页配置已变化，请读取最新配置后再同步。', 'DOUBAN_CONNECTION_CONFLICT');
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO douban_sync_runs
      (user_id,id,profile_id,connection_revision,revision,status,state_json,added,updated,unchanged,created_at,updated_at,finished_at)
      SELECT ?,?,?,?,0,'running',?,0,0,0,?,?,NULL WHERE EXISTS(SELECT 1 FROM douban_connections WHERE user_id=? AND revision=? AND profile_id=?)
      ON CONFLICT DO NOTHING RETURNING ${runColumns}`)
    .bind(userId, id, connection.profileId, connectionRevision, encoded, now, now, userId, connectionRevision, connection.profileId).first<RunRow>();
  if (result) return runView(result)!;
  const active = await db.prepare(`SELECT ${runColumns} FROM douban_sync_runs WHERE user_id=? AND connection_revision=? AND status='running'`).bind(userId, connectionRevision).first<RunRow>();
  if (active && (await readDoubanConnection(db, userId)).revision === connectionRevision) return runView(active)!;
  throw new DoubanStoreError('豆瓣配置或同步进度已变化，请重新读取。');
}

const activeGuard = `EXISTS(SELECT 1 FROM douban_sync_runs r JOIN douban_connections c ON c.user_id=r.user_id
  WHERE r.user_id=? AND r.id=? AND r.revision=? AND r.connection_revision=? AND r.status='running'
    AND c.revision=r.connection_revision AND c.profile_id=r.profile_id)`;
const frozenRssRow = `(excluded.source='rss' AND (douban_items.source<>'rss' OR excluded.published_at IS NULL
  OR (douban_items.published_at IS NOT NULL AND excluded.published_at<=douban_items.published_at)))`;
export interface DoubanStep {
  runId: string; expectedRevision: number; connectionRevision: number; items: DoubanRecordInput[];
  classification?: { domain: 'screen'; subjectId: string; kind: 'movie' | 'series' | null; coverUrl?: string | null; details?: DoubanSubjectDetails };
  state: unknown; status: DoubanRunStatus; now?: string;
}
/** One bounded page/detail commit. Every mutation shares the same owner, binding and run CAS guard. */
export async function commitDoubanStep(db: DoubanDatabase, userId: string, command: DoubanStep): Promise<DoubanRun> {
  revision(command.expectedRevision); revision(command.connectionRevision);
  const now = timestamp(command.now ?? new Date().toISOString()), encoded = stateJson(command.state);
  if (!statuses.includes(command.status) || !Array.isArray(command.items) || command.items.length > 30) invalid('每步最多同步30条豆瓣记录。');
  const parsed = new Map<string, DoubanRecordInput>();
  for (const raw of command.items) { const item = parseDoubanRecord(raw); parsed.set(item.domain + ':' + item.subjectId, item); }
  const classification = command.classification;
  if (classification && (classification.domain !== 'screen'
    || classification.kind !== null && classification.kind !== 'movie' && classification.kind !== 'series')) invalid('影视分类结果不正确。');
  if (classification) { doubanSubjectUrl('screen', classification.subjectId); normalizeDoubanCover(classification.coverUrl); doubanDetailsJson(classification.details); }
  const run = await readDoubanRun(db, userId, command.runId);
  const connection = await readDoubanConnection(db, userId);
  if (!run || run.status !== 'running' || run.revision !== command.expectedRevision || run.connectionRevision !== command.connectionRevision
    || connection.revision !== command.connectionRevision || connection.profileId !== run.profileId) throw new DoubanStoreError('配置或同步进度已更新，本次结果未写入，请读取最新进度。');
  const keys = [...parsed.keys()]; if (classification) keys.push('screen:' + classification.subjectId);
  const oldRows = keys.length ? await db.prepare(`SELECT ${itemColumns} FROM douban_items WHERE user_id=? AND profile_id=?
    AND domain||':'||subject_id IN (SELECT value FROM json_each(?))`).bind(userId, run.profileId, JSON.stringify(keys)).all<DoubanStoredRecord>() : { results: [] };
  const old = new Map(oldRows.results.map(presentDoubanStoredRecord).map(item => [item.domain + ':' + item.subjectId, item]));
  const snapshots = businessSnapshots([...new Set(keys)], old);
  const guardValues = [userId, run.id, run.revision, run.connectionRevision];
  let added = 0, updated = 0, unchanged = 0;
  const commands: D1PreparedStatement[] = [db.prepare(`UPDATE douban_sync_runs SET state_json=CASE WHEN ${activeGuard} AND ${importSnapshotGuard}
    THEN state_json ELSE NULL END WHERE user_id=? AND id=? AND revision=? AND status='running'`)
    .bind(...guardValues, JSON.stringify(snapshots), userId, run.profileId, userId, run.id, run.revision)];
  for (const [key, input] of parsed) {
    const existing = old.get(key), desired = merge(existing, input);
    const collectionHash = input.source === 'rss' && existing && existing.source !== 'rss' ? existing.sync?.collectionHash ?? null : await doubanCollectionHash(input);
    const detailsCheckedAt = classification && key === 'screen:' + classification.subjectId && (classification.kind !== null || classification.coverUrl != null || Object.keys(classification.details ?? {}).length > 0) ? now : null;
    if (classification && key === 'screen:' + classification.subjectId) {
      if (classification.kind && !chosenKind(existing) && !importedKind(existing)) desired.kind = classification.kind;
      desired.coverUrl = normalizeDoubanCover(classification.coverUrl) ?? desired.coverUrl;
      const details = mergedDetails(desired.details, classification.details); if (Object.keys(details).length) desired.details = details;
    }
    const incomingKind = classification && key === 'screen:' + classification.subjectId && classification.kind ? classification.kind : input.kind;
    const incomingCover = classification && key === 'screen:' + classification.subjectId ? normalizeDoubanCover(classification.coverUrl) ?? input.coverUrl : input.coverUrl;
    if (!existing) added++; else if (equal(existing, desired)) unchanged++; else updated++;
    // Merge against the transactional row too, so a just-restored known field
    // cannot be erased by an RSS record that did not publish that field.
    commands.push(db.prepare(`INSERT INTO douban_items
      (user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,observed_at,created_at,updated_at,metadata_checked_run_id,details_json,collection_hash,details_checked_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${activeGuard}
      ON CONFLICT(user_id,profile_id,domain,subject_id) DO UPDATE SET
        kind=CASE WHEN douban_items.metadata_checked_run_id='manual-kind' AND douban_items.kind IN ('movie','series') OR ${frozenRssRow}
          OR (excluded.kind='screen' OR (douban_items.source='import' OR douban_items.metadata_checked_run_id='import-kind') AND excluded.source<>'import') AND douban_items.kind IN ('movie','series') THEN douban_items.kind ELSE excluded.kind END,
        title=CASE WHEN ${frozenRssRow} THEN douban_items.title ELSE excluded.title END,
        url=CASE WHEN ${frozenRssRow} THEN douban_items.url ELSE excluded.url END,
        cover_url=CASE WHEN ${frozenRssRow} THEN COALESCE(douban_items.cover_url,excluded.cover_url) ELSE COALESCE(excluded.cover_url,douban_items.cover_url) END,
        details_json=excluded.details_json,
        collection_hash=excluded.collection_hash,details_checked_at=CASE WHEN excluded.details_checked_at IS NOT NULL THEN excluded.details_checked_at WHEN douban_items.collection_hash IS excluded.collection_hash THEN douban_items.details_checked_at ELSE NULL END,
        rating=CASE WHEN ${frozenRssRow} OR douban_items.source='browser' AND excluded.source='collection' OR douban_items.source='import' AND excluded.source NOT IN ('import','browser') AND douban_items.rating IS NOT NULL OR excluded.source IN ('rss','import') AND excluded.rating IS NULL THEN douban_items.rating ELSE excluded.rating END,
        marked_date=CASE WHEN ${frozenRssRow} OR douban_items.source='browser' AND excluded.source='collection' OR douban_items.source='import' AND excluded.source NOT IN ('import','browser') AND douban_items.marked_date IS NOT NULL OR excluded.source IN ('rss','import') AND excluded.marked_date IS NULL THEN douban_items.marked_date ELSE excluded.marked_date END,
        comment=CASE WHEN ${frozenRssRow} OR douban_items.source='browser' AND excluded.source='collection' OR douban_items.source='import' AND excluded.source NOT IN ('import','browser') AND douban_items.comment IS NOT NULL OR excluded.source IN ('rss','import') AND excluded.comment IS NULL THEN douban_items.comment ELSE excluded.comment END,
        published_at=CASE WHEN ${frozenRssRow} THEN COALESCE(douban_items.published_at,excluded.published_at) ELSE COALESCE(excluded.published_at,douban_items.published_at) END,
        source=CASE WHEN ${frozenRssRow} OR douban_items.source='browser' AND excluded.source='collection' OR douban_items.source='import' AND excluded.source NOT IN ('import','browser') OR excluded.source='rss' AND douban_items.source<>'rss' THEN douban_items.source ELSE excluded.source END,
        observed_at=MAX(douban_items.observed_at,excluded.observed_at),
        updated_at=CASE WHEN ${frozenRssRow} THEN CASE WHEN douban_items.cover_url IS NULL AND excluded.cover_url IS NOT NULL
          OR douban_items.published_at IS NULL AND excluded.published_at IS NOT NULL OR douban_items.details_json<>excluded.details_json THEN MAX(douban_items.observed_at,excluded.observed_at) ELSE douban_items.updated_at END
          ELSE MAX(douban_items.updated_at,?) END,
        metadata_checked_run_id=CASE WHEN douban_items.metadata_checked_run_id IN ('manual-kind','import-kind') THEN douban_items.metadata_checked_run_id
          WHEN douban_items.source='import' AND excluded.source='browser' AND douban_items.kind IN ('movie','series') THEN 'import-kind'
          ELSE COALESCE(excluded.metadata_checked_run_id,douban_items.metadata_checked_run_id) END`)
      .bind(userId, run.profileId, input.domain, input.subjectId, incomingKind, input.title, input.url, incomingCover, input.rating, input.markedDate, input.comment,
        input.publishedAt, input.source, now, now, now, classification && key === 'screen:' + classification.subjectId ? run.id : null,
        doubanDetailsJson(desired.details), collectionHash, detailsCheckedAt,
        ...guardValues, existing && equal(existing, desired) ? existing.updatedAt : [existing?.observedAt ?? now, now].sort().at(-1)!));
  }
  if (classification && !parsed.has('screen:' + classification.subjectId)) {
    const existing = old.get('screen:' + classification.subjectId);
    if (existing) {
      const kind = classification.kind && !chosenKind(existing) && !importedKind(existing) ? classification.kind : existing.kind;
      const desired = { ...existing, kind, coverUrl: normalizeDoubanCover(classification.coverUrl) ?? existing.coverUrl, details: mergedDetails(existing.details, classification.details) };
      const changed = !equal(existing, desired); if (changed) updated++;
      const updatedAt = changed ? new Date(Math.max(Date.parse(now), Date.parse(existing.updatedAt) + 1)).toISOString() : existing.updatedAt;
      const checkedAt = classification.kind !== null || classification.coverUrl != null || Object.keys(classification.details ?? {}).length > 0 ? now : existing.sync?.detailsCheckedAt ?? null;
      commands.push(db.prepare(`UPDATE douban_items SET kind=?,cover_url=?,details_json=?,details_checked_at=?,
        metadata_checked_run_id=CASE WHEN metadata_checked_run_id IN ('manual-kind','import-kind') THEN metadata_checked_run_id ELSE ? END,
        updated_at=?,observed_at=MAX(observed_at,?) WHERE user_id=? AND profile_id=? AND domain='screen' AND subject_id=? AND ${activeGuard}`)
        .bind(kind, desired.coverUrl, doubanDetailsJson(desired.details), checkedAt, run.id, updatedAt, now, userId, run.profileId, classification.subjectId, ...guardValues));
    }
  }
  commands.push(db.prepare(`UPDATE douban_sync_runs SET revision=revision+1,state_json=?,status=?,added=added+?,updated=updated+?,unchanged=unchanged+?,
    updated_at=MAX(updated_at,?),finished_at=CASE WHEN ?='running' THEN NULL ELSE MAX(updated_at,?) END
    WHERE user_id=? AND id=? AND revision=? AND connection_revision=? AND status='running' AND ${activeGuard}
    RETURNING ${runColumns}`).bind(encoded, command.status, added, updated, unchanged, now, command.status, now,
      userId, run.id, run.revision, run.connectionRevision, ...guardValues));
  let results: D1Result[];
  try { results = await db.batch(commands); }
  catch (error) {
    const currentRun = await readDoubanRun(db, userId, run.id), currentConnection = await readDoubanConnection(db, userId);
    if (!currentRun || currentRun.revision !== run.revision || currentRun.status !== 'running'
      || currentConnection.revision !== run.connectionRevision || currentConnection.profileId !== run.profileId) {
      throw new DoubanStoreError('配置或同步进度已更新，本次结果未写入，请读取最新进度。');
    }
    const currentRows = keys.length ? await db.prepare(`SELECT ${itemColumns} FROM douban_items WHERE user_id=? AND profile_id=?
      AND domain||':'||subject_id IN (SELECT value FROM json_each(?))`).bind(userId, run.profileId, JSON.stringify(keys)).all<DoubanStoredRecord>() : { results: [] };
    if (JSON.stringify(businessSnapshots([...new Set(keys)], new Map(currentRows.results.map(presentDoubanStoredRecord).map(item => [keyOf(item), item])))) !== JSON.stringify(snapshots)) {
      throw new DoubanStoreError('豆瓣记录已在其他操作中更新，本次结果未写入，请读取最新进度。');
    }
    throw error;
  }
  const row = results.at(-1)?.results[0] as unknown as RunRow | undefined;
  if (!row) throw new DoubanStoreError('配置或同步进度已更新，本次结果未写入，请读取最新进度。');
  return runView(row)!;
}

export async function nextUnclassifiedRecord(db: DoubanDatabase, userId: string, profileId: string, runId: string, now = new Date().toISOString()): Promise<DoubanRecord | null> {
  const profile = parseDoubanProfile(profileId).profileId, cutoff = new Date(Date.parse(timestamp(now)) - 7 * 86400000).toISOString();
  const row = await db.prepare(`SELECT ${itemColumns} FROM douban_items WHERE user_id=? AND profile_id=? AND domain='screen' AND kind='screen'
    AND source IN ('collection','rss') AND (metadata_checked_run_id IS NULL OR metadata_checked_run_id<>?)
    AND (collection_hash IS NULL OR details_checked_at IS NULL OR details_checked_at<=?)
    ORDER BY observed_at DESC,subject_id LIMIT 1`).bind(userId, profile, runId, cutoff).first<DoubanStoredRecord>();
  return row ? presentDoubanStoredRecord(row) : null;
}

export async function countUnclassifiedDoubanRecords(db: DoubanDatabase, userId: string, profileId: string): Promise<number> {
  const profile = parseDoubanProfile(profileId).profileId;
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM douban_items WHERE user_id=? AND profile_id=? AND domain='screen' AND kind='screen' AND source IN ('collection','rss')`)
    .bind(userId, profile).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface DoubanImportInput { profileId: string; items: DoubanRecordInput[]; expectedDataEpoch?: number }
export interface DoubanImportPreview { profileId: string; dataEpoch: number; snapshotHash: string; total: number; added: number; updated: number; unchanged: number }
export interface DoubanImportReceipt { profileId: string; dataEpoch: number; requestId: string; total: number; added: number; updated: number; unchanged: number }
export interface DoubanImportCommand extends DoubanImportInput { expectedSnapshotHash: string; requestId: string; now?: string }
type ImportSnapshot = Record<string, string | number | boolean | null> & { domain: string; subjectId: string; exists: number; manualKind: boolean; importKind: boolean; detailsJson: string };
function businessSnapshots(keys: string[], old: Map<string, DoubanRecord>): ImportSnapshot[] {
  return keys.map(key => {
    const [domain, subjectId] = key.split(':'), before = old.get(key);
    return { ...Object.fromEntries(portableFields.map(field => [field, before?.[field] ?? null])), domain, subjectId, exists: before ? 1 : 0, manualKind: before?.metadataCheckedRunId === 'manual-kind', importKind: before?.metadataCheckedRunId === 'import-kind', detailsJson: doubanDetailsJson(before?.details) };
  });
}
interface ImportPlan {
  preview: DoubanImportPreview; requestHash: string; inputs: DoubanRecordInput[]; desired: DoubanRecordInput[];
  snapshots: ImportSnapshot[]; old: Map<string, DoubanRecord>;
}
const keyOf = (item: Pick<DoubanRecordInput, 'domain' | 'subjectId'>) => item.domain + ':' + item.subjectId;
async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function importItems(input: DoubanImportInput) {
  const profileId = parseDoubanProfile(input.profileId).profileId;
  const expectedDataEpoch = input.expectedDataEpoch === undefined ? 0 : input.expectedDataEpoch;
  if (!Number.isSafeInteger(expectedDataEpoch) || expectedDataEpoch < 0) invalid('请先读取当前豆瓣资料，再预览本次导入。');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 500) invalid('每次请导入1–500条豆瓣记录。');
  const keys = new Set<string>();
  const items = input.items.map(raw => {
    const item = parseDoubanRecord(raw);
    if (item.source !== 'import' && item.source !== 'browser') invalid('资料保存只接收文件导入或浏览器同步来源。');
    const key = keyOf(item);
    if (keys.has(key)) invalid('同一文件含重复豆瓣条目，请核对后去重再导入。');
    keys.add(key); return item;
  }).sort((a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
  return { profileId, items, expectedDataEpoch };
}
function importEpochConflict(): never {
  throw new DoubanStoreError('豆瓣资料已清空或重置，请重新读取当前资料后再预览导入。', 'DOUBAN_DATA_EPOCH_CONFLICT');
}
async function assertImportEpoch(db: DoubanDatabase, userId: string, expectedDataEpoch: number) {
  if (await readDoubanDataEpoch(db, userId) !== expectedDataEpoch) importEpochConflict();
}
const importEpochGuard = 'COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=?';
async function planDoubanImport(db: DoubanDatabase, userId: string, input: DoubanImportInput): Promise<ImportPlan> {
  const { profileId, items, expectedDataEpoch } = importItems(input);
  await assertImportEpoch(db, userId, expectedDataEpoch);
  const result = await db.prepare(`SELECT ${itemColumns} FROM douban_items WHERE user_id=? AND profile_id=?
    AND domain||':'||subject_id IN (SELECT value FROM json_each(?))`)
    .bind(userId, profileId, JSON.stringify(items.map(keyOf))).all<DoubanStoredRecord>();
  const old = new Map(result.results.map(presentDoubanStoredRecord).map(item => [keyOf(item), item]));
  const snapshots = businessSnapshots(items.map(keyOf), old);
  const desired = items.map(item => merge(old.get(keyOf(item)), item));
  let added = 0, updated = 0, unchanged = 0;
  for (let index = 0; index < items.length; index++) {
    const before = old.get(keyOf(items[index]));
    if (!before) added++; else if (equal(before, desired[index])) unchanged++; else updated++;
  }
  const requestHash = await digest({ profileId, items });
  // Bind the preview to its owner, source profile, exact proposed content and
  // the affected business snapshot. Observations and ordinary classification
  // bookkeeping may change; an explicit manual classification remains an intent.
  const snapshotHash = await digest([userId, profileId, expectedDataEpoch, requestHash, snapshots]);
  await assertImportEpoch(db, userId, expectedDataEpoch);
  return { preview: { profileId, dataEpoch: expectedDataEpoch, snapshotHash, total: items.length, added, updated, unchanged }, requestHash, inputs: items, desired, snapshots, old };
}
export async function previewDoubanImport(db: DoubanDatabase, userId: string, input: DoubanImportInput): Promise<DoubanImportPreview> {
  return (await planDoubanImport(db, userId, input)).preview;
}
/** Read current persisted versions for an explicitly requested small import page, never the receipt's old input. */
export async function readDoubanImportRecords(db: DoubanDatabase, userId: string, input: DoubanImportInput): Promise<DoubanRecord[]> {
  const normalized = importItems(input);
  if (normalized.items.length > 30) invalid('每次最多返回30条已保存的豆瓣记录。');
  await assertImportEpoch(db, userId, normalized.expectedDataEpoch);
  const result = await db.prepare(`SELECT ${itemColumns} FROM douban_items WHERE user_id=? AND profile_id=?
    AND domain||':'||subject_id IN (SELECT value FROM json_each(?)) ORDER BY domain,subject_id`)
    .bind(userId, normalized.profileId, JSON.stringify(normalized.items.map(keyOf))).all<DoubanStoredRecord>();
  const records = result.results.map(presentDoubanStoredRecord);
  await assertImportEpoch(db, userId, normalized.expectedDataEpoch);
  if (records.length !== normalized.items.length) importConflict();
  return records;
}
async function importReceipt(db: DoubanDatabase, userId: string, requestId: string, dataEpoch: number) {
  return db.prepare(`SELECT request_hash AS requestHash,receipt_json AS receiptJson FROM douban_import_receipts WHERE user_id=? AND request_id=? AND ${importEpochGuard}`)
    .bind(userId, requestId, userId, dataEpoch).first<{ requestHash: string; receiptJson: string }>();
}
function importReceiptView(prior: { requestHash: string; receiptJson: string }, requestHash: string, dataEpoch: number): DoubanImportReceipt {
  if (prior.requestHash !== requestHash) importConflict();
  const { _syncWriteToken: _token, ...receipt } = JSON.parse(prior.receiptJson) as DoubanImportReceipt & { _syncWriteToken?: string };
  if ((receipt.dataEpoch ?? 0) !== dataEpoch) importEpochConflict();
  return { ...receipt, dataEpoch };
}
const importBusinessColumns: Record<(typeof portableFields)[number], string> = {
  domain: 'domain', subjectId: 'subject_id', kind: 'kind', title: 'title', url: 'url', coverUrl: 'cover_url', rating: 'rating',
  markedDate: 'marked_date', comment: 'comment', publishedAt: 'published_at', source: 'source',
};
const importSnapshotGuard = `NOT EXISTS(SELECT 1 FROM json_each(?) s LEFT JOIN douban_items i
  ON i.user_id=? AND i.profile_id=? AND i.domain=json_extract(s.value,'$.domain') AND i.subject_id=json_extract(s.value,'$.subjectId')
  WHERE (CASE WHEN i.subject_id IS NULL THEN 0 ELSE 1 END) IS NOT json_extract(s.value,'$.exists')
    OR COALESCE(i.details_json,'{}') IS NOT json_extract(s.value,'$.detailsJson')
    OR (CASE WHEN i.metadata_checked_run_id='manual-kind' THEN 1 ELSE 0 END) IS NOT json_extract(s.value,'$.manualKind')
    OR (CASE WHEN i.metadata_checked_run_id='import-kind' THEN 1 ELSE 0 END) IS NOT json_extract(s.value,'$.importKind') OR `
  + portableFields.filter(field => field !== 'domain' && field !== 'subjectId')
    .map(field => `i.${importBusinessColumns[field]} IS NOT json_extract(s.value,'$.${field}')`).join(' OR ') + ')';
function importConflict(): never {
  throw new DoubanStoreError('这些豆瓣记录已发生变化，未导入任何记录。请重新预览并核对。', 'DOUBAN_IMPORT_CONFLICT');
}
/** Confirmed private import: no connection lookup and no outbound network request. */
export async function commitDoubanImport(db: DoubanDatabase, userId: string, command: DoubanImportCommand): Promise<DoubanImportReceipt> {
  if (typeof command.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.requestId)
    || typeof command.expectedSnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(command.expectedSnapshotHash)) invalid('请先预览文件，再确认本次导入。');
  const now = timestamp(command.now ?? new Date().toISOString()), requestId = command.requestId.toLowerCase();
  const normalized = importItems(command), dataEpoch = normalized.expectedDataEpoch, requestHash = await digest({ profileId: normalized.profileId, items: normalized.items });
  await assertImportEpoch(db, userId, dataEpoch);
  const prior = await importReceipt(db, userId, requestId, dataEpoch);
  if (prior) { await assertImportEpoch(db, userId, dataEpoch); return importReceiptView(prior, requestHash, dataEpoch); }
  const plan = await planDoubanImport(db, userId, normalized);
  if (plan.preview.snapshotHash !== command.expectedSnapshotHash) importConflict();
  const { snapshotHash: _snapshotHash, ...counts } = plan.preview;
  const receipt: DoubanImportReceipt = { ...counts, requestId }, syncWriteToken = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO douban_import_receipts (user_id,request_id,request_hash,receipt_json,created_at)
    VALUES (?,?,?,CASE WHEN ${importEpochGuard} THEN ? ELSE NULL END,?) ON CONFLICT(user_id,request_id) DO NOTHING`)
    .bind(userId, requestId, requestHash, userId, dataEpoch, JSON.stringify({ ...receipt, _syncWriteToken: syncWriteToken }), now)];
  for (let offset = 0; offset < plan.inputs.length;) {
    const rows: string[] = [], snapshots: string[] = []; let rowBytes = 2, snapshotBytes = 2;
    while (offset < plan.inputs.length && rows.length < 100) {
      const item = plan.desired[offset], before = plan.old.get(keyOf(item)), { details: _details, ...portable } = item;
      // Source provenance can change to browser while an explicit imported
      // classification stays protected. Keep its own marker, separate from a
      // manual choice, so a later explicit file import may still correct it.
      const classificationMarker = importedKind(before) && item.source === 'browser' || before?.metadataCheckedRunId === 'import-kind' ? 'import-kind' : null;
      const collectionHash = await doubanCollectionHash(plan.inputs[offset]);
      const row = JSON.stringify({ ...portable, collectionHash, classificationMarker, detailsJson: doubanDetailsJson(item.details), observedAt: now, createdAt: now,
        updatedAt: before && equal(before, item) ? before.updatedAt : [before?.observedAt ?? now, now].sort().at(-1)! });
      const snapshot = JSON.stringify(plan.snapshots[offset]), rowSize = new TextEncoder().encode(row).byteLength + 1, snapshotSize = new TextEncoder().encode(snapshot).byteLength + 1;
      if (rowSize + 2 > 1024 * 1024 || snapshotSize + 2 > 1024 * 1024) invalid('单条豆瓣作品详情超出保存上限。');
      if (rowBytes + rowSize > 1024 * 1024 || snapshotBytes + snapshotSize > 1024 * 1024) break;
      rows.push(row); snapshots.push(snapshot); rowBytes += rowSize; snapshotBytes += snapshotSize; offset++;
    }
    // A failed NULL-safe snapshot guard deliberately violates this receipt's
    // NOT NULL constraint. D1 batch rolls every earlier chunk back atomically.
    statements.push(db.prepare(`UPDATE douban_import_receipts SET receipt_json=CASE WHEN request_hash=? AND ${importEpochGuard} AND ${importSnapshotGuard}
      THEN receipt_json ELSE NULL END WHERE user_id=? AND request_id=?`)
      .bind(requestHash, userId, dataEpoch, '[' + snapshots.join(',') + ']', userId, plan.preview.profileId, userId, requestId));
    statements.push(db.prepare(`INSERT INTO douban_items
      (user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,observed_at,created_at,updated_at,details_json,metadata_checked_run_id,collection_hash)
      SELECT ?,?,json_extract(value,'$.domain'),json_extract(value,'$.subjectId'),json_extract(value,'$.kind'),json_extract(value,'$.title'),
        json_extract(value,'$.url'),json_extract(value,'$.coverUrl'),json_extract(value,'$.rating'),json_extract(value,'$.markedDate'),
        json_extract(value,'$.comment'),json_extract(value,'$.publishedAt'),json_extract(value,'$.source'),json_extract(value,'$.observedAt'),json_extract(value,'$.createdAt'),json_extract(value,'$.updatedAt'),json_extract(value,'$.detailsJson'),json_extract(value,'$.classificationMarker'),json_extract(value,'$.collectionHash')
      FROM json_each(?) WHERE ${importEpochGuard}
      ON CONFLICT(user_id,profile_id,domain,subject_id) DO UPDATE SET kind=CASE WHEN (douban_items.metadata_checked_run_id='manual-kind' OR douban_items.metadata_checked_run_id='import-kind' AND excluded.source<>'import') AND douban_items.kind IN ('movie','series') THEN douban_items.kind ELSE excluded.kind END,
        title=excluded.title,url=excluded.url,cover_url=excluded.cover_url,details_json=excluded.details_json,
        collection_hash=CASE WHEN (SELECT json_extract(receipt_json,'$._syncWriteToken') FROM douban_import_receipts WHERE user_id=? AND request_id=?)=? THEN excluded.collection_hash ELSE douban_items.collection_hash END,
        details_checked_at=CASE WHEN (SELECT json_extract(receipt_json,'$._syncWriteToken') FROM douban_import_receipts WHERE user_id=? AND request_id=?)=? AND douban_items.collection_hash IS NOT excluded.collection_hash THEN NULL ELSE douban_items.details_checked_at END,
        rating=excluded.rating,marked_date=excluded.marked_date,comment=excluded.comment,published_at=excluded.published_at,source=excluded.source,
        observed_at=MAX(douban_items.observed_at,excluded.observed_at),updated_at=MAX(douban_items.updated_at,excluded.updated_at),
        metadata_checked_run_id=CASE WHEN douban_items.metadata_checked_run_id='manual-kind' THEN douban_items.metadata_checked_run_id ELSE COALESCE(excluded.metadata_checked_run_id,douban_items.metadata_checked_run_id) END`)
      .bind(userId, plan.preview.profileId, '[' + rows.join(',') + ']', userId, dataEpoch, userId, requestId, syncWriteToken, userId, requestId, syncWriteToken));
  }
  try { await db.batch(statements); }
  catch {
    await assertImportEpoch(db, userId, dataEpoch);
    const replay = await importReceipt(db, userId, requestId, dataEpoch);
    if (replay) { await assertImportEpoch(db, userId, dataEpoch); return importReceiptView(replay, requestHash, dataEpoch); }
    const current = await planDoubanImport(db, userId, normalized);
    if (current.preview.snapshotHash !== command.expectedSnapshotHash) importConflict();
    throw new DoubanStoreError('导入暂未确认完成，请保留本次预览和提交标识后重试。', 'DOUBAN_IMPORT_UNAVAILABLE', 503);
  }
  await assertImportEpoch(db, userId, dataEpoch);
  return receipt;
}
