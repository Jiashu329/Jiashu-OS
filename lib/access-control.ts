export type AccessGrantStatus = 'active' | 'revoked';
export interface AccessGrant {
  id: string;
  email: string;
  boundUserId: string | null;
  status: AccessGrantStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}
export interface AccessOwnerContext { actorUserId: string; ownerUserId: string | undefined; ownerEmail?: string }
export interface AccessIdentity { userId: string; email: string }
export type AccessResolution = { allowed: true; isOwner: boolean } | { allowed: false; isOwner: false; reason: 'unconfigured' | 'not_invited' | 'revoked' | 'identity_conflict' };
export class AccessValidationError extends Error { readonly code = 'INVALID_ACCESS_REQUEST'; readonly status = 400; constructor(message: string) { super(message); this.name = 'AccessValidationError'; } }
export class AccessConfigurationError extends Error { readonly code = 'ACCESS_NOT_CONFIGURED'; readonly status = 503; constructor() { super('访问名单尚未完成服务端配置。'); this.name = 'AccessConfigurationError'; } }
export class AccessForbiddenError extends Error { readonly code = 'ACCESS_OWNER_REQUIRED'; readonly status = 403; constructor() { super('只有创建者可以管理允许访问的成员。'); this.name = 'AccessForbiddenError'; } }
export class AccessConflictError extends Error { readonly code = 'ACCESS_GRANT_CONFLICT'; readonly status = 409; constructor(message = '成员状态已变化，请读取最新名单后核对再提交。') { super(message); this.name = 'AccessConflictError'; } }
export class AccessNotFoundError extends Error { readonly code = 'ACCESS_GRANT_NOT_FOUND'; readonly status = 404; constructor() { super('找不到这条成员配置，请刷新名单。'); this.name = 'AccessNotFoundError'; } }

function controls(value: string) { for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); if (code < 32 || code === 127) return true; } return false; }
export function configuredAccessOwner(ownerId: unknown): string | null {
  if (typeof ownerId !== 'string') return null;
  const value = ownerId.trim();
  return value.length && value.length <= 512 && !controls(value) ? value : null;
}
export function assertAccessOwner(actorId: string, ownerId: unknown): string {
  const configured = configuredAccessOwner(ownerId);
  if (!configured) throw new AccessConfigurationError();
  if (actorId !== configured) throw new AccessForbiddenError();
  return configured;
}
export function validAccessUserId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && !controls(value); }
export function normalizeAccessEmail(input: unknown): string {
  if (typeof input !== 'string' || input.length > 320 || controls(input)) throw new AccessValidationError('请输入有效的登录邮箱。');
  const email = input.trim().toLowerCase();
  const pieces = email.split('@');
  if (email.length > 254 || pieces.length !== 2) throw new AccessValidationError('请输入有效的登录邮箱。');
  const [local, domain] = pieces;
  const labels = domain.split('.');
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || labels.length < 2 || labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new AccessValidationError('请输入有效的登录邮箱。');
  return email;
}
export function parseAccessOperationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new AccessValidationError('这次操作缺少有效标识，请重新打开成员设置后提交。');
  return value.toLowerCase();
}
function exact(input: unknown, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new AccessValidationError('成员配置格式不正确。');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new AccessValidationError('成员配置包含缺少或不支持的字段。');
  return value;
}
export function parseAccessInvite(input: unknown): { email: string } { const value = exact(input, ['email']); return { email: normalizeAccessEmail(value.email) }; }
export function parseAccessStatus(input: unknown): { status: AccessGrantStatus; expectedRevision: number } {
  const value = exact(input, ['status', 'expectedRevision']);
  if (value.status !== 'active' && value.status !== 'revoked') throw new AccessValidationError('请选择启用或停用。');
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new AccessValidationError('请先读取成员的最新状态。');
  return { status: value.status, expectedRevision: Number(value.expectedRevision) };
}
export function presentAccessGrant(grant: AccessGrant) {
  const { boundUserId, ...visible } = grant;
  return { ...visible, bound: boundUserId !== null };
}
