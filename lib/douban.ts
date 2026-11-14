/** Data imported from a person's explicit completed collection; no login credentials. */
export const DOUBAN_DOMAINS = ['screen', 'book', 'music'] as const;
export type DoubanDomain = typeof DOUBAN_DOMAINS[number];
export type DoubanKind = 'screen' | 'movie' | 'series' | 'book' | 'music';
export interface DoubanRecordInput {
  domain: DoubanDomain;
  subjectId: string;
  title: string;
  url: string;
  kind: DoubanKind;
  coverUrl: string | null;
  rating: 1 | 2 | 3 | 4 | 5 | null;
  markedDate: string | null;
  comment: string | null;
  /** RSS publication timestamp, never substituted for a collection marking date. */
  publishedAt: string | null;
  source: 'collection' | 'rss' | 'import';
}
export class DoubanValidationError extends Error {
  readonly code = 'INVALID_DOUBAN_INPUT';
  readonly status = 400;
  constructor(message = '豆瓣资料格式不正确，请核对后重试。') { super(message); this.name = 'DoubanValidationError'; }
}
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SUBJECT_ID = /^[1-9]\d{0,15}$/;
export const DOUBAN_HOSTS: Record<DoubanDomain, string> = { screen: 'movie.douban.com', book: 'book.douban.com', music: 'music.douban.com' };
function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function text(value: unknown, maximum: number, multiline = false): value is string {
  return typeof value === 'string' && value.length <= maximum && Boolean(value.trim())
    && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value);
}
export function parseDoubanProfile(raw: unknown): { profileId: string; profileUrl: string } {
  if (!text(raw, 512)) throw new DoubanValidationError('请填写豆瓣个人主页链接或主页 ID。');
  const value = raw.trim();
  let profileId = value;
  if (!PROFILE_ID.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new DoubanValidationError('请填写 https://www.douban.com/people/你的ID/ 格式的主页链接。'); }
    const match = /^\/people\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || !['www.douban.com', 'douban.com'].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || !match
      || /[%\\?#]/.test(value) || /^https:\/\/[^/?#]*:/i.test(value) || /\/\.?\.(?:\/|$)/.test(value)) throw new DoubanValidationError('请使用不含额外参数的豆瓣个人主页链接。');
    profileId = match[1];
  }
  return { profileId, profileUrl: 'https://www.douban.com/people/' + profileId + '/' };
}
export function doubanSubjectUrl(domain: DoubanDomain, subjectId: string): string {
  if (!DOUBAN_DOMAINS.includes(domain) || !SUBJECT_ID.test(subjectId)) throw new DoubanValidationError('豆瓣条目标识不正确。');
  return 'https://' + DOUBAN_HOSTS[domain] + '/subject/' + subjectId + '/';
}
export function validDoubanDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '2100-12-31') return false;
  const parsed = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
export function normalizeDoubanCover(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 2048) throw new DoubanValidationError('豆瓣封面链接不正确。');
  let url: URL;
  try { url = new URL(raw); } catch { throw new DoubanValidationError('豆瓣封面链接不正确。'); }
  if (!['https:', 'http:'].includes(url.protocol) || !/^img\d{1,2}\.doubanio\.com$/.test(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash
    || !/^\/(?:view\/[A-Za-z0-9_./-]+|[sl]pic\/[A-Za-z0-9_.-]+)\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname)) throw new DoubanValidationError('请使用豆瓣官方封面链接。');
  url.protocol = 'https:';
  return url.href;
}
export function parseDoubanRecord(raw: unknown): DoubanRecordInput {
  const fields = ['domain', 'subjectId', 'title', 'url', 'kind', 'coverUrl', 'rating', 'markedDate', 'comment', 'publishedAt', 'source'];
  if (!plain(raw) || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !fields.includes(key))
    || fields.some(key => !Object.hasOwn(raw, key))) throw new DoubanValidationError('豆瓣条目需要完整且受支持的字段。');
  if (typeof raw.domain !== 'string' || !DOUBAN_DOMAINS.includes(raw.domain as DoubanDomain)) throw new DoubanValidationError('请选择影视、书籍或音乐分类。');
  const domain = raw.domain as DoubanDomain;
  if (typeof raw.subjectId !== 'string' || !SUBJECT_ID.test(raw.subjectId)) throw new DoubanValidationError('豆瓣条目标识不正确。');
  const url = doubanSubjectUrl(domain, raw.subjectId);
  if (raw.url !== url) throw new DoubanValidationError('豆瓣条目链接与标识不一致。');
  if (!text(raw.title, 500)) throw new DoubanValidationError('豆瓣条目名称需为 1–500 个字符。');
  if (domain === 'screen' ? !['screen', 'movie', 'series'].includes(String(raw.kind)) : raw.kind !== domain) throw new DoubanValidationError('条目类型与来源不一致。');
  if (raw.rating !== null && (typeof raw.rating !== 'number' || !Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5)) throw new DoubanValidationError('个人评分需为 1–5 星，未评分请留空。');
  if (raw.markedDate !== null && !validDoubanDay(raw.markedDate)) throw new DoubanValidationError('豆瓣标记日期不正确。');
  if (raw.comment !== null && (typeof raw.comment !== 'string' || raw.comment.length > 2000 || (raw.comment.trim() && !text(raw.comment, 2000, true)))) throw new DoubanValidationError('短评最多 2000 个字符。');
  let publishedAt: string | null = null;
  if (raw.publishedAt !== null) {
    if (typeof raw.publishedAt !== 'string' || raw.publishedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(raw.publishedAt)
      || !validDoubanDay(raw.publishedAt.slice(0, 10)) || !Number.isFinite(Date.parse(raw.publishedAt))) throw new DoubanValidationError('豆瓣发布时间不正确。');
    publishedAt = new Date(raw.publishedAt).toISOString();
    if (publishedAt < '1970-01-01' || publishedAt > '2100-12-31T23:59:59.999Z') throw new DoubanValidationError('豆瓣发布时间不正确。');
  }
  if (!['collection', 'rss', 'import'].includes(String(raw.source))) throw new DoubanValidationError('豆瓣条目来源不正确。');
  if (raw.source === 'rss' && raw.markedDate !== null) throw new DoubanValidationError('RSS 发布时间不能代替标记日期。');
  return { domain, subjectId: raw.subjectId, title: raw.title.trim(), url, kind: raw.kind as DoubanKind,
    coverUrl: normalizeDoubanCover(raw.coverUrl), rating: raw.rating as DoubanRecordInput['rating'], markedDate: raw.markedDate as string | null,
    comment: typeof raw.comment === 'string' && raw.comment.trim() ? raw.comment.trim() : null, publishedAt, source: raw.source as DoubanRecordInput['source'] };
}
