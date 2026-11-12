import { AccessConflictError, AccessNotFoundError, AccessValidationError, assertAccessOwner, configuredAccessOwner, normalizeAccessEmail, parseAccessInvite, parseAccessOperationId, parseAccessStatus, validAccessUserId } from '../lib/access-control.ts';
import type { AccessGrant, AccessIdentity, AccessOwnerContext, AccessResolution } from '../lib/access-control.ts';
import { shanghaiDay } from '../lib/health.ts';

export type AccessDatabase = Pick<D1Database, 'prepare' | 'batch'>;
const columns = 'id, email, bound_user_id AS boundUserId, status, revision, created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt';
interface Receipt { operationId: string; actorUserId: string; requestHash: string; grantId: string }
const denied = (reason: Extract<AccessResolution, { allowed: false }>['reason']): AccessResolution => ({ allowed: false, isOwner: false, reason });
function decision(grant: AccessGrant | null, userId: string): AccessResolution {
  if (!grant) return denied('not_invited');
  if (grant.status !== 'active') return denied('revoked');
  if (grant.boundUserId !== userId) return denied('identity_conflict');
  return { allowed: true, isOwner: false };
}
/** Each request reads the current status. Only the first binding and first visit of a Shanghai day write. */
export async function resolveAccess(db: AccessDatabase | null | undefined, identity: AccessIdentity, ownerId: string | undefined, now = new Date().toISOString()): Promise<AccessResolution> {
  const owner = configuredAccessOwner(ownerId);
  if (!owner) return denied('unconfigured');
  if (validAccessUserId(identity.userId) && identity.userId === owner) return { allowed: true, isOwner: true };
  if (!db) throw new Error('Access storage unavailable');
  if (!validAccessUserId(identity.userId)) return denied('identity_conflict');
  const boundIdentity = () => db.prepare(`SELECT ${columns} FROM app_access_grants WHERE bound_user_id = ?`).bind(identity.userId).first<AccessGrant>();
  // After first binding, authorization follows the stable account, including revocation.
  // An email change must neither lock out that account nor let it bypass an existing revocation.
  let current = await boundIdentity();
  if (!current) {
    let email: string;
    try { email = normalizeAccessEmail(identity.email); } catch { return denied('not_invited'); }
    current = await db.prepare(`SELECT ${columns} FROM app_access_grants WHERE email = ?`).bind(email).first<AccessGrant>();
  }
  if (!current) return denied('not_invited');
  if (current.status !== 'active') return denied('revoked');
  if (current.boundUserId !== null && current.boundUserId !== identity.userId) return denied('identity_conflict');
  const grantId = current.id, invitedEmail = current.email;
  const read = () => db.prepare(`SELECT ${columns} FROM app_access_grants WHERE id = ?`).bind(grantId).first<AccessGrant>();
  const today = shanghaiDay(now);
  if (current.boundUserId === identity.userId && current.lastLoginAt && shanghaiDay(current.lastLoginAt) === today) return { allowed: true, isOwner: false };
  const dayStart = new Date(today + 'T00:00:00+08:00').toISOString();
  try {
    const bound = await db.prepare(`UPDATE app_access_grants
      SET bound_user_id = COALESCE(bound_user_id, ?), last_login_at = ?,
        updated_at = CASE WHEN bound_user_id IS NULL THEN ? ELSE updated_at END
      WHERE id = ? AND email = ? AND status = 'active' AND (bound_user_id IS NULL OR bound_user_id = ?)
        AND (bound_user_id IS NULL OR last_login_at IS NULL OR last_login_at < ?)
      RETURNING ${columns}`).bind(identity.userId, now, now, grantId, invitedEmail, identity.userId, dayStart).first<AccessGrant>();
    return decision(bound ?? await read(), identity.userId);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/.test(error.message)) return decision(await boundIdentity(), identity.userId);
    throw error;
  }
}

