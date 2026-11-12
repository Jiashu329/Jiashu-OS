import { env } from 'cloudflare:workers';
import { AIProviderError } from '../../../../lib/ai-provider';
import { AISettingsRequestError } from '../../../../lib/ai-settings';
import { AISettingsCryptoError, hasAISettingsEncryptionKey } from '../../../../lib/ai-settings-crypto';
import { AISettingsConflictError, AISettingsValidationError } from '../../../../db/ai-settings-store';
import { SiteAISettingsUnavailableError } from '../../../../db/site-ai-settings-store';
import { invalidOrigin, isSameOrigin, json } from '../../_shared';

export function settingsDatabase(): D1Database {
  if (!env.DB) throw new Error('AI settings storage unavailable');
  return env.DB;
}

export function settingsStorageReady(): boolean {
  return hasAISettingsEncryptionKey(env.AI_SETTINGS_ENCRYPTION_KEY);
}

export function settingsResponse(settings: { configured: boolean }, message?: string, canManage = false): Response {
  const storageReady = settingsStorageReady();
  return json({ settings, scope: 'site', canManage: canManage === true, storageReady, message: message ?? (!canManage
    ? !storageReady ? '全站 MiniMax 密钥服务暂未就绪，请联系管理员。'
      : settings.configured ? '正在使用管理员配置的全站 MiniMax 服务。' : '管理员尚未配置全站 MiniMax，请联系管理员。'
    : !storageReady ? '密钥加密服务暂未就绪，请稍后重试。已保存的密钥仍可删除。'
      : settings.configured ? '全站 MiniMax 配置已保存，所有成员立即使用最新配置。可测试连接确认账号与模型可用。'
        : '保存 MiniMax 密钥后，所有成员将使用这份全站配置。') });
}

export function settingsOwnerRequired(): Response { return json({ error: '只有管理员可以修改全站 MiniMax 配置或测试连接。', code: 'AI_SETTINGS_OWNER_REQUIRED' }, 403); }

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
  if (error instanceof SiteAISettingsUnavailableError) return json({ error: '全站 MiniMax 配置暂未就绪，请联系管理员完成配置。', code: error.code }, 503);
  if (error instanceof AISettingsRequestError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof AISettingsValidationError) return json({ error: error.message, code: error.code }, 400);
  if (error instanceof AISettingsConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof AISettingsCryptoError) return json({ error: '无法读取已保存的密钥，请重新填写密钥并保存。', code: 'AI_SETTINGS_ENCRYPTION_UNAVAILABLE' }, 503);
  if (error instanceof AIProviderError) return json({ error: error.message, code: error.code, diagnostics: error.diagnostics }, error.status);
  // Neither raw credential bodies nor underlying provider/storage errors are logged or returned.
  return json({ error: 'AI 设置暂时不可用，请稍后重试。', code: 'AI_SETTINGS_UNAVAILABLE' }, 503);
}
