import { DOUBAN_HOSTS, doubanSubjectUrl, normalizeDoubanCover, type DoubanDomain } from './douban.ts';
import { DoubanSourceError, parseDoubanSourceDocument, readDoubanSource, type DoubanFetchOptions } from './douban-source.ts';
import { createDoubanSubjectDetailsExtractor } from './douban-details-parser.ts';
import type { DoubanSubjectDetails } from './douban-details.ts';

export interface DoubanSubjectMetadata {
  kind: 'movie' | 'series' | 'book' | 'music' | null;
  coverUrl: string | null;
  details?: DoubanSubjectDetails;
}
const MAX_BYTES = 2 * 1024 * 1024;
type SubjectDocument = ReturnType<typeof parseDoubanSourceDocument>;
type SubjectElement = NonNullable<ReturnType<SubjectDocument['querySelector']>>;
const SERIES_TYPES = new Set(['TVSeries', 'TVSeason', 'TVEpisode']);
const SUBJECT_TYPES = new Set(['Movie', 'TVSeries', 'TVSeason', 'TVEpisode', 'Book', 'MusicAlbum', 'MusicRecording', 'MusicRelease']);
function invalid(): never { throw new DoubanSourceError('DOUBAN_SOURCE_INVALID'); }
function compact(value: string | null | undefined): string { return (value ?? '').replace(/\s+/g, ' ').trim(); }

