import { env } from 'cloudflare:workers';
import { readWeeklyAction, writeWeeklyAction, WeeklyActionConflictError } from '../../../../db/health-weekly-actions-store';
import { parseWeeklyActionInput, weeklyActionWeek, WeeklyActionValidationError } from '../../../../lib/health-weekly-actions';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../_shared';

export const dynamic = 'force-dynamic';
function database() { if (!env.DB) throw new Error('Health database is not configured'); return env.DB; }
function failure(error: unknown) {
  if (error instanceof WeeklyActionValidationError) return json({ error: error.message, code: error.code }, 400);
  if (error instanceof WeeklyActionConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof SyntaxError) return json({ error: '行动格式不正确。', code: 'INVALID_WEEKLY_ACTION' }, 400);
  if (error instanceof RangeError) return json({ error: '行动内容不能超过 4 KB。', code: 'WEEKLY_ACTION_TOO_LARGE' }, 413);
  return unavailable();
}
async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > 4096) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw new RangeError(); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const weekStart = weeklyActionWeek(new URL(request.url).searchParams.get('week'));
    return json({ weekStart, action: await readWeeklyAction(database(), user.userId, weekStart) });
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '请通过网站提交 JSON 格式的行动。' }, 415);
  try { return json(await writeWeeklyAction(database(), user.userId, parseWeeklyActionInput(await body(request)))); }
  catch (error) { return failure(error); }
}
