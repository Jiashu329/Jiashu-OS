import { env } from 'cloudflare:workers';
import { createAccessHandlers } from '../../../lib/access-control-api';
import { apiUser, unauthenticated, json } from '../_shared';

export const accessHandlers = createAccessHandlers({
  user: apiUser, unauthenticated,
  // isOwner comes only from the central verified runtime identity gate (including owner bootstrap).
  ownerId(user) { return user.isOwner ? user.userId : undefined; },
  database() { if (!env.DB) throw new Error('Access storage unavailable'); return env.DB; },
  json,
});
