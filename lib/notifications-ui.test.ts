import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderNotificationsPage } from '../notifications-page.ts';
import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';
import { NOTIFICATIONS_BADGE_SCRIPT, NOTIFICATIONS_SCRIPT } from './notifications-ui.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationItem, type NotificationPreferences } from './notifications.ts';

async function settled(check: () => boolean) {
  for (let index = 0; index < 60; index++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'Notifications client did not settle');
}
function fixture() {
  const { document, window } = parseHTML(renderNotificationsPage());
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? this.querySelector('option')?.getAttribute('value') ?? ''; },
    set(value: string) { for (const option of this.querySelectorAll('option')) { if (option.getAttribute('value') === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } },
  });
  const items: NotificationItem[] = [
    { id: 'invite:one:1', category: 'invitations', title: '<img src=x onerror=bad()>邀请', summary: '家人邀请你加入家庭账本。', href: '/finance?ledger=family', createdAt: '2026-11-14T00:00:00.000Z', readAt: null },
    { id: 'sync:one', category: 'sync', title: '同步待核对', summary: '<script>bad()</script>', href: 'https://evil.example/steal', createdAt: '2026-11-14T01:00:00.000Z', readAt: null },
  ];
  const settings = { categories: { ...DEFAULT_NOTIFICATION_PREFERENCES }, revision: 0, updatedAt: null as string | null };
  let failAfterApplying = false, loadFailure = false;
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const session = { document, changed: false, async request(path: string, options: RequestInit = {}) {
    const method = options.method ?? 'GET', body = options.body ? JSON.parse(String(options.body)) as { action: string; ids?: string[]; expectedRevision?: number; categories?: NotificationPreferences } : undefined;
    calls.push({ path, method, body });
    if (method === 'POST') {
      if (body?.action === 'settings') {
        if (body.expectedRevision !== settings.revision) return Response.json({ error: '设置已被更新。', code: 'NOTIFICATIONS_SETTINGS_CHANGED' }, { status: 409 });
        settings.categories = { ...body.categories! }; settings.revision++; settings.updatedAt = '2026-11-14T02:00:00Z';
      } else for (const item of items) if (body?.action === 'readAll' || body?.ids?.includes(item.id)) item.readAt ||= '2026-11-14T02:00:00Z';
      if (failAfterApplying) { failAfterApplying = false; throw new TypeError('Synthetic lost response'); }
      return Response.json({ ok: true });
    }
    if (loadFailure) { loadFailure = false; return Response.json({ error: '暂时无法读取消息。' }, { status: 503 }); }
    const query = new URL(path, 'https://notifications.test').searchParams;
    const visible = items.filter((item) => settings.categories[item.category]);
    const unreadIds=visible.filter((item)=>!item.readAt).map((item)=>item.id);
    const filtered = query.get('unread') === '1' ? visible.filter((item) => !item.readAt) : visible;
    const offset=Number(query.get('offset')??0);
    return Response.json({ items: filtered.slice(offset,offset+20), total: filtered.length, unreadCount: unreadIds.length,unreadIds,
      offset, limit: 20, hasMore: offset+20<filtered.length, unavailable: [], truncated: false, settings });
  } };
  Object.assign(window, { JiashuAccountSession: session });
  let current = new URL('https://notifications.test/notifications');
  const location = { get origin() { return current.origin; }, get search() { return current.search; } };
  const history = { replaceState(_state: unknown, _unused: string, path: string) { current = new URL(path, current); } };
  runInNewContext(CLIENT_REQUEST_SCRIPT + NOTIFICATIONS_SCRIPT, { window, document, location, history, fetch: () => { throw new Error('Identity-aware transport required'); }, URL, URLSearchParams, Element: window.Element, AbortController, Intl, Date, setTimeout, clearTimeout });
  const el = (id: string) => document.getElementById('notifications-' + id)! as unknown as HTMLElement & { value: string; disabled: boolean; checked: boolean };
  const event = (name: string) => new window.Event(name, { bubbles: true, cancelable: true });
  const click = (id: string | Element) => (typeof id === 'string' ? el(id) : id).dispatchEvent(event('click'));
  return { document, window, el, calls, items, session, click,
    ready() { return settled(() => el('page').getAttribute('aria-busy') === 'false' && el('settings-save').disabled === false); },
    selectUnread() { el('filter').value = 'unread'; el('filter').dispatchEvent(event('change')); },
    setCategory(category: string, checked: boolean) { el('setting-' + category).checked = checked; el('setting-' + category).dispatchEvent(event('change')); },
    saveSettings() { el('settings').dispatchEvent(event('submit')); },
    lostResponse() { failAfterApplying = true; },
    failLoad() { loadFailure = true; },
    externalSettings(categories: NotificationPreferences) { settings.categories = categories; settings.revision++; },
  };
}

test('message page initialization is read-only and renders escaped content, safe navigation and Shanghai timestamps', async () => {
  const f = fixture(); await f.ready();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.el('list').children.length, 2);
  assert.match(f.el('list').textContent ?? '', /<img src=x/);
  assert.equal(f.el('list').querySelectorAll('img,script').length, 0);
  assert.equal(f.el('list').querySelectorAll('a').length, 1);
  assert.equal(f.el('list').querySelector('a')?.getAttribute('href'), '/finance?ledger=family');
  assert.match(f.el('list').querySelector('time')?.textContent ?? '', /08:00/);
  f.selectUnread(); await settled(() => f.calls.length === 2 && f.el('page').getAttribute('aria-busy') === 'false');
  assert.ok(f.calls.every((call) => call.method === 'GET'));
});

