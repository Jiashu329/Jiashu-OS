import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderAISettingsPage } from '../ai-settings-page.ts';
import { renderAISettingsScript } from './ai-settings-ui.ts';

const settings = (fields: Record<string, unknown> = {}) => ({ configured: true, model: 'MiniMax-M3', region: 'cn', revision: 4, updatedAt: '2026-11-12T01:00:00.000Z', lastTestStatus: null, lastTestAt: null, ...fields });
const metadata = (canManage: unknown = true, fields: Record<string, unknown> = {}) => ({ settings: settings(), storageReady: true, scope: 'site', canManage, ...fields });
const panels = ['manage-panel', 'test-panel', 'delete-panel'];
async function settled(check: () => boolean) {
  for (let count = 0; count < 60; count++) { if (check()) return; await new Promise<void>((done) => setImmediate(done)); }
  assert.ok(check(), 'AI settings UI did not settle');
}
function fixture(initial = metadata()) {
  const html = renderAISettingsPage();
  const { document, window } = parseHTML(html);
  document.querySelectorAll('select').forEach((select) => Object.defineProperty(select, 'value', { writable: true, value: 'cn' }));
  for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { configurable: true, get() { throw new Error('AI credentials must never enter browser storage'); } });
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let handler: (url: string, options: RequestInit) => Promise<Response> = async () => Response.json(initial);
  const fetch = async (url: string, options: RequestInit = {}) => {
    requests.push({ url, method: options.method ?? 'GET', body: typeof options.body === 'string' ? JSON.parse(options.body) as unknown : null });
    return handler(url, options);
  };
  const el = (id: string) => document.getElementById('ai-settings-' + id)! as unknown as HTMLInputElement;
  const event = (id: string, kind = 'click') => el(id).dispatchEvent(new window.Event(kind, { bubbles: true, cancelable: true }));
  const input = (id: string, value: string) => { el(id).value = value; event(id, id === 'region' ? 'change' : 'input'); };
  runInNewContext(renderAISettingsScript().replace(/^<script type="module">/, '').replace(/<\/script>$/, ''), { document, window, fetch, AbortController, Intl, Date, setTimeout, clearTimeout });
  return { html, document, window, el, event, input, requests, respond(next: typeof handler) { handler = next; }, writes: () => requests.filter((row) => row.method !== 'GET') };
}

void test('initial HTML hides every management panel before owner metadata is known', () => {
  const { document } = parseHTML(renderAISettingsPage());
  for (const id of panels) assert.equal(document.getElementById('ai-settings-' + id)?.hidden, true);
  assert.match(document.getElementById('ai-settings-shared-note')?.textContent ?? '', /由网站创建者统一配置，你无需填写密钥即可使用/);
  assert.equal(document.getElementById('ai-settings-back-link')?.getAttribute('href'), '/health/assistant');
  assert.match(document.getElementById('ai-settings-delete-confirm')?.textContent ?? '', /所有用户/);
});

void test('members and unrecognized management authority see shared status but cannot trigger writes', async () => {
  for (const authority of [false, null, 'true', 1, undefined]) {
    const data = metadata(authority);
    if (authority === undefined) delete (data as { canManage?: unknown }).canManage;
    const f = fixture(data);
    await settled(() => f.el('page').getAttribute('aria-busy') === 'false');
    for (const id of panels) assert.equal(f.el(id).hidden, true);
    for (const id of ['api-key', 'model', 'region', 'save', 'discard', 'test', 'test-consent', 'delete-open', 'delete-submit']) assert.equal(f.el(id).disabled, true);
    assert.equal(f.el('summary-model').textContent, 'MiniMax-M3');
    assert.match(f.el('summary-region').textContent ?? '', /中国大陆/);
    assert.equal(f.el('configured').textContent, '已保存');
    // Synthetic events bypass disabled controls, so the write gate must also reject them.
    f.input('api-key', 'sk-do-not-persist'); f.input('model', 'MiniMax-M3-Flash');
    f.event('form', 'submit'); f.el('test-consent').checked = true; f.event('test');
    f.event('delete-open'); f.el('delete-confirm').hidden = false; f.event('delete-submit');
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(f.writes().length, 0);
  }
});

