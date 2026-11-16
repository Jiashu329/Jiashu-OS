/** This table stores only one-way session-family digests, never cookies or JWTs. */
export type LocalSessionRevocationsDatabase = Pick<D1Database, 'prepare' | 'batch'>;
const CLEANUP_LIMIT = 1000;

function family(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid session revocation parameters.');
  return value;
}
function instant(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid session revocation parameters.');
  return value;
}

/** Authentication must fail closed if this lookup throws. All times are UTC ms. */
export async function isLocalSessionRevoked(db: LocalSessionRevocationsDatabase, familyHash: string, now: number): Promise<boolean> {
  const hash = family(familyHash), at = instant(now);
  return await db.prepare('SELECT 1 AS revoked FROM local_session_revocations WHERE family_hash=? AND expires_at>?')
    .bind(hash, at).first<{ revoked: number }>() !== null;
}

/** Logout waits for this durable write before clearing the browser cookie. */
export async function revokeLocalSession(db: LocalSessionRevocationsDatabase, familyHash: string, expiresAt: number, now: number): Promise<void> {
  const hash = family(familyHash), expiry = instant(expiresAt), at = instant(now);
  if (expiry <= at) return;
  await db.batch([
    db.prepare(`INSERT INTO local_session_revocations(family_hash,expires_at) VALUES(?,?)
      ON CONFLICT(family_hash) DO UPDATE SET expires_at=MAX(local_session_revocations.expires_at,excluded.expires_at)`).bind(hash, expiry),
    // Bound cleanup work; a logout must never scan/delete an unbounded history.
    db.prepare(`DELETE FROM local_session_revocations WHERE family_hash IN (
      SELECT family_hash FROM local_session_revocations WHERE expires_at<=? ORDER BY expires_at,family_hash LIMIT ${CLEANUP_LIMIT}
    )`).bind(at),
  ]);
}
