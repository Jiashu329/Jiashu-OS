import { shanghaiDay } from '../lib/health.ts';
import { normalizeFinanceBookActor, type FinanceBookActor } from '../lib/finance-books.ts';
import { listFinanceBookActivity } from './finance-book-activity-store.ts';
import {
  DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_CATEGORIES, NotificationsError, parseNotificationMutation,
  type NotificationCategory, type NotificationFeed, type NotificationItem, type NotificationPreferences, type NotificationSettings,
} from '../lib/notifications.ts';

export type NotificationsDatabase = Pick<D1Database, 'prepare' | 'batch'>;
type FeedItem = Omit<NotificationItem, 'readAt'>;
export const MAX_NOTIFICATION_FEED = 100;
function instant(now: string) { const result = new Date(now); if (!Number.isFinite(result.getTime())) throw new NotificationsError('消息读取时间无效。'); return result.toISOString(); }
function safeText(value: string, max = 200) { return Array.from(value).filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, max); }
function same(a: NotificationPreferences, b: NotificationPreferences) { return NOTIFICATION_CATEGORIES.every((key) => a[key] === b[key]); }

export async function readNotificationSettings(db: NotificationsDatabase, userId: string): Promise<NotificationSettings> {
  const row = await db.prepare('SELECT settings_json AS settingsJson,revision,updated_at AS updatedAt FROM notification_preferences WHERE user_id=?').bind(userId).first<{ settingsJson: string; revision: number; updatedAt: string }>();
  if (!row) return { categories: { ...DEFAULT_NOTIFICATION_PREFERENCES }, revision: 0, updatedAt: null };
  const value = parseNotificationMutation({ action: 'settings', categories: JSON.parse(row.settingsJson), expectedRevision: row.revision });
  if (value.action !== 'settings') throw new Error('Invalid notification settings');
  return { categories: value.categories, revision: row.revision, updatedAt: row.updatedAt };
}

export async function writeNotificationSettings(db: NotificationsDatabase, userId: string, categories: NotificationPreferences, expectedRevision: number, now = new Date().toISOString()) {
  const parsed = parseNotificationMutation({ action: 'settings', categories, expectedRevision });
  if (parsed.action !== 'settings') throw new NotificationsError('提醒设置格式不正确。');
  const timestamp = instant(now), previous = await readNotificationSettings(db, userId);
  if (previous.revision === expectedRevision + 1 && same(previous.categories, categories)) return { settings: previous, replayed: true };
  if (previous.revision !== expectedRevision) throw new NotificationsError('提醒设置已在另一页面更新，请读取最新版本后核对。', 'NOTIFICATIONS_SETTINGS_CHANGED', 409);
  const result = expectedRevision === 0
    ? await db.prepare('INSERT INTO notification_preferences(user_id,settings_json,revision,updated_at) VALUES (?,?,1,?) ON CONFLICT(user_id) DO NOTHING').bind(userId, JSON.stringify(parsed.categories), timestamp).run()
    : await db.prepare('UPDATE notification_preferences SET settings_json=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?').bind(JSON.stringify(parsed.categories), timestamp, userId, expectedRevision).run();
  const saved = await readNotificationSettings(db, userId);
  if (saved.revision !== expectedRevision + 1 || !same(saved.categories, categories)) throw new NotificationsError('提醒设置已变化，未覆盖其他页面内容，请重新核对。', 'NOTIFICATIONS_SETTINGS_CHANGED', 409);
  return { settings: saved, replayed: result.meta.changes !== 1 };
}

