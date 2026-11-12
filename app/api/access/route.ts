import { accessHandlers } from './_shared';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return accessHandlers.GET(request); }
export async function POST(request: Request) { return accessHandlers.POST(request); }
