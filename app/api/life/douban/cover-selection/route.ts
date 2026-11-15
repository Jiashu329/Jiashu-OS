import { writeUserCover, type UserCoverCommand } from '../../../../../db/douban-cover-selection-store';
import { UserCoverError } from '../../../../../lib/douban-cover-selection';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';

export const dynamic = 'force-dynamic';

/** User-selected links are owner-scoped data, never a destination for server-side image fetching. */
export async function PUT(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const raw = await doubanBody(request, 12 * 1024);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UserCoverError('请从当前作品详情填写封面链接。');
    const body = raw as Record<string, unknown>, fields = ['profileId', 'domain', 'subjectId', 'expectedDataEpoch', 'expectedLocalRevision', 'mode'];
    if (body.mode === 'url') fields.push('url');
    if (typeof body.mode !== 'string' || !['original', 'url'].includes(body.mode) || Object.keys(body).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(body, key))) {
      throw new UserCoverError('仅支持填写图片链接或恢复原封面。');
    }
    const item = await writeUserCover(doubanDatabase(), user.userId, body as unknown as UserCoverCommand);
    return json({ item, dataEpoch: body.expectedDataEpoch });
  } catch (error) {
    if (error instanceof UserCoverError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof RangeError) return json({ error: '封面填写不能超过 12 KiB。', code: 'USER_COVER_REQUEST_TOO_LARGE' }, 413);
    return doubanError(error);
  }
}
