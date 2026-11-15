const MAX_BYTES = 8 * 1024;
export class TMDBSettingsRequestError extends Error {
  readonly code = 'INVALID_TMDB_SETTINGS';
  readonly status: number;
  constructor(message = '封面服务设置格式无效，请检查后重试。', status = 400) { super(message); this.name = 'TMDBSettingsRequestError'; this.status = status; }
}
function invalid(message?: string): never { throw new TMDBSettingsRequestError(message); }
function object(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  try {
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !('value' in descriptor)) return invalid();
      values[key] = descriptor.value as unknown;
    }
    return values;
  } catch (error) { if (error instanceof TMDBSettingsRequestError) throw error; return invalid(); }
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return invalid('设置版本无效，请重新读取后再试。');
  return value;
}
export async function readTMDBSettingsBody(request: Request): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!request.body) return invalid();
    reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, body = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) { void reader.cancel().catch(() => {}); throw new TMDBSettingsRequestError('设置请求过大，请缩短内容。', 413); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch (error) { if (error instanceof TMDBSettingsRequestError) throw error; return invalid(); }
  finally { reader?.releaseLock(); }
}
export interface TMDBSettingsInput { token?: string; expectedRevision: number }
/** Omitted/blank token retains the existing value. DELETE is the only clear operation. */
export function parseTMDBSettingsSave(raw: unknown): TMDBSettingsInput {
  const values = object(raw, ['token', 'expectedRevision']);
  let token: string | undefined;
  if (Object.hasOwn(values, 'token')) {
    if (typeof values.token !== 'string') return invalid('Token 格式无效；留空可保留已保存的 Token。');
    const trimmed = values.token.trim();
    if (trimmed) {
      if (!/^[\x21-\x7e]{1,4096}$/.test(trimmed)) return invalid('请填写不超过 4096 个字符的有效 API Read Access Token。');
      token = trimmed;
    }
  }
  return { ...(token ? { token } : {}), expectedRevision: revision(values.expectedRevision) };
}
export function parseTMDBSettingsRevision(raw: unknown): { expectedRevision: number } {
  const values = object(raw, ['expectedRevision']);
  return { expectedRevision: revision(values.expectedRevision) };
}
