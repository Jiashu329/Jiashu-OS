import { configuredAccessOwner, validAccessUserId } from '../lib/access-control.ts';
import type { AIConfiguration } from '../lib/ai-provider.ts';
import { readAISettings, resolveUserAIConfiguration } from './ai-settings-store.ts';
import type { AISettingsDatabase, AISettingsMetadata } from './ai-settings-store.ts';

export interface SiteAISettingsEnvironment {
  APP_OWNER_USER_ID?: string;
  AI_SETTINGS_ENCRYPTION_KEY?: string;
}

export class SiteAISettingsUnavailableError extends Error {
  readonly code = 'SITE_AI_NOT_CONFIGURED';
  constructor() {
    super('管理员尚未配置全站AI，请联系网站创建者。');
    this.name = 'SiteAISettingsUnavailableError';
  }
}

/** Read an already established owner only. Shared AI must never bootstrap an identity. */
export async function readSiteAISettingsOwner(db: AISettingsDatabase, config: SiteAISettingsEnvironment): Promise<string> {
  const explicit = configuredAccessOwner(config.APP_OWNER_USER_ID);
  if (explicit) return explicit;
  const row = await db.prepare("SELECT user_id AS userId FROM app_owner_identity WHERE id = 'owner'").first<{ userId: string }>();
  if (!row || !validAccessUserId(row.userId)) throw new SiteAISettingsUnavailableError();
  return row.userId;
}

export async function readSiteAISettings(db: AISettingsDatabase, config: SiteAISettingsEnvironment): Promise<AISettingsMetadata> {
  return readAISettings(db, await readSiteAISettingsOwner(db, config));
}

/** Preserve the original AES-GCM owner and private provider configuration object. */
export async function resolveSiteAIConfiguration(db: AISettingsDatabase, config: SiteAISettingsEnvironment, expectedRevision?: number): Promise<AIConfiguration> {
  const owner = await readSiteAISettingsOwner(db, config);
  const configuration = await resolveUserAIConfiguration(db, owner, config.AI_SETTINGS_ENCRYPTION_KEY, expectedRevision);
  // Ready configurations are keys in the provider's private WeakMap: cloning one
  // would detach its credential. Only an unconfigured result gets new UI copy.
  if (!configuration.ready && configuration.message === '尚未保存 MiniMax API 密钥，请前往网站的 AI 设置。') {
    return Object.freeze({ ...configuration, message: '全站MiniMax尚未就绪，请联系网站创建者。' });
  }
  return configuration;
}
