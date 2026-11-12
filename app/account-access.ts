import { env } from 'cloudflare:workers';
import { identityFromHeaders } from '../lib/account-identity';
import { resolveAccess } from '../db/access-grants-store';
import { resolveOwnerIdentity } from '../db/owner-identity-store';

export async function accountAccess(requestHeaders: Pick<Headers, 'get'>) {
  const identity = identityFromHeaders(requestHeaders);
  if (!identity) return { identity: null, allowed: false, isOwner: false, reason: 'signed_out' } as const;
  try {
    const ownerId = await resolveOwnerIdentity(env.DB, identity, { userId: env.APP_OWNER_USER_ID, email: env.APP_OWNER_EMAIL });
    if (!ownerId) return { identity, allowed: false, isOwner: false, reason: 'unconfigured' } as const;
    if (identity.userId === ownerId) return { identity, allowed: true, isOwner: true } as const;
    if (!env.DB) return { identity, allowed: false, isOwner: false, reason: 'unavailable' } as const;
    return { identity, ...await resolveAccess(env.DB, identity, ownerId) };
  }
  catch {
    console.error(JSON.stringify({ event: 'account_access_unavailable' }));
    return { identity, allowed: false, isOwner: false, reason: 'unavailable' } as const;
  }
}
