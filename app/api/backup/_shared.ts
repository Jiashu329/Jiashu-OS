import { env } from 'cloudflare:workers';
import { BackupConflictError } from '../../../db/backup-store';
import { BackupValidationError, MAX_BACKUP_BYTES } from '../../../lib/backup';
import { invalidOrigin, isSameOrigin, json } from '../_shared';

export function backupDatabase() { if (!env.DB) throw new Error('Backup database unavailable'); return env.DB; }
export function backupGuard(request: Request) {
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '请选择 JSON 完整备份文件。' }, 415);
  return null;
}
export function backupError(error: unknown) {
  if (error instanceof BackupValidationError || error instanceof SyntaxError) return json({ error: error instanceof BackupValidationError ? error.message : '备份文件不是有效的 JSON。', code: 'INVALID_BACKUP' }, 400);
  if (error instanceof BackupConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof RangeError) return json({ error: '完整备份文件不能超过 16 MB。', code: 'BACKUP_TOO_LARGE' }, 413);
  return json({ error: '备份服务暂时不可用，请稍后重试。', code: 'BACKUP_STORAGE_UNAVAILABLE' }, 503);
}
export async function backupBody(request: Request): Promise<Record<string, unknown>> {
  const limit = MAX_BACKUP_BYTES + 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new RangeError('Backup too large');
  if (!request.body) throw new SyntaxError('Missing body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new RangeError('Backup too large'); }
      text += decoder.decode(value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackupValidationError('备份请求格式不正确。');
    return value as Record<string, unknown>;
  } finally { reader.releaseLock(); }
}
