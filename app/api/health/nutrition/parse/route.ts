import { env } from 'cloudflare:workers';
import { consumeAIQuota } from '../../../../../db/ai-usage-store';
import { AISettingsConflictError, readAISettings, resolveUserAIConfiguration } from '../../../../../db/ai-settings-store';
import { AISettingsCryptoError } from '../../../../../lib/ai-settings-crypto';
import { AIProviderError, callNutritionParser } from '../../../../../lib/ai-provider';
import { buildNutritionDrafts, NutritionParserError, parseNutritionParserRequest } from '../../../../../lib/nutrition-parser';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { nutritionBody, nutritionGuard } from '../_shared';

export const dynamic = 'force-dynamic';

function failure(error: unknown): Response {
  if (error instanceof NutritionParserError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof AIProviderError) return json({ error: error.message, code: error.code, diagnostics: error.diagnostics }, error.status);
  if (error instanceof AISettingsConflictError) return json({ error: 'AI 设置已更新，请重新识别。', code: 'AI_SETTINGS_CONFLICT' }, 409);
  if (error instanceof AISettingsCryptoError) return json({ error: '无法读取密钥，请到 AI 设置重新保存。', code: 'AI_SETTINGS_ENCRYPTION_UNAVAILABLE' }, 503);
  if (error instanceof SyntaxError) return json({ error: '饮食描述格式不正确，请重新提交。', code: 'INVALID_NUTRITION_PARSE_REQUEST' }, 400);
  if (error instanceof RangeError) return json({ error: '饮食描述请求不能超过 16 KB。', code: 'NUTRITION_PARSE_REQUEST_TOO_LARGE' }, 413);
  // Storage errors may contain key material. Never echo them or provider output.
  return json({ error: '饮食识别暂时不可用，请稍后重试。', code: 'NUTRITION_PARSE_UNAVAILABLE' }, 503);
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = nutritionGuard(request);
  if (guard) return guard;
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请通过网站提交 JSON 格式的饮食描述。', code: 'INVALID_CONTENT_TYPE' }, 415);
  }
  try {
    const input = parseNutritionParserRequest(await nutritionBody(request));
    if (!env.DB) throw new Error('AI settings storage unavailable');
    const saved = await readAISettings(env.DB, user.userId);
    const config = await resolveUserAIConfiguration(env.DB, user.userId, env.AI_SETTINGS_ENCRYPTION_KEY, saved.revision);
    if (!config.ready) return json({ error: config.message, code: 'AI_NOT_CONFIGURED' }, 503);
    const quota = await consumeAIQuota(env.DB, user.userId, Date.now());
    if (!quota.allowed) return json({ error: '已达到 AI 请求上限，请稍后再试。每分钟最多 3 次，每天最多 20 次。', code: 'AI_RATE_LIMITED' }, 429,
      { 'Retry-After': String(quota.retryAfter) });
    // Recheck after quota access, so clearing/updating a key during the request
    // cannot reuse a captured configuration or silently select another account.
    const active = await resolveUserAIConfiguration(env.DB, user.userId, env.AI_SETTINGS_ENCRYPTION_KEY, saved.revision);
    const result = await callNutritionParser(active, input);
    return json({ ...buildNutritionDrafts(result.answer, input), provider: result.provider, model: result.model });
  } catch (error) { return failure(error); }
}
