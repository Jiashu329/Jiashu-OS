import { financeBookHandlers } from './_shared';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return financeBookHandlers.GET(request); }
