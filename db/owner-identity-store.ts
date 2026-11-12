import { configuredAccessOwner, normalizeAccessEmail, validAccessUserId } from '../lib/access-control.ts';

export type OwnerIdentityDatabase = Pick<D1Database, 'prepare'>;
/** A verified, configured owner email may bootstrap once; every later login uses the bound stable ID. */
export async function resolveOwnerIdentity(db: OwnerIdentityDatabase | undefined, identity: { userId: string; email: string },
  config: { userId?: string; email?: string }, now = new Date().toISOString()): Promise<string | null> {
  const explicit = configuredAccessOwner(config.userId);
  if (explicit) return explicit;
  if (!db || !validAccessUserId(identity.userId)) return null;
  let configuredEmail: string;
  try { configuredEmail = normalizeAccessEmail(config.email); } catch { return null; }
  const read = () => db.prepare("SELECT user_id AS userId FROM app_owner_identity WHERE id = 'owner'").first<{ userId: string }>();
  const existing = await read();
  if (existing) return existing.userId;
  let currentEmail: string;
  try { currentEmail = normalizeAccessEmail(identity.email); } catch { return null; }
  if (currentEmail !== configuredEmail) return null;
  await db.prepare(`INSERT INTO app_owner_identity (id, user_id, email, created_at)
    VALUES ('owner', ?, ?, ?) ON CONFLICT(id) DO NOTHING`).bind(identity.userId, configuredEmail, now).run();
  return (await read())?.userId ?? null;
}
