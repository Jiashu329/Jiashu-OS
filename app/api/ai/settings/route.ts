import { env } from 'cloudflare:workers';
import { clearAISettings, readAISettings, saveAISettings } from '../../../../db/ai-settings-store';
import { parseAISettingsRevision, parseAISettingsSave, readAISettingsBody } from '../../../../lib/ai-settings';
import { apiUser, unauthenticated } from '../../_shared';
import { settingsDatabase, settingsFailure, settingsMutationGuard, settingsResponse, settingsStorageGuard } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try { return settingsResponse(await readAISettings(settingsDatabase(), user.userId)); }
  catch (error) { return settingsFailure(error); }
}

export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = settingsMutationGuard(request) ?? settingsStorageGuard();
  if (guard) return guard;
  try {
    const input = parseAISettingsSave(await readAISettingsBody(request));
    const settings = await saveAISettings(settingsDatabase(), user.userId, input, env.AI_SETTINGS_ENCRYPTION_KEY!);
    return settingsResponse(settings);
  } catch (error) { return settingsFailure(error); }
}

export async function DELETE(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = settingsMutationGuard(request);
  if (guard) return guard;
  try {
    const { expectedRevision } = parseAISettingsRevision(await readAISettingsBody(request));
    const settings = await clearAISettings(settingsDatabase(), user.userId, expectedRevision);
    return settingsResponse(settings, 'MiniMax 密钥已删除，健康助手已停止使用该密钥。');
  } catch (error) { return settingsFailure(error); }
}
