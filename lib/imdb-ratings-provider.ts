import { IMDB_DATASET_URL, IMDB_RATING_SOURCE, parseIMDbRating, validIMDbRatingDate, type IMDbRating } from './imdb-rating.ts';
import { validIMDbId } from './tmdb-cover.ts';

export type IMDbRatingsProviderCode = 'IMDB_RATE_LIMITED' | 'IMDB_UNAVAILABLE';
export class IMDbRatingsProviderError extends Error {
  readonly code: IMDbRatingsProviderCode;
  readonly status: 429 | 503;
  readonly retryAfter?: number;
  constructor(code: IMDbRatingsProviderCode, retryAfter?: number) {
    super(code === 'IMDB_RATE_LIMITED' ? 'IMDb 评分来源暂时限制请求频率，请稍后重试。' : 'IMDb 评分来源暂时无法读取，已保存的评分和豆瓣资料已保留。');
    this.name = 'IMDbRatingsProviderError'; this.code = code; this.status = code === 'IMDB_RATE_LIMITED' ? 429 : 503;
    if (code === 'IMDB_RATE_LIMITED') this.retryAfter = Number.isFinite(retryAfter) && Number(retryAfter) > 0 ? Math.min(3600, Math.max(1, Math.ceil(Number(retryAfter)))) : 60;
  }
}
export const MAXIMUM_IMDB_TARGETS = 5000;
const MAXIMUM_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAXIMUM_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAXIMUM_LINE_BYTES = 256;
const HEADER = 'tconst\taverageRating\tnumVotes';
export interface IMDbRatingsProviderOptions { fetcher?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; now?: string }
export interface IMDbRatingsLookupResult { ratings: IMDbRating[]; missingIds: string[]; datasetDate: string | null; checkedAt: string }
function unavailable(): never { throw new IMDbRatingsProviderError('IMDB_UNAVAILABLE'); }
function checkedTime(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) unavailable();
  return raw;
}
function retryDelay(raw: string | null, now: string): number {
  if (raw && /^\d{1,10}$/.test(raw)) return Math.min(3600, Math.max(1, Number(raw)));
  if (raw) { const timestamp = Date.parse(raw); if (Number.isFinite(timestamp)) return Math.min(3600, Math.max(1, Math.ceil((timestamp - Date.parse(now)) / 1000))); }
  return 60;
}
function datasetDate(headers: Headers, checkedAt: string): string | null {
  const runDate = headers.get('X-Amz-Meta-Run-Date');
  if (runDate !== null) {
    if (!validIMDbRatingDate(runDate) || runDate > checkedAt.slice(0, 10)) unavailable();
    return runDate;
  }
  const modified = headers.get('Last-Modified');
  if (modified === null) return null;
  const timestamp = Date.parse(modified);
  if (!Number.isFinite(timestamp)) unavailable();
  const value = new Date(timestamp).toISOString().slice(0, 10);
  if (!validIMDbRatingDate(value) || value > checkedAt.slice(0, 10)) unavailable();
  return value;
}
function cancelBody(body: ReadableStream<Uint8Array> | null | undefined) {
  try { void body?.cancel().catch(() => {}); } catch { /* A locked stream is cancelled through its reader. */ }
}

