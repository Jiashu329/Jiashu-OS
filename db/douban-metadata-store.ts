import { doubanSubjectUrl, normalizeDoubanCover, parseDoubanProfile } from '../lib/douban.ts';
import { mergeDoubanDetails } from '../lib/douban-details.ts';
import type { DoubanSubjectMetadata } from '../lib/douban-metadata.ts';
import { DoubanStoreError, doubanDetailsJson, presentDoubanStoredRecord, readDoubanDataEpoch, readDoubanRecord, type DoubanDatabase, type DoubanRecord, type DoubanRecordKey, type DoubanStoredRecord } from './douban-store.ts';

export interface DoubanRecordUpdateKey extends DoubanRecordKey { expectedUpdatedAt: string; expectedDataEpoch?: number }
const MANUAL_KIND = 'manual-kind';
const itemColumns = `profile_id AS profileId,domain,subject_id AS subjectId,kind,title,url,cover_url AS coverUrl,rating,
  marked_date AS markedDate,comment,published_at AS publishedAt,source,observed_at AS observedAt,
  created_at AS createdAt,updated_at AS updatedAt,metadata_checked_run_id AS metadataCheckedRunId,details_json AS detailsJson`;
// Observation time may advance independently, but no business value or classification provenance may change during a refresh.
const guardedFields = {
  kind: 'kind', title: 'title', url: 'url', coverUrl: 'cover_url', rating: 'rating', markedDate: 'marked_date', comment: 'comment',
  publishedAt: 'published_at', source: 'source', createdAt: 'created_at', updatedAt: 'updated_at', metadataCheckedRunId: 'metadata_checked_run_id', details: 'details_json',
} as const;
const fieldNames = Object.keys(guardedFields) as Array<keyof typeof guardedFields>;

