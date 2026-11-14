/** Public subject facts, independent of a person's rating, comment or completion status. */
export interface DoubanSubjectDetails {
  summary?: string;
  alternateTitles?: string[];
  year?: number;
  genres?: string[];
  countries?: string[];
  languages?: string[];
  doubanRating?: number;
  ratingCount?: number;
  directors?: string[];
  writers?: string[];
  cast?: string[];
  releaseDates?: string[];
  duration?: string;
  episodes?: number;
  seasons?: number;
  episodeDuration?: string;
  authors?: string[];
  translators?: string[];
  publisher?: string;
  publicationDate?: string;
  pages?: number;
  isbn?: string;
  binding?: string;
  price?: string;
  seriesTitle?: string;
  artists?: string[];
  albumType?: string;
  medium?: string;
  label?: string;
  releaseDate?: string;
  tracks?: string[];
}
export const DOUBAN_DETAILS_MAX_BYTES = 16 * 1024;
export class DoubanDetailsValidationError extends Error {
  readonly code = 'INVALID_DOUBAN_INPUT';
  readonly status = 400;
  constructor(message = '豆瓣作品详情格式不正确，请核对字段、长度和数值后重试。') { super(message); this.name = 'DoubanDetailsValidationError'; }
}
export interface DoubanDetailsParser {
  parse(raw: unknown): DoubanSubjectDetails;
  merge(old: unknown, incoming: unknown): DoubanSubjectDetails;
  limits: { jsonBytes: number };
}

/**
 * Serialized into local import and extension parsers. Keep every runtime
 * dependency inside the factory; no model imports, eval, DOM or network access.
 */
export function createDoubanDetailsParser(onInvalid?: (message: string) => never): DoubanDetailsParser {
  const jsonBytes = 16 * 1024;
  // Text limits are UTF-16 lengths, like the rest of the record model. The
  // additional encoded-byte limit bounds combined multilingual metadata.
  const textLimits: Record<string, number> = { summary: 12000, duration: 100, episodeDuration: 100, publisher: 500, publicationDate: 100,
    isbn: 64, binding: 500, price: 100, seriesTitle: 500, albumType: 500, medium: 500, label: 500, releaseDate: 100 };
  const listLimits: Record<string, [number, number]> = { alternateTitles: [50, 500], genres: [100, 200], countries: [100, 200], languages: [100, 200],
    directors: [100, 200], writers: [100, 200], cast: [100, 200], releaseDates: [50, 300], authors: [100, 200], translators: [100, 200],
    artists: [100, 200], tracks: [300, 500] };
  const numberLimits: Record<string, [number, number, boolean]> = { year: [1, 2100, true], doubanRating: [0, 10, false], ratingCount: [0, 1000000000, true],
    episodes: [1, 100000, true], seasons: [1, 10000, true], pages: [1, 1000000, true] };
  const fields = ['summary', 'alternateTitles', 'year', 'genres', 'countries', 'languages', 'doubanRating', 'ratingCount', 'directors', 'writers', 'cast',
    'releaseDates', 'duration', 'episodes', 'seasons', 'episodeDuration', 'authors', 'translators', 'publisher', 'publicationDate', 'pages', 'isbn',
    'binding', 'price', 'seriesTitle', 'artists', 'albumType', 'medium', 'label', 'releaseDate', 'tracks'];
  function invalid(): never {
    const message = '豆瓣作品详情格式不正确，请核对字段、长度和数值后重试。';
    if (onInvalid) return onInvalid(message);
    const error = new Error(message) as Error & { code: string; status: number };
    error.name = 'DoubanDetailsValidationError'; error.code = 'INVALID_DOUBAN_INPUT'; error.status = 400; throw error;
  }
  function text(raw: unknown, maximum: number, summary = false): string | undefined {
    if (typeof raw !== 'string') return invalid();
    // Only ordinary formatting whitespace is permitted among control characters.
    for (const character of raw) {
      const code = character.charCodeAt(0);
      if (code <= 31 && ![9, 10, 13].includes(code) || code >= 127 && code <= 159) return invalid();
    }
    if (/<\/?[A-Za-z][^>]*>|<!--|<![A-Za-z]/.test(raw)) return invalid();
    const value = summary ? raw.replace(/\r\n?/g, '\n').trim() : raw.replace(/\s+/g, ' ').trim();
    if (!value) return undefined;
    if (value.length > maximum) return invalid();
    return value;
  }
  function parse(raw: unknown): DoubanSubjectDetails {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
    const keys = Reflect.ownKeys(raw);
    if (keys.some(key => typeof key !== 'string' || !fields.includes(key))) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.some(key => { const item = descriptors[key as string]; return !item || Object.hasOwn(item, 'get') || Object.hasOwn(item, 'set'); })) return invalid();
    const result: Record<string, string | string[] | number> = {};
    for (const field of fields) {
      const value: unknown = descriptors[field]?.value;
      if (value === null || value === undefined) continue;
      if (Object.hasOwn(textLimits, field)) {
        const normalized = text(value, textLimits[field], field === 'summary');
        if (normalized !== undefined) result[field] = normalized;
      } else if (Object.hasOwn(listLimits, field)) {
        const [count, maximum] = listLimits[field];
        if (!Array.isArray(value) || value.length > count) return invalid();
        const normalized = [...new Set(value.map(item => text(item, maximum)).filter((item): item is string => item !== undefined))];
        if (normalized.length) result[field] = normalized;
      } else {
        const [minimum, maximum, integer] = numberLimits[field];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
          || integer && !Number.isSafeInteger(value) || !integer && Math.round(value * 10) / 10 !== value) return invalid();
        result[field] = Object.is(value, -0) ? 0 : value;
      }
    }
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > jsonBytes) return invalid();
    return result;
  }
  function merge(old: unknown, incoming: unknown): DoubanSubjectDetails {
    // Parse once more to retain canonical field ordering and enforce the total
    // byte cap after combining different previously known fields.
    return parse({ ...parse(old), ...parse(incoming) });
  }
  return { parse, merge, limits: { jsonBytes } };
}
const parser = createDoubanDetailsParser(message => { throw new DoubanDetailsValidationError(message); });
export function parseDoubanDetails(raw: unknown): DoubanSubjectDetails { return parser.parse(raw); }
export function mergeDoubanDetails(old: unknown, incoming: unknown): DoubanSubjectDetails { return parser.merge(old, incoming); }
export function renderDoubanDetailsParserFactory(): string { return '(' + createDoubanDetailsParser.toString() + ')'; }
