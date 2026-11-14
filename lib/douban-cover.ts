import { normalizeDoubanCover } from './douban.ts';

export const DOUBAN_COVER_MAX_BYTES = 4 * 1024 * 1024;
export const DOUBAN_COVER_TIMEOUT_MS = 15000;
export type DoubanCoverContentType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export interface DoubanCoverResult { bytes: ArrayBuffer; contentType: DoubanCoverContentType }
export class DoubanCoverError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;
  constructor(message = '封面暂时无法读取。', code = 'DOUBAN_COVER_UNAVAILABLE', status = 502, retryAfter?: number) {
    super(message); this.name = 'DoubanCoverError'; this.code = code; this.status = status;
    if (Number.isSafeInteger(retryAfter) && retryAfter! >= 1 && retryAfter! <= 3600) this.retryAfter = retryAfter;
  }
}
const contentTypes = new Set<DoubanCoverContentType>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
function cancel(response: Response) { void response.body?.cancel().catch(() => {}); }
function signature(bytes: Uint8Array): DoubanCoverContentType | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 6 && (['GIF87a', 'GIF89a'].some(header => header.split('').every((char, index) => bytes[index] === char.charCodeAt(0))))) return 'image/gif';
  if (bytes.length >= 12 && 'RIFF'.split('').every((char, index) => bytes[index] === char.charCodeAt(0))
    && 'WEBP'.split('').every((char, index) => bytes[index + 8] === char.charCodeAt(0))) return 'image/webp';
  return null;
}

/** Fetch an already-stored official CDN image, never a profile or subject page. */
export async function fetchDoubanCover(value: string, options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DoubanCoverResult> {
  let url: string | null;
  try { url = normalizeDoubanCover(value); } catch { throw new DoubanCoverError('封面链接暂不可用。', 'DOUBAN_COVER_URL_REJECTED'); }
  if (!url) throw new DoubanCoverError('此条目尚无封面。', 'DOUBAN_COVER_MISSING', 404);
  const controller = new AbortController();
  const requestedTimeout = options.timeoutMs ?? DOUBAN_COVER_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, DOUBAN_COVER_TIMEOUT_MS) : DOUBAN_COVER_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let rejectCancelled!: (error: DoubanCoverError) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const cancellation = () => timedOut ? new DoubanCoverError('封面读取超时。', 'DOUBAN_COVER_TIMEOUT', 504)
    : new DoubanCoverError('封面读取已取消。', 'DOUBAN_COVER_ABORTED', 499);
  const abort = () => { controller.abort(); rejectCancelled(cancellation()); };
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(cancellation()); }, timeoutMs);
  });
  const execute = async (): Promise<DoubanCoverResult> => {
    if (controller.signal.aborted) throw cancellation();
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET', credentials: 'omit', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif', Referer: 'https://www.douban.com/' },
    });
    if (controller.signal.aborted) { cancel(response); throw cancellation(); }
    if (response.status === 429) {
      const value = response.headers.get('retry-after'), retryAfter = value && /^[0-9]{1,8}$/.test(value) ? Math.max(1, Math.min(3600, Number(value))) : 60;
      cancel(response); throw new DoubanCoverError('豆瓣图片暂时限制读取频率，请稍后重试。', 'DOUBAN_COVER_RATE_LIMITED', 429, retryAfter);
    }
    if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
      cancel(response); throw new DoubanCoverError('封面来源发生跳转，本次未继续读取。', 'DOUBAN_COVER_REDIRECT');
    }
    if ([401, 403, 418, 451].includes(response.status)) { cancel(response); throw new DoubanCoverError('豆瓣暂不允许读取这张封面。', 'DOUBAN_COVER_BLOCKED'); }
    if (response.status === 404) { cancel(response); throw new DoubanCoverError('原封面图片暂时不存在。', 'DOUBAN_COVER_UPSTREAM_NOT_FOUND', 404); }
    if (!response.ok) { cancel(response); throw new DoubanCoverError('豆瓣图片来源暂时无法读取。', 'DOUBAN_COVER_UPSTREAM_ERROR'); }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() as DoubanCoverContentType | undefined;
    if (!contentType || !contentTypes.has(contentType)) {
      cancel(response); throw new DoubanCoverError('封面不是受支持的图片。', 'DOUBAN_COVER_INVALID_IMAGE');
    }
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > DOUBAN_COVER_MAX_BYTES) {
      cancel(response); throw new DoubanCoverError('封面图片过大。', 'DOUBAN_COVER_TOO_LARGE');
    }
    if (!response.body) throw new DoubanCoverError('封面没有可读取的图片内容。', 'DOUBAN_COVER_INVALID_IMAGE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    const stopReading = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', stopReading, { once: true });
    if (controller.signal.aborted) stopReading();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > DOUBAN_COVER_MAX_BYTES) {
          void reader.cancel().catch(() => {});
          throw new DoubanCoverError('封面图片过大。', 'DOUBAN_COVER_TOO_LARGE');
        }
        chunks.push(next.value);
      }
    } finally { controller.signal.removeEventListener('abort', stopReading); reader.releaseLock(); }
    if (controller.signal.aborted) throw cancellation();
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (signature(bytes) !== contentType) throw new DoubanCoverError('封面内容与图片格式不一致。', 'DOUBAN_COVER_INVALID_IMAGE');
    return { bytes: bytes.buffer, contentType };
  };
  try { return await Promise.race([execute(), deadline, cancelled]); }
  catch (error) {
    if (error instanceof DoubanCoverError) throw error;
    if (timedOut) throw cancellation();
    if (options.signal?.aborted) throw new DoubanCoverError('封面读取已取消。', 'DOUBAN_COVER_ABORTED', 499);
    // Upstream text, URLs and credentials are never returned or logged.
    throw new DoubanCoverError('封面来源暂时无法连接。', 'DOUBAN_COVER_NETWORK');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort); controller.abort();
  }
}
