import { doubanSubjectUrl, parseDoubanProfile } from '../lib/douban.ts';
import { parseTMDBCover, serializeTMDBCover, tmdbCoverUrl, type TMDBCover } from '../lib/tmdb-cover.ts';
import { readDoubanLibraryRecord, type DoubanLibraryRecord } from './douban-library-store.ts';
import { readDoubanMetadataEpoch } from './douban-metadata-store.ts';
import { DoubanStoreError, type DoubanDatabase, type DoubanRecordKey } from './douban-store.ts';

export interface DoubanTMDBCommand extends DoubanRecordKey { domain: 'screen'; expectedUpdatedAt: string; expectedDataEpoch: number }
function conflict(): never { throw new DoubanStoreError('这条豆瓣记录已更新，请重新读取后再找封面。', 'DOUBAN_RECORD_CONFLICT'); }
function timestamp(raw: unknown): raw is string {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    && Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString() === raw;
}
function validate(command: DoubanTMDBCommand) {
  if (typeof command.profileId !== 'string' || parseDoubanProfile(command.profileId).profileId !== command.profileId
    || command.domain !== 'screen' || typeof command.subjectId !== 'string' || !timestamp(command.expectedUpdatedAt) || !Number.isSafeInteger(command.expectedDataEpoch) || command.expectedDataEpoch < 0) {
    throw new DoubanStoreError('请从当前影视收藏选择作品，并核对资料版本。', 'INVALID_DOUBAN_INPUT', 400);
  }
  doubanSubjectUrl(command.domain, command.subjectId);
}
export async function readDoubanTMDBItem(db: DoubanDatabase, userId: string, command: DoubanTMDBCommand): Promise<DoubanLibraryRecord> {
  validate(command); await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch);
  const item = await readDoubanLibraryRecord(db, userId, command);
  await readDoubanMetadataEpoch(db, userId, command.expectedDataEpoch);
  if (!item) throw new DoubanStoreError('未找到这条影视记录，请重新读取收藏。', 'DOUBAN_RECORD_NOT_FOUND', 404);
  // The same successfully saved match can acknowledge a lost response without another external lookup.
  if (!item.tmdb && item.updatedAt !== command.expectedUpdatedAt) conflict();
  return item;
}
/** Recheck both fences after external reads, including unsuccessful lookups. */
export async function confirmDoubanTMDBItem(db: DoubanDatabase, userId: string, old: DoubanLibraryRecord, expectedDataEpoch: number): Promise<DoubanLibraryRecord> {
  await readDoubanMetadataEpoch(db, userId, expectedDataEpoch);
  const item = await readDoubanLibraryRecord(db, userId, old);
  await readDoubanMetadataEpoch(db, userId, expectedDataEpoch);
  if (!item || item.updatedAt !== old.updatedAt || item.details?.imdbId !== old.details?.imdbId) conflict();
  return item;
}
/** Automatic matches update their own column only; source images and personal edits keep their ownership. */
export async function saveDoubanTMDBCover(db: DoubanDatabase, userId: string, old: DoubanLibraryRecord, rawCover: TMDBCover,
  expectedDataEpoch: number, now = new Date().toISOString()): Promise<{ item: DoubanLibraryRecord; changed: boolean }> {
  const cover = parseTMDBCover(rawCover);
  if (!cover || old.domain !== 'screen' || cover.imdbId !== old.details?.imdbId
    || old.kind === 'movie' && cover.mediaType !== 'movie' || old.kind === 'series' && cover.mediaType !== 'tv'
    || !timestamp(now)) throw new DoubanStoreError('TMDB 匹配与当前作品不一致。', 'INVALID_DOUBAN_INPUT', 400);
  await readDoubanMetadataEpoch(db, userId, expectedDataEpoch);
  if (old.tmdb && old.tmdbCoverUrl === tmdbCoverUrl(old.tmdb)) return { item: await confirmDoubanTMDBItem(db, userId, old, expectedDataEpoch), changed: false };
  const updatedAt = new Date(Math.max(Date.parse(now), Date.parse(old.updatedAt) + 1)).toISOString();
  const row = await db.prepare(`UPDATE douban_items SET tmdb_cover_json=?,tmdb_cover_url=?,updated_at=?,observed_at=MAX(observed_at,?)
    WHERE user_id=? AND profile_id=? AND domain='screen' AND subject_id=? AND updated_at=?
    AND json_extract(details_json,'$.imdbId')=?
    AND COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=?
    RETURNING subject_id AS subjectId`).bind(serializeTMDBCover(cover), tmdbCoverUrl(cover), updatedAt, updatedAt, userId, old.profileId, old.subjectId, old.updatedAt, cover.imdbId, userId, expectedDataEpoch)
    .first<{ subjectId: string }>();
  await readDoubanMetadataEpoch(db, userId, expectedDataEpoch);
  const item = await readDoubanLibraryRecord(db, userId, old);
  await readDoubanMetadataEpoch(db, userId, expectedDataEpoch);
  if (!item?.tmdb || item.details?.imdbId !== cover.imdbId || item.tmdbCoverUrl !== tmdbCoverUrl(item.tmdb)) conflict();
  // A concurrent identical lookup may have completed first; only an active current match is idempotent.
  if (!row) return { item, changed: false };
  return { item, changed: true };
}
