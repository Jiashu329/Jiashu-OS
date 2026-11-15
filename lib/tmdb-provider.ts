import { parseTMDBCover, validIMDbId, validTMDBPosterPath, type TMDBCover } from './tmdb-cover.ts';

export type TMDBProviderCode = 'TMDB_UNAUTHORIZED' | 'TMDB_RATE_LIMITED' | 'TMDB_UNAVAILABLE';
export class TMDBProviderError extends Error {
  readonly code: TMDBProviderCode;
  readonly retryAfter?: number;
  constructor(code: TMDBProviderCode, retryAfter?: number) {
    super(code === 'TMDB_UNAUTHORIZED' ? 'TMDB 凭据无效，请在设置中重新配置。' : code === 'TMDB_RATE_LIMITED' ? 'TMDB 暂时限制请求频率，请稍后重试。' : 'TMDB 暂时无法读取，已有豆瓣资料和手动封面已保留。');
    this.name = 'TMDBProviderError'; this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}
export interface TMDBProviderOptions { fetcher?: typeof fetch; timeoutMs?: number }
export type TMDBLookupResult = { status: 'matched'; cover: TMDBCover } | { status: 'no_match' | 'ambiguous' | 'episode_only' | 'no_poster' };
const MAXIMUM_JSON_BYTES = 1024 * 1024;
function unavailable(): never { throw new TMDBProviderError('TMDB_UNAVAILABLE'); }
function object(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) unavailable(); return raw as Record<string, unknown>; }
function retryDelay(raw: string | null): number {
  if (raw && /^\d{1,9}$/.test(raw)) return Math.min(3600, Math.max(1, Number(raw)));
  if (raw) { const timestamp = Date.parse(raw); if (Number.isFinite(timestamp)) return Math.min(3600, Math.max(1, Math.ceil((timestamp - Date.now()) / 1000))); }
  return 60;
}
/** All authenticated traffic stays on this fixed HTTPS host, including error responses. */
async function tmdbJSON(path: string, token: string, options: TMDBProviderOptions): Promise<Record<string, unknown>> {
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new TMDBProviderError('TMDB_UNAUTHORIZED');
  const controller = new AbortController(), timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) unavailable();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetcher ?? fetch)('https://api.themoviedb.org/3' + path, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      redirect: 'manual', credentials: 'omit', signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new TMDBProviderError('TMDB_UNAUTHORIZED'); }
    if (response.status === 429) { const delay = retryDelay(response.headers.get('Retry-After')); await response.body?.cancel(); throw new TMDBProviderError('TMDB_RATE_LIMITED', delay); }
    if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) { await response.body?.cancel(); unavailable(); }
    const length = response.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAXIMUM_JSON_BYTES)) { await response.body?.cancel(); unavailable(); }
    if (!response.body) unavailable();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) { const result = await reader.read(); if (result.done) break; total += result.value.byteLength; if (total > MAXIMUM_JSON_BYTES) { await reader.cancel(); unavailable(); } chunks.push(result.value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) { if (error instanceof TMDBProviderError) throw error; unavailable(); }
  finally { clearTimeout(timer); }
}

/** A credential test reads public API configuration and never fetches account data. */
export async function checkTMDBToken(token: string, options: TMDBProviderOptions = {}): Promise<void> {
  const data = await tmdbJSON('/configuration', token, options), images = object(data.images);
  if (images.secure_base_url !== 'https://image.tmdb.org/t/p/' || !Array.isArray(images.poster_sizes) || !images.poster_sizes.includes('w500')) unavailable();
}
function matches(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length > 100) unavailable();
  const ids = raw.map(value => { const row = object(value); if (!Number.isSafeInteger(row.id) || Number(row.id) < 1) unavailable(); return row.id as number; });
  return [...new Set(ids)];
}
interface Poster { path: string; language: TMDBCover['language']; width: number; height: number; votes: number; average: number }
function poster(raw: unknown): Poster | null {
  const row = object(raw);
  if (!validTMDBPosterPath(row.file_path) || !['zh', 'en', null].includes(row.iso_639_1 as TMDBCover['language'])
    || !Number.isInteger(row.width) || !Number.isInteger(row.height) || Number(row.width) < 300 || Number(row.width) > 20000 || Number(row.height) < 450 || Number(row.height) > 30000
    || Number(row.width) / Number(row.height) < .45 || Number(row.width) / Number(row.height) > .85) return null;
  return { path: row.file_path, language: row.iso_639_1 as TMDBCover['language'], width: Number(row.width), height: Number(row.height),
    votes: typeof row.vote_count === 'number' && Number.isFinite(row.vote_count) ? Math.max(0, row.vote_count) : 0,
    average: typeof row.vote_average === 'number' && Number.isFinite(row.vote_average) ? row.vote_average : 0 };
}
export async function findTMDBCover(imdbId: string, kind: 'movie' | 'series' | 'screen', token: string,
  options: TMDBProviderOptions & { now?: string } = {}): Promise<TMDBLookupResult> {
  if (!validIMDbId(imdbId) || !['movie', 'series', 'screen'].includes(kind)) unavailable();
  const found = await tmdbJSON('/find/' + imdbId + '?external_source=imdb_id&language=zh-CN', token, options);
  const movies = matches(found.movie_results), series = matches(found.tv_results), episodes = matches(found.tv_episode_results ?? []), seasons = matches(found.tv_season_results ?? []);
  if (movies.length + series.length === 0) return { status: episodes.length || seasons.length ? 'episode_only' : 'no_match' };
  if (movies.length + series.length > 1 || episodes.length || seasons.length) return { status: 'ambiguous' };
  const mediaType = movies.length ? 'movie' : 'tv', tmdbId = (movies.length ? movies : series)[0];
  if (kind === 'movie' && mediaType !== 'movie' || kind === 'series' && mediaType !== 'tv') return { status: 'no_match' };
  const images = await tmdbJSON('/' + mediaType + '/' + tmdbId + '/images?include_image_language=zh,en,null', token, options);
  if (!Array.isArray(images.posters) || images.posters.length > 1000) unavailable();
  const languages = ['zh', 'en', null], posters = images.posters.map(poster).filter((value): value is Poster => value !== null);
  posters.sort((a, b) => languages.indexOf(a.language) - languages.indexOf(b.language)
    || Number(b.width >= 500) - Number(a.width >= 500) || b.votes - a.votes || b.average - a.average || b.width - a.width || a.path.localeCompare(b.path));
  if (!posters.length) return { status: 'no_poster' };
  const selected = posters[0], cover = parseTMDBCover({ imdbId, mediaType, tmdbId, posterPath: selected.path, language: selected.language, matchedAt: options.now ?? new Date().toISOString() });
  if (!cover) unavailable();
  return { status: 'matched', cover };
}
