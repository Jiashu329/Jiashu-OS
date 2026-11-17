import { DOMParser } from 'linkedom/worker';
import { parseDoubanRecord, type DoubanDomain, type DoubanRecordInput } from './douban.ts';
import { createDoubanDetailsParser, renderDoubanDetailsParserFactory } from './douban-details.ts';

export const DOUBAN_IMPORT_LIMITS = { bytes: 8 * 1024 * 1024, files: 100, records: 500, htmlBytes: 2 * 1024 * 1024 } as const;
export interface DoubanImportFile { name: string; text: string; domain?: DoubanDomain; start?: number }
export interface DoubanImportOptions { profileId: string; confirmCompleted?: boolean }
export interface DoubanImportPreview {
  items: DoubanRecordInput[]; warnings: string[]; skipped: number; duplicates: number; sourceFiles: number;
}
export class DoubanImportError extends Error {
  readonly code = 'INVALID_DOUBAN_IMPORT';
  readonly status = 400;
  constructor(message: string) { super(message); this.name = 'DoubanImportError'; }
}

/**
 * All browser logic lives inside this factory, so production minification keeps
 * its serialized closure self-contained. It never fetches, evaluates YAML or
 * inserts the parsed HTML into a live document. Browser callers inject an inert
 * template-content adapter; native DOMParser's image-loading behaviour is not used.
 */
