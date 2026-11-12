const MAX_SETTINGS_BYTES = 8 * 1024;

export class AISettingsRequestError extends Error {
  readonly code = 'INVALID_AI_SETTINGS';
  readonly status: number;

  constructor(message = 'AI 设置请求格式无效，请检查后重试。', status = 400) {
    super(message);
    this.name = 'AISettingsRequestError';
    this.status = status;
  }
}

function invalid(message = 'AI 设置请求格式无效，请检查后重试。'): never {
  throw new AISettingsRequestError(message);
}

function settingsObject(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  try {
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return invalid('AI 设置请求包含不支持的字段。');
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      // JSON data cannot contain getters; never execute one during validation.
      if (!descriptor || !('value' in descriptor)) return invalid();
      values[key] = descriptor.value as unknown;
    }
    return values;
  } catch (error) {
    if (error instanceof AISettingsRequestError) throw error;
    return invalid();
  }
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalid('设置版本无效，请刷新页面后重试。');
  }
  return value;
}

/** Count actual UTF-8 bytes before parsing, including when content-length is absent or wrong. */
export async function readAISettingsBody(request: Request): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!request.body) return invalid('请提交 JSON 格式的 AI 设置。');
    reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let body = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SETTINGS_BYTES) {
        void reader.cancel().catch(() => {});
        throw new AISettingsRequestError('AI 设置请求过大，请缩短内容后重试。', 413);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof AISettingsRequestError) throw error;
    throw new AISettingsRequestError('无法读取 AI 设置，请提交完整、有效的 JSON 后重试。');
  } finally {
    reader?.releaseLock();
  }
}

export interface AISettingsSave {
  apiKey?: string;
  model: string;
  region: 'cn' | 'global';
  expectedRevision: number;
}

export function parseAISettingsSave(raw: unknown): AISettingsSave {
  const values = settingsObject(raw, ['apiKey', 'model', 'region', 'expectedRevision']);
  if (typeof values.model !== 'string') return invalid('请填写 MiniMax 模型名称。');
  const model = values.model.trim();
  if (model.length > 100 || !/^MiniMax-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    return invalid('模型名称须以 MiniMax- 开头，仅使用字母、数字、点、下划线或连字符，且不超过 100 个字符。');
  }
  if (values.region !== 'cn' && values.region !== 'global') return invalid('请选择 cn 或 global 区域。');
  const expectedRevision = revision(values.expectedRevision);
  let apiKey: string | undefined;
  if (Object.hasOwn(values, 'apiKey')) {
    if (typeof values.apiKey !== 'string') return invalid('API 密钥格式无效；留空可保留当前密钥。');
    const trimmed = values.apiKey.trim();
    if (trimmed) {
      if (!/^[\x21-\x7e]{1,4096}$/.test(trimmed)) {
        return invalid('API 密钥格式无效，请填写不超过 4096 个字符的有效密钥。');
      }
      apiKey = trimmed;
    }
  }
  return { ...(apiKey ? { apiKey } : {}), model, region: values.region, expectedRevision };
}

export function parseAISettingsRevision(raw: unknown): { expectedRevision: number } {
  const values = settingsObject(raw, ['expectedRevision']);
  return { expectedRevision: revision(values.expectedRevision) };
}

export function parseAISettingsTest(raw: unknown): { expectedRevision: number; consent: true } {
  const values = settingsObject(raw, ['expectedRevision', 'consent']);
  if (values.consent !== true) return invalid('请先确认同意使用少量 API 额度测试连接。');
  return { expectedRevision: revision(values.expectedRevision), consent: true };
}
