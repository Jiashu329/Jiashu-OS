import { normalizeUserCoverUrl, UserCoverError } from '../lib/douban-cover-selection.ts';
import { doubanSubjectUrl, parseDoubanProfile } from '../lib/douban.ts';
import { DoubanStoreError, readDoubanDataEpoch, type DoubanDatabase, type DoubanRecordKey } from './douban-store.ts';
import { readDoubanLibraryRecord, type DoubanLibraryRecord } from './douban-library-store.ts';

export interface UserCoverCommand extends DoubanRecordKey {
  expectedDataEpoch: number; expectedLocalRevision: number; mode: 'original' | 'url'; url?: string;
}
function conflict(): never { throw new DoubanStoreError('这部作品的个人整理已变化，请重新打开详情核对后再保存封面。', 'DOUBAN_RECORD_CONFLICT'); }
async function verifyEpoch(db: DoubanDatabase, userId: string, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new UserCoverError('请先读取当前书影音资料版本。');
  if (await readDoubanDataEpoch(db, userId) !== expected) throw new DoubanStoreError('书影音资料已清空或重置，请重新读取后选择封面。', 'DOUBAN_DATA_EPOCH_CONFLICT');
}
function equivalent(item: DoubanLibraryRecord, selected: string | null) { return (item.cover.mode === 'url' ? item.cover.url : null) === selected; }
/** Local cover edits share the notes/tags revision fence and never change imported cover metadata. */
export async function writeUserCover(db: DoubanDatabase, userId: string, command: UserCoverCommand): Promise<DoubanLibraryRecord> {
  if (typeof command.profileId !== 'string' || parseDoubanProfile(command.profileId).profileId !== command.profileId) throw new UserCoverError('请从当前收藏选择作品。');
  doubanSubjectUrl(command.domain, command.subjectId);
  if (!Number.isSafeInteger(command.expectedLocalRevision) || command.expectedLocalRevision < 0 || command.expectedLocalRevision >= Number.MAX_SAFE_INTEGER) throw new UserCoverError('请重新读取作品的个人整理版本。');
  const selected = command.mode === 'url' ? normalizeUserCoverUrl(command.url) : command.mode === 'original' ? null : (() => { throw new UserCoverError('请选择填写图片链接或恢复原封面。'); })();
  await verifyEpoch(db, userId, command.expectedDataEpoch);
  const current = await readDoubanLibraryRecord(db, userId, command);
  if (!current) throw new DoubanStoreError('这部作品已不存在，请重新读取收藏。', 'DOUBAN_ITEM_NOT_FOUND', 404);
  if (equivalent(current, selected)) { await verifyEpoch(db, userId, command.expectedDataEpoch); return current; }
  if (current.local.revision !== command.expectedLocalRevision) conflict();
  const result = await db.prepare(`UPDATE douban_items SET local_cover_url=?,local_revision=local_revision+1
    WHERE user_id=? AND profile_id=? AND domain=? AND subject_id=? AND local_revision=?
    AND COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=? RETURNING local_revision AS revision`)
    .bind(selected, userId, command.profileId, command.domain, command.subjectId, command.expectedLocalRevision, userId, command.expectedDataEpoch).first<{ revision: number }>();
  await verifyEpoch(db, userId, command.expectedDataEpoch);
  if (!result) {
    const latest = await readDoubanLibraryRecord(db, userId, command);
    if (latest && equivalent(latest, selected)) return latest;
    conflict();
  }
  const item = await readDoubanLibraryRecord(db, userId, command); if (!item || !equivalent(item, selected)) conflict();
  return item;
}
