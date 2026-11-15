import { DOUBAN_LIBRARY_SORTS, parseDoubanLocalRecord, type DoubanLibrarySort, type DoubanLocalRecord } from '../lib/douban-library.ts';
import { doubanSubjectUrl, parseDoubanProfile, type DoubanKind } from '../lib/douban.ts';
import { DoubanStoreError, presentDoubanStoredRecord, readDoubanDataEpoch, type DoubanDatabase, type DoubanRecord, type DoubanRecordKey, type DoubanStoredRecord } from './douban-store.ts';

export interface DoubanLibraryRecord extends DoubanRecord { local: DoubanLocalRecord }
interface StoredLibraryRecord extends DoubanStoredRecord { localNote: string; localTagsJson: string; localHidden: number; localRevision: number }
export interface DoubanLibraryOptions {
  profileId?: string; kind?: DoubanKind | 'all'; query?: string; offset?: number; limit?: number;
  rating?: number | 'unrated'; year?: number; sort?: DoubanLibrarySort; hidden?: 'visible' | 'hidden' | 'all'; tag?: string; missing?: boolean;
}
const columns = `profile_id AS profileId,domain,subject_id AS subjectId,kind,title,url,cover_url AS coverUrl,rating,
  marked_date AS markedDate,comment,published_at AS publishedAt,source,observed_at AS observedAt,
  created_at AS createdAt,updated_at AS updatedAt,metadata_checked_run_id AS metadataCheckedRunId,details_json AS detailsJson,
  local_note AS localNote,local_tags_json AS localTagsJson,local_hidden AS localHidden,local_revision AS localRevision`;
const kinds = ['screen', 'movie', 'series', 'book', 'music'];
const dateOrder = 'marked_date IS NULL,marked_date';
const missingCondition = `(kind='screen' OR cover_url IS NULL OR trim(cover_url)='' OR trim(COALESCE(json_extract(details_json,'$.summary'),''))=''
  OR CASE domain WHEN 'screen' THEN COALESCE(json_array_length(details_json,'$.directors'),0) WHEN 'book' THEN COALESCE(json_array_length(details_json,'$.authors'),0) ELSE COALESCE(json_array_length(details_json,'$.artists'),0) END=0)`;
function invalid(message = '请核对书影音筛选或整理参数。'): never { throw new DoubanStoreError(message, 'INVALID_DOUBAN_INPUT', 400); }
function conflict(): never { throw new DoubanStoreError('记录已变化，请重新读取收藏，核对后再保存。', 'DOUBAN_RECORD_CONFLICT'); }
function present(row: StoredLibraryRecord): DoubanLibraryRecord {
  const { localNote, localTagsJson, localHidden, localRevision, ...stored } = row;
  let tags: unknown; try { tags = JSON.parse(localTagsJson); } catch { throw new DoubanStoreError('个人整理资料暂时无法读取。', 'DOUBAN_STORAGE_UNAVAILABLE', 503); }
  const local = parseDoubanLocalRecord({ note: localNote, tags, hidden: localHidden === 1 });
  if (![0, 1].includes(localHidden) || !Number.isSafeInteger(localRevision) || localRevision < 0) throw new DoubanStoreError('个人整理版本暂时无法读取。', 'DOUBAN_STORAGE_UNAVAILABLE', 503);
  return { ...presentDoubanStoredRecord(stored), local: { ...local, revision: localRevision } };
}
function recordKey(command: DoubanRecordKey): DoubanRecordKey {
  if (typeof command.profileId !== 'string' || parseDoubanProfile(command.profileId).profileId !== command.profileId) invalid();
  doubanSubjectUrl(command.domain, command.subjectId);
  return command;
}
function expectedEpoch(value: number) { if (!Number.isSafeInteger(value) || value < 0) invalid('请先读取当前书影音资料版本。'); }
async function verifyEpoch(db: DoubanDatabase, userId: string, value: number) {
  expectedEpoch(value);
  if (await readDoubanDataEpoch(db, userId) !== value) throw new DoubanStoreError('书影音资料已清空或重置，请重新读取后操作。', 'DOUBAN_DATA_EPOCH_CONFLICT');
}

