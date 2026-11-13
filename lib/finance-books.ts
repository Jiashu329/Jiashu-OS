import { normalizeAccessEmail, validAccessUserId } from './access-control.ts';

export interface FinanceBookActor { userId: string; email: string; displayName?: string; isOwner?: boolean }
export interface FinanceBookScope {
  actorUserId: string; actorEmail: string; actorName: string; ownerUserId: string;
  ledger: 'personal' | 'family'; bookId: string | null; role: 'owner' | 'editor';
  membershipId: string | null; accessRevision: number; isSiteOwner: boolean;
}
export type FinanceBookMemberStatus = 'pending' | 'active' | 'revoked' | 'declined';
export interface FinanceBookMember {
  id: string; bookId: string; email: string; status: FinanceBookMemberStatus; revision: number;
  expiresAt: string; acceptedAt: string | null; createdAt: string; updatedAt: string; bound: boolean;
}
export interface FinanceBookChoice {
  id: string; name: string; ownerName: string; role: 'owner' | 'editor'; accessRevision: number;
  canManageMembers: boolean; canExport: boolean;
}
export interface FinanceBookInvitation {
  id: string; bookId: string; bookName: string; ownerName: string; email: string; revision: number; expiresAt: string;
}
export interface FinanceBookPublic {
  id: string; name: string; ownerName: string; createdAt: string | null; updatedAt: string | null;
}
export class FinanceBookError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) { super(message); this.code = code; this.status = status; this.name = 'FinanceBookError'; }
}
export function financeBookAccessRevoked(): FinanceBookError {
  return new FinanceBookError('FINANCE_BOOK_ACCESS_REVOKED', 403, '此家庭账本的访问权限已撤销或尚未接受邀请，请重新选择账本。');
}
export function financeBookAccessChanged(): FinanceBookError {
  return new FinanceBookError('FINANCE_BOOK_ACCESS_CHANGED', 409, '家庭账本访问版本已变化，请重新读取账本后核对原操作。');
}
export function normalizeFinanceBookActor(actor: FinanceBookActor): FinanceBookActor & { displayName: string } {
  if (!validAccessUserId(actor?.userId)) throw new FinanceBookError('SIGN_IN_REQUIRED', 401, '请先登录后查看家庭账本。');
  let email: string;
  try { email = normalizeAccessEmail(actor.email); } catch { throw new FinanceBookError('FINANCE_BOOK_IDENTITY_INVALID', 401, '当前账户邮箱无法核对，请重新登录。'); }
  const name = typeof actor.displayName === 'string' ? Array.from(actor.displayName).filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').trim().slice(0, 200) : '';
  return { userId: actor.userId, email, displayName: name || email, isOwner: actor.isOwner === true };
}
export function parseFinanceBookId(value: unknown, allowOwn = true): string {
  if (allowOwn && (value === undefined || value === null || value === '' || value === 'own')) return 'own';
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '请选择有效的家庭账本或操作标识。');
  }
  return value.toLowerCase();
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '家庭成员操作格式不正确。');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key))) throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '家庭成员操作含缺少或不支持的字段。');
  return raw;
}
export function parseFinanceBookInvite(value: unknown): { email: string } {
  const raw = exact(value, ['email']);
  try { return { email: normalizeAccessEmail(raw.email) }; } catch { throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '请输入有效的受邀账户邮箱。'); }
}
export function parseFinanceBookMemberAction(value: unknown, actions: readonly string[]): { action: string; expectedRevision: number } {
  const raw = exact(value, ['action', 'expectedRevision']);
  if (typeof raw.action !== 'string' || !actions.includes(raw.action) || !Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1 || Number(raw.expectedRevision) >= Number.MAX_SAFE_INTEGER) throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '请读取成员最新状态后再选择操作。');
  return { action: raw.action, expectedRevision: Number(raw.expectedRevision) };
}
