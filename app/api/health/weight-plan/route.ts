import { env } from 'cloudflare:workers';
import { readHealth } from '../../../../db/health-repository';
import { readWeightPlanSettings, WeightPlanConflictError, writeWeightPlanSettings } from '../../../../db/weight-plan-store';
import { readWeightCycleState } from '../../../../db/weight-cycles-store';
import { buildWeightPlanReview, parseWeightPlanInput, WeightPlanValidationError } from '../../../../lib/weight-plan';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../_shared';

export const dynamic = 'force-dynamic';

function database() {
  if (!env.DB) throw new Error('Health database is not configured');
  return env.DB;
}
function errorResponse(error: unknown) {
  if (error instanceof WeightPlanConflictError) return json({error:error.message,code:error.code},409);
  if (error instanceof WeightPlanValidationError) return json({ error: error.message, code: error.code, issues: error.issues }, 400);
  if (error instanceof SyntaxError) return json({ error: '体重计划格式不正确。', code: 'INVALID_WEIGHT_PLAN' }, 400);
  if (error instanceof RangeError) return json({ error: '体重计划不能超过 2 KB。', code: 'WEIGHT_PLAN_TOO_LARGE' }, 413);
  return unavailable();
}
async function smallBody(request: Request): Promise<unknown> {
  const maximumBytes = 2048;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumBytes) throw new RangeError('Weight plan request too large');
  if (!request.body) throw new SyntaxError('Missing body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) { await reader.cancel(); throw new RangeError('Weight plan request too large'); }
      text += decoder.decode(result.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const [settings, health] = await Promise.all([readWeightPlanSettings(database(), user.userId), readHealth(user.userId, 360)]);
    return json({ ...buildWeightPlanReview(settings, health.measurements), ...await readWeightCycleState(database(),user.userId) });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '请通过网站提交 JSON 格式的体重计划。' }, 415);
  try {
    const now = Date.now();
    const body = await smallBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body,'expectedRevision')) return json({error:'请重新读取最新体重计划，再保存。',code:'WEIGHT_PLAN_REVISION_REQUIRED'},400);
    const { expectedRevision, ...fields } = body as Record<string,unknown>;
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision)<0) return json({error:'请重新读取最新体重计划，再保存。',code:'WEIGHT_PLAN_REVISION_REQUIRED'},400);
    const input = parseWeightPlanInput(fields, now);
    const settings = await writeWeightPlanSettings(database(), user.userId, input, Number(expectedRevision));
    const health = await readHealth(user.userId, 360);
    return json({ ...buildWeightPlanReview(settings, health.measurements, now), ...await readWeightCycleState(database(),user.userId) });
  } catch (error) { return errorResponse(error); }
}