void test('owner saves a replacement key once, clears it, retains management after test and discard', async () => {
  const f = fixture(); await settled(() => !f.el('model').disabled);
  for (const id of panels) assert.equal(f.el(id).hidden, false);
  f.respond(async (url, options) => {
    if (options.method === 'PUT') return Response.json(metadata(true, { settings: settings({ revision: 5, model: 'MiniMax-M3-Flash' }) }));
    assert.equal(url, '/api/ai/settings/test');
    return Response.json(metadata(true, { settings: settings({ revision: 5, model: 'MiniMax-M3-Flash', lastTestStatus: 'success', lastTestAt: '2026-11-12T02:00:00.000Z' }) }));
  });
  f.input('api-key', 'sk-owner-private'); f.input('model', 'MiniMax-M3-Flash'); f.event('form', 'submit');
  await settled(() => !f.el('model').disabled && f.el('summary-model').textContent === 'MiniMax-M3-Flash');
  assert.deepEqual(f.writes()[0], { url: '/api/ai/settings', method: 'PUT', body: { model: 'MiniMax-M3-Flash', region: 'cn', expectedRevision: 4, apiKey: 'sk-owner-private' } });
  assert.equal(f.el('api-key').value, ''); assert.match(f.el('status-text').textContent ?? '', /全站所有用户/);
  assert.equal(f.el('test').disabled, true); f.el('test-consent').checked = true; f.event('test-consent', 'change'); f.event('test');
  await settled(() => !f.el('model').disabled && f.el('test-result').textContent?.includes('测试成功') === true);
  assert.deepEqual(f.writes()[1].body, { expectedRevision: 5, consent: true });
  assert.equal(f.el('test-consent').checked, false);
  f.input('model', 'MiniMax-M3'); f.event('discard');
  assert.equal(f.el('model').value, 'MiniMax-M3-Flash'); assert.equal(f.el('manage-panel').hidden, false);
  assert.equal(f.writes().length, 2);
});

void test('owner deletion requires confirmation and stays available when encryption storage is unavailable', async () => {
  const f = fixture(metadata(true, { storageReady: false })); await settled(() => f.el('page').getAttribute('aria-busy') === 'false');
  assert.equal(f.el('model').disabled, true); assert.equal(f.el('delete-open').disabled, false);
  f.respond(async () => Response.json(metadata(true, { storageReady: false, settings: settings({ configured: false, revision: 5 }) })));
  f.event('delete-submit'); assert.equal(f.writes().length, 0);
  f.event('delete-open'); assert.equal(f.el('delete-confirm').hidden, false); f.event('delete-submit');
  await settled(() => f.el('configured').textContent === '未配置' && f.el('page').getAttribute('aria-busy') === 'false');
  assert.deepEqual(f.writes(), [{ url: '/api/ai/settings', method: 'DELETE', body: { expectedRevision: 4 } }]);
  assert.match(f.el('status-text').textContent ?? '', /所有用户/); assert.equal(f.el('delete-open').disabled, true);
});

void test('conflicts require rereading and uncertain saves reconcile authoritative member permissions', async () => {
  const f = fixture(); await settled(() => !f.el('model').disabled);
  f.respond(async () => Response.json({ error: '配置冲突' }, { status: 409 }));
  f.input('model', 'MiniMax-M3-Flash'); f.event('form', 'submit');
  await settled(() => f.el('status-text').textContent?.includes('其他页面更新') === true && f.el('page').getAttribute('aria-busy') === 'false');
  assert.equal(f.el('model').disabled, true); f.event('form', 'submit'); assert.equal(f.writes().length, 1);
  f.respond(async (_url, options) => { if (options.method) throw new Error('transport lost'); return Response.json(metadata()); });
  f.event('reload'); await settled(() => !f.el('model').disabled);
  f.respond(async (_url, options) => { if (options.method) throw new Error('transport lost'); return Response.json(metadata(false)); });
  f.input('api-key', 'sk-must-clear'); f.input('model', 'MiniMax-M3-Flash'); f.event('form', 'submit');
  await settled(() => f.el('manage-panel').hidden && f.el('page').getAttribute('aria-busy') === 'false');
  assert.equal(f.el('api-key').value, ''); f.event('form', 'submit'); assert.equal(f.writes().length, 2);
});

void test('forbidden management locks a previously authorized page until a fresh metadata read', async () => {
  const f = fixture(); await settled(() => !f.el('model').disabled);
  f.respond(async () => Response.json({ error: '仅创建者可管理', code: 'SITE_OWNER_REQUIRED' }, { status: 403 }));
  f.input('api-key', 'sk-clear-forbidden'); f.input('model', 'MiniMax-M3-Flash'); f.event('form', 'submit');
  await settled(() => f.el('manage-panel').hidden && f.el('page').getAttribute('aria-busy') === 'false');
  assert.equal(f.el('api-key').value, ''); f.event('form', 'submit'); f.event('delete-open');
  assert.equal(f.writes().length, 1); assert.match(f.el('status-text').textContent ?? '', /网站创建者/);
});
