import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationsHandlers } from './notifications-api.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationsError, type NotificationFeed } from './notifications.ts';

function fixture() {
  let signedIn = true;
  const calls: Array<{ action: string; actor: string; input?: unknown }> = [];
  const feed: NotificationFeed = { items: [], total: 0, unreadCount: 2, unreadIds: ['sync:a','sync:b'], offset: 0, limit: 20, hasMore: false, unavailable: [], truncated: false, settings: { categories: { ...DEFAULT_NOTIFICATION_PREFERENCES }, revision: 0, updatedAt: null } };
  const handlers = createNotificationsHandlers({
    user: async () => signedIn ? { userId: 'alice', email: 'alice@example.test', displayName: 'Alice' } : null,
    database: () => ({}) as D1Database,
    json: (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }),
    operations: {
      async read(_db, actor, options) { calls.push({ action: 'read', actor: actor.userId, input: options }); return feed; },
      async mark(_db, actor, input) { calls.push({ action: 'mark', actor: actor.userId, input }); if (Array.isArray(input) && input.includes('sync:foreign')) throw new NotificationsError('Not visible', 'NOTIFICATION_NOT_FOUND', 404); return { ok: true as const, readCount: input === 'all' ? 2 : input.length }; },
      async settings(_db, actor, categories, revision) { calls.push({ action: 'settings', actor, input: { categories, revision } }); return { settings: { categories, revision: revision + 1, updatedAt: '2026-11-14T00:00:00Z' }, replayed: false }; },
    },
  });
  const request = (method: string, query = '', value?: unknown, headers: Record<string, string> = {}) => new Request('https://notifications.test/api/notifications' + query, { method, headers: { ...(method === 'POST' ? { Origin: 'https://notifications.test', 'X-Page-Owner': 'alice', 'Content-Type': 'application/json' } : {}), ...headers }, ...(method === 'POST' ? { body: typeof value === 'string' ? value : JSON.stringify(value) } : {}) });
  return { calls, signOut() { signedIn = false; }, get(query = '', headers?: Record<string, string>) { return handlers.GET(request('GET', query, undefined, headers)); }, post(input: unknown, headers?: Record<string, string>) { return handlers.POST(request('POST', '', input, headers)); } };
}

test('message reads require the current identity and never dispatch read-state mutations', async () => {
  const f = fixture();
  const summary = await f.get('?summary=1');
  assert.equal(summary.status, 200); assert.deepEqual(await summary.json(), { unreadCount: 2, unavailable: [], truncated: false });
  assert.equal(summary.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'read');
  assert.equal((await f.get('', { 'X-Page-Owner': 'bob' })).status, 401);
  f.signOut(); assert.equal((await f.get()).status, 401); assert.equal(f.calls.length, 1);
});

test('malformed queries and cross-origin, stale-page or oversized writes fail before source reads or mutations', async () => {
  const f = fixture();
  for (const query of ['?unread=0', '?summary=1&offset=0', '?unread=1&unread=1', '?limit=51', '?offset=-1', '?offset=1001', '?scope=bob']) assert.equal((await f.get(query)).status, 400, query);
  assert.equal((await f.post({ action: 'readAll' }, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await f.post({ action: 'readAll' }, { 'X-Page-Owner': 'bob' })).status, 401);
  assert.equal((await f.post({ action: 'readAll' }, { 'X-Page-Owner': '' })).status, 401);
  assert.equal((await f.post({ action: 'readAll' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('bad-json')).status, 400);
  assert.equal((await f.post({ action: 'read', ids: ['x'.repeat(9000)] })).status, 413);
  assert.equal(f.calls.length, 0);
});

test('only explicit validated message operations reach the current actor and unauthorized IDs remain unavailable', async () => {
  const f = fixture();
  for (const body of [{ action: 'read', ids: [] }, { action: 'read', ids: ['sync:a', 'sync:a'] }, { action: 'readAll', userId: 'bob' }, { action: 'settings', categories: {}, expectedRevision: 0 }, { action: 'read', ids: ['<script>'] }]) assert.equal((await f.post(body)).status, 400);
  assert.equal((await f.post({ action: 'read', ids: ['sync:foreign'] })).status, 404);
  assert.equal((await f.post({ action: 'read', ids: ['sync:a'] })).status, 200);
  assert.equal((await f.post({ action: 'readAll' })).status, 200);
  assert.equal((await f.post({ action: 'settings', categories: DEFAULT_NOTIFICATION_PREFERENCES, expectedRevision: 0 })).status, 200);
  assert.ok(f.calls.every((call) => call.actor === 'alice'));
});
