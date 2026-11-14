import type { DoubanDomain, DoubanRecordInput } from './douban.ts';
import type { DoubanSubjectDetails } from './douban-details.ts';
import { createDoubanSubjectDetailsExtractor } from './douban-details-parser.ts';

export interface DoubanBrowserCollectionPage {
  items: DoubanRecordInput[];
  nextStart: number | null;
  total: number;
  /** Null means the current navigation did not prove the signed-in account. */
  accountProfileId: string | null;
}
export interface DoubanBrowserSubjectMetadata { kind: 'movie' | 'series' | 'book' | 'music' | null; coverUrl: string | null; details?: DoubanSubjectDetails }
/** Fixed diagnostic labels only; never include page text, addresses or user data. */
export type DoubanBrowserCollectorReason = 'input' | 'document' | 'structure_limit' | 'account_navigation' | 'account_mismatch'
  | 'collection_identity' | 'heading' | 'total' | 'rows' | 'item_url' | 'item_title' | 'item_comment' | 'item_rating'
  | 'item_date' | 'duplicate_items' | 'item_range' | 'pagination_query' | 'pagination_offset' | 'pagination_incomplete'
  | 'subject_identity' | 'subject_structure';
type ParserDocument = Pick<DocumentFragment, 'querySelector' | 'querySelectorAll'>;

/**
 * The renderer embeds this closure and its shared detail extractor in a static
 * extension content script. Both read only whitelisted fields, never fetch, and
 * never attach parsed markup to a live document.
 */
