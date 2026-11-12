import { env } from 'cloudflare:workers';
import { readHealthRange } from '../../../../db/health-repository';
import { readNutritionRangeSnapshot } from '../../../../db/nutrition-store';
import { consumeAIQuota, readAIQuota } from '../../../../db/ai-usage-store';
import { AIProviderError, callHealthAssistant } from '../../../../lib/ai-provider';
import { AISettingsConflictError, readAISettings, resolveUserAIConfiguration } from '../../../../db/ai-settings-store';
import { AISettingsCryptoError } from '../../../../lib/ai-settings-crypto';
import { buildHealthAssistantContext, HealthAssistantContextError } from '../../../../lib/health-assistant-context';
import { HealthAssistantChatError, MAX_ASSISTANT_REQUEST_BYTES, parseAssistantHistory, validAssistantText } from '../../../../lib/health-assistant-chat';
import { readGoalSettings } from '../../../../db/health-goals-store';
import { readWeightPlanSettings } from '../../../../db/weight-plan-store';
import { readNutritionGoals } from '../../../../db/nutrition-goals-store';
import { assistantScopeKey, AssistantScopeError, parseAssistantDays, parseAssistantScope, parseAssistantRange } from '../../../../lib/health-assistant-scope';
import type { AssistantScope } from '../../../../lib/health-assistant-scope';
import type { AIQuotaResult } from '../../../../db/ai-usage-store';
import { renderAssistantMarkdown } from '../../../../lib/assistant-markdown';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated } from '../../_shared';

export const dynamic = 'force-dynamic';

async function configuration(userId: string, expectedRevision?: number) {
  if (!env.DB) throw new Error('AI settings storage unavailable');
  return resolveUserAIConfiguration(env.DB, userId, env.AI_SETTINGS_ENCRYPTION_KEY, expectedRevision);
}

class AssistantRequestError extends Error {}

async function contextFor(userId: string, period: {days:number;from:string;to:string}, scope: AssistantScope, now: number) {
  if (!env.DB) throw new Error('Health storage unavailable');
  const range = period;
  const [health, nutritionSnapshot, goals, weightPlan, nutritionGoals] = await Promise.all([
    scope.metrics.length ? readHealthRange(userId, range.from, range.to, scope.metrics) : Promise.resolve({measurements:[]}),
    scope.includeNutrition ? readNutritionRangeSnapshot(env.DB, userId, { from: range.from, to: range.to }) : Promise.resolve({entries:[],statuses:[]}),
    scope.includeGoals ? readGoalSettings(env.DB,userId) : Promise.resolve(undefined),
    scope.includeGoals && scope.metrics.includes('weight') ? readWeightPlanSettings(env.DB,userId) : Promise.resolve(undefined),
    scope.includeGoals && scope.includeNutrition ? readNutritionGoals(env.DB,userId) : Promise.resolve(undefined),
  ]);
  return buildHealthAssistantContext({ measurements: health.measurements, nutrition: nutritionSnapshot.entries,
    nutritionStatuses: scope.includeNutrition ? nutritionSnapshot.statuses : undefined, days: period.days, from:period.from, to:period.to, scope, goals, weightPlan, nutritionGoals, now });
}

function failure(error: unknown, quota?: AIQuotaResult): Response {
  const usage = quota ? { usage: {remainingToday:quota.remainingToday,retryAfter:quota.retryAfter} } : {};
  if (error instanceof AISettingsConflictError) return json({ error: 'AI 设置已更新，请重新读取配置后再提问。', code: 'AI_SETTINGS_CONFLICT', ...usage }, 409);
  if (error instanceof AISettingsCryptoError) return json({ error: '无法读取已保存的密钥，请到 AI 设置重新填写并保存。', code: 'AI_SETTINGS_ENCRYPTION_UNAVAILABLE', ...usage }, 503);
  if (error instanceof AIProviderError) return json({ error: error.message, code: error.code, diagnostics: error.diagnostics, ...usage }, error.status);
  if (error instanceof HealthAssistantContextError) return json({ error: error.message, code: error.code, ...usage }, 400);
  if (error instanceof AssistantRequestError || error instanceof AssistantScopeError || error instanceof HealthAssistantChatError || error instanceof SyntaxError) return json({
    error: error instanceof AssistantRequestError || error instanceof AssistantScopeError || error instanceof HealthAssistantChatError ? error.message : '问题格式不正确，请重新提交。', code: 'INVALID_HEALTH_ASSISTANT_REQUEST', ...usage,
  }, 400);
  if (error instanceof RangeError) return json({ error: '对话请求超过 48 KB，请清空历史或缩短问题后再试。', code: 'HEALTH_ASSISTANT_REQUEST_TOO_LARGE', ...usage }, 413);
  // Provider payloads and storage exceptions can contain private data. Do not echo or log them.
  return json({ error: '健康助手暂时不可用，请稍后重试。', code: 'HEALTH_ASSISTANT_UNAVAILABLE', ...usage }, 503);
}

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => !['days','from','to','metrics','nutrition','goals'].includes(key)) || [...query.keys()].some((key) => query.getAll(key).length > 1)) throw new AssistantRequestError('请选择一个有效的时间范围。');
    const now = Date.now();
    const period = parseAssistantRange(Object.fromEntries(['days','from','to'].filter((key)=>query.has(key)).map((key)=>[key,query.get(key)])),now);
    const custom=query.has('from')||query.has('to');
    if (['nutrition','goals'].some((key) => query.has(key) && !['0','1'].includes(query.get(key)!))) throw new AssistantScopeError();
    const scope = parseAssistantScope({metrics:query.has('metrics') ? (query.get('metrics') ? query.get('metrics')!.split(',') : []) : [...parseAssistantScope().metrics], includeNutrition:query.get('nutrition') !== '0', includeGoals:query.get('goals') === '1'});
    const selected = await contextFor(user.userId, period, scope, now);
    const config = await configuration(user.userId);
    const usage = await readAIQuota(env.DB, user.userId, now);
    return json({ usage, scopeKey:assistantScopeKey(period.days,scope,custom?period:undefined), configuration: { ready: config.ready, provider: config.providerLabel, model: config.model, message: config.message }, ...selected });
  } catch (error) { return failure(error); }
}

