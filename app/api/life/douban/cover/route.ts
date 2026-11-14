import { readDoubanRecord } from '../../../../../db/douban-store';
import { DOUBAN_DOMAINS, doubanSubjectUrl, parseDoubanProfile, type DoubanDomain } from '../../../../../lib/douban';
import { DoubanCoverError, fetchDoubanCover } from '../../../../../lib/douban-cover';
import { apiUser, invalidOrigin, json, unauthenticated } from '../../../_shared';
import { doubanDatabase, doubanError } from '../_shared';

export const dynamic = 'force-dynamic';
const coverHeaders = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
};

/** Authenticated image reads resolve a saved owner-scoped key, never a supplied remote URL. */
export async function GET(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const url = new URL(request.url), origin = request.headers.get('origin'), fetchSite = request.headers.get('sec-fetch-site');
  if (origin && origin !== url.origin || fetchSite && !['same-origin', 'none'].includes(fetchSite)) return invalidOrigin();
  try {
    const params = url.searchParams;
    if ([...params.keys()].some(key => !['profileId', 'domain', 'subjectId'].includes(key))
      || ['profileId', 'domain', 'subjectId'].some(key => params.getAll(key).length !== 1)) {
      return json({ error: '封面条目标识不正确。', code: 'INVALID_DOUBAN_COVER_KEY' }, 400, coverHeaders);
    }
    const profileId = parseDoubanProfile(params.get('profileId')).profileId, domain = params.get('domain'), subjectId = params.get('subjectId')!;
    if (typeof domain !== 'string' || !DOUBAN_DOMAINS.includes(domain as DoubanDomain)) return json({ error: '封面条目标识不正确。', code: 'INVALID_DOUBAN_COVER_KEY' }, 400, coverHeaders);
    doubanSubjectUrl(domain as DoubanDomain, subjectId);
    const record = await readDoubanRecord(doubanDatabase(), user.userId, { profileId, domain: domain as DoubanDomain, subjectId });
    if (!record?.coverUrl) return json({ error: '此条目尚无可用封面。', code: 'DOUBAN_COVER_NOT_FOUND' }, 404, coverHeaders);
    const cover = await fetchDoubanCover(record.coverUrl, { signal: request.signal });
    return new Response(cover.bytes, { status: 200, headers: { ...coverHeaders, 'Content-Type': cover.contentType, 'Content-Length': String(cover.bytes.byteLength) } });
  } catch (error) {
    if (error instanceof DoubanCoverError) return json({ error: error.message, code: error.code }, error.status, coverHeaders);
    return doubanError(error);
  }
}
