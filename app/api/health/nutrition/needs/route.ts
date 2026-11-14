import { env } from 'cloudflare:workers';
import { consumeAIQuota } from '../../../../../db/ai-usage-store';
import { AISettingsConflictError } from '../../../../../db/ai-settings-store';
import { readSiteAISettings, resolveSiteAIConfiguration, SiteAISettingsUnavailableError } from '../../../../../db/site-ai-settings-store';
import { AISettingsCryptoError } from '../../../../../lib/ai-settings-crypto';
import { AIProviderError, callNutritionNeedsAssistant } from '../../../../../lib/ai-provider';
import { NutritionValidationError } from '../../../../../lib/nutrition';
import { calculateNutritionNeeds, parseNutritionNeedsInput } from '../../../../../lib/nutrition-needs';
import type { NutritionNeedsInput } from '../../../../../lib/nutrition-needs';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { nutritionBody, nutritionGuard } from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = nutritionGuard(request);
  if (guard) return guard;
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请通过网站提交 JSON 格式的测算资料。', code: 'INVALID_CONTENT_TYPE' }, 415);
  }

  let input: NutritionNeedsInput;
  let estimate: ReturnType<typeof calculateNutritionNeeds>;
  try {
    input = parseNutritionNeedsInput(await nutritionBody(request, 4 * 1024));
    estimate = calculateNutritionNeeds(input);
  } catch (error) {
    if (error instanceof NutritionValidationError) return json({ error: error.message, code: error.code, issues: error.issues }, 400);
    if (error instanceof SyntaxError) return json({ error: '测算资料格式不正确，请重新提交。', code: 'INVALID_NUTRITION_NEEDS_REQUEST' }, 400);
    if (error instanceof RangeError) return json({ error: '测算请求不能超过 4 KB。', code: 'NUTRITION_NEEDS_REQUEST_TOO_LARGE' }, 413);
    return json({ error: '暂时无法计算，请检查填写资料后重试。', code: 'NUTRITION_NEEDS_UNAVAILABLE' }, 503);
  }

  // Measurements stay in this request. Only the authenticated actor's existing
  // AI quota is written; no profile, nutrition goal or health record is saved.
  const fallback = (message: string, status: 'unavailable' | 'rateLimited' = 'unavailable', headers: Record<string, string> = {}) =>
    json({ estimate, ai: { status, text: null, message } }, 200, headers);
  try {
    if (!env.DB) return fallback('AI 服务暂不可用，已保留公式估算，可稍后重新测算以获取 AI 解释。');
    const saved = await readSiteAISettings(env.DB, env);
    const configuration = await resolveSiteAIConfiguration(env.DB, env, saved.revision);
    if (!configuration.ready) return fallback('网站 AI 服务尚未就绪，已保留公式估算，请联系网站创建者检查配置。');
    const quota = await consumeAIQuota(env.DB, user.userId, Date.now());
    if (!quota.allowed) return fallback('已达到 AI 请求上限，每分钟最多 3 次、每天最多 20 次。已保留公式估算，请稍后获取 AI 解释。',
      'rateLimited', { 'Retry-After': String(quota.retryAfter) });
    // Re-read after the quota write so a cleared or changed shared key cannot
    // be reused from a configuration captured earlier in this request.
    const active = await resolveSiteAIConfiguration(env.DB, env, saved.revision);
    if (!active.ready) return fallback('网站 AI 配置已变化，已保留公式估算，请稍后重新测算。');
    const result = await callNutritionNeedsAssistant(active, input);
    if (typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 6000) {
      return fallback('AI 解释未完整返回，已保留公式估算，可稍后重新测算。');
    }
    return json({ estimate, ai: { status: 'ready', text: result.answer.trim(), message: null, provider: result.provider, model: result.model } });
  } catch (error) {
    if (error instanceof AISettingsConflictError) return fallback('网站 AI 配置已更新，已保留公式估算，请重新测算以获取最新 AI 解释。');
    if (error instanceof SiteAISettingsUnavailableError || error instanceof AISettingsCryptoError) {
      return fallback('网站 AI 服务尚未就绪，已保留公式估算，请联系网站创建者检查配置。');
    }
    if (error instanceof AIProviderError && error.status === 429) {
      return fallback('AI 服务当前请求较多，已保留公式估算，请稍后获取 AI 解释。', 'rateLimited');
    }
    // Never echo storage errors, upstream output, credentials or measurements.
    return fallback('AI 解释暂不可用，已保留公式估算，可稍后重新测算。');
  }
}