async function invitations(db: NotificationsDatabase, actor: ReturnType<typeof normalizeFinanceBookActor>, now: string): Promise<FeedItem[]> {
  const rows = await db.prepare(`SELECT m.id,m.revision,m.created_at AS createdAt,m.expires_at AS expiresAt,b.owner_name AS ownerName,b.name AS bookName
    FROM family_book_members m JOIN family_books b ON b.id=m.book_id
    WHERE m.email=? AND m.status='pending' AND m.expires_at>? AND (m.user_id IS NULL OR m.user_id=?) AND b.owner_user_id<>?
    ORDER BY m.created_at DESC,m.id DESC LIMIT 20`).bind(actor.email, now, actor.userId, actor.userId)
    .all<{ id: string; revision: number; createdAt: string; expiresAt: string; ownerName: string; bookName: string }>();
  return rows.results.map((row) => ({ id: `invite:${row.id}:${row.revision}`, category: 'invitations', title: '收到家庭账本邀请',
    summary: `${safeText(row.ownerName)}邀请你加入「${safeText(row.bookName)}」，请在家庭账本中接受或婉拒。`, href: '/finance?ledger=family', createdAt: row.createdAt }));
}
async function collaboration(db: NotificationsDatabase, actor: ReturnType<typeof normalizeFinanceBookActor>) {
  const books = await db.prepare(`SELECT b.id,0 AS accessRevision FROM family_books b WHERE b.owner_user_id=?
    UNION SELECT b.id,m.revision AS accessRevision FROM family_books b JOIN family_book_members m ON m.book_id=b.id
    WHERE m.user_id=? AND m.status='active' AND b.owner_user_id<>? ORDER BY id LIMIT 10`).bind(actor.userId, actor.userId, actor.userId).all<{ id: string; accessRevision: number }>();
  const results = await Promise.allSettled(books.results.map(async (book) => {
    const feed = await listFinanceBookActivity(db, actor, book.id, { offset: 0, limit: 5, accessRevision: book.accessRevision, excludeActor: true });
    const query = new URLSearchParams({ ledger: 'family', book: book.id, bookRevision: String(book.accessRevision) });
    return { items: feed.items.map((item): FeedItem => ({ id: `activity:${book.id}:${item.id}`, category: 'collaboration', title: '家庭账本有新变更',
      summary: safeText(item.actorName + item.summary + (item.targetName ? '「' + item.targetName + '」' : ''), 400), href: '/finance/activity?' + query, createdAt: item.createdAt })), truncated: feed.hasMore };
  }));
  const items: FeedItem[] = []; let truncated = false;
  for (const result of results) {
    if (result.status === 'fulfilled') { items.push(...result.value.items); truncated ||= result.value.truncated; }
    else if (!['FINANCE_BOOK_ACCESS_REVOKED', 'FINANCE_BOOK_ACCESS_CHANGED'].includes((result.reason as { code?: string })?.code ?? '')) throw result.reason;
  }
  return { items, truncated: truncated || books.results.length === 10 };
}
async function syncFailures(db: NotificationsDatabase, actor: ReturnType<typeof normalizeFinanceBookActor>, now: string): Promise<FeedItem[]> {
  const from = new Date(Date.parse(now) - 30 * 86400000).toISOString();
  const rows = await db.prepare(`SELECT s.attempt_id AS id,s.created_at AS createdAt FROM health_sync_attempts s
    WHERE s.user_id=? AND s.status='failed' AND s.created_at>=? AND NOT EXISTS(
      SELECT 1 FROM health_sync_attempts n WHERE n.user_id=s.user_id AND n.channel=s.channel AND n.device_label IS s.device_label
      AND n.created_at>s.created_at AND n.status IN ('success','unchanged','duplicate'))
    ORDER BY s.created_at DESC,s.attempt_id DESC LIMIT 20`).bind(actor.userId, from).all<{ id: string; createdAt: string }>();
  return rows.results.map((row) => ({ id: 'sync:' + row.id, category: 'sync', title: '同步结果需要核对',
    summary: '一次同步尝试未确认完成，请打开同步页查看安全诊断并核对结果。', href: '/sync', createdAt: row.createdAt }));
}
async function balances(db: NotificationsDatabase, actor: ReturnType<typeof normalizeFinanceBookActor>, now: string): Promise<FeedItem[]> {
  const today = shanghaiDay(now), month = today.slice(0, 7), first = month + '-01';
  const rows = await db.prepare(`SELECT a.ledger,COUNT(*) AS missing FROM finance_accounts a
    WHERE a.user_id=? AND a.archived_at IS NULL AND NOT EXISTS(
      SELECT 1 FROM finance_balance_entries e LEFT JOIN finance_balance_changes c ON c.user_id=e.user_id AND c.entry_id=e.id
      AND c.revision=(SELECT MAX(x.revision) FROM finance_balance_changes x WHERE x.user_id=e.user_id AND x.entry_id=e.id)
      WHERE e.user_id=a.user_id AND e.account_id=a.id AND (c.action IS NULL OR c.action<>'void')
      AND COALESCE(c.as_of_date,e.as_of_date)>=? AND COALESCE(c.as_of_date,e.as_of_date)<=?)
    GROUP BY a.ledger ORDER BY a.ledger`).bind(actor.userId, first, today).all<{ ledger: string; missing: number }>();
  return rows.results.filter((row) => ['personal', 'family'].includes(row.ledger) && row.missing > 0).map((row) => ({ id: `balance:${row.ledger}:${month}`, category: 'balances', title: '本月余额待核对',
    summary: `${row.ledger === 'family' ? '自有家庭' : '个人'}账本有${row.missing}个账户本月尚未核对余额。`, href: '/finance/balances?' + new URLSearchParams({ ledger: row.ledger }), createdAt: new Date(first + 'T00:00:00+08:00').toISOString() }));
}

