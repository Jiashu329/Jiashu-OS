import { financeBookHandlers } from '../../../_shared';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ bookId: string; memberId: string }> }) {
  const { bookId, memberId } = await context.params;
  return financeBookHandlers.REVOKE(request, bookId, memberId);
}
