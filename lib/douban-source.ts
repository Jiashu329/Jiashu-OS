import { fetchDoubanSubjectMetadata } from './douban-metadata.ts';
import { DOMParser } from 'linkedom/worker';
import { DOUBAN_HOSTS, doubanSubjectUrl, normalizeDoubanCover, parseDoubanProfile, parseDoubanRecord, validDoubanDay } from './douban.ts';
import type { DoubanDomain, DoubanRecordInput } from './douban.ts';

export type DoubanSourceErrorCode = 'DOUBAN_SOURCE_BLOCKED' | 'DOUBAN_SOURCE_LOGIN_REQUIRED' | 'DOUBAN_SOURCE_CHALLENGE'
  | 'DOUBAN_SOURCE_RATE_LIMITED' | 'DOUBAN_SOURCE_TIMEOUT' | 'DOUBAN_SOURCE_NETWORK' | 'DOUBAN_SOURCE_INVALID'
  | 'DOUBAN_SOURCE_TOO_LARGE' | 'DOUBAN_SOURCE_REDIRECT' | 'DOUBAN_SOURCE_HTTP_ERROR';
const MESSAGES: Record<DoubanSourceErrorCode, string> = {
  DOUBAN_SOURCE_BLOCKED: '豆瓣暂不允许读取这个公开页面，请稍后重试或导入自己的记录。',
  DOUBAN_SOURCE_LOGIN_REQUIRED: '豆瓣要求登录，本站不能读取这部分记录。',
  DOUBAN_SOURCE_CHALLENGE: '豆瓣要求安全验证，本次读取已停止。',
  DOUBAN_SOURCE_RATE_LIMITED: '豆瓣暂时限制请求频率，请稍后再试。',
  DOUBAN_SOURCE_TIMEOUT: '读取豆瓣页面超时，请稍后重试。',
  DOUBAN_SOURCE_NETWORK: '暂时无法连接豆瓣，请稍后重试。',
  DOUBAN_SOURCE_INVALID: '未能确认豆瓣页面结构，原有记录已保留。',
  DOUBAN_SOURCE_TOO_LARGE: '豆瓣页面超过本次读取大小上限。',
  DOUBAN_SOURCE_REDIRECT: '豆瓣页面发生跳转，本次读取已停止。',
  DOUBAN_SOURCE_HTTP_ERROR: '豆瓣页面暂时无法读取，请稍后重试。',
};
export class DoubanSourceError extends Error {
  readonly code: DoubanSourceErrorCode;
  readonly status: number;
  readonly upstreamStatus?: number;
  constructor(code: DoubanSourceErrorCode, message = MESSAGES[code], status = code === 'DOUBAN_SOURCE_TIMEOUT' ? 504 : code === 'DOUBAN_SOURCE_RATE_LIMITED' ? 429 : 502, upstreamStatus?: number) {
    super(message); this.name = 'DoubanSourceError'; this.code = code; this.status = status;
    if (Number.isInteger(upstreamStatus) && upstreamStatus! >= 100 && upstreamStatus! <= 599) this.upstreamStatus = upstreamStatus;
  }
}
export interface DoubanFetchOptions { fetch?: typeof fetch }
export interface DoubanCollectionPage { items: DoubanRecordInput[]; nextStart: number | null; total: number | null }
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const MAX_START = 100000;
function invalid(): never { throw new DoubanSourceError('DOUBAN_SOURCE_INVALID'); }
function cancel(response: Response) { void response.body?.cancel().catch(() => {}); }
async function read(url: string, xml: boolean, options: DoubanFetchOptions): Promise<string> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DoubanSourceError('DOUBAN_SOURCE_TIMEOUT')); }, TIMEOUT_MS); });
  const execute = async () => {
    const response = await (options.fetch ?? fetch)(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
      headers: { Accept: xml ? 'application/rss+xml, application/xml, text/xml' : 'text/html, application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    if (response.status >= 300 && response.status < 400 || response.redirected) {
      const target = response.headers.get('location') ?? response.url;
      cancel(response);
      let host = ''; try { host = new URL(target, url).hostname; } catch { /* reject below */ }
      throw new DoubanSourceError(host === 'sec.douban.com' ? 'DOUBAN_SOURCE_CHALLENGE' : host === 'accounts.douban.com' ? 'DOUBAN_SOURCE_LOGIN_REQUIRED' : 'DOUBAN_SOURCE_REDIRECT');
    }
    if (!response.ok) {
      cancel(response);
      const code = response.status === 429 ? 'DOUBAN_SOURCE_RATE_LIMITED' : [403, 418, 451].includes(response.status) ? 'DOUBAN_SOURCE_BLOCKED' : response.status === 401 ? 'DOUBAN_SOURCE_LOGIN_REQUIRED' : 'DOUBAN_SOURCE_HTTP_ERROR';
      throw new DoubanSourceError(code, undefined, undefined, response.status);
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!type || !(xml ? ['text/xml', 'application/xml', 'application/rss+xml'] : ['text/html', 'application/xhtml+xml']).includes(type)) { cancel(response); return invalid(); }
    const size = response.headers.get('content-length');
    if (size && /^\d+$/.test(size) && Number(size) > MAX_BYTES) { cancel(response); throw new DoubanSourceError('DOUBAN_SOURCE_TOO_LARGE'); }
    if (!response.body) return invalid();
    const reader = response.body.getReader(); const abortReader = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', abortReader, { once: true }); const decoder = new TextDecoder('utf-8', { fatal: true }); let count = 0, result = '';
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; count += chunk.value.byteLength;
        if (count > MAX_BYTES) { void reader.cancel().catch(() => {}); throw new DoubanSourceError('DOUBAN_SOURCE_TOO_LARGE'); }
        try { result += decoder.decode(chunk.value, { stream: true }); } catch { return invalid(); }
      }
      try { result += decoder.decode(); } catch { return invalid(); }
      if (!result.trim()) return invalid();
      return result;
    } finally { controller.signal.removeEventListener('abort', abortReader); reader.releaseLock(); }
  };
  try { return await Promise.race([execute(), deadline]); }
  catch (error) { if (error instanceof DoubanSourceError) throw error; throw new DoubanSourceError(controller.signal.aborted ? 'DOUBAN_SOURCE_TIMEOUT' : 'DOUBAN_SOURCE_NETWORK'); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
function documentFrom(raw: string, xml = false) {
  if (/<!ENTITY\b/i.test(raw) || (xml ? /<!DOCTYPE\b/i.test(raw) : /<!DOCTYPE(?!\s+html\s*>)/i.test(raw))) return invalid();
  let tokens = 0; const token = /</g; while (token.exec(raw)) if (++tokens > 30000) return invalid();
  let doc: ReturnType<DOMParser['parseFromString']>;
  try { doc = new DOMParser().parseFromString(raw, xml ? 'text/xml' : 'text/html'); } catch { return invalid(); }
  const title = doc.querySelector('title')?.textContent?.trim() ?? '';
  if (/禁止访问|访问受限/.test(title)) throw new DoubanSourceError('DOUBAN_SOURCE_BLOCKED');
  if (/登录跳转|^豆瓣\s*[-–—]?\s*登录$/.test(title)) throw new DoubanSourceError('DOUBAN_SOURCE_LOGIN_REQUIRED');
  if (/安全验证|人机验证/.test(title) || /^豆瓣$/.test(title) && /sec\.douban\.com|captcha|验证码|异常请求|机器人/i.test(raw)) throw new DoubanSourceError('DOUBAN_SOURCE_CHALLENGE');
  return doc;
}
function canonicalSubject(raw: string | null, expected?: DoubanDomain) {
  if (!raw || raw.length > 2048) return null;
  let url: URL; try { url = new URL(raw); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash) return null;
  const domain = (Object.keys(DOUBAN_HOSTS) as DoubanDomain[]).find(key => DOUBAN_HOSTS[key] === url.hostname);
  const id = /^\/subject\/([1-9]\d{0,15})\/?$/.exec(url.pathname)?.[1];
  if (!domain || !id || expected && domain !== expected) return null;
  return { domain, subjectId: id, url: doubanSubjectUrl(domain, id) };
}
function compact(raw: string | null | undefined) { return (raw ?? '').replace(/\s+/g, ' ').trim(); }
function safeCover(raw: string | null) { try { return normalizeDoubanCover(raw); } catch { return null; } }
function dto(raw: DoubanRecordInput): DoubanRecordInput { try { return parseDoubanRecord(raw); } catch { return invalid(); } }
function ratingFrom(raw: string | null | undefined): DoubanRecordInput['rating'] {
  const value = /^\s*rating([1-5])-t\s*$/.exec(raw ?? '')?.[1];
  return value ? Number(value) as DoubanRecordInput['rating'] : null;
}

function collectionUrl(profileId: string, domain: DoubanDomain, start: number) {
  const profile = parseDoubanProfile(profileId);
  if (!Object.hasOwn(DOUBAN_HOSTS, domain) || !Number.isSafeInteger(start) || start < 0 || start > MAX_START) return invalid();
  return 'https://' + DOUBAN_HOSTS[domain] + '/people/' + profile.profileId + '/collect?' + new URLSearchParams({ start: String(start), sort: 'time', rating: 'all', filter: 'all', mode: 'grid' });
}
/** One bounded, anonymous public-page request; absence never means deletion. */
export async function fetchDoubanCollection(profileId: string, domain: DoubanDomain, start: number, options: DoubanFetchOptions = {}): Promise<DoubanCollectionPage> {
  const url = collectionUrl(profileId, domain, start);
  return parseDoubanCollectionHtml(await read(url, false, options), profileId, domain, start);
}
/** Pure saved-page parser. Import callers must label returned items as source=import. */
export function parseDoubanCollectionHtml(raw: string, profileId: string, domain: DoubanDomain, start = 0): DoubanCollectionPage {
  const url = collectionUrl(profileId, domain, start);
  if (typeof raw !== 'string' || raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new DoubanSourceError('DOUBAN_SOURCE_TOO_LARGE');
  const doc = documentFrom(raw);
  const heading = compact(doc.querySelector('h1')?.textContent) || compact(doc.querySelector('title')?.textContent);
  const expected = domain === 'screen' ? /看过的(?:电影|电视剧|影视)/ : domain === 'book' ? /读过的书/ : /听过的音乐/;
  if (!expected.test(heading)) return invalid();
  const counter = compact(doc.querySelector('.subject-num')?.textContent);
  const totalText = /\/\s*(\d+)/.exec(counter)?.[1] ?? /[（(]\s*(\d+)\s*[)）]/.exec(heading)?.[1];
  const total = totalText === undefined ? null : Number(totalText);
  if (total === null || !Number.isSafeInteger(total) || total < 0 || total > MAX_START) return invalid();
  const rows = [...doc.querySelectorAll('.item-show, .grid-view > .item')];
  if (rows.length > 30 || rows.length === 0 && total !== 0 || total === 0 && (rows.length > 0 || start !== 0)) return invalid();
  const items = rows.map(row => {
    const anchor = row.querySelector('.title > a, li.title > a, .info .title a');
    const subject = canonicalSubject(anchor?.getAttribute('href') ?? null, domain);
    const title = compact(anchor?.querySelector('em')?.textContent || anchor?.textContent);
    if (!subject || !title) return invalid();
    const dateText = compact(row.querySelector('div.date, span.date, .date')?.textContent);
    const date = /\b\d{4}-\d{2}-\d{2}\b/.exec(dateText)?.[0] ?? null;
    if (date && !validDoubanDay(date)) return invalid();
    const rate = [...row.querySelectorAll('[class]')].map(node => ratingFrom(node.getAttribute('class'))).find(value => value !== null) ?? null;
    return dto({ ...subject, kind: domain, title, coverUrl: safeCover(row.querySelector('img')?.getAttribute('src') ?? null), rating: rate,
      markedDate: date, comment: compact(row.querySelector('.comment')?.textContent) || null, publishedAt: null, source: 'collection' });
  });
  if (new Set(items.map(item => item.subjectId)).size !== items.length || items.length > total || start + items.length > total) return invalid();
  let nextStart: number | null = null;
  const next = doc.querySelector('.paginator .next a, .paginator a[rel="next"], a[rel="next"]');
  if (next) {
    let target: URL; try { target = new URL(next.getAttribute('href') ?? '', url); } catch { return invalid(); }
    // Only extract a bounded offset; the next call reconstructs its own fixed-host URL.
    if (target.protocol !== 'https:' || target.hostname !== DOUBAN_HOSTS[domain] || target.username || target.password || target.port
      || !/^\/people\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/collect\/?$/.test(target.pathname) || target.hash) return invalid();
    const value = target.searchParams.get('start');
    if (!value || !/^\d+$/.test(value)) return invalid();
    nextStart = Number(value);
    if (!Number.isSafeInteger(nextStart) || nextStart <= start || nextStart > MAX_START || nextStart !== start + items.length || nextStart >= total) return invalid();
  }
  if ((start + items.length < total) !== (nextStart !== null)) return invalid();
  return { items, nextStart, total };
}

/** RSS is a finite recent-activity window, not a historical collection export. */
export async function fetchDoubanRSS(profileId: string, options: DoubanFetchOptions = {}): Promise<DoubanRecordInput[]> {
  const profile = parseDoubanProfile(profileId);
  const xml = await read('https://www.douban.com/feed/people/' + profile.profileId + '/interests', true, options);
  if (!/<\/channel\s*>\s*<\/rss\s*>\s*$/i.test(xml)) return invalid();
  const doc = documentFrom(xml, true);
  const channel = doc.querySelector('rss > channel');
  if (!channel || !/收藏/.test(channel.querySelector('title')?.textContent ?? '')) return invalid();
  const channelLink = channel.querySelector('link')?.textContent?.trim();
  if (!channelLink) return invalid();
  try { parseDoubanProfile(channelLink); } catch { return invalid(); }
  const rows = [...channel.querySelectorAll('item')];
  if (rows.length > 100) return invalid();
  const items: DoubanRecordInput[] = [];
  for (const row of rows) {
    const label = row.querySelector('title')?.textContent?.trim() ?? '';
    if (!label) return invalid();
    const status = /^(看过|读过|听过)([\s\S]+)$/.exec(label);
    if (!status) continue;
    const subject = canonicalSubject(row.querySelector('link')?.textContent?.trim() ?? null);
    if (!subject || status[1] !== ({ screen: '看过', book: '读过', music: '听过' } as const)[subject.domain]) return invalid();
    const description = documentFrom('<html><body>' + (row.querySelector('description')?.textContent ?? '') + '</body></html>');
    const paragraphs = [...description.querySelectorAll('p')].map(node => compact(node.textContent));
    const recommendation = paragraphs.find(text => /^推荐\s*[:：]/.test(text))?.replace(/^推荐\s*[:：]\s*/, '') ?? '';
    const rating = ({ 很差: 1, 较差: 2, 还行: 3, 推荐: 4, 力荐: 5 } as Record<string, number>)[recommendation] ?? null;
    const comment = paragraphs.find(text => /^备注\s*[:：]/.test(text))?.replace(/^备注\s*[:：]\s*/, '') || null;
    const published = row.querySelector('pubDate')?.textContent?.trim();
    if (published && !Number.isFinite(Date.parse(published))) return invalid();
    items.push(dto({ ...subject, title: status[2].trim(), kind: subject.domain,
      coverUrl: safeCover(description.querySelector('img')?.getAttribute('src') ?? null), rating: rating as DoubanRecordInput['rating'],
      markedDate: null, publishedAt: published ? new Date(published).toISOString() : null, comment, source: 'rss' }));
  }
  if (new Set(items.map(item => item.domain + ':' + item.subjectId)).size !== items.length) return invalid();
  return items;
}

/** A separate optional request; generic Movie JSON-LD cannot overrule TV evidence. */
export async function fetchDoubanSubjectKind(subjectId: string, options: DoubanFetchOptions = {}): Promise<'movie' | 'series' | null> {
  const metadata = await fetchDoubanSubjectMetadata('screen', subjectId, options);
  return metadata.kind === 'movie' || metadata.kind === 'series' ? metadata.kind : null;
}

export { read as readDoubanSource, documentFrom as parseDoubanSourceDocument };
