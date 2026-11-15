import { parseDoubanProfile, doubanSubjectUrl } from '../lib/douban.ts';
import { parseIMDbRating, serializeIMDbRating, type IMDbRating } from '../lib/imdb-rating.ts';
import { findIMDbRatings } from '../lib/imdb-ratings-provider.ts';
import { validIMDbId } from '../lib/tmdb-cover.ts';
import { readDoubanLibraryRecords, type DoubanLibraryRecord } from './douban-library-store.ts';
import { readDoubanMetadataEpoch } from './douban-metadata-store.ts';
import { DoubanStoreError, type DoubanDatabase } from './douban-store.ts';

export interface IMDbRatingsItem { profileId: string; domain: 'screen'; subjectId: string; expectedUpdatedAt: string; expectedImdbId: string }
export interface IMDbRatingsCommand { requestId: string; expectedDataEpoch: number; confirmed: true; items: IMDbRatingsItem[] }
export interface IMDbRatingsReceipt { requestId: string; requested: number; updated: number; missing: number; checkedAt: string }
export class IMDbRatingsRefreshBusyError extends Error {
  readonly code = 'IMDB_REFRESH_BUSY'; readonly status = 429; readonly retryAfter = 10;
  constructor() { super('IMDb 评分正在更新，请至少 10 秒后重试原批次。'); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function timestamp(raw: unknown): raw is string { return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw) && Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString() === raw; }
function invalid(): never { throw new DoubanStoreError('请从当前影视收藏选择 1–50 条带 IMDb 编号的作品。', 'INVALID_DOUBAN_INPUT', 400); }
function conflict(): never { throw new DoubanStoreError('本批作品已变化，请重新读取后再获取 IMDb 评分。', 'DOUBAN_RECORD_CONFLICT'); }
function shape(raw: unknown, fields: string[]): raw is Record<string, unknown> {
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && [Object.prototype, null].includes(Object.getPrototypeOf(raw))
    && Object.keys(raw).length === fields.length && Object.keys(raw).every(key => fields.includes(key)));
}
export function parseIMDbRatingsCommand(raw: unknown): IMDbRatingsCommand {
  if (!shape(raw, ['requestId', 'expectedDataEpoch', 'confirmed', 'items']) || typeof raw.requestId !== 'string' || !uuid.test(raw.requestId)
    || !Number.isSafeInteger(raw.expectedDataEpoch) || Number(raw.expectedDataEpoch) < 0 || raw.confirmed !== true || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 50) invalid();
  const seen = new Set<string>(), items: IMDbRatingsItem[] = [];
  for (const item of raw.items) {
    if (!shape(item, ['profileId', 'domain', 'subjectId', 'expectedUpdatedAt', 'expectedImdbId']) || item.domain !== 'screen'
      || typeof item.profileId !== 'string' || parseDoubanProfile(item.profileId).profileId !== item.profileId || typeof item.subjectId !== 'string'
      || !timestamp(item.expectedUpdatedAt) || !validIMDbId(item.expectedImdbId)) invalid();
    doubanSubjectUrl('screen', item.subjectId); const key = JSON.stringify([item.profileId, item.subjectId]); if (seen.has(key)) invalid(); seen.add(key);
    items.push({ profileId: item.profileId, domain: 'screen', subjectId: item.subjectId, expectedUpdatedAt: item.expectedUpdatedAt, expectedImdbId: item.expectedImdbId });
  }
  return { requestId: raw.requestId, expectedDataEpoch: raw.expectedDataEpoch as number, confirmed: true, items };
}
const key = (item: { profileId: string; subjectId: string }) => JSON.stringify([item.profileId, item.subjectId]);
async function hash(command: IMDbRatingsCommand): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(command))))].map(value => value.toString(16).padStart(2, '0')).join(''); }
interface StoredReceipt { requestHash: string; receiptJson: string }
async function readReceipt(db: DoubanDatabase, userId: string, requestId: string): Promise<StoredReceipt | null> {
  return db.prepare('SELECT request_hash AS requestHash,receipt_json AS receiptJson FROM douban_imdb_ratings_receipts WHERE user_id=? AND request_id=?').bind(userId, requestId).first<StoredReceipt>();
}
async function records(db: DoubanDatabase, userId: string, command: IMDbRatingsCommand, requireVersion: boolean): Promise<DoubanLibraryRecord[]> {
  await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch);
  const items = await readDoubanLibraryRecords(db, userId, command.items), found = new Map(items.map(item => [key(item), item]));
  await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch);
  return command.items.map(expected => { const item = found.get(key(expected)); if (!item || item.details?.imdbId !== expected.expectedImdbId || requireVersion && item.updatedAt !== expected.expectedUpdatedAt) conflict(); return item; });
}
function receiptValue(row: StoredReceipt, requestHash: string, command: IMDbRatingsCommand): IMDbRatingsReceipt {
  if (row.requestHash !== requestHash) throw new DoubanStoreError('此评分批次编号已用于另一份请求，请重新读取后操作。', 'IMDB_RATINGS_REQUEST_CONFLICT');
  let value: IMDbRatingsReceipt; try { value = JSON.parse(row.receiptJson); } catch { conflict(); }
  if (!value || value.requestId !== command.requestId || value.requested !== command.items.length || !Number.isSafeInteger(value.updated) || value.updated < 0 || value.updated > value.requested
    || !Number.isSafeInteger(value.missing) || value.missing < 0 || value.missing > value.requested || !timestamp(value.checkedAt)) conflict();
  return value;
}
interface CacheRow { imdbId: string; ratingJson: string; checkedAt: string }
async function readCache(db: DoubanDatabase, ids: string[], now: string): Promise<Map<string, IMDbRating | null>> {
  const result = await db.prepare(`SELECT imdb_id AS imdbId,rating_json AS ratingJson,checked_at AS checkedAt FROM imdb_ratings_cache
    WHERE imdb_id IN (SELECT value FROM json_each(?)) AND checked_at>=? AND checked_at<=?`)
    .bind(JSON.stringify(ids), new Date(Date.parse(now) - 86400000).toISOString(), now).all<CacheRow>();
  const found = new Map<string, IMDbRating | null>();
  for (const row of result.results) {
    if (!validIMDbId(row.imdbId) || !timestamp(row.checkedAt)) throw new Error('Invalid IMDb cache');
    const rating = parseIMDbRating(JSON.parse(row.ratingJson)); if (rating && (rating.imdbId !== row.imdbId || rating.checkedAt !== row.checkedAt)) throw new Error('Invalid IMDb cache');
    found.set(row.imdbId, rating);
  }
  return found;
}
async function cachedRatings(db: DoubanDatabase, userId: string, ids: string[], now: string, lookup: typeof findIMDbRatings): Promise<Map<string, IMDbRating | null>> {
  let found = await readCache(db, ids, now); if (ids.every(id => found.has(id))) return found;
  const token = crypto.randomUUID(), expiresAt = new Date(Date.parse(now) + 60000).toISOString();
  const lease = await db.prepare(`INSERT INTO imdb_ratings_refresh_leases(id,token,expires_at) VALUES('official-dataset',?,?)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE imdb_ratings_refresh_leases.expires_at<=?
    RETURNING token`).bind(token, expiresAt, now).first<{ token: string }>();
  if (!lease) { found = await readCache(db, ids, now); if (ids.every(id => found.has(id))) return found; throw new IMDbRatingsRefreshBusyError(); }
  try {
    // The first scan also fills the caller's remaining known identifiers, so subsequent batches reuse one download.
    const other = await db.prepare(`SELECT DISTINCT json_extract(details_json,'$.imdbId') AS imdbId FROM douban_items
      WHERE user_id=? AND domain='screen' AND json_extract(details_json,'$.imdbId') IS NOT NULL LIMIT 5000`).bind(userId).all<{ imdbId: string }>();
    const targets = [...new Set([...ids, ...other.results.map(row => row.imdbId).filter(validIMDbId)])].slice(0, 5000);
    const targetSet = new Set(targets), result = await lookup(targets, { now });
    if (!timestamp(result.checkedAt) || !Array.isArray(result.ratings) || !Array.isArray(result.missingIds)) throw new Error('Invalid IMDb provider response');
    const values = new Map<string, IMDbRating | null>();
    for (const raw of result.ratings) { const rating = parseIMDbRating(raw); if (!rating || !targetSet.has(rating.imdbId) || rating.checkedAt !== result.checkedAt || values.has(rating.imdbId)) throw new Error('Invalid IMDb provider response'); values.set(rating.imdbId, rating); }
    for (const id of result.missingIds) { if (!targetSet.has(id) || values.has(id)) throw new Error('Invalid IMDb provider response'); values.set(id, null); }
    if (values.size !== targets.length) throw new Error('Incomplete IMDb provider response');
    const rows = [...values].map(([imdbId, rating]) => ({ imdbId, ratingJson: serializeIMDbRating(rating ?? {}), checkedAt: result.checkedAt }));
    await db.prepare(`INSERT INTO imdb_ratings_cache(imdb_id,rating_json,checked_at)
      SELECT json_extract(value,'$.imdbId'),json_extract(value,'$.ratingJson'),json_extract(value,'$.checkedAt') FROM json_each(?) WHERE 1
      ON CONFLICT(imdb_id) DO UPDATE SET rating_json=excluded.rating_json,checked_at=excluded.checked_at
      WHERE excluded.checked_at>=imdb_ratings_cache.checked_at`).bind(JSON.stringify(rows)).all();
    found = new Map(ids.map(id => [id, values.get(id) ?? null])); return found;
  } finally { await db.prepare("DELETE FROM imdb_ratings_refresh_leases WHERE id='official-dataset' AND token=? RETURNING id").bind(token).first(); }
}
export async function syncDoubanIMDbRatings(db: DoubanDatabase, userId: string, raw: IMDbRatingsCommand,
  options: { now?: string; lookup?: typeof findIMDbRatings } = {}) {
  const command = parseIMDbRatingsCommand(raw), now = options.now ?? new Date().toISOString(); if (!timestamp(now)) invalid();
  await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch); const requestHash = await hash(command);
  const existing = await readReceipt(db, userId, command.requestId);
  const response = async (row: StoredReceipt) => ({ items: await records(db, userId, command, false), dataEpoch: command.expectedDataEpoch,
    receipt: receiptValue(row, requestHash, command), ratings: { status: 'complete' as const, source: 'imdb-datasets' as const } });
  if (existing) { receiptValue(existing, requestHash, command); return response(existing); }
  const old = await records(db, userId, command, true), ids = [...new Set(command.items.map(item => item.expectedImdbId))];
  const ratings = await cachedRatings(db, userId, ids, now, options.lookup ?? findIMDbRatings);
  const entries = command.items.map((item, index) => {
    const rating = ratings.get(item.expectedImdbId), ratingJson = rating ? serializeIMDbRating(rating) : null;
    const changed = ratingJson !== null && ratingJson !== serializeIMDbRating(old[index].imdb ?? {});
    return { ...item, ratingJson, changed, updatedAt: new Date(Math.max(Date.parse(now), Date.parse(item.expectedUpdatedAt) + 1)).toISOString() };
  });
  const receipt: IMDbRatingsReceipt = { requestId: command.requestId, requested: entries.length, updated: entries.filter(item => item.changed).length,
    missing: entries.filter(item => item.ratingJson === null).length, checkedAt: now };
  const data = JSON.stringify(entries), writeToken = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO douban_imdb_ratings_receipts(user_id,request_id,request_hash,write_token,receipt_json,created_at)
      SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=?
      AND (SELECT COUNT(*) FROM json_each(?) r JOIN douban_items d ON d.user_id=? AND d.profile_id=json_extract(r.value,'$.profileId')
        AND d.domain='screen' AND d.subject_id=json_extract(r.value,'$.subjectId') AND d.updated_at=json_extract(r.value,'$.expectedUpdatedAt')
        AND json_extract(d.details_json,'$.imdbId')=json_extract(r.value,'$.expectedImdbId'))=?
      ON CONFLICT(user_id,request_id) DO NOTHING`)
      .bind(userId, command.requestId, requestHash, writeToken, JSON.stringify(receipt), now, userId, command.expectedDataEpoch, data, userId, entries.length),
    db.prepare(`UPDATE douban_items SET
      imdb_rating_json=(SELECT json_extract(r.value,'$.ratingJson') FROM json_each(?) r WHERE json_extract(r.value,'$.profileId')=profile_id AND json_extract(r.value,'$.subjectId')=subject_id),
      updated_at=(SELECT json_extract(r.value,'$.updatedAt') FROM json_each(?) r WHERE json_extract(r.value,'$.profileId')=profile_id AND json_extract(r.value,'$.subjectId')=subject_id),
      observed_at=MAX(observed_at,(SELECT json_extract(r.value,'$.updatedAt') FROM json_each(?) r WHERE json_extract(r.value,'$.profileId')=profile_id AND json_extract(r.value,'$.subjectId')=subject_id))
      WHERE user_id=? AND domain='screen' AND EXISTS(SELECT 1 FROM douban_imdb_ratings_receipts WHERE user_id=? AND request_id=? AND write_token=?)
      AND EXISTS(SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.profileId')=profile_id AND json_extract(r.value,'$.subjectId')=subject_id AND json_extract(r.value,'$.changed')=1)
      AND COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=?`)
      .bind(data, data, data, userId, userId, command.requestId, writeToken, data, userId, command.expectedDataEpoch),
  ]);
  await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch); const saved = await readReceipt(db, userId, command.requestId); if (!saved) conflict();
  return response(saved);
}