/** A bounded live feed is rebuilt under current authorization; no message body is cached across membership changes. */
export async function readNotifications(db: NotificationsDatabase, value: FinanceBookActor, options: { unread?: boolean; offset?: number; limit?: number } = {}, now = new Date().toISOString()): Promise<NotificationFeed> {
  const actor = normalizeFinanceBookActor(value), timestamp = instant(now), settings = await readNotificationSettings(db, actor.userId);
  const offset = options.offset ?? 0, limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new NotificationsError('消息分页参数不正确。');
  const unavailable: NotificationCategory[] = []; let truncated = false;
  const loaders: Record<NotificationCategory, () => Promise<{ items: FeedItem[]; truncated?: boolean }>> = {
    invitations: async () => ({ items: await invitations(db, actor, timestamp) }), collaboration: () => collaboration(db, actor),
    sync: async () => ({ items: await syncFailures(db, actor, timestamp) }), balances: async () => ({ items: await balances(db, actor, timestamp) }),
  };
  const sources = await Promise.all(NOTIFICATION_CATEGORIES.filter((category) => settings.categories[category]).map(async (category) => {
    try { const result = await loaders[category](); truncated ||= result.truncated === true; return result.items; }
    catch { unavailable.push(category); return []; }
  }));
  const unique = new Map<string, FeedItem>(); for (const item of sources.flat()) unique.set(item.id, item);
  const sorted = [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  truncated ||= sorted.length > MAX_NOTIFICATION_FEED;
  const current = sorted.slice(0, MAX_NOTIFICATION_FEED);
  const reads = current.length ? await db.prepare('SELECT notification_id AS id,read_at AS readAt FROM notification_read_states WHERE user_id=? AND notification_id IN (SELECT value FROM json_each(?))')
    .bind(actor.userId, JSON.stringify(current.map((item) => item.id))).all<{ id: string; readAt: string }>() : { results: [] };
  const readById = new Map(reads.results.map((row) => [row.id, row.readAt]));
  const all = current.map((item): NotificationItem => ({ ...item, readAt: readById.get(item.id) ?? null }));
  const unread = all.filter((item) => item.readAt === null), unreadIds = unread.map((item) => item.id);
  const unreadCount = unreadIds.length, filtered = options.unread ? unread : all;
  return { items: filtered.slice(offset, offset + limit), total: filtered.length, unreadCount, unreadIds, offset, limit, hasMore: offset + limit < filtered.length, unavailable, truncated, settings };
}

export async function markNotificationsRead(db: NotificationsDatabase, actor: FinanceBookActor, ids: string[] | 'all', now = new Date().toISOString()) {
  const timestamp = instant(now), feed = await readNotifications(db, actor, { limit: MAX_NOTIFICATION_FEED }, timestamp);
  const visible = new Set(feed.items.map((item) => item.id)), selected = ids === 'all' ? feed.items.filter((item) => item.readAt === null).map((item) => item.id) : ids;
  if (selected.some((id) => !visible.has(id))) throw new NotificationsError('这条消息已失效或不属于当前账户，请刷新消息列表。', 'NOTIFICATION_NOT_FOUND', 404);
  if (selected.length) await db.prepare('INSERT INTO notification_read_states(user_id,notification_id,read_at) SELECT ?,value,? FROM json_each(?) WHERE 1 ON CONFLICT(user_id,notification_id) DO NOTHING').bind(actor.userId, timestamp, JSON.stringify(selected)).run();
  return { ok: true, readCount: selected.length };
}