function subjectReference(raw: unknown, domain: DoubanDomain, base: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2048 || /[%\\]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw, base); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== DOUBAN_HOSTS[domain]
    || url.username || url.password || url.port || url.search) return null;
  return /^\/subject\/([1-9]\d{0,15})\/?$/.exec(url.pathname)?.[1] ?? null;
}
function typeName(value: string): string { return value.replace(/^https?:\/\/schema\.org\//i, ''); }
function cover(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().startsWith('//') ? 'https:' + value.trim() : value.trim();
  try { return normalizeDoubanCover(raw); } catch { return null; }
}
function imageValues(raw: unknown, depth = 0): string[] {
  if (depth > 3 || !raw) return [];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.length <= 20 ? raw.flatMap(value => imageValues(value, depth + 1)) : [];
  if (typeof raw === 'object') {
    const object = raw as Record<string, unknown>;
    return [...imageValues(object.url, depth + 1), ...imageValues(object.contentUrl, depth + 1)];
  }
  return [];
}
function labelValue(label: SubjectElement): { name: string; value: string } {
  const text = compact(label.textContent), match = /^([^:：]{1,20})\s*[:：]\s*(.*)$/.exec(text);
  const name = (match?.[1] ?? text).trim(), parts = [match?.[2] ?? ''];
  let sibling = label.nextSibling;
  for (let count = 0; sibling && count < 6; count++, sibling = sibling.nextSibling) {
    if (sibling.nodeName.toUpperCase() === 'BR') break;
    if (sibling.nodeType === 1 && /(?:^|\s)pl(?:\s|$)/.test((sibling as unknown as { getAttribute(name: string): string | null }).getAttribute('class') ?? '')) break;
    parts.push(sibling.textContent ?? '');
  }
  return { name, value: compact(parts.join(' ')).replace(/^[:：]\s*/, '').slice(0, 250) };
}

/**
 * Read only metadata belonging to the requested public subject. Douban sometimes
 * emits Movie JSON-LD for a television series, so explicit episode evidence wins
 * and a generic Movie declaration alone is deliberately insufficient.
 */
export function parseDoubanSubjectMetadata(html: string, domain: DoubanDomain, subjectId: string): DoubanSubjectMetadata {
  const url = doubanSubjectUrl(domain, subjectId);
  if (typeof html !== 'string' || html.length > MAX_BYTES || new TextEncoder().encode(html).byteLength > MAX_BYTES) throw new DoubanSourceError('DOUBAN_SOURCE_TOO_LARGE');
  const document = parseDoubanSourceDocument(html);
  const canonicalNodes = [...document.querySelectorAll('meta[property="og:url"], link[rel="canonical"]')];
  let canonical = false;
  for (const node of canonicalNodes) {
    const raw = node.getAttribute(node.nodeName.toLowerCase() === 'meta' ? 'content' : 'href');
    const id = subjectReference(raw, domain, url);
    if (!id || id !== subjectId) return invalid();
    canonical = true;
  }
  const types = new Set<string>(), structuredImages: string[] = [], structuredObjects: Record<string, unknown>[] = [];
  let boundObjects = 0;
  for (const script of document.querySelectorAll('script[type]')) {
    if ((script.getAttribute('type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/ld+json') continue;
    const raw = script.textContent ?? '';
    if (raw.length > 256 * 1024) continue;
    let json: unknown; try { json = JSON.parse(raw); } catch { continue; }
    let visited = 0;
    function visit(value: unknown, depth: number, root: boolean): void {
      if (depth > 5 || !value || typeof value !== 'object' || ++visited > 300) return;
      if (Array.isArray(value)) {
        if (value.length <= 100) for (const child of value) visit(child, depth + 1, false);
        return;
      }
      const object = value as Record<string, unknown>;
      const rawTypes = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
      const names = rawTypes.filter((type): type is string => typeof type === 'string').map(typeName);
      const explicit = [object.url, object['@id'], typeof object.mainEntityOfPage === 'object' && object.mainEntityOfPage !== null
        ? (object.mainEntityOfPage as Record<string, unknown>)['@id'] : object.mainEntityOfPage].filter(value => typeof value === 'string');
      const ids = explicit.map(value => subjectReference(value, domain, url));
      const hasOwnReference = ids.includes(subjectId);
      const foreignReference = ids.some(id => id !== null && id !== subjectId);
      const bound = !foreignReference && (hasOwnReference || root && !explicit.length && canonical && names.some(name => SUBJECT_TYPES.has(name)));
      if (bound) {
        boundObjects++;
        structuredObjects.push(object);
        for (const name of names) types.add(name);
        structuredImages.push(...imageValues(object.image), ...imageValues(object.thumbnailUrl));
      }
      if (object['@graph']) visit(object['@graph'], depth + 1, false);
      if (object.mainEntity) visit(object.mainEntity, depth + 1, canonical && !foreignReference && (hasOwnReference || root && !explicit.length));
    }
    visit(json, 0, !Array.isArray(json));
  }
  if (!canonical && !boundObjects) return invalid();
  const supportedType = [...types].some(type => SUBJECT_TYPES.has(type));
  if (!compact(document.querySelector('h1')?.textContent) && !document.querySelector('#info, #mainpic') && !supportedType) return invalid();

  const info = [...document.querySelectorAll('#info .pl')].map(labelValue);
  const count = (name: string) => info.some(field => field.name === name && /^[1-9]\d{0,3}(?!\d)/.test(field.value));
  const duration = (name: string) => info.some(field => field.name === name && /^[1-9]\d{0,2}\s*(?:分钟|min(?:ute)?s?)(?:\s|$|[/（(])/i.test(field.value));
  const ogTypes = [...document.querySelectorAll('meta[property="og:type"]')].map(node => (node.getAttribute('content') ?? '').trim().toLowerCase());
  const structuredSeries = [...types].some(type => SERIES_TYPES.has(type));
  const explicitTV = ogTypes.some(type => ['video.tv_show', 'video.tv_series', 'video.episode', 'tv_show', 'tvseries'].includes(type));
  const episodeEvidence = count('集数') || count('季数') || duration('单集片长');
  const tvHints = structuredSeries || explicitTV || episodeEvidence || info.some(field => ['集数', '季数', '单集片长', '首播'].includes(field.name));
  const filmDetails = duration('片长') || info.some(field => field.name === '上映日期' && /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/.test(field.value));
  let kind: DoubanSubjectMetadata['kind'] = domain === 'book' ? 'book' : domain === 'music' ? 'music' : null;
  if (domain === 'screen') {
    if (structuredSeries || explicitTV || episodeEvidence) kind = 'series';
    else if (!tvHints && filmDetails && (types.has('Movie') || ogTypes.includes('video.movie'))) kind = 'movie';
  }

  const candidates: unknown[] = [];
  for (const node of document.querySelectorAll('meta[property="og:image:secure_url"], meta[property="og:image"]')) candidates.push(node.getAttribute('content'));
  candidates.push(...structuredImages);
  for (const image of document.querySelectorAll('#mainpic img, img[rel="v:image"], .subject .pic img, .subjectwrap .pic img')) {
    for (const attribute of ['data-original', 'data-src', 'data-lazy-src', 'data-lazyload', 'data-url']) candidates.push(image.getAttribute(attribute));
    for (const attribute of ['data-srcset', 'srcset']) {
      const raw = image.getAttribute(attribute);
      if (raw && raw.length <= 8192) for (const part of raw.split(',').slice(0, 10)) candidates.push(part.trim().replace(/\s+\d+(?:\.\d+)?[wx]\s*$/i, ''));
    }
    candidates.push(image.getAttribute('src'));
  }
  for (const anchor of document.querySelectorAll('#mainpic a.nbg[href], .subject .pic a.nbg[href], .subjectwrap .pic a.nbg[href]')) candidates.push(anchor.getAttribute('href'));
  const coverUrl = candidates.map(cover).find((value): value is string => value !== null) ?? null;
  const details = createDoubanSubjectDetailsExtractor().extract(document, domain, subjectId, structuredObjects);
  return { kind, coverUrl, ...(Object.keys(details).length ? { details } : {}) };
}

/** Exactly one anonymous fixed-host read; redirects and access challenges stop. */
export async function fetchDoubanSubjectMetadata(domain: DoubanDomain, subjectId: string, options: DoubanFetchOptions = {}): Promise<DoubanSubjectMetadata> {
  const url = doubanSubjectUrl(domain, subjectId);
  return parseDoubanSubjectMetadata(await readDoubanSource(url, false, options), domain, subjectId);
}