export function createDoubanBrowserCollector(parseHTML?: (html: string) => ParserDocument, detailsExtractor = createDoubanSubjectDetailsExtractor()) {
  const limits = { htmlBytes: 2 * 1024 * 1024, pageItems: 30, total: 100000, tokens: 30000 };
  const hosts: Record<string, string> = { screen: 'movie.douban.com', book: 'book.douban.com', music: 'music.douban.com' };
  const messages: Record<string, string> = {
    INVALID: '未能确认豆瓣页面或分页结构，本次读取已停止。',
    TOO_LARGE: '豆瓣页面超过本次读取大小上限。',
    LOGIN_REQUIRED: '豆瓣要求登录，请在豆瓣完成登录后重试。',
    CHALLENGE: '豆瓣要求安全验证，本次读取已停止。',
    BLOCKED: '豆瓣暂时限制读取，本次读取已停止。',
    PROFILE_MISMATCH: '豆瓣页面或当前登录账户与所选主页不一致，请核对后重试。',
  };
  function fail(code = 'INVALID', reason?: DoubanBrowserCollectorReason): never {
    const error = new Error(messages[code] ?? messages.INVALID) as Error & { code: string; reason?: DoubanBrowserCollectorReason };
    error.name = 'DoubanBrowserCollectorError'; error.code = 'DOUBAN_BROWSER_' + code;
    if (reason) error.reason = reason;
    throw error;
  }
  function compact(value: string | null | undefined) { return (value ?? '').replace(/\s+/g, ' ').trim(); }
  function controls(value: string, includeSpace = false): boolean {
    for (const char of value) { const code = char.charCodeAt(0); if (code <= 31 || code >= 127 && code <= 159 || includeSpace && code === 32) return true; }
    return false;
  }
  function clean(value: string, maximum: number, reason: 'item_title' | 'item_comment'): string {
    if (!value || value.length > maximum || controls(value)) fail('INVALID', reason);
    return value;
  }
  function context(profileId: string, domain: DoubanDomain, start: number) {
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileId)
      || !Object.hasOwn(hosts, domain) || !Number.isSafeInteger(start) || start < 0 || start > limits.total) fail('INVALID', 'input');
    return 'https://' + hosts[domain] + '/people/' + profileId + '/collect';
  }
  function safeURL(raw: unknown, base?: string): URL | null {
    if (typeof raw !== 'string' || !raw || raw.length > 2048 || /[%\\]/.test(raw) || controls(raw, true)) return null;
    let url: URL; try { url = new URL(raw, base); } catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    return url;
  }
  function collectionLocation(raw: unknown, domain: DoubanDomain, profileId: string, base: string): URL {
    const url = safeURL(raw, base), path = '/people/' + profileId + '/collect';
    if (!url || url.protocol !== 'https:' || url.hostname !== hosts[domain] || ![path, path + '/'].includes(url.pathname) || url.hash) fail('PROFILE_MISMATCH', 'collection_identity');
    const allowed: Record<string, RegExp> = { start: /^(0|[1-9]\d*)$/, sort: /^time$/, rating: /^all$/, type: /^all$/, filter: /^all$/, mode: /^(?:grid|list)$/ };
    for (const [key, value] of url.searchParams) if (!Object.hasOwn(allowed, key) || url.searchParams.getAll(key).length !== 1 || !allowed[key].test(value)) fail('INVALID', 'pagination_query');
    return url;
  }
  function documentFrom(html: string): ParserDocument {
    if (typeof html !== 'string' || html.length > limits.htmlBytes || new TextEncoder().encode(html).byteLength > limits.htmlBytes) fail('TOO_LARGE');
    if (!html.trim() || /<!ENTITY\b/i.test(html) || /<!DOCTYPE(?!\s+html\s*>)/i.test(html)) fail('INVALID', 'document');
    let tokens = 0; const expression = /</g; while (expression.exec(html)) if (++tokens > limits.tokens) fail('INVALID', 'structure_limit');
    let doc: ParserDocument;
    try {
      if (parseHTML) doc = parseHTML(html);
      else { const template = document.createElement('template'); template.innerHTML = html; doc = template.content; }
    } catch { return fail('INVALID', 'document'); }
    const title = compact(doc.querySelector('title')?.textContent);
    if (/禁止访问|访问受限|访问被拒绝|403 Forbidden/i.test(title)) fail('BLOCKED');
    if (/登录跳转|^豆瓣\s*[-–—]?\s*登[录陆]$/.test(title) || doc.querySelector('form[action*="accounts.douban.com"] input[type="password"], #login-form input[type="password"]')) fail('LOGIN_REQUIRED');
    if (/安全验证|人机验证|验证码|异常请求/.test(title) || /^豆瓣$/.test(title) && /sec\.douban\.com|captcha|验证码|异常请求|机器人/i.test(html)) fail('CHALLENGE');
    return doc;
  }
  function account(doc: ParserDocument, expected: string): string | null {
    const links = doc.querySelectorAll('#db-global-nav .nav-user-account a[href], #db-global-nav .top-nav-info a[href], .global-nav .nav-user-account a[href]');
    let found: string | null = null;
    for (const link of links) {
      if (!/^(?:个人主页|我的主页|my (?:profile|home))$/i.test(compact(link.textContent))) continue;
      const raw = link.getAttribute('href');
      if (typeof raw !== 'string' || !raw || raw.length > 2048 || /\\/.test(raw) || controls(raw, true)) fail('INVALID', 'account_navigation');
      let url: URL; try { url = new URL(raw, 'https://www.douban.com/'); } catch { return fail('INVALID', 'account_navigation'); }
      if (url.protocol !== 'https:' || !/^(?:www\.)?douban\.com$/.test(url.hostname) || url.username || url.password || url.port) fail('INVALID', 'account_navigation');
      // Douban's signed-in global navigation uses /mine/, a redirect without an
      // account ID. Its presence cannot prove which person is signed in. Query
      // and fragment tracking on this local-only link do not change that fact.
      if (/^\/mine\/?$/.test(url.pathname)) continue;
      const match = /^\/people\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/.exec(url.pathname);
      if (!match) fail('INVALID', 'account_navigation');
      if (match[1] !== expected || found && found !== match[1]) fail('PROFILE_MISMATCH', 'account_mismatch');
      if (url.search || url.hash) fail('INVALID', 'account_navigation');
      found = match[1];
    }
    return found;
  }
  function subjectURL(raw: unknown, domain: DoubanDomain, base?: string) {
    const url = safeURL(raw, base);
    const subjectId = url && /^\/subject\/([1-9]\d{0,15})\/?$/.exec(url.pathname)?.[1];
    if (!url || !subjectId || url.hostname !== hosts[domain] || url.search || url.hash) return null;
    return { subjectId, url: 'https://' + hosts[domain] + '/subject/' + subjectId + '/' };
  }
  function cover(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const url = safeURL(raw.startsWith('//') ? 'https:' + raw : raw);
    if (!url || !/^img\d{1,2}\.doubanio\.com$/.test(url.hostname) || url.search || url.hash
      || !/^\/(?:view\/[A-Za-z0-9_./-]+|[sl]pic\/[A-Za-z0-9_.-]+)\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname)) return null;
    url.protocol = 'https:'; return url.href;
  }
  function images(scope: ParserDocument | Element, selector: string): string | null {
    for (const image of scope.querySelectorAll(selector)) {
      const candidates: Array<string | null> = ['data-original', 'data-src', 'data-lazy-src', 'data-lazyload', 'data-url'].map(key => image.getAttribute(key));
      for (const key of ['data-srcset', 'srcset']) {
        const raw = image.getAttribute(key);
        if (raw && raw.length <= 8192) for (const part of raw.split(',').slice(0, 10)) candidates.push(part.trim().replace(/\s+\d+(?:\.\d+)?[wx]\s*$/i, ''));
      }
      candidates.push(image.getAttribute('src'));
      for (const candidate of candidates) { const value = cover(candidate); if (value) return value; }
    }
    return null;
  }
  function day(raw: string): string | null {
    const value = /\b\d{4}-\d{2}-\d{2}\b/.exec(raw)?.[0] ?? null;
    if (value && (value < '1970-01-01' || value > '2100-12-31' || !Number.isFinite(Date.parse(value + 'T12:00:00Z')) || new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) !== value)) fail('INVALID', 'item_date');
    return value;
  }
  function parseCollection(html: string, profileId: string, domain: DoubanDomain, start = 0): DoubanBrowserCollectionPage {
    const base = context(profileId, domain, start), doc = documentFrom(html), accountProfileId = account(doc, profileId);
    for (const node of doc.querySelectorAll('link[rel="canonical"], meta[property="og:url"]')) {
      collectionLocation(node.getAttribute(node.nodeName.toLowerCase() === 'meta' ? 'content' : 'href'), domain, profileId, base);
    }
    const heading = compact(doc.querySelector('h1')?.textContent) || compact(doc.querySelector('title')?.textContent);
    const completed = domain === 'screen' ? /看过的(?:电影|电视剧|影视)/ : domain === 'book' ? /读过的书/ : /听过的音乐/;
    if (!completed.test(heading)) fail('INVALID', 'heading');
    const counter = compact(doc.querySelector('.subject-num')?.textContent);
    const totalText = /\/\s*(\d+)/.exec(counter)?.[1] ?? /[（(]\s*(\d+)\s*[)）]/.exec(heading)?.[1];
    const total = totalText === undefined ? null : Number(totalText);
    if (total === null || !Number.isSafeInteger(total) || total < 0 || total > limits.total) fail('INVALID', 'total');
    const rows = [...doc.querySelectorAll('.item-show, .grid-view > .item, .interest-list > .subject-item')];
    if (rows.length > limits.pageItems || !rows.length && (total !== 0 || start !== 0) || total === 0 && rows.length > 0) fail('INVALID', 'rows');
    const items: DoubanRecordInput[] = rows.map(row => {
      const anchor = row.querySelector('.title > a, li.title > a, .info .title a, .info h2 > a');
      const subject = subjectURL(anchor?.getAttribute('href'), domain);
      if (!subject) return fail('INVALID', 'item_url');
      const title = clean(compact(anchor?.querySelector('em')?.textContent || anchor?.textContent), 500, 'item_title');
      const stars = [...row.querySelectorAll('[class]')].map(node => /^\s*rating([1-5])-t\s*$/.exec(node.getAttribute('class') ?? '')?.[1]).filter(Boolean);
      if (new Set(stars).size > 1) fail('INVALID', 'item_rating');
      const comment = compact(row.querySelector('.comment')?.textContent);
      return { domain, ...subject, title, kind: domain, coverUrl: images(row, '.pic img, img'), rating: stars.length ? Number(stars[0]) as DoubanRecordInput['rating'] : null,
        markedDate: day(compact(row.querySelector('div.date, span.date, .date')?.textContent)), comment: comment ? clean(comment, 2000, 'item_comment') : null, publishedAt: null, source: 'import' };
    });
    if (new Set(items.map(item => item.subjectId)).size !== items.length) fail('INVALID', 'duplicate_items');
    if (items.length > total || start + items.length > total) fail('INVALID', 'item_range');
    const nextLinks = [...doc.querySelectorAll('.paginator .next a, .paginator a[rel="next"], a[rel="next"]')];
    let nextStart: number | null = null;
    for (const next of nextLinks) {
      const target = collectionLocation(next.getAttribute('href'), domain, profileId, base), value = target.searchParams.get('start');
      if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) fail('INVALID', 'pagination_offset');
      const offset = Number(value);
      if (!Number.isSafeInteger(offset) || offset <= start || offset > limits.total || offset !== start + items.length || offset >= total || nextStart !== null && nextStart !== offset) fail('INVALID', 'pagination_offset');
      nextStart = offset;
    }
    if ((start + items.length < total) !== (nextStart !== null)) fail('INVALID', 'pagination_incomplete');
    return { items, nextStart, total, accountProfileId };
  }
  function parseSubject(html: string, domain: DoubanDomain, subjectId: string): DoubanBrowserSubjectMetadata {
    context('subject', domain, 0);
    if (typeof subjectId !== 'string' || !/^[1-9]\d{0,15}$/.test(subjectId)) fail('INVALID', 'input');
    const base = 'https://' + hosts[domain] + '/subject/' + subjectId + '/', doc = documentFrom(html);
    let canonical = false;
    for (const node of doc.querySelectorAll('link[rel="canonical"], meta[property="og:url"]')) {
      const found = subjectURL(node.getAttribute(node.nodeName.toLowerCase() === 'meta' ? 'content' : 'href'), domain, base);
      if (!found || found.subjectId !== subjectId) fail('INVALID', 'subject_identity');
      canonical = true;
    }
    const types = new Set<string>(), structuredImages: unknown[] = [], structuredObjects: Record<string, unknown>[] = [];
    let bound = false;
    const supported = ['Movie', 'TVSeries', 'TVSeason', 'TVEpisode', 'Book', 'MusicAlbum', 'MusicRecording', 'MusicRelease'];
    for (const script of doc.querySelectorAll('script[type]')) {
      if ((script.getAttribute('type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/ld+json' || (script.textContent?.length ?? 0) > 256 * 1024) continue;
      let json: unknown; try { json = JSON.parse(script.textContent ?? ''); } catch { continue; }
      let visited = 0;
      function visit(value: unknown, depth: number, root: boolean): void {
        if (!value || typeof value !== 'object' || depth > 5 || ++visited > 300) return;
        if (Array.isArray(value)) { if (value.length <= 100) for (const child of value) visit(child, depth + 1, false); return; }
        const object = value as Record<string, unknown>;
        const names = (Array.isArray(object['@type']) ? object['@type'] : [object['@type']]).filter((name): name is string => typeof name === 'string').map(name => name.replace(/^https?:\/\/schema\.org\//i, ''));
        const references = [object.url, object['@id'], typeof object.mainEntityOfPage === 'object' && object.mainEntityOfPage !== null
          ? (object.mainEntityOfPage as Record<string, unknown>)['@id'] : object.mainEntityOfPage].filter((url): url is string => typeof url === 'string');
        const ids = references.map(raw => { const url = safeURL(raw, base); if (url) url.hash = ''; return url ? subjectURL(url.href, domain)?.subjectId ?? null : null; });
        const hasOwnReference = ids.includes(subjectId), foreignReference = ids.some(value => value !== null && value !== subjectId);
        const own = !foreignReference && (hasOwnReference || root && !references.length && canonical && names.some(name => supported.includes(name)));
        if (own) { bound = true; structuredObjects.push(object); for (const name of names) types.add(name); structuredImages.push(object.image, object.thumbnailUrl); }
        if (object['@graph']) visit(object['@graph'], depth + 1, false);
        if (object.mainEntity) visit(object.mainEntity, depth + 1, canonical && !foreignReference && (hasOwnReference || root && !references.length));
      }
      visit(json, 0, !Array.isArray(json));
    }
    if (!canonical && !bound) fail('INVALID', 'subject_identity');
    if (!compact(doc.querySelector('h1')?.textContent) && !doc.querySelector('#info, #mainpic') && ![...types].some(value => supported.includes(value))) fail('INVALID', 'subject_structure');
    const fields = [...doc.querySelectorAll('#info .pl')].map(label => {
      const text = compact(label.textContent), match = /^([^:：]{1,20})\s*[:：]\s*(.*)$/.exec(text), values = [match?.[2] ?? ''];
      let sibling = label.nextSibling;
      for (let count = 0; sibling && count < 6; count++, sibling = sibling.nextSibling) {
        if (sibling.nodeName.toUpperCase() === 'BR' || sibling.nodeType === 1 && /(?:^|\s)pl(?:\s|$)/.test((sibling as Element).getAttribute('class') ?? '')) break;
        values.push(sibling.textContent ?? '');
      }
      return { name: (match?.[1] ?? text).trim(), value: compact(values.join(' ')).slice(0, 250) };
    });
    const count = (name: string) => fields.some(field => field.name === name && /^[1-9]\d{0,3}(?!\d)/.test(field.value));
    const duration = (name: string) => fields.some(field => field.name === name && /^[1-9]\d{0,2}\s*(?:分钟|min(?:ute)?s?)(?:\s|$|[/（(])/i.test(field.value));
    const ogTypes = [...doc.querySelectorAll('meta[property="og:type"]')].map(node => (node.getAttribute('content') ?? '').trim().toLowerCase());
    const explicitTV = ['TVSeries', 'TVSeason', 'TVEpisode'].some(name => types.has(name)) || ogTypes.some(name => ['video.tv_show', 'video.tv_series', 'video.episode', 'tv_show', 'tvseries'].includes(name));
    const episodes = count('集数') || count('季数') || duration('单集片长');
    const tvHint = explicitTV || episodes || fields.some(field => ['集数', '季数', '单集片长', '首播'].includes(field.name));
    let kind: DoubanBrowserSubjectMetadata['kind'] = domain === 'screen' ? null : domain;
    if (domain === 'screen') {
      if (explicitTV || episodes) kind = 'series';
      else if (!tvHint && (duration('片长') || fields.some(field => field.name === '上映日期' && /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/.test(field.value))) && (types.has('Movie') || ogTypes.includes('video.movie'))) kind = 'movie';
    }
    function imageValues(value: unknown, depth = 0): string[] {
      if (!value || depth > 3) return [];
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) return value.length <= 20 ? value.flatMap(child => imageValues(child, depth + 1)) : [];
      if (typeof value === 'object') { const object = value as Record<string, unknown>; return [...imageValues(object.url, depth + 1), ...imageValues(object.contentUrl, depth + 1)]; }
      return [];
    }
    const covers = [...doc.querySelectorAll('meta[property="og:image:secure_url"], meta[property="og:image"]')].map(node => node.getAttribute('content'));
    covers.push(...structuredImages.flatMap(value => imageValues(value)));
    let coverUrl = covers.map(cover).find((value): value is string => value !== null) ?? images(doc, '#mainpic img, img[rel="v:image"], .subject .pic img, .subjectwrap .pic img');
    if (!coverUrl) for (const anchor of doc.querySelectorAll('#mainpic a.nbg[href]')) { coverUrl = cover(anchor.getAttribute('href')); if (coverUrl) break; }
    const details = detailsExtractor.extract(doc, domain, subjectId, structuredObjects);
    return { kind, coverUrl, ...(Object.keys(details).length ? { details } : {}) };
  }
  return { parseCollection, parseSubject, limits };
}

/** A function expression, not an eval or a remote script loader. */
export function renderDoubanBrowserCollectorFactory(): string {
  return '(function(parseHTML){const createDoubanSubjectDetailsExtractor=' + createDoubanSubjectDetailsExtractor.toString()
    + ';return (' + createDoubanBrowserCollector.toString() + ')(parseHTML,createDoubanSubjectDetailsExtractor());})';
}
