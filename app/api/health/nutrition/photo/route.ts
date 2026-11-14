import { listManagedFoodLibrary } from '../../../../../db/managed-food-store';
import { env } from 'cloudflare:workers';
import { consumeAIQuota } from '../../../../../db/ai-usage-store';
import { AISettingsConflictError } from '../../../../../db/ai-settings-store';
import { readSiteAISettings, resolveSiteAIConfiguration, SiteAISettingsUnavailableError } from '../../../../../db/site-ai-settings-store';
import { AISettingsCryptoError } from '../../../../../lib/ai-settings-crypto';
import { AIProviderError, assertNutritionPhotoModel, callNutritionPhotoParser } from '../../../../../lib/ai-provider';
import { NutritionPhotoError, buildNutritionPhotoDrafts, parseNutritionPhotoRequest, readNutritionPhotoBody } from '../../../../../lib/nutrition-photo';
import { NutritionPhotoImageError } from '../../../../../lib/nutrition-photo-image';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { nutritionGuard } from '../_shared';

export const dynamic = 'force-dynamic';
function failure(error: unknown): Response {
  if (error instanceof NutritionPhotoError || error instanceof NutritionPhotoImageError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof AIProviderError) return json({ error: error.message, code: error.code, diagnostics: error.diagnostics }, error.status);
  if (error instanceof AISettingsConflictError) return json({ error: 'AI 设置已更新，请核对设置后重新识别图片。', code: 'AI_SETTINGS_CONFLICT' }, 409);
  if (error instanceof SiteAISettingsUnavailableError) return json({ error: '网站 AI 服务尚未配置，请联系网站创建者。', code: error.code }, 503);
  if (error instanceof AISettingsCryptoError) return json({ error: '网站 AI 配置暂不可用，请联系网站创建者检查。', code: 'AI_SETTINGS_ENCRYPTION_UNAVAILABLE' }, 503);
  return json({ error: '图片识别暂时不可用，请稍后重试。', code: 'NUTRITION_PHOTO_UNAVAILABLE' }, 503);
}
export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = nutritionGuard(request); if (guard) return guard;
  const pageOwner=request.headers.get('X-Page-Owner');
  if(pageOwner&&pageOwner!==user.userId)return json({error:'登录账号已变化，请刷新饮食页面后重新选择图片。',code:'NUTRITION_PHOTO_OWNER_CHANGED'},409);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: '请通过网站提交食物图片。', code: 'INVALID_CONTENT_TYPE' }, 415);
  try {
    const input = parseNutritionPhotoRequest(await readNutritionPhotoBody(request));
    if (!env.DB) throw new Error('AI settings storage unavailable');
    const saved = await readSiteAISettings(env.DB, env);
    const config = await resolveSiteAIConfiguration(env.DB, env, saved.revision);
    if (!config.ready) return json({ error: '网站 AI 服务尚未就绪，请联系网站创建者检查配置。', code: 'AI_NOT_CONFIGURED' }, 503);
    assertNutritionPhotoModel(config);
    const publicCatalog = await listManagedFoodLibrary(env.DB);
    const quota = await consumeAIQuota(env.DB, user.userId, Date.now());
    if (!quota.allowed) return json({ error: '已达到 AI 请求上限，请稍后再试。每分钟最多 3 次，每天最多 20 次。', code: 'AI_RATE_LIMITED' }, 429, { 'Retry-After': String(quota.retryAfter) });
    // Same ownership/revision boundary as text parsing; no stale captured key after a clear/update.
    const active = await resolveSiteAIConfiguration(env.DB, env, saved.revision);
    assertNutritionPhotoModel(active);
    const result = await callNutritionPhotoParser(active, input);
    return json({ ...buildNutritionPhotoDrafts(result.answer, input, { excludedFoodIds: publicCatalog.overrides }), provider: result.provider, model: result.model });
  } catch (error) { return failure(error); }
}
