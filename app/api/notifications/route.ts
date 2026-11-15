import { env } from 'cloudflare:workers';
import { createNotificationsHandlers } from '../../../lib/notifications-api';
import { apiUser, unauthenticated, json } from '../_shared';

export const dynamic = 'force-dynamic';
const handlers = createNotificationsHandlers({ user: apiUser, unauthenticated, json,
  database() { if (!env.DB) throw new Error('Notification storage unavailable'); return env.DB; },
});
export const GET = handlers.GET;
export const POST = handlers.POST;
