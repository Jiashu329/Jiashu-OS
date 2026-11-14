import { doubanSubjectUrl, normalizeDoubanCover, parseDoubanProfile } from '../lib/douban.ts';
import type { DoubanSubjectMetadata } from '../lib/douban-metadata.ts';
import { DoubanStoreError, readDoubanRecord, type DoubanDatabase, type DoubanRecord, type DoubanRecordKey } from './douban-store.ts';

export interface DoubanRecordUpdateKey extends DoubanRecordKey { expectedUpdatedAt: string }
const MANUAL_KIND = 'manual-kind';
const itemColumns = `profile_id AS profileId,domain,subject_id AS subjectId,kind,title,url,cover_url AS coverUrl,rating,
  marked_date AS markedDate,comment,published_at AS publishedAt,source,observed_at AS observedAt,
  created_at AS createdAt,updated_at AS updatedAt,metadata_checked_run_id AS metadataCheckedRunId`;
// Observation time may advance independently, but no business value or classification provenance may change during a refresh.
const guardedFields = {
  kind: 'kind', title: 'title', url: 'url', coverUrl: 'cover_url', rating: 'rating', markedDate: 'marked_date', comment: 'comment',
  publishedAt: 'published_at', source: 'source', createdAt: 'created_at', updatedAt: 'updated_at', metadataCheckedRunId: 'metadata_checked_run_id',
} as const;
const fieldNames = Object.keys(guardedFields) as Array<keyof typeof guardedFields>;

function invalid(message: string): never { throw new DoubanStoreError(message, 'INVALID_DOUBAN_INPUT', 400); }
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('请读取这条豆瓣记录的最新版本后重试。');
  return value;
}
function conflict(): never { throw new DoubanStoreError('这条豆瓣记录已更新，请重新读取后再试。', 'DOUBAN_RECORD_CONFLICT'); }
function key(command: DoubanRecordUpdateKey): DoubanRecordKey {
  const profileId = parseDoubanProfile(command.profileId).profileId;
  if (profileId !== command.profileId) invalid('请使用当前记录的豆瓣主页 ID。');
  doubanSubjectUrl(command.domain, command.subjectId); timestamp(command.expectedUpdatedAt);
  return { profileId, domain: command.domain, subjectId: command.subjectId };
}
/** A saved subject is editable only inside its signed-in owner and original source profile. */
export async function readDoubanMetadataRecord(db: DoubanDatabase, userId: string, command: DoubanRecordUpdateKey): Promise<DoubanRecord> {
  const item = await readDoubanRecord(db, userId, key(command));
  if (!item) throw new DoubanStoreError('未找到这条豆瓣记录，请重新读取收藏。', 'DOUBAN_RECORD_NOT_FOUND', 404);
  if (item.updatedAt !== command.expectedUpdatedAt) conflict();
  return item;
}
async function persist(db: DoubanDatabase, userId: string, old: DoubanRecord, kind: DoubanRecord['kind'], coverUrl: string | null,
  marker: string | null, now: string): Promise<{ item: DoubanRecord; changed: boolean }> {
  timestamp(now);
  const changed = old.kind !== kind || old.coverUrl !== coverUrl;
  if (!changed && marker === old.metadataCheckedRunId) {
    const current = await readDoubanRecord(db, userId, old);
    if (!current || fieldNames.some(field => current[field] !== old[field])) conflict();
    return { item: current, changed: false };
  }
  // A changed content version must remain distinct even if requests share a millisecond or the clock moves backwards.
  const updatedAt = changed ? new Date(Math.max(Date.parse(now), Date.parse(old.updatedAt) + 1)).toISOString() : old.updatedAt;
  const row = await db.prepare(`UPDATE douban_items SET kind=?,cover_url=?,metadata_checked_run_id=?,updated_at=?,observed_at=MAX(observed_at,?)
    WHERE user_id=? AND profile_id=? AND domain=? AND subject_id=? AND ${fieldNames.map(field => guardedFields[field] + ' IS ?').join(' AND ')}
    RETURNING ${itemColumns}`)
    .bind(kind, coverUrl, marker, updatedAt, updatedAt, userId, old.profileId, old.domain, old.subjectId, ...fieldNames.map(field => old[field]))
    .first<DoubanRecord>();
  if (!row) conflict();
  return { item: row, changed };
}
/** Only reliable subject metadata is merged; personal fields and original source are never changed. */
export async function saveDoubanSubjectMetadata(db: DoubanDatabase, userId: string, old: DoubanRecord, metadata: DoubanSubjectMetadata,
  now = new Date().toISOString()): Promise<{ item: DoubanRecord; changed: boolean }> {
  const coverUrl = normalizeDoubanCover(metadata.coverUrl) ?? old.coverUrl;
  let kind = old.kind;
  if (metadata.kind !== null) {
    if (old.domain === 'screen' ? !['movie', 'series'].includes(metadata.kind) : metadata.kind !== old.domain) invalid('豆瓣详情分类与原条目不一致。');
    const protectedKind = old.metadataCheckedRunId === MANUAL_KIND || old.source === 'import' && ['movie', 'series'].includes(old.kind);
    if (!protectedKind) kind = metadata.kind;
  }
  return persist(db, userId, old, kind, coverUrl, old.metadataCheckedRunId, now);
}
/** Local manual classification also marks an already matching kind as explicitly chosen. */
export async function classifyDoubanRecord(db: DoubanDatabase, userId: string,
  command: DoubanRecordUpdateKey & { kind: 'movie' | 'series' }, now = new Date().toISOString()): Promise<DoubanRecord> {
  if (command.domain !== 'screen' || !['movie', 'series'].includes(command.kind)) invalid('只能将影视记录分为电影或电视剧。');
  const old = await readDoubanMetadataRecord(db, userId, command);
  return (await persist(db, userId, old, command.kind, old.coverUrl, MANUAL_KIND, now)).item;
}