export function createDoubanImportParser(Parser: typeof globalThis.DOMParser, detailsParser: ReturnType<typeof createDoubanDetailsParser>) {
  const limits = { bytes: 8 * 1024 * 1024, files: 100, records: 500, htmlBytes: 2 * 1024 * 1024 };
  const hosts: Record<string, string> = { screen: 'movie.douban.com', book: 'book.douban.com', music: 'music.douban.com' };
  const credentials = /^(?:cookie|cookies|password|passwd|authorization|token|session|accesstoken|refreshtoken|authtoken|sessiontoken|dbcl2|apikey|secret)$/i;
  const keyName = (key: string) => key.replace(/[\s_-]/g, '').toLowerCase();
  const byteSize = (text: string) => new TextEncoder().encode(text).byteLength;
  function fail(message: string): never {
    const error = new Error(message) as Error & { code: string; status: number };
    error.name = 'DoubanImportError'; error.code = 'INVALID_DOUBAN_IMPORT'; error.status = 400; throw error;
  }
  function plain(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  }
  function secretKeys(raw: unknown, depth = 0): void {
    if (depth > 12) fail('导入资料嵌套过深。');
    if (!raw || typeof raw !== 'object') return;
    if (Array.isArray(raw)) { for (const item of raw) secretKeys(item, depth + 1); return; }
    if (!plain(raw)) fail('导入资料结构不受支持。');
    for (const [key, value] of Object.entries(raw)) {
      if (credentials.test(keyName(key)) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        fail('导入文件含有登录凭据字段，请移除密码、Cookie 或令牌后再导入。');
      }
      secretKeys(value, depth + 1);
    }
  }
  function missing(raw: unknown): boolean {
    return raw === null || raw === undefined || raw === '' || typeof raw === 'string'
      && (!raw.trim() || /^(?:null|~|\{\{[^{}]+\}\})$/i.test(raw.trim()));
  }
  function control(value: string, multiline = false): boolean {
    for (const char of value) { const code = char.charCodeAt(0); if (code < 32 && !(multiline && [9, 10, 13].includes(code)) || code >= 127 && code <= 159) return true; }
    return false;
  }
  function string(raw: unknown, maximum: number, label: string, nullable = false, multiline = false): string | null {
    if (nullable && missing(raw)) return null;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > maximum
      || control(raw, multiline)) fail(label + '格式不正确。');
    return raw.trim();
  }
  function profile(raw: unknown): string {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)) fail('请先确认本次资料对应的豆瓣主页 ID。');
    return raw;
  }
  function get(raw: Record<string, unknown>, aliases: string[]): unknown {
    const matches = Object.keys(raw).filter(key => aliases.map(keyName).includes(keyName(key)));
    if (matches.length > 1) {
      const nonempty = matches.filter(key => !missing(raw[key]));
      if (new Set(nonempty.map(key => JSON.stringify(raw[key]))).size > 1) fail('同一条目含有相互冲突的同义字段。');
      return nonempty.length ? raw[nonempty[0]] : raw[matches[0]];
    }
    return matches.length ? raw[matches[0]] : undefined;
  }
  function typeOf(raw: unknown): 'screen' | 'movie' | 'series' | 'book' | 'music' | null {
    if (missing(raw)) return null;
    if (typeof raw !== 'string') fail('条目类型需为文字。');
    const value = raw.trim().toLowerCase();
    const names: Record<string, 'screen' | 'movie' | 'series' | 'book' | 'music'> = {
      screen: 'screen', 影视: 'screen', '待分类影视': 'screen', movie: 'movie', film: 'movie', 电影: 'movie',
      series: 'series', tv: 'series', tvseries: 'series', teleplay: 'series', 电视剧: 'series', 剧集: 'series',
      book: 'book', books: 'book', 书: 'book', 书籍: 'book', 图书: 'book',
      music: 'music', album: 'music', 音乐: 'music', 专辑: 'music',
    };
    return names[value] ?? fail('条目类型不受支持，请使用电影、电视剧、影视、书籍或音乐。');
  }
  function subject(rawUrl: unknown, rawId: unknown, kind: ReturnType<typeof typeOf>) {
    let domain: string | null = null, id: string | null = null;
    if (!missing(rawUrl)) {
      const value = string(rawUrl, 2048, '豆瓣条目链接')!;
      let url: URL; try { url = new URL(value); } catch { return fail('请提供豆瓣条目的完整链接。'); }
      domain = Object.keys(hosts).find(key => hosts[key] === url.hostname) ?? null;
      id = /^\/subject\/([1-9]\d{0,15})\/?$/.exec(url.pathname)?.[1] ?? null;
      if (!domain || !id || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash
        || /[%\\]/.test(value) || /^https?:\/\/[^/?#]*:/i.test(value)) fail('仅支持不含额外参数的豆瓣电影、书籍或音乐条目链接。');
    }
    if (!missing(rawId)) {
      const explicit = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
      if (typeof explicit !== 'string' || !/^[1-9]\d{0,15}$/.test(explicit)) fail('豆瓣条目 ID 不正确。');
      if (id && id !== explicit) fail('豆瓣条目 ID 与链接不一致。');
      id = explicit;
    }
    const kindDomain = kind === 'movie' || kind === 'series' || kind === 'screen' ? 'screen' : kind;
    if (domain && kindDomain && domain !== kindDomain) fail('条目类型与豆瓣链接不一致。');
    domain = domain ?? kindDomain;
    if (!domain || !id) fail('每条记录都需要豆瓣条目链接，或条目 ID 与明确类型。');
    return { domain: domain as DoubanDomain, subjectId: id, url: 'https://' + hosts[domain] + '/subject/' + id + '/', kind: (kind ?? domain) as DoubanRecordInput['kind'] };
  }
  function cover(raw: unknown, strict = true): string | null {
    if (missing(raw)) return null;
    try {
      const value = string(raw, 2048, '封面链接')!;
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !/^img\d{1,2}\.doubanio\.com$/.test(url.hostname)
        || url.username || url.password || url.port || url.search || url.hash
        || !/^\/(?:view\/[A-Za-z0-9_./-]+|[sl]pic\/[A-Za-z0-9_.-]+)\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname)) fail('封面必须使用豆瓣官方图片链接。');
      url.protocol = 'https:'; return url.href;
    } catch (error) { if (strict) throw error; return null; }
  }
  function day(raw: unknown): string | null {
    if (missing(raw)) return null;
    const value = string(raw, 40, '豆瓣标记日期')!;
    const match = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
    if (!match) fail('豆瓣标记日期需为 YYYY-MM-DD 格式，不能用出版日期代替。');
    const date = match[1], time = Date.parse(date + 'T12:00:00Z');
    if (date < '1970-01-01' || date > '2100-12-31' || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) fail('豆瓣标记日期不是有效日期。');
    return date;
  }
  function completed(raw: unknown, domain: DoubanDomain, confirmed: boolean): boolean {
    if (missing(raw)) return confirmed;
    if (typeof raw !== 'string') fail('收藏状态需为文字。');
    const value = raw.trim().toLowerCase();
    if (['collect', 'collected', 'completed', 'complete', 'done', '完成', '已完成'].includes(value)) return true;
    if ((domain === 'screen' ? ['看过', '已看', 'watched'] : domain === 'book' ? ['读过', '已读', 'read'] : ['听过', '已听', 'listened']).includes(value)) return true;
    return false;
  }
  function rating(raw: unknown): DoubanRecordInput['rating'] {
    if (missing(raw)) return null;
    const numeric = typeof raw === 'string' && /^[1-5](?:\.0)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 1 || numeric > 5) fail('个人评分需为 1–5 星；未评分请留空，不能填写豆瓣站点评分。');
    return numeric as DoubanRecordInput['rating'];
  }
  function detailList(raw: unknown): unknown {
    if (missing(raw) || Array.isArray(raw) || typeof raw !== 'string') return raw;
    const value = raw.trim();
    if (value.startsWith('[')) {
      try { return JSON.parse(value); } catch { /* A bounded, flat YAML list is also safe text. */ }
      if (!value.endsWith(']') || ['[', ']', '{', '}', '"', "'", '!', '&', '*'].some(char => value.slice(1, -1).includes(char))) fail('作品详情的列表格式不正确。');
      return value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean);
    }
    return value.split(/\s+\/\s+|、/).map(item => item.trim()).filter(Boolean);
  }
  function detailNumber(raw: unknown): unknown {
    if (missing(raw)) return undefined;
    return typeof raw === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  }
  function details(raw: Record<string, unknown>, domain: DoubanDomain) {
    try {
      if (Object.hasOwn(raw, 'details')) {
        let value = raw.details;
        if (typeof value === 'string' && value.trim()) { try { value = JSON.parse(value); } catch { fail('作品详情 details 需要一个 JSON 字段对象。'); } }
        return detailsParser.parse(value);
      }
      const mapped: Record<string, unknown> = {};
      const set = (key: string, aliases: string[], mode: 'list' | 'number' | 'text' = 'text') => {
        const rawValue = get(raw, aliases); if (missing(rawValue)) return;
        mapped[key] = mode === 'list' ? detailList(rawValue) : mode === 'number' ? detailNumber(rawValue) : rawValue;
      };
      set('summary', ['summary', 'desc', '简介']);
      const alternate = ['alternateTitles', 'originalTitle', 'aliases'].flatMap(key => {
        const value = get(raw, [key]); return missing(value) ? [] : [detailList(value)];
      });
      if (alternate.length) mapped.alternateTitles = alternate.flat();
      for (const [key, aliases] of [['genres', ['genres', 'genre', '类型标签']], ['countries', ['countries', 'country', '国家']], ['languages', ['languages', 'language', '语言']]] as const) set(key, [...aliases], 'list');
      set('year', ['year', '年份'], 'number'); set('doubanRating', ['doubanRating', 'doubanScore', 'score', '豆瓣评分'], 'number'); set('ratingCount', ['ratingCount', '评分人数'], 'number');
      if (domain === 'screen') {
        set('imdbId', ['imdbId', 'imdbID', 'IMDb']);
        set('directors', ['directors', 'director', '导演'], 'list'); set('writers', ['writers', 'author', '编剧'], 'list'); set('cast', ['cast', 'actor', 'actors', '主演', '演员'], 'list');
        set('releaseDates', ['releaseDates', 'datePublished', '上映日期'], 'list'); set('duration', ['duration', 'time', '片长']);
        set('episodes', ['episodes', 'episode', '集数'], 'number'); set('seasons', ['seasons', '季数'], 'number'); set('episodeDuration', ['episodeDuration', '单集片长']);
      } else if (domain === 'book') {
        set('authors', ['authors', 'author', '作者'], 'list'); set('translators', ['translators', 'translator', '译者'], 'list'); set('publisher', ['publisher', '出版社']);
        set('publicationDate', ['publicationDate', 'datePublished', '出版日期']); set('isbn', ['isbn', 'ISBN']); set('binding', ['binding', '装帧']); set('price', ['price', '定价']);
        set('seriesTitle', ['seriesTitle', 'series', '丛书']); set('pages', ['pages', 'totalPage', '页数'], 'number');
      } else {
        set('artists', ['artists', 'artist', 'actor', '表演者'], 'list'); set('albumType', ['albumType', '专辑类型']); set('medium', ['medium', '介质']);
        set('label', ['label', 'publisher', '唱片公司']); set('releaseDate', ['releaseDate', 'datePublished', '发行日期']); set('tracks', ['tracks', '曲目'], 'list');
      }
      return detailsParser.parse(mapped);
    } catch (error) {
      if (error instanceof Error && error.name === 'DoubanImportError') throw error;
      return fail('作品详情格式不正确，请核对受支持字段、文字长度与豆瓣站点评分。');
    }
  }
  function record(raw: unknown, options: DoubanImportOptions, canonical: boolean, warn: (text: string) => void): DoubanRecordInput | null {
    if (!plain(raw)) fail('每条导入记录需要一个字段对象。');
    secretKeys(raw);
    const claimedProfile = get(raw, ['profileId', 'sourceProfile']);
    if (!missing(claimedProfile) && claimedProfile !== options.profileId) fail('文件中的来源主页与本次选择的主页不一致。');
    const kind = typeOf(get(raw, ['kind', 'type', '类型', '分类']));
    const found = subject(get(raw, ['url', 'subjectUrl', '豆瓣链接', '条目链接']), get(raw, ['subjectId', 'doubanId', '条目ID']), kind);
    const rawDomain = get(raw, ['domain']);
    if (!missing(rawDomain) && rawDomain !== found.domain) fail('条目来源分类与链接不一致。');
    const state = get(raw, ['state', 'status', 'myState', 'collectionStatus', '状态', '收藏状态']);
    if (!completed(state, found.domain, options.confirmCompleted === true)) {
      warn(missing(state) ? '未注明完成状态的条目已跳过；只有确认这些条目均已完成后才会导入。' : '想看、在看、想读、在读及其他非完成状态已跳过。');
      return null;
    }
    if (missing(state)) warn('部分条目未注明状态，已按你本次“这些条目均已完成”的确认导入。');
    const personal = get(raw, ['myRating', 'personalRating', 'userRating', '个人评分', ...(canonical ? ['rating'] : [])]);
    if (!canonical && Object.keys(raw).some(key => ['rating', 'score', 'doubanrating', '豆瓣评分'].includes(keyName(key)))) warn('rating、score 等站点评分字段未作为个人评分；请使用 myRating 或“个人评分”。');
    const subjectDetails = details(raw, found.domain);
    return { ...found, ...(Object.keys(subjectDetails).length ? { details: subjectDetails } : {}), title: string(get(raw, ['title', 'name', '名称', '标题']), 500, '条目名称')!,
      coverUrl: cover(get(raw, ['coverUrl', 'image', 'cover', '封面'])),
      rating: rating(personal), markedDate: day(get(raw, ['markedDate', 'myCollectionDate', 'collectionDate', '标记日期'])),
      comment: string(get(raw, ['myComment', 'comment', '个人短评', '短评']), 2000, '个人短评', true, true),
      publishedAt: null, source: 'import' };
  }
  function csv(text: string): Record<string, unknown>[] {
    const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, endedQuote = false;
    const pushCell = () => { if (cell.length > 10000 || row.length >= 100) fail('CSV 字段过长或列数过多。'); row.push(cell); cell = ''; endedQuote = false; };
    const pushRow = () => { pushCell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > 501) fail('一次最多预览 500 条记录。'); };
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"') { if (text[index + 1] === '"') { cell += '"'; index++; } else { quoted = false; endedQuote = true; } }
        else cell += char;
      } else if (char === '"') {
        if (cell || endedQuote) fail('CSV 引号格式不正确。'); quoted = true;
      } else if (char === ',') pushCell();
      else if (char === '\n' || char === '\r') { if (char === '\r' && text[index + 1] === '\n') index++; pushRow(); }
      else { if (endedQuote) fail('CSV 引号结束后只能是分隔符。'); cell += char; }
      if (cell.length > 10000) fail('CSV 字段过长。');
    }
    if (quoted) fail('CSV 有未结束的引号。');
    if (cell || row.length || endedQuote) pushRow();
    if (!rows.length) fail('CSV 没有表头。');
    const header = rows.shift()!.map(value => value.trim());
    if (header.some(value => !value || value.length > 100) || new Set(header.map(keyName)).size !== header.length) fail('CSV 表头为空、重复或过长。');
    for (const key of header) if (credentials.test(keyName(key)) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('CSV 含有登录凭据字段，请先移除。');
    return rows.map(values => {
      if (values.length !== header.length) fail('CSV 各行列数必须与表头一致。');
      return Object.fromEntries(header.map((key, index) => [key, values[index]]));
    });
  }
  function scalar(raw: string): unknown {
    const value = raw.trim();
    if (!value || value === '~' || /^null$/i.test(value)) return null;
    if (value.startsWith('"')) { try { const decoded = JSON.parse(value); if (typeof decoded !== 'string') fail('Markdown 字段需要简单文字。'); return decoded; } catch { return fail('Markdown 双引号字段格式不正确。'); } }
    if (value.startsWith("'")) { if (!/^'(?:[^']|'')*'$/.test(value)) fail('Markdown 单引号字段格式不正确。'); return value.slice(1, -1).replace(/''/g, "'"); }
    if (/^(?:!!|!<|&|\*)/.test(value)) fail('不支持 YAML 标签、锚点或引用。');
    return value;
  }
  function markdown(text: string): Record<string, unknown> {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines[0].trim() !== '---') fail('Markdown 需要 Obsidian 豆瓣笔记的 YAML 顶部字段。');
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 1 || end > 300) fail('Markdown 顶部字段缺少结束标记或过长。');
    const result: Record<string, unknown> = Object.create(null);
    for (let index = 1; index < end; index++) {
      const line = lines[index]; if (!line.trim() || /^\s*#/.test(line)) continue;
      const match = /^([^\s:#][^:]{0,99}):(?:\s*(.*))?$/.exec(line);
      if (!match) { if (/^\s/.test(line)) continue; fail('Markdown 顶部字段仅支持简单键值。'); }
      const key = match[1].trim(), value = match[2] ?? '';
      if (Object.hasOwn(result, key)) fail('Markdown 顶部字段重复。');
      if (credentials.test(keyName(key)) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('Markdown 含有登录凭据字段，请先移除。');
      if (/^[|>][-+]?$/.test(value.trim())) {
        const block: string[] = []; while (index + 1 < end && (/^\s/.test(lines[index + 1]) || !lines[index + 1])) block.push(lines[++index]);
        const indent = Math.min(...block.filter(value => value.trim()).map(value => /^\s*/.exec(value)![0].length), 100);
        result[key] = block.map(value => value.slice(indent)).join(value.trim().startsWith('>') ? ' ' : '\n');
      } else result[key] = scalar(value);
    }
    const body = lines.slice(end + 1).join('\n');
    if (missing(get(result, ['coverUrl', 'image', 'cover', '封面']))) {
      const image = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^) \n]+))\s*\)/.exec(body);
      if (image) result.image = image[1] ?? image[2];
    }
    if (missing(get(result, ['myComment', 'comment', '个人短评', '短评']))) {
      const match = /(?:^|\n)Comment:\s*\n(?:---\s*\n)?([\s\S]*?)(?=\n---(?:\n|$)|\nMenu:\s*(?:\n|$)|$)/i.exec(body);
      if (match) result.myComment = match[1].trim();
    }
    return result;
  }
  function html(text: string, file: DoubanImportFile, options: DoubanImportOptions): DoubanRecordInput[] {
    if (byteSize(text) > limits.htmlBytes || /<!ENTITY\b/i.test(text) || /<!DOCTYPE(?!\s+html\s*>)/i.test(text)) fail('HTML 页面过大或包含不受支持的文档声明。');
    if ((text.match(/</g)?.length ?? 0) > 30000) fail('HTML 页面结构过大。');
    const doc = new Parser().parseFromString(text, 'text/html');
    const heading = (doc.querySelector('h1')?.textContent || doc.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
    if (/禁止访问|安全验证|登录跳转|人机验证/.test(heading)) fail('这份 HTML 是登录或验证页面，不是本人收藏导出。');
    const inferred: DoubanDomain | null = /看过的(?:电影|电视剧|影视)/.test(heading) ? 'screen' : /读过的书/.test(heading) ? 'book' : /听过的音乐/.test(heading) ? 'music' : null;
    if (!inferred || file.domain && file.domain !== inferred) fail('请保存“看过／读过／听过”的收藏列表网页，不能导入想看、在看或条目详情页。');
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || doc.querySelector('meta[property="og:url"]')?.getAttribute('content');
    if (canonical) {
      let url: URL; try { url = new URL(canonical); } catch { return fail('保存网页的来源链接不正确。'); }
      const match = /^\/people\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/collect\/?$/.exec(url.pathname);
      if (url.hostname !== hosts[inferred] || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !match || match[1] !== options.profileId) fail('保存网页的来源主页与本次导入选择不一致。');
    }
    const rows = [...doc.querySelectorAll('.item-show, .grid-view > .item, .interest-list > .subject-item')];
    if (rows.length > 30) fail('HTML 每页最多支持 30 条收藏，请分页面保存。');
    if (!rows.length) {
      const count = /[（(]\s*(\d+)\s*[)）]/.exec(heading)?.[1] ?? /\/\s*(\d+)/.exec(doc.querySelector('.subject-num')?.textContent ?? '')?.[1];
      if (count !== '0') fail('未能在 HTML 中确认收藏条目，未导入任何记录。');
      return [];
    }
    return rows.map(row => {
      const anchor = row.querySelector('.title > a, li.title > a, .info .title a, .info h2 > a');
      const found = subject(anchor?.getAttribute('href'), null, inferred);
      const title = anchor?.querySelector('em')?.textContent || anchor?.textContent;
      const marked = /\b\d{4}-\d{2}-\d{2}\b/.exec(row.querySelector('.date')?.textContent ?? '')?.[0];
      const star = [...row.querySelectorAll('[class]')].map(node => /(?:^|\s)rating([1-5])-t(?:\s|$)/.exec(node.getAttribute('class') ?? '')?.[1]).find(Boolean);
      const mapped: Record<string, unknown> = {};
      const property = (selector: string) => [...row.querySelectorAll(selector)].map(node => (node.getAttribute('content') ?? node.textContent ?? '').trim()).filter(Boolean);
      const add = (key: string, selector: string, list = false) => { const values = property(selector); if (values.length) mapped[key] = list ? values : values[0]; };
      add('summary', '[property="v:summary"], [itemprop="description"]'); add('doubanRating', '[property="v:average"], [itemprop="ratingValue"]'); add('ratingCount', '[property="v:votes"], [itemprop="ratingCount"]');
      if (inferred === 'screen') { add('directors', '[rel="v:directedBy"], [itemprop="director"]', true); add('cast', '[rel="v:starring"], [itemprop="actor"]', true); }
      if (inferred === 'book') { add('authors', '[itemprop="author"]', true); add('publisher', '[itemprop="publisher"]'); add('isbn', '[itemprop="isbn"]'); }
      if (inferred === 'music') add('artists', '[itemprop="byArtist"]', true);
      const subjectDetails = details(mapped, inferred);
      return { ...found, ...(Object.keys(subjectDetails).length ? { details: subjectDetails } : {}), title: string(title, 500, '条目名称')!, coverUrl: cover(row.querySelector('img')?.getAttribute('src'), false),
        rating: star ? rating(star) : null, markedDate: day(marked), comment: string(row.querySelector('.comment')?.textContent ?? null, 2000, '个人短评', true, true),
        publishedAt: null, source: 'import' as const };
    });
  }
  function parse(files: unknown, rawOptions: unknown): DoubanImportPreview {
    if (!plain(rawOptions) || Object.keys(rawOptions).some(key => !['profileId', 'confirmCompleted'].includes(key))
      || rawOptions.confirmCompleted !== undefined && typeof rawOptions.confirmCompleted !== 'boolean') fail('导入确认选项不正确。');
    const options: DoubanImportOptions = { profileId: profile(rawOptions.profileId), confirmCompleted: rawOptions.confirmCompleted === true };
    if (!Array.isArray(files) || !files.length || files.length > limits.files) fail('请选择 1–100 个文本导出文件。');
    const warnings: string[] = [], output: DoubanRecordInput[] = []; let bytes = 0, skipped = 0, duplicates = 0, seenRecords = 0;
    const warn = (value: string) => { if (!warnings.includes(value) && warnings.length < 12) warnings.push(value); };
    for (const rawFile of files) {
      if (!plain(rawFile) || Object.keys(rawFile).some(key => !['name', 'text', 'domain', 'start'].includes(key))
        || typeof rawFile.name !== 'string' || !rawFile.name || rawFile.name.length > 200 || /[\\/]/.test(rawFile.name) || control(rawFile.name)
        || typeof rawFile.text !== 'string' || rawFile.domain !== undefined && (typeof rawFile.domain !== 'string' || !['screen', 'book', 'music'].includes(rawFile.domain))
        || rawFile.start !== undefined && (!Number.isSafeInteger(rawFile.start) || Number(rawFile.start) < 0 || Number(rawFile.start) > 100000)) fail('导入文件描述不正确。');
      const file = rawFile as unknown as DoubanImportFile, text = file.text.replace(/^\uFEFF/, '');
      bytes += byteSize(file.text); if (bytes > limits.bytes) fail('一次导入的原始文件合计不能超过 8 MiB。');
      const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase();
      if (!extension || !['json', 'csv', 'md', 'markdown', 'html', 'htm'].includes(extension)) fail('只支持 JSON、UTF-8 CSV、Markdown 和 HTML 文本文件。');
      let rows: unknown[], canonical = false;
      if (extension === 'html' || extension === 'htm') {
        const parsed = html(text, file, options); rows = parsed; canonical = true;
        warn('HTML 只包含你保存的这一个收藏页面；如有多页，需要逐页保存并一起导入。');
        for (const item of parsed) { output.push(item); if (++seenRecords > limits.records) fail('一次最多预览 500 条记录。'); }
        continue;
      }
      if (extension === 'csv') rows = csv(text);
      else if (extension === 'md' || extension === 'markdown') rows = [markdown(text)];
      else {
        let json: unknown; try { json = JSON.parse(text); } catch { return fail('JSON 文件格式不正确。'); }
        secretKeys(json);
        if (Array.isArray(json)) rows = json;
        else if (plain(json) && (Object.hasOwn(json, 'items') || json.format === 'jiashu-douban-import-v1')) {
          if (!Array.isArray(json.items) || Object.keys(json).some(key => !['format', 'items', 'profileId'].includes(key)) || json.format !== undefined && json.format !== 'jiashu-douban-import-v1') fail('JSON 导入清单格式不正确。');
          if (json.profileId !== undefined && json.profileId !== options.profileId) fail('JSON 中的来源主页与本次选择不一致。');
          canonical = json.format === 'jiashu-douban-import-v1'; rows = json.items;
        } else rows = [json];
      }
      for (const raw of rows) {
        if (++seenRecords > limits.records) fail('一次最多预览 500 条记录。');
        const item = record(raw, options, canonical, warn); if (item) output.push(item); else skipped++;
      }
    }
    const unique = new Map<string, DoubanRecordInput>();
    for (const item of output) {
      const key = item.domain + ':' + item.subjectId, previous = unique.get(key);
      if (!previous) unique.set(key, item);
      else if (JSON.stringify(previous) !== JSON.stringify(item)) fail('同一豆瓣条目在文件中有不同内容，请先保留正确的一份再导入。');
      else duplicates++;
    }
    if (duplicates) warn('相同的重复条目已合并，确认导入时不会重复新增。');
    return { items: [...unique.values()], warnings, skipped, duplicates, sourceFiles: files.length };
  }
  return { parse, limits };
}

export function parseDoubanImportFiles(files: unknown, options: unknown): DoubanImportPreview {
  try {
    const preview = createDoubanImportParser(DOMParser as unknown as typeof globalThis.DOMParser, createDoubanDetailsParser()).parse(files, options);
    return { ...preview, items: preview.items.map(parseDoubanRecord) };
  } catch (error) {
    if (error instanceof Error && error.name === 'DoubanImportError') throw new DoubanImportError(error.message);
    throw error;
  }
}

export function renderDoubanImportParserScript(): string {
  return '<script>window.JiashuDoubanImport=(' + createDoubanImportParser.toString().replace(/<\/script/gi, '<\\/script')
    + ')(class{parseFromString(raw){const template=document.createElement("template");template.innerHTML=raw;return template.content;}},(' + renderDoubanDetailsParserFactory() + ')());</script>';
}
