import { env } from 'cloudflare:workers';
import { HealthRecordConflictError, HealthRecordNotFoundError } from '../../../../db/health-records-store';
import { HealthRecordValidationError, validHealthRecordRequestId } from '../../../../lib/health-records';
import { invalidOrigin, isSameOrigin, json, unavailable } from '../../_shared';

export function recordsDatabase() {
  if (!env.DB) throw new Error('Health database is not configured');
  return env.DB;
}
export function recordsError(error: unknown) {
  if (error instanceof HealthRecordValidationError) return json({ error: error.message, code: error.code, issues: error.issues }, 400);
  if (error instanceof HealthRecordConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof HealthRecordNotFoundError) return json({ error: '找不到这条健康记录。', code: error.code }, 404);
  if (error instanceof SyntaxError) return json({ error: '健康记录格式不正确。', code: 'INVALID_HEALTH_RECORD' }, 400);
  if (error instanceof RangeError) return json({ error: '单次填写内容不能超过 16 KB。', code: 'HEALTH_RECORD_TOO_LARGE' }, 413);
  return unavailable();
}
export function guardRecordWrite(request: Request) {
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '请通过网站提交 JSON 格式的健康记录。' }, 415);
  return null;
}
export function recordRequestId(request: Request) {
  const key = request.headers.get('idempotency-key')?.trim();
  return validHealthRecordRequestId(key) ? key.toLowerCase() : null;
}
export function invalidRecordRequestId() {
  return json({ error: '这次提交缺少有效标识，请重新打开表单后保存。', code: 'HEALTH_RECORD_REQUEST_ID_REQUIRED' }, 400);
}
export async function recordBody(request: Request): Promise<unknown> {
  const maximumBytes = 16 * 1024;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumBytes) throw new RangeError('Health record request too large');
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
        throw new RangeError('Health record request too large');
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
