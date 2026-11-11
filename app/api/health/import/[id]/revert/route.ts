import { revertImport } from '../../../../../../db/health-repository';
import { HealthImportConflictError } from '../../../../../../db/health-import-store';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../../../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '请提交 JSON 格式。' }, 415);
  try {
    const id = (await context.params).id;
    if (!/^[a-f0-9]{64}$/.test(id)) return json({ error: '导入编号无效。' }, 400);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: '请填写回退原因。' }, 400);
    let bytes = 0, text = '';
    const decoder = new TextDecoder();
    try {
      while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 4096) { await reader.cancel(); return json({ error: '回退说明过长。' }, 413); } text += decoder.decode(next.value, { stream: true }); }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json({ error: '请提交完整的回退说明。' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'reason')) return json({ error: '回退请求格式不正确。' }, 400);
    const reason = (body as { reason?: unknown }).reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) return json({ error: '请填写 1–500 字的回退原因。' }, 400);
    return json(await revertImport(user.userId, id, reason.trim()));
  } catch (error) {
    if (error instanceof HealthImportConflictError) return json({ error: error.message, code: error.code }, error.code === 'HEALTH_IMPORT_NOT_FOUND' ? 404 : 409);
    return unavailable();
  }
}
