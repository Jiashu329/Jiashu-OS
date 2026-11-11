import { previewImport } from '../../../../../db/health-repository';
import { HealthValidationError, MAX_SYNC_BYTES } from '../../../../../lib/health';
import { parseMobileSyncPayload } from '../../../../../lib/mobile-sync';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '请提交 JSON 格式的数据。' }, 415);
  if (Number(request.headers.get('content-length')) > MAX_SYNC_BYTES) return json({ error: '单次同步文件不能超过 512 KB。' }, 413);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: '请选择文件或粘贴 JSON 内容。' }, 400);
  try {
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_SYNC_BYTES) { await reader.cancel(); return json({ error: '单次同步文件不能超过 512 KB。' }, 413); }
      text += decoder.decode(next.value, { stream: true });
    }
    const payload = parseMobileSyncPayload(text + decoder.decode());
    if (Date.parse(payload.exportedAt) > Date.now() + 5 * 60000) return json({ error: '导出时间晚于当前时间，请检查 iPhone 的日期与时区。' }, 400);
    return json({ preview: await previewImport(user.userId, payload) });
  } catch (error) {
    if (error instanceof HealthValidationError) return json({ error: '数据格式不正确，请检查指标、来源、单位与日期。', code: error.code, issues: error.issues }, 400);
    return unavailable();
  } finally { reader.releaseLock(); }
}
