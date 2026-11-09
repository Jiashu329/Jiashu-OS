/** Minimal D1 surface shared with the SQLite-backed regression tests. */
export interface SyncConnectionStatement {
  bind(...values: unknown[]): SyncConnectionStatement;
  run(): Promise<{ meta: { changes?: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface SyncConnectionDatabase {
  prepare(sql: string): SyncConnectionStatement;
}

export interface SyncDeviceMetadata {
  deviceId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function listSyncConnections(db: SyncConnectionDatabase, userId: string): Promise<SyncDeviceMetadata[]> {
  const result = await db.prepare(`
    SELECT id AS deviceId, label, created_at AS createdAt,
      last_used_at AS lastUsedAt, revoked_at AS revokedAt
    FROM sync_devices WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC, id DESC
  `).bind(userId).all<SyncDeviceMetadata>();
  return result.results;
}

export async function createSyncConnection(db: SyncConnectionDatabase, userId: string, label: string, tokenHash: string): Promise<string | null> {
  const deviceId = crypto.randomUUID();
  // Every generated address is an independent connection, not a physical
  // device. Creating another one must not revoke any working shortcut.
  const result = await db.prepare(`
    INSERT INTO sync_devices (id, user_id, label, token_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(deviceId, userId, label, tokenHash, new Date().toISOString()).run();
  return result.meta.changes === 1 ? deviceId : null;
}

export async function findSyncConnection(db: SyncConnectionDatabase, userId: string, tokenHash: string): Promise<string | null> {
  const row = await db.prepare(`
    SELECT id FROM sync_devices WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL LIMIT 1
  `).bind(userId, tokenHash).first<{ id: string }>();
  return row?.id ?? null;
}

export async function revokeSyncConnection(db: SyncConnectionDatabase, userId: string, deviceId: string): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE sync_devices SET revoked_at = COALESCE(revoked_at, ?)
    WHERE id = ? AND user_id = ?
  `).bind(new Date().toISOString(), deviceId, userId).run();
  return result.meta.changes === 1;
}
