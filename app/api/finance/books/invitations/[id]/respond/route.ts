import { financeBookHandlers } from '../../../_shared';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return financeBookHandlers.RESPOND(request, (await context.params).id);
}
