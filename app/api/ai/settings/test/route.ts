import { env } from 'cloudflare:workers';
import { consumeAIQuota } from '../../../../../db/ai-usage-store';
import { recordAISettingsTest, resolveUserAIConfiguration } from '../../../../../db/ai-settings-store';
import { callHealthAssistant } from '../../../../../lib/ai-provider';
import { parseAISettingsTest, readAISettingsBody } from '../../../../../lib/ai-settings';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { settingsDatabase, settingsFailure, settingsMutationGuard, settingsResponse, settingsStorageGuard } from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = settingsMutationGuard(request) ?? settingsStorageGuard();
  if (guard) return guard;
  try {
    const { expectedRevision } = parseAISettingsTest(await readAISettingsBody(request));
    const db = settingsDatabase();
    const config = await resolveUserAIConfiguration(db, user.userId, env.AI_SETTINGS_ENCRYPTION_KEY, expectedRevision);
    if (!config.ready) return json({ error: '请先保存 MiniMax 密钥，再测试连接。', code: 'AI_NOT_CONFIGURED' }, 400);
    const quota = await consumeAIQuota(db, user.userId, Date.now());
    if (!quota.allowed) return json({ error: '已达到请求上限。测试连接与健康助手共用每分钟 3 次、每天 20 次的额度，请稍后再试。', code: 'AI_RATE_LIMITED' }, 429,
      { 'Retry-After': String(quota.retryAfter) });
    const activeConfig = await resolveUserAIConfiguration(db, user.userId, env.AI_SETTINGS_ENCRYPTION_KEY, expectedRevision);
    try {
      // Only fixed synthetic text is sent: no health, nutrition, account or identity data.
      await callHealthAssistant(activeConfig, { question: '这是不含个人信息的连接测试。请只回复：连接正常。',
        context: { purpose: 'connection-test', data: 'synthetic', health: [], nutrition: [] } });
    } catch (error) {
      await recordAISettingsTest(db, user.userId, expectedRevision, false);
      throw error;
    }
    const settings = await recordAISettingsTest(db, user.userId, expectedRevision, true);
    return settingsResponse(settings, '连接测试成功。');
  } catch (error) { return settingsFailure(error); }
}
