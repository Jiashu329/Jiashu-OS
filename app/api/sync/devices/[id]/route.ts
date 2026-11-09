import { revokeSyncDevice } from '../../../../../db/health-repository';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../../_shared';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  if (!isSameOrigin(request)) return invalidOrigin();
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return json({ error: '找不到该同步设备。' }, 404);
  }
  try {
    if (!await revokeSyncDevice(user.userId, id)) return json({ error: '找不到该同步设备。' }, 404);
    return json({ ok: true });
  } catch { return unavailable(); }
}
