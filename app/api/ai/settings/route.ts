import { env } from 'cloudflare:workers';
import { clearAISettings, saveAISettings } from '../../../../db/ai-settings-store';
import { readSiteAISettings, readSiteAISettingsOwner } from '../../../../db/site-ai-settings-store';
import { parseAISettingsRevision, parseAISettingsSave, readAISettingsBody } from '../../../../lib/ai-settings';
import { apiUser, unauthenticated } from '../../_shared';
import { settingsDatabase, settingsFailure, settingsMutationGuard, settingsOwnerRequired, settingsResponse, settingsStorageGuard } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const db = settingsDatabase();
    const ownerId = await readSiteAISettingsOwner(db, env);
    return settingsResponse(await readSiteAISettings(db, env), undefined, user.isOwner === true && user.userId === ownerId);
  }
  catch (error) { return settingsFailure(error); }
}

export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (user.isOwner !== true) return settingsOwnerRequired();
  const guard = settingsMutationGuard(request) ?? settingsStorageGuard();
  if (guard) return guard;
  try {
    const input = parseAISettingsSave(await readAISettingsBody(request));
    const db = settingsDatabase(), ownerId = await readSiteAISettingsOwner(db, env);
    if (user.userId !== ownerId) return settingsOwnerRequired();
    const settings = await saveAISettings(db, ownerId, input, env.AI_SETTINGS_ENCRYPTION_KEY!);
    return settingsResponse(settings, undefined, true);
  } catch (error) { return settingsFailure(error); }
}

export async function DELETE(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (user.isOwner !== true) return settingsOwnerRequired();
  const guard = settingsMutationGuard(request);
  if (guard) return guard;
  try {
    const { expectedRevision } = parseAISettingsRevision(await readAISettingsBody(request));
    const db = settingsDatabase(), ownerId = await readSiteAISettingsOwner(db, env);
    if (user.userId !== ownerId) return settingsOwnerRequired();
    const settings = await clearAISettings(db, ownerId, expectedRevision);
    return settingsResponse(settings, '全站 MiniMax 密钥已删除，所有成员的 AI 功能停止使用该配置。', true);
  } catch (error) { return settingsFailure(error); }
}
