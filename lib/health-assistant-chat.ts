export interface AssistantHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export const MAX_ASSISTANT_HISTORY_MESSAGES = 8;
export const MAX_ASSISTANT_HISTORY_BYTES = 32000;
export const MAX_ASSISTANT_REQUEST_BYTES = 48 * 1024;

export class HealthAssistantChatError extends Error {
  constructor(message = '对话历史格式无效，请清空对话后重试。') {
    super(message);
    this.name = 'HealthAssistantChatError';
  }
}

/** Count Unicode code points; ordinary newlines and tabs remain useful in chat. */
export function validAssistantText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum * 2 && Boolean(value.trim())
    && [...value].length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
}

/** Untrusted browser history is optional, complete, role-limited, and never persisted. */
export function parseAssistantHistory(raw: unknown): AssistantHistoryMessage[] {
  if (raw === undefined) return [];
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) throw new HealthAssistantChatError();
    const length = Object.getOwnPropertyDescriptor(raw, 'length')?.value as unknown;
    if (typeof length !== 'number' || length > MAX_ASSISTANT_HISTORY_MESSAGES || length % 2 !== 0) {
      throw new HealthAssistantChatError('对话历史最多保留 4 轮完整问答，请开始新对话后重试。');
    }
    if (Reflect.ownKeys(raw).some((key) => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw new HealthAssistantChatError();
    const history: AssistantHistoryMessage[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!descriptor || !('value' in descriptor)) throw new HealthAssistantChatError();
      const message: unknown = descriptor.value;
      if (message === null || typeof message !== 'object' || Array.isArray(message)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(message))) throw new HealthAssistantChatError();
      const keys = Reflect.ownKeys(message);
      if (keys.length !== 2 || keys.some((key) => key !== 'role' && key !== 'content')) throw new HealthAssistantChatError();
      const role = Object.getOwnPropertyDescriptor(message, 'role');
      const content = Object.getOwnPropertyDescriptor(message, 'content');
      if (!role || !('value' in role) || !content || !('value' in content)) throw new HealthAssistantChatError();
      const expectedRole = index % 2 === 0 ? 'user' : 'assistant';
      if (role.value !== expectedRole || !validAssistantText(content.value, expectedRole === 'user' ? 1000 : 10000)) {
        throw new HealthAssistantChatError();
      }
      history.push({ role: expectedRole, content: content.value.trim() });
    }
    if (new TextEncoder().encode(JSON.stringify(history)).byteLength > MAX_ASSISTANT_HISTORY_BYTES) {
      throw new HealthAssistantChatError('对话历史超过 32,000 字节，请开始新对话后重试。');
    }
    return history;
  } catch (error) {
    if (error instanceof HealthAssistantChatError) throw error;
    throw new HealthAssistantChatError();
  }
}
