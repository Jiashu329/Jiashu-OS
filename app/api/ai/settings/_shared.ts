import { env } from 'cloudflare:workers';
import { AIProviderError } from '../../../../lib/ai-provider';
import { AISettingsRequestError } from '../../../../lib/ai-settings';
import { AISettingsCryptoError, hasAISettingsEncryptionKey } from '../../../../lib/ai-settings-crypto';
import { AISettingsConflictError, AISettingsValidationError } from '../../../../db/ai-settings-store';
import { invalidOrigin, isSameOrigin, json } from '../../_shared';

export function settingsDatabase(): D1Database {
  if (!env.DB) throw new Error('AI settings storage unavailable');
  return env.DB;
}

export function settingsStorageReady(): boolean {
  return hasAISettingsEncryptionKey(env.AI_SETTINGS_ENCRYPTION_KEY);
}

export function settingsResponse(settings: { configured: boolean }, message?: string): Response {
  const storageReady = settingsStorageReady();
  return json({ settings, storageReady, message: message ?? (!storageReady
    ? '密钥加密服务暂未就绪，请稍后重试。已保存的密钥仍可删除。'
    : settings.configured ? 'MiniMax 配置已保存。保存后立即生效；可点击测试连接确认账号与模型可用。'
    : '填写 MiniMax 密钥并保存，即可在健康助手中使用。') });
}

export function settingsStorageGuard(): Response | null {
  return settingsStorageReady() ? null : json({ error: '密钥加密服务暂未就绪，请稍后重试。', code: 'AI_SETTINGS_ENCRYPTION_UNAVAILABLE' }, 503);
}

export function settingsMutationGuard(request: Request): Response | null {
  if (!isSameOrigin(request)) return invalidOrigin();
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请从 AI 设置页面提交 JSON 格式的配置。', code: 'INVALID_CONTENT_TYPE' }, 415);
  }
  return null;
}

export function settingsFailure(error: unknown): Response {
  if (error instanceof AISettingsRequestError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof AISettingsValidationError) return json({ error: error.message, code: error.code }, 400);
  if (error instanceof AISettingsConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof AISettingsCryptoError) return json({ error: '无法读取已保存的密钥，请重新填写密钥并保存。', code: 'AI_SETTINGS_ENCRYPTION_UNAVAILABLE' }, 503);
  if (error instanceof AIProviderError) return json({ error: error.message, code: error.code }, error.status);
  // Neither raw credential bodies nor underlying provider/storage errors are logged or returned.
  return json({ error: 'AI 设置暂时不可用，请稍后重试。', code: 'AI_SETTINGS_UNAVAILABLE' }, 503);
}
