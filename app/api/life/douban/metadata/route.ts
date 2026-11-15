import { readDoubanMetadataEpoch, readDoubanMetadataRecord, readSatisfiedDoubanMetadataCheck, readSatisfiedDoubanSubjectMetadata, saveDoubanSubjectMetadata } from '../../../../../db/douban-metadata-store';
import { DoubanStoreError } from '../../../../../db/douban-store';
import { doubanSubjectUrl, normalizeDoubanCover, parseDoubanProfile, type DoubanDomain } from '../../../../../lib/douban';
import { parseDoubanDetails } from '../../../../../lib/douban-details';
import { fetchDoubanSubjectMetadata, type DoubanSubjectMetadata } from '../../../../../lib/douban-metadata';
import { DoubanSourceError } from '../../../../../lib/douban-source';
import { DoubanSyncError } from '../../../../../lib/douban-sync';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard } from '../_shared';

export const dynamic = 'force-dynamic';
const UNAVAILABLE = '暂时无法从豆瓣补全这条记录，已有作品详情、封面、分类和个人资料均已保留。';
function command(raw: unknown, browser: boolean) {
  const required = ['profileId', 'domain', 'subjectId', 'expectedUpdatedAt', 'confirmed', ...(browser ? ['expectedDataEpoch', 'metadata'] : [])];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(field => !required.includes(field) && !(field === 'expectedDataEpoch' && !browser) && field !== 'expectedDetailsCheckedAt')
    || required.some(field => !Object.hasOwn(raw, field))) throw new DoubanSyncError('请从收藏中选择需要补全的记录，并确认读取作品详情。');
  const body = raw as Record<string, unknown>;
  if (body.confirmed !== true || typeof body.profileId !== 'string' || parseDoubanProfile(body.profileId).profileId !== body.profileId
    || typeof body.domain !== 'string' || !['screen', 'book', 'music'].includes(body.domain) || typeof body.subjectId !== 'string'
    || typeof body.expectedUpdatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.expectedUpdatedAt)
    || !Number.isFinite(Date.parse(body.expectedUpdatedAt)) || new Date(body.expectedUpdatedAt).toISOString() !== body.expectedUpdatedAt
    || Object.hasOwn(body, 'expectedDetailsCheckedAt') && body.expectedDetailsCheckedAt !== null && (typeof body.expectedDetailsCheckedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.expectedDetailsCheckedAt) || !Number.isFinite(Date.parse(body.expectedDetailsCheckedAt)) || new Date(body.expectedDetailsCheckedAt).toISOString() !== body.expectedDetailsCheckedAt)
    || Object.hasOwn(body, 'expectedDataEpoch') && (!Number.isSafeInteger(body.expectedDataEpoch) || Number(body.expectedDataEpoch) < 0)) {
    throw new DoubanSyncError('请核对条目信息、资料版本，并确认读取作品详情。');
  }
  const value = { profileId: body.profileId, domain: body.domain as DoubanDomain, subjectId: body.subjectId, expectedUpdatedAt: body.expectedUpdatedAt,
    ...(Object.hasOwn(body, 'expectedDataEpoch') ? { expectedDataEpoch: body.expectedDataEpoch as number } : {}),
    ...(Object.hasOwn(body, 'expectedDetailsCheckedAt') ? { expectedDetailsCheckedAt: body.expectedDetailsCheckedAt as string | null } : {}) };
  doubanSubjectUrl(value.domain, value.subjectId);
  return { value, metadata: body.metadata };
}
function browserMetadata(raw: unknown, domain: DoubanDomain): DoubanSubjectMetadata {
  const fields = ['kind', 'coverUrl', 'details'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(field => !fields.includes(field)) || fields.some(field => !Object.hasOwn(raw, field))) throw new DoubanSyncError('浏览器作品详情字段不正确。');
  const value = raw as Record<string, unknown>;
  if (value.kind !== null && (typeof value.kind !== 'string' || !(domain === 'screen' ? ['movie', 'series'] : [domain]).includes(value.kind))
    || value.coverUrl !== null && typeof value.coverUrl !== 'string') throw new DoubanSyncError('浏览器作品详情分类或封面不正确。');
  let details;
  try { details = parseDoubanDetails(value.details); } catch { throw new DoubanSyncError('浏览器作品详情含有不支持或超出限制的字段。'); }
  return { kind: value.kind as DoubanSubjectMetadata['kind'], coverUrl: normalizeDoubanCover(value.coverUrl), ...(Object.keys(details).length ? { details } : {}) };
}