/** Scan the official daily file once; no full dataset or HTML is materialized or returned. */
export async function findIMDbRatings(imdbIds: readonly string[], options: IMDbRatingsProviderOptions = {}): Promise<IMDbRatingsLookupResult> {
  if (!Array.isArray(imdbIds) || imdbIds.length > MAXIMUM_IMDB_TARGETS) unavailable();
  for (const id of imdbIds) if (!validIMDbId(id)) unavailable();
  const checkedAt = checkedTime(options.now ?? new Date().toISOString()), timeoutMs = options.timeoutMs ?? 45000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000 || options.signal?.aborted) unavailable();
  const ids = [...new Set(imdbIds)], targets = new Set(ids);
  if (!ids.length) return { ratings: [], missingIds: [], datasetDate: null, checkedAt };
  const controller = new AbortController(); let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const cancelReader = () => { try { void reader?.cancel().catch(() => {}); } catch { /* Cancellation is best effort after an upstream stream failure. */ } };
  controller.signal.addEventListener('abort', cancelReader);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new IMDbRatingsProviderError('IMDB_UNAVAILABLE')); }, timeoutMs);
    controller.signal.addEventListener('abort', () => reject(new IMDbRatingsProviderError('IMDB_UNAVAILABLE')), { once: true });
  });
  const operation = (async (): Promise<IMDbRatingsLookupResult> => {
    try {
      response = await (options.fetcher ?? fetch)(IMDB_DATASET_URL, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/gzip, application/octet-stream, binary/octet-stream', 'Accept-Encoding': 'identity' },
      });
      if (controller.signal.aborted) unavailable();
      if (response.status === 429) throw new IMDbRatingsProviderError('IMDB_RATE_LIMITED', retryDelay(response.headers.get('Retry-After'), checkedAt));
      if (response.status !== 200 || response.redirected || !/^(?:binary\/octet-stream|application\/(?:octet-stream|gzip|x-gzip))(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')
        || !['', 'identity'].includes((response.headers.get('Content-Encoding') ?? '').toLowerCase()) || !response.body) unavailable();
      const rawLength = response.headers.get('Content-Length');
      if (rawLength !== null && (!/^\d+$/.test(rawLength) || Number(rawLength) > MAXIMUM_COMPRESSED_BYTES)) unavailable();
      const date = datasetDate(response.headers, checkedAt);
      let compressedBytes = 0, decompressedBytes = 0, lineBytes = 0, headerSeen = false, rows = 0, pending = '';
      const found = new Map<string, { rating: number; ratingCount: number }>(), seenTargets = new Set<string>();
      const boundedCompressed = new TransformStream<Uint8Array, BufferSource>({
        transform(chunk, sink) {
          compressedBytes += chunk.byteLength;
          if (compressedBytes > MAXIMUM_COMPRESSED_BYTES || controller.signal.aborted) unavailable();
          // Network chunks are bounded; the owned ArrayBuffer also satisfies both Workers and DOM stream types.
          sink.enqueue(new Uint8Array(chunk));
        },
      });
      reader = response.body.pipeThrough(boundedCompressed).pipeThrough(new DecompressionStream('gzip')).getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      function line(raw: string) {
        const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!headerSeen) { if (value !== HEADER) unavailable(); headerSeen = true; return; }
        const fields = /^(tt[0-9]{7,10})\t([^\t]+)\t([^\t]+)$/.exec(value);
        if (!fields) unavailable();
        const [, id, ratingText, votesText] = fields;
        const missingRating = ratingText === '\\N', missingVotes = votesText === '\\N';
        if (!missingRating && (!/^(?:[0-9]|10)(?:\.[0-9]+)?$/.test(ratingText) || !(Number(ratingText) > 0 && Number(ratingText) <= 10))
          || !missingVotes && (!/^[1-9][0-9]{0,15}$/.test(votesText) || !Number.isSafeInteger(Number(votesText)))) unavailable();
        rows++;
        if (!targets.has(id)) return;
        if (seenTargets.has(id)) unavailable();
        seenTargets.add(id);
        if (!missingRating && !missingVotes) found.set(id, { rating: Number(ratingText), ratingCount: Number(votesText) });
      }
      function text(chunk: string) {
        let start = 0, newline: number;
        while ((newline = chunk.indexOf('\n', start)) !== -1) { line(pending + chunk.slice(start, newline)); pending = ''; start = newline + 1; }
        pending += chunk.slice(start);
      }
      try {
        while (true) {
          const result = await reader.read();
          if (controller.signal.aborted) unavailable();
          if (result.done) break;
          const bytes = result.value; decompressedBytes += bytes.byteLength;
          if (decompressedBytes > MAXIMUM_DECOMPRESSED_BYTES) unavailable();
          let start = 0, newline: number;
          while ((newline = bytes.indexOf(10, start)) !== -1) { lineBytes += newline - start; if (lineBytes > MAXIMUM_LINE_BYTES) unavailable(); lineBytes = 0; start = newline + 1; }
          lineBytes += bytes.byteLength - start; if (lineBytes > MAXIMUM_LINE_BYTES) unavailable();
          text(decoder.decode(bytes, { stream: true }));
        }
        text(decoder.decode()); if (pending) line(pending);
        if (!headerSeen || rows === 0 || rawLength !== null && compressedBytes !== Number(rawLength) || controller.signal.aborted) unavailable();
        const ratings = ids.flatMap(imdbId => {
          const value = found.get(imdbId); if (!value) return [];
          const rating = parseIMDbRating({ imdbId, ...value, source: IMDB_RATING_SOURCE, checkedAt, datasetDate: date });
          if (!rating) unavailable();
          return [rating];
        });
        return { ratings, missingIds: ids.filter(id => !found.has(id)), datasetDate: date, checkedAt };
      } finally { cancelReader(); try { reader.releaseLock(); } catch { /* A pending read is released after cancellation. */ } reader = undefined; }
    } catch (error) { if (error instanceof IMDbRatingsProviderError) throw error; unavailable(); }
    finally { cancelBody(response?.body); }
  })();
  try { return await Promise.race([operation, deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort(); controller.signal.removeEventListener('abort', cancelReader); cancelReader(); cancelBody(response?.body); }
}