function invalid(message: string): never { throw new DoubanStoreError(message, 'INVALID_DOUBAN_INPUT', 400); }
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('请读取这条豆瓣记录的最新版本后重试。');
  return value;
}
function conflict(): never { throw new DoubanStoreError('这条豆瓣记录已更新，请重新读取后再试。', 'DOUBAN_RECORD_CONFLICT'); }
export async function readDoubanMetadataEpoch(db: DoubanDatabase, userId: string, expectedDataEpoch?: number): Promise<number> {
  if (expectedDataEpoch !== undefined && (!Number.isSafeInteger(expectedDataEpoch) || expectedDataEpoch < 0)) invalid('请先读取当前豆瓣资料版本。');
  const current = await readDoubanDataEpoch(db, userId);
  if (expectedDataEpoch !== undefined && current !== expectedDataEpoch) throw new DoubanStoreError('豆瓣资料已清空或重置，旧详情未写入。请重新读取。', 'DOUBAN_DATA_EPOCH_CONFLICT');
  return current;
}
function guardValue(item: DoubanRecord, field: keyof typeof guardedFields) { return field === 'details' ? doubanDetailsJson(item.details) : item[field]; }
function key(command: DoubanRecordUpdateKey): DoubanRecordKey {
  const profileId = parseDoubanProfile(command.profileId).profileId;
  if (profileId !== command.profileId) invalid('请使用当前记录的豆瓣主页 ID。');
  doubanSubjectUrl(command.domain, command.subjectId); timestamp(command.expectedUpdatedAt);
  return { profileId, domain: command.domain, subjectId: command.subjectId };
}
/** A saved subject is editable only inside its signed-in owner and original source profile. */
export async function readDoubanMetadataRecord(db: DoubanDatabase, userId: string, command: DoubanRecordUpdateKey): Promise<DoubanRecord> {
  const recordKey = key(command);
  if (command.expectedDataEpoch !== undefined) await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch);
  const item = await readDoubanRecord(db, userId, recordKey);
  if (!item) throw new DoubanStoreError('未找到这条豆瓣记录，请重新读取收藏。', 'DOUBAN_RECORD_NOT_FOUND', 404);
  if (item.updatedAt !== command.expectedUpdatedAt) conflict();
  return item;
}
async function persist(db: DoubanDatabase, userId: string, old: DoubanRecord, kind: DoubanRecord['kind'], coverUrl: string | null,
  detailsJson: string, marker: string | null, now: string, dataEpoch: number): Promise<{ item: DoubanRecord; changed: boolean }> {
  timestamp(now);
  const changed = old.kind !== kind || old.coverUrl !== coverUrl || doubanDetailsJson(old.details) !== detailsJson;
  if (!changed && marker === old.metadataCheckedRunId) {
    const current = await readDoubanRecord(db, userId, old);
    await readDoubanMetadataEpoch(db, userId, dataEpoch);
    if (!current || fieldNames.some(field => guardValue(current, field) !== guardValue(old, field))) conflict();
    return { item: current, changed: false };
  }
  // A changed content version must remain distinct even if requests share a millisecond or the clock moves backwards.
  const updatedAt = changed ? new Date(Math.max(Date.parse(now), Date.parse(old.updatedAt) + 1)).toISOString() : old.updatedAt;
  const row = await db.prepare(`UPDATE douban_items SET kind=?,cover_url=?,details_json=?,metadata_checked_run_id=?,updated_at=?,observed_at=MAX(observed_at,?)
    WHERE user_id=? AND profile_id=? AND domain=? AND subject_id=? AND ${fieldNames.map(field => guardedFields[field] + ' IS ?').join(' AND ')}
    AND COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=?
    RETURNING ${itemColumns}`)
    .bind(kind, coverUrl, detailsJson, marker, updatedAt, updatedAt, userId, old.profileId, old.domain, old.subjectId, ...fieldNames.map(field => guardValue(old, field)), userId, dataEpoch)
    .first<DoubanStoredRecord>();
  await readDoubanMetadataEpoch(db, userId, dataEpoch);
  if (!row) conflict();
  return { item: presentDoubanStoredRecord(row), changed };
}
function subjectMetadataValues(old: DoubanRecord, metadata: DoubanSubjectMetadata) {
  const coverUrl = normalizeDoubanCover(metadata.coverUrl) ?? old.coverUrl;
  let kind = old.kind;
  if (metadata.kind !== null) {
    if (old.domain === 'screen' ? !['movie', 'series'].includes(metadata.kind) : metadata.kind !== old.domain) invalid('豆瓣详情分类与原条目不一致。');
    const protectedKind = old.metadataCheckedRunId === MANUAL_KIND || old.metadataCheckedRunId === 'import-kind' || old.source === 'import' && ['movie', 'series'].includes(old.kind);
    if (!protectedKind) kind = metadata.kind;
  }
  let detailsJson: string;
  try { detailsJson = doubanDetailsJson(mergeDoubanDetails(old.details, metadata.details)); } catch { return invalid('豆瓣作品详情含有不支持或超出限制的字段。'); }
  return { kind, coverUrl, detailsJson };
}
/** A lost browser reply can be acknowledged only when its public values are already satisfied, without any write. */
export async function readSatisfiedDoubanSubjectMetadata(db: DoubanDatabase, userId: string,
  command: DoubanRecordUpdateKey & { expectedDataEpoch: number }, metadata: DoubanSubjectMetadata): Promise<{ item: DoubanRecord; changed: false }> {
  const recordKey = key(command);
  if (command.expectedDataEpoch === undefined) invalid('请先读取当前豆瓣资料版本。');
  const dataEpoch = await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch);
  const current = await readDoubanRecord(db, userId, recordKey);
  await readDoubanMetadataEpoch(db, userId, dataEpoch);
  if (!current) throw new DoubanStoreError('未找到这条豆瓣记录，请重新读取收藏。', 'DOUBAN_RECORD_NOT_FOUND', 404);
  const values = subjectMetadataValues(current, metadata);
  if (current.kind !== values.kind || current.coverUrl !== values.coverUrl || doubanDetailsJson(current.details) !== values.detailsJson) conflict();
  return { item: current, changed: false };
}
/** Only reliable subject metadata is merged; personal fields and original source are never changed. */
export async function saveDoubanSubjectMetadata(db: DoubanDatabase, userId: string, old: DoubanRecord, metadata: DoubanSubjectMetadata,
  now = new Date().toISOString(), expectedDataEpoch?: number): Promise<{ item: DoubanRecord; changed: boolean }> {
  const dataEpoch = await readDoubanMetadataEpoch(db, userId, expectedDataEpoch);
  const { kind, coverUrl, detailsJson } = subjectMetadataValues(old, metadata);
  return persist(db, userId, old, kind, coverUrl, detailsJson, old.metadataCheckedRunId, now, dataEpoch);
}
/** Local manual classification also marks an already matching kind as explicitly chosen. */
export async function classifyDoubanRecord(db: DoubanDatabase, userId: string,
  command: DoubanRecordUpdateKey & { kind: 'movie' | 'series' }, now = new Date().toISOString()): Promise<DoubanRecord> {
  if (command.domain !== 'screen' || !['movie', 'series'].includes(command.kind)) invalid('只能将影视记录分为电影或电视剧。');
  key(command);
  const dataEpoch = await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch);
  const old = await readDoubanMetadataRecord(db, userId, command);
  return (await persist(db, userId, old, command.kind, old.coverUrl, doubanDetailsJson(old.details), MANUAL_KIND, now, dataEpoch)).item;
}
