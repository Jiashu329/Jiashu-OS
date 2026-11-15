/** Portable TMDB matches contain identifiers only; remote URLs are never accepted. */
export interface TMDBCover {
  imdbId: string;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  posterPath: string;
  language: 'zh' | 'en' | null;
  matchedAt: string;
}
const fields = ['imdbId', 'mediaType', 'tmdbId', 'posterPath', 'language', 'matchedAt'];
export function validIMDbId(value: unknown): value is string { return typeof value === 'string' && /^tt[0-9]{7,10}$/.test(value); }
export function validTMDBPosterPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/[A-Za-z0-9_-]{1,160}\.(?:jpg|jpeg|png|webp)$/.test(value);
}
export function parseTMDBCover(raw: unknown): TMDBCover | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new TypeError('TMDB 封面格式不正确。');
  const value = raw as Record<string, unknown>, keys = Object.keys(value);
  if (keys.length === 0) return null;
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || !validIMDbId(value.imdbId)
    || !['movie', 'tv'].includes(value.mediaType as string) || !Number.isSafeInteger(value.tmdbId) || Number(value.tmdbId) < 1
    || !validTMDBPosterPath(value.posterPath) || !['zh', 'en', null].includes(value.language as 'zh' | 'en' | null)
    || typeof value.matchedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.matchedAt)
    || !Number.isFinite(Date.parse(value.matchedAt)) || new Date(value.matchedAt).toISOString() !== value.matchedAt) throw new TypeError('TMDB 封面格式不正确。');
  return { imdbId: value.imdbId, mediaType: value.mediaType as TMDBCover['mediaType'], tmdbId: value.tmdbId as number,
    posterPath: value.posterPath, language: value.language as TMDBCover['language'], matchedAt: value.matchedAt };
}
export function serializeTMDBCover(raw: unknown): string { return JSON.stringify(parseTMDBCover(raw) ?? {}); }
export function tmdbCoverUrl(cover: TMDBCover | null | undefined): string | null {
  if (!cover) return null;
  try { const parsed = parseTMDBCover(cover); return parsed ? 'https://image.tmdb.org/t/p/w500' + parsed.posterPath : null; }
  catch { return null; }
}
