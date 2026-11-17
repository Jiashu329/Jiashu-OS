import { env } from 'cloudflare:workers';
import { identityFromHeaders } from '../lib/account-identity';
import { resolveAccess } from '../db/access-grants-store';
import { resolveOwnerIdentity } from '../db/owner-identity-store';
import { getLocalUserById } from '../db/local-users-store';
import { LOCAL_ACCOUNT_REVISION_HEADER, normalizeLocalEmail } from '../lib/local-users';

export async function accountAccess(requestHeaders: Pick<Headers, 'get'>) {
  const identity = identityFromHeaders(requestHeaders);
  if (!identity) return { identity: null, allowed: false, isOwner: false, reason: 'signed_out' } as const;
  try {
    const ownerId = await resolveOwnerIdentity(env.DB, identity, { userId: env.APP_OWNER_USER_ID, email: env.APP_OWNER_EMAIL });
    if (!ownerId) return { identity, allowed: false, isOwner: false, reason: 'unconfigured' } as const;
    if (env.SELFHOST_AUTH_PROVIDER === 'local') {
      if (!env.DB) return { identity, allowed: false, isOwner: false, reason: 'unavailable' } as const;
      const user = await getLocalUserById(env.DB, identity.userId);
      if (!user) return { identity, allowed: false, isOwner: false, reason: 'not_invited' } as const;
      if (user.status !== 'active') return { identity, allowed: false, isOwner: false, reason: 'revoked' } as const;
      if (user.email !== normalizeLocalEmail(identity.email)) return { identity, allowed: false, isOwner: false, reason: 'identity_conflict' } as const;
      // Keep the session revision verified by the gateway across later database checks.
      if (requestHeaders.get(LOCAL_ACCOUNT_REVISION_HEADER) !== String(user.revision)) return { identity, allowed: false, isOwner: false, reason: 'revoked' } as const;
      return { identity: { ...identity, localAccountRevision: user.revision }, allowed: true, isOwner: user.id === ownerId } as const;
    }
    if (identity.userId === ownerId) return { identity, allowed: true, isOwner: true } as const;
    if (!env.DB) return { identity, allowed: false, isOwner: false, reason: 'unavailable' } as const;
    return { identity, ...await resolveAccess(env.DB, identity, ownerId) };
  }
  catch {
    console.error(JSON.stringify({ event: 'account_access_unavailable' }));
    return { identity, allowed: false, isOwner: false, reason: 'unavailable' } as const;
  }
}
