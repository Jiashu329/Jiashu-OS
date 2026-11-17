import { normalizeAccessEmail, validAccessUserId } from './access-control.ts';

// Reserved for the self-host gateway, which replaces all incoming x-auth headers.
export const LOCAL_ACCOUNT_REVISION_HEADER = 'x-auth-local-account-revision';

export type LocalUserStatus = 'active' | 'disabled';
/** Internal authentication record. Never serialize this record into a response. */
export interface LocalUser {
  id: string;
  email: string;
  passwordHash: string;
  status: LocalUserStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}
export interface PublicLocalUser extends Omit<LocalUser, 'passwordHash'> { isAdmin: boolean }
export interface NewLocalUser { id: string; email: string; passwordHash: string }
export interface LocalUserUpdate { expectedRevision: number; email?: string; passwordHash?: string; status?: LocalUserStatus }
export type LocalUserErrorCode = 'LOCAL_USER_INVALID' | 'LOCAL_USER_DUPLICATE' | 'LOCAL_USER_STALE' | 'LOCAL_USER_NOT_FOUND' | 'LOCAL_USER_OWNER_PROTECTED' | 'LOCAL_USER_BOOTSTRAP_CONFLICT';
const errors = {
  LOCAL_USER_INVALID: [400, '用户配置格式不正确，请检查邮箱和密码。'],
  LOCAL_USER_DUPLICATE: [409, '该邮箱或用户已存在，请检查用户列表。'],
  LOCAL_USER_STALE: [409, '用户配置已更新，请刷新后重试。'],
  LOCAL_USER_NOT_FOUND: [404, '找不到该用户，请刷新用户列表。'],
  LOCAL_USER_OWNER_PROTECTED: [400, '管理员账号不能停用。'],
  LOCAL_USER_BOOTSTRAP_CONFLICT: [409, '本地用户与管理员配置不一致，请检查服务器配置。'],
} as const;
export class LocalUserError extends Error {
  readonly code: LocalUserErrorCode;
  readonly status: number;
  constructor(code: LocalUserErrorCode) {
    super(errors[code][1]); this.name = 'LocalUserError'; this.code = code; this.status = errors[code][0];
  }
}

export function normalizeLocalEmail(input: unknown): string {
  try { return normalizeAccessEmail(input); }
  catch { throw new LocalUserError('LOCAL_USER_INVALID'); }
}

/** The existing scrypt-v1 encoding, including canonical 16/64-byte base64url. */
export function validLocalPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && /^scrypt-v1\$32768\$8\$1\$[A-Za-z0-9_-]{21}[AQgw]\$[A-Za-z0-9_-]{85}[AQgw]$/.test(value);
}

export function localUserId(value: unknown): string {
  if (!validAccessUserId(value)) throw new LocalUserError('LOCAL_USER_INVALID');
  return value;
}

export function localUserTime(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== value) throw new LocalUserError('LOCAL_USER_INVALID');
  return value;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new LocalUserError('LOCAL_USER_INVALID');
  return input as Record<string, unknown>;
}

export function parseNewLocalUser(input: unknown, owner = false): NewLocalUser {
  const value = object(input);
  if (Object.keys(value).length !== 3 || Object.keys(value).some(key => !['id', 'email', 'passwordHash'].includes(key)) || !validLocalPasswordHash(value.passwordHash)) throw new LocalUserError('LOCAL_USER_INVALID');
  const id = localUserId(value.id);
  if (!owner && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new LocalUserError('LOCAL_USER_INVALID');
  return { id, email: normalizeLocalEmail(value.email), passwordHash: value.passwordHash };
}

export function parseLocalUserUpdate(input: unknown): LocalUserUpdate {
  const value = object(input), keys = Object.keys(value);
  if (keys.length < 2 || keys.some(key => !['expectedRevision', 'email', 'passwordHash', 'status'].includes(key)) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1 || Number(value.expectedRevision) >= Number.MAX_SAFE_INTEGER) throw new LocalUserError('LOCAL_USER_INVALID');
  const patch: LocalUserUpdate = { expectedRevision: Number(value.expectedRevision) };
  if (Object.hasOwn(value, 'email')) patch.email = normalizeLocalEmail(value.email);
  if (Object.hasOwn(value, 'passwordHash')) {
    if (!validLocalPasswordHash(value.passwordHash)) throw new LocalUserError('LOCAL_USER_INVALID');
    patch.passwordHash = value.passwordHash;
  }
  if (Object.hasOwn(value, 'status')) {
    if (value.status !== 'active' && value.status !== 'disabled') throw new LocalUserError('LOCAL_USER_INVALID');
    patch.status = value.status;
  }
  return patch;
}

export function publicLocalUser(record: Omit<LocalUser, 'passwordHash'>, ownerId: string): PublicLocalUser {
  // Explicit fields prevent a password hash (or future secret columns) from
  // entering a public response even when passed a complete internal record.
  return { id: record.id, email: record.email, status: record.status, revision: record.revision, isAdmin: record.id === ownerId,
    createdAt: record.createdAt, updatedAt: record.updatedAt, lastLoginAt: record.lastLoginAt };
}
