import { financeBookHandlers } from '../../_shared';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ bookId: string }> }) {
  return financeBookHandlers.MEMBERS(request, (await context.params).bookId);
}