test('marking read waits for explicit actions and retry confirms the exact original operation after a lost response', async () => {
  const f = fixture(); await f.ready(); f.lostResponse();
  f.click(f.el('list').querySelector('[data-message-read]')!);
  await settled(() => !f.el('retry').hidden && !f.el('retry').disabled);
  const original = f.calls.find((call) => call.method === 'POST')!;
  assert.equal(f.el('settings-save').disabled, true);
  f.click('retry'); await settled(() => f.el('retry').hidden && !f.el('settings-save').disabled);
  const writes = f.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 2); assert.deepEqual(writes[0].body, writes[1].body); assert.deepEqual(writes[0], original);
  assert.match(f.el('count').textContent ?? '', /近期未读 1 条/);
  f.click('read-all'); await settled(() => f.el('read-all').disabled && f.el('count').textContent?.includes('近期未读 0 条') === true);
  assert.deepEqual(f.calls.at(-2)?.body, {action:'read',ids:['sync:one']});
});

test('conflicting settings preserve edited switches until the explicit latest-settings read fetches the server revision', async () => {
  const f = fixture(); await f.ready(); f.setCategory('sync', false);
  f.externalSettings({ invitations: false, collaboration: false, sync: false, balances: false });
  f.saveSettings(); await settled(() => f.el('settings-message').textContent?.includes('设置冲突') === true && !f.el('settings-save').disabled);
  assert.equal(f.el('setting-invitations').checked, true); assert.equal(f.el('setting-sync').checked, false);
  const before = f.calls.filter((call) => call.method === 'GET').length;
  f.click('settings-latest'); await settled(() => f.calls.filter((call) => call.method === 'GET').length > before && f.el('setting-invitations').checked === false);
  f.saveSettings(); await settled(() => f.calls.filter((call) => call.method === 'POST').length === 2 && !f.el('settings-save').disabled);
  const writes = f.calls.filter((call) => call.method === 'POST').map((call) => call.body as { expectedRevision: number });
  assert.equal(writes[0].expectedRevision, 0); assert.equal(writes[1].expectedRevision, 1);
});

test('all-read retry keeps its original IDs even when a newer notification arrives and the feed is refreshed', async () => {
  const f = fixture(); await f.ready();
  const originalIds = f.items.map((item) => item.id);
  f.lostResponse(); f.click('read-all');
  await settled(() => !f.el('retry').hidden && !f.el('retry').disabled);
  f.items.push({ id: 'sync:new-arrival', category: 'sync', title: '新的同步提醒', summary: '在首次操作后到达。', href: '/sync', createdAt: '2026-11-14T03:00:00Z', readAt: null });
  f.click('refresh');
  await settled(() => f.el('list').textContent?.includes('新的同步提醒') === true && f.el('page').getAttribute('aria-busy') === 'false');
  f.click('retry');
  await settled(() => f.el('retry').hidden && !f.el('settings-save').disabled);
  const writes = f.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, { action: 'read', ids: originalIds });
  assert.deepEqual(writes[1].body, writes[0].body);
  assert.equal(f.items.at(-1)?.readAt, null);
  assert.match(f.el('count').textContent ?? '', /近期未读 1 条/);
});

test('all-read uses the complete unread ID snapshot across pages while excluding already-read entries', async () => {
  const f = fixture(); await f.ready();
  f.items[0].readAt = '2026-11-14T02:00:00Z';
  for (let index = 0; index < 23; index++) f.items.push({ id: 'sync:extra-' + index, category: 'sync', title: '消息 ' + index, summary: '分页消息', href: '/sync', createdAt: '2026-11-14T01:00:00Z', readAt: null });
  f.click('refresh'); await settled(() => f.el('list').children.length === 20 && !f.el('next').disabled);
  f.click('next'); await settled(() => f.el('list').children.length === 5 && f.el('page').getAttribute('aria-busy') === 'false');
  const originalIds = f.items.filter((item) => item.readAt === null).map((item) => item.id);
  assert.equal(originalIds.length, 24);
  f.click('read-all'); await settled(() => f.el('count').textContent?.includes('近期未读 0 条') === true && !f.el('settings-save').disabled);
  const write = f.calls.find((call) => call.method === 'POST');
  assert.deepEqual(write?.body, { action: 'read', ids: originalIds });
  assert.ok(!originalIds.includes(f.items[0].id));
});

test('account changes clear the loaded feed and prevent stale-page mutation controls from posting', async () => {
  const f = fixture(); await f.ready(); f.session.changed = true;
  f.document.dispatchEvent(new f.window.Event('jiashu-account-changed'));
  assert.equal(f.el('list').children.length, 0); assert.equal(f.el('settings-save').disabled, true);
  f.click('read-all'); f.saveSettings(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(f.calls.every((call) => call.method === 'GET'));
});

test('notification badges only react to explicit page updates and never load the feed themselves', () => {
  const { document, window } = parseHTML('<span data-notification-unread hidden></span>');
  runInNewContext(NOTIFICATIONS_BADGE_SCRIPT, { document });
  const badge = document.querySelector('span')!;
  document.dispatchEvent(new window.CustomEvent('jiashu-notifications-updated', { detail: { unreadCount: 3 } }));
  assert.equal(badge.hidden, false); assert.equal(badge.textContent, '3');
  document.dispatchEvent(new window.Event('jiashu-account-changed'));
  assert.equal(badge.hidden, true); assert.equal(badge.textContent, '0');
});
