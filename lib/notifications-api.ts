import type { FinanceBookActor } from './finance-books.ts';
import { NotificationsError, parseNotificationMutation, parseNotificationsQuery } from './notifications.ts';
import { markNotificationsRead, readNotifications, writeNotificationSettings, type NotificationsDatabase } from '../db/notifications-store.ts';

interface Dependencies {
  unauthenticated?(message?: string): Response | Promise<Response>;
  user(): Promise<FinanceBookActor | null>;
  database(): NotificationsDatabase;
  json(value: unknown, status?: number): Response;
  now?(): string;
  operations?: { read: typeof readNotifications; mark: typeof markNotificationsRead; settings: typeof writeNotificationSettings };
}
async function body(request: Request) {
  const maximum = 8192;
  if (Number(request.headers.get('Content-Length')) > maximum) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader(), decoder = new TextDecoder(); let bytes = 0, result = '';
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new RangeError(); }
      result += decoder.decode(item.value, { stream: true });
    }
    return JSON.parse(result + decoder.decode()) as unknown;
  } finally { reader.releaseLock(); }
}

export function createNotificationsHandlers(deps: Dependencies) {
  const ops = deps.operations ?? { read: readNotifications, mark: markNotificationsRead, settings: writeNotificationSettings };
  const failure = (error: unknown) => {
    if (error instanceof NotificationsError) return deps.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof SyntaxError) return deps.json({ error: '消息操作不是有效的 JSON。', code: 'NOTIFICATIONS_INVALID' }, 400);
    if (error instanceof RangeError) return deps.json({ error: '消息操作内容过大。', code: 'NOTIFICATIONS_TOO_LARGE' }, 413);
    return deps.json({ error: '消息暂时无法读取，请稍后重试。', code: 'NOTIFICATIONS_UNAVAILABLE' }, 503);
  };
  async function actor(request: Request, write = false): Promise<FinanceBookActor | Response> {
    const user = await deps.user();
    if (!user) return deps.unauthenticated ? deps.unauthenticated('请先登录网站，再查看消息。') : deps.json({ error: '请先登录网站，再查看消息。', code: 'SIGN_IN_REQUIRED' }, 401);
    const owner = request.headers.get('X-Page-Owner');
    if ((write && !owner) || owner && owner !== user.userId) return deps.json({ error: '请刷新已登录页面后继续当前账户的操作。', code: 'ACCOUNT_CHANGED' }, 401);
    return user;
  }
  return {
    async GET(request: Request) {
      try {
        const user = await actor(request); if (user instanceof Response) return user;
        const query = parseNotificationsQuery(new URL(request.url).searchParams);
        const feed = await ops.read(deps.database(), user, query, deps.now?.());
        return deps.json(query.summary ? { unreadCount: feed.unreadCount, unavailable: feed.unavailable, truncated: feed.truncated } : feed);
      } catch (error) { return failure(error); }
    },
    async POST(request: Request) {
      try {
        const user = await actor(request, true); if (user instanceof Response) return user;
        if (request.headers.get('Origin') !== new URL(request.url).origin) return deps.json({ error: '请从网站内操作消息。', code: 'INVALID_ORIGIN' }, 403);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return deps.json({ error: '请通过网站提交 JSON 消息操作。', code: 'INVALID_CONTENT_TYPE' }, 415);
        const input = parseNotificationMutation(await body(request)), db = deps.database(), now = deps.now?.();
        if (input.action === 'settings') return deps.json(await ops.settings(db, user.userId, input.categories, input.expectedRevision, now));
        return deps.json(await ops.mark(db, user, input.action === 'readAll' ? 'all' : input.ids, now));
      } catch (error) { return failure(error); }
    },
  };
}
