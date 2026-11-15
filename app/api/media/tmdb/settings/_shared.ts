import { env } from 'cloudflare:workers';
import { TMDBSettingsRequestError } from '../../../../../lib/tmdb-settings';
import { hasTMDBSettingsEncryptionKey, TMDBSettingsCryptoError } from '../../../../../lib/tmdb-settings-crypto';
import { TMDBSettingsConflictError, TMDBSettingsOwnerUnavailableError, TMDBSettingsValidationError } from '../../../../../db/tmdb-settings-store';
import type { TMDBSettingsMetadata } from '../../../../../db/tmdb-settings-store';
import { TMDBProviderError } from '../../../../../lib/tmdb-provider';
import { invalidOrigin, isSameOrigin, json } from '../../../_shared';

export function tmdbSettingsDatabase(): D1Database { if (!env.DB) throw new Error('TMDB settings storage unavailable'); return env.DB; }
export function tmdbSettingsStorageReady(): boolean { return hasTMDBSettingsEncryptionKey(env.AI_SETTINGS_ENCRYPTION_KEY); }
export function tmdbSettingsResponse(settings: TMDBSettingsMetadata, canManage: boolean, message?: string): Response {
  return json({ settings, scope: 'site', canManage: canManage === true, storageReady: tmdbSettingsStorageReady(), ...(message ? { message } : {}) });
}
export function tmdbSettingsOwnerRequired(): Response { return json({ error: '只有网站创建者可以管理封面服务配置或测试连接。', code: 'TMDB_SETTINGS_OWNER_REQUIRED' }, 403); }
export function tmdbSettingsStorageGuard(): Response | null {
  return tmdbSettingsStorageReady() ? null : json({ error: '密钥加密服务暂未就绪，请稍后重试。', code: 'TMDB_SETTINGS_ENCRYPTION_UNAVAILABLE' }, 503);
}
export function tmdbSettingsMutationGuard(request: Request, userId: string): Response | null {
  if (!isSameOrigin(request)) return invalidOrigin();
  if (request.headers.get('X-Page-Owner') !== userId) return json({ error: '登录账号已变化，请刷新页面后重试。', code: 'PAGE_OWNER_MISMATCH' }, 401);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: '请从封面设置页面提交 JSON 格式的配置。', code: 'INVALID_CONTENT_TYPE' }, 415);
  return null;
}
export function tmdbSettingsFailure(error: unknown): Response {
  if (error instanceof TMDBSettingsRequestError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof TMDBSettingsConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof TMDBSettingsValidationError) return json({ error: error.message, code: error.code }, 400);
  if (error instanceof TMDBSettingsOwnerUnavailableError) return json({ error: error.message, code: error.code }, 503);
  if (error instanceof TMDBSettingsCryptoError) return json({ error: error.message, code: error.code }, 503);
  if (error instanceof TMDBProviderError) {
    const status = error.code === 'TMDB_UNAUTHORIZED' ? 400 : error.code === 'TMDB_RATE_LIMITED' ? 429 : 503;
    return json({ error: error.message, code: error.code }, status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
  }
  // No raw storage/provider errors, request bodies, ciphertext or tokens are logged or returned.
  return json({ error: '封面服务设置暂时不可用，请稍后重试。', code: 'TMDB_SETTINGS_UNAVAILABLE' }, 503);
}
