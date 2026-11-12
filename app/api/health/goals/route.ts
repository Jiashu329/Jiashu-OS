import { env } from 'cloudflare:workers';
import { HealthGoalConflictError, readGoalSettings, writeGoalSettings } from '../../../../db/health-goals-store';
import { GoalValidationError, parseGoalUpdateInput } from '../../../../lib/health-goals';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../_shared';

export const dynamic = 'force-dynamic';

function database() {
  if (!env.DB) throw new Error('Health database is not configured');
  return env.DB;
}

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try { return json(await readGoalSettings(database(), user.userId)); }
  catch { return unavailable(); }
}

async function readBody(request: Request): Promise<unknown> {
  const maximumBytes = 2048;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumBytes) throw new RangeError('Goal settings request too large');
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
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new RangeError('Goal settings request too large');
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json({ error: '请通过网站提交 JSON 格式的健康目标。' }, 415);
  }
  try {
    const input = parseGoalUpdateInput(await readBody(request));
    return json(await writeGoalSettings(database(), user.userId, input.targets, input.expectedRevision, input.effectiveFrom));
  } catch (error) {
    if (error instanceof HealthGoalConflictError) return json({ error:error.message,code:error.code },409);
    if (error instanceof GoalValidationError) return json({ error: '请检查健康目标。', code: error.code, issues: error.issues }, 400);
    if (error instanceof SyntaxError) return json({ error: '目标设置格式不正确，请重试。', code: 'INVALID_HEALTH_GOALS' }, 400);
    if (error instanceof RangeError) return json({ error: '目标设置不能超过 2 KB。', code: 'HEALTH_GOALS_TOO_LARGE' }, 413);
    return unavailable();
  }
}