export async function listAccessGrants(db: AccessDatabase, owner: AccessOwnerContext): Promise<AccessGrant[]> {
  assertAccessOwner(owner.actorUserId, owner.ownerUserId);
  return (await db.prepare(`SELECT ${columns} FROM app_access_grants ORDER BY created_at DESC, id DESC`).all<AccessGrant>()).results;
}
async function readGrant(db: AccessDatabase, id: string): Promise<AccessGrant | null> { return db.prepare(`SELECT ${columns} FROM app_access_grants WHERE id = ?`).bind(id).first<AccessGrant>(); }
async function fingerprint(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function replay(db: AccessDatabase, operationId: string, owner: AccessOwnerContext, requestHash: string) {
  const receipt = await db.prepare('SELECT operation_id AS operationId, actor_user_id AS actorUserId, request_hash AS requestHash, grant_id AS grantId FROM app_access_operations WHERE operation_id = ?').bind(operationId).first<Receipt>();
  if (!receipt) return null;
  if (receipt.actorUserId !== owner.actorUserId || receipt.requestHash !== requestHash) throw new AccessConflictError('同一操作标识不能用于不同成员或不同变更。');
  const grant = await readGrant(db, receipt.grantId);
  if (!grant) throw new Error('Access operation has no grant');
  return { grant, replayed: true };
}
function protectedGrant(grant: AccessGrant, owner: AccessOwnerContext) {
  if (grant.boundUserId === configuredAccessOwner(owner.ownerUserId)) throw new AccessValidationError('创建者由服务端配置保持访问权限，不能通过成员名单停用。');
}
function expectedRace(error: unknown) { return error instanceof Error && /UNIQUE constraint|integer overflow/.test(error.message); }
export async function inviteAccessGrant(db: AccessDatabase, owner: AccessOwnerContext, input: unknown, requestId: string, now = new Date().toISOString()) {
  assertAccessOwner(owner.actorUserId, owner.ownerUserId);
  const { email } = parseAccessInvite(input), operationId = parseAccessOperationId(requestId);
  if (owner.ownerEmail && normalizeAccessEmail(owner.ownerEmail) === email) throw new AccessValidationError('创建者已自动拥有访问权限，无需加入成员名单。');
  const requestHash = await fingerprint(['invite', email]);
  const prior = await replay(db, operationId, owner, requestHash);
  if (prior) return prior;
  try {
    await db.batch([
      db.prepare(`INSERT INTO app_access_grants (id, email, bound_user_id, status, revision, created_at, updated_at, last_login_at)
        VALUES (?, ?, NULL, 'active', 1, ?, ?, NULL)`).bind(operationId, email, now, now),
      db.prepare(`INSERT INTO app_access_operations (operation_id, actor_user_id, request_hash, grant_id, created_at)
        VALUES (?, ?, ?, ?, ?)`).bind(operationId, owner.actorUserId, requestHash, operationId, now),
    ]);
  } catch (error) {
    const done = await replay(db, operationId, owner, requestHash);
    if (done) return done;
    if (expectedRace(error)) throw new AccessConflictError('这个邮箱已在名单中，请查看现有成员；停用的成员可直接恢复。');
    throw error;
  }
  const grant = await readGrant(db, operationId);
  if (!grant) throw new Error('Access grant was not saved');
  return { grant, replayed: false };
}
export async function changeAccessGrant(db: AccessDatabase, owner: AccessOwnerContext, grantId: string, input: unknown, requestId: string, now = new Date().toISOString()) {
  const ownerId = assertAccessOwner(owner.actorUserId, owner.ownerUserId);
  const id = parseAccessOperationId(grantId), operationId = parseAccessOperationId(requestId), change = parseAccessStatus(input);
  const requestHash = await fingerprint(['status', id, change.status, change.expectedRevision]);
  const prior = await replay(db, operationId, owner, requestHash);
  if (prior) return prior;
  const grant = await readGrant(db, id);
  if (!grant) throw new AccessNotFoundError();
  protectedGrant(grant, owner);
  if (grant.revision !== change.expectedRevision) throw new AccessConflictError();
  const changed = grant.status !== change.status;
  const commands = [db.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM app_access_grants WHERE id = ? AND revision = ? AND (bound_user_id IS NULL OR bound_user_id <> ?)
  ) THEN 1 ELSE abs(-9223372036854775808) END AS access_guard`).bind(id, change.expectedRevision, ownerId)];
  if (changed) commands.push(db.prepare('UPDATE app_access_grants SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').bind(change.status, now, id, change.expectedRevision));
  commands.push(db.prepare(`INSERT INTO app_access_operations (operation_id, actor_user_id, request_hash, grant_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(operationId, owner.actorUserId, requestHash, id, now));
  try { await db.batch(commands); }
  catch (error) {
    const done = await replay(db, operationId, owner, requestHash);
    if (done) return done;
    if (expectedRace(error)) throw new AccessConflictError();
    throw error;
  }
  const current = await readGrant(db, id);
  if (!current) throw new Error('Access grant was not saved');
  return { grant: current, replayed: false };
}
