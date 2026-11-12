import { accessHandlers } from '../_shared';

export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return accessHandlers.PATCH(request, id);
}