async function body(request: Request): Promise<unknown> {
  const maximum = MAX_ASSISTANT_REQUEST_BYTES;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximum) throw new RangeError('Request too large');
  if (!request.body) throw new SyntaxError('Missing body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new RangeError('Request too large'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请从健康助手页面提交 JSON 格式的问题。', code: 'INVALID_CONTENT_TYPE' }, 415);
  }
  let quota: AIQuotaResult | undefined;
  try {
    const raw = await body(request);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AssistantRequestError('请填写问题并选择时间范围。');
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['question', 'days', 'from', 'to', 'shareHealthData', 'history', 'scope', 'historyScope'].includes(key))) throw new AssistantRequestError('本次提交包含不支持的字段。');
    const now=Date.now();
    if(!Object.hasOwn(input,'from')&&!Object.hasOwn(input,'to'))parseAssistantDays(input.days);
    const period = parseAssistantRange(Object.fromEntries(['days','from','to'].filter((key)=>Object.hasOwn(input,key)).map((key)=>[key,input[key]])),now);
    const custom=Object.hasOwn(input,'from')||Object.hasOwn(input,'to');
    const scope = parseAssistantScope(input.scope);
    if (input.shareHealthData !== true) return json({ error: '请先确认将所选范围的健康摘要与问题发送至 MiniMax。', code: 'HEALTH_DATA_CONSENT_REQUIRED' }, 400);
    if (!validAssistantText(input.question, 1000)) {
      throw new AssistantRequestError('请填写 1–1000 个字符的问题。');
    }
    const history = parseAssistantHistory(input.history);
    if (input.historyScope !== undefined && (typeof input.historyScope !== 'string' || input.historyScope !== assistantScopeKey(period.days,scope,custom?period:undefined))) throw new AssistantRequestError('资料范围已变化，请开始新对话后再提问。');
    if (!env.DB) throw new Error('AI settings storage unavailable');
    const savedSettings = await readAISettings(env.DB, user.userId);
    const config = await configuration(user.userId, savedSettings.revision);
    if (!config.ready) return json({ error: config.message, code: 'AI_NOT_CONFIGURED' }, 503);
    const selected = await contextFor(user.userId, period, scope, now);
    if (!selected.hasData) return json({ error: '这个时间范围没有健康或饮食记录，请先同步或补录数据。', code: 'HEALTH_ASSISTANT_NO_DATA' }, 400);
    quota = await consumeAIQuota(env.DB, user.userId, now);
    if (!quota.allowed) return json({ error: '已达到健康助手的请求上限，请稍后再试。每分钟最多 3 次，每天最多 20 次。', code: 'AI_RATE_LIMITED', usage: {remainingToday:quota.remainingToday,retryAfter:quota.retryAfter} }, 429,
      { 'Retry-After': String(quota.retryAfter) });
    // Recheck the saved version after data/limit reads so a concurrent clear cannot reuse a captured key.
    const activeConfig = await configuration(user.userId, savedSettings.revision);
    const result = await callHealthAssistant(activeConfig, { question: input.question.trim(), context: selected.context,
      ...(history.length ? { history } : {}) });
    return json({ ...result, answerHtml: renderAssistantMarkdown(result.answer, selected.sources), usage: {remainingToday:quota.remainingToday,retryAfter:0}, scopeKey:assistantScopeKey(period.days,scope,custom?period:undefined), generatedAt: new Date().toISOString(), range: selected.context.range, sources: selected.sources });
  } catch (error) { return failure(error, quota); }
}