export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const { value } = command(await doubanBody(request), false), db = doubanDatabase();
    const dataEpoch = await readDoubanMetadataEpoch(db, user.userId, value.expectedDataEpoch), guarded = { ...value, expectedDataEpoch: dataEpoch };
    let old;
    try { old = await readDoubanMetadataRecord(db, user.userId, guarded); }
    catch (error) { if (!(error instanceof DoubanStoreError) || error.code !== 'DOUBAN_RECORD_CONFLICT' || !Object.hasOwn(guarded, 'expectedDetailsCheckedAt')) throw error; const result = await readSatisfiedDoubanMetadataCheck(db, user.userId, guarded); return json({ ...result, dataEpoch, metadata: { status: 'complete' } }); }
    if (Object.hasOwn(guarded, 'expectedDetailsCheckedAt') && old.sync.detailsCheckedAt !== guarded.expectedDetailsCheckedAt) { const result = await readSatisfiedDoubanMetadataCheck(db, user.userId, guarded); return json({ ...result, dataEpoch, metadata: { status: 'complete' } }); }
    let metadata;
    try { metadata = await fetchDoubanSubjectMetadata(value.domain, value.subjectId); }
    catch (error) {
      if (!(error instanceof DoubanSourceError)) throw error;
      if (error.code === 'DOUBAN_SOURCE_RATE_LIMITED') return json({ error: '豆瓣暂时限制请求频率，请稍后再补全。', code: 'DOUBAN_METADATA_RATE_LIMITED' }, 429, { 'Retry-After': '60' });
      const current = await readDoubanMetadataRecord(db, user.userId, guarded);
      return json({ item: current, changed: false, dataEpoch, metadata: { status: 'unavailable', message: UNAVAILABLE } });
    }
    let result;
    try { result = await saveDoubanSubjectMetadata(db, user.userId, old, metadata, undefined, dataEpoch, guarded.expectedDetailsCheckedAt); }
    catch (error) { if (!(error instanceof DoubanStoreError) || error.code !== 'DOUBAN_RECORD_CONFLICT' || !Object.hasOwn(guarded, 'expectedDetailsCheckedAt')) throw error; result = await readSatisfiedDoubanMetadataCheck(db, user.userId, guarded); }
    const empty = metadata.kind === null && metadata.coverUrl === null && !Object.keys(metadata.details ?? {}).length;
    return json({ ...result, dataEpoch, metadata: empty ? { status: 'unavailable', message: UNAVAILABLE } : { status: 'complete' } });
  } catch (error) { return doubanError(error); }
}

/** Save only normalized metadata already read by the user's explicit local browser action. */
export async function PUT(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const parsed = command(await doubanBody(request, 4 * 1024 * 1024), true), metadata = browserMetadata(parsed.metadata, parsed.value.domain), db = doubanDatabase();
    const dataEpoch = await readDoubanMetadataEpoch(db, user.userId, parsed.value.expectedDataEpoch);
    let result;
    try {
      const old = await readDoubanMetadataRecord(db, user.userId, parsed.value);
      if (Object.hasOwn(parsed.value, 'expectedDetailsCheckedAt') && old.sync.detailsCheckedAt !== parsed.value.expectedDetailsCheckedAt) result = await readSatisfiedDoubanSubjectMetadata(db, user.userId, { ...parsed.value, expectedDataEpoch: dataEpoch }, metadata);
      else result = await saveDoubanSubjectMetadata(db, user.userId, old, metadata, undefined, dataEpoch, parsed.value.expectedDetailsCheckedAt);
    } catch (error) {
      if (!(error instanceof DoubanStoreError) || error.code !== 'DOUBAN_RECORD_CONFLICT') throw error;
      result = await readSatisfiedDoubanSubjectMetadata(db, user.userId, { ...parsed.value, expectedDataEpoch: dataEpoch }, metadata);
    }
    const empty = metadata.kind === null && metadata.coverUrl === null && !Object.keys(metadata.details ?? {}).length;
    return json({ ...result, dataEpoch, metadata: empty ? { status: 'unavailable', message: UNAVAILABLE } : { status: 'complete' } });
  } catch (error) {
    if (error instanceof RangeError) return json({ error: '作品详情不能超过 4 MiB，请精简后重试。', code: 'DOUBAN_METADATA_TOO_LARGE' }, 413);
    return doubanError(error);
  }
}