export async function listDoubanLibrary(db: DoubanDatabase, userId: string, options: DoubanLibraryOptions = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 24, kind = options.kind ?? 'all', query = options.query?.trim() ?? '',
    sort = options.sort ?? 'date-desc', hidden = options.hidden ?? 'visible';
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 50
    || !['all', ...kinds].includes(kind) || typeof query !== 'string' || query.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(query)
    || !DOUBAN_LIBRARY_SORTS.includes(sort) || !['visible', 'hidden', 'all'].includes(hidden)
    || options.rating !== undefined && options.rating !== 'unrated' && (!Number.isInteger(options.rating) || options.rating < 1 || options.rating > 5)
    || options.year !== undefined && (!Number.isInteger(options.year) || options.year < 1000 || options.year > 9999)
    || options.tag !== undefined && (typeof options.tag !== 'string' || !options.tag.trim() || options.tag.length > 30 || /[\u0000-\u001f\u007f-\u009f]/.test(options.tag))
    || options.missing !== undefined && typeof options.missing !== 'boolean') invalid();
  const clauses = ['user_id=?'], values: unknown[] = [userId];
  if (options.profileId !== undefined) { clauses.push('profile_id=?'); values.push(parseDoubanProfile(options.profileId).profileId); }
  if (hidden !== 'all') { clauses.push('local_hidden=?'); values.push(hidden === 'hidden' ? 1 : 0); }
  const facetWhere = clauses.join(' AND '), facetValues = [...values];
  if (query) {
    const fields = ['title', "COALESCE(comment,'')", 'local_note', 'local_tags_json', "COALESCE(json_extract(details_json,'$.authors'),'')", "COALESCE(json_extract(details_json,'$.directors'),'')", "COALESCE(json_extract(details_json,'$.artists'),'')", "COALESCE(json_extract(details_json,'$.cast'),'')"];
    clauses.push('(' + fields.map(field => `${field} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    const term = '%' + query.replace(/[\\%_]/g, char => '\\' + char) + '%'; values.push(...fields.map(() => term));
  }
  if (options.rating !== undefined) { clauses.push(options.rating === 'unrated' ? 'rating IS NULL' : 'rating=?'); if (options.rating !== 'unrated') values.push(options.rating); }
  if (options.year !== undefined) { clauses.push('substr(marked_date,1,4)=?'); values.push(String(options.year)); }
  if (options.tag !== undefined) { clauses.push('EXISTS(SELECT 1 FROM json_each(local_tags_json) WHERE value=?)'); values.push(options.tag.trim()); }
  if (options.missing) clauses.push(missingCondition);
  const where = clauses.join(' AND '), filtered = where + (kind === 'all' ? '' : ' AND kind=?'), selection = kind === 'all' ? values : [...values, kind];
  const order = sort.startsWith('rating-') ? `rating IS NULL,rating ${sort === 'rating-asc' ? 'ASC' : 'DESC'},${dateOrder} DESC` : `${dateOrder} ${sort === 'date-asc' ? 'ASC' : 'DESC'}`;
  const results = await db.batch([
    db.prepare(`SELECT kind,COUNT(*) AS n FROM douban_items WHERE ${where} GROUP BY kind`).bind(...values),
    db.prepare(`SELECT ${columns} FROM douban_items WHERE ${filtered} ORDER BY ${order},observed_at DESC,domain,subject_id,profile_id LIMIT ? OFFSET ?`).bind(...selection, limit, offset),
    db.prepare(`SELECT DISTINCT substr(marked_date,1,4) AS year FROM douban_items WHERE ${facetWhere} AND marked_date IS NOT NULL ORDER BY year DESC`).bind(...facetValues),
    db.prepare(`SELECT DISTINCT j.value AS tag FROM douban_items,json_each(local_tags_json) j WHERE ${facetWhere} ORDER BY j.value LIMIT 500`).bind(...facetValues),
  ]);
  const counts = { all: 0, screen: 0, movie: 0, series: 0, book: 0, music: 0 };
  for (const row of results[0].results as unknown as Array<{ kind: DoubanKind; n: number }>) { counts[row.kind] = row.n; counts.all += row.n; }
  const total = kind === 'all' ? counts.all : counts[kind as DoubanKind];
  return { items: (results[1].results as unknown as StoredLibraryRecord[]).map(present), total, counts, offset, limit, hasMore: offset + results[1].results.length < total,
    years: (results[2].results as unknown as { year: string }[]).map(row => Number(row.year)).filter(year => Number.isInteger(year) && year >= 1000 && year <= 9999),
    tags: (results[3].results as unknown as { tag: string }[]).map(row => row.tag) };
}

export async function writeDoubanLocalRecord(db: DoubanDatabase, userId: string,
  command: DoubanRecordKey & { expectedDataEpoch: number; expectedLocalRevision: number; note: string; tags: string[]; hidden: boolean }): Promise<DoubanLibraryRecord> {
  recordKey(command); await verifyEpoch(db, userId, command.expectedDataEpoch);
  if (!Number.isSafeInteger(command.expectedLocalRevision) || command.expectedLocalRevision < 0 || command.expectedLocalRevision >= Number.MAX_SAFE_INTEGER) invalid();
  const local = parseDoubanLocalRecord(command), tags = JSON.stringify(local.tags);
  const row = await db.prepare(`UPDATE douban_items SET local_note=?,local_tags_json=?,local_hidden=?,local_revision=local_revision+1
    WHERE user_id=? AND profile_id=? AND domain=? AND subject_id=? AND local_revision=?
    AND COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=? RETURNING ${columns}`)
    .bind(local.note, tags, local.hidden ? 1 : 0, userId, command.profileId, command.domain, command.subjectId, command.expectedLocalRevision, userId, command.expectedDataEpoch).first<StoredLibraryRecord>();
  await verifyEpoch(db, userId, command.expectedDataEpoch);
  if (!row) conflict();
  return present(row);
}

export interface DoubanBatchClassification { kind: 'movie' | 'series'; expectedDataEpoch: number; items: Array<DoubanRecordKey & { expectedUpdatedAt: string }> }
export async function classifyDoubanLibrary(db: DoubanDatabase, userId: string, command: DoubanBatchClassification, now = new Date().toISOString()): Promise<DoubanLibraryRecord[]> {
  if (!['movie', 'series'].includes(command.kind) || !Array.isArray(command.items) || command.items.length < 1 || command.items.length > 24) invalid('每次请选择 1–24 条影视记录分类。');
  await verifyEpoch(db, userId, command.expectedDataEpoch);
  const seen = new Set<string>();
  for (const item of command.items) {
    recordKey(item);
    if (item.domain !== 'screen' || typeof item.expectedUpdatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.expectedUpdatedAt) || !Number.isFinite(Date.parse(item.expectedUpdatedAt)) || new Date(item.expectedUpdatedAt).toISOString() !== item.expectedUpdatedAt) invalid();
    const key = item.profileId + ':' + item.subjectId; if (seen.has(key)) invalid('同一条影视记录不能重复选择。'); seen.add(key);
  }
  if (!Number.isFinite(Date.parse(now))) invalid();
  const updatedAt = new Date(Math.max(Date.parse(now), ...command.items.map(item => Date.parse(item.expectedUpdatedAt) + 1))).toISOString();
  const items = JSON.stringify(command.items);
  // Materialize the complete version check before changing any row. One UPDATE makes the batch all-or-nothing.
  const result = await db.prepare(`WITH requested AS MATERIALIZED (SELECT json_extract(value,'$.profileId') AS profileId,json_extract(value,'$.subjectId') AS subjectId,json_extract(value,'$.expectedUpdatedAt') AS version FROM json_each(?)),
    ready AS MATERIALIZED (SELECT COUNT(*) AS n FROM requested r JOIN douban_items d ON d.user_id=? AND d.profile_id=r.profileId AND d.domain='screen' AND d.subject_id=r.subjectId AND d.updated_at=r.version)
    UPDATE douban_items SET kind=?,metadata_checked_run_id='manual-kind',updated_at=?,observed_at=MAX(observed_at,?)
    WHERE user_id=? AND domain='screen' AND (SELECT n FROM ready)=?
    AND COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=?
    AND EXISTS(SELECT 1 FROM requested r WHERE r.profileId=douban_items.profile_id AND r.subjectId=douban_items.subject_id)
    RETURNING ${columns}`).bind(items, userId, command.kind, updatedAt, updatedAt, userId, command.items.length, userId, command.expectedDataEpoch).all<StoredLibraryRecord>();
  await verifyEpoch(db, userId, command.expectedDataEpoch);
  if (result.results.length !== command.items.length) conflict();
  return result.results.map(present);
}
