import { env } from 'cloudflare:workers';
import { DoubanStoreError, type DoubanConnection } from '../../../../db/douban-store';
import { DoubanValidationError } from '../../../../lib/douban';
import { DoubanSyncError } from '../../../../lib/douban-sync';
import { invalidOrigin, isSameOrigin, json } from '../../_shared';

export function doubanDatabase() {
  if (!env.DB) throw new Error('Douban database unavailable');
  return env.DB;
}
export function presentDoubanConnection(connection: DoubanConnection) {
  return { ...connection, profileUrl: connection.profileId === null ? null : 'https://www.douban.com/people/' + connection.profileId + '/' };
}
export function doubanGuard(request: Request) {
  if (!isSameOrigin(request)) return invalidOrigin();
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请通过网站提交 JSON 格式的豆瓣同步操作。', code: 'INVALID_CONTENT_TYPE' }, 415);
  }
  return null;
}
export async function doubanBody(request: Request, maximum = 4096): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new RangeError(); }
      try { text += decoder.decode(next.value, { stream: true }); } catch { throw new SyntaxError(); }
    }
    try { text += decoder.decode(); } catch { throw new SyntaxError(); }
    return JSON.parse(text);
  } finally { reader.releaseLock(); }
}
export function doubanError(error: unknown) {
  if (error instanceof DoubanValidationError || error instanceof DoubanStoreError || error instanceof DoubanSyncError) {
    return json({ error: error.message, code: error.code }, error.status,
      error instanceof DoubanSyncError && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
  }
  if (error instanceof SyntaxError) return json({ error: '豆瓣同步操作格式不正确，请重新提交。', code: 'INVALID_DOUBAN_REQUEST' }, 400);
  if (error instanceof RangeError) return json({ error: '豆瓣同步操作不能超过 4 KB。', code: 'DOUBAN_REQUEST_TOO_LARGE' }, 413);
  return json({ error: '豆瓣资料暂时无法读取或保存，请保留填写后重试。', code: 'DOUBAN_STORAGE_UNAVAILABLE' }, 503);
}
