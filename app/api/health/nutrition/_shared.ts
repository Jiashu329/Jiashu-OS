import { env } from 'cloudflare:workers';
import { NutritionConflictError } from '../../../../db/nutrition-store';
import { NutritionValidationError, validNutritionId } from '../../../../lib/nutrition';
import { invalidOrigin, isSameOrigin, json, unavailable } from '../../_shared';

export function nutritionDatabase() {
  if (!env.DB) throw new Error('Health database is not configured');
  return env.DB;
}
export function nutritionError(error: unknown) {
  if (error instanceof NutritionValidationError) return json({ error: error.message, code: error.code, issues: error.issues }, 400);
  if (error instanceof NutritionConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof SyntaxError) return json({ error: '饮食记录格式不正确。', code: 'INVALID_NUTRITION_ENTRY' }, 400);
  if (error instanceof RangeError) return json({ error: '单次填写内容不能超过 16 KB。', code: 'NUTRITION_REQUEST_TOO_LARGE' }, 413);
  return unavailable();
}
export function nutritionNotFound() { return json({ error: '找不到这条饮食记录。', code: 'NUTRITION_ENTRY_NOT_FOUND' }, 404); }
export function nutritionGuard(request: Request) {
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '请通过网站提交 JSON 格式的饮食记录。' }, 415);
  return null;
}
export function nutritionRequestId(request: Request) {
  const key = request.headers.get('idempotency-key')?.trim();
  return validNutritionId(key) ? key.toLowerCase() : null;
}
export function invalidNutritionRequestId() {
  return json({ error: '这次提交缺少有效标识，请重新打开表单后保存。', code: 'NUTRITION_REQUEST_ID_REQUIRED' }, 400);
}
export async function nutritionBody(request: Request): Promise<unknown> {
  const maximumBytes = 16 * 1024;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumBytes) throw new RangeError('Nutrition request too large');
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
      if (bytes > maximumBytes) { await reader.cancel(); throw new RangeError('Nutrition request too large'); }
      text += decoder.decode(result.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
