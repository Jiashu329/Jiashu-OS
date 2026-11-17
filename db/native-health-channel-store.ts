/** Server-owned ingestion policy, separate from portable personal business data. */
export type NativeHealthChannelDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export interface NativeHealthChannelState {
  revision: number;
  deviceId: string | null;
  label: string | null;
  updatedAt: string | null;
  isCurrentDevice: boolean;
}
interface ChannelRow {
  revision: number; deviceId: string | null; lastDeviceId: string;
  label: string | null; tokenHash: string | null; revokedAt: string | null; updatedAt: string;
}
export interface NativeHealthChannelPolicy { revision: number; deviceId: string | null; live: boolean }
type ChannelErrorCode = 'NATIVE_HEALTH_CHANNEL_INVALID' | 'NATIVE_HEALTH_CHANNEL_STALE' | 'NATIVE_HEALTH_CHANNEL_DEVICE_INVALID' | 'NATIVE_HEALTH_CHANNEL_NOT_CURRENT';
const errors = {
  NATIVE_HEALTH_CHANNEL_INVALID: [400, '同步通道设置格式不正确，请核对设备名称及版本。'],
  NATIVE_HEALTH_CHANNEL_STALE: [409, '同步通道已在另一设备更新，请读取最新设置后再确认。'],
  NATIVE_HEALTH_CHANNEL_DEVICE_INVALID: [403, '此设备连接已失效，请生成新的设备连接后再确认。'],
  NATIVE_HEALTH_CHANNEL_NOT_CURRENT: [409, '只有当前选定的设备可以关闭这个同步通道。'],
} as const;
export class NativeHealthChannelError extends Error {
  readonly code: ChannelErrorCode;
  readonly status: number;
  constructor(code: ChannelErrorCode) { super(errors[code][1]); this.name = 'NativeHealthChannelError'; this.code = code; this.status = errors[code][0]; }
}
function invalid(): never { throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_INVALID'); }
function controls(value: string): boolean { return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function validate(userId: string, hash?: string | null, revision?: number) {
  if (typeof userId !== 'string' || !userId || userId.length > 200 || controls(userId)) invalid();
  if (hash !== undefined && hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) invalid();
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)) invalid();
}
function time(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
async function row(db: NativeHealthChannelDatabase, userId: string): Promise<ChannelRow | null> {
  return db.prepare(`SELECT c.revision,c.device_id AS deviceId,c.last_device_id AS lastDeviceId,c.updated_at AS updatedAt,
    d.label,d.token_hash AS tokenHash,d.revoked_at AS revokedAt
    FROM native_health_channels c LEFT JOIN sync_devices d ON d.id=c.device_id AND d.user_id=c.user_id
    WHERE c.user_id=?`).bind(userId).first<ChannelRow>();
}
function state(value: ChannelRow | null, hash?: string | null): NativeHealthChannelState {
  return { revision: value?.revision ?? 0, deviceId: value?.deviceId ?? null, label: value?.deviceId ? value.label : null,
    updatedAt: value?.updatedAt ?? null,
    isCurrentDevice: !!(value?.deviceId && hash && value.tokenHash === hash && value.revokedAt === null) };
}
export async function readNativeHealthChannel(db: NativeHealthChannelDatabase, userId: string, deviceTokenHash?: string | null): Promise<NativeHealthChannelState> {
  validate(userId, deviceTokenHash);
  return state(await row(db, userId), deviceTokenHash);
}
/** Import code snapshots this revision even while inactive, preventing ABA after a clear. */
export async function readNativeHealthChannelPolicy(db: NativeHealthChannelDatabase, userId: string): Promise<NativeHealthChannelPolicy> {
  const current = await row(db, userId);
  return { revision: current?.revision ?? 0, deviceId: current?.deviceId ?? null,
    live: !!(current?.deviceId && current.tokenHash && current.revokedAt === null) };
}
const revisionGuard = `COALESCE((SELECT revision FROM native_health_channels WHERE user_id=?),0)=?`;
export async function selectNativeHealthChannel(db: NativeHealthChannelDatabase, userId: string,
  input: { deviceTokenHash: string; label: string; expectedRevision: number }, now = new Date().toISOString()): Promise<NativeHealthChannelState> {
  validate(userId, input.deviceTokenHash, input.expectedRevision); time(now);
  if (typeof input.expectedRevision !== 'number') invalid();
  if (!input.deviceTokenHash || typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 40
    || controls(input.label)) invalid();
  const current = await row(db, userId);
  // An exact retry identifies the same durable connection and does not rename,
  // reselect or increment it, even when the original success response was lost.
  if (current?.deviceId && current.tokenHash === input.deviceTokenHash) {
    if (current.revokedAt !== null) throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_DEVICE_INVALID');
    return state(current, input.deviceTokenHash);
  }
  if ((current?.revision ?? 0) !== input.expectedRevision) throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_STALE');
  const existing = await db.prepare('SELECT id FROM sync_devices WHERE token_hash=? LIMIT 1').bind(input.deviceTokenHash).first<{ id: string }>();
  if (existing) throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_DEVICE_INVALID');
  const deviceId = crypto.randomUUID(), next = input.expectedRevision + 1;
  await db.batch([
    db.prepare(`INSERT INTO sync_devices(id,user_id,label,token_hash,created_at)
      SELECT ?,?,?,?,? WHERE ${revisionGuard} AND NOT EXISTS(SELECT 1 FROM sync_devices WHERE token_hash=?)`)
      .bind(deviceId, userId, input.label.trim(), input.deviceTokenHash, now, userId, input.expectedRevision, input.deviceTokenHash),
    db.prepare(`INSERT INTO native_health_channels(user_id,device_id,last_device_id,revision,created_at,updated_at)
      SELECT ?,?,?,?,?,? WHERE ${revisionGuard} AND EXISTS(SELECT 1 FROM sync_devices WHERE id=? AND user_id=? AND revoked_at IS NULL)
      ON CONFLICT(user_id) DO UPDATE SET device_id=excluded.device_id,last_device_id=excluded.last_device_id,
        revision=excluded.revision,updated_at=excluded.updated_at WHERE native_health_channels.revision=?`)
      .bind(userId, deviceId, deviceId, next, now, now, userId, input.expectedRevision, deviceId, userId, input.expectedRevision),
    db.prepare(`UPDATE sync_devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?
      AND EXISTS(SELECT 1 FROM native_health_channels WHERE user_id=? AND device_id=? AND revision=?)`)
      .bind(now, current?.deviceId ?? null, userId, userId, deviceId, next),
  ]);
  const saved = await row(db, userId);
  if (saved?.deviceId && saved.tokenHash === input.deviceTokenHash && saved.revokedAt === null) return state(saved, input.deviceTokenHash);
  throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_STALE');
}
export async function clearNativeHealthChannel(db: NativeHealthChannelDatabase, userId: string,
  input: { deviceTokenHash: string; expectedRevision: number }, now = new Date().toISOString()): Promise<NativeHealthChannelState> {
  validate(userId, input.deviceTokenHash, input.expectedRevision); time(now);
  if (typeof input.expectedRevision !== 'number') invalid();
  if (!input.deviceTokenHash) invalid();
  const current = await row(db, userId);
  if (!current) {
    if (input.expectedRevision !== 0) throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_STALE');
    return state(null);
  }
  const device = await db.prepare('SELECT id FROM sync_devices WHERE user_id=? AND token_hash=? LIMIT 1')
    .bind(userId, input.deviceTokenHash).first<{ id: string }>();
  if (!device || device.id !== (current.deviceId ?? current.lastDeviceId)) throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_NOT_CURRENT');
  if (current.deviceId === null) return state(current);
  if (current.revision !== input.expectedRevision) throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_STALE');
  await db.batch([
    db.prepare(`UPDATE native_health_channels SET device_id=NULL,revision=revision+1,updated_at=?
      WHERE user_id=? AND revision=? AND device_id=?`)
      .bind(now, userId, input.expectedRevision, device.id),
    db.prepare(`UPDATE sync_devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?
      AND EXISTS(SELECT 1 FROM native_health_channels WHERE user_id=? AND device_id IS NULL AND last_device_id=? AND revision=?)`)
      .bind(now, device.id, userId, userId, device.id, input.expectedRevision + 1),
  ]);
  const saved = await row(db, userId);
  if (saved?.deviceId === null && saved.lastDeviceId === device.id) return state(saved);
  throw new NativeHealthChannelError('NATIVE_HEALTH_CHANNEL_STALE');
}
