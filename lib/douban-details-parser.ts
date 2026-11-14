import type { DoubanDomain } from './douban.ts';
import type { DoubanSubjectDetails } from './douban-details.ts';

type DetailsDocument = Pick<DocumentFragment, 'querySelector' | 'querySelectorAll'>;
/** No runtime dependencies: the same bounded extractor is embedded in the local extension. */
export function createDoubanSubjectDetailsExtractor() {
  const html = /<\/?[A-Za-z][^>]*>|<!--|<![A-Za-z]/;
  const domains: Record<string, string> = { screen: 'movie.douban.com', book: 'book.douban.com', music: 'music.douban.com' };
  function text(raw: unknown, maximum = 500, multiline = false): string | null {
    if (typeof raw !== 'string' || html.test(raw)) return null;
    for (const char of raw) {
      const code = char.charCodeAt(0);
      if (code < 32 && ![9, 10, 13].includes(code) || code >= 127 && code <= 159) return null;
    }
    const value = multiline ? raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : raw.replace(/\s+/g, ' ').trim();
    return value && value.length <= maximum ? value : null;
  }
  function names(raw: unknown, maximum = 100, itemLength = 200): string[] {
    const values = Array.isArray(raw) ? raw : [raw], result: string[] = [];
    for (const value of values.slice(0, 600)) {
      const cleaned = text(value, itemLength);
      if (cleaned && !result.includes(cleaned)) result.push(cleaned);
      if (result.length === maximum) break;
    }
    return result;
  }
  function number(raw: unknown, maximum: number, minimum = 1, decimal = false): number | null {
    if (typeof raw === 'string') {
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d)?$/.test(raw.trim())) return null;
      raw = Number(raw.replaceAll(',', ''));
    }
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= minimum && raw <= maximum
      && (decimal ? Math.abs(raw * 10 - Math.round(raw * 10)) < 1e-8 : Number.isInteger(raw)) ? raw : null;
  }
  function content(root: Element, lines = false): string {
    let visited = 0;
    function walk(node: Node, depth: number): string {
      if (++visited > 10000 || depth > 30) return '';
      if (node.nodeType === 3) return node.textContent ?? '';
      const tag = node.nodeName.toUpperCase();
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'BUTTON'].includes(tag)) return '';
      if (tag === 'BR') return lines ? '\n' : ' ';
      const result = [...node.childNodes].map(child => walk(child, depth + 1)).join('');
      return result + (lines && ['P', 'DIV', 'LI'].includes(tag) ? '\n' : '');
    }
    return walk(root, 0);
  }
  function unique(doc: DetailsDocument, selector: string): Element | null {
    const nodes = [...doc.querySelectorAll(selector)];
    return nodes.length === 1 ? nodes[0] : null;
  }
  function relatedContext(element: Element): boolean {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (['ASIDE', 'BLOCKQUOTE'].includes(node.nodeName.toUpperCase())) return true;
      const identity = (node.getAttribute('id') ?? '') + ' ' + (node.getAttribute('class') ?? '');
      if (/(?:^|[-_\s])(?:reviews?|comments?|recommendations?|doulist|discussion|forum)(?:$|[-_\s])/i.test(identity)) return true;
    }
    return false;
  }
  function subjectTracks(doc: DetailsDocument): Element | null {
    const identified = unique(doc, '#track-list');
    if (identified && !relatedContext(identified)) return identified;
    const article = unique(doc, '#content .article');
    if (!article || relatedContext(article)) return null;
    const candidates: Element[] = [];
    for (const heading of article.querySelectorAll('h2')) {
      const parent = heading.parentElement;
      if (parent !== article && !(parent?.parentElement === article && parent.classList.contains('related_info'))) continue;
      if (relatedContext(heading) || !/^曲目[\s·.。…]*$/.test(heading.textContent?.trim() ?? '')) continue;
      const section = heading.nextElementSibling;
      if (!section || relatedContext(section)) continue;
      const tracks = section.classList.contains('track-list') ? [section] : [...section.querySelectorAll('.track-list')];
      if (tracks.length === 1 && !relatedContext(tracks[0])) candidates.push(tracks[0]);
    }
    return candidates.length === 1 ? candidates[0] : null;
  }
  function typeNames(object: Record<string, unknown>) {
    return (Array.isArray(object['@type']) ? object['@type'] : [object['@type']])
      .filter((value): value is string => typeof value === 'string').map(value => value.replace(/^https?:\/\/schema\.org\//i, ''));
  }
  function structuredNames(raw: unknown, depth = 0): string[] {
    if (depth > 4 || raw === null || raw === undefined) return [];
    if (typeof raw === 'string') return [raw];
    if (Array.isArray(raw)) return raw.length <= 300 ? raw.flatMap(value => structuredNames(value, depth + 1)) : [];
    if (typeof raw === 'object') return structuredNames((raw as Record<string, unknown>).name, depth + 1);
    return [];
  }
  function year(raw: unknown): number | null {
    if (typeof raw === 'number') return number(raw, 2100);
    const value = typeof raw === 'string' ? /^(?:[（(]\s*)?(\d{1,4})(?:\s*[)）]|[-/年]|$)/.exec(raw.trim())?.[1] : undefined;
    return value ? number(value, 2100) : null;
  }
  function duration(raw: unknown): string | null {
    const value = text(raw, 100); if (!value) return null;
    const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
    if (!iso || !iso.slice(1).some(Boolean)) return value;
    const minutes = Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0), seconds = Number(iso[3] ?? 0);
    return minutes <= 100000 && seconds < 60 ? (minutes ? minutes + '分钟' : '') + (seconds ? seconds + '秒' : '') || null : null;
  }
  function extract(doc: DetailsDocument, domain: DoubanDomain, subjectId: string, boundObjects: ReadonlyArray<Record<string, unknown>> = []): DoubanSubjectDetails {
    if (!Object.hasOwn(domains, domain) || !/^[1-9]\d{0,15}$/.test(subjectId)) return {};
    const details: DoubanSubjectDetails = {};
    function put(field: keyof DoubanSubjectDetails, value: unknown) {
      if (value === null || value === undefined || Array.isArray(value) && !value.length) return;
      const next = { ...details, [field]: value };
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength <= 16 * 1024) Object.assign(details, { [field]: value });
    }
    const expectedTypes = domain === 'screen' ? ['Movie', 'TVSeries', 'TVSeason', 'TVEpisode'] : domain === 'book' ? ['Book'] : ['MusicAlbum', 'MusicRecording', 'MusicRelease'];
    const objects = boundObjects.slice(0, 300).filter(object => typeNames(object).some(type => expectedTypes.includes(type)));
    function json(...keys: string[]): unknown {
      for (const object of objects) for (const key of keys) if (object[key] !== null && object[key] !== undefined) return object[key];
      return undefined;
    }
    const info = unique(doc, '#info'), fields: Array<{ name: string; value: string; people: string[] }> = [];
    if (info) for (const label of info.querySelectorAll('.pl')) {
      const labelText = (label.textContent ?? '').replace(/\s+/g, ' ').trim(), match = /^([^:：]{1,30})\s*[:：]\s*(.*)$/.exec(labelText);
      const name = (match?.[1] ?? labelText).trim(), parts = [match?.[2] ?? ''], people: string[] = [];
      let sibling = label.nextSibling;
      for (let visited = 0; sibling && visited < 600; sibling = sibling.nextSibling, visited++) {
        if (sibling.nodeName.toUpperCase() === 'BR') break;
        if (sibling.nodeType === 1) {
          const element = sibling as Element;
          if (/(?:^|\s)pl(?:\s|$)/.test(element.getAttribute('class') ?? '')) break;
          for (const anchor of element.nodeName.toUpperCase() === 'A' ? [element] : element.querySelectorAll('a')) {
            const value = text(anchor.textContent, 200);
            if (value && !/^(?:更多|展开全部|收起|显示全部)(?:[.。…]+)?$/.test(value)) people.push(value);
          }
        }
        parts.push(sibling.textContent ?? '');
      }
      const value = parts.join(' ').replace(/^\s*[:：]\s*/, '').replace(/\s+/g, ' ').trim();
      if (value && value.length <= 20000) fields.push({ name, value, people });
    }
    const matching = (...labels: string[]) => fields.filter(field => labels.includes(field.name));
    const value = (...labels: string[]) => matching(...labels).map(field => field.value).find(Boolean);
    const split = (raw: unknown) => typeof raw === 'string' ? raw.split(/\s*\/\s*|\s*[、;；|]\s*/) : [];
    function list(labels: string[], fallback: unknown, maximum = 100, itemLength = 200, people = false): string[] {
      const source = matching(...labels).flatMap(field => people && field.people.length ? field.people : people ? field.value.split(/\s+\/\s+|\s*[、;；]\s*/) : split(field.value));
      return names(source.length ? source : Array.isArray(fallback) ? fallback : split(fallback), maximum, itemLength);
    }
    const report = unique(doc, '#link-report');
    const summaryNode = report ? ['.all .intro', '.all [property="v:summary"]', '.all.hidden', '[property="v:summary"]', '.intro']
      .map(selector => report.querySelector(selector)).find(Boolean) ?? report : null;
    const summary = text(summaryNode ? content(summaryNode, true).replace(/\s*[（(]展开全部[)）]\s*$/, '') : null, 12000, true)
      ?? text(json('description'), 12000, true);
    put('summary', summary);
    put('alternateTitles', list(['又名', '原名', '原作名', '副标题'], structuredNames(json('alternateName')), 50, 500));
    put('year', year(unique(doc, 'h1 .year')?.textContent) ?? year(json('datePublished')) ?? year(value('上映日期', '首播', '出版年', '出版日期', '发行时间', '发行日期')));
    put('genres', list(domain === 'music' ? ['流派', '类型'] : ['类型'], json('genre')));
    put('countries', list(['制片国家/地区', '国家/地区', '国家', '地区'], structuredNames(json('countryOfOrigin'))));
    put('languages', list(['语言'], structuredNames(json('inLanguage'))));
    const ratings = unique(doc, '#interest_sectl');
    const aggregate = json('aggregateRating'), aggregateRating = aggregate && typeof aggregate === 'object' && !Array.isArray(aggregate) ? aggregate as Record<string, unknown> : {};
    const compatibleRating = aggregateRating.bestRating === undefined || number(aggregateRating.bestRating, 10, 0) === 10;
    put('doubanRating', number(ratings?.querySelector('.rating_self [property="v:average"], .rating_self .rating_num')?.textContent?.trim(), 10, 0, true)
      ?? (compatibleRating ? number(aggregateRating.ratingValue, 10, 0, true) : null));
    put('ratingCount', number(ratings?.querySelector('.rating_sum [property="v:votes"], [property="v:votes"]')?.textContent?.trim(), 1e9, 0)
      ?? (compatibleRating ? number(aggregateRating.ratingCount, 1e9, 0) : null));
    if (domain === 'screen') {
      put('directors', list(['导演'], structuredNames(json('director')), 100, 200, true));
      put('writers', list(['编剧'], structuredNames(json('screenwriter', 'creator')), 100, 200, true));
      put('cast', list(['主演'], structuredNames(json('actor')), 100, 200, true));
      put('releaseDates', list(['上映日期', '首播'], json('datePublished'), 50, 300));
      put('duration', duration(value('片长') ?? json('duration')));
      put('episodes', number(value('集数') ?? json('numberOfEpisodes'), 100000));
      put('seasons', number(value('季数') ?? json('numberOfSeasons'), 10000));
      put('episodeDuration', duration(value('单集片长')));
    } else if (domain === 'book') {
      put('authors', list(['作者'], structuredNames(json('author')), 100, 200, true));
      put('translators', list(['译者'], structuredNames(json('translator')), 100, 200, true));
      put('publisher', text(value('出版社') ?? structuredNames(json('publisher'))[0]));
      put('publicationDate', text(value('出版年', '出版日期') ?? json('datePublished'), 100));
      put('pages', number(value('页数') ?? json('numberOfPages'), 1e6));
      put('isbn', text(value('ISBN', 'isbn') ?? json('isbn'), 64));
      put('binding', text(value('装帧') ?? json('bookFormat')));
      const offers = json('offers'), offer = offers && typeof offers === 'object' && !Array.isArray(offers) ? offers as Record<string, unknown> : {};
      put('price', text(value('定价') ?? (typeof offer.price === 'string' || typeof offer.price === 'number' ? String(offer.price) + (typeof offer.priceCurrency === 'string' ? ' ' + offer.priceCurrency : '') : undefined), 100));
      put('seriesTitle', text(value('丛书', '系列') ?? structuredNames(json('isPartOf'))[0]));
    } else {
      put('artists', list(['表演者', '艺术家', '歌手', '演唱者'], structuredNames(json('byArtist')), 100, 200, true));
      put('albumType', text(value('专辑类型') ?? json('albumReleaseType', 'albumProductionType')));
      put('medium', text(value('介质') ?? json('musicReleaseFormat')));
      put('label', text(value('出版者', '发行商', '唱片公司') ?? structuredNames(json('recordLabel', 'publisher'))[0]));
      put('releaseDate', text(value('发行时间', '发行日期') ?? json('datePublished'), 100));
      const trackList = subjectTracks(doc);
      let tracks = trackList ? content(trackList, true).split('\n').map(line => line.trim()).filter(Boolean) : [];
      if (!tracks.length) {
        const rawTracks = json('track'), track = rawTracks && typeof rawTracks === 'object' && !Array.isArray(rawTracks) ? rawTracks as Record<string, unknown> : null;
        const items = track?.itemListElement;
        tracks = Array.isArray(items) && items.length <= 300 ? items.flatMap(item => {
          if (item && typeof item === 'object' && !Array.isArray(item)) { const object = item as Record<string, unknown>; return structuredNames(object.item ?? object); }
          return structuredNames(item);
        }) : structuredNames(rawTracks);
      }
      put('tracks', names(tracks, 300, 500));
    }
    return details;
  }
  return { extract };
}
