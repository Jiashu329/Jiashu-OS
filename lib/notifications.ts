export const NOTIFICATION_CATEGORIES = ['invitations', 'collaboration', 'sync', 'balances'] as const;
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];
export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  invitations: '家庭邀请', collaboration: '协作变更', sync: '同步结果', balances: '余额核对',
};
export type NotificationPreferences = Record<NotificationCategory, boolean>;
export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({ invitations: true, collaboration: true, sync: true, balances: true });
export interface NotificationSettings { categories: NotificationPreferences; revision: number; updatedAt: string | null }
export interface NotificationItem {
  id: string; category: NotificationCategory; title: string; summary: string; href: string; createdAt: string; readAt: string | null;
}
export interface NotificationFeed {
  items: NotificationItem[]; total: number; unreadCount: number; unreadIds: string[]; offset: number; limit: number; hasMore: boolean;
  unavailable: NotificationCategory[]; truncated: boolean; settings: NotificationSettings;
}
export class NotificationsError extends Error {
  readonly code: string; readonly status: number;
  constructor(message: string, code = 'NOTIFICATIONS_INVALID', status = 400) { super(message); this.code = code; this.status = status; this.name = 'NotificationsError'; }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new NotificationsError('请提交有效的消息操作。');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key))) throw new NotificationsError('消息操作含缺少或不支持的字段。');
  return raw;
}
export function validNotificationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[a-zA-Z0-9:._-]+$/.test(value);
}
export type NotificationMutation = { action: 'read'; ids: string[] } | { action: 'readAll' }
  | { action: 'settings'; categories: NotificationPreferences; expectedRevision: number };
export function parseNotificationMutation(value: unknown): NotificationMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotificationsError('请提交有效的消息操作。');
  const action = (value as Record<string, unknown>).action;
  if (action === 'readAll') { object(value, ['action']); return { action }; }
  if (action === 'read') {
    const raw = object(value, ['action', 'ids']);
    if (!Array.isArray(raw.ids) || raw.ids.length < 1 || raw.ids.length > 100 || raw.ids.some((id) => !validNotificationId(id)) || new Set(raw.ids).size !== raw.ids.length) throw new NotificationsError('请选择1至100条有效消息。');
    return { action, ids: raw.ids as string[] };
  }
  if (action === 'settings') {
    const raw = object(value, ['action', 'categories', 'expectedRevision']);
    const categories = object(raw.categories, NOTIFICATION_CATEGORIES);
    if (NOTIFICATION_CATEGORIES.some((category) => typeof categories[category] !== 'boolean') || !Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0 || Number(raw.expectedRevision) >= Number.MAX_SAFE_INTEGER) throw new NotificationsError('请核对提醒开关和最新版本。');
    return { action, categories: Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, categories[category]])) as NotificationPreferences, expectedRevision: Number(raw.expectedRevision) };
  }
  throw new NotificationsError('不支持这项消息操作。');
}
export function parseNotificationsQuery(params: URLSearchParams) {
  if ([...params.keys()].some((key) => !['summary', 'unread', 'offset', 'limit'].includes(key) || params.getAll(key).length !== 1)) throw new NotificationsError('消息筛选参数不正确。');
  const summary = params.get('summary');
  if (summary !== null && (summary !== '1' || params.size !== 1)) throw new NotificationsError('消息摘要参数不正确。');
  const unread = params.get('unread');
  if (unread !== null && unread !== '1') throw new NotificationsError('请选择全部或未读消息。');
  const offsetText = params.get('offset') ?? '0', limitText = params.get('limit') ?? '20';
  if (!/^(?:0|[1-9]\d*)$/.test(offsetText) || !/^[1-9]\d?$/.test(limitText)) throw new NotificationsError('消息分页参数不正确。');
  const offset = Number(offsetText), limit = Number(limitText);
  if (!Number.isSafeInteger(offset) || offset > 1000 || limit > 50) throw new NotificationsError('消息分页参数超出范围。');
  return { summary: summary === '1', unread: unread === '1', offset, limit };
}
