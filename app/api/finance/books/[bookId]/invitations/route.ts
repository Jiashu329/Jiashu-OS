import { financeBookHandlers } from '../../_shared';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ bookId: string }> }) {
  return financeBookHandlers.INVITE(request, (await context.params).bookId);
}
